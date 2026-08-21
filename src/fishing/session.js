export const FishingState = Object.freeze({
  IDLE: 'idle', CHARGE: 'charge', FLIGHT: 'flight', WAIT: 'wait',
  NIBBLE: 'nibble', BITE: 'bite', FIGHT: 'fight', LANDING: 'landing', CARD: 'card',
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
  }
  enter(state, { resetTime = true } = {}) { this.fs = state; if (resetTime) this.stateTime = 0; }
  setBaitPresent(present) { const next = !!present; if (next !== this.baitPresent) this.baitRevision++; this.baitPresent = next; }
  beginApproach(fish) { this.hookFish = fish || null; this.approachT = 0; }
  clearTarget() { this.hookFish = null; this.approachT = 0; }
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
