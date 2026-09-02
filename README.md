# Olaf — Game Room + Leveling Bot

A Discord bot for the "Ruang Game" (Game Room) category:

1. **Room by game** — members join the game lobby voice channel, then pick a game from a dropdown posted in that category's `#pengaturan` channel. A voice room named after the chosen game is created and they're moved into it. The room is deleted automatically once empty for 5 minutes.
2. **Room controls** — a persistent status embed and buttons (Lock, Hide, Rename, Kick, Ban, Permit, Claim, Invite) are posted directly in the room's own text chat when it's created. No Limit button — game rooms don't have a size restriction. Each button embeds the room's channel id in its customId (`vc:<action>:<roomId>`).
3. **XP & leveling** — members earn XP for time spent connected to a game room (`5 XP/minute`) and for chatting in that room's text chat (`3 XP` per eligible message, one per minute per user). Leveling up announces in the room and pays out coins.
4. **Coins** — `/work` pays out a random paycheck (100-300 coins) on a 1-hour cooldown. `/daily` pays a base 200 coins plus 20 per streak day (capped at streak 30) once every 24h; claiming again within 48h of the last claim keeps the streak going, waiting longer resets it to 0. Leveling up also pays a flat coin reward per band: levels 1-5 pay 500, 6-10 pay 750, 11-15 pay 1000, and so on (+250 every 5 levels).
5. `/balance` and `/level` check your (or someone else's) coins / level+XP.
6. **Couples** — `/couple propose @user` sends an Accept/Decline button; once accepted, both members are paired. `/couple share <amount>` transfers coins from you to your partner. `/couple status` shows your current partner, `/couple breakup` ends the pairing (frees both members to couple again).
7. `/help` — lists all commands and how they work.
8. **Moderation** — `/report <user> <reason>` (staff only, requires the Moderate Members permission) tracks a per-user report count and escalates automatically: 1st report = 12h timeout, 3rd report = 5 day timeout, 5th report = ban. Requires the bot's role to have Timeout Members / Ban Members and sit above the reported member's highest role.
9. **Grandma's recipes** — `/resep add <nama> <isi>` and `/resep hapus <nama>` are admin-only (checked against the Discord Administrator permission); `/resep lihat <nama>` and `/resep list` are open to everyone. Stored in `recipes.json`. Set `RESEP_CHANNEL_ID` to confine the whole command to one text channel.
10. **Announcements** — `/announce <message> [channel]` (admin-only) posts an `@everyone` embed, defaulting to the channel the command was run in. Requires the bot's role to have the "Mention @everyone" permission.
11. **Channel restrictions** — `REPORT_CHANNEL_ID` and `RESEP_CHANNEL_ID` (both optional) confine `/report` and `/resep` to one text channel each, so staff can monitor everything in one place. `BOT_CHANNEL_IDS` (optional, comma-separated) confines the general commands (`/work`, `/daily`, `/balance`, `/level`, `/couple`, `/help`) to a set of channels — e.g. dedicated "allbot" command channels — so they can't be used inside a game room's own auto-created chat. Leave any of these unset to allow the command anywhere. Game rooms themselves are already implicitly confined to wherever `GAME_LOBBY_CHANNEL_ID` and its category live — see "Server setup" below.

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
| `GAMES_PC` | Comma-separated PC game names for the "PC Game List" dropdown (max 25) |
| `GAMES_MOBILE` | Comma-separated mobile game names for the "Mobile Game List" dropdown (max 25) |
| `REPORT_CHANNEL_ID` | *(optional)* Right-click the reports text channel → Copy Channel ID |
| `RESEP_CHANNEL_ID` | *(optional)* Right-click the recipes text channel → Copy Channel ID |
| `BOT_CHANNEL_IDS` | *(optional)* Comma-separated channel ids where general commands are allowed (e.g. the "allbot" channels) |

The category the lobby sits in must have a text channel with "pengaturan" somewhere in its name — that's where the game picker gets posted.

## Server setup (Arcade Area example)

To keep everything scoped to one category (e.g. "ARCADE AREA"):

1. Put the game lobby voice channel and its `#pengaturan` text channel inside that category, and set `GAME_LOBBY_CHANNEL_ID` to the lobby's id. Game rooms can then only ever be created from there — there's no separate setting needed, since the picker only ever posts in that category's `#pengaturan` channel and only reacts to members connected to that exact lobby channel.
2. Create a text channel for reports (e.g. `#report`) in that category, right-click it → **Copy Channel ID**, and set `REPORT_CHANNEL_ID` in `.env` to that id. `/report` will then only work inside that channel — running it anywhere else gets an ephemeral "please use it in #report" reply — so every report staff issues shows up in one place.
3. Create a text channel for recipes (e.g. `#cooking-nenek`) the same way, and set `RESEP_CHANNEL_ID` to its id. `/resep` (add/lihat/list/hapus) then only works in that channel.
4. After changing `.env`, restart the bot (`pm2 restart olaf-bot` on the VPS) for the new values to take effect — no need to re-run `npm run deploy`, since these are runtime checks, not new slash commands.

Both `REPORT_CHANNEL_ID` and `RESEP_CHANNEL_ID` are optional — leave them blank and the commands work in any channel, same as before.

## 4. Register slash commands & run

```bash
npm run deploy
npm start
```

## Deployment

This bot lives on the **`olaf` branch of the `jtc` repo** (not a separate repo) so it reuses that repo's already-configured VPS secrets (`VPS_HOST`, `VPS_USER`, `VPS_PORT`, `VPS_SSH_KEY`). Pushing to the `olaf` branch triggers `.github/workflows/deploy.yml`, which clones/updates `~/olaf-bot` on the VPS, installs dependencies, registers slash commands, and restarts it under PM2 (`ecosystem.config.cjs`) as its own process (`olaf-bot`), independent of the `jtc`/`snowy` bots running on the same server.
