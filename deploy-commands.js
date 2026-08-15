import 'dotenv/config';
import {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from 'discord.js';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('❌ DISCORD_TOKEN, CLIENT_ID, and GUILD_ID must be set in .env');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Create a private voice room and move into it')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('setlimit')
    .setDescription('Set the max users for new voice rooms (0 = unlimited)')
    .addIntegerOption((option) =>
      option
        .setName('count')
        .setDescription('Maximum users per room (0-99, 0 = unlimited)')
        .setMinValue(0)
        .setMaxValue(99)
        .setRequired(true),
    )
    // Only members with Manage Channels see/use this command by default.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

try {
  console.log('⏳ Registering slash commands...');
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands },
  );
  console.log('✅ Slash commands /voice and /setlimit registered for this guild.');
} catch (err) {
  console.error('Failed to register commands:', err);
  process.exit(1);
}
