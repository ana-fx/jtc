# Olaf — Game Room + Leveling Bot

A Discord bot for the "Ruang Game" (Game Room) category:

1. **Room by game** — members join the game lobby voice channel, then pick a game from a dropdown posted in that category's `#pengaturan` channel. A voice room named after the chosen game is created and they're moved into it. The room is deleted automatically once empty for 5 minutes.
2. **Room controls** — a persistent status embed and buttons (Lock, Hide, Rename, Kick, Ban, Permit, Claim, Invite) are posted directly in the room's own text chat when it's created. No Limit button — game rooms don't have a size restriction. Each button embeds the room's channel id in its customId (`vc:<action>:<roomId>`).
3. **XP & leveling** — members earn XP for time spent connected to a game room (`5 XP/minute`) and for chatting in that room's text chat (`3 XP` per eligible message, one per minute per user). Leveling up announces in the room and pays out coins.
4. **Coins** — `/wh` (work: hunt) and `/wb` (work: battle) give a random amount of coins on a cooldown (30s / 60s). Leveling up also pays a flat coin reward per band: levels 1-5 pay 500, 6-10 pay 750, 11-15 pay 1000, and so on (+250 every 5 levels).
5. `/balance` and `/level` check your (or someone else's) coins / level+XP.

Shop and gacha cards are intentionally **not** included yet — planned for a later phase.

---

## 1. Prerequisites

Node.js 18+:

```bash
node --version
```

```bash
npm install
```

## 2. Create the Bot on Discord

1. https://discord.com/developers/applications → **New Application**.
2. **Bot** → **Reset Token** → paste into `DISCORD_TOKEN` in `.env`.
3. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`; permissions: View Channels, Manage Channels, Move Members, Connect.
4. Open the generated URL to invite the bot.
5. **Server Settings → Roles → Olaf** → enable **Manage Roles** on the role. This is required for the Ban/Permit/Claim buttons to edit other members' permission overwrites on a room — without it those specific buttons fail with a 50013 error even though everything else works.

## 3. Configure

```bash
cp .env.example .env
```

| Variable | How to get it |
|---|---|
| `DISCORD_TOKEN` | Bot page (step 2) |
| `CLIENT_ID` | General Information → Application ID |
| `GUILD_ID` | Right-click server name → Copy Server ID |
| `GAME_LOBBY_CHANNEL_ID` | Right-click the "Ruang Game" voice channel → Copy Channel ID |
| `GAMES` | Comma-separated game names for the picker (max 25) |

The category the lobby sits in must have a text channel with "pengaturan" somewhere in its name — that's where the game picker gets posted.

## 4. Register slash commands & run

```bash
npm run deploy
npm start
```

## Deployment

This bot lives on the **`olaf` branch of the `jtc` repo** (not a separate repo) so it reuses that repo's already-configured VPS secrets (`VPS_HOST`, `VPS_USER`, `VPS_PORT`, `VPS_SSH_KEY`). Pushing to the `olaf` branch triggers `.github/workflows/deploy.yml`, which clones/updates `~/olaf-bot` on the VPS, installs dependencies, registers slash commands, and restarts it under PM2 (`ecosystem.config.cjs`) as its own process (`olaf-bot`), independent of the `jtc`/`snowy` bots running on the same server.
