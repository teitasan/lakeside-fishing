import { RemoteFishSchool } from './remoteFish.js';

/**
 * Game本体をシングル向けのまま保ち、マルチ時だけ共有魚の振る舞いを差し込む。
 * 既存ファイト計算はownerクライアントで動かし、位置だけserverへ返す。
 */
export function installMultiplayerRuntime(Game) {
  if (Game.prototype.__sharedFishInstalled) return;
  Game.prototype.__sharedFishInstalled = true;

  const build = Game.prototype.build;
  Game.prototype.build = async function (...args) {
    const r = await build.apply(this, args);
    if (!this.multiplayer) return r;
    // ローカル魚AIを止める。描画用の共有魚は別マネージャが担当する。
    for (const f of this.school.fishes) f.despawn();
    this.school.update = () => {};
    this.school.populate = () => {};
    this.school.startle = () => {};
    this.sharedFish = new RemoteFishSchool(this.scene);
    this._mpFightSentAt = 0;
    return r;
  };

  const connect = Game.prototype._connectMultiplayer;
  Game.prototype._connectMultiplayer = function (...args) {
    const r = connect.apply(this, args);
    const mp = this.mp;
    if (!mp) return r;
    const oldWelcome = mp.onWelcome;
    mp.onWelcome = (m) => {
      oldWelcome?.(m);
      if (m.weather) { this.env.setWeather(m.weather); this.env.weatherTimer = 1e9; }
      this.sharedFish?.applySnapshot(m.fish || []);
    };
    mp.onFishSnapshot = (items) => {
      this.sharedFish?.applySnapshot(items);
      // 自分の餌へ接近している個体だけ既存状態機械のhookFishに接続する。
      if (!this.hookFish && this.fs === 'wait') {
        const mine = items.find((f) => f.targetBaitId === `b:${mp.id}` && (f.state === 'approaching' || f.ownerPlayerId === mp.id));
        if (mine) {
          const local = this.sharedFish?.get(mine.id);
          if (local) {
            local.state = mine.ownerPlayerId === mp.id ? 'nibble' : 'approach';
            this.hookFish = local;
            this.approachT = 0;
          }
        }
      }
      if (this.hookFish?.networkId) {
        const s = items.find((f) => f.id === this.hookFish.networkId);
        if (s && this.fs !== 'fight' && this.fs !== 'landing' && this.fs !== 'card') {
          if (s.ownerPlayerId === mp.id && s.state === 'reserved') this.hookFish.state = 'nibble';
          else if (s.state === 'approaching') this.hookFish.state = 'approach';
          else if (!s.ownerPlayerId && s.state === 'swimming') this.hookFish = null;
        }
      }
    };
    mp.onFishEscaped = (m) => {
      const f = this.sharedFish?.get(m.fishId);
      if (f && f !== this.hookFish) f.state = 'wander';
    };
    mp.onFishCaught = (m) => {
      if (m.playerId !== mp.id) {
        const f = this.sharedFish?.get(m.fishId);
        if (f) f.despawn();
      }
    };
    mp.onWeather = (key) => { if (key) { this.env.setWeather(key); this.env.weatherTimer = 1e9; } };
    return r;
  };

  const chooseBiter = Game.prototype._chooseBiter;
  Game.prototype._chooseBiter = function (...args) {
    if (!this.multiplayer) return chooseBiter.apply(this, args);
    // 魚を選ぶ権限はserver側。再試行の間隔だけクライアントで持つ。
    this.biteTimer = 1.5;
  };

  const landWater = Game.prototype._onLandWater;
  Game.prototype._onLandWater = function (...args) {
    const r = landWater.apply(this, args);
    if (this.multiplayer && this.fs === 'wait') {
      this.mp?.setBait({
        x: this.bobber.x, y: this.baitY, z: this.bobber.z,
        baitType: this.bait.id, rigLayer: this.rigLayer.id,
      });
    }
    return r;
  };

  const setHook = Game.prototype._setHook;
  Game.prototype._setHook = function (...args) {
    const id = this.hookFish?.networkId;
    const r = setHook.apply(this, args);
    if (this.multiplayer && id && this.fs === 'fight') this.mp?.hookFish(id);
    return r;
  };

  const retrieve = Game.prototype._retrieve;
  Game.prototype._retrieve = function (...args) {
    if (this.multiplayer) this.mp?.clearBait();
    return retrieve.apply(this, args);
  };

  const releaseFish = Game.prototype._releaseFish;
  Game.prototype._releaseFish = function (flee, ...args) {
    const id = this.hookFish?.networkId;
    const r = releaseFish.call(this, flee, ...args);
    if (this.multiplayer && id) this.mp?.endFight(id, 'escaped');
    return r;
  };

  const land = Game.prototype._land;
  Game.prototype._land = function (...args) {
    const id = this.hookFish?.networkId;
    const r = land.apply(this, args);
    if (this.multiplayer && id) this.mp?.endFight(id, 'caught');
    return r;
  };

  const update = Game.prototype.update;
  Game.prototype.update = function (dt, ...args) {
    const r = update.call(this, dt, ...args);
    if (!this.multiplayer) return r;
    this.sharedFish?.update(dt);
    // ownerのファイト位置を10Hzで共有。他クライアントはsnapshotを補間表示する。
    if (this.fs === 'fight' && this.hookFish?.networkId && this.mp?.connected) {
      const now = performance.now();
      if (now - this._mpFightSentAt >= 100) {
        this._mpFightSentAt = now;
        const p = this.hookFish.pos;
        this.mp.fightUpdate(this.hookFish.networkId, p.x, p.y, p.z);
      }
    }
    // server weather固定。ローカルのtickWeatherが切り替えないよう十分大きく保つ。
    if (this.env) this.env.weatherTimer = Math.max(this.env.weatherTimer || 0, 1e8);
    return r;
  };
}
