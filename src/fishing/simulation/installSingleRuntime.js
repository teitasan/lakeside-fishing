import { Fish, FishSchool } from '../../fish.js';
import { Environment } from '../../sky.js';
import {
  FISH_APPROACH_SPEED_MUL, FISH_NIBBLE_SPEED_MUL, FISH_FLEE_SPEED_MUL,
  fishBaseSpeed, approachRadius, wanderSpeedMul, nibbleTarget,
  preferredFishY, pickWanderTarget, steerVelocity, startleDuration, startleTarget,
  clampFishDepth,
} from './motion.js';
import { nextWeatherKey, nextWeatherHours } from './weather.js';
import { WEATHERS } from '../../sky.js';
import { rand } from '../../util.js';

let installed = false;

export function installSingleSimulationRuntime() {
  if (installed) return;
  installed = true;

  Fish.prototype.preferredY = function (depth, band = null) {
    return preferredFishY(this.species, depth, band, this._depthBias ?? 0.5);
  };

  Fish.prototype.pickWanderTarget = function (ctx) {
    const r = pickWanderTarget({
      fish: {
        x: this.pos.x, y: this.pos.y, z: this.pos.z,
        species: this.species, depthBias: this._depthBias ?? 0.5,
      },
      terrain: ctx.terrain,
      band: ctx.band,
    });
    this._depthBias = r.depthBias;
    this.target.set(r.x, r.y, r.z);
    return r.found;
  };

  const legacyUpdate = Fish.prototype.update;
  Fish.prototype.update = function (dt, ctx) {
    if (!this.active) return;
    const { water, terrain } = ctx;
    const sp = this.species;
    this.timer -= dt;
    this.startle = Math.max(0, this.startle - dt);
    let speedMul = 1;

    switch (this.state) {
      case 'wander': {
        if (this.timer <= 0 || this.pos.distanceTo(this.target) < 1.2) {
          this.pickWanderTarget(ctx);
          this.timer = rand(2.5, 6);
        }
        speedMul = wanderSpeedMul(this.phase, ctx.time, this.startle > 0);
        if (sp.rarity > 0 && this.timer > 0.4 && Math.random() < dt * 0.012) {
          const surf = water.surfaceY(this.pos.x, this.pos.z);
          if (terrain.depthAt(this.pos.x, this.pos.z) > 1.2 && this.pos.y > -2.2) {
            this.state = 'jump';
            this.jumpVy = rand(3.4, 5.6);
            this.pos.y = surf - 0.05;
            water.addSplash(this.pos.x, surf, this.pos.z, 12, 0.8);
            water.addRipple(this.pos.x, this.pos.z, 0.9, 1.6);
            ctx.onJump?.(this);
          }
        }
        break;
      }
      case 'approach': {
        this.target.copy(ctx.bait);
        speedMul = FISH_APPROACH_SPEED_MUL;
        if (this.pos.distanceTo(this.target) < approachRadius(this.length)) {
          this.state = 'nibble';
          this.timer = rand(0.6, 1.4);
        }
        break;
      }
      case 'nibble': {
        const target = nibbleTarget(ctx.bait, this.phase, ctx.time);
        this.target.set(target.x, target.y, target.z);
        speedMul = FISH_NIBBLE_SPEED_MUL;
        break;
      }
      case 'flee': {
        speedMul = FISH_FLEE_SPEED_MUL;
        if (this.timer <= 0) { this.state = 'wander'; this.timer = 1; }
        break;
      }
      // jump/hooked/landedは描画・演出依存が強いため既存処理をそのまま使用する。
      case 'jump':
      case 'hooked':
      case 'landed':
        return legacyUpdate.call(this, dt, ctx);
      default:
        return;
    }

    const v = steerVelocity({
      x: this.pos.x, y: this.pos.y, z: this.pos.z,
      vx: this.vel.x, vy: this.vel.y, vz: this.vel.z,
      length: this.length,
    }, { x: this.target.x, y: this.target.y, z: this.target.z }, speedMul, dt);
    this.vel.set(v.vx, v.vy, v.vz);
    this.pos.addScaledVector(this.vel, dt);

    const clamped = clampFishDepth({
      x: this.pos.x, y: this.pos.y, z: this.pos.z, vy: this.vel.y,
      length: this.length, terrain, surfaceY: water.surfaceY(this.pos.x, this.pos.z),
    });
    this.pos.y = clamped.y;
    this.vel.y = clamped.vy;

    this.mesh.position.copy(this.pos);
    const spd = this.vel.length();
    const dir = this.vel.clone();
    if (spd < 0.02) dir.set(Math.cos(this.phase), 0, Math.sin(this.phase));
    this._orient(dt, dir.normalize(), Math.max(-0.4, Math.min(0.4, -this.vel.x * 0.06)));
    this._wiggle(dt, 0.9 + spd * 1.9, 0.045 + spd * 0.05);
  };

  Fish.prototype.spawn = wrap(Fish.prototype.spawn, function (next, sp, length, pos, opts = {}) {
    const r = next(sp, length, pos, opts);
    this.speed = fishBaseSpeed(length);
    return r;
  });

  FishSchool.prototype.startle = function (x, z, radius = 3.5, sec = 1.8) {
    for (const f of this.fishes) {
      if (!f.active || f.state === 'hooked') continue;
      if (Math.hypot(f.pos.x - x, f.pos.z - z) >= radius) continue;
      f.startle = startleDuration(sec);
      if (f.state === 'wander') {
        const target = startleTarget({ x: f.pos.x, y: f.pos.y, z: f.pos.z }, x, z);
        f.target.set(target.x, target.y, target.z);
        f.timer = 2;
      }
    }
  };

  Environment.prototype.tickWeather = function (dtHours) {
    this.weatherTimer -= dtHours;
    if (this.weatherTimer > 0) return null;
    const key = nextWeatherKey(this.weather.key);
    this.weather = WEATHERS[key];
    this.weatherTimer = nextWeatherHours();
    return this.weather;
  };
}

function wrap(fn, body) {
  return function (...args) {
    return body.call(this, (...inner) => fn.apply(this, inner), ...args);
  };
}
