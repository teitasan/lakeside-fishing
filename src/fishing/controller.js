import { clamp, clamp01, lerp, rand } from '../util.js';
import { fightPattern } from '../data.js';
import { t, fightHint } from '../i18n.js';

const BAIT_KEEP_ON_MISS = 0.2;
const RUN_MARGIN = 16;

export function computeBiteWindow(species, line) {
  return lerp(1.55, 0.85, clamp01(species.rarity / 5))
    * (species.tags.includes('trout') ? 0.8 : 1)
    * line.biteWindow;
}

export function createFightState(game, fish) {
  const sp = fish.species;
  const sizeF = 0.55 + (fish.length / sp.len[1]) * 0.75;
  const pattern = fightPattern(sp);
  const len0 = Math.max(2.5, Math.hypot(
    game.bobber.x - (game.pos.x + Math.sin(game.yaw) * 1.6),
    game.bobber.z - (game.pos.z + Math.cos(game.yaw) * 1.6),
  ));
  const surge = sp.str * sizeF >= 1.2 && pattern.runGap < 50;
  const surf0 = game.water.surfaceY(fish.pos.x, fish.pos.z);
  const hookDepth = clamp(surf0 - fish.pos.y, 0.4, 48);
  return {
    yaw0: game.yaw,
    span: Math.max(len0 + 4, Math.min(len0 + RUN_MARGIN, game.maxLine)),
    dist: len0,
    tension: 0,
    stamina: 1,
    runTimer: rand(1.4, 3.2) * pattern.runGap,
    running: surge,
    runDur: surge ? rand(0.6, 1.2) * pattern.runDur : 0,
    lateral: 0,
    spin: 0,
    px: game.bobber.x,
    pz: game.bobber.z,
    face: 'player',
    sizeF,
    pull0: sp.str * sizeF,
    time: 0,
    jumps: 0,
    pattern,
    jumpQueued: 0,
    jumpT: 0,
    jumpFromY: null,
    shakeT: rand(0.6, 1.3),
    shakeOn: false,
    shakeAge: 0,
    hookDepth,
    fishDepth: hookDepth,
    prevTension: 0,
    rise: 0,
    danger: 0,
    ttl: Infinity,
  };
}

export class FishingController {
  constructor(game) { this.game = game; }

  startBite() {
    const g = this.game;
    const fish = g.hookFish;
    if (!fish) return;
    g.fs = 'bite';
    g.stateTime = 0;
    g.biteWindow = computeBiteWindow(fish.species, g.line);
    g.audio.bite();
    g.ui.biteAlert();
    g.water.addSplash(g.bobber.x, g.water.surfaceY(g.bobber.x, g.bobber.z), g.bobber.z, 8, 0.5);
  }

  missBite() {
    const g = this.game;
    const f = g.hookFish;
    if (f) {
      f.state = 'flee';
      f.timer = 3;
      const dx = f.pos.x - g.pos.x;
      const dz = f.pos.z - g.pos.z;
      const len = Math.hypot(dx, dz) || 1;
      f.target.set(f.pos.x + dx / len * 22, f.pos.y - 1, f.pos.z + dz / len * 22);
    }
    g.hookFish = null;
    g.fs = 'wait';
    g.stateTime = 0;
    g.biteTimer = rand(3, 6);
    g.audio.escape();
    g.ui.toast(t('ui.toast.missBite'), 'bad');
    if (Math.random() < BAIT_KEEP_ON_MISS) {
      g.ui.toast(t('ui.toast.baitSafe'), 'good');
    } else {
      g._useBait(t('ui.toast.baitStolen'));
      g._retrieve();
    }
  }

  setHook() {
    const g = this.game;
    const f = g.hookFish;
    if (!f) return;
    g.audio.hookSet();
    f.state = 'hooked';
    g.bobberFar = g.bobber.clone();
    g.fight = createFightState(g, f);
    g.fs = 'fight';
    g.stateTime = 0;
    g.water.addSplash(g.bobber.x, g.water.surfaceY(g.bobber.x, g.bobber.z), g.bobber.z, 14, 1.0);
    g.water.addRipple(g.bobber.x, g.bobber.z, 1.1, 1.4);
    if (g.fight.running) g.audio.drag();
    const heavy = g.fight.pull0;
    const feel = t(heavy >= 2.0 ? 'ui.toast.hitHeavy2'
      : heavy >= 1.2 ? 'ui.toast.hitHeavy12' : 'ui.toast.hitHooked');
    g.ui.toast(
      t('ui.toast.hitBanner', { feel })
      + `<small style="opacity:.75"> — ${fightHint(g.fight.pattern)}</small>`,
      heavy >= 2.0 ? 'gold' : 'good',
    );
  }
}

export function installFishingController(Game) {
  if (Game.prototype.__fishingControllerInstalled) return;
  Object.defineProperty(Game.prototype, '__fishingControllerInstalled', { value: true });
  Object.defineProperty(Game.prototype, 'fishingController', {
    configurable: true,
    get() {
      if (!this.__fishingController) {
        Object.defineProperty(this, '__fishingController', {
          value: new FishingController(this), configurable: false,
        });
      }
      return this.__fishingController;
    },
  });
  Game.prototype._startBite = function () { return this.fishingController.startBite(); };
  Game.prototype._missBite = function () { return this.fishingController.missBite(); };
  Game.prototype._setHook = function () { return this.fishingController.setHook(); };
}
