import assert from 'node:assert/strict';
import { installFishingController } from '../src/fishing/controller.js';
import { installFightController } from '../src/fishing/fightController.js';
import { installFishingSession } from '../src/fishing/session.js';

class FakeGame { _updateFight() { return 'legacy'; } }
installFishingController(FakeGame);
installFightController(FakeGame);
installFishingSession(FakeGame);
const g = new FakeGame();
assert.ok(g.fishingController);
assert.ok(g.fightController);
assert.ok(g.fishing);
assert.equal(g._updateFight(0.1, null), 'legacy');
g.fs = 'bite';
assert.equal(g.fishing.fs, 'bite');
g.fishing.enter('fight');
assert.equal(g.fs, 'fight');
console.log('OK fishing runtime installation order');
