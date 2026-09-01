// Grandma's recipe book — a simple named text store, same JSON-file pattern
// as store.js/config.js. Keyed by lowercased recipe name.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = join(__dirname, 'recipes.json');

let cache = null;

function load() {
  if (cache) return cache;
  if (!existsSync(STORE_PATH)) {
    cache = {};
    return cache;
  }
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    console.error('Failed to read recipes.json, starting empty:', err);
    cache = {};
  }
  return cache;
}

function save() {
  writeFileSync(STORE_PATH, JSON.stringify(cache, null, 2));
}

export function getRecipe(name) {
  return load()[name.toLowerCase()] ?? null;
}

export function listRecipes() {
  return Object.values(load());
}

export function setRecipe(name, content, addedBy) {
  const recipes = load();
  recipes[name.toLowerCase()] = { name, content, addedBy, addedAt: Date.now() };
  save();
}

export function deleteRecipe(name) {
  const recipes = load();
  const key = name.toLowerCase();
  if (!recipes[key]) return false;
  delete recipes[key];
  save();
  return true;
}
