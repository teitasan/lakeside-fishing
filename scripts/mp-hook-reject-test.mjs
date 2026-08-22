/* hook 拒否時に endFight を送らずローカル状態を解除する */
import assert from 'node:assert/strict';
import { FishingSession } from '../src/fishing/session.js';
import { MultiplayerFishingSync } from '../src/multiplayer/fishingSync.js';

const calls = [];
const mp = {
  id: 'p1', connected: true,
  hookFish: (id) => calls.push(['hookFish', id]),
  endFight: (id, r) => calls.push(['endFight', id, r]),
};
const fish = { networkId: 'f1', pos: { x: 0, y: -1, z: 0 }, species: { rarity: 1 } };
const game = {
  fishing: new FishingSession(),
  fs: 'fight',
  hookFish: fish,
  fight: { tension: 0 },
  bobber: { x: 1, z: 3 },
  ui: { showFight() {} },
  retrieving: false,
};
game.fishing.baitPresent = true;
const sync = new MultiplayerFishingSync(game, mp);
game.fishing.notifyHooked(fish);
assert.equal(calls.filter((c) => c[0] === 'hookFish').length, 1);
sync.onFishHookRejected({ playerId: 'p1', fishId: 'f1', reason: 'owned' });
assert.equal(game.fs, 'wait');
assert.equal(game.hookFish, null);
assert.equal(game.fight, null);
assert.equal(calls.filter((c) => c[0] === 'endFight').length, 0, '拒否時に endFight を送ってはいけない');
sync.dispose();

// hook確認前のアタリ失敗でも、サーバー側の予約を解放する要求は送る。
const missedCalls = [];
const missedGame = {
  fishing: new FishingSession(), fs: 'wait', hookFish: fish,
};
missedGame.fishing.baitPresent = true;
const missedSync = new MultiplayerFishingSync(missedGame, {
  id: 'p1', connected: true,
  endFight: (id, result) => missedCalls.push([id, result]),
});
missedGame.fishing.notifyMissed(fish, { baitKept: false });
assert.deepEqual(missedCalls, [['f1', 'escaped']], '未確認hookのアタリ失敗でも予約解放が必要');
missedSync.dispose();

// fish_snapshotだけでhook確認できた場合も、fight位置を送れる。
const snapshotCalls = [];
const snapshotGame = {
  fishing: new FishingSession(), fs: 'fight', hookFish: fish,
};
const snapshotSync = new MultiplayerFishingSync(snapshotGame, {
  id: 'p1', connected: true,
  fightUpdate: (...args) => snapshotCalls.push(args),
});
snapshotSync.onFishSnapshot([{ id: 'f1', ownerPlayerId: 'p1', state: 'hooked' }]);
snapshotSync.lastFightSentAt = -Infinity;
snapshotSync.sendFightPosition();
assert.equal(snapshotCalls.length, 1, 'hooked snapshot後にfight位置を送信できない');
snapshotSync.dispose();
console.log('OK hook rejection clears local fight without endFight');
