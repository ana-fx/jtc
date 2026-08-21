# JTC — Discord Voice Room Bot

A Discord bot that automatically creates **voice rooms** for users. Three ways to use it:

1. **Join to Create** — a user simply joins a designated "lobby" voice channel, and the bot instantly creates a new room and moves them into it. The room is **automatically deleted once empty**.
2. **Slash command `/voice`** — a user already in a voice channel can create a private room at any time.
3. **Slash command `/setlimit <count>`** — an admin (with the *Manage Channels* permission) sets the maximum number of users allowed in each new room. `0` = unlimited, max `99`. The value is stored in `config.json` and persists across restarts.
4. **Limit lobbies** — multiple lobby channels, each producing rooms with its own user-limit range (e.g. Bedroom 1-3, Library 4-6, Family Room 7+). Rooms are created in the same category as their lobby, and the owner can only change the limit within the range. Configured via the `LOBBIES` env var — see `.env.example`.
   - **Bounded lobbies** (a finite max, e.g. `1:3`) don't auto-create on join: the bot posts a "choose your room size" picker in the category's **#pengaturan** channel (alongside the room-control panel), listing every value in the range. The member must stay connected to the lobby voice channel while picking; the room is then created with exactly that limit and they're moved in.
   - **Unbounded lobbies** (`max` = `0`, e.g. `7:0`) keep the simple auto-create-on-join behavior, starting at the minimum.

---

## 1. Prerequisites

Requires **Node.js version 18 or newer**. Check with:

```bash
node --version
```

Install dependencies:

```bash
npm install
```

## 2. Create the Bot on Discord

1. Open https://discord.com/developers/applications → **New Application**.
2. Go to **Bot** → **Reset Token** → copy the token → paste it into `DISCORD_TOKEN` in the `.env` file.
3. On the **Bot** page, the *Voice States* intent (used by this bot) is enabled by default; you don't need Server Members or Presence intents.
4. Go to **OAuth2 → URL Generator**: check the **`bot`** and **`applications.commands`** scopes, then under **Bot Permissions** check:
   - Manage Channels
   - Move Members
   - Connect
   - View Channels
5. Open the generated URL to **invite the bot** to your server.

## 3. Configure

Copy the template and fill in the values:

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | How to get it |
|---|---|
| `DISCORD_TOKEN` | From the Bot page (step 2) |
| `CLIENT_ID` | General Information → Application ID |
| `GUILD_ID` | Right-click the server name → Copy Server ID |
| `JOIN_TO_CREATE_CHANNEL_ID` | Create a voice channel (e.g. "Join to Create"), right-click it → Copy Channel ID |
| `CATEGORY_ID` | (optional) category where new rooms are created |

> To use "Copy ... ID", enable **Developer Mode** in Discord: Settings → Advanced → Developer Mode.

## 4. Register Slash Commands

```bash
npm run deploy
```

## 5. Run the Bot

```bash
npm start
```

When you see `Logged in as ...`, the bot is active. Try joining the lobby channel, or type `/voice` in the server.

---

## How It Works

- **`index.js`** — listens for the `voiceStateUpdate` event. When someone joins the lobby, the bot creates a new channel and moves them into it. When a bot-created channel becomes empty, it is deleted.
- **Room controls** — when a room is created, the bot posts a persistent status embed and action buttons (Lock, Hide, Rename, Kick, Ban, Permit, Claim, Invite) directly in the room's own text chat. A **Limit** button is also included, but only for rooms whose size wasn't fixed by a bounded lobby's picker: rooms from an unbounded lobby (e.g. Family Room, auto-created at its minimum), `/voice`, or the legacy single-lobby setup can still have their limit changed afterward; rooms created by explicitly picking a size from a bounded lobby (e.g. Bedroom/Library) have that exact limit locked in and get no Limit button. Each button embeds the room's channel id in its customId (`vc:<action>:<roomId>`).
- Rooms are tracked only while the bot is running. **If the bot restarts**, previously created rooms are no longer tracked (and won't be auto-deleted). For permanent tracking, this would need a database (can be added later).

## Deployment

See [DEPLOY.md](DEPLOY.md) for deploying to a VPS with PM2. A GitHub Actions
workflow ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)) is
included to auto-deploy on every push to `main`.

## Troubleshooting

- **Bot is online but doesn't create rooms** → check that `JOIN_TO_CREATE_CHANNEL_ID` is correct and that the bot has the *Manage Channels* + *Move Members* permissions on that category.
- **`/voice` doesn't show up** → run `npm run deploy` again, and make sure the bot was invited with the `applications.commands` scope.
- **Error `Used disallowed intents`** → check the intent settings in the Developer Portal.
- **Error 50013 (Missing Permissions)** → the bot needs *Manage Channels* on the specific category where rooms are created; category-level permission overwrites can override server-level ones.
