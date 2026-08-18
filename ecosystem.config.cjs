// PM2 process definitions for the voice-room bots.
//
// Several bot instances run from this same directory, each with its own env
// file and its own config/rooms JSON files (kept apart via BOT_INSTANCE):
//   .env       -> app "jtc-voice-bot"  (legacy single-bot setup)
//   .env.elsa  -> app "elsa-room-bot"  (Family Room lobby, limit 7+)
//   .env.anna  -> app "anna-room-bot"  (Bedroom 1-3 + Library 4-6 lobbies)
//   .env.olaf  -> app "olaf-room-bot"  (Game Room lobby, no limit)
// Only instances whose env file exists are started, so this file works both
// before and after the multi-bot env files are created.
//
// Usage on the VPS:
//   pm2 startOrRestart ecosystem.config.cjs
//   pm2 save        # persist across reboots (run `pm2 startup` once first)
const { existsSync } = require('fs');
const { join } = require('path');

const base = {
  script: 'index.js',
  cwd: __dirname,
  instances: 1,
  autorestart: true,
  watch: false,
  max_memory_restart: '256M',
};

const apps = [];

// Legacy single-bot setup using plain .env
if (existsSync(join(__dirname, '.env'))) {
  apps.push({
    ...base,
    name: 'jtc-voice-bot',
    env: { NODE_ENV: 'production' },
  });
}

// Named instances: .env.<instance> -> "<instance>-room-bot"
for (const instance of ['elsa', 'anna', 'olaf']) {
  const envFile = join(__dirname, `.env.${instance}`);
  if (existsSync(envFile)) {
    apps.push({
      ...base,
      name: `${instance}-room-bot`,
      env: {
        NODE_ENV: 'production',
        DOTENV_CONFIG_PATH: envFile,
        BOT_INSTANCE: instance,
      },
    });
  }
}

module.exports = { apps };
