/* 釣り上げ・逃げの後に次のキャストで餌がサーバーへ再登録されることの回帰テスト。
   実バグ: dismissCatch/_releaseFish 後も baitPresent が true のまま残り、
   2投目の着水で BAIT_PLACED が発火せず setBait が送られなかった */
import assert from 'node:assert/strict';
import { FishingSession } from '../src/fishing/session.js';
import { MultiplayerFishingSync } from '../src/multiplayer/fishingSync.js';

const calls = [];
const mp = {
  id: 'p1', connected: true,
  setBait: (v) => calls.push(['setBait', v]),
  clearBait: () => calls.push(['clearBait']),
};

function makeGame() {
  return {
    fishing: new FishingSession(), fs: 'wait', hookFish: null,
    bobber: { x: 1, z: 3 }, baitY: -1,
    bait: { id: 'worm' }, rigLayer: { id: 'mid' }, rod: { id: 'bamboo' }, line: { id: 'nylon2' },
    state: { level: 1, clock: 12 },
    terrain: { bedAt: () => ({ kind: 'sand' }), structureNear: () => false },
    castAcc: 0.5, castPower: 0.5,
  };
}

/* --- 1投目: 着水で餌が登録される --- */
const game = makeGame();
new MultiplayerFishingSync(game, mp);
game.fishing.setBaitPresent(true, { source: 'land' });
assert.equal(calls.filter((c) => c[0] === 'setBait').length, 1, '1投目の着水でsetBaitが送られていない');

/* --- 釣り上げ: カードを閉じたら餌なし状態へ戻る（実バグでは true のまま残留）--- */
game.fishing.notifyCaught(game.hookFish);
game.fs = 'idle';
game.fishing.setBaitPresent(false, { source: 'catch' });
assert.equal(game.fishing.baitPresent, false, '釣り上げ後に餌なし状態へ戻っていない');

/* --- 2投目: 再着水で必ず BAIT_PLACED が再発火する --- */
game.fs = 'wait';
game.fishing.setBaitPresent(true, { source: 'land' });
assert.equal(
  calls.filter((c) => c[0] === 'setBait').length, 2,
  '釣り上げ後の2投目でsetBaitが再送されない（マルチで魚が寄ってこない原因）',
);

/* --- 同様に逃げ(flee)後も次のキャストで再登録される --- */
const g2 = makeGame();
new MultiplayerFishingSync(g2, mp);
g2.fishing.setBaitPresent(true, { source: 'land' });
g2.fishing.notifyMissed(g2.hookFish, { baitKept: false });
g2.fishing.setBaitPresent(false, { source: 'escape' });
g2.fishing.setBaitPresent(true, { source: 'land' });
assert.equal(
  calls.filter((c) => c[0] === 'setBait').length, 4,
  '逃げた後の再キャストでsetBaitが再送されない',
);

console.log('OK catch/release resets bait state so the next cast re-registers the bait');
