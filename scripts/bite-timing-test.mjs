import assert from 'node:assert/strict';
import { biteDelaySeconds } from '../src/fishing/simulation/biteTiming.js';

const fixed = () => 0.5;
assert.equal(biteDelaySeconds({ rng: fixed }), 4.6);
assert.equal(biteDelaySeconds({ baitAttract: 2, rng: fixed }), 2.3);
assert.equal(biteDelaySeconds({ weatherBite: 1.3, rng: fixed }), 4.6 / 1.3);
assert.equal(biteDelaySeconds({ lineAttract: 0.5, rng: fixed }), 9.2);
assert.equal(biteDelaySeconds({ depth: 0.5, rng: fixed }), 4.6 * 1.7);
assert.ok(biteDelaySeconds({ castAcc: 1, rng: fixed }) < biteDelaySeconds({ castAcc: 0, rng: fixed }));
console.log('OK bite timing: bait/rod/line/weather/cast/depth multipliers match single-player formula');
