// Simple JSON-file config store so settings survive bot restarts.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// BOT_INSTANCE allows several bot instances (e.g. "elsa", "anna") to run
// from this same directory without overwriting each other's settings.
const suffix = process.env.BOT_INSTANCE ? `.${process.env.BOT_INSTANCE}` : '';
const CONFIG_PATH = join(__dirname, `config${suffix}.json`);

// defaultUserLimit: max users allowed in each new room. 0 = unlimited.
const DEFAULTS = { defaultUserLimit: 0 };

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) };
  } catch (err) {
    console.error('Failed to read config.json, using defaults:', err);
    return { ...DEFAULTS };
  }
}

export function saveConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
