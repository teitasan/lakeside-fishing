import { FishingEvent } from '../fishing/session.js';

export class MultiplayerFishingSync {
  constructor(game, mp) {
    this.game = game;
    this.mp = mp;
    this.lastFightSentAt = 0;
    this.unsubscribers = [];
    this.bindSession();
  }

  bindSession() {
    const fishing = this.game.fishing;
    this.unsubscribers.push(
      fishing.on(FishingEvent.BAIT_PLACED, () => this.setBaitFromGame()),
      fishing.on(FishingEvent.BAIT_CLEARED, () => this.mp?.clearBait()),
      fishing.on(FishingEvent.HOOKED, ({ fish }) => {
        if (fish?.networkId) this.mp?.hookFish(fish.networkId);
      }),
      fishing.on(FishingEvent.MISSED, ({ fish, baitKept }) => {
        if (fish?.networkId) this.mp?.endFight(fish.networkId, 'escaped');
        if (baitKept) this.setBaitFromGame();
      }),
      fishing.on(FishingEvent.FISH_ESCAPED, ({ fish }) => {
        if (fish?.networkId) this.mp?.endFight(fish.networkId, 'escaped');
      }),
      fishing.on(FishingEvent.FISH_CAUGHT, ({ fish }) => {
        if (fish?.networkId) this.mp?.endFight(fish.networkId, 'caught');
      }),
    );
  }

  dispose() {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }

  onFishSnapshot(items) {
    const g = this.game;
    g.sharedFish?.applySnapshot(items);
    if (!g.hookFish && g.fs === 'wait') {
      const mine = items.find((f) => f.targetBaitId === `b:${this.mp.id}`
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
      if (server && !['fight', 'landing', 'card'].includes(g.fs)) {
        if (server.ownerPlayerId === this.mp.id && server.state === 'reserved') g.hookFish.state = 'nibble';
        else if (server.state === 'approaching') g.hookFish.state = 'approach';
        else if (!server.ownerPlayerId && server.state === 'swimming') g.fishing.clearTarget({ source: 'server' });
      }
    }
  }

  setBaitFromGame() {
    const g = this.game;
    if (!this.mp?.connected || g.fs !== 'wait') return;
    this.mp.setBait({
      x: g.bobber.x, y: g.baitY, z: g.bobber.z,
      baitType: g.bait.id, rigLayer: g.rigLayer.id,
    });
  }

  sendFightPosition() {
    const g = this.game;
    if (g.fs !== 'fight' || !g.hookFish?.networkId || !this.mp?.connected) return;
    const now = performance.now();
    if (now - this.lastFightSentAt < 100) return;
    this.lastFightSentAt = now;
    const p = g.hookFish.pos;
    this.mp.fightUpdate(g.hookFish.networkId, p.x, p.y, p.z);
  }
}
