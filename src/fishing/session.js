export const FishingState = Object.freeze({
  IDLE: 'idle',
  CHARGE: 'charge',
  FLIGHT: 'flight',
  WAIT: 'wait',
  NIBBLE: 'nibble',
  BITE: 'bite',
  FIGHT: 'fight',
  LANDING: 'landing',
  CARD: 'card',
});

const SESSION_FIELDS = [
  'fs', 'charge', 'chargeDir', 'castPower', 'castPerfect', 'castAcc',
  'biteTimer', 'hookFish', 'fight', 'retrieving', 'stateTime',
  'approachT',
];

export class FishingSession {
  constructor() {
    this.fs = FishingState.IDLE;
    this.charge = 0;
    this.chargeDir = 1;
    this.castPower = 0;
    this.castPerfect = false;
    this.castAcc = 0;
    this.biteTimer = 0;
    this.hookFish = null;
    this.fight = null;
    this.retrieving = false;
    this.stateTime = 0;
    this.approachT = 0;
    this.baitPresent = false;
    this.baitRevision = 0;
  }

  enter(state, { resetTime = true } = {}) {
    this.fs = state;
    if (resetTime) this.stateTime = 0;
  }

  setBaitPresent(present) {
    const next = !!present;
    if (next !== this.baitPresent) this.baitRevision++;
    this.baitPresent = next;
  }

  beginApproach(fish) {
    this.hookFish = fish || null;
    this.approachT = 0;
  }

  clearTarget() {
    this.hookFish = null;
    this.approachT = 0;
  }

  beginFight(fish, fight) {
    this.hookFish = fish || this.hookFish;
    this.fight = fight || null;
    this.enter(FishingState.FIGHT);
  }

  endFight({ keepBait = false } = {}) {
    this.fight = null;
    this.clearTarget();
    this.enter(keepBait ? FishingState.WAIT : FishingState.IDLE);
    this.setBaitPresent(keepBait);
  }
}

export function bindFishingSession(game, session = new FishingSession()) {
  Object.defineProperty(game, 'fishing', {
    value: session,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  for (const field of SESSION_FIELDS) {
    Object.defineProperty(game, field, {
      configurable: true,
      enumerable: true,
      get() { return session[field]; },
      set(value) { session[field] = value; },
    });
  }
  return session;
}

export function isFishingLineState(state) {
  return [
    FishingState.FLIGHT,
    FishingState.WAIT,
    FishingState.NIBBLE,
    FishingState.BITE,
    FishingState.FIGHT,
    FishingState.LANDING,
  ].includes(state);
}
