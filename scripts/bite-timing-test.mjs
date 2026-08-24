import assert from 'node:assert/strict';
import {
  biteDelaySeconds,
  BITE_DELAY_MIN_SEC,
  BITE_DELAY_MAX_SEC,
  BITE_DELAY_MP_MIN_MUL,
  BITE_DELAY_MP_MAX_MUL,
} from '../src/fishing/simulation/biteTiming.js';

const fixed = () => 0.5;
assert.equal(biteDelaySeconds({ rng: fixed }), 4.6);
assert.equal(biteDelaySeconds({ baitAttract: 2, rng: fixed }), 2.3);
assert.equal(biteDelaySeconds({ weatherBite: 1.3, rng: fixed }), 4.6 / 1.3);
assert.equal(biteDelaySeconds({ lineAttract: 0.5, rng: fixed }), 9.2);
assert.equal(biteDelaySeconds({ depth: 0.5, rng: fixed }), 4.6 * 1.7);
assert.ok(biteDelaySeconds({ castAcc: 1, rng: fixed }) < biteDelaySeconds({ castAcc: 0, rng: fixed }));

const minRng = () => 0;
const maxRng = () => 1;
const spMin = BITE_DELAY_MIN_SEC;
const spMax = BITE_DELAY_MAX_SEC;
const mpMin = BITE_DELAY_MIN_SEC * BITE_DELAY_MP_MIN_MUL;
const mpMax = BITE_DELAY_MAX_SEC * BITE_DELAY_MP_MAX_MUL;
assert.equal(biteDelaySeconds({ rng: minRng }), spMin);
assert.equal(biteDelaySeconds({ rng: maxRng }), spMax);
assert.equal(biteDelaySeconds({ rng: minRng, multiplayer: true }), mpMin);
assert.equal(biteDelaySeconds({ rng: maxRng, multiplayer: true }), mpMax);
assert.equal(biteDelaySeconds({ baitAttract: 2, rng: minRng, multiplayer: true }), mpMin / 2);
assert.equal(biteDelaySeconds({ depth: 0.5, rng: maxRng, multiplayer: true }), mpMax * 1.7);
assert.ok(
  biteDelaySeconds({ rng: minRng, multiplayer: true })
  > biteDelaySeconds({ rng: minRng }),
);
assert.ok(
  biteDelaySeconds({ rng: maxRng, multiplayer: true })
  > biteDelaySeconds({ rng: maxRng }),
);

console.log('OK bite timing: single-player formula unchanged; multiplayer min/max scaled 2x/4x');
