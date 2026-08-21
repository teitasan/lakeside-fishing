import assert from 'node:assert/strict';
import { SharedWorld } from '../worker/simulation/sharedWorld.js';

const world = new SharedWorld();
const players = [{ id: 'p1', x: 0, y: 0, z: 0, fresh: false }];
for (let i = 0; i < 30; i++) world.tick(players);
const first = world.snapshot();
assert.ok(first.length >= 10, `fish spawn不足: ${first.length}`);
assert.ok(first.every((f) => f.id && f.speciesId && Number.isFinite(f.x) && Number.isFinite(f.y)), 'fish snapshot不正');

const bait = { x: 0, y: -2, z: 0, baitType: 'worm', rigLayer: 'mid', rodType: 'bamboo', lineType: 'nylon2', level: 1, hour: 12 };
world.setBait('p1', bait);
const sharedBait = world.baits.get('p1');
assert.ok(sharedBait?.readyAt > sharedBait?.at, 'アタリ待ち時刻が設定されていない');
sharedBait.readyAt = Date.now() - 1;

// 既存魚を全て餌から遠ざけ、シングル同様「適合魚が近くにいなければ5.5〜9.5mへ生成」を必ず通す。
for (const f of world.fishes.values()) { f.x += 100; f.z += 100; f.tx = f.x; f.tz = f.z; }
const idsBefore = new Set(world.fishes.keys());
world.tick(players);
let target = world.snapshot().find((f) => f.targetBaitId === 'b:p1' || f.ownerPlayerId === 'p1');
assert.ok(target, '待機終了時にアタリ対象魚が生成されない');
assert.ok(!idsBefore.has(target.id), '近くに適合魚がいないのに既存魚だけを待っている');
const spawnDistance = Math.hypot(target.x - bait.x, target.z - bait.z);
assert.ok(spawnDistance >= 5 && spawnDistance <= 10, `アタリ対象魚の生成距離が不正: ${spawnDistance}`);

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

console.log(`OK shared world: ${world.snapshot().length} fish, forced biter spawn/approach/nibble/reservation/escape passed`);
