import { rollLength, rollAlbino } from '../../data.js';
import { pickSpecies } from './rules.js';

export const BITER_EXISTING_RADIUS = 18;
export const BITER_SPAWN_MIN_RADIUS = 5.5;
export const BITER_SPAWN_MAX_RADIUS = 9.5;

export function chooseBiterSpecies(ctx, rng = Math.random) {
  return pickSpecies(ctx, rng);
}

export function findExistingBiter(fishes, speciesId, x, z, now = Date.now()) {
  let best = null, bestD = Infinity;
  for (const f of fishes) {
    if (f.speciesId !== speciesId || f.state !== 'swimming' || now < (f.startleUntil || 0)) continue;
    const d = Math.hypot(f.x - x, f.z - z);
    if (d < BITER_EXISTING_RADIUS && d < bestD) { best = f; bestD = d; }
  }
  return best;
}

export function makeBiterSpawn({ species, x, z, baitY, terrain, rng = Math.random, rareBonus = 0 }) {
  const angle = rng() * Math.PI * 2;
  const length = rollLength(species, rareBonus);
  const albino = rollAlbino(species);
  for (let i = 0; i < 20; i++) {
    const r = BITER_SPAWN_MIN_RADIUS + rng() * (BITER_SPAWN_MAX_RADIUS - BITER_SPAWN_MIN_RADIUS);
    const px = x + Math.cos(angle + i * 0.7) * r;
    const pz = z + Math.sin(angle + i * 0.7) * r;
    const depth = terrain.depthAt(px, pz);
    if (depth < 0.8) continue;
    const jitter = -1 + rng() * 2;
    const fishDepth = Math.max(0.35, Math.min(Math.min(-baitY + jitter, depth - 0.4), Math.max(0.4, depth - 0.35)));
    return { x: px, y: -fishDepth, z: pz, length, albino, depthBias: rng() };
  }
  return null;
}
