import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { loadConfig, saveConfig } from './config.js';
import { loadRooms, saveRooms } from './rooms.js';

const {
  DISCORD_TOKEN,
  JOIN_TO_CREATE_CHANNEL_ID,
  CATEGORY_ID,
  LOBBIES,
} = process.env;

// Persistent settings (e.g. default user limit for new rooms).
const config = loadConfig();

/**
 * Parses the LOBBIES env var into a Map<lobbyChannelId, { min, max }>.
 * Format: "<channelId>:<minLimit>:<maxLimit>,..." — maxLimit 0 means no
 * upper bound. Rooms created from a configured lobby start at minLimit and
 * the owner can only set a limit within [min, max].
 */
function parseLobbies(raw) {
  const map = new Map();
  if (!raw) return map;
  for (const entry of raw.split(',')) {
    const [id, min, max] = entry.trim().split(':');
    if (!id) continue;
    map.set(id, {
      min: Math.max(0, Number.parseInt(min, 10) || 0),
      max: Math.max(0, Number.parseInt(max, 10) || 0),
    });
  }
  return map;
}
const lobbies = parseLobbies(LOBBIES);

// How long a room may stay empty before the sweeper deletes it.
const EMPTY_GRACE_MS = 5 * 60 * 1000; // 5 minutes
// How often the sweeper runs.
const SWEEP_INTERVAL_MS = 60 * 1000; // 1 minute

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is not set in the .env file');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Rooms created by the bot. Map<channelId, { ownerId, emptySince, min, max,
// categoryId, name }>. emptySince is a timestamp (ms) since the room became
// empty, or null. min/max define the allowed user-limit range (0 max = no
// upper bound). categoryId groups rooms for the "Manage a Room" picker;
// name is kept in sync with the channel's current name so that picker can
// list rooms without an extra fetch per room.
//
// There is no per-room panel message to track: a single static control
// panel is posted once per category (in its #pengaturan channel, see
// ensurePanel). Clicking "Manage a Room" lists active rooms in that
// category; picking one reveals the actual controls, with the room's id
// embedded in their customIds — that's what ties a control action to a
// specific room, not the channel the interaction started in.
const tempChannels = new Map();

// categoryId -> guild, for every category we create rooms in. Populated once
// in clientReady and reused by the periodic panel self-heal check.
const categoryGuilds = new Map();

// categoryId -> [{ channel, lobbyCfg }, ...], the bounded lobbies (max > 0)
// living in each category — their create-size pickers get folded into that
// category's one combined panel message. Populated once in clientReady and
// reused by the periodic self-heal check.
const categoryBoundedLobbies = new Map();

// Writes the current room list to disk so it survives a restart.
function persistRooms() {
  const rooms = {};
  for (const [id, room] of tempChannels) {
    rooms[id] = {
      ownerId: room.ownerId,
      min: room.min ?? 0,
      max: room.max ?? 0,
      categoryId: room.categoryId ?? null,
      name: room.name ?? null,
    };
  }
  saveRooms(rooms);
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag} (id: ${client.user.id})`);
  console.log(`Default room user limit: ${config.defaultUserLimit} (0 = unlimited)`);
  console.log(`Configured lobby channel: ${JOIN_TO_CREATE_CHANNEL_ID || '(not configured)'}`);

  console.log(`Bot is in ${client.guilds.cache.size} guild(s):`);
  for (const [id, guild] of client.guilds.cache) {
    console.log(`  - ${guild.name} (id: ${id})`);
  }

  if (JOIN_TO_CREATE_CHANNEL_ID) {
    const lobby = client.channels.cache.get(JOIN_TO_CREATE_CHANNEL_ID);
    if (lobby) {
      console.log(`Lobby channel resolved: "${lobby.name}" in guild "${lobby.guild?.name}"`);
    } else {
      console.warn(
        `WARNING: lobby channel ${JOIN_TO_CREATE_CHANNEL_ID} not found. ` +
          'Check JOIN_TO_CREATE_CHANNEL_ID and that the bot is in that server.',
      );
    }
  }

  console.log(`Configured limit lobbies: ${lobbies.size}`);
  for (const [id, cfg] of lobbies) {
    const ch = client.channels.cache.get(id);
    const range = cfg.max === 0 ? `min ${cfg.min}` : `${cfg.min}-${cfg.max}`;
    if (ch) {
      console.log(`  - "${ch.name}" (${id}) limit ${range}`);
    } else {
      console.warn(`  - WARNING: lobby ${id} (limit ${range}) not found on this server`);
    }
  }

  // Re-adopt rooms created before the last restart so orphaned (empty) rooms
  // still get cleaned up by the sweeper.
  const persisted = loadRooms();
  for (const [channelId, saved] of Object.entries(persisted)) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel) {
        // Backward compat: old format stored just the owner id string.
        const record = typeof saved === 'string' ? { ownerId: saved } : saved;
        tempChannels.set(channelId, {
          ownerId: record.ownerId,
          min: record.min ?? 0,
          max: record.max ?? 0,
          categoryId: record.categoryId ?? channel.parentId ?? null,
          name: record.name ?? channel.name,
          emptySince: channel.members.size === 0 ? Date.now() : null,
        });
      }
    } catch {
      // Channel no longer exists; drop it.
    }
  }
  persistRooms(); // prune any that were deleted while offline
  console.log(`Adopted ${tempChannels.size} room(s) from the previous session.`);

  // Every category we create rooms in needs its one combined panel message
  // (control buttons + any bounded lobbies' create-size pickers) in its
  // #pengaturan channel. Computed once here (channels don't change category
  // at runtime) and reused by the periodic re-check below, so a panel
  // someone deletes by hand gets reposted within a minute instead of
  // needing a bot restart.
  if (JOIN_TO_CREATE_CHANNEL_ID) {
    const lobby = client.channels.cache.get(JOIN_TO_CREATE_CHANNEL_ID);
    const categoryId = CATEGORY_ID || lobby?.parentId;
    if (lobby && categoryId) categoryGuilds.set(categoryId, lobby.guild);
  }
  for (const [lobbyId, lobbyCfg] of lobbies) {
    const lobby = client.channels.cache.get(lobbyId);
    if (!lobby?.parentId) continue;
    categoryGuilds.set(lobby.parentId, lobby.guild);
    if (lobbyCfg.max > 0) {
      const list = categoryBoundedLobbies.get(lobby.parentId) ?? [];
      list.push({ channel: lobby, lobbyCfg });
      categoryBoundedLobbies.set(lobby.parentId, list);
    }
  }
  for (const [categoryId, guild] of categoryGuilds) {
    await ensurePanel(guild, categoryId, categoryBoundedLobbies.get(categoryId));
  }

  // Start the periodic sweeper (empty-room cleanup + panel self-heal).
  setInterval(() => {
    sweepRooms().catch((err) => console.error('Sweep error:', err));
    for (const [categoryId, guild] of categoryGuilds) {
      ensurePanel(guild, categoryId, categoryBoundedLobbies.get(categoryId)).catch((err) =>
        console.error(`Panel re-check failed for category ${categoryId}:`, err),
      );
    }
  }, SWEEP_INTERVAL_MS);
});

/**
 * Deletes any tracked room that has been empty for longer than EMPTY_GRACE_MS.
 * Also prunes rooms that were deleted manually.
 */
async function sweepRooms() {
  for (const [channelId, room] of tempChannels) {
    let channel;
    try {
      channel = await client.channels.fetch(channelId);
    } catch {
      channel = null;
    }

    if (!channel) {
      tempChannels.delete(channelId);
      persistRooms();
      continue;
    }

    if (channel.members.size > 0) {
      room.emptySince = null;
      continue;
    }

    // Room is empty: start / continue the grace timer.
    if (room.emptySince == null) {
      room.emptySince = Date.now();
      continue;
    }

    if (Date.now() - room.emptySince >= EMPTY_GRACE_MS) {
      try {
        await channel.delete('Empty for more than 5 minutes');
        console.log(`Swept empty room "${channel.name}"`);
      } catch (err) {
        if (err?.code === 50001) {
          console.warn(
            `WARNING: lost access to room "${channel.name}" (id: ${channel.id}) — ` +
              'a server admin must delete it manually in Discord.',
          );
        } else {
          console.error('Failed to sweep room:', err);
        }
      }
      tempChannels.delete(channelId);
      persistRooms();
    }
  }
}

/**
 * Builds the ONE static message posted per category: a "Manage a Room"
 * button, plus (if any bounded lobbies live in this category) a "choose
 * your room size" select menu per lobby. It does not represent any specific
 * room — clicking "Manage a Room" lists the category's currently active
 * rooms (see handleManageRoomButton); picking one from that list is what
 * reveals the actual per-room controls, so this message never needs to be
 * edited or reposted as rooms come and go.
 *
 * A bounded lobby's select menu embeds its channel id in the customId
 * (vc:createPick:<lobbyChannelId>) since it can't be inferred from the
 * channel the interaction came from — this message lives in #pengaturan,
 * not in the lobby itself, and a category could in principle hold more than
 * one bounded lobby's picker.
 */
function buildPanel(boundedLobbiesInCategory = []) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Room Controls')
    .setDescription(
      'Click **Manage a Room** to pick one of the currently active rooms ' +
        'in this category and get its controls (Lock, Hide, Limit, Rename, ' +
        'Kick, Ban, Permit, Claim, Invite). Most controls only work for the ' +
        "room's owner. **Claim** can be used by anyone on a room whose " +
        'owner has left.',
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vc:manageRoom').setLabel('Manage a Room').setEmoji('🎛️').setStyle(ButtonStyle.Primary),
  );

  const embeds = [embed];
  const components = [row1];

  for (const { channel: lobbyChannel, lobbyCfg } of boundedLobbiesInCategory) {
    embeds.push(
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`Create Your Room — ${lobbyChannel.name}`)
        .setDescription(
          'Choose how many people can join your room, then it will be ' +
            `created and you will be moved into it automatically. **You ` +
            `must be connected to <#${lobbyChannel.id}>** while picking.`,
        ),
    );

    const options = [];
    for (let n = lobbyCfg.min; n <= lobbyCfg.max; n++) {
      options.push({ label: `${n} user${n === 1 ? '' : 's'}`, value: String(n) });
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId(`vc:createPick:${lobbyChannel.id}`)
      .setPlaceholder(`Select a room size for ${lobbyChannel.name}`)
      .addOptions(options);
    components.push(new ActionRowBuilder().addComponents(select));
  }

  return { embeds, components };
}

/**
 * Builds the per-room controls shown after picking a room from "Manage a
 * Room": a status embed for that specific room plus its action buttons,
 * each with the room's id embedded in its customId (vc:<action>:<roomId>)
 * so the follow-up interaction (a button click, modal submit, or select
 * choice) resolves back to this exact room via resolveRoomById.
 */
function buildRoomControls(channel, room) {
  const everyone = channel.permissionOverwrites.cache.get(channel.guild.id);
  const isLocked = everyone?.deny.has(PermissionFlagsBits.Connect) ?? false;
  const isHidden = everyone?.deny.has(PermissionFlagsBits.ViewChannel) ?? false;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(channel.name)
    .addFields(
      { name: 'Owner', value: `<@${room.ownerId}>`, inline: true },
      { name: 'Status', value: isLocked ? 'Locked' : 'Public', inline: true },
      { name: 'Visibility', value: isHidden ? 'Hidden' : 'Visible', inline: true },
      {
        name: 'User limit',
        value: channel.userLimit === 0 ? 'Unlimited' : String(channel.userLimit),
        inline: true,
      },
    );
  if ((room.min ?? 0) > 0 || (room.max ?? 0) > 0) {
    embed.addFields({
      name: 'Allowed limit',
      value: room.max === 0 ? `min ${room.min}` : `${room.min}-${room.max}`,
      inline: true,
    });
  }

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`vc:lock:${channel.id}`)
      .setLabel(isLocked ? 'Unlock' : 'Lock')
      .setEmoji(isLocked ? '🔓' : '🔒')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`vc:hide:${channel.id}`)
      .setLabel(isHidden ? 'Unhide' : 'Hide')
      .setEmoji(isHidden ? '👁️' : '🙈')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`vc:limit:${channel.id}`).setLabel('Limit').setEmoji('🔢').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`vc:rename:${channel.id}`).setLabel('Rename').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vc:kick:${channel.id}`).setLabel('Kick').setEmoji('👢').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`vc:ban:${channel.id}`).setLabel('Ban').setEmoji('🔨').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`vc:permit:${channel.id}`).setLabel('Permit').setEmoji('✅').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`vc:claim:${channel.id}`).setLabel('Claim').setEmoji('👑').setStyle(ButtonStyle.Secondary),
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vc:invite:${channel.id}`).setLabel('Invite').setEmoji('🔗').setStyle(ButtonStyle.Secondary),
  );

  return { content: '', embeds: [embed], components: [row1, row2, row3] };
}

/**
 * Posts the one combined panel (control buttons + any bounded lobbies'
 * create-size pickers) in a category's #pengaturan channel if it isn't
 * already there, re-posting if that message was deleted. Safe to call
 * repeatedly — a no-op once the panel exists.
 */
async function ensurePanel(guild, categoryId, boundedLobbiesInCategory = []) {
  const settingsChannel = findSettingsChannel(guild, categoryId);
  if (!settingsChannel) {
    console.warn(
      `WARNING: no text channel with "pengaturan" in its name found in category ${categoryId}; ` +
        'the control panel was not posted there.',
    );
    return;
  }

  const saved = config.panelMessages?.[categoryId];
  if (saved?.channelId === settingsChannel.id) {
    try {
      await settingsChannel.messages.fetch(saved.messageId);
      return; // Panel already posted and still there.
    } catch {
      // Message was deleted; fall through and repost it.
    }
  }

  try {
    const message = await settingsChannel.send(buildPanel(boundedLobbiesInCategory));
    config.panelMessages = { ...(config.panelMessages ?? {}), [categoryId]: { channelId: settingsChannel.id, messageId: message.id } };
    saveConfig(config);
    console.log(`Posted the control panel in "${settingsChannel.name}" for category ${categoryId}`);
  } catch (err) {
    console.error(`Failed to post the control panel in category ${categoryId}:`, err);
  }
}

/**
 * Finds the shared "pengaturan" (settings) text channel in a category, so
 * room control panels can be posted there instead of in each room's own
 * chat. Matches by substring so the decorative characters some server owners
 * add around the name (e.g. "⚙️・pengaturan=͙˚") don't break the lookup.
 */
function findSettingsChannel(guild, categoryId) {
  if (!categoryId) return null;
  return (
    guild.channels.cache.find(
      (ch) =>
        ch.parentId === categoryId &&
        ch.type === ChannelType.GuildText &&
        ch.name.toLowerCase().includes('pengaturan'),
    ) ?? null
  );
}

/**
 * Creates a new voice room for a member and moves them into it.
 * When lobbyCfg is set (a configured limit lobby), the room stays in the
 * lobby's own category so each room type groups under its lobby. chosenLimit
 * overrides lobbyCfg.min — used when the member picked a specific size from
 * a bounded lobby's create-picker instead of getting the lobby's default.
 */
async function createRoomFor(member, lobbyChannel, lobbyCfg = null, chosenLimit = null) {
  const guild = member.guild;
  const parentId = lobbyCfg
    ? lobbyChannel.parentId || null
    : CATEGORY_ID || lobbyChannel.parentId || null;

  console.log(
    `createRoomFor: member=${member.user.tag} lobby="${lobbyChannel.name}" ` +
      `(${lobbyChannel.id}) parentCategory=${parentId ?? '(none)'} chosenLimit=${chosenLimit ?? '(none)'}`,
  );

  try {
    const channel = await guild.channels.create({
      name: `${member.displayName}'s Channel`,
      type: ChannelType.GuildVoice,
      parent: parentId,
      // A picked limit wins; otherwise a configured lobby starts at its
      // minimum, or the global default from /setlimit applies (0 = unlimited).
      userLimit: chosenLimit ?? (lobbyCfg ? lobbyCfg.min : config.defaultUserLimit),
      permissionOverwrites: [
        {
          // Give the room owner full control over their channel.
          id: member.id,
          allow: [
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.MoveMembers,
            PermissionFlagsBits.MuteMembers,
            PermissionFlagsBits.Connect,
          ],
        },
      ],
    });

    // Explicitly grant the bot itself access on this specific channel, as a
    // separate follow-up edit. Without this, an @everyone deny added later
    // (e.g. via the Hide button) can override the bot's category-level
    // allow — Discord processes category overwrites before the channel's
    // own, so a channel-level @everyone deny wins over a category-level
    // role allow for any entity (including the bot) that has no overwrite
    // of its own directly on the channel.
    //
    // Deliberately NOT including ManageRoles or CreateInstantInvite here:
    // Discord rejects (50013) granting those two via an overwrite unless the
    // granter has Administrator, even when it already holds them through its
    // base role. Both are already covered by the bot's base role permissions
    // (guild-wide), so omitting them from the channel-specific overwrite
    // loses no capability.
    try {
      await channel.permissionOverwrites.edit(client.user.id, {
        ViewChannel: true,
        ManageChannels: true,
        MoveMembers: true,
        MuteMembers: true,
        Connect: true,
      });
    } catch (err) {
      console.error(`Failed to grant the bot its own overwrite on "${channel.name}":`, err);
    }

    // Move the member into the new room (if still connected to voice).
    if (member.voice.channel) {
      try {
        await member.voice.setChannel(channel);
        console.log(`Moved ${member.user.tag} into "${channel.name}" (voice channel was "${member.voice.channel?.name}")`);
      } catch (err) {
        console.error(`Failed to move ${member.user.tag} into "${channel.name}":`, err);
      }
    } else {
      console.warn(`${member.user.tag} was not connected to voice at room-creation time; not moved.`);
    }

    // No per-room panel to post: the category's one combined panel (posted
    // at startup by ensurePanel) already covers this room too — "Manage a
    // Room" lists it by categoryId/name and its controls resolve back to it
    // by channel id once picked.
    tempChannels.set(channel.id, {
      ownerId: member.id,
      emptySince: null,
      min: lobbyCfg?.min ?? 0,
      max: lobbyCfg?.max ?? 0,
      categoryId: parentId,
      name: channel.name,
    });
    persistRooms();

    console.log(`Created room "${channel.name}" for ${member.user.tag}`);
    return channel;
  } catch (err) {
    console.error('Failed to create room:', err);
    return null;
  }
}

/**
 * Deletes the channel if it was created by the bot and is now empty.
 */
async function deleteIfEmpty(channel) {
  console.log(
    `deleteIfEmpty check: channel="${channel?.name}" (${channel?.id}) ` +
      `tracked=${channel ? tempChannels.has(channel.id) : 'n/a'} ` +
      `members=${channel?.members?.size ?? 'n/a'}`,
  );
  if (!channel || !tempChannels.has(channel.id)) return;
  if (channel.members.size > 0) return;

  try {
    await channel.delete('Voice room is empty, deleted automatically');
    tempChannels.delete(channel.id);
    persistRooms();
    console.log(`Deleted empty room "${channel.name}"`);
  } catch (err) {
    // 50001 (Missing Access) means the bot itself lost visibility into this
    // channel — usually a stray permission overwrite denying it View Channel
    // (e.g. it was accidentally targeted by Ban). The bot can never recover
    // access on its own, so stop retrying and flag it for manual deletion.
    if (err?.code === 50001) {
      console.warn(
        `WARNING: lost access to room "${channel.name}" (id: ${channel.id}) — ` +
          'the bot can no longer see or manage it. A server admin must delete ' +
          'it manually in Discord.',
      );
      tempChannels.delete(channel.id);
      persistRooms();
      return;
    }
    console.error('Failed to delete room:', err);
  }
}

client.on('voiceStateUpdate', async (oldState, newState) => {
  console.log(
    `voiceStateUpdate: member=${newState.member?.user.tag ?? oldState.member?.user.tag} ` +
      `old="${oldState.channel?.name ?? 'none'}" (${oldState.channelId ?? 'none'}) -> ` +
      `new="${newState.channel?.name ?? 'none'}" (${newState.channelId ?? 'none'})`,
  );

  // 1) A user joined a lobby channel => create a new room for them.
  //    Configured limit lobbies take their own min/max; the legacy single
  //    lobby (JOIN_TO_CREATE_CHANNEL_ID) uses the global default limit.
  //    Bounded lobbies (max > 0) do NOT auto-create here — the member must
  //    pick a size from the lobby's create-picker instead (see
  //    handleCreatePick), so they end up with exactly the size they chose.
  if (newState.member && newState.channelId && oldState.channelId !== newState.channelId) {
    const lobbyCfg = lobbies.get(newState.channelId);
    if (lobbyCfg) {
      if (lobbyCfg.max === 0) {
        await createRoomFor(newState.member, newState.channel, lobbyCfg);
      }
    } else if (newState.channelId === JOIN_TO_CREATE_CHANNEL_ID) {
      await createRoomFor(newState.member, newState.channel);
    }
  }

  // 2) A user left a channel => delete it if it is now an empty bot room.
  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    await deleteIfEmpty(oldState.channel);
  }
});

// ── Interaction router ──────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) return await handleSlashCommand(interaction);
    if (interaction.isButton() && interaction.customId === 'vc:manageRoom') {
      return await handleManageRoomButton(interaction);
    }
    if (interaction.isButton() && interaction.customId.startsWith('vc:')) {
      return await handlePanelButton(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('vc:')) {
      return await handlePanelModal(interaction);
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('vc:createPick:')) {
      return await handleCreatePick(interaction);
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'vc:manageRoomSelect') {
      return await handleManageRoomSelect(interaction);
    }
    if (
      (interaction.isUserSelectMenu() || interaction.isStringSelectMenu()) &&
      interaction.customId.startsWith('vc:')
    ) {
      return await handlePanelSelect(interaction);
    }
  } catch (err) {
    console.error('Interaction handler error:', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      interaction
        .reply({
          content:
            'Something went wrong. The bot may be missing a permission ' +
            '(Manage Roles / Manage Channels / Create Invite).',
          ephemeral: true,
        })
        .catch(() => {});
    }
  }
});

// Resolves a room by its channel id (embedded in a control's customId —
// see buildRoomControls), fetching the channel fresh so it reflects the
// current name/permissions rather than a stale cache entry.
async function resolveRoomById(roomId, guild) {
  if (!roomId || !tempChannels.has(roomId)) return null;
  const channel = await guild.channels.fetch(roomId).catch(() => null);
  if (!channel) return null;
  return { channel, room: tempChannels.get(roomId) };
}

/**
 * Handles the "Manage a Room" button: lists every currently active room in
 * this category (derived from the #pengaturan channel's own category) as a
 * select menu, so the member can pick which one to get controls for.
 */
async function handleManageRoomButton(interaction) {
  const categoryId = interaction.channel?.parentId;
  const roomsInCategory = [...tempChannels.entries()].filter(([, room]) => room.categoryId === categoryId);
  if (roomsInCategory.length === 0) {
    return interaction.reply({ content: 'There are no active rooms in this category right now.', ephemeral: true });
  }
  const options = roomsInCategory
    .slice(-25)
    .map(([id, room]) => ({ label: room.name ?? 'Room', value: id }));
  const select = new StringSelectMenuBuilder()
    .setCustomId('vc:manageRoomSelect')
    .setPlaceholder('Select a room to manage')
    .addOptions(options);
  return interaction.reply({
    content: 'Choose which room to manage:',
    components: [new ActionRowBuilder().addComponents(select)],
    ephemeral: true,
  });
}

/**
 * Handles picking a room from the "Manage a Room" list: replaces the
 * ephemeral message with that room's status embed and control buttons.
 */
async function handleManageRoomSelect(interaction) {
  const roomId = interaction.values[0];
  const info = await resolveRoomById(roomId, interaction.guild);
  if (!info) {
    return interaction.update({ content: 'That room no longer exists.', embeds: [], components: [] });
  }
  return interaction.update(buildRoomControls(info.channel, info.room));
}

// Dumps the channel's current permission overwrites and the change about to
// be attempted, so a subsequent failure can be diagnosed from logs alone.
function logOverwriteAttempt(channel, action, change) {
  const entries = [...channel.permissionOverwrites.cache.values()].map(
    (o) => `[type=${o.type} id=${o.id} allow=${o.allow.bitfield} deny=${o.deny.bitfield}]`,
  );
  console.log(
    `${action}: channel="${channel.name}" (${channel.id}) parent=${channel.parentId ?? '(none)'} ` +
      `botId=${client.user.id} change=${JSON.stringify(change)} ` +
      `currentOverwrites=${entries.join(' ') || '(none)'}`,
  );
}

function logOverwriteFailure(channel, action, err) {
  console.error(
    `${action} FAILED on channel="${channel.name}" (${channel.id}) parent=${channel.parentId ?? '(none)'}: ` +
      `code=${err?.code} status=${err?.status} message=${err?.rawError?.message ?? err?.message}`,
  );
}

async function handleSlashCommand(interaction) {
  console.log(
    `interaction: /${interaction.commandName} from ${interaction.user.tag} ` +
      `in guild ${interaction.guildId}`,
  );

  if (interaction.commandName === 'voice') {
    const member = interaction.member;
    if (!member?.voice?.channel) {
      return interaction.reply({
        content: 'You must be in a voice channel to use this command.',
        ephemeral: true,
      });
    }
    const room = await createRoomFor(member, member.voice.channel);
    return interaction.reply({
      content: room
        ? `Room created: **${room.name}** — you have been moved into it.`
        : 'Failed to create the room. Check the bot permissions (Manage Channels & Move Members).',
      ephemeral: true,
    });
  }

  if (interaction.commandName === 'setlimit') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.reply({
        content: 'You need the Manage Channels permission to use this command.',
        ephemeral: true,
      });
    }
    const limit = interaction.options.getInteger('count', true);
    config.defaultUserLimit = limit;
    saveConfig(config);
    const label = limit === 0 ? 'unlimited' : `${limit} user(s)`;
    console.log(`${interaction.user.tag} set default room limit to ${label}`);
    return interaction.reply({
      content: `Default room user limit set to **${label}**. This applies to newly created rooms.`,
      ephemeral: true,
    });
  }
}

async function handlePanelButton(interaction) {
  const [, action, roomId] = interaction.customId.split(':');
  const info = await resolveRoomById(roomId, interaction.guild);
  if (!info) {
    return interaction.update({ content: 'That room no longer exists.', embeds: [], components: [] });
  }
  const { channel, room } = info;
  const everyoneId = channel.guild.id;

  // Every action except "claim" is owner-only.
  if (action !== 'claim' && interaction.user.id !== room.ownerId) {
    return interaction.reply({
      content: 'Only the room owner can use these controls.',
      ephemeral: true,
    });
  }

  switch (action) {
    case 'lock': {
      const locked =
        channel.permissionOverwrites.cache.get(everyoneId)?.deny.has(PermissionFlagsBits.Connect) ?? false;
      logOverwriteAttempt(channel, 'lock', { Connect: locked ? null : false });
      try {
        await channel.permissionOverwrites.edit(everyoneId, { Connect: locked ? null : false });
      } catch (err) {
        logOverwriteFailure(channel, 'lock', err);
        throw err;
      }
      return interaction.update(buildRoomControls(channel, room));
    }
    case 'hide': {
      const hidden =
        channel.permissionOverwrites.cache.get(everyoneId)?.deny.has(PermissionFlagsBits.ViewChannel) ?? false;
      logOverwriteAttempt(channel, 'hide', { ViewChannel: hidden ? null : false });
      try {
        await channel.permissionOverwrites.edit(everyoneId, { ViewChannel: hidden ? null : false });
      } catch (err) {
        logOverwriteFailure(channel, 'hide', err);
        throw err;
      }
      return interaction.update(buildRoomControls(channel, room));
    }
    case 'limit': {
      const min = room.min ?? 0;
      const max = room.max ?? 0;
      let label;
      if (min === 0 && max === 0) {
        label = 'Max users (0-99, 0 = unlimited)';
      } else if (max === 0) {
        label = `Max users (minimum ${min})`;
      } else {
        label = `Max users (${min}-${max})`;
      }
      const modal = new ModalBuilder().setCustomId(`vc:limitModal:${channel.id}`).setTitle('Set user limit');
      const input = new TextInputBuilder()
        .setCustomId('value')
        .setLabel(label)
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }
    case 'rename': {
      const modal = new ModalBuilder().setCustomId(`vc:renameModal:${channel.id}`).setTitle('Rename room');
      const input = new TextInputBuilder()
        .setCustomId('value')
        .setLabel('New room name')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }
    case 'kick': {
      // Only offer members currently connected to this room (except the owner).
      const members = channel.members.filter((m) => m.id !== room.ownerId);
      if (members.size === 0) {
        return interaction.reply({
          content: 'There is no one else in this room to kick.',
          ephemeral: true,
        });
      }
      const options = members
        .first(25)
        .map((m) => ({ label: m.displayName, value: m.id }));
      const select = new StringSelectMenuBuilder()
        .setCustomId(`vc:kickSelect:${channel.id}`)
        .setPlaceholder('Select a member in this room to disconnect')
        .setMaxValues(1)
        .addOptions(options);
      return interaction.reply({
        content: 'Choose who to disconnect from this room:',
        components: [new ActionRowBuilder().addComponents(select)],
        ephemeral: true,
      });
    }
    case 'ban': {
      const select = new UserSelectMenuBuilder()
        .setCustomId(`vc:banSelect:${channel.id}`)
        .setPlaceholder('Select a user to ban from this room')
        .setMaxValues(1);
      return interaction.reply({
        content: 'Choose who to ban (they will be blocked from joining). Use Permit to undo.',
        components: [new ActionRowBuilder().addComponents(select)],
        ephemeral: true,
      });
    }
    case 'permit': {
      const select = new UserSelectMenuBuilder()
        .setCustomId(`vc:permitSelect:${channel.id}`)
        .setPlaceholder('Select a user to permit')
        .setMaxValues(1);
      return interaction.reply({
        content: 'Choose who to permit (allow to join and see this room):',
        components: [new ActionRowBuilder().addComponents(select)],
        ephemeral: true,
      });
    }
    case 'claim': {
      if (channel.members.has(room.ownerId)) {
        return interaction.reply({
          content: 'The current owner is still here — you cannot claim this room.',
          ephemeral: true,
        });
      }
      room.ownerId = interaction.user.id;
      persistRooms();
      await channel.permissionOverwrites.edit(interaction.user.id, {
        ManageChannels: true,
        MoveMembers: true,
        MuteMembers: true,
        Connect: true,
      });
      return interaction.update(buildRoomControls(channel, room));
    }
    case 'invite': {
      const invite = await channel.createInvite({ maxAge: 3600, maxUses: 0 });
      return interaction.reply({
        content: `Invite link (valid for 1 hour): ${invite.url}`,
        ephemeral: true,
      });
    }
    default:
      return interaction.reply({ content: 'Unknown action.', ephemeral: true });
  }
}

async function handlePanelModal(interaction) {
  const [, modalName, roomId] = interaction.customId.split(':');
  const info = await resolveRoomById(roomId, interaction.guild);
  if (!info) {
    return interaction.update({ content: 'That room no longer exists.', embeds: [], components: [] });
  }
  const { channel, room } = info;
  if (interaction.user.id !== room.ownerId) {
    return interaction.reply({ content: 'Only the room owner can do that.', ephemeral: true });
  }
  const value = interaction.fields.getTextInputValue('value').trim();

  if (modalName === 'limitModal') {
    const n = Number.parseInt(value, 10);
    if (Number.isNaN(n) || n < 0 || n > 99) {
      return interaction.reply({ content: 'Please enter a number between 0 and 99.', ephemeral: true });
    }
    // Enforce the room's allowed range (set by the lobby it was created from).
    const min = room.min ?? 0;
    const max = room.max ?? 0;
    if (min > 0 && n < min) {
      return interaction.reply({
        content: `This room type requires a limit of at least ${min}.`,
        ephemeral: true,
      });
    }
    if (max > 0 && n > max) {
      return interaction.reply({
        content: `This room type allows a limit of at most ${max}.`,
        ephemeral: true,
      });
    }
    await channel.setUserLimit(n);
    return interaction.update(buildRoomControls(channel, room));
  }

  if (modalName === 'renameModal') {
    await channel.setName(value);
    room.name = value;
    persistRooms();
    return interaction.update(buildRoomControls(channel, room));
  }
}

/**
 * Handles a selection on a bounded lobby's create-size picker (posted in
 * #pengaturan, so the target lobby is read from the customId — see
 * buildCreatePicker — rather than from the channel the interaction came
 * from). The member must be currently connected to that exact lobby channel
 * (so they can be moved into the room this creates), then the room is
 * created with exactly the size they picked.
 */
async function handleCreatePick(interaction) {
  const lobbyId = interaction.customId.split(':')[2];
  const lobbyCfg = lobbies.get(lobbyId);
  if (!lobbyCfg) {
    return interaction.reply({ content: 'This picker is no longer configured.', ephemeral: true });
  }
  if (interaction.member?.voice?.channelId !== lobbyId) {
    return interaction.reply({
      content: `Join <#${lobbyId}> first, then pick your room size here.`,
      ephemeral: true,
    });
  }
  const lobbyChannel = await interaction.guild.channels.fetch(lobbyId).catch(() => null);
  if (!lobbyChannel) {
    return interaction.reply({ content: 'That lobby channel no longer exists.', ephemeral: true });
  }
  const limit = Number.parseInt(interaction.values[0], 10);
  const room = await createRoomFor(interaction.member, lobbyChannel, lobbyCfg, limit);
  return interaction.reply({
    content: room
      ? `Room created with a limit of ${limit} — you have been moved into it.`
      : 'Failed to create the room. Check the bot permissions.',
    ephemeral: true,
  });
}

async function handlePanelSelect(interaction) {
  const [, selectName, roomId] = interaction.customId.split(':');
  const info = await resolveRoomById(roomId, interaction.guild);
  if (!info) {
    return interaction.update({ content: 'That room no longer exists.', components: [] });
  }
  const { channel, room } = info;
  if (interaction.user.id !== room.ownerId) {
    return interaction.update({ content: 'Only the room owner can do that.', components: [] });
  }
  const targetId = interaction.values[0];

  if (selectName === 'kickSelect') {
    const member = await channel.guild.members.fetch(targetId).catch(() => null);
    if (member?.voice?.channelId === channel.id) {
      await member.voice.disconnect('Removed by room owner');
      return interaction.update({ content: `Disconnected <@${targetId}>.`, components: [] });
    }
    return interaction.update({ content: 'That user is no longer in this room.', components: [] });
  }

  if (selectName === 'banSelect') {
    if (targetId === room.ownerId) {
      return interaction.update({ content: 'You cannot ban yourself.', components: [] });
    }
    if (targetId === client.user.id) {
      return interaction.update({
        content: 'You cannot ban the bot — that would lock it out of managing this room.',
        components: [],
      });
    }
    const targetMember = await channel.guild.members.fetch(targetId).catch(() => null);
    if (targetMember?.user.bot) {
      return interaction.update({ content: 'You cannot ban a bot from this room.', components: [] });
    }
    // Block the user from connecting to / seeing this room.
    await channel.permissionOverwrites.edit(targetId, { Connect: false, ViewChannel: false });
    // If they are currently inside, disconnect them too.
    if (targetMember?.voice?.channelId === channel.id) {
      await targetMember.voice.disconnect('Banned by room owner').catch(() => {});
    }
    return interaction.update({
      content: `Banned <@${targetId}> from this room. Use Permit to undo.`,
      components: [],
    });
  }

  if (selectName === 'permitSelect') {
    // Also clears a ban (re-allows Connect + ViewChannel).
    await channel.permissionOverwrites.edit(targetId, { Connect: true, ViewChannel: true });
    return interaction.update({ content: `Permitted <@${targetId}> to join this room.`, components: [] });
  }
}

// Note: rooms are only tracked for the current session. After a restart,
// previously created rooms are no longer tracked (and won't be auto-deleted).
client.login(DISCORD_TOKEN);
