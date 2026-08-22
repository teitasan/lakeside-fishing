import { SharedWorld as BaseSharedWorld } from './world.js';
import { GEAR, JUNK } from '../../src/data.js';
import { timeBand } from '../../src/util.js';
import { chooseBiterSpecies, findExistingBiter, makeBiterSpawn } from '../../src/fishing/simulation/biter.js';

const baitById = id => GEAR.bait.find(x => x.id === id) || GEAR.bait[0];
const rodById = id => GEAR.rod.find(x => x.id === id) || GEAR.rod[0];

/* シングルの junkP（game.js _chooseBiter）と同じ式。
   totalCaught は餌メッセージ経由で渡る（初心者のうちはゴミが減る） */
function rollJunk(bait, rng = Math.random) {
  const b = baitById(bait.baitType);
  const depth = bait._depth ?? 0;
  const p = 0.085 * b.junk * (depth < 1.4 ? 1.8 : 1)
    * (bait.rigLayer === 'bottom' ? 1.5 : 0.55)
    * ((bait.totalCaught ?? 99) < 3 ? 0.3 : 1);
  return rng() < p ? JUNK[Math.floor(rng() * JUNK.length)] : null;
}

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
      bait._depth = this.lake.depthAt(bait.x, bait.z);

      // ゴミ抽選：シングル同様、魚より先に行う。ゴミは泳がないのでその場で予約状態にする
      const junk = rollJunk(bait);
      if (junk) {
        const id = `f${this.seq++}`;
        this.fishes.set(id, {
          id, speciesId: junk.id, species: junk,
          length: Math.round((junk.len[0] + Math.random() * (junk.len[1] - junk.len[0])) * 10) / 10,
          albino: false,
          x: bait.x + (Math.random() - 0.5) * 0.6, y: bait.y - 0.1, z: bait.z + (Math.random() - 0.5) * 0.6,
          vx: 0, vy: 0, vz: 0, tx: bait.x, ty: bait.y, tz: bait.z, depthBias: 0.5,
          state: 'reserved', targetBaitId: bait.id, ownerPlayerId: bait.playerId,
          turnAt: 0, stateAt: now, phase: Math.random() * 10, startleUntil: 0, junk: true,
        });
        continue;
      }

      // 種を先に決める（シングル一致）。候補が無ければ短い再試行
      const nearSpecies = new Set();
      for (const f of this.fishes.values()) {
        if (f.state === 'swimming' && now >= (f.startleUntil || 0)
          && Math.hypot(f.x - bait.x, f.z - bait.z) < 18) nearSpecies.add(f.speciesId);
      }
      const species = chooseBiterSpecies({
        depth: bait._depth,
        band: timeBand(this._worldHour()),
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
