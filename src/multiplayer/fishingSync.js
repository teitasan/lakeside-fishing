export class MultiplayerFishingSync {
  constructor(game, mp) {
    this.game = game;
    this.mp = mp;
    this.lastFightSentAt = 0;
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
          g.fishing.beginApproach(local);
        }
      }
    }
    if (g.hookFish?.networkId) {
      const server = items.find((f) => f.id === g.hookFish.networkId);
      if (server && !['fight', 'landing', 'card'].includes(g.fs)) {
        if (server.ownerPlayerId === this.mp.id && server.state === 'reserved') g.hookFish.state = 'nibble';
        else if (server.state === 'approaching') g.hookFish.state = 'approach';
        else if (!server.ownerPlayerId && server.state === 'swimming') g.fishing.clearTarget();
      }
    }
  }

  setBaitFromGame() {
    const g = this.game;
    this.mp?.setBait({
      x: g.bobber.x, y: g.baitY, z: g.bobber.z,
      baitType: g.bait.id, rigLayer: g.rigLayer.id,
    });
    g.fishing.setBaitPresent(true);
  }

  clearBait() {
    this.mp?.clearBait();
    this.game.fishing.setBaitPresent(false);
  }

  onMiss(fishId) {
    if (!fishId) return;
    this.mp?.endFight(fishId, 'escaped');
    if (this.game.fs === 'wait') this.setBaitFromGame();
    else this.game.fishing.setBaitPresent(false);
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
