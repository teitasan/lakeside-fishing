import { RemoteFishSchool } from './remoteFish.js';
import { MultiplayerFishingSync } from './fishingSync.js';
import { installFishingSession, isFishingLineState } from '../fishing/session.js';
import { pickSpecies } from '../fishing/simulation/rules.js';
import { timeBand } from '../util.js';

function installSharedFishingRules(Game) {
  if (Game.prototype.__sharedFishingRulesInstalled) return;
  Game.prototype.__sharedFishingRulesInstalled = true;
  Game.prototype.rollSpecies = function (depth, opts = {}) {
    return pickSpecies({
      depth,
      band: timeBand(this.state.clock),
      weather: this.env.weather.key,
      useBait: !!opts.bait,
      bait: this.bait,
      layer: opts.layer ?? this.rigLayer.id,
      bed: opts.bed ?? null,
      nearStruct: !!opts.struct,
      nearSpecies: opts.near || null,
      rodAttract: this.rod.attract,
      level: this.state.level,
    });
  };
}

function installFishingEventBridge(Game) {
  if (Game.prototype.__fishingEventBridgeInstalled) return;
  Game.prototype.__fishingEventBridgeInstalled = true;

  const landWater = Game.prototype._onLandWater;
  Game.prototype._onLandWater = function (...args) {
    const r = landWater.apply(this, args);
    if (this.fs === 'wait') this.fishing.setBaitPresent(true, { source: 'land' });
    return r;
  };
  const retrieve = Game.prototype._retrieve;
  Game.prototype._retrieve = function (...args) {
    this.fishing.setBaitPresent(false, { source: 'retrieve' });
    return retrieve.apply(this, args);
  };
  const releaseFish = Game.prototype._releaseFish;
  Game.prototype._releaseFish = function (flee, ...args) {
    const fish = this.hookFish, r = releaseFish.call(this, flee, ...args);
    this.fishing.notifyEscaped(fish, { flee }); return r;
  };
  const dismissCatch = Game.prototype.dismissCatch;
  Game.prototype.dismissCatch = function (...args) {
    const fish = this.hookFish, wasCard = this.fs === 'card', r = dismissCatch.apply(this, args);
    if (wasCard) this.fishing.notifyCaught(fish); return r;
  };
}

export function installMultiplayerRuntime(Game) {
  installSharedFishingRules(Game); installFishingSession(Game); installFishingEventBridge(Game);
  if (Game.prototype.__sharedFishInstalled) return;
  Game.prototype.__sharedFishInstalled = true;
  const build = Game.prototype.build;
  Game.prototype.build = async function (...args) {
    const r = await build.apply(this, args); if (!this.multiplayer) return r;
    for (const f of this.school.fishes) f.despawn();
    this.school.update = () => {}; this.school.populate = () => {}; this.school.startle = () => {};
    this.sharedFish = new RemoteFishSchool(this.scene); if (this.remotePlayers) this.remotePlayers.camera = this.camera; return r;
  };
  const connect = Game.prototype._connectMultiplayer;
  Game.prototype._connectMultiplayer = function (...args) {
    const r = connect.apply(this, args), mp = this.mp; if (!mp) return r;
    this.multiplayerFishing?.dispose(); const sync = this.multiplayerFishing = new MultiplayerFishingSync(this, mp); const oldWelcome = mp.onWelcome;
    mp.onWelcome = (m) => { const reconnect = mp._reconnecting; mp._reconnecting = false; oldWelcome?.(m); if (m.weather) { this.env.setWeather(m.weather); this.env.weatherTimer = 1e9; } this.sharedFish?.applySnapshot(m.fish || []); for (const v of m.visuals || []) this.remotePlayers?.setVisual(v); sync.resyncAfterWelcome(m, { reconnect }); };
    mp.onVisual = (v) => this.remotePlayers?.setVisual(v); mp.onFishSnapshot = (items) => sync.onFishSnapshot(items);
    mp.onFishHooked = (m) => sync.onFishHooked(m);
    mp.onFishHookRejected = (m) => sync.onFishHookRejected(m);
    mp.onFishEscaped = (m) => { const f = this.sharedFish?.get(m.fishId); if (f && f !== this.hookFish) f.state = 'wander'; };
    mp.onFishCaught = (m) => { if (m.playerId !== mp.id) this.sharedFish?.get(m.fishId)?.despawn(); };
    mp.onWeather = (key) => { if (key) { this.env.setWeather(key); this.env.weatherTimer = 1e9; } }; return r;
  };
  const chooseBiter = Game.prototype._chooseBiter;
  Game.prototype._chooseBiter = function (...args) { if (!this.multiplayer) return chooseBiter.apply(this, args); this.biteTimer = 1.5; };
  const update = Game.prototype.update;
  Game.prototype.update = function (dt, ...args) {
    const r = update.call(this, dt, ...args); if (!this.multiplayer) return r; this.sharedFish?.update(dt);
    if (this.mp?.connected) { const fightT = this.fight ? Math.max(0, Math.min(1, this.fight.tension / this.line.cap)) : 0; const end = this.fs === 'fight' && this.hookFish ? this.hookFish.pos : this.bobber;
      this.mp.sendVisual({ fs: this.fs === 'card' ? 'landed' : this.fs, charge: this.charge, tension: fightT, reeling: this.fs === 'fight' ? (this.fight?.spin || 0) : (this.retrieving ? 1 : 0), rod: this.state.gear.rod, bait: this.bait.id, rarity: this.hookFish?.species?.rarity || 0, bx: end?.x || 0, by: end?.y || 0, bz: end?.z || 0, line: isFishingLineState(this.fs) }); }
    this.multiplayerFishing?.sendFightPosition(); if (this.env) this.env.weatherTimer = Math.max(this.env.weatherTimer || 0, 1e8); return r;
  };
}
