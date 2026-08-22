import { FishingEvent } from '../fishing/session.js';

export class MultiplayerFishingSync {
  constructor(game, mp) {
    this.game = game;
    this.mp = mp;
    this.lastFightSentAt = 0;
    this.unsubscribers = [];
    this._pendingHookId = null;
    this._confirmedHookId = null;
    this._terminalHookId = null;
    this.bindSession();
  }

  bindSession() {
    const fishing = this.game.fishing;
    this.unsubscribers.push(
      fishing.on(FishingEvent.BAIT_PLACED, () => this.setBaitFromGame()),
      fishing.on(FishingEvent.BAIT_CLEARED, () => this.mp?.clearBait()),
      fishing.on(FishingEvent.HOOKED, ({ fish }) => {
        if (fish?.networkId) {
          this._pendingHookId = fish.networkId;
          this._confirmedHookId = null;
          this._terminalHookId = null;
          this.mp?.hookFish(fish.networkId);
        }
      }),
      fishing.on(FishingEvent.MISSED, ({ fish, baitKept }) => {
        this.sendFightEnd(fish?.networkId, 'escaped');
        this._pendingHookId = null;
        if (this._confirmedHookId === fish?.networkId) this._confirmedHookId = null;
        if (baitKept) this.setBaitFromGame({ retry: true });
      }),
      fishing.on(FishingEvent.FISH_ESCAPED, ({ fish }) => {
        this.sendFightEnd(fish?.networkId, 'escaped');
        this._pendingHookId = null;
        if (this._confirmedHookId === fish?.networkId) this._confirmedHookId = null;
      }),
      fishing.on(FishingEvent.FISH_CAUGHT, ({ fish }) => {
        this.sendFightEnd(fish?.networkId, 'caught');
        this._pendingHookId = null;
        if (this._confirmedHookId === fish?.networkId) this._confirmedHookId = null;
      }),
    );
  }

  dispose() {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this._pendingHookId = null;
    this._confirmedHookId = null;
    this._terminalHookId = null;
  }

  sendFightEnd(fishId, result) {
    if (!fishId || this._terminalHookId === fishId) return;
    this._terminalHookId = fishId;
    this.mp?.endFight(fishId, result);
  }

  onFishHooked(m) {
    if (m.playerId === this.mp?.id) {
      this._confirmedHookId = m.fishId;
      this._pendingHookId = null;
      return;
    }
    if (this.game.hookFish?.networkId === m.fishId) {
      this.abortLocalEngagement({ reason: 'lost_race' });
    }
  }

  onFishHookRejected(m) {
    if (m.playerId !== this.mp?.id) return;
    if (this._confirmedHookId === m.fishId) return;
    if (this._pendingHookId !== m.fishId && this.game.hookFish?.networkId !== m.fishId) return;
    this._pendingHookId = null;
    this.abortLocalEngagement({ reason: m.reason || 'rejected' });
  }

  resyncAfterWelcome(m, { reconnect = false } = {}) {
    this._confirmedHookId = null;
    this._pendingHookId = null;
    this._terminalHookId = null;
    if (reconnect) this.reconcileLocalState(m.fish || []);
    if (this.game.fs === 'wait' && this.game.fishing?.baitPresent) {
      this.setBaitFromGame();
    }
  }

  reconcileLocalState(items) {
    const g = this.game;
    const fishId = g.hookFish?.networkId;
    if (fishId) {
      const server = items.find((f) => f.id === fishId);
      const owned = server?.ownerPlayerId === this.mp.id && server?.state === 'hooked';
      if (!owned) this.abortLocalEngagement({ reason: 'reconnect' });
      return;
    }
    if (['fight', 'landing', 'bite'].includes(g.fs)) {
      this.abortLocalEngagement({ reason: 'reconnect' });
    }
  }

  abortLocalEngagement({ reason = 'abort' } = {}) {
    const g = this.game;
    const fish = g.hookFish;
    const fs = g.fs;

    if (fs === 'fight' || fs === 'landing') {
      if (fish && g.fishing?.hookFish === fish) g.fishing.clearTarget({ source: reason });
      g.hookFish = null;
      g.fight = null;
      g.bobberFar = null;
      g.ui?.showFight(false);
      g.underwaterCam = false;
      g.retrieving = false;
      if (g.fishing?.baitPresent) {
        g.fs = 'wait';
        g.stateTime = 0;
        g.biteTimer = 2;
      } else {
        g.retrieving = true;
        g.fs = 'flight';
        g.stateTime = 0;
      }
    } else if (fs === 'bite' || fs === 'nibble') {
      if (fish) g.fishing.clearTarget({ source: reason });
      g.fs = 'wait';
      g.stateTime = 0;
      g.biteTimer = 2;
    } else if (fish) {
      g.fishing.clearTarget({ source: reason });
    }
    this._pendingHookId = null;
  }

  onFishSnapshot(items) {
    const g = this.game;
    g.sharedFish?.applySnapshot(items);
    if (!g.hookFish && g.fs === 'wait') {
      const mine = items.find((f) =>
        f.targetBaitId === `b:${this.mp.id}`
        && (f.state === 'approaching' || f.ownerPlayerId === this.mp.id));
      if (mine) {
        const local = g.sharedFish?.get(mine.id);
        if (local) {
          local.state = mine.ownerPlayerId === this.mp.id ? 'nibble' : 'approach';
          g.fishing.beginApproach(local, { source: 'server' });
        }
      }
    }
    if (g.hookFish?.networkId) {
      const server = items.find((f) => f.id === g.hookFish.networkId);
      if (server?.ownerPlayerId === this.mp.id && server.state === 'hooked') {
        this._confirmedHookId = server.id;
        this._pendingHookId = null;
      }
      if (server && !['fight', 'landing', 'card'].includes(g.fs)) {
        if (server.ownerPlayerId === this.mp.id && server.state === 'reserved') {
          g.hookFish.state = 'nibble';
        } else if (server.state === 'approaching') {
          g.hookFish.state = 'approach';
        } else if (server.ownerPlayerId && server.ownerPlayerId !== this.mp.id) {
          this.abortLocalEngagement({ reason: 'owned' });
        } else if (!server.ownerPlayerId && server.state === 'swimming') {
          g.fishing.clearTarget({ source: 'server' });
        }
      }
      if (server && ['fight', 'landing'].includes(g.fs)
        && server.ownerPlayerId !== this.mp.id && server.state !== 'hooked') {
        this.abortLocalEngagement({ reason: 'server' });
      }
    }
  }

  setBaitFromGame({ retry = false } = {}) {
    const g = this.game;
    if (!this.mp?.connected || g.fs !== 'wait') return;
    const x = g.bobber.x, z = g.bobber.z;
    const bed = g.terrain?.bedAt?.(x, z)?.kind ?? null;
    const nearStruct = !!g.terrain?.structureNear?.(x, z, 4.5);
    const rodType = g.rod?.id ?? g.state?.gear?.rod ?? null;
    const lineType = g.line?.id ?? g.state?.gear?.line ?? null;
    this.mp.setBait({
      x, y: g.baitY, z,
      baitType: g.bait?.id ?? null,
      rigLayer: g.rigLayer?.id ?? 'mid',
      rodType,
      lineType,
      level: g.state?.level ?? 1,
      hour: g.state?.clock ?? 12,
      totalCaught: g.state?.totalCaught ?? 0,
      bed,
      nearStruct,
      castAcc: g.castAcc ?? 0,
      castPower: g.castPower ?? 0,
      retry,
    });
  }

  sendFightPosition() {
    const g = this.game;
    if (g.fs !== 'fight' || !g.hookFish?.networkId || !this.mp?.connected) return;
    if (this._confirmedHookId !== g.hookFish.networkId) return;
    const now = performance.now();
    if (now - this.lastFightSentAt < 100) return;
    this.lastFightSentAt = now;
    const p = g.hookFish.pos;
    this.mp.fightUpdate(g.hookFish.networkId, p.x, p.y, p.z);
  }
}
