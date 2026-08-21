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
import { getUser, saveUsers } from './store.js';
import { addXp, xpToNextLevel } from './leveling.js';

const { DISCORD_TOKEN, GAME_LOBBY_CHANNEL_ID, GAMES } = process.env;

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is not set in the .env file');
  process.exit(1);
}
if (!GAME_LOBBY_CHANNEL_ID) {
  console.error('GAME_LOBBY_CHANNEL_ID is not set in the .env file');
  process.exit(1);
}

// Comma-separated list of games offered in the room-creation picker, e.g.
// "Mobile Legends,PUBG,Valorant,Free Fire".
const games = (
  GAMES ||
  'Mobile Legends,PUBG Mobile,Free Fire,Call of Duty Mobile,Valorant,Genshin Impact,Clash Royale,Clash of Clans,Brawl Stars,Wild Rift,Arena of Valor,eFootball'
)
  .split(',')
  .map((g) => g.trim())
  .filter(Boolean);

const config = loadConfig();

// Tuning constants — adjust freely.
const XP_PER_MINUTE_VOICE = 5; // XP per minute connected to a game room
const XP_PER_MESSAGE = 3; // XP per eligible chat message in a game room
const MESSAGE_XP_COOLDOWN_MS = 60 * 1000; // one XP-earning message per minute per user
const WORK_HUNT_COOLDOWN_MS = 30 * 1000;
const WORK_HUNT_MIN = 10;
const WORK_HUNT_MAX = 50;
const WORK_BATTLE_COOLDOWN_MS = 60 * 1000;
const WORK_BATTLE_MIN = 20;
const WORK_BATTLE_MAX = 100;
const EMPTY_GRACE_MS = 5 * 60 * 1000; // delete an empty game room after 5 minutes
const TICK_INTERVAL_MS = 60 * 1000; // voice-XP + empty-room sweep cadence

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

// Game rooms created by the bot. Map<channelId, { ownerId, game, emptySince }>.
const gameRooms = new Map();

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag} (id: ${client.user.id})`);
  console.log(`Configured games: ${games.join(', ')}`);

  const lobby = client.channels.cache.get(GAME_LOBBY_CHANNEL_ID);
  if (!lobby) {
    console.warn(
      `WARNING: game lobby channel ${GAME_LOBBY_CHANNEL_ID} not found. ` +
        'Check GAME_LOBBY_CHANNEL_ID and that the bot is in that server.',
    );
  } else {
    console.log(`Game lobby resolved: "${lobby.name}" in guild "${lobby.guild?.name}"`);
    if (lobby.parentId) {
      await ensureGamePicker(lobby.guild, lobby.parentId);
    }
  }

  setInterval(() => {
    tickVoiceXp();
    sweepEmptyRooms().catch((err) => console.error('Sweep error:', err));
    if (lobby?.parentId) {
      ensureGamePicker(lobby.guild, lobby.parentId).catch((err) =>
        console.error('Game picker re-check failed:', err),
      );
    }
  }, TICK_INTERVAL_MS);
});

/**
 * Finds the shared "pengaturan" (settings) text channel in a category.
 * Matches by substring so decorative characters around the name don't
 * break the lookup.
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
 * Builds the "pick a game" select menu message posted in the lobby
 * category's #pengaturan channel.
 */
function buildGamePicker() {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Create a Game Room')
    .setDescription(
      'Choose which game you\'re playing, then a voice room named after it ' +
        `will be created and you'll be moved into it. **You must be ` +
        `connected to <#${GAME_LOBBY_CHANNEL_ID}>** while picking.`,
    );

  const select = new StringSelectMenuBuilder()
    .setCustomId('game:pick')
    .setPlaceholder('Select a game')
    .addOptions(games.slice(0, 25).map((game) => ({ label: game, value: game })));

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

/**
 * Posts the game picker in the category's #pengaturan channel if it isn't
 * already there, re-posting only if the message was genuinely deleted
 * (Discord 10008), not on a transient fetch error.
 */
async function ensureGamePicker(guild, categoryId) {
  const settingsChannel = findSettingsChannel(guild, categoryId);
  if (!settingsChannel) {
    console.warn(
      `WARNING: no text channel with "pengaturan" in its name found in category ${categoryId}; ` +
        'the game picker was not posted there.',
    );
    return;
  }

  const saved = config.panelMessages?.[categoryId];
  if (saved?.channelId === settingsChannel.id) {
    try {
      await settingsChannel.messages.fetch(saved.messageId);
      return; // Already posted and still there.
    } catch (err) {
      if (err?.code !== 10008) {
        console.warn(`Game picker fetch check failed (will retry later):`, err?.message ?? err);
        return;
      }
      // else: genuinely deleted, fall through and repost.
    }
  }

  try {
    const message = await settingsChannel.send(buildGamePicker());
    config.panelMessages = { ...(config.panelMessages ?? {}), [categoryId]: { channelId: settingsChannel.id, messageId: message.id } };
    saveConfig(config);
    console.log(`Posted the game picker in "${settingsChannel.name}"`);
  } catch (err) {
    console.error('Failed to post the game picker:', err);
  }
}

/**
 * Builds the per-room controls: a status embed plus action buttons, each
 * with the room's id embedded in its customId (vc:<action>:<roomId>) so a
 * follow-up interaction resolves back to this exact room. No Limit button —
 * game rooms don't have a size restriction.
 */
function buildRoomControls(channel, room) {
  const everyone = channel.permissionOverwrites.cache.get(channel.guild.id);
  const isLocked = everyone?.deny.has(PermissionFlagsBits.Connect) ?? false;
  const isHidden = everyone?.deny.has(PermissionFlagsBits.ViewChannel) ?? false;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(channel.name)
    .addFields(
      { name: 'Game', value: room.game, inline: true },
      { name: 'Owner', value: `<@${room.ownerId}>`, inline: true },
      { name: 'Status', value: isLocked ? 'Locked' : 'Public', inline: true },
      { name: 'Visibility', value: isHidden ? 'Hidden' : 'Visible', inline: true },
    );

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

/** Resolves a room by its channel id (embedded in a control's customId). */
async function resolveRoomById(roomId, guild) {
  if (!roomId || !gameRooms.has(roomId)) return null;
  const channel = await guild.channels.fetch(roomId).catch(() => null);
  if (!channel) return null;
  return { channel, room: gameRooms.get(roomId) };
}

/**
 * Creates a game-named voice room for a member and moves them into it.
 */
async function createGameRoomFor(member, game) {
  const guild = member.guild;
  const lobby = client.channels.cache.get(GAME_LOBBY_CHANNEL_ID);
  const parentId = lobby?.parentId ?? null;

  try {
    const channel = await guild.channels.create({
      name: game,
      type: ChannelType.GuildVoice,
      parent: parentId,
    });

    // Explicitly grant the bot itself access on this specific channel — a
    // channel-level @everyone deny (if anyone ever locks the room) would
    // otherwise override the bot's category-level allow, since Discord
    // processes category overwrites before the channel's own.
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

    if (member.voice.channel) {
      try {
        await member.voice.setChannel(channel);
      } catch (err) {
        console.error(`Failed to move ${member.user.tag} into "${channel.name}":`, err);
      }
    }

    const room = { ownerId: member.id, game, emptySince: null };
    gameRooms.set(channel.id, room);

    // Post the persistent control panel directly in the room's own chat.
    try {
      await channel.send(buildRoomControls(channel, room));
    } catch (err) {
      console.error(`Failed to post room controls in "${channel.name}":`, err);
    }

    console.log(`Created game room "${channel.name}" (${game}) for ${member.user.tag}`);
    return channel;
  } catch (err) {
    console.error('Failed to create game room:', err);
    return null;
  }
}

/**
 * Deletes a tracked game room if it's now empty (called on member leave).
 */
async function deleteIfEmpty(channel) {
  if (!channel || !gameRooms.has(channel.id)) return;
  if (channel.members.size > 0) return;

  try {
    await channel.delete('Game room is empty, deleted automatically');
    gameRooms.delete(channel.id);
    console.log(`Deleted empty game room "${channel.name}"`);
  } catch (err) {
    if (err?.code === 50001) {
      console.warn(
        `WARNING: lost access to game room "${channel.name}" (id: ${channel.id}) — ` +
          'a server admin must delete it manually in Discord.',
      );
      gameRooms.delete(channel.id);
      return;
    }
    console.error('Failed to delete game room:', err);
  }
}

/** Periodic sweep: catches rooms left empty across a restart. */
async function sweepEmptyRooms() {
  for (const [channelId, room] of gameRooms) {
    let channel;
    try {
      channel = await client.channels.fetch(channelId);
    } catch {
      channel = null;
    }
    if (!channel) {
      gameRooms.delete(channelId);
      continue;
    }
    if (channel.members.size > 0) {
      room.emptySince = null;
      continue;
    }
    if (room.emptySince == null) {
      room.emptySince = Date.now();
      continue;
    }
    if (Date.now() - room.emptySince >= EMPTY_GRACE_MS) {
      await deleteIfEmpty(channel);
    }
  }
}

/** Awards voice-time XP to every non-bot member currently in a game room. */
function tickVoiceXp() {
  for (const [channelId] of gameRooms) {
    const channel = client.channels.cache.get(channelId);
    if (!channel) continue;
    for (const [, member] of channel.members) {
      if (member.user.bot) continue;
      const user = getUser(member.id);
      const result = addXp(user, XP_PER_MINUTE_VOICE);
      if (result.leveledUp) {
        announceLevelUp(channel, member.id, result);
      }
    }
  }
  saveUsers();
}

function announceLevelUp(channel, userId, result) {
  channel
    .send({
      content:
        `🎉 <@${userId}> leveled up to **level ${result.toLevel}** and earned **${result.coinsEarned} coins**!`,
    })
    .catch(() => {});
}

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (newState.member && newState.channelId === GAME_LOBBY_CHANNEL_ID) {
    // Joining the lobby itself doesn't create a room — the member must
    // pick a game from the picker in #pengaturan first.
  }
  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    await deleteIfEmpty(oldState.channel);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!gameRooms.has(message.channelId)) return;

  const user = getUser(message.author.id);
  const now = Date.now();
  if (now - user.lastMessageXpAt < MESSAGE_XP_COOLDOWN_MS) return;
  user.lastMessageXpAt = now;
  const result = addXp(user, XP_PER_MESSAGE);
  saveUsers();
  if (result.leveledUp) {
    announceLevelUp(message.channel, message.author.id, result);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) return await handleSlashCommand(interaction);
    if (interaction.isStringSelectMenu() && interaction.customId === 'game:pick') {
      return await handleGamePick(interaction);
    }
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
      interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
    }
  }
});

async function handleGamePick(interaction) {
  if (interaction.member?.voice?.channelId !== GAME_LOBBY_CHANNEL_ID) {
    return interaction.reply({
      content: `Join <#${GAME_LOBBY_CHANNEL_ID}> first, then pick your game here.`,
      ephemeral: true,
    });
  }
  const game = interaction.values[0];
  const channel = await createGameRoomFor(interaction.member, game);
  return interaction.reply({
    content: channel
      ? `Room created for **${game}** — you have been moved into it. Check the room's text chat for its controls.`
      : 'Failed to create the room. Check the bot permissions.',
    ephemeral: true,
  });
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
    return interaction.reply({ content: 'Only the room owner can use these controls.', ephemeral: true });
  }

  switch (action) {
    case 'lock': {
      const locked = channel.permissionOverwrites.cache.get(everyoneId)?.deny.has(PermissionFlagsBits.Connect) ?? false;
      await channel.permissionOverwrites.edit(everyoneId, { Connect: locked ? null : false });
      return interaction.update(buildRoomControls(channel, room));
    }
    case 'hide': {
      const hidden = channel.permissionOverwrites.cache.get(everyoneId)?.deny.has(PermissionFlagsBits.ViewChannel) ?? false;
      await channel.permissionOverwrites.edit(everyoneId, { ViewChannel: hidden ? null : false });
      return interaction.update(buildRoomControls(channel, room));
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
      const members = channel.members.filter((m) => m.id !== room.ownerId);
      if (members.size === 0) {
        return interaction.reply({ content: 'There is no one else in this room to kick.', ephemeral: true });
      }
      const options = members.first(25).map((m) => ({ label: m.displayName, value: m.id }));
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
        return interaction.reply({ content: 'The current owner is still here — you cannot claim this room.', ephemeral: true });
      }
      room.ownerId = interaction.user.id;
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
      return interaction.reply({ content: `Invite link (valid for 1 hour): ${invite.url}`, ephemeral: true });
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

  if (modalName === 'renameModal') {
    await channel.setName(value);
    return interaction.update(buildRoomControls(channel, room));
  }
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
    await channel.permissionOverwrites.edit(targetId, { Connect: false, ViewChannel: false });
    if (targetMember?.voice?.channelId === channel.id) {
      await targetMember.voice.disconnect('Banned by room owner').catch(() => {});
    }
    return interaction.update({ content: `Banned <@${targetId}> from this room. Use Permit to undo.`, components: [] });
  }

  if (selectName === 'permitSelect') {
    await channel.permissionOverwrites.edit(targetId, { Connect: true, ViewChannel: true });
    return interaction.update({ content: `Permitted <@${targetId}> to join this room.`, components: [] });
  }
}

async function handleSlashCommand(interaction) {
  const { commandName } = interaction;

  if (commandName === 'wh') {
    const user = getUser(interaction.user.id);
    const now = Date.now();
    const remaining = WORK_HUNT_COOLDOWN_MS - (now - user.lastWorkHuntAt);
    if (remaining > 0) {
      return interaction.reply({
        content: `You can hunt again in ${Math.ceil(remaining / 1000)}s.`,
        ephemeral: true,
      });
    }
    const earned = randomInt(WORK_HUNT_MIN, WORK_HUNT_MAX);
    user.lastWorkHuntAt = now;
    user.coins += earned;
    saveUsers();
    return interaction.reply(`🔫 ${interaction.user} went hunting and found **${earned} coins**!`);
  }

  if (commandName === 'wb') {
    const user = getUser(interaction.user.id);
    const now = Date.now();
    const remaining = WORK_BATTLE_COOLDOWN_MS - (now - user.lastWorkBattleAt);
    if (remaining > 0) {
      return interaction.reply({
        content: `You can battle again in ${Math.ceil(remaining / 1000)}s.`,
        ephemeral: true,
      });
    }
    const earned = randomInt(WORK_BATTLE_MIN, WORK_BATTLE_MAX);
    user.lastWorkBattleAt = now;
    user.coins += earned;
    saveUsers();
    return interaction.reply(`⚔️ ${interaction.user} won a battle and earned **${earned} coins**!`);
  }

  if (commandName === 'balance') {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const user = getUser(target.id);
    return interaction.reply({
      content: `${target}: **${user.coins} coins**`,
      ephemeral: target.id === interaction.user.id,
    });
  }

  if (commandName === 'level') {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const user = getUser(target.id);
    const need = xpToNextLevel(user.level);
    return interaction.reply({
      content: `${target}: **Level ${user.level}** — ${user.xp} XP (${need} XP to next level) — **${user.coins} coins**`,
      ephemeral: target.id === interaction.user.id,
    });
  }
}

client.login(DISCORD_TOKEN);
