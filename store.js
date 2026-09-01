// Per-user persistent data (xp, level, coins, work cooldowns), stored as a
// single JSON file. Simple and consistent with the room bots' config/rooms
// stores — fine for this scale; move to a real database if this ever needs
// to handle heavy concurrent write volume.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = join(__dirname, 'users.json');

let cache = null;

function load() {
  if (cache) return cache;
  if (!existsSync(STORE_PATH)) {
    cache = {};
    return cache;
  }
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
    // JSON.parse succeeds on non-object values too (null, arrays, numbers,
    // ...); guard against those so a corrupted file can't crash getUser().
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    console.error('Failed to read users.json, starting empty:', err);
    cache = {};
  }
  return cache;
}

function save() {
  writeFileSync(STORE_PATH, JSON.stringify(cache, null, 2));
}

// Returns (creating if needed) a user's record: { xp, level, coins,
// lastMessageXpAt, lastWorkAt, lastDailyAt, dailyStreak, partnerId,
// reportCount }.
export function getUser(userId) {
  const users = load();
  if (!users[userId]) {
    users[userId] = {
      xp: 0,
      level: 1,
      coins: 0,
      lastMessageXpAt: 0,
      lastWorkAt: 0,
      lastDailyAt: 0,
      dailyStreak: 0,
      partnerId: null,
      reportCount: 0,
    };
  }
  // Backward compat: fill in fields added after a user's record was first
  // created.
  const user = users[userId];
  if (user.lastWorkAt === undefined) user.lastWorkAt = 0;
  if (user.lastDailyAt === undefined) user.lastDailyAt = 0;
  if (user.dailyStreak === undefined) user.dailyStreak = 0;
  if (user.partnerId === undefined) user.partnerId = null;
  if (user.reportCount === undefined) user.reportCount = 0;
  return user;
}

export function saveUsers() {
  save();
}
