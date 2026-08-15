import 'dotenv/config';
import {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from 'discord.js';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

// Diagnostics: show which config values are loaded (token is masked).
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

console.log(
  `Preparing ${commands.length} command(s): ` +
    commands.map((c) => `/${c.name}`).join(', '),
);

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

try {
  console.log(`Registering guild commands for app ${CLIENT_ID} on guild ${GUILD_ID}...`);
  const data = await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands },
  );
  console.log(`SUCCESS: ${data.length} command(s) now registered on this guild:`);
  for (const cmd of data) {
    console.log(`  - /${cmd.name} (id: ${cmd.id})`);
  }
} catch (err) {
  console.error('FAILED to register commands.');
  // Surface the specific Discord/HTTP details so the exact cause is visible.
  if (err?.status) console.error('HTTP status   :', err.status);
  if (err?.code) console.error('Discord code  :', err.code);
  if (err?.rawError) console.error('Discord body  :', JSON.stringify(err.rawError, null, 2));
  console.error('Full error:', err);
  process.exit(1);
}
