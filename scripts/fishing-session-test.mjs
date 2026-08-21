import assert from 'node:assert/strict';
import {
  FishingEvent, FishingSession, installFishingSession, isFishingLineState,
} from '../src/fishing/session.js';

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

const events = [];
const record = (type) => a.fishing.on(type, (detail) => events.push([type, detail]));
const unsubscribers = [
  record(FishingEvent.BAIT_PLACED), record(FishingEvent.BAIT_CLEARED),
  record(FishingEvent.HOOKED), record(FishingEvent.MISSED),
  record(FishingEvent.FISH_ESCAPED), record(FishingEvent.FISH_CAUGHT),
];
a.fishing.setBaitPresent(true, { source: 'test' });
a.fishing.setBaitPresent(true, { source: 'duplicate' });
a.fishing.notifyHooked(a.hookFish);
a.fishing.notifyMissed(a.hookFish, { baitKept: true });
a.fishing.notifyEscaped(a.hookFish);
a.fishing.notifyCaught(a.hookFish);
a.fishing.setBaitPresent(false, { source: 'test' });

assert.equal(a.fishing.baitPresent, false);
assert.equal(a.fishing.baitRevision, 2, '同じ餌状態の再設定でrevisionを増やさない');
assert.deepEqual(events.map(([type]) => type), [
  FishingEvent.BAIT_PLACED, FishingEvent.HOOKED, FishingEvent.MISSED,
  FishingEvent.FISH_ESCAPED, FishingEvent.FISH_CAUGHT, FishingEvent.BAIT_CLEARED,
]);
assert.equal(events[2][1].baitKept, true);
for (const unsubscribe of unsubscribers) unsubscribe();
a.fishing.notifyCaught(a.hookFish);
assert.equal(events.length, 6, 'unsubscribe後にイベントが残っている');

assert.equal(b.fs, 'idle');
assert.equal(isFishingLineState('wait'), true);
assert.equal(isFishingLineState('fight'), true);
assert.equal(isFishingLineState('idle'), false);
console.log('OK fishing session: legacy fields, semantic events, and listener lifecycle passed');
