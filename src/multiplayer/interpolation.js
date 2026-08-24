/** 受信サンプルの時間補間（10Hz 向け・固定容量リングバッファ） */
import { TAU } from '../util.js';

export const INTERP_DELAY_SEC = 0.12;
export const INTERP_DELAY_5HZ = 0.22;
export const INTERP_MAX_EXTRAPOLATE_SEC = 0.15;
const CAP = 3;

function lerpAngle(a, b, t) {
  let d = b - a;
  d = ((d + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return a + d * t;
}

export class Vec3Stream {
  constructor(delaySec = INTERP_DELAY_SEC) {
    this.delaySec = delaySec;
    this.times = new Float64Array(CAP);
    this.xs = new Float64Array(CAP);
    this.ys = new Float64Array(CAP);
    this.zs = new Float64Array(CAP);
    this.count = 0;
    this.start = 0;
    this.hasSample = false;
  }

  reset() {
    this.count = 0;
    this.start = 0;
    this.hasSample = false;
  }

  push(tSec, x, y, z) {
    if (!Number.isFinite(tSec)) tSec = performance.now() * 0.001;
    if (this.count > 0) {
      const last = (this.start + this.count - 1) % CAP;
      if (tSec < this.times[last] - 0.001) { this.reset(); }
      else if (tSec - this.times[last] < 0.004) {
        this.xs[last] = x; this.ys[last] = y; this.zs[last] = z;
        return;
      }
    }
    if (this.count === CAP) { this.start = (this.start + 1) % CAP; this.count--; }
    const idx = (this.start + this.count) % CAP;
    this.times[idx] = tSec;
    this.xs[idx] = x; this.ys[idx] = y; this.zs[idx] = z;
    this.count++;
    this.hasSample = true;
  }

  snap(x, y, z) {
    this.reset();
    this.push(performance.now() * 0.001, x, y, z);
  }

  sample(nowSec, out) {
    if (!this.hasSample || this.count === 0) return false;
    const target = nowSec - this.delaySec;
    const oldest = this.start;
    const newest = (this.start + this.count - 1) % CAP;

    if (this.count === 1 || target <= this.times[oldest]) {
      out.x = this.xs[oldest]; out.y = this.ys[oldest]; out.z = this.zs[oldest];
      return true;
    }

    let i0 = -1, i1 = -1;
    for (let i = 0; i < this.count - 1; i++) {
      const a = (this.start + i) % CAP;
      const b = (this.start + i + 1) % CAP;
      if (this.times[a] <= target && target <= this.times[b]) { i0 = a; i1 = b; break; }
    }

    if (i0 < 0) {
      const dt = target - this.times[newest];
      if (this.count >= 2 && dt > 0 && dt <= INTERP_MAX_EXTRAPOLATE_SEC) {
        const prev = (this.start + this.count - 2) % CAP;
        const seg = this.times[newest] - this.times[prev];
        if (seg > 1e-6) {
          const u = dt / seg;
          out.x = this.xs[newest] + (this.xs[newest] - this.xs[prev]) * u;
          out.y = this.ys[newest] + (this.ys[newest] - this.ys[prev]) * u;
          out.z = this.zs[newest] + (this.zs[newest] - this.zs[prev]) * u;
          return true;
        }
      }
      out.x = this.xs[newest]; out.y = this.ys[newest]; out.z = this.zs[newest];
      return true;
    }

    const t0 = this.times[i0], t1 = this.times[i1];
    const u = t1 === t0 ? 0 : (target - t0) / (t1 - t0);
    out.x = this.xs[i0] + (this.xs[i1] - this.xs[i0]) * u;
    out.y = this.ys[i0] + (this.ys[i1] - this.ys[i0]) * u;
    out.z = this.zs[i0] + (this.zs[i1] - this.zs[i0]) * u;
    return true;
  }
}

export class YawStream {
  constructor(delaySec = INTERP_DELAY_SEC) {
    this.delaySec = delaySec;
    this.times = new Float64Array(CAP);
    this.yaws = new Float64Array(CAP);
    this.count = 0;
    this.start = 0;
    this.hasSample = false;
  }

  reset() {
    this.count = 0;
    this.start = 0;
    this.hasSample = false;
  }

  push(tSec, yaw) {
    if (!Number.isFinite(tSec)) tSec = performance.now() * 0.001;
    if (this.count > 0) {
      const last = (this.start + this.count - 1) % CAP;
      if (tSec < this.times[last] - 0.001) { this.reset(); }
      else if (tSec - this.times[last] < 0.004) { this.yaws[last] = yaw; return; }
    }
    if (this.count === CAP) { this.start = (this.start + 1) % CAP; this.count--; }
    const idx = (this.start + this.count) % CAP;
    this.times[idx] = tSec;
    this.yaws[idx] = yaw;
    this.count++;
    this.hasSample = true;
  }

  snap(yaw) {
    this.reset();
    this.push(performance.now() * 0.001, yaw);
  }

  sample(nowSec) {
    if (!this.hasSample || this.count === 0) return null;
    const target = nowSec - this.delaySec;
    const oldest = this.start;
    const newest = (this.start + this.count - 1) % CAP;

    if (this.count === 1 || target <= this.times[oldest]) return this.yaws[oldest];

    let i0 = -1, i1 = -1;
    for (let i = 0; i < this.count - 1; i++) {
      const a = (this.start + i) % CAP;
      const b = (this.start + i + 1) % CAP;
      if (this.times[a] <= target && target <= this.times[b]) { i0 = a; i1 = b; break; }
    }

    if (i0 < 0) {
      const dt = target - this.times[newest];
      if (this.count >= 2 && dt > 0 && dt <= INTERP_MAX_EXTRAPOLATE_SEC) {
        const prev = (this.start + this.count - 2) % CAP;
        const seg = this.times[newest] - this.times[prev];
        if (seg > 1e-6) {
          let dy = this.yaws[newest] - this.yaws[prev];
          dy = ((dy + Math.PI) % TAU + TAU) % TAU - Math.PI;
          return this.yaws[newest] + dy * (dt / seg);
        }
      }
      return this.yaws[newest];
    }

    const t0 = this.times[i0], t1 = this.times[i1];
    const u = t1 === t0 ? 0 : (target - t0) / (t1 - t0);
    return lerpAngle(this.yaws[i0], this.yaws[i1], u);
  }
}

/** メッセージ受信時刻（秒）。multiplayer.js が _recvAt を付与する */
export function recvTimeSec(msg) {
  const t = msg?._recvAt;
  return Number.isFinite(t) ? t * 0.001 : performance.now() * 0.001;
}
