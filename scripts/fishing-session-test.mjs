import assert from 'node:assert/strict';
import { FishingSession, installFishingSession, isFishingLineState } from '../src/fishing/session.js';

class FakeGame {
  constructor() {
    this.fs = 'idle';
    this.charge = 0;
    this.hookFish = null;
    this.stateTime = 0;
  }
}
installFishingSession(FakeGame);
const a = new FakeGame(), b = new FakeGame();
assert.ok(a.fishing instanceof FishingSession);
assert.notEqual(a.fishing, b.fishing, 'セッションがインスタンス間で共有されている');
a.fs = 'wait'; a.charge = 0.7; a.hookFish = { id: 'f1' };
assert.equal(a.fishing.fs, 'wait');
assert.equal(a.fishing.charge, 0.7);
assert.equal(a.fishing.hookFish.id, 'f1');
a.fishing.beginApproach({ id: 'f2' });
assert.equal(a.hookFish.id, 'f2');
a.fishing.setBaitPresent(true);
assert.equal(a.fishing.baitPresent, true);
assert.equal(a.fishing.baitRevision, 1);
assert.equal(b.fs, 'idle');
assert.equal(isFishingLineState('wait'), true);
assert.equal(isFishingLineState('fight'), true);
assert.equal(isFishingLineState('idle'), false);
console.log('OK fishing session: legacy Game fields are isolated and backed by FishingSession');
