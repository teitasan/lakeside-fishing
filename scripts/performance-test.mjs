#!/usr/bin/env node
/* FrameProfiler の統計・GPU query復旧・RT見積テスト（実WebGL不要） */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(root, 'src/performance.js'), 'utf8');

if (!src.includes('autoReset = false')) throw new Error('renderer.info.autoReset should be disabled');
if (!src.includes('EXT_disjoint_timer_query_webgl2')) throw new Error('GPU timer extension missing');
if (!src.includes('byQuality')) throw new Error('per-quality summaries missing');
if (!src.includes('_lastFrameStart')) throw new Error('rAF frame interval tracking missing');
if (!src.includes('lastByQuality')) throw new Error('GPU samples must retain quality metadata');
if (!src.includes('pending.length >= 8')) throw new Error('GPU query queue must be bounded');
if (!src.includes('this.gpu.begin(this.quality, this._qualityGeneration[this.quality])')) {
  throw new Error('GPU query should begin at render submission');
}
if (src.includes('if (s.gpuMs != null) this.gpuMs.push')) {
  throw new Error('delayed GPU samples must not be re-ingested every frame');
}
if (!src.includes('abortFrame()') || !src.includes('this.gpu.abort(this._gpuQuery)')) {
  throw new Error('render exceptions must abort active GPU queries');
}
if (!src.includes('warmupFrames') || !src.includes('_qualityGeneration')) {
  throw new Error('quality comparisons need warmup and generation isolation');
}
if (!src.includes("addRT(game.env?.sun?.shadow?.map)")) {
  throw new Error('shadow render target must be included in memory estimate');
}

const executable = src
  .replace("import * as THREE from 'three';", 'const THREE = globalThis.__THREE;')
  .replace('export class FrameProfiler', 'class FrameProfiler')
  + '\nglobalThis.__FrameProfiler = FrameProfiler;';

const THREE = {
  RedFormat: 1, RGFormat: 2, DepthFormat: 3, DepthStencilFormat: 4,
  FloatType: 10, HalfFloatType: 11, UnsignedShortType: 12, ShortType: 13,
  UnsignedIntType: 14, IntType: 15, UnsignedInt248Type: 16,
};
const context = vm.createContext({ __THREE: THREE, performance });
vm.runInContext(executable, context, { filename: 'performance.js' });
const FrameProfiler = context.__FrameProfiler;

class MockGL {
  constructor() {
    this.QUERY_RESULT_AVAILABLE = 100;
    this.QUERY_RESULT = 101;
    this.ext = { TIME_ELAPSED_EXT: 200, GPU_DISJOINT_EXT: 201 };
    this.active = null;
    this.beginCount = 0;
  }
  getExtension(name) { return name === 'EXT_disjoint_timer_query_webgl2' ? this.ext : null; }
  createQuery() { return { ready: false, result: 4_000_000, deleted: false }; }
  beginQuery(type, query) {
    if (this.active) throw new Error('query already active');
    this.active = query;
    this.beginCount++;
  }
  endQuery() {
    if (!this.active) throw new Error('no active query');
    this.active.ready = true;
    this.active = null;
  }
  deleteQuery(query) { query.deleted = true; }
  getParameter() { return false; }
  getQueryParameter(query, pname) {
    return pname === this.QUERY_RESULT_AVAILABLE ? query.ready : query.result;
  }
}

const gl = new MockGL();
const renderer = {
  info: {
    autoReset: true,
    render: { calls: 0, triangles: 0, points: 0, lines: 0 },
    memory: { geometries: 3, textures: 5 },
    reset() {
      this.render.calls = this.render.triangles = this.render.points = this.render.lines = 0;
    },
  },
  getContext: () => gl,
};
const profiler = new FrameProfiler(renderer);
profiler.setQuality('high', { warmupFrames: 0 });
profiler.beginFrame(100);
profiler.markUpdate(1.25);
profiler.beginRender(101.25);
renderer.info.render.calls = 7;
renderer.info.render.triangles = 1234;
profiler.endFrame(105);
let snap = profiler.getSnapshot();
assert.equal(snap.summaries.high.frames, 1);
assert.equal(snap.summaries.high.calls.avg, 7);
assert.equal(snap.summaries.high.gpuMs.avg, 4);
profiler.setCompileStats(12.5, 9);
snap = profiler.getSnapshot();
assert.deepEqual({ ...snap.compile }, { ms: 12.5, programs: 9 });

// render例外相当の中断後も、warmupを1フレーム消化すればqueryを再開できる。
profiler.beginFrame(110);
profiler.beginRender(111);
assert.ok(gl.active, 'GPU query should be active during render');
const beginsBeforeAbort = gl.beginCount;
profiler.abortFrame();
assert.equal(gl.active, null, 'abortFrame must close the active GPU query');
profiler.beginFrame(120);
profiler.beginRender(121);
profiler.endFrame(124);
profiler.beginFrame(130);
profiler.beginRender(131);
assert.equal(gl.beginCount, beginsBeforeAbort + 1, 'GPU query should resume after abort warmup');
profiler.abortFrame();

// 品質切替直後のwarmupはsummaryへ混ぜない。
profiler.setQuality('mid', { warmupFrames: 2 });
for (let i = 0; i < 3; i++) {
  profiler.beginFrame(200 + i * 10);
  profiler.markUpdate(1);
  profiler.beginRender(202 + i * 10);
  profiler.endFrame(205 + i * 10);
}
snap = profiler.getSnapshot();
assert.equal(snap.summaries.mid.frames, 1);

const texture = { format: THREE.RedFormat, type: THREE.HalfFloatType };
const rt = { width: 10, height: 10, samples: 0, texture, depthBuffer: false };
const withoutShadow = profiler.estimateRtBytes({ water: { rt }, postfx: {} });
const shadow = { width: 20, height: 20, samples: 0, texture, depthBuffer: true };
const withShadow = profiler.estimateRtBytes({
  water: { rt }, postfx: {}, env: { sun: { shadow: { map: shadow } } },
});
assert.ok(withShadow > withoutShadow, 'shadow RT must contribute to estimate');

console.log('performance-test: ok');
