import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';

const {
  DISCORD_TOKEN,
  JOIN_TO_CREATE_CHANNEL_ID,
  CATEGORY_ID,
} = process.env;

if (!DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN is not set in the .env file');
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
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`   Lobby channel: ${JOIN_TO_CREATE_CHANNEL_ID || '(not configured)'}`);
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
      name: `🔊 ${member.displayName}'s Room`,
      type: ChannelType.GuildVoice,
      parent: parentId,
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

    console.log(`➕ Created room "${channel.name}" for ${member.user.tag}`);
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
    console.log(`➖ Deleted empty room "${channel.name}"`);
  } catch (err) {
    console.error('Failed to delete room:', err);
  }
}

client.on('voiceStateUpdate', async (oldState, newState) => {
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

// ── Slash command: /voice creates a room manually ──────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'voice') return;

  const member = interaction.member;
  if (!member?.voice?.channel) {
    await interaction.reply({
      content: '⚠️ You must be in a voice channel to use this command.',
      ephemeral: true,
    });
    return;
  }

  const room = await createRoomFor(member, member.voice.channel);
  if (room) {
    await interaction.reply({
      content: `✅ Room created: **${room.name}** — you have been moved into it.`,
      ephemeral: true,
    });
  } else {
    await interaction.reply({
      content: '❌ Failed to create the room. Check the bot permissions (Manage Channels & Move Members).',
      ephemeral: true,
    });
  }
});

// Note: rooms are only tracked for the current session. After a restart,
// previously created rooms are no longer tracked (and won't be auto-deleted).
client.login(DISCORD_TOKEN);
