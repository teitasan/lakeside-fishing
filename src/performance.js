/* ===========================================================
   フレーム計測：CPU/GPU タイミング、renderer.info 集計、品質別サマリー
   =========================================================== */
import * as THREE from 'three';

const QUALITIES = ['low', 'mid', 'high'];
const ROLL = 180;

class RollingStats {
  constructor(size = ROLL) {
    this.size = size;
    this.buf = new Float64Array(size);
    this.i = 0;
    this.n = 0;
  }

  push(v) {
    this.buf[this.i] = v;
    this.i = (this.i + 1) % this.size;
    if (this.n < this.size) this.n++;
  }

  _values() {
    if (!this.n) return [];
    const out = new Array(this.n);
    if (this.n < this.size) {
      for (let k = 0; k < this.n; k++) out[k] = this.buf[k];
    } else {
      for (let k = 0; k < this.n; k++) out[k] = this.buf[(this.i + k) % this.size];
    }
    return out;
  }

  avg() {
    const arr = this._values();
    if (!arr.length) return 0;
    let s = 0;
    for (const v of arr) s += v;
    return s / arr.length;
  }

  p95() {
    const arr = this._values();
    if (!arr.length) return 0;
    arr.sort((a, b) => a - b);
    return arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.95))];
  }
}

class QualityBucket {
  constructor() {
    this.frames = 0;
    this.frameMs = new RollingStats();
    this.cpuMs = new RollingStats();
    this.updateMs = new RollingStats();
    this.renderMs = new RollingStats();
    this.gpuMs = new RollingStats();
    this.calls = new RollingStats();
    this.triangles = new RollingStats();
  }

  ingest(s) {
    this.frames++;
    this.frameMs.push(s.frameMs);
    this.cpuMs.push(s.cpuMs);
    this.updateMs.push(s.updateMs);
    this.renderMs.push(s.renderMs);
    this.calls.push(s.total.calls);
    this.triangles.push(s.total.triangles);
  }

  snapshot() {
    return {
      frames: this.frames,
      frameMs: { avg: this.frameMs.avg(), p95: this.frameMs.p95() },
      cpuMs: { avg: this.cpuMs.avg(), p95: this.cpuMs.p95() },
      updateMs: { avg: this.updateMs.avg(), p95: this.updateMs.p95() },
      renderMs: { avg: this.renderMs.avg(), p95: this.renderMs.p95() },
      gpuMs: { avg: this.gpuMs.avg(), p95: this.gpuMs.p95(), supported: this.gpuMs.n > 0 },
      calls: { avg: this.calls.avg(), p95: this.calls.p95() },
      triangles: { avg: this.triangles.avg(), p95: this.triangles.p95() },
    };
  }
}

/** EXT_disjoint_timer_query_webgl2（非ブロッキング・失敗時は安全に無効） */
class GpuTimer {
  constructor(renderer) {
    this.renderer = renderer;
    this.supported = false;
    this.disjoint = false;
    this.pending = [];
    this.active = null;
    this.lastByQuality = { low: null, mid: null, high: null };
    this.lastAtByQuality = { low: 0, mid: 0, high: 0 };
    const gl = renderer.getContext();
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (this.ext) this.supported = true;
  }

  begin(quality, generation) {
    if (!this.supported || this.disjoint || this.active || this.pending.length >= 8) return null;
    let query = null;
    try {
      query = this.gl.createQuery();
      if (!query) return null;
      this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
      this.active = { query, quality, generation };
      return this.active;
    } catch (e) {
      if (query) this.gl.deleteQuery(query);
      this.active = null;
      return null;
    }
  }

  end(token) {
    if (!token || token !== this.active || !this.supported) return;
    try {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.pending.push(token);
    } catch (e) {
      this.gl.deleteQuery(token.query);
    }
    this.active = null;
  }

  abort(token = this.active) {
    if (!token || token !== this.active) return;
    try { this.gl.endQuery(this.ext.TIME_ELAPSED_EXT); } catch (e) { /* context loss等 */ }
    try { this.gl.deleteQuery(token.query); } catch (e) { /* context loss等 */ }
    this.active = null;
  }

  clearQuality(quality) {
    if (!(quality in this.lastByQuality)) return;
    this.lastByQuality[quality] = null;
    this.lastAtByQuality[quality] = 0;
  }

  clearLast() {
    for (const q of QUALITIES) this.clearQuality(q);
  }

  latest(quality, maxAgeMs = 1000) {
    const ms = this.lastByQuality[quality];
    const at = this.lastAtByQuality[quality] || 0;
    const ageMs = at > 0 ? performance.now() - at : Infinity;
    return { ms: ageMs <= maxAgeMs ? ms : null, ageMs };
  }

  poll() {
    const samples = [];
    if (!this.supported) return samples;
    const gl = this.gl;
    try {
      this.disjoint = !!gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      if (this.disjoint) {
        for (const token of this.pending) gl.deleteQuery(token.query);
        this.pending.length = 0;
        this.clearLast();
        return samples;
      }
      while (this.pending.length) {
        const token = this.pending[0];
        const ready = gl.getQueryParameter(token.query, gl.QUERY_RESULT_AVAILABLE);
        if (!ready) break;
        const ns = gl.getQueryParameter(token.query, gl.QUERY_RESULT);
        gl.deleteQuery(token.query);
        this.pending.shift();
        const ms = ns / 1e6;
        samples.push({ quality: token.quality, generation: token.generation, ms });
      }
    } catch (e) {
      for (const token of this.pending) {
        try { gl.deleteQuery(token.query); } catch (deleteError) { /* context loss等 */ }
      }
      this.abort();
      this.supported = false;
      this.pending.length = 0;
      this.clearLast();
    }
    return samples;
  }
}

function snapRenderInfo(renderer) {
  const r = renderer.info.render;
  const m = renderer.info.memory;
  return {
    calls: r.calls,
    triangles: r.triangles,
    points: r.points,
    lines: r.lines,
    geometries: m.geometries,
    textures: m.textures,
  };
}

function diffInfo(a, b) {
  return {
    calls: b.calls - a.calls,
    triangles: b.triangles - a.triangles,
    points: b.points - a.points,
    lines: b.lines - a.lines,
    geometries: b.geometries - a.geometries,
    textures: b.textures - a.textures,
  };
}

export class FrameProfiler {
  constructor(renderer) {
    this.renderer = renderer;
    renderer.info.autoReset = false;
    this.gpu = new GpuTimer(renderer);
    this.quality = null;
    this.byQuality = Object.fromEntries(QUALITIES.map((q) => [q, new QualityBucket()]));
    this._qualityGeneration = Object.fromEntries(QUALITIES.map((q) => [q, 0]));
    this.compileByQuality = Object.fromEntries(QUALITIES.map((q) => [q, null]));
    this._frameStart = 0;
    this._lastFrameStart = 0;
    this._frameIntervalMs = 0;
    this._updateMs = 0;
    this._renderStart = 0;
    this._passBase = null;
    this._passSnap = {};
    this._gpuQuery = null;
    this._warmupRemaining = 0;
    this.last = null;
  }

  setQuality(q, { warmupFrames = 30, reset = true } = {}) {
    if (!QUALITIES.includes(q)) return;
    const changed = this.quality !== q;
    this.quality = q;
    if (changed || reset) {
      this.byQuality[q] = new QualityBucket();
      this._qualityGeneration[q]++;
      this.gpu.clearQuality(q);
      this._warmupRemaining = Math.max(0, Math.floor(warmupFrames));
      this._lastFrameStart = 0;
      this._frameIntervalMs = 0;
      this.last = null;
    }
  }

  resetCurrent(warmupFrames = 12) {
    if (this.quality) this.setQuality(this.quality, { warmupFrames, reset: true });
  }

  setCompileStats(ms, programs = 0) {
    if (!this.quality) return;
    this.compileByQuality[this.quality] = {
      ms: Math.max(0, Number(ms) || 0),
      programs: Math.max(0, Number(programs) || 0),
    };
  }

  beginFrame(now = performance.now()) {
    this.renderer.info.reset();
    this._ingestGpuSamples(this.gpu.poll());
    this._frameIntervalMs = this._lastFrameStart > 0 ? now - this._lastFrameStart : 0;
    this._lastFrameStart = now;
    this._frameStart = now;
    this._passSnap = {};
    this._passBase = snapRenderInfo(this.renderer);
    this._gpuQuery = null;
    this._updateMs = 0;
    this._renderStart = 0;
  }

  markUpdate(ms) {
    this._updateMs = ms;
  }

  beginRender(now = performance.now()) {
    this._renderStart = now;
    this._gpuQuery = this._warmupRemaining > 0
      ? null : this.gpu.begin(this.quality, this._qualityGeneration[this.quality]);
  }

  /** 描画パス開始（capture / reflection / composer） */
  beginPass(name) {
    this._passSnap[`${name}__start`] = snapRenderInfo(this.renderer);
  }

  endPass(name) {
    const end = snapRenderInfo(this.renderer);
    const start = this._passSnap[`${name}__start`] || this._passBase;
    this._passSnap[name] = diffInfo(start, end);
  }

  endFrame(now = performance.now()) {
    this.gpu.end(this._gpuQuery);
    this._ingestGpuSamples(this.gpu.poll());

    const total = snapRenderInfo(this.renderer);
    const cpuMs = now - this._frameStart;
    const frameMs = this._frameIntervalMs > 0 ? this._frameIntervalMs : cpuMs;
    const renderMs = this._renderStart ? now - this._renderStart : 0;
    const gpuLatest = this.gpu.latest(this.quality);
    const snap = {
      frameMs,
      cpuMs,
      updateMs: this._updateMs,
      renderMs,
      gpuMs: gpuLatest.ms,
      gpuSampleAgeMs: gpuLatest.ageMs,
      gpuSupported: this.gpu.supported && !this.gpu.disjoint,
      quality: this.quality,
      total,
      passes: {
        capture: this._passSnap.capture || null,
        reflection: this._passSnap.reflection || null,
        composer: this._passSnap.composer || null,
      },
      rtBytes: 0,
      warmupRemaining: this._warmupRemaining,
    };
    if (this._warmupRemaining > 0) this._warmupRemaining--;
    else this.byQuality[this.quality]?.ingest(snap);
    this.last = snap;
    this._gpuQuery = null;
    return snap;
  }

  abortFrame() {
    this.gpu.abort(this._gpuQuery);
    this._gpuQuery = null;
    this._lastFrameStart = 0;
    this._frameIntervalMs = 0;
    this._warmupRemaining = Math.max(this._warmupRemaining, 1);
  }

  _ingestGpuSamples(samples) {
    for (const sample of samples || []) {
      if (sample.generation === this._qualityGeneration[sample.quality]) {
        this.byQuality[sample.quality]?.gpuMs.push(sample.ms);
        this.gpu.lastByQuality[sample.quality] = sample.ms;
        this.gpu.lastAtByQuality[sample.quality] = performance.now();
      }
    }
  }

  /** レンダーターゲットの概算メモリ（bytes） */
  estimateRtBytes(game) {
    let bytes = 0;
    const seen = new Set();
    const colorBpp = (texture) => {
      if (texture?.format === THREE.DepthStencilFormat) return 4;
      if (texture?.format === THREE.DepthFormat) {
        return texture?.type === THREE.UnsignedShortType ? 2 : 4;
      }
      const channels = texture?.format === THREE.RedFormat || texture?.format === THREE.DepthFormat ? 1
        : texture?.format === THREE.RGFormat ? 2 : 4;
      const bytesPerChannel = texture?.type === THREE.FloatType ? 4
        : texture?.type === THREE.HalfFloatType || texture?.type === THREE.UnsignedShortType
          || texture?.type === THREE.ShortType ? 2
          : texture?.type === THREE.UnsignedIntType || texture?.type === THREE.IntType
            || texture?.type === THREE.UnsignedInt248Type ? 4 : 1;
      return channels * bytesPerChannel;
    };
    const addRT = (rt) => {
      if (!rt || seen.has(rt)) return;
      seen.add(rt);
      const pixels = Math.max(1, rt.width) * Math.max(1, rt.height);
      const samples = Math.max(0, rt.samples || 0);
      const textures = rt.textures?.length ? rt.textures : [rt.texture];
      for (const texture of textures) {
        // samples>0ではresolve textureに加えてmultisample renderbufferも存在する。
        bytes += pixels * colorBpp(texture) * (1 + samples);
      }
      if (rt.depthTexture) {
        bytes += pixels * colorBpp(rt.depthTexture);
        if (samples > 0) bytes += pixels * 4 * samples;
      } else if (rt.depthBuffer) {
        bytes += pixels * 4 * Math.max(1, samples);
      }
    };
    addRT(game.water?.rt);
    addRT(game.water?.reflRT);
    addRT(game.env?.sun?.shadow?.map);
    const composer = game.postfx?.composer;
    addRT(composer?.inputBuffer);
    addRT(composer?.outputBuffer);
    addRT(composer?.depthRenderTarget);
    const bloom = game.postfx?.bloom;
    addRT(bloom?.renderTarget);
    addRT(bloom?.luminancePass?.renderTarget);
    addRT(bloom?.blurPass?.renderTargetA);
    addRT(bloom?.blurPass?.renderTargetB);
    const mip = bloom?.mipmapBlurPass;
    addRT(mip?.renderTarget);
    for (const rt of mip?.downsamplingMipmaps || []) addRT(rt);
    for (const rt of mip?.upsamplingMipmaps || []) addRT(rt);
    return bytes;
  }

  getSnapshot(game = null) {
    const s = this.last;
    const summaries = {};
    for (const q of QUALITIES) summaries[q] = this.byQuality[q].snapshot();
    const rtBytes = game ? this.estimateRtBytes(game) : (s?.rtBytes || 0);
    return {
      fps: s ? 1000 / Math.max(0.001, s.frameMs) : 0,
      frameMs: s?.frameMs ?? 0,
      cpuMs: s?.cpuMs ?? 0,
      updateMs: s?.updateMs ?? 0,
      renderMs: s?.renderMs ?? 0,
      gpuMs: s?.gpuMs ?? null,
      gpuSampleAgeMs: s?.gpuSampleAgeMs ?? Infinity,
      gpuSupported: s?.gpuSupported ?? false,
      quality: this.quality,
      total: s?.total ?? snapRenderInfo(this.renderer),
      passes: s?.passes ?? {},
      rtBytes,
      warmupRemaining: s?.warmupRemaining ?? this._warmupRemaining,
      compile: this.quality ? this.compileByQuality[this.quality] : null,
      summaries,
    };
  }
}
