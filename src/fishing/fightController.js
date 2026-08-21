export class FightController {
  constructor(game) { this.game = game; }
  update(dt, tipPos) { return this.game._updateFightLegacy(dt, tipPos); }
}

export function installFightController(Game) {
  if (Game.prototype.__fightControllerInstalled) return;
  Object.defineProperty(Game.prototype, '__fightControllerInstalled', { value: true });
  Object.defineProperty(Game.prototype, 'fightController', {
    configurable: true,
    get() {
      if (!this.__fightController) Object.defineProperty(this, '__fightController', { value: new FightController(this) });
      return this.__fightController;
    },
  });
  if (!Game.prototype._updateFightLegacy) Game.prototype._updateFightLegacy = Game.prototype._updateFight;
  Game.prototype._updateFight = function (dt, tipPos) { return this.fightController.update(dt, tipPos); };
}
