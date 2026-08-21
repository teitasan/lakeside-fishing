import { makeLake } from '../../src/lakefield.js';
import { REAL_FISH } from '../../src/data.js';

const SEED = 123456789;
const TICK = 0.1;
const BASE_FISH = 18;
const PER_EXTRA_PLAYER = 8;
const MAX_FISH = 50;
const ACTIVE_R = 72;
const DESPAWN_R = 92;
const APPROACH_R = 30;
const BITE_R = 0.9;

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function weightedSpecies(depth) {
  const list = REAL_FISH.filter((sp) => sp.rarity > 0 && depth >= sp.depth[0] * 0.65 && depth <= sp.depth[1] + 5);
  let total = 0;
  for (const sp of list) total += Math.max(0, sp.spawn || 0);
  if (!total) return REAL_FISH.find((sp) => sp.id === 'bluegill') || REAL_FISH[0];
  let r = Math.random() * total;
  for (const sp of list) {
    r -= Math.max(0, sp.spawn || 0);
    if (r <= 0) return sp;
  }
  return list[list.length - 1];
}

export class SharedWorld {
  constructor() {
    this.lake = makeLake(SEED);
    this.fishes = new Map();
    this.baits = new Map();
    this.seq = 1;
    this.weather = 'clear';
    this.weatherChangedAt = Date.now();
  }

  targetCount(players) {
    return Math.min(MAX_FISH, BASE_FISH + Math.max(0, players.length - 1) * PER_EXTRA_PLAYER);
  }

  spawnNear(players) {
    if (!players.length) return null;
    for (let tries = 0; tries < 30; tries++) {
      const p = players[Math.floor(Math.random() * players.length)];
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z) || p.fresh) continue;
      const a = rand(0, Math.PI * 2), r = rand(10, ACTIVE_R);
      const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
      const depth = this.lake.depthAt(x, z);
      if (depth < 0.8) continue;
      const sp = weightedSpecies(depth);
      if (!sp) continue;
      const length = Math.round(rand(sp.len[0], sp.len[1]) * 10) / 10;
      const fishDepth = clamp(rand(sp.depth[0], Math.min(sp.depth[1], depth - 0.35)), 0.35, Math.max(0.4, depth - 0.35));
      const id = `f${this.seq++}`;
      const fish = {
        id, speciesId: sp.id, length, albino: Math.random() < 0.002,
        x, y: -fishDepth, z, vx: rand(-0.4, 0.4), vz: rand(-0.4, 0.4),
        tx: x, tz: z, state: 'swimming', targetBaitId: null, ownerPlayerId: null,
        turnAt: 0, stateAt: Date.now(),
      };
      this.fishes.set(id, fish);
      return fish;
    }
    return null;
  }

  setBait(playerId, bait) {
    if (!bait) { this.baits.delete(playerId); return; }
    const x = +bait.x, y = +bait.y, z = +bait.z;
    if (![x, y, z].every(Number.isFinite)) return;
    if (Math.abs(x) > 500 || Math.abs(z) > 500 || y > 2 || y < -60) return;
    this.baits.set(playerId, {
      id: `b:${playerId}`, playerId, x, y, z,
      baitType: String(bait.baitType || '').slice(0, 24),
      rigLayer: String(bait.rigLayer || '').slice(0, 12),
      at: Date.now(),
    });
  }

  hook(playerId, fishId) {
    const f = this.fishes.get(fishId);
    if (!f || f.ownerPlayerId !== playerId || f.state !== 'reserved') return false;
    f.state = 'hooked'; f.stateAt = Date.now();
    return true;
  }

  fightUpdate(playerId, fishId, pos) {
    const f = this.fishes.get(fishId);
    if (!f || f.ownerPlayerId !== playerId || f.state !== 'hooked') return;
    const x = +pos.x, y = +pos.y, z = +pos.z;
    if (![x, y, z].every(Number.isFinite)) return;
    f.x = x; f.y = y; f.z = z;
  }

  endFight(playerId, fishId, result) {
    const f = this.fishes.get(fishId);
    if (!f || f.ownerPlayerId !== playerId) return null;
    if (result === 'caught') {
      this.fishes.delete(fishId);
      this.baits.delete(playerId);
      return { removed: true, fish: f };
    }
    f.state = 'swimming'; f.ownerPlayerId = null; f.targetBaitId = null;
    f.stateAt = Date.now(); f.turnAt = 0;
    f.vx = rand(-1.8, 1.8); f.vz = rand(-1.8, 1.8);
    this.baits.delete(playerId);
    return { removed: false, fish: f };
  }

  dropPlayer(playerId) {
    this.baits.delete(playerId);
    for (const f of this.fishes.values()) {
      if (f.ownerPlayerId === playerId) {
        f.ownerPlayerId = null; f.targetBaitId = null; f.state = 'swimming'; f.stateAt = Date.now();
      }
    }
  }

  tick(players) {
    const now = Date.now();
    if (now - this.weatherChangedAt > 180000) {
      const options = ['clear', 'cloudy', 'rain'].filter((w) => w !== this.weather);
      this.weather = options[Math.floor(Math.random() * options.length)];
      this.weatherChangedAt = now;
    }

    const wanted = this.targetCount(players);
    while (this.fishes.size < wanted) {
      if (!this.spawnNear(players)) break;
    }

    // 1つの仕掛けに同時に寄れる魚は1匹だけ。approaching/reserved/hookedの全状態で占有扱いにする。
    // これが無いと複数匹が同じ餌でreservedになり、7秒停止する魚が量産される。
    const occupiedBaits = new Set();
    for (const f of this.fishes.values()) {
      if (f.targetBaitId && (f.state === 'approaching' || f.state === 'reserved' || f.state === 'hooked')) {
        occupiedBaits.add(f.targetBaitId);
      }
    }

    for (const [id, f] of this.fishes) {
      if (f.state === 'hooked') continue;
      if (f.state === 'reserved') {
        if (now - f.stateAt > 7000) {
          occupiedBaits.delete(f.targetBaitId);
          f.state = 'swimming'; f.ownerPlayerId = null; f.targetBaitId = null;
        }
        continue;
      }

      if (f.state === 'approaching') {
        const bait = [...this.baits.values()].find((b) => b.id === f.targetBaitId);
        if (!bait) {
          occupiedBaits.delete(f.targetBaitId);
          f.state = 'swimming'; f.targetBaitId = null;
        } else {
          const dx = bait.x - f.x, dz = bait.z - f.z;
          const d = Math.hypot(dx, dz);
          const speed = 1.4 + Math.min(1.5, f.length / 100);
          if (d > 0.001) { f.vx = dx / d * speed; f.vz = dz / d * speed; }
          f.x += f.vx * TICK; f.z += f.vz * TICK;
          f.y += (bait.y - f.y) * 0.08;
          if (d <= BITE_R) {
            f.state = 'reserved'; f.ownerPlayerId = bait.playerId; f.stateAt = now;
          } else if (now - f.stateAt > 18000) {
            occupiedBaits.delete(f.targetBaitId);
            f.state = 'swimming'; f.targetBaitId = null;
          }
          continue;
        }
      }

      if (now >= f.turnAt) {
        const a = rand(0, Math.PI * 2), speed = rand(0.25, 0.75);
        f.vx = Math.cos(a) * speed; f.vz = Math.sin(a) * speed;
        f.turnAt = now + rand(1800, 5200);
      }
      f.x += f.vx * TICK; f.z += f.vz * TICK;
      const depth = this.lake.depthAt(f.x, f.z);
      if (depth < 0.55) { f.vx *= -1; f.vz *= -1; f.x += f.vx; f.z += f.vz; }
      const maxY = -0.25, minY = -Math.max(0.35, depth - 0.3);
      f.y = clamp(f.y, minY, maxY);

      let best = null, bestD = APPROACH_R;
      for (const bait of this.baits.values()) {
        if (occupiedBaits.has(bait.id)) continue;
        const d = Math.hypot(f.x - bait.x, f.z - bait.z);
        if (d < bestD) { best = bait; bestD = d; }
      }
      if (best && Math.random() < TICK * 0.10) {
        f.state = 'approaching'; f.targetBaitId = best.id; f.ownerPlayerId = null; f.stateAt = now;
        occupiedBaits.add(best.id);
      }
    }

    for (const [id, f] of this.fishes) {
      if (this.fishes.size <= wanted || f.state !== 'swimming') continue;
      const near = players.some((p) => !p.fresh && Math.hypot(f.x - p.x, f.z - p.z) <= DESPAWN_R);
      if (!near) this.fishes.delete(id);
    }
  }

  snapshot() {
    return [...this.fishes.values()].map((f) => ({
      id: f.id, speciesId: f.speciesId, length: f.length, albino: f.albino,
      x: +f.x.toFixed(2), y: +f.y.toFixed(2), z: +f.z.toFixed(2),
      state: f.state, targetBaitId: f.targetBaitId, ownerPlayerId: f.ownerPlayerId,
    }));
  }
}