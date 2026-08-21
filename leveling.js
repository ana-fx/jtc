// XP curve and level-up money reward. Kept isolated so the formulas are easy
// to tune without touching bot logic.

// XP required to go from level N to level N+1. Linear growth: each level
// needs 100 more XP than the last (level 1->2 needs 100, 2->3 needs 200, ...).
export function xpToNextLevel(level) {
  return 100 * level;
}

// Given a total lifetime XP amount, returns the current level (starting at 1).
export function levelForXp(xp) {
  let level = 1;
  let remaining = xp;
  while (remaining >= xpToNextLevel(level)) {
    remaining -= xpToNextLevel(level);
    level += 1;
  }
  return level;
}

// Flat coin reward for reaching `level` (paid once per level gained).
// Bands: 1-5 -> 500, 6-10 -> 750, 11-15 -> 1000, 16-20 -> 1250, ... (+250
// every 5 levels after the first band).
export function levelUpReward(level) {
  if (level <= 5) return 500;
  const band = Math.floor((level - 6) / 5);
  return 750 + band * 250;
}

// Applies `xpGain` to a user record (from store.js), leveling them up as
// many times as earned and returning info about what happened so the
// caller can announce it.
export function addXp(user, xpGain) {
  const startLevel = user.level;
  user.xp += xpGain;
  let newLevel = levelForXp(user.xp);
  let coinsEarned = 0;
  for (let lvl = startLevel + 1; lvl <= newLevel; lvl++) {
    coinsEarned += levelUpReward(lvl);
  }
  user.level = newLevel;
  user.coins += coinsEarned;
  return { leveledUp: newLevel > startLevel, fromLevel: startLevel, toLevel: newLevel, coinsEarned };
}
