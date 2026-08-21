import assert from 'node:assert/strict';
import { SharedWorld } from '../worker/simulation/world.js';

// SharedWorld のアタリ待ちは実時間(Date.now)で管理される。
// テストの高速 tick では時計が進まないため、待機区間だけ実時間を進めて検証する。
const world = new SharedWorld();
const players = [{ id: 'p1', x: 0, y: 0, z: 0, fresh: false }];
for (let i = 0; i < 30; i++) world.tick(players);
const first = world.snapshot();
assert.ok(first.length >= 10, `fish spawn不足: ${first.length}`);
assert.ok(first.every((f) => f.id && f.speciesId && Number.isFinite(f.x) && Number.isFinite(f.y)), 'fish snapshot不正');

const bait = { x: 0, y: -2, z: 0, baitType: 'worm', rigLayer: 'mid' };
world.setBait('p1', bait);
const sharedBait = world.baits.get('p1');
assert.ok(sharedBait?.readyAt > sharedBait?.at, 'アタリ待ち時刻が設定されていない');
// CIで数秒sleepさせず、待機済み状態へ進める。以降の接近・予約ロジックは従来通りtickで検証する。
sharedBait.readyAt = Date.now() - 1;
let target = null;
for (let i = 0; i < 2500 && !target; i++) {
  world.tick(players);
  const interested = world.snapshot().filter((f) => f.targetBaitId === 'b:p1' || f.ownerPlayerId === 'p1');
  assert.ok(interested.length <= 1, `同じ餌に複数魚が接近: ${interested.map((f) => f.id).join(',')}`);
  target = interested[0] || null;
}
assert.ok(target, '共有餌へ魚が寄らない');

for (let i = 0; i < 800 && target.ownerPlayerId !== 'p1'; i++) {
  world.tick(players);
  const interested = world.snapshot().filter((f) => f.targetBaitId === 'b:p1' || f.ownerPlayerId === 'p1');
  assert.ok(interested.length <= 1, `予約待ち中に同じ餌へ複数魚: ${interested.map((f) => f.id).join(',')}`);
  target = world.snapshot().find((f) => f.id === target.id) || target;
}
assert.equal(target.ownerPlayerId, 'p1', 'bite予約が成立しない');
const reservedDistance = Math.hypot(target.x - bait.x, target.y - bait.y, target.z - bait.z);
assert.ok(reservedDistance > 0.01, 'reserved移行時に魚が餌座標へスナップしている');
const beforeNibble = { x: target.x, y: target.y, z: target.z };
for (let i = 0; i < 5; i++) world.tick(players);
target = world.snapshot().find((f) => f.id === target.id) || target;
const nibbleMove = Math.hypot(target.x - beforeNibble.x, target.y - beforeNibble.y, target.z - beforeNibble.z);
assert.ok(nibbleMove > 0.001, 'reserved中の魚が完全停止している');

assert.equal(world.hook('p1', target.id), true, 'ownerがhookできない');
assert.equal(world.hook('other', target.id), false, '非ownerがhookできてしまう');
world.fightUpdate('p1', target.id, { x: 1, y: -1, z: 1 });
const hooked = world.snapshot().find((f) => f.id === target.id);
assert.equal(hooked.state, 'hooked');
assert.equal(hooked.x, 1);
const escaped = world.endFight('p1', target.id, 'escaped');
assert.ok(escaped && !escaped.removed);
assert.equal(world.snapshot().find((f) => f.id === target.id).state, 'swimming');
assert.equal(world.hook('p1', target.id), false, 'escape後に予約なしhookできる');

console.log(`OK shared world: ${world.snapshot().length} fish, bite delay/approach/nibble/reservation/escape passed`);
