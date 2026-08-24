import assert from 'node:assert/strict';
import { SharedWorld } from '../worker/simulation/sharedWorld.js';
import { MultiplayerClient } from '../src/network/multiplayer.js';

// --- world: full/delta fish snapshot + vision ---
{
  const world = new SharedWorld();
  const players = [{ id: 'p1', x: 0, y: 0, z: 0, fresh: false }];
  for (let i = 0; i < 30; i++) world.tick(players);
  const legacy = world.snapshot();
  assert.ok(legacy.length >= 10, 'snapshot() API互換');
  assert.ok(legacy.every((f) => f.speciesId && f.length != null), 'full fields');

  const full = world.fishSnapshotFull('p1', 0, 0);
  const known = new Set(full.map((f) => f.id));
  assert.ok(known.size > 0);

  const far = world.fishSnapshotFull('p1', 500, 500);
  assert.ok(far.length < full.length, '視界外の魚を除外');

  const delta = world.fishSnapshotDelta('p1', 500, 500, known);
  assert.ok(delta.removed.length > 0, '視界外になった魚はremoved');
  assert.equal(delta.added.length, 0);
}

// --- client: stage/flush batched update ---
{
  const mp = new MultiplayerClient();
  mp.connected = true;
  mp.ws = { readyState: 1, send: (raw) => { mp._lastRaw = raw; } };
  mp.sendState(1, 2, 3, 0.5, 'walk');
  mp.sendVisual({ fs: 'idle', charge: 0, tension: 0, reeling: 0, rod: 'bamboo', bait: 'worm', rarity: 0, bx: 1, by: 2, bz: 3, line: false });
  assert.equal(mp._staged?.x, 1);
  mp.flushUpdate(true);
  const msg = JSON.parse(mp._lastRaw);
  assert.equal(msg.t, 'u');
  assert.equal(msg.x, 1);
  assert.equal(msg.fs, 'idle');
  assert.equal(msg.rod, 'bamboo');
  mp.sendVisual({ fs: 'wait', charge: 0, tension: 0, reeling: 0, rod: 'bamboo', bait: 'worm', rarity: 0, bx: 4, by: 5, bz: 6, line: true });
  mp.flushUpdate(true);
  const msg2 = JSON.parse(mp._lastRaw);
  assert.equal(msg2.fs, 'wait');
  assert.equal(msg2.rod, undefined, '静的rodは変更時のみ');
}

// --- client: fish_snapshot full/delta normalization ---
{
  const mp = new MultiplayerClient();
  const full = mp._normalizeFishSnapshot({ mode: 'full', fish: [{ id: 'f1' }], hz: 10 }, 1000);
  assert.equal(full._mode, 'full');
  assert.equal(full[0].id, 'f1');
  const delta = mp._normalizeFishSnapshot({ mode: 'delta', added: [], fish: [{ id: 'f1' }], removed: ['f0'], hz: 5 }, 2000);
  assert.equal(delta._mode, 'delta');
  assert.deepEqual(delta._removed, ['f0']);
}

console.log('OK mp v4 unit: fish vision/delta, client stage/flush, snapshot normalize');
