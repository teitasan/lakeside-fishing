import assert from 'node:assert/strict';
import { FishingSession } from '../src/fishing/session.js';
import { MultiplayerFishingSync } from '../src/multiplayer/fishingSync.js';

const calls = [];
const mp = {
  id: 'p1', connected: true,
  setBait: (v) => calls.push(['setBait', v]),
  clearBait: () => calls.push(['clearBait']),
  hookFish: (id) => calls.push(['hookFish', id]),
  endFight: (id, result) => calls.push(['endFight', id, result]),
  fightUpdate: (id, x, y, z) => calls.push(['fightUpdate', id, x, y, z]),
};
const fish = { networkId: 'f1', pos: { x: 4, y: -2, z: 8 } };
const game = {
  fishing: new FishingSession(), fs: 'wait', hookFish: fish,
  bobber: { x: 1, z: 3 }, baitY: -1,
  bait: { id: 'worm' }, rigLayer: { id: 'bottom' }, rod: { id: 'starter_rod' },
  state: { level: 4, clock: 18, gear: { rod: 'starter_rod' } },
  terrain: {
    bedAt: () => ({ kind: 'sand' }),
    structureNear: () => true,
  },
  castAcc: 0.8, castPower: 0.6,
};
const sync = new MultiplayerFishingSync(game, mp);
game.fishing.setBaitPresent(true);
game.fishing.notifyHooked(fish);
game.fishing.notifyMissed(fish, { baitKept: true });
game.fishing.notifyEscaped(fish);
game.fishing.notifyCaught(fish);
game.fishing.setBaitPresent(false);
assert.deepEqual(calls.map((c) => c[0]), [
  'setBait', 'hookFish', 'endFight', 'setBait', 'endFight', 'endFight', 'clearBait',
]);
assert.deepEqual(calls[0][1], {
  x: 1, y: -1, z: 3,
  baitType: 'worm', rigLayer: 'bottom', rodType: 'starter_rod',
  level: 4, hour: 18, bed: 'sand', nearStruct: true,
  castAcc: 0.8, castPower: 0.6,
});
sync.dispose();
game.fishing.setBaitPresent(true);
assert.equal(calls.length, 7, 'dispose後も同期イベントが送信されている');
console.log('OK multiplayer fishing sync: semantic fishing events map to protocol calls');
