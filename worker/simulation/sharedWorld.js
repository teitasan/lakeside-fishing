import { SharedWorld as BaseSharedWorld } from './world.js';
import { GEAR } from '../../src/data.js';
import { timeBand } from '../../src/util.js';
import { chooseBiterSpecies, findExistingBiter, makeBiterSpawn } from '../../src/fishing/simulation/biter.js';

const baitById = id => GEAR.bait.find(x => x.id === id) || GEAR.bait[0];
const rodById = id => GEAR.rod.find(x => x.id === id) || GEAR.rod[0];

export class SharedWorld extends BaseSharedWorld {
  tick(players) {
    const now = Date.now();
    const due = [];
    for (const bait of this.baits.values()) {
      const occupied = [...this.fishes.values()].some(f =>
        f.targetBaitId === bait.id && ['approaching', 'reserved', 'hooked'].includes(f.state));
      if (!occupied && now >= (bait.readyAt || 0)) due.push(bait.id);
    }

    super.tick(players);

    for (const baitId of due) {
      const bait = [...this.baits.values()].find(b => b.id === baitId);
      if (!bait) continue;
      const occupied = [...this.fishes.values()].some(f =>
        f.targetBaitId === bait.id && ['approaching', 'reserved', 'hooked'].includes(f.state));
      if (occupied) continue; // Base側で既存魚を選べた

      const nearSpecies = new Set();
      for (const f of this.fishes.values()) {
        if (f.state === 'swimming' && Math.hypot(f.x - bait.x, f.z - bait.z) < 18) nearSpecies.add(f.speciesId);
      }
      const depth = this.lake.depthAt(bait.x, bait.z);
      const species = chooseBiterSpecies({
        depth,
        band: timeBand(bait.hour ?? this._worldHour()),
        weather: this.weather,
        useBait: true,
        bait: baitById(bait.baitType),
        layer: bait.rigLayer,
        bed: bait.bed,
        nearStruct: bait.nearStruct,
        nearSpecies,
        rodAttract: rodById(bait.rodType).attract,
        level: bait.level,
      });
      if (!species) { bait.readyAt = now + 2000 + Math.random() * 2000; continue; }

      let fish = findExistingBiter(this.fishes.values(), species.id, bait.x, bait.z, now);
      if (!fish) {
        const spawn = makeBiterSpawn({
          species,
          x: bait.x,
          z: bait.z,
          baitY: bait.y,
          terrain: this.lake,
          rareBonus: baitById(bait.baitType).rare * 0.25,
        });
        if (!spawn) { bait.readyAt = now + 2000 + Math.random() * 2000; continue; }
        const id = `f${this.seq++}`;
        fish = {
          id, speciesId: species.id, species, length: spawn.length, albino: spawn.albino,
          x: spawn.x, y: spawn.y, z: spawn.z, vx: 0, vy: 0, vz: 0,
          tx: spawn.x, ty: spawn.y, tz: spawn.z, depthBias: spawn.depthBias,
          state: 'swimming', targetBaitId: null, ownerPlayerId: null,
          turnAt: 0, stateAt: now, phase: Math.random() * 10, startleUntil: 0,
        };
        this.fishes.set(id, fish);
      }
      fish.state = 'approaching';
      fish.targetBaitId = bait.id;
      fish.ownerPlayerId = null;
      fish.stateAt = now;
    }
  }
}
