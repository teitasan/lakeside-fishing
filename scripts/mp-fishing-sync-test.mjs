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
  bait: { id: 'worm' }, rigLayer: { id: 'bottom' }, rod: { id: 'starter_rod' }, line: { id: 'nylon2' },
  state: { level: 4, clock: 18, gear: { rod: 'starter_rod', line: 'nylon2' } },
  terrain: {
    bedAt: () => ({ kind: 'sand' }),
    structureNear: () => true,
  },
  castAcc: 0.8, castPower: 0.6,
};
const sync = new MultiplayerFishingSync(game, mp);
game.fishing.setBaitPresent(true);
game.fishing.notifyHooked(fish);
sync.onFishHooked({ playerId: 'p1', fishId: 'f1' });
game.fishing.notifyMissed(fish, { baitKept: true });
game.fishing.notifyHooked(fish);
sync.onFishHooked({ playerId: 'p1', fishId: 'f1' });
game.fishing.notifyEscaped(fish);
game.fishing.notifyHooked(fish);
sync.onFishHooked({ playerId: 'p1', fishId: 'f1' });
game.fishing.notifyCaught(fish);
game.fishing.setBaitPresent(false);
assert.deepEqual(calls.map((c) => c[0]), [
  'setBait', 'hookFish', 'endFight', 'setBait', 'hookFish', 'endFight', 'hookFish', 'endFight', 'clearBait',
]);
assert.deepEqual(calls[0][1], {
  x: 1, y: -1, z: 3,
  baitType: 'worm', rigLayer: 'bottom', rodType: 'starter_rod', lineType: 'nylon2',
  level: 4, hour: 18, totalCaught: 0, bed: 'sand', nearStruct: true,
  castAcc: 0.8, castPower: 0.6, retry: false,
});
assert.equal(calls[3][1].retry, true, 'アタリを逃して餌が残った場合は再待機扱いになっていない');
sync.dispose();
game.fishing.setBaitPresent(true);
assert.equal(calls.length, 9, 'dispose後も同期イベントが送信されている');
console.log('OK multiplayer fishing sync: semantic fishing events map to protocol calls');
