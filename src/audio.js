/* ===========================================================
   WebAudio による効果音・環境音（外部アセット不要の合成音）
   =========================================================== */
import { clamp, clamp01, rand } from './util.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.volume = 0.7;    // 効果音（SE）
    this.bgm = 0.7;       // 環境音（水・風・雨・虫）
    this._reelClickAt = 0;
    this._noise = null;
  }

  /** ユーザー操作後に呼ぶ */
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());

    // マスターチェーン: (SE / 環境音) -> master -> 水中フィルタ -> コンプ -> 出力
    this.master = ctx.createGain();
    this.master.gain.value = 1;

    // 2系統に分けて別々に音量調整できるようにする
    this.seBus = ctx.createGain();
    this.seBus.gain.value = this.volume;
    this.seBus.connect(this.master);

    this.bgmBus = ctx.createGain();
    this.bgmBus.gain.value = this.bgm;
    this.bgmBus.connect(this.master);

    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 4;

    this.master.connect(this.muffle);
    this.muffle.connect(comp);
    comp.connect(ctx.destination);

    // ノイズバッファ（使い回し）
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._noise = buf;

    this._buildAmbient();
    this.ready = true;
  }

  /** 効果音（SE）の音量 */
  setVolume(v) {
    this.volume = clamp01(v);
    if (this.seBus) this.seBus.gain.value = this.volume;
  }

  /** 環境音（雨・風・水・虫）の音量 */
  setBgm(v) {
    this.bgm = clamp01(v);
    if (this.bgmBus) this.bgmBus.gain.value = this.bgm;
  }

  /** 水中カメラ時の音の詰まり */
  setUnderwater(on) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.muffle.frequency.cancelScheduledValues(t);
    this.muffle.frequency.linearRampToValueAtTime(on ? 520 : 20000, t + 0.35);
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  /* ---------------- 環境音 ---------------- */
  _buildAmbient() {
    const ctx = this.ctx;

    // 水音（低域ノイズ + ゆらぎ）
    const water = ctx.createBufferSource();
    water.buffer = this._noise;
    water.loop = true;
    const wf = ctx.createBiquadFilter();
    wf.type = 'lowpass';
    wf.frequency.value = 420;
    wf.Q.value = 0.8;
    const wg = ctx.createGain();
    wg.gain.value = 0.08;          // 環境音は控えめに（従来の半分）
    water.connect(wf); wf.connect(wg); wg.connect(this.bgmBus);

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 230;
    lfo.connect(lfoG); lfoG.connect(wf.frequency);

    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 0.07;
    const lfo2G = ctx.createGain();
    lfo2G.gain.value = 0.03;
    lfo2.connect(lfo2G); lfo2G.connect(wg.gain);

    // 風
    const wind = ctx.createBufferSource();
    wind.buffer = this._noise;
    wind.loop = true;
    const bf = ctx.createBiquadFilter();
    bf.type = 'bandpass';
    bf.frequency.value = 620;
    bf.Q.value = 0.6;
    const bg = ctx.createGain();
    bg.gain.value = 0.025;
    wind.connect(bf); bf.connect(bg); bg.connect(this.bgmBus);
    const wlfo = ctx.createOscillator();
    wlfo.frequency.value = 0.05;
    const wlfoG = ctx.createGain();
    wlfoG.gain.value = 300;
    wlfo.connect(wlfoG); wlfoG.connect(bf.frequency);

    // 雨（強度で音量制御）
    const rainSrc = ctx.createBufferSource();
    rainSrc.buffer = this._noise;
    rainSrc.loop = true;
    const rf = ctx.createBiquadFilter();
    rf.type = 'highpass';
    rf.frequency.value = 1100;
    const rg = ctx.createGain();
    rg.gain.value = 0;
    rainSrc.connect(rf); rf.connect(rg); rg.connect(this.bgmBus);
    this.rainGain = rg;

    // 虫の声（夜）
    const nightG = ctx.createGain();
    nightG.gain.value = 0;
    nightG.connect(this.bgmBus);
    const cricket = ctx.createOscillator();
    cricket.type = 'triangle';
    cricket.frequency.value = 4200;
    const cg = ctx.createGain();
    cg.gain.value = 0.02;
    const trill = ctx.createOscillator();
    trill.type = 'square';
    trill.frequency.value = 22;
    const trillG = ctx.createGain();
    trillG.gain.value = 0.02;
    trill.connect(trillG); trillG.connect(cg.gain);
    cricket.connect(cg); cg.connect(nightG);
    this.nightGain = nightG;

    [water, wind, rainSrc].forEach((s) => s.start());
    [lfo, lfo2, wlfo, cricket, trill].forEach((o) => o.start());
  }

  setRain(intensity) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.rainGain.gain.cancelScheduledValues(t);
    this.rainGain.gain.linearRampToValueAtTime(clamp01(intensity) * 0.1, t + 0.8);
  }

  setNight(amount) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.nightGain.gain.cancelScheduledValues(t);
    this.nightGain.gain.linearRampToValueAtTime(clamp01(amount) * 0.25, t + 1.5);
  }

  /* ---------------- ワンショット ---------------- */
  _noiseBurst({ dur = 0.3, type = 'lowpass', f0 = 2000, f1 = 400, q = 1, gain = 0.3, delay = 0 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this._noise;
    src.playbackRate.value = rand(0.9, 1.1);
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + Math.min(0.03, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f); f.connect(g); g.connect(this.seBus);
    src.start(t, rand(0, 1));
    src.stop(t + dur + 0.05);
  }

  _tone({ freq = 440, dur = 0.2, type = 'sine', gain = 0.16, delay = 0, slideTo = null, attack = 0.008 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0006, t + dur);
    o.connect(g); g.connect(this.seBus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  cast(power = 1) {
    if (!this.ready) return;
    this._noiseBurst({ dur: 0.34, type: 'bandpass', f0: 500, f1: 2600, q: 1.1, gain: 0.16 + 0.14 * power });
  }

  charge() {
    if (!this.ready) return;
    this._tone({ freq: 220, dur: 0.08, type: 'triangle', gain: 0.05 });
  }

  splash(size = 1) {
    if (!this.ready) return;
    this._noiseBurst({ dur: 0.18 + 0.3 * size, type: 'lowpass', f0: 3600, f1: 260, gain: 0.16 + 0.2 * size });
    this._tone({ freq: 760 * rand(0.85, 1.15), dur: 0.16, type: 'sine', gain: 0.1 * size, slideTo: 180 });
  }

  bite() {
    if (!this.ready) return;
    this._tone({ freq: 880, dur: 0.1, type: 'square', gain: 0.1 });
    this._tone({ freq: 1320, dur: 0.14, type: 'square', gain: 0.09, delay: 0.09 });
  }

  nibble() {
    if (!this.ready) return;
    this._tone({ freq: 1500, dur: 0.05, type: 'sine', gain: 0.045 });
  }

  hookSet() {
    if (!this.ready) return;
    this._noiseBurst({ dur: 0.2, type: 'bandpass', f0: 1800, f1: 500, q: 2, gain: 0.2 });
    this._tone({ freq: 300, dur: 0.22, type: 'sawtooth', gain: 0.07, slideTo: 520 });
  }

  /** リールの巻き音（連続呼び出し可） */
  reelTick(rate = 1) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const interval = 0.075 / clamp(rate, 0.4, 2.4);
    if (now - this._reelClickAt < interval) return;
    this._reelClickAt = now;
    this._tone({ freq: rand(2000, 2600), dur: 0.028, type: 'square', gain: 0.035, attack: 0.001 });
  }

  drag() {
    if (!this.ready) return;
    this._tone({ freq: rand(1400, 1900), dur: 0.05, type: 'sawtooth', gain: 0.03, attack: 0.002 });
  }

  snap() {
    if (!this.ready) return;
    this._noiseBurst({ dur: 0.3, type: 'highpass', f0: 3000, f1: 900, gain: 0.34 });
    this._tone({ freq: 900, dur: 0.3, type: 'sawtooth', gain: 0.12, slideTo: 90 });
  }

  escape() {
    if (!this.ready) return;
    this._tone({ freq: 500, dur: 0.4, type: 'triangle', gain: 0.1, slideTo: 160 });
  }

  catchFanfare(rarity = 1) {
    if (!this.ready) return;
    const scale = [523.25, 659.25, 783.99, 1046.5, 1318.5];
    const n = Math.min(5, 2 + rarity);
    for (let i = 0; i < n; i++) {
      this._tone({ freq: scale[i], dur: 0.34, type: 'triangle', gain: 0.12, delay: i * 0.075 });
    }
    if (rarity >= 4) {
      this._tone({ freq: 1568, dur: 0.9, type: 'sine', gain: 0.1, delay: n * 0.075 });
      this._noiseBurst({ dur: 0.8, type: 'highpass', f0: 5000, f1: 2000, gain: 0.07, delay: n * 0.075 });
    }
    this.splash(0.5);
  }

  levelUp() {
    if (!this.ready) return;
    [523.25, 698.46, 880, 1174.7].forEach((f, i) =>
      this._tone({ freq: f, dur: 0.3, type: 'square', gain: 0.07, delay: i * 0.09 })
    );
  }

  click() {
    if (!this.ready) return;
    this._tone({ freq: 620, dur: 0.05, type: 'square', gain: 0.05 });
  }

  buy() {
    if (!this.ready) return;
    this._tone({ freq: 900, dur: 0.09, type: 'triangle', gain: 0.09 });
    this._tone({ freq: 1350, dur: 0.16, type: 'triangle', gain: 0.08, delay: 0.07 });
  }

  deny() {
    if (!this.ready) return;
    this._tone({ freq: 220, dur: 0.16, type: 'square', gain: 0.06, slideTo: 140 });
  }

  step() {
    if (!this.ready) return;
    this._noiseBurst({ dur: 0.1, type: 'lowpass', f0: 900, f1: 200, gain: 0.055 });
  }
}
