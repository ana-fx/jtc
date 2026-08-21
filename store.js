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
    cache = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
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
// lastMessageXpAt, lastWorkAt }.
export function getUser(userId) {
  const users = load();
  if (!users[userId]) {
    users[userId] = {
      xp: 0,
      level: 1,
      coins: 0,
      lastMessageXpAt: 0,
      lastWorkAt: 0,
    };
  }
  // Backward compat: users created before /work replaced /wh + /wb won't
  // have lastWorkAt yet.
  if (users[userId].lastWorkAt === undefined) users[userId].lastWorkAt = 0;
  return users[userId];
}

export function saveUsers() {
  save();
}
