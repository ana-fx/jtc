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

// Rooms created by the bot. Map<channelId, { ownerId, emptySince, min, max }>.
// emptySince is a timestamp (ms) since the room became empty, or null.
// min/max define the allowed user-limit range (0 max = no upper bound).
const tempChannels = new Map();

// Writes the current room list to disk so it survives a restart.
function persistRooms() {
  const rooms = {};
  for (const [id, room] of tempChannels) {
    rooms[id] = { ownerId: room.ownerId, min: room.min ?? 0, max: room.max ?? 0 };
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
          emptySince: channel.members.size === 0 ? Date.now() : null,
        });
      }
    } catch {
      // Channel no longer exists; drop it.
    }
  }
  persistRooms(); // prune any that were deleted while offline
  console.log(`Adopted ${tempChannels.size} room(s) from the previous session.`);

  // Start the periodic sweeper.
  setInterval(() => {
    sweepRooms().catch((err) => console.error('Sweep error:', err));
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
 * Builds the control-panel message (embed + buttons) for a room.
 */
function buildPanel(channel, ownerId) {
  const everyone = channel.permissionOverwrites.cache.get(channel.guild.id);
  const isLocked = everyone?.deny.has(PermissionFlagsBits.Connect) ?? false;
  const isHidden = everyone?.deny.has(PermissionFlagsBits.ViewChannel) ?? false;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(channel.name)
    .setDescription(
      `Welcome <@${ownerId}> to your voice room!\n` +
        'Only the owner can use the buttons below to manage this room.',
    )
    .addFields(
      { name: 'Owner', value: `<@${ownerId}>`, inline: true },
      { name: 'Status', value: isLocked ? 'Locked' : 'Public', inline: true },
      { name: 'Visibility', value: isHidden ? 'Hidden' : 'Visible', inline: true },
      {
        name: 'User limit',
        value: channel.userLimit === 0 ? 'Unlimited' : String(channel.userLimit),
        inline: true,
      },
    );

  // Show the allowed limit range for rooms created from a configured lobby.
  const record = tempChannels.get(channel.id);
  if (record && (record.min > 0 || record.max > 0)) {
    embed.addFields({
      name: 'Allowed limit',
      value: record.max === 0 ? `min ${record.min}` : `${record.min}-${record.max}`,
      inline: true,
    });
  }

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('vc:lock')
      .setLabel(isLocked ? 'Unlock' : 'Lock')
      .setEmoji(isLocked ? '🔓' : '🔒')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('vc:hide')
      .setLabel(isHidden ? 'Unhide' : 'Hide')
      .setEmoji(isHidden ? '👁️' : '🙈')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('vc:limit')
      .setLabel('Limit')
      .setEmoji('🔢')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('vc:rename')
      .setLabel('Rename')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('vc:kick')
      .setLabel('Kick')
      .setEmoji('👢')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('vc:ban')
      .setLabel('Ban')
      .setEmoji('🔨')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('vc:permit')
      .setLabel('Permit')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('vc:claim')
      .setLabel('Claim')
      .setEmoji('👑')
      .setStyle(ButtonStyle.Secondary),
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('vc:invite')
      .setLabel('Invite')
      .setEmoji('🔗')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2, row3] };
}

/**
 * Creates a new voice room for a member and moves them into it.
 * When lobbyCfg is set (a configured limit lobby), the room starts at the
 * lobby's minimum limit and stays in the lobby's own category so each room
 * type groups under its lobby.
 */
async function createRoomFor(member, lobbyChannel, lobbyCfg = null) {
  const guild = member.guild;
  const parentId = lobbyCfg
    ? lobbyChannel.parentId || null
    : CATEGORY_ID || lobbyChannel.parentId || null;

  console.log(
    `createRoomFor: member=${member.user.tag} lobby="${lobbyChannel.name}" ` +
      `(${lobbyChannel.id}) parentCategory=${parentId ?? '(none)'}`,
  );

  try {
    const channel = await guild.channels.create({
      name: `${member.displayName}'s Channel`,
      type: ChannelType.GuildVoice,
      parent: parentId,
      // Configured lobbies start at their minimum; otherwise the global
      // default from /setlimit applies (0 = unlimited).
      userLimit: lobbyCfg ? lobbyCfg.min : config.defaultUserLimit,
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

    tempChannels.set(channel.id, {
      ownerId: member.id,
      emptySince: null,
      min: lobbyCfg?.min ?? 0,
      max: lobbyCfg?.max ?? 0,
    });
    persistRooms();

    // Move the member into the new room (if still connected to voice).
    if (member.voice.channel) {
      await member.voice.setChannel(channel);
    }

    // Post the control panel in the room's built-in text chat.
    try {
      await channel.send(buildPanel(channel, member.id));
    } catch (err) {
      console.error('Failed to send control panel:', err);
    }

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
  // 1) A user joined a lobby channel => create a new room for them.
  //    Configured limit lobbies take their own min/max; the legacy single
  //    lobby (JOIN_TO_CREATE_CHANNEL_ID) uses the global default limit.
  if (newState.member && newState.channelId && oldState.channelId !== newState.channelId) {
    const lobbyCfg = lobbies.get(newState.channelId);
    if (lobbyCfg) {
      await createRoomFor(newState.member, newState.channel, lobbyCfg);
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
    if (interaction.isButton() && interaction.customId.startsWith('vc:')) {
      return await handlePanelButton(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('vc:')) {
      return await handlePanelModal(interaction);
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

// Resolves the room record for the channel the interaction happened in.
function getRoom(interaction) {
  const channel = interaction.channel;
  if (!channel || !tempChannels.has(channel.id)) return null;
  return { channel, room: tempChannels.get(channel.id) };
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
  const info = getRoom(interaction);
  if (!info) {
    return interaction.reply({ content: 'This panel is no longer active.', ephemeral: true });
  }
  const { channel, room } = info;
  const action = interaction.customId.split(':')[1];
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
      return interaction.update(buildPanel(channel, room.ownerId));
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
      return interaction.update(buildPanel(channel, room.ownerId));
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
      const modal = new ModalBuilder().setCustomId('vc:limitModal').setTitle('Set user limit');
      const input = new TextInputBuilder()
        .setCustomId('value')
        .setLabel(label)
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }
    case 'rename': {
      const modal = new ModalBuilder().setCustomId('vc:renameModal').setTitle('Rename room');
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
        .setCustomId('vc:kickSelect')
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
        .setCustomId('vc:banSelect')
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
        .setCustomId('vc:permitSelect')
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
      return interaction.update(buildPanel(channel, room.ownerId));
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
  const info = getRoom(interaction);
  if (!info) {
    return interaction.reply({ content: 'This panel is no longer active.', ephemeral: true });
  }
  const { channel, room } = info;
  if (interaction.user.id !== room.ownerId) {
    return interaction.reply({ content: 'Only the room owner can do that.', ephemeral: true });
  }
  const value = interaction.fields.getTextInputValue('value').trim();

  if (interaction.customId === 'vc:limitModal') {
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
    if (interaction.message) {
      await interaction.message.edit(buildPanel(channel, room.ownerId)).catch(() => {});
    }
    return interaction.reply({
      content: `User limit set to ${n === 0 ? 'unlimited' : n}.`,
      ephemeral: true,
    });
  }

  if (interaction.customId === 'vc:renameModal') {
    await channel.setName(value);
    if (interaction.message) {
      await interaction.message.edit(buildPanel(channel, room.ownerId)).catch(() => {});
    }
    return interaction.reply({ content: `Room renamed to "${value}".`, ephemeral: true });
  }
}

async function handlePanelSelect(interaction) {
  const info = getRoom(interaction);
  if (!info) {
    return interaction.update({ content: 'This panel is no longer active.', components: [] });
  }
  const { channel, room } = info;
  if (interaction.user.id !== room.ownerId) {
    return interaction.update({ content: 'Only the room owner can do that.', components: [] });
  }
  const targetId = interaction.values[0];

  if (interaction.customId === 'vc:kickSelect') {
    const member = await channel.guild.members.fetch(targetId).catch(() => null);
    if (member?.voice?.channelId === channel.id) {
      await member.voice.disconnect('Removed by room owner');
      return interaction.update({ content: `Disconnected <@${targetId}>.`, components: [] });
    }
    return interaction.update({ content: 'That user is no longer in this room.', components: [] });
  }

  if (interaction.customId === 'vc:banSelect') {
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

  if (interaction.customId === 'vc:permitSelect') {
    // Also clears a ban (re-allows Connect + ViewChannel).
    await channel.permissionOverwrites.edit(targetId, { Connect: true, ViewChannel: true });
    return interaction.update({ content: `Permitted <@${targetId}> to join this room.`, components: [] });
  }
}

// Note: rooms are only tracked for the current session. After a restart,
// previously created rooms are no longer tracked (and won't be auto-deleted).
client.login(DISCORD_TOKEN);
