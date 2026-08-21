import { clamp, clamp01, lerp } from '../../util.js';
import { depthBandAt } from '../../data.js';

export const FISH_APPROACH_SPEED_MUL = 1.45;
export const FISH_NIBBLE_SPEED_MUL = 0.35;
export const FISH_STARTLE_SPEED_MUL = 1.5;
export const FISH_FLEE_SPEED_MUL = 1.7;

export function fishBaseSpeed(lengthCm) {
  return 0.78 + (lengthCm / 100) * 1.7;
}

export function approachRadius(lengthCm) {
  return 0.5 + lengthCm * 0.004;
}

export function wanderSpeedMul(phase, timeSec, startled = false) {
  if (startled) return FISH_STARTLE_SPEED_MUL;
  return 0.26 + Math.sin(phase + timeSec * 0.6) * 0.05;
}

export function nibbleTarget(bait, phase, timeSec) {
  const a = timeSec * 1.6 + phase;
  return {
    x: bait.x + Math.cos(a) * 0.45,
    y: bait.y + Math.sin(a * 0.7) * 0.18,
    z: bait.z + Math.sin(a) * 0.45,
  };
}

export function preferredFishY(sp, depth, band = null, depthBias = 0.5) {
  const [b0, b1] = depthBandAt(sp, band);
  const dmin = Math.min(b0, Math.max(0.4, depth - 0.5));
  const dmax = Math.min(b1, Math.max(0.6, depth - 0.4));
  return -lerp(dmin, dmax, depthBias);
}

export function pickWanderTarget({ fish, terrain, band = null, rng = Math.random }) {
  for (let i = 0; i < 12; i++) {
    const a = rng() * Math.PI * 2;
    const r = 3 + rng() * 13;
    const x = fish.x + Math.cos(a) * r;
    const z = fish.z + Math.sin(a) * r;
    const depth = terrain.depthAt(x, z);
    if (depth < Math.max(0.5, fish.species.depth[0] * 0.5)) continue;
    if (depth > fish.species.depth[1] + 8) continue;
    const delta = -0.3 + rng() * 0.6;
    const depthBias = clamp01((fish.depthBias ?? 0.5) + delta);
    return { x, y: preferredFishY(fish.species, depth, band, depthBias), z, depthBias, found: true };
  }
  return { x: fish.x * 0.9, y: fish.y, z: fish.z * 0.9, depthBias: fish.depthBias ?? 0.5, found: false };
}

export function steerVelocity(state, target, speedMul, dt) {
  const dx = target.x - state.x, dy = target.y - state.y, dz = target.z - state.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 0.001) return { vx: state.vx || 0, vy: state.vy || 0, vz: state.vz || 0, dist };
  const speed = fishBaseSpeed(state.length) * speedMul;
  const desiredX = dx / dist * speed;
  const desiredY = dy / dist * speed * 0.55;
  const desiredZ = dz / dist * speed;
  const alpha = 1 - Math.exp(-2.6 * dt);
  return {
    vx: (state.vx || 0) + (desiredX - (state.vx || 0)) * alpha,
    vy: (state.vy || 0) + (desiredY - (state.vy || 0)) * alpha,
    vz: (state.vz || 0) + (desiredZ - (state.vz || 0)) * alpha,
    dist,
  };
}

export function startleDuration(sec, rng = Math.random) {
  return sec * (0.75 + rng() * 0.5);
}

export function startleTarget(fish, x, z) {
  const dx = fish.x - x, dz = fish.z - z;
  const d = Math.hypot(dx, dz) || 1;
  return { x: fish.x + dx / d * 14, y: fish.y, z: fish.z + dz / d * 14 };
}

export function clampFishDepth({ x, y, z, vy = 0, length, terrain, surfaceY = 0 }) {
  const bed = terrain.heightAt ? terrain.heightAt(x, z) : -terrain.depthAt(x, z);
  const minY = bed + 0.22 + length * 0.0016;
  const maxY = surfaceY - 0.18 - length * 0.0012;
  let nextY = y, nextVy = vy;
  if (nextY < minY) { nextY = minY; nextVy = Math.max(0, nextVy); }
  if (nextY > maxY) { nextY = maxY; nextVy = Math.min(0, nextVy); }
  if (maxY < minY) nextY = (maxY + minY) * 0.5;
  return { y: nextY, vy: nextVy };
}
