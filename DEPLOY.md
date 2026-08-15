# Deployment Guide (VPS)

Instructions for deploying the JTC Discord voice-room bot to a Linux VPS.
This document is written so an automated DevOps agent can follow it step by step.

## Overview

- **Runtime:** Node.js 18+ (LTS recommended)
- **Type:** long-running Discord bot (no inbound ports, no web server)
- **Process manager:** PM2 (keeps the bot alive and auto-restarts on crash/reboot)
- **Repository:** https://github.com/ana-fx/jtc

## Prerequisites on the VPS

1. A Linux server (Ubuntu/Debian assumed below) with sudo access.
2. Outbound HTTPS access to Discord (no inbound firewall rules needed).
3. Node.js 18+ and Git installed.

Install Node.js LTS + Git (Ubuntu/Debian):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
node --version   # must be >= 18
```

Install PM2 globally:

```bash
sudo npm install -g pm2
```

## Deploy steps

```bash
# 1. Clone the repository
git clone https://github.com/ana-fx/jtc.git
cd jtc

# 2. Install production dependencies
npm ci --omit=dev   # falls back to `npm install --omit=dev` if no lockfile

# 3. Create the environment file from the template
cp .env.example .env
```

Then edit `.env` and fill in the real values (do NOT commit this file):

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Bot token from the Discord Developer Portal |
| `CLIENT_ID` | Application ID |
| `GUILD_ID` | Target Discord server ID |
| `JOIN_TO_CREATE_CHANNEL_ID` | Voice channel ID that triggers room creation |
| `CATEGORY_ID` | (optional) category for new rooms |

```bash
# 4. Register the /voice slash command (run once, and again whenever
#    commands change)
npm run deploy

# 5. Start the bot under PM2
pm2 start ecosystem.config.cjs

# 6. Persist across reboots
pm2 save
pm2 startup    # run the command it prints, then `pm2 save` again
```

## Verify

```bash
pm2 status              # process should be "online"
pm2 logs jtc-voice-bot  # expect: "Logged in as <bot>#0000"
```

## Updating to a new version

```bash
cd jtc
git pull
npm ci --omit=dev
npm run deploy          # only if slash commands changed
pm2 restart jtc-voice-bot
```

## Security notes

- The `.env` file holds the bot token — never commit it and keep file
  permissions tight: `chmod 600 .env`.
- The bot needs no open inbound ports; do not expose anything publicly.
- If the token is ever leaked, reset it in the Discord Developer Portal and
  update `.env`, then `pm2 restart jtc-voice-bot`.
