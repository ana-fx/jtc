import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';
import { loadConfig, saveConfig } from './config.js';

const {
  DISCORD_TOKEN,
  JOIN_TO_CREATE_CHANNEL_ID,
  CATEGORY_ID,
} = process.env;

// Persistent settings (e.g. default user limit for new rooms).
const config = loadConfig();

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

// Tracks the IDs of voice channels created by the bot, so they can be
// deleted once they become empty. Set<channelId>
const tempChannels = new Set();

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag} (id: ${client.user.id})`);
  console.log(`Default room user limit: ${config.defaultUserLimit} (0 = unlimited)`);
  console.log(`Configured lobby channel: ${JOIN_TO_CREATE_CHANNEL_ID || '(not configured)'}`);

  // Diagnostics: which guilds is the bot actually in, and does the lobby
  // channel resolve? This reveals a wrong GUILD_ID / wrong-server problem.
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
});

/**
 * Creates a new voice room for a member and moves them into it.
 * @returns {Promise<import('discord.js').VoiceChannel | null>}
 */
async function createRoomFor(member, lobbyChannel) {
  const guild = member.guild;
  const parentId = CATEGORY_ID || lobbyChannel.parentId || null;

  try {
    const channel = await guild.channels.create({
      name: `${member.displayName}'s Room`,
      type: ChannelType.GuildVoice,
      parent: parentId,
      // 0 = unlimited. Configurable via the /setlimit command.
      userLimit: config.defaultUserLimit,
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

    tempChannels.add(channel.id);

    // Move the member into the new room (if still connected to voice).
    if (member.voice.channel) {
      await member.voice.setChannel(channel);
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
    console.log(`Deleted empty room "${channel.name}"`);
  } catch (err) {
    console.error('Failed to delete room:', err);
  }
}

client.on('voiceStateUpdate', async (oldState, newState) => {
  // Diagnostic: trace every voice move so join-to-create can be debugged.
  if (oldState.channelId !== newState.channelId) {
    console.log(
      `voiceStateUpdate: ${newState.member?.user.tag} ` +
        `${oldState.channelId || 'none'} -> ${newState.channelId || 'none'} ` +
        `(lobby is ${JOIN_TO_CREATE_CHANNEL_ID})`,
    );
  }

  // 1) A user joined the lobby channel => create a new room for them.
  if (
    newState.channelId === JOIN_TO_CREATE_CHANNEL_ID &&
    newState.member
  ) {
    await createRoomFor(newState.member, newState.channel);
  }

  // 2) A user left a channel => check whether the old channel (created by
  //    the bot) is now empty, and delete it if so.
  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    await deleteIfEmpty(oldState.channel);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  console.log(
    `interaction: /${interaction.commandName} from ${interaction.user.tag} ` +
      `in guild ${interaction.guildId}`,
  );

  // ── /voice: create a room manually ───────────────────────────────────────
  if (interaction.commandName === 'voice') {
    const member = interaction.member;
    if (!member?.voice?.channel) {
      await interaction.reply({
        content: 'You must be in a voice channel to use this command.',
        ephemeral: true,
      });
      return;
    }

    const room = await createRoomFor(member, member.voice.channel);
    if (room) {
      await interaction.reply({
        content: `Room created: **${room.name}** — you have been moved into it.`,
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: 'Failed to create the room. Check the bot permissions (Manage Channels & Move Members).',
        ephemeral: true,
      });
    }
    return;
  }

  // ── /setlimit: set the default user limit for new rooms (admins only) ─────
  if (interaction.commandName === 'setlimit') {
    // Guard: only members with Manage Channels may change this.
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.reply({
        content: 'You need the Manage Channels permission to use this command.',
        ephemeral: true,
      });
      return;
    }

    const limit = interaction.options.getInteger('count', true);
    config.defaultUserLimit = limit;
    saveConfig(config);

    const label = limit === 0 ? 'unlimited' : `${limit} user(s)`;
    console.log(`${interaction.user.tag} set default room limit to ${label}`);
    await interaction.reply({
      content: `Default room user limit set to **${label}**. This applies to newly created rooms.`,
      ephemeral: true,
    });
    return;
  }
});

// Note: rooms are only tracked for the current session. After a restart,
// previously created rooms are no longer tracked (and won't be auto-deleted).
client.login(DISCORD_TOKEN);
