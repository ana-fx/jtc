// PM2 process definition for the Discord voice-room bot.
// Usage on the VPS:
//   pm2 start ecosystem.config.cjs
//   pm2 save        # persist across reboots (run `pm2 startup` once first)
module.exports = {
  apps: [
    {
      name: 'jtc-voice-bot',
      script: 'index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
