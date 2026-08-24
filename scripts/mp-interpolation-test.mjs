import assert from 'node:assert/strict';
import { Vec3Stream, YawStream, INTERP_DELAY_SEC } from '../src/multiplayer/interpolation.js';

const out = { x: 0, y: 0, z: 0 };
const delay = INTERP_DELAY_SEC;

// 2サンプル間を補間する
{
  const s = new Vec3Stream(delay);
  s.push(0, 0, 0, 0);
  s.push(0.1, 10, 0, 0);
  assert.ok(s.sample(0.05 + delay, out));
  assert.ok(Math.abs(out.x - 5) < 0.01, `midpoint x=${out.x}`);
}

// 最初の1サンプルは即表示
{
  const s = new Vec3Stream(delay);
  s.push(1, 3, 4, 5);
  assert.ok(s.sample(1.5, out));
  assert.equal(out.x, 3);
  assert.equal(out.y, 4);
  assert.equal(out.z, 5);
}

// 時刻逆行でリセット
{
  const s = new Vec3Stream(delay);
  s.push(2, 1, 0, 0);
  s.push(2.1, 2, 0, 0);
  s.push(1.5, 99, 0, 0);
  assert.equal(s.count, 1);
  assert.ok(s.sample(2, out));
  assert.equal(out.x, 99);
}

// 短時間の重複サンプルは上書き
{
  const s = new Vec3Stream(delay);
  s.push(0, 0, 0, 0);
  s.push(0.002, 7, 0, 0);
  assert.equal(s.count, 1);
  assert.ok(s.sample(delay, out));
  assert.equal(out.x, 7);
}

// 僅かな外挿
{
  const s = new Vec3Stream(delay);
  s.push(0, 0, 0, 0);
  s.push(0.1, 10, 0, 0);
  assert.ok(s.sample(0.1 + delay + 0.05, out));
  assert.ok(out.x >= 10 && out.x <= 15, `extrapolated x=${out.x}`);
}

// Yaw は最短経路（長回りしない）
{
  const y = new YawStream(delay);
  y.push(0, 0.1);
  y.push(0.1, -0.1);
  const mid = y.sample(0.05 + delay);
  assert.ok(Math.abs(mid) < 0.05, `yaw short path mid=${mid}`);
}

console.log('OK multiplayer interpolation: temporal streams interpolate and reset safely');
