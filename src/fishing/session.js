export const FishingState = Object.freeze({
  IDLE: 'idle', CHARGE: 'charge', FLIGHT: 'flight', WAIT: 'wait',
  NIBBLE: 'nibble', BITE: 'bite', FIGHT: 'fight', LANDING: 'landing', CARD: 'card',
});

export const FishingEvent = Object.freeze({
  BAIT_PLACED: 'bait-placed',
  BAIT_CLEARED: 'bait-cleared',
  TARGET_ACQUIRED: 'target-acquired',
  TARGET_CLEARED: 'target-cleared',
  HOOKED: 'hooked',
  MISSED: 'missed',
  FISH_ESCAPED: 'fish-escaped',
  FISH_CAUGHT: 'fish-caught',
});

const SESSION_FIELDS = [
  'fs', 'charge', 'chargeDir', 'castPower', 'castPerfect', 'castAcc',
  'biteTimer', 'hookFish', 'fight', 'retrieving', 'stateTime', 'approachT',
];
const SESSION = Symbol('fishingSession');

export class FishingSession {
  constructor() {
    this.fs = FishingState.IDLE;
    this.charge = 0; this.chargeDir = 1; this.castPower = 0;
    this.castPerfect = false; this.castAcc = 0; this.biteTimer = 0;
    this.hookFish = null; this.fight = null; this.retrieving = false;
    this.stateTime = 0; this.approachT = 0;
    this.baitPresent = false; this.baitRevision = 0;
    this.listeners = new Map();
  }

  on(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    return () => this.listeners.get(type)?.delete(listener);
  }

  emit(type, detail = {}) {
    for (const listener of this.listeners.get(type) || []) listener(detail);
  }

  enter(state, { resetTime = true } = {}) {
    this.fs = state;
    if (resetTime) this.stateTime = 0;
  }

  setBaitPresent(present, detail = {}) {
    const next = !!present;
    if (next === this.baitPresent) return;
    this.baitPresent = next;
    this.baitRevision++;
    this.emit(next ? FishingEvent.BAIT_PLACED : FishingEvent.BAIT_CLEARED, detail);
  }

  beginApproach(fish, detail = {}) {
    this.hookFish = fish || null;
    this.approachT = 0;
    if (fish) this.emit(FishingEvent.TARGET_ACQUIRED, { fish, ...detail });
  }

  clearTarget(detail = {}) {
    const fish = this.hookFish;
    this.hookFish = null;
    this.approachT = 0;
    if (fish) this.emit(FishingEvent.TARGET_CLEARED, { fish, ...detail });
  }

  notifyHooked(fish = this.hookFish) {
    if (fish) this.emit(FishingEvent.HOOKED, { fish });
  }

  notifyMissed(fish, { baitKept = false } = {}) {
    this.emit(FishingEvent.MISSED, { fish, baitKept });
  }

  notifyEscaped(fish, detail = {}) {
    if (fish) this.emit(FishingEvent.FISH_ESCAPED, { fish, ...detail });
  }

  notifyCaught(fish, detail = {}) {
    if (fish) this.emit(FishingEvent.FISH_CAUGHT, { fish, ...detail });
  }
}

function sessionOf(game) {
  if (!Object.prototype.hasOwnProperty.call(game, SESSION)) {
    Object.defineProperty(game, SESSION, { value: new FishingSession() });
  }
  return game[SESSION];
}

export function installFishingSession(Game) {
  if (Game.prototype.__fishingSessionInstalled) return;
  Object.defineProperty(Game.prototype, '__fishingSessionInstalled', { value: true });
  Object.defineProperty(Game.prototype, 'fishing', { configurable: true, get() { return sessionOf(this); } });
  for (const field of SESSION_FIELDS) {
    Object.defineProperty(Game.prototype, field, {
      configurable: true,
      get() { return sessionOf(this)[field]; },
      set(value) { sessionOf(this)[field] = value; },
    });
  }
}

export function isFishingLineState(state) {
  return [FishingState.FLIGHT, FishingState.WAIT, FishingState.NIBBLE,
    FishingState.BITE, FishingState.FIGHT, FishingState.LANDING].includes(state);
}
