import assert from 'node:assert/strict';
import { REAL_FISH } from '../src/data.js';
import { computeBiteWindow, createFightState } from '../src/fishing/controller.js';

const normal = REAL_FISH.find((sp) => !sp.tags.includes('trout') && sp.rarity === 2);
const trout = REAL_FISH.find((sp) => sp.tags.includes('trout') && sp.rarity === 2);
assert.ok(normal && trout, 'テスト用魚種が見つからない');
const line = { biteWindow: 1.2 };
const normalWindow = computeBiteWindow(normal, line);
const troutWindow = computeBiteWindow(trout, line);
assert.ok(normalWindow > 0);
assert.ok(troutWindow < normalWindow, 'trout のアワセ猶予補正が失われている');
assert.ok(Math.abs(troutWindow / normalWindow - 0.8) < 1e-9);

const species = REAL_FISH.find((sp) => sp.rarity >= 2);
const game = {
  yaw: 0,
  bobber: { x: 8, z: 0 },
  pos: { x: 0, z: 0 },
  maxLine: 30,
  water: { surfaceY: () => 0 },
};
const fish = { species, length: species.len[0], pos: { x: 8, y: -4, z: 0 } };
const fight = createFightState(game, fish);
// createFightState はプレイヤー中心ではなく、yaw方向へ1.6m進めた竿先基準で
// 初期ライン長を計算する。ここを固定値にすると竿先オフセット変更だけでテストが壊れる。
const rodTipX = game.pos.x + Math.sin(game.yaw) * 1.6;
const rodTipZ = game.pos.z + Math.cos(game.yaw) * 1.6;
const expectedDist = Math.max(2.5, Math.hypot(game.bobber.x - rodTipX, game.bobber.z - rodTipZ));
assert.ok(Math.abs(fight.dist - expectedDist) < 1e-9);
assert.equal(fight.hookDepth, 4);
assert.equal(fight.fishDepth, 4);
assert.ok(fight.span > fight.dist && fight.span <= game.maxLine);
assert.ok(fight.pull0 > 0);
assert.equal(fight.tension, 0);
assert.equal(fight.stamina, 1);
assert.ok(fight.pattern && typeof fight.pattern.pull === 'number');

console.log('OK fishing controller: bite window and fight initialization are isolated');
