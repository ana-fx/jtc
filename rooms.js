// Persists the list of bot-created rooms so they survive a restart.
// Stored as { channelId: ownerId }.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOMS_PATH = join(__dirname, 'rooms.json');

export function loadRooms() {
  if (!existsSync(ROOMS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(ROOMS_PATH, 'utf8'));
  } catch (err) {
    console.error('Failed to read rooms.json, starting empty:', err);
    return {};
  }
}

export function saveRooms(rooms) {
  writeFileSync(ROOMS_PATH, JSON.stringify(rooms, null, 2));
}
