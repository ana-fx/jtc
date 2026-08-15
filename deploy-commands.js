import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

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
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

try {
  console.log('⏳ Registering slash commands...');
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands },
  );
  console.log('✅ Slash command /voice registered for this guild.');
} catch (err) {
  console.error('Failed to register commands:', err);
  process.exit(1);
}
