import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

console.log('--- deploy-commands diagnostics ---');
console.log('DISCORD_TOKEN :', DISCORD_TOKEN ? `present (ends ...${DISCORD_TOKEN.slice(-6)})` : 'MISSING');
console.log('CLIENT_ID     :', CLIENT_ID || 'MISSING');
console.log('GUILD_ID      :', GUILD_ID || 'MISSING');
console.log('-----------------------------------');

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('ERROR: DISCORD_TOKEN, CLIENT_ID, and GUILD_ID must all be set in .env');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder().setName('wh').setDescription('Go hunting for coins (has a cooldown)').toJSON(),
  new SlashCommandBuilder().setName('wb').setDescription('Go into battle for coins (has a cooldown)').toJSON(),
  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check your (or someone else\'s) coin balance')
    .addUserOption((opt) => opt.setName('user').setDescription('Whose balance to check'))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('level')
    .setDescription('Check your (or someone else\'s) level and XP')
    .addUserOption((opt) => opt.setName('user').setDescription('Whose level to check'))
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

try {
  console.log(`Registering guild commands for app ${CLIENT_ID} on guild ${GUILD_ID}...`);
  const data = await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log(`SUCCESS: ${data.length} command(s) now registered on this guild:`);
  for (const cmd of data) {
    console.log(`  - /${cmd.name} (id: ${cmd.id})`);
  }
} catch (err) {
  console.error('FAILED to register commands.');
  if (err?.status) console.error('HTTP status   :', err.status);
  if (err?.code) console.error('Discord code  :', err.code);
  if (err?.rawError) console.error('Discord body  :', JSON.stringify(err.rawError, null, 2));
  console.error('Full error:', err);
  process.exit(1);
}
