import assert from 'node:assert/strict';
import { SharedWorld } from '../worker/simulation/world.js';

const world = new SharedWorld();
const players = [{ id: 'p1', x: 0, y: 0, z: 0, fresh: false }];
for (let i = 0; i < 30; i++) world.tick(players);
const first = world.snapshot();
assert.ok(first.length >= 10, `fish spawn不足: ${first.length}`);
assert.ok(first.every((f) => f.id && f.speciesId && Number.isFinite(f.x) && Number.isFinite(f.y)), 'fish snapshot不正');

world.setBait('p1', { x: 0, y: -2, z: 0, baitType: 'worm', rigLayer: 'mid' });
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

console.log(`OK shared world: ${world.snapshot().length} fish, single-bait exclusion/reservation/escape passed`);