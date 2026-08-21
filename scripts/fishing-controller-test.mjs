import assert from 'node:assert/strict';
import { computeBiteWindow, createFightState } from '../src/fishing/controller.js';

const normal = { rarity: 2, tags: [], str: 1.4, len: [20, 50] };
const trout = { rarity: 2, tags: ['trout'], str: 1.4, len: [20, 50] };
const line = { biteWindow: 1.2 };
const normalWindow = computeBiteWindow(normal, line);
const troutWindow = computeBiteWindow(trout, line);
assert.ok(normalWindow > 0);
assert.ok(troutWindow < normalWindow, 'trout のアワセ猶予補正が失われている');
assert.ok(Math.abs(troutWindow / normalWindow - 0.8) < 1e-9);

const species = {
  rarity: 2, tags: [], str: 1.5, len: [20, 50],
  fight: { pull: 1, runGap: 1, runDur: 1, runPull: 1, lineOut: 1,
    tensionGain: 1, tensionDecay: 1, staminaDrain: 1, shake: 0, jump: 0 },
};
const game = {
  yaw: 0,
  bobber: { x: 8, z: 0 },
  pos: { x: 0, z: 0 },
  maxLine: 30,
  water: { surfaceY: () => 0 },
};
const fish = { species, length: 40, pos: { x: 8, y: -4, z: 0 } };
const fight = createFightState(game, fish);
assert.equal(fight.dist, 8);
assert.equal(fight.hookDepth, 4);
assert.equal(fight.fishDepth, 4);
assert.ok(fight.span > fight.dist && fight.span <= game.maxLine);
assert.ok(fight.pull0 > 0);
assert.equal(fight.tension, 0);
assert.equal(fight.stamina, 1);

console.log('OK fishing controller: bite window and fight initialization are isolated');
