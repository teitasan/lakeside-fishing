/* ===========================================================
   ゲーム本体：状態機械・キャスト・ファイト・進行
   =========================================================== */
import * as THREE from 'three';
import { Environment } from './sky.js';
import { Terrain } from './terrain.js';
import { resolveLake } from './lakefield.js';
import { Water } from './water.js';
import { FishSchool } from './fish.js';
import { Angler } from './angler.js';
import { UI } from './ui.js';
import { Debug } from './debug.js';
import { AudioEngine } from './audio.js';
import * as Save from './save.js';
import {
  REAL_FISH, JUNK, GEAR, ACHIEVEMENTS,
  weightOf, valueOf, xpOf, rollLength, fightPattern,
} from './data.js';
import {
  clamp, clamp01, lerp, damp, rand, pick, weightedPick, TAU, timeBand, fmt1,
} from './util.js';

const GRAVITY = 9.8;
const EXPOSURE = 0.78;
const PLAYER_RADIUS = 0.34;
/* キャストの狙い */
const CAST_SPEED_MIN = 4.5;    // 最弱キャストの初速（足元 4〜5m を狙える）
const CAST_SPEED_MAX = 28.5;
const AIM_MAX = 50;            // 照準が届く最大距離
const CAST_TOL = 0.06;         // 目印に合っていると見なすパワーの許容差
const HOURS_PER_SEC = 24 / 720;   // 実時間12分で1日
const MAX_LINE = 62;
const EYE_H = 1.62;

/** 湖を作り直して再読み込みした直後は、タイトルを飛ばして再開する */
export const AUTOSTART_KEY = 'lakeside-fishing-autostart';

/**
 * 引きの強さの表示（魚種・レア度は伏せ、手応えだけを伝える）
 * pull0 = 種の str × サイズ係数 なので、大きなコモンも「重い」になる
 */
function pullLabel(pull0) {
  if (pull0 < 0.55) return '軽い引き';
  if (pull0 < 1.0) return 'まずまずの引き';
  if (pull0 < 1.6) return '強い引き！';
  if (pull0 < 2.4) return 'かなり重い…！';
  return 'とてつもない重さ…！';
}

const BAIT_COLORS = {
  worm: 0xb9614c, dough: 0xe4d6b4, minnow: 0xa9bcc8, spoon: 0xd7d2b4,
  frog: 0x6e9b46, crank: 0xcf5a42, secret: 0xd9c274,
};

const UP = new THREE.Vector3(0, 1, 0);
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.bootedWithSave = Save.hasSave();
    this.state = Save.load();
    this.audio = new AudioEngine();
    this.playing = false;
    this.time = 0;
    this.hudDepth = 0;

    /* --- 入力 --- */
    this.keys = new Set();
    this.actionHeld = false;
    this.locked = false;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.rmb = false;

    /* --- プレイヤー --- */
    this.pos = new THREE.Vector3();
    this.visY = 0;
    this.yaw = 0;
    this.pitch = -0.12;
    this.moveAmt = 0;
    this.underwaterCam = false;
    this.camDist = 4.6;

    /* --- 釣り --- */
    this.fs = 'idle'; // idle|charge|flight|wait|nibble|bite|fight|landing|card
    this.charge = 0;
    this.chargeDir = 1;
    this.castPower = 0;
    this.castPerfect = false;
    this.bobber = new THREE.Vector3();
    this.bobberVel = new THREE.Vector3();
    this.bobberOffset = 0;
    this.castOrigin = new THREE.Vector3();
    this.castDist = 0;
    this.biteTimer = 0;
    this.hookFish = null;
    this.fight = null;
    this.retrieving = false;
    this.stateTime = 0;
    this.lastStepAt = 0;
    this.baitPos = new THREE.Vector3();
    this.approachT = 0;
  }

  /* =========================================================
     構築
     ========================================================= */
  async build(onProgress) {
    const q = this.state.settings.quality;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: q !== 'low', powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q === 'high' ? 2 : 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = EXPOSURE;
    this.renderer.shadowMap.enabled = this.state.settings.shadow;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 3000);
    this.camera.position.set(0, 5, 0);

    await onProgress('空を描いています');
    this.env = new Environment(this.scene, { exposure: EXPOSURE });
    this.env.setQuality(q);

    await onProgress('湖と山を生成しています');
    // シードを決めて、遊べる湖になるまで検証してから採用する
    const wantSeed = (this.state.settings.randomLake || !this.state.seed)
      ? Save.randomLakeSeed() : this.state.seed;
    const resolved = resolveLake(wantSeed);
    this.lake = resolved.lake;
    this.lakeStats = resolved.stats;
    this.lakeTries = resolved.tries;
    if (this.state.seed !== resolved.seed) {
      this.state.seed = resolved.seed;
      Save.saveNow(this.state);
    }
    this.terrain = new Terrain(this.scene, { quality: q, lake: resolved.lake });

    await onProgress('水を注いでいます');
    this.water = new Water(this.scene, this.terrain, { quality: q, exposure: EXPOSURE });

    await onProgress('魚を放しています');
    this.school = new FishSchool(this.scene, this.terrain, this.water, {
      count: q === 'low' ? 14 : q === 'high' ? 30 : 22,
    });

    this.angler = new Angler(this.scene);

    // キャスト予測マーカー
    const ringGeo = new THREE.RingGeometry(0.86, 1.12, 40);
    ringGeo.rotateX(-Math.PI / 2);
    this.marker = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: 0xffe98a, transparent: true, opacity: 0.9, depthWrite: false, fog: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }));
    this.marker.visible = false;
    this.marker.renderOrder = 6;
    this.scene.add(this.marker);

    // 狙い点のリング（照準が水面と交わる位置）
    const aimGeo = new THREE.RingGeometry(0.5, 0.66, 32);
    aimGeo.rotateX(-Math.PI / 2);
    this.aimMarker = new THREE.Mesh(aimGeo, new THREE.MeshBasicMaterial({
      color: 0x9ff0ff, transparent: true, opacity: 0.5, depthWrite: false, fog: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }));
    this.aimMarker.visible = false;
    this.aimMarker.renderOrder = 6;
    this.scene.add(this.aimMarker);

    this.ui = new UI(this);
    this.debug = new Debug(this);
    this._bindInput();

    // 初期位置（桟橋の先端）
    this.pos.copy(this.terrain.spawnPos);
    this.visY = this.pos.y;
    this.yaw = Math.atan2(this.terrain.dockDir.x, this.terrain.dockDir.z);
    this.angler.setPosition(this.pos.x, this.pos.y, this.pos.z);
    this.angler.setYaw(this.yaw);

    this.school.populate(this.pos, (d) => this.rollSpecies(d));
    if (this.state.settings.debug) this.debug.setEnabled(true);
    this._updateCamera(0.016, true);
    this.renderer.compile(this.scene, this.camera);
    await onProgress('準備完了');
  }

  /* =========================================================
     入力
     ========================================================= */
  _bindInput() {
    const c = this.canvas;

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    c.addEventListener('mousedown', (e) => {
      if (!this.playing || this.ui.isBlocking()) return;
      if (e.button === 2) { this.rmb = true; return; }
      if (!this.locked && document.pointerLockElement !== c) {
        const p = c.requestPointerLock();
        if (p && p.catch) p.catch(() => {});
        return;
      }
      if (e.button === 0) this._actionDown();
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.rmb = false;
      if (e.button === 0 && this.actionHeld) this._actionUp();
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === c;
      document.body.classList.toggle('aiming-off', !this.locked && !this.playing);
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.playing) return;
      if (this.locked || this.rmb) {
        this.mouseDX += e.movementX || 0;
        this.mouseDY += e.movementY || 0;
      }
    });

    window.addEventListener('wheel', (e) => {
      if (!this.playing || this.ui.isBlocking()) return;
      this.camDist = clamp(this.camDist + Math.sign(e.deltaY) * 0.5, 1.6, 9);
    }, { passive: true });

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') e.preventDefault();
      if (e.repeat) return;

      // デバッグ表示はどの状態でも切り替えられる
      if (e.code === 'F3' || (e.code === 'Backquote' && !this.ui.isBlocking())) {
        e.preventDefault();
        this.debug.toggle();
        return;
      }

      // モーダル中の処理
      if (this.ui.openModal === 'catch') {
        if (e.code === 'Space' || e.code === 'Enter' || e.code === 'Escape') this.dismissCatch();
        return;
      }
      if (this.ui.isBlocking()) {
        if (e.code === 'Escape' || e.code === 'KeyQ' || e.code === 'KeyB') this.ui.closeAll();
        return;
      }
      if (!this.playing) {
        if (e.code === 'Space' || e.code === 'Enter') this.start(Save.hasSave());
        return;
      }

      this.keys.add(e.code);
      switch (e.code) {
        case 'Space': this._actionDown(); break;
        case 'KeyQ': this._cancelCharge(); this._exitLock(); this.ui.openJournal(); this.audio.click(); break;
        case 'KeyB': this._cancelCharge(); this._exitLock(); this.ui.openShop(); this.audio.click(); break;
        case 'Escape': this._cancelCharge(); this._exitLock(); this.ui.openPause(); break;
        case 'KeyV': this._toggleUnderwater(); break;
        case 'KeyM': {
          const s = this.state.settings;
          // 効果音と環境音の両方をまとめてミュート／復帰
          const muted = s.volume <= 0 && (s.bgm ?? 0) <= 0;
          if (muted) {
            s.volume = this._preMute?.volume ?? 0.7;
            s.bgm = this._preMute?.bgm ?? 0.7;
          } else {
            this._preMute = { volume: s.volume, bgm: s.bgm ?? 0.7 };
            s.volume = 0;
            s.bgm = 0;
          }
          this.audio.setVolume(s.volume);
          this.audio.setBgm(s.bgm);
          document.getElementById('opt-volume').value = s.volume * 100;
          document.getElementById('opt-bgm').value = s.bgm * 100;
          this.ui.toast(muted ? '🔊 音を戻した' : '🔇 ミュート');
          this.saveState();
          break;
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Space' && this.actionHeld) this._actionUp();
    });

    window.addEventListener('blur', () => {
      this.keys.clear();
      if (this.actionHeld) this._actionUp();
    });
  }

  _exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /* =========================================================
     開始 / セーブ
     ========================================================= */
  start(useSave) {
    if (!useSave) {
      // 設定は引き継ぎつつ、同じオブジェクトのまま初期化（UI の参照を保つ）
      const keep = this.state.settings;
      Object.assign(this.state, Save.defaultState(), { settings: keep });
      if (this.bootedWithSave) {
        // 既存セーブの湖で起動していたので、新しい湖を引き直して作り直す
        this._reloadWithLake(Save.randomLakeSeed());
        return;
      }
      this.state.seed = this.lake.seed;   // 起動時に引いた湖をそのまま使う
      Save.saveNow(this.state);
    }
    this.audio.init();
    this.audio.setVolume(this.state.settings.volume);
    this.audio.setBgm(this.state.settings.bgm ?? 0.7);
    this.audio.resume();
    this.playing = true;
    document.body.classList.add('playing');
    this.ui.el.title.classList.remove('open');
    this.ui.toast('湖へようこそ。まずは<b>クリック長押し</b>でキャスト！', 'gold');
    setTimeout(() => {
      if (this.playing && !this.ui.isBlocking()) {
        const p = this.canvas.requestPointerLock();
        if (p && p.catch) p.catch(() => {});
      }
    }, 200);
  }

  saveState() { Save.save(this.state); }

  resetSave() {
    Save.wipe();
    location.reload();
  }

  /* =========================================================
     湖（シード）
     ========================================================= */
  /** シードを保存して再読み込み。復帰後はタイトルを飛ばしてそのまま再開する */
  _reloadWithLake(seed) {
    this.state.seed = seed >>> 0;
    Save.saveNow(this.state);
    try { sessionStorage.setItem(AUTOSTART_KEY, '1'); } catch (e) { /* noop */ }
    location.reload();
  }

  /** シードを指定して湖を作り直す（再読み込み） */
  setLakeSeed(seed) {
    const n = Math.floor(Number(seed));
    if (!Number.isFinite(n) || n < 1 || n > 0xffffffff) {
      this.ui.toast('シードは 1〜4294967295 の数値で指定してください', 'bad');
      this.audio.deny();
      return false;
    }
    this._reloadWithLake(n);
    return true;
  }

  newRandomLake() { return this.setLakeSeed(Save.randomLakeSeed()); }

  /** ポーズ画面に出す、いまの湖の要約 */
  lakeInfo() {
    const S = this.lakeStats || {};
    const d = this.terrain.dockEnd, dir = this.terrain.dockDir;
    const rightX = -dir.z, rightZ = dir.x;
    const dirOf = (p) => {
      const vx = p.x - d.x, vz = p.z - d.z;
      const fwd = vx * dir.x + vz * dir.z;
      const side = vx * rightX + vz * rightZ;
      const dist = Math.hypot(vx, vz);
      const lr = side > 0 ? '右' : '左';
      const fb = fwd > dist * 0.35 ? '前方' : fwd < -dist * 0.35 ? '後方' : '真横';
      return `${lr}${fb} ${Math.round(dist)}m`;
    };
    return {
      seed: this.state.seed,
      tries: this.lakeTries || 1,
      dockDepth: S.dockTipDepth,
      holeDepth: S.holeDepth,
      holeWhere: dirOf(this.terrain.hole),
      flatDepth: S.flatDepth,
      flatWhere: dirOf(this.terrain.flat),
      shoreR: S.shoreR0,
      minDepth: S.minDepth,
      maxDepth: S.maxDepth,
    };
  }

  rest() {
    if (this.fs !== 'idle') {
      this.ui.toast('仕掛けを回収してから休みましょう', 'bad');
      this.audio.deny();
      return;
    }
    this.state.clock = (this.state.clock + 1) % 24;
    this.env.tickWeather(1.2);
    this.audio.click();
    this.ui.toast(`🍵 ひと休み… ${Math.floor(this.state.clock)}時になった`, 'good');
    this.saveState();
  }

  applyQuality() {
    const q = this.state.settings.quality;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q === 'high' ? 2 : q === 'low' ? 1 : 1.5));
    this.renderer.shadowMap.enabled = this.state.settings.shadow;
    this.env.setQuality(q);
    this.school.setCount(q === 'low' ? 14 : q === 'high' ? 30 : 22);
    this.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  }

  /* =========================================================
     装備
     ========================================================= */
  get rod() { return GEAR.rod.find((r) => r.id === this.state.gear.rod) || GEAR.rod[0]; }
  get line() { return GEAR.line.find((r) => r.id === this.state.gear.line) || GEAR.line[0]; }
  get bait() { return GEAR.bait.find((r) => r.id === this.state.gear.bait) || GEAR.bait[0]; }

  buy(kind, id) {
    const item = GEAR[kind].find((x) => x.id === id);
    if (!item) return false;
    if (this.state.level < item.level) { this.audio.deny(); return false; }
    if (this.state.money < item.price) {
      this.ui.toast('お金が足りません', 'bad');
      this.audio.deny();
      return false;
    }
    this.state.money -= item.price;
    this.state.owned[kind].push(item.id);
    this.state.gear[kind] = item.id;
    this.audio.buy();
    this.ui.toast(`${item.icon} <b>${item.name}</b> を購入しました！`, 'gold');
    this.saveState();
    return true;
  }

  equip(kind, id) {
    if (!this.state.owned[kind].includes(id)) return;
    this.state.gear[kind] = id;
    this.audio.click();
    const item = GEAR[kind].find((x) => x.id === id);
    this.ui.toast(`${item.icon} ${item.name} を装備`, 'good');
    this.saveState();
  }

  /* =========================================================
     魚種の抽選
     ========================================================= */
  baitAffinity(sp) {
    const aff = this.bait.aff;
    let sum = 0, n = 0;
    for (const t of sp.tags) {
      if (aff[t] !== undefined) { sum += aff[t]; n++; }
    }
    if (!n) return 1;
    return sum / n;
  }

  /** 水深 depth の場所に居そうな魚を抽選 */
  rollSpecies(depth, opts = {}) {
    const band = timeBand(this.state.clock);
    const wk = this.env.weather.key;
    const useBait = !!opts.bait;
    const bait = this.bait;
    const baitDepth = opts.baitDepth ?? 0;

    return weightedPick(REAL_FISH, (sp) => {
      let w = sp.spawn;
      if (w <= 0) return 0;
      const [d0, d1] = sp.depth;
      if (depth < d0 * 0.55) return 0;
      // 水深適合
      const fit = depth >= d0 && depth <= d1 + 3 ? 1 : depth > d1 ? 0.18 : 0.09;
      w *= fit;
      w *= sp.times[band] ?? 1;
      w *= sp.weather[wk] ?? 1;
      if (useBait) {
        w *= this.baitAffinity(sp);
        // 餌の層と魚の層の一致
        const mid = (d0 + d1) / 2;
        const spread = Math.max(2.5, (d1 - d0) * 0.75);
        w *= 0.14 + 1.4 * Math.exp(-((baitDepth - mid) ** 2) / (2 * spread * spread));
        if (sp.rarity >= 3) w *= bait.rare;
        w *= this.rod.attract;
        // 序盤に強すぎる魚が来て理不尽にならないよう、レベルで解禁
        const lv = this.state.level;
        if (sp.rarity === 4) w *= clamp01((lv - 2) / 5);
        if (sp.rarity === 5) w *= clamp01((lv - 5) / 6);
      }
      return w;
    });
  }

  /* =========================================================
     アクション（クリック / スペース）
     ========================================================= */
  _actionDown() {
    if (this.actionHeld) return;
    this.actionHeld = true;
    this.audio.resume();

    switch (this.fs) {
      case 'idle':
        this.fs = 'charge';
        this.charge = 0;
        this.chargeDir = 1;
        this.stateTime = 0;
        this.audio.charge();
        break;
      case 'wait':
      case 'nibble':
        this._retrieve();
        break;
      case 'bite':
        this._setHook();
        break;
      default:
        break;
    }
  }

  _actionUp() {
    this.actionHeld = false;
    if (this.ui.isBlocking()) return;      // メニュー中は発射しない
    if (this.fs === 'charge') this._releaseCast();
  }

  /** ため動作を取り消す（メニューを開いた時など） */
  _cancelCharge() {
    if (this.fs !== 'charge') return;
    this.fs = 'idle';
    this.charge = 0;
    this.chargeDir = 1;
    this.castObstruction = null;
    this.marker.visible = false;
    this.ui.showPower(false);
    this.ui.setPrompt('');
  }

  /* ---------------- キャスト ---------------- */
  _aimDir(out = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch);
    return out.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
  }

  _castVelocity(power, out = new THREE.Vector3()) {
    this._aimDir(out);
    out.y = 0;
    if (out.lengthSq() < 1e-6) out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    out.normalize();
    const elev = clamp(0.46 + this.pitch * 0.55, 0.16, 0.95);
    out.y = elev;
    out.normalize();
    return out.multiplyScalar(lerp(CAST_SPEED_MIN, CAST_SPEED_MAX, power));
  }

  /**
   * あるパワーで水面（y=0）に落ちるまでの水平距離。
   * 地形サンプルを使わない軽量版で、目印の逆算に使う。
   */
  _rangeForPower(power) {
    this._castVelocity(power, _v4);
    let vx = Math.hypot(_v4.x, _v4.z);
    let vy = _v4.y;
    let x = 0, y = this._tipY || 3;
    const dt = 0.055;
    for (let i = 0; i < 200 && y > 0; i++) {
      vy -= GRAVITY * dt;
      const k = 1 - 0.0055 * Math.hypot(vx, vy) * dt;
      vx *= k; vy *= k;
      x += vx * dt; y += vy * dt;
    }
    return x;
  }

  /**
   * 狙い距離（プレイヤー基準）に必要なパワーを二分探索で求める。
   * _rangeForPower はロッド先端からの距離なので、先端の前方オフセットを引く。
   */
  _solveTargetPower(aimDist) {
    const want = aimDist - (this._tipFwd || 0);
    let lo = 0, hi = 1;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (this._rangeForPower(mid) < want) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /**
   * 狙い点（照準が水面と交わる位置）・必要パワー・最短距離を更新。
   * 見下ろすほど近く、水平に近いほど遠くなる。
   */
  _updateAim(force = false) {
    if (!this.aimPoint) this.aimPoint = new THREE.Vector3();
    // ロッド先端（スカラーで退避：_v4 はこの後使い回す）
    this.angler.getRodTip(_v4);
    const tipX = _v4.x, tipZ = _v4.z;
    this._tipY = _v4.y;
    // 狙い方向
    const dir = this._aimDir(_v4);
    const dirY = dir.y;
    const h = Math.hypot(dir.x, dir.z) || 1e-4;
    const fx = dir.x / h, fz = dir.z / h;
    this._tipFwd = (tipX - this.pos.x) * fx + (tipZ - this.pos.z) * fz;
    this.minCastDist = this._rangeForPower(0) + this._tipFwd;

    const eyeY = this.visY + EYE_H;
    let dist = AIM_MAX;
    if (dirY < -0.02) dist = h * (-eyeY / dirY);   // 視線が y=0 に達する距離
    dist = clamp(dist, this.minCastDist, AIM_MAX);
    this.aimDist = dist;
    this.aimPoint.set(this.pos.x + fx * dist, 0, this.pos.z + fz * dist);

    if (force || Math.abs(dist - (this._solvedFor ?? -1)) > 0.3) {
      this._solvedFor = dist;
      this.targetPower = clamp(this._solveTargetPower(dist), 0, 1);
    }
    return dist;
  }

  /** 着水点を予測（描画マーカー用） */
  _predictLanding(power, out = new THREE.Vector3()) {
    this.angler.getRodTip(_v1);
    _v2.copy(_v1);
    this._castVelocity(power, _v3);
    // マーカー用の概算なので、水面は y=0 とみなして地形サンプルを半分に減らす
    const dt = 0.055;
    for (let i = 0; i < 160; i++) {
      _v3.y -= GRAVITY * dt;
      _v3.multiplyScalar(1 - 0.055 * dt * _v3.length() * 0.1);
      _v2.addScaledVector(_v3, dt);
      const ground = this.terrain.heightAt(_v2.x, _v2.z);
      if (_v2.y <= (ground < 0 ? 0 : ground)) break;
      if (_v2.distanceTo(_v1) > MAX_LINE) break;
    }
    return out.copy(_v2);
  }

  _releaseCast() {
    this._updateAim(true);
    // 目印（狙った距離に必要なパワー）に合っていれば「狙い通り」
    const target = this.targetPower ?? 0.78;
    const err = Math.abs(this.charge - target);
    this.castPerfect = err <= CAST_TOL;
    // 合っていれば小さな誤差を補正して、狙い点にきっちり落とす
    const power = this.castPerfect ? target : this.charge;
    this.castPower = power;
    this.charge = power;
    this.fs = 'flight';
    this.stateTime = 0;
    this.angler.playCast();
    this.audio.cast(power);
    this.angler.getRodTip(this.bobber);
    this.castOrigin.copy(this.bobber);
    this._castVelocity(power, this.bobberVel);
    this.angler.bobber.visible = true;
    this.angler.baitMat.color.setHex(BAIT_COLORS[this.bait.id] ?? 0xc2705a);
    this.marker.visible = false;
    this.aimMarker.visible = false;
    this.ui.showPower(false);
    if (this.castPerfect) {
      this.ui.toast(`✨ 狙い通り！ <small style="opacity:.75">${fmt1(this.aimDist)}m</small>`, 'good');
    } else {
      const over = this.charge > (this.targetPower ?? 0.78);
      this.ui.toast(over ? '飛ばし過ぎた…' : '手前に落ちた…', '');
    }
  }

  /** ロッド先端 → 到達点 の糸が桟橋を貫通するか */
  _lineHitsDock(tip, end) {
    return this.terrain.dockBlocksSegment(tip.x, tip.y, tip.z, end.x, end.y, end.z);
  }

  /**
   * 糸が何かを貫通しているか。'dock' | 'terrain' | 'rock' | null
   * 桟橋・陸の張り出し・岩を同じ枠組みで扱う。
   */
  lineObstruction(tip, end, slack = 0.5) {
    if (this._lineHitsDock(tip, end)) return 'dock';
    const hit = this.terrain.lineBlocked(tip.x, tip.y, tip.z, end.x, end.y, end.z, { slack });
    return hit ? hit.kind : null;
  }

  _snagOnDock(msg) {
    this.ui.toast(msg, 'bad');
    this.audio.deny();
    this._retrieve();
  }

  /** 障害の種類に応じたメッセージで回収 */
  _snagLine(kind) {
    const msg = kind === 'dock' ? '桟橋に糸が掛かった…回収します'
      : kind === 'rock' ? '岩に糸が掛かった…回収します'
        : '陸に糸が掛かった…回収します';
    this._snagOnDock(msg);
  }

  /* ---------------- 回収 ---------------- */
  _retrieve() {
    if (this.hookFish) {
      this.hookFish.state = 'flee';
      this.hookFish.timer = 2.2;
      this.hookFish = null;
    }
    this.retrieving = true;
    this.fs = 'flight';
    this.stateTime = 0;
    this.bobberVel.set(0, 0, 0);
  }

  /* ---------------- アワセ ---------------- */
  _setHook() {
    const f = this.hookFish;
    if (!f) return;
    this.audio.hookSet();
    const sp = f.species;
    f.state = 'hooked';
    const sizeF = 0.55 + (f.length / sp.len[1]) * 0.75;
    const pattern = fightPattern(sp);
    this.fight = {
      dist: 0.88,
      tension: 0,
      stamina: 1,
      runTimer: rand(1.4, 3.2) * pattern.runGap,
      running: false,
      runDur: 0,
      lateral: 0,
      sizeF,
      pull0: sp.str * sizeF,
      time: 0,
      jumps: 0,
      pattern,
      jumpQueued: 0,   // 走りの途中で跳ねるまでの秒数
      jumpT: 0,        // 跳ねている残り時間
      shakeT: rand(0.6, 1.3),
      shakeOn: false,
      shakeAge: 0,
    };
    this.fs = 'fight';
    this.stateTime = 0;
    this.water.addSplash(this.bobber.x, this.water.surfaceY(this.bobber.x, this.bobber.z), this.bobber.z, 14, 1.0);
    this.water.addRipple(this.bobber.x, this.bobber.z, 1.1, 1.4);
    // レア度ではなく「手応え」と「ファイトの型」で知らせる（種は取り込むまで伏せる）
    const heavy = this.fight.pull0;
    this.ui.toast(
      `ヒット！ <b>${heavy >= 2.0 ? '重い…！' : heavy >= 1.2 ? 'ぐんと重い！' : '掛かった！'}</b>`
      + `<small style="opacity:.75"> — ${pattern.hint}</small>`,
      heavy >= 2.0 ? 'gold' : 'good'
    );
  }

  /* =========================================================
     メインループ
     ========================================================= */
  update(dt) {
    dt = Math.min(dt, 0.1); // 極端に重い環境でも破綻しない範囲でスロー化を抑える

    // メニュー（ポーズ・ショップ・図鑑）を開いている間は世界を止める。
    // 止めないと、ため中にメニューを開いてもキャストが進み、
    // ボタンを離した瞬間にメニュー越しに発射されてしまう。
    const paused = this.playing && this.ui.isBlocking() && this.ui.openModal !== 'catch';
    const sdt = paused ? 0 : dt;
    this.time += sdt;

    if (this.playing && !paused) {
      this.state.clock = (this.state.clock + dt * HOURS_PER_SEC) % 24;
      const changed = this.env.tickWeather(dt * HOURS_PER_SEC);
      if (changed) this.ui.toast(`${changed.icon} 天候が「${changed.name}」に変わった`);
    }

    if (!paused) {
      this._updateLook(dt);
      this._updateMove(dt);
      this._updateFishing(dt);
    }
    this._updateCamera(sdt);

    this.env.update(sdt, this.state.clock, this.camera, this.pos);
    this.terrain.updateLamp(this.env.nightAmount, sdt);
    this.water.update(sdt, this.camera, this.env);

    this.audio.setRain(this.env.rainIntensity);
    this.audio.setNight(this.env.nightAmount);

    // 魚群（ポーズ中は入れ替えも止める）
    if (!paused) this.school.update(dt, {
      water: this.water,
      terrain: this.terrain,
      time: this.time,
      center: this.pos,
      bait: this.baitPos,
      rollSpecies: (d) => this.rollSpecies(d),
      onSplash: (f) => {
        if (f.pos.distanceTo(this.camera.position) < 60) this.audio.splash(0.6);
      },
    });

    // 釣り人
    const fightT = this.fight ? clamp01(this.fight.tension / this.line.cap) : 0;
    this.angler.pitch = this.pitch;
    this.angler.update(dt, {
      state: this.fs === 'charge' ? 'charge'
        : this.fs === 'fight' ? 'fight'
          : this.fs === 'landing' || this.fs === 'card' ? 'landed'
            : this.fs === 'wait' || this.fs === 'nibble' || this.fs === 'bite' ? 'wait'
              : this.fs === 'flight' ? 'flight' : 'idle',
      charge: this.charge,
      tension: fightT,
      moving: this.moveAmt,
      reeling: this.fs === 'fight' && this.actionHeld,
      time: this.time,
    });

    this.ui.updateHUD(this);
    this.renderer.render(this.scene, this.camera);
    this.debug.update(dt);
  }

  /* ---------------- 視点 ---------------- */
  _updateLook(dt) {
    const sens = 0.0022 * this.state.settings.sens;
    if (this.mouseDX || this.mouseDY) {
      this.yaw -= this.mouseDX * sens;
      this.pitch = clamp(this.pitch - this.mouseDY * sens, -1.15, 0.7);
      this.mouseDX = 0;
      this.mouseDY = 0;
    }
    if (this.yaw > Math.PI) this.yaw -= TAU;
    if (this.yaw < -Math.PI) this.yaw += TAU;
    this.angler.setYaw(this.yaw);
  }

  /* ---------------- 移動 ---------------- */
  _updateMove(dt) {
    let mx = 0, mz = 0;
    if (this.playing && !this.ui.isBlocking()) {
      if (this.keys.has('KeyW')) mz += 1;
      if (this.keys.has('KeyS')) mz -= 1;
      if (this.keys.has('KeyA')) mx -= 1;
      if (this.keys.has('KeyD')) mx += 1;
    }
    const len = Math.hypot(mx, mz);
    let target = 0;
    if (len > 0) {
      mx /= len; mz /= len;
      const run = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
      let speed = run ? 6.2 : 3.1;
      if (this.fs === 'fight') speed *= 0.42;
      else if (this.fs !== 'idle') speed *= 0.75;

      // 前方 = (sin yaw, cos yaw) / 右 = (-cos yaw, sin yaw)
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
      const dx = (mz * sy - mx * cy) * speed * dt;
      const dz = (mz * cy + mx * sy) * speed * dt;
      if (this._tryMove(this.pos.x + dx, this.pos.z + dz)) target = run ? 1 : 0.6;
      else if (this._tryMove(this.pos.x + dx, this.pos.z)) target = 0.5;
      else if (this._tryMove(this.pos.x, this.pos.z + dz)) target = 0.5;

      // 足音
      if (target > 0 && this.time - this.lastStepAt > (run ? 0.32 : 0.52)) {
        this.lastStepAt = this.time;
        this.audio.step();
      }
    }
    this.moveAmt = damp(this.moveAmt, target, 8, dt);

    // 立ち位置の高さ
    const dockY = this.terrain.onDock(this.pos.x, this.pos.z);
    const groundY = dockY !== null ? dockY : this.terrain.heightAt(this.pos.x, this.pos.z);
    this.pos.y = groundY;
    this.visY = damp(this.visY, groundY, 14, dt);
    this.angler.setPosition(this.pos.x, this.visY, this.pos.z);
  }

  _tryMove(nx, nz) {
    if (Math.hypot(nx, nz) > 460) return false;
    if (this.terrain.blockedAt(nx, nz, PLAYER_RADIUS)) return false;   // 岩・木・灯篭・小舟
    const dock = this.terrain.onDock(nx, nz);
    if (dock !== null) { this.pos.x = nx; this.pos.z = nz; return true; }
    const h = this.terrain.heightAt(nx, nz);
    if (h < -0.55) return false;               // 深くて入れない
    if (h > 0.6 && this.terrain.slopeAt(nx, nz) > 1.5) return false; // 崖
    // 桟橋から降りる時の段差
    const cur = this.terrain.onDock(this.pos.x, this.pos.z);
    if (cur !== null && h < cur - 1.9) return false;
    this.pos.x = nx; this.pos.z = nz;
    return true;
  }

  /* ---------------- カメラ ---------------- */
  _updateCamera(dt, snap = false) {
    const cam = this.camera;

    // タイトル中はゆっくり周回するアトラクトカメラ
    if (!this.playing) {
      const a = this.time * 0.045 + 1.2;
      const c = this.terrain.dockEnd;
      cam.position.set(c.x + Math.cos(a) * 17, 4.2 + Math.sin(this.time * 0.2) * 0.5, c.z + Math.sin(a) * 17);
      _v1.set(c.x + this.terrain.dockDir.x * 5, 1.1, c.z + this.terrain.dockDir.z * 5);
      cam.lookAt(_v1);
      return;
    }

    if (this.underwaterCam && (this.fs === 'wait' || this.fs === 'nibble' || this.fs === 'bite' || this.fs === 'fight')) {
      // 水中カメラ：ウキの周りを見る
      const b = this.bobber;
      const depth = this.terrain.depthAt(b.x, b.z);
      const surf = this.water.surfaceY(b.x, b.z);
      const targetY = clamp(this.baitY - 0.15, -depth + 0.5, surf - 0.35);
      const ang = this.time * 0.12;
      _v1.set(b.x + Math.cos(ang) * 2.3, targetY + 1.0, b.z + Math.sin(ang) * 2.3);
      cam.position.lerp(_v1, snap ? 1 : 1 - Math.exp(-3 * dt));
      _v2.set(b.x, this.baitY - 0.05, b.z);
      cam.lookAt(_v2);
      this._setUnderwaterFx(cam.position.y < this.water.surfaceY(cam.position.x, cam.position.z));
      return;
    }

    const dir = this._aimDir(_v1);
    const pivotY = this.visY + EYE_H;
    // 肩越し（右肩側にずらす）
    const right = _v2.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const pivot = _v3.set(this.pos.x, pivotY, this.pos.z).addScaledVector(right, 0.42);

    let dist = this.camDist;
    if (this.fs === 'fight') dist = this.camDist * 0.82;
    const want = pivot.clone().addScaledVector(dir, -dist);
    want.y += 0.35;

    // 地面/水面にめり込まないように
    const gh = this.terrain.heightAt(want.x, want.z);
    const wh = gh < 0 ? this.water.surfaceY(want.x, want.z) : gh;
    const minY = Math.max(gh + 0.45, wh + 0.35);
    if (want.y < minY) want.y = minY;

    if (snap) cam.position.copy(want);
    else cam.position.lerp(want, 1 - Math.exp(-14 * dt));

    // 注視点
    const look = pivot.clone().addScaledVector(dir, 12);
    if (this.fs === 'fight' && this.hookFish) {
      look.lerp(this.hookFish.pos, 0.35);
      // 手ブレ
      const t = clamp01(this.fight.tension / this.line.cap);
      cam.position.x += Math.sin(this.time * 31) * 0.012 * t;
      cam.position.y += Math.sin(this.time * 27) * 0.012 * t;
    } else if (this.fs === 'flight' || this.fs === 'wait' || this.fs === 'nibble' || this.fs === 'bite') {
      look.lerp(this.bobber, 0.32);
    } else if (this.fs === 'landing' || this.fs === 'card') {
      if (this.hookFish) look.lerp(this.hookFish.pos, 0.6);
    }
    cam.lookAt(look);
    this._setUnderwaterFx(false);
  }

  _setUnderwaterFx(on) {
    if (this._uwFx === on) return;
    this._uwFx = on;
    this.env.underwater = on;
    document.getElementById('underwater-tint').classList.toggle('on', on);
    this.audio.setUnderwater(on);
  }

  _toggleUnderwater() {
    const ok = ['wait', 'nibble', 'bite', 'fight'].includes(this.fs);
    if (!ok) {
      this.ui.toast('仕掛けが水に入っている時だけ使えます', 'bad');
      this.audio.deny();
      return;
    }
    this.underwaterCam = !this.underwaterCam;
    this.audio.click();
    this.ui.toast(this.underwaterCam ? '🌊 水中カメラ ON（Vで戻る）' : '水中カメラ OFF');
  }

  /* =========================================================
     釣りの状態機械
     ========================================================= */
  /**
   * 水面より下の糸を隠すためのクリップ高さ。
   * 陸の上、または水中カメラ中（水中の糸を見せたい）は null。
   */
  _clipY(x, z) {
    if (this._uwFx) return null;
    if (this.terrain.depthAt(x, z) <= 0.02) return null;
    return this.water.surfaceY(x, z);
  }

  get baitY() {
    const d = this.terrain.depthAt(this.bobber.x, this.bobber.z);
    const target = Math.min(this.bait.depth, Math.max(0.35, d - 0.35));
    return -target;
  }

  _updateFishing(dt) {
    if (!this.playing) {
      this.ui.setPrompt('');
      this.ui.showPower(false);
      this.ui.showFight(false);
      return;
    }
    this.stateTime += dt;
    const ui = this.ui;
    const bob = this.angler.bobber;
    this.angler.getRodTip(_v1);

    switch (this.fs) {
      /* ---------------- 待機 ---------------- */
      case 'idle': {
        // 照準の狙い点を出しておく（水深の下見にも使える）
        this._updateAim();
        const ad = this.terrain.depthAt(this.aimPoint.x, this.aimPoint.z);
        this.hudDepth = ad;
        this.hudAim = this.aimDist;
        this.aimMarker.visible = true;
        this.aimMarker.position.set(
          this.aimPoint.x,
          (ad > 0 ? this.water.surfaceY(this.aimPoint.x, this.aimPoint.z) : this.terrain.heightAt(this.aimPoint.x, this.aimPoint.z)) + 0.05,
          this.aimPoint.z
        );
        this.aimMarker.material.color.setHex(ad > 0.4 ? 0x9ff0ff : 0xff9a80);
        bob.visible = false;
        this.angler.hideLine();
        this.marker.visible = false;
        ui.showPower(false);
        ui.showFight(false);
        ui.setPrompt('<b>十字で狙い</b>、長押しして<b>目印で離す</b>（見下ろすと近く／水平で遠く）');
        break;
      }

      /* ---------------- 力をためる ---------------- */
      case 'charge': {
        if (this.stateTime < dt * 1.5) { this.castObstruction = null; this._obsCheckT = 1; }
        const rate = 1.05;
        this.charge += this.chargeDir * rate * dt;
        if (this.charge >= 1) { this.charge = 1; this.chargeDir = -1; }
        if (this.charge <= 0.0) { this.charge = 0; this.chargeDir = 1; }

        // 狙い点と、その距離に必要なパワー（目印）
        this._updateAim();
        const onTarget = Math.abs(this.charge - this.targetPower) <= CAST_TOL;
        ui.showPower(true, this.charge, this.targetPower, CAST_TOL);
        const aimDepth = this.terrain.depthAt(this.aimPoint.x, this.aimPoint.z);
        this.hudAim = this.aimDist;
        this.aimMarker.visible = true;
        this.aimMarker.position.set(
          this.aimPoint.x,
          (aimDepth > 0 ? this.water.surfaceY(this.aimPoint.x, this.aimPoint.z) : this.terrain.heightAt(this.aimPoint.x, this.aimPoint.z)) + 0.05,
          this.aimPoint.z
        );
        this.aimMarker.material.color.setHex(onTarget ? 0x9dffb4 : 0x9ff0ff);
        this.aimMarker.scale.setScalar(onTarget ? 1.1 : 1);

        ui.setPrompt(onTarget
          ? '<b>今！</b> 離せば狙い通りに落ちる'
          : `離してキャスト（狙い ${fmt1(this.aimDist)}m ／ 目印まで待つ）`);
        // 着水点予測（糸が何かに掛かる場合は赤くして知らせる）
        this._predictLanding(this.charge, _v2);
        const d = this.terrain.depthAt(_v2.x, _v2.z);
        // 糸の判定は毎フレームやると重いので 12Hz で更新
        this._obsCheckT = (this._obsCheckT || 0) + dt;
        if (this._obsCheckT > 0.08) {
          this._obsCheckT = 0;
          this.castObstruction = d > 0.25 ? this.lineObstruction(_v1, _v2, 0.62) : null;
        }
        const obstruct = this.castObstruction;
        this.hudDepth = d;
        this.marker.visible = true;
        this.marker.position.set(_v2.x, (d > 0 ? this.water.surfaceY(_v2.x, _v2.z) : this.terrain.heightAt(_v2.x, _v2.z)) + 0.06, _v2.z);
        this.marker.scale.setScalar(1 + (1 - this.charge) * 0.5);
        this.marker.material.color.setHex(obstruct ? 0xff5a4a : d > 0.4 ? 0xfff0b0 : 0xff8a6a);
        if (obstruct) {
          const what = obstruct === 'dock' ? '桟橋' : obstruct === 'rock' ? '岩' : '陸';
          ui.setPrompt(`⚠ <b>${what}が邪魔</b>：このままだと糸が掛かります`);
        }
        bob.visible = false;
        this.angler.hideLine();
        break;
      }

      /* ---------------- 飛行 / 回収 ---------------- */
      case 'flight': {
        ui.setPrompt('');
        this.aimMarker.visible = false;
        if (this.retrieving) {
          // ウキを手元へ
          _v2.subVectors(_v1, this.bobber);
          const d = _v2.length();
          if (d < 0.8) {
            this.retrieving = false;
            this.fs = 'idle';
            bob.visible = false;
            this.angler.hideLine();
            break;
          }
          _v2.multiplyScalar(1 / d);
          const sp = 9 + this.rod.reel * 6;
          this.bobber.addScaledVector(_v2, Math.min(d, sp * dt));
          const surf = this.water.surfaceY(this.bobber.x, this.bobber.z);
          if (this.bobber.y < surf) {
            this.bobber.y = lerp(this.bobber.y, surf, 0.3);
            if (Math.random() < dt * 8) this.water.addRipple(this.bobber.x, this.bobber.z, 0.35, 0.8);
          }
          this.audio.reelTick(1.5);
        } else {
          // 放物線
          _v3.copy(this.bobber);                       // 直前位置（桟橋との判定用）
          this.bobberVel.y -= GRAVITY * dt;
          const spd = this.bobberVel.length();
          this.bobberVel.multiplyScalar(1 - 0.0055 * spd * dt);
          this.bobber.addScaledVector(this.bobberVel, dt);

          // 桟橋に当たったら落ちる
          if (this.terrain.dockBlocksSegment(_v3.x, _v3.y, _v3.z, this.bobber.x, this.bobber.y, this.bobber.z)) {
            this.bobber.copy(_v3);
            this._snagOnDock('桟橋に当たった…回収します');
            break;
          }

          const ground = this.terrain.heightAt(this.bobber.x, this.bobber.z);
          const surf = ground < 0 ? this.water.surfaceY(this.bobber.x, this.bobber.z) : ground;
          const lineOut = this.bobber.distanceTo(this.castOrigin);

          if (this.bobber.y <= surf || lineOut > MAX_LINE) {
            this.bobber.y = surf;
            if (ground < -0.25) this._onLandWater();
            else this._onLandGround();
          }
        }
        bob.visible = true;
        bob.position.copy(this.bobber);
        bob.rotation.set(0, 0, 0);
        this.angler.updateLine(_v1, this.bobber, 0.25, this.camera,
          this._clipY(this.bobber.x, this.bobber.z));
        this.angler.updateRig(this.bobber, this.baitPos, this.camera, false);
        this.angler.bobberRing.visible = false;
        break;
      }

      /* ---------------- アタリ待ち ---------------- */
      case 'wait':
      case 'nibble': {
        const surf = this.water.surfaceY(this.bobber.x, this.bobber.z);
        this.hudDepth = this.terrain.depthAt(this.bobber.x, this.bobber.z);
        this.hudAim = 0;
        this.aimMarker.visible = false;
        this.baitPos.set(this.bobber.x, this.baitY, this.bobber.z);

        // ウキの挙動
        let off = 0;
        if (this.fs === 'nibble') {
          off = -0.045 + Math.sin(this.stateTime * 17) * 0.05 - 0.02;
          if (Math.random() < dt * 3.5) {
            this.water.addRipple(this.bobber.x, this.bobber.z, 0.3, 0.9);
            this.audio.nibble();
          }
        } else {
          off = Math.sin(this.time * 1.6) * 0.012;
        }
        this.bobberOffset = damp(this.bobberOffset, off, 10, dt);
        this.bobber.y = surf + 0.012 + this.bobberOffset;
        bob.visible = true;
        bob.position.copy(this.bobber);
        this.water.surfaceNormal(this.bobber.x, this.bobber.z, _v2);
        bob.quaternion.setFromUnitVectors(UP, _v2);
        this.angler.updateLine(_v1, this.bobber, 0.62, this.camera, this._uwFx ? null : surf);
        // 水中の仕掛けは水中カメラの時だけ見せる
        this.angler.updateRig(this.bobber, this.baitPos, this.camera, !!this._uwFx);
        // 水面のリング（遠くでもウキが見えるように）
        const ring = this.angler.bobberRing;
        ring.visible = true;
        ring.position.set(this.bobber.x, surf + 0.02, this.bobber.z);
        ring.scale.setScalar(1 + Math.sin(this.time * 1.7) * 0.07 + (this.fs === 'nibble' ? 0.35 : 0));
        ring.material.opacity = this.fs === 'nibble' ? 0.55 : 0.34;

        // 糸が伸びきったら強制回収
        if (_v1.distanceTo(this.bobber) > MAX_LINE) {
          this.ui.toast('糸が伸びきった…回収します', 'bad');
          this._retrieve();
          break;
        }
        // 歩いて障害物を挟んでしまったら糸が掛かる
        if (this.moveAmt > 0.02) {
          const obs = this.lineObstruction(_v1, this.bobber, 0.62);
          if (obs) { this._snagLine(obs); break; }
        }

        // アタリ抽選
        this.biteTimer -= dt;
        if (this.fs === 'wait') {
          if (!this.hookFish && this.biteTimer <= 0) this._chooseBiter();
          if (this.hookFish) {
            this.approachT += dt;
            // 接近中の魚が餌に着いたら nibble へ
            if (this.hookFish.state === 'nibble') {
              this.fs = 'nibble';
              this.stateTime = 0;
              this.nibbleDur = rand(0.7, 1.9) * (this.hookFish.species.rarity >= 4 ? 1.5 : 1);
            } else if (this.hookFish.state !== 'approach' || this.approachT > 22) {
              // 逃げた・辿り着けない
              if (this.hookFish.state === 'approach') this.hookFish.state = 'wander';
              this.hookFish = null;
              this.biteTimer = rand(2, 5);
            }
          }
          ui.setPrompt(this._waitPrompt());
        } else {
          if (this.stateTime > this.nibbleDur) this._startBite();
          ui.setPrompt('…何かがエサに触っている！ <b>まだ待つ</b>');
        }
        break;
      }

      /* ---------------- アタリ本番 ---------------- */
      case 'bite': {
        const surf = this.water.surfaceY(this.bobber.x, this.bobber.z);
        const t = clamp01(this.stateTime / 0.22);
        this.bobber.y = surf + 0.012 - t * 0.42 - Math.sin(this.stateTime * 24) * 0.03;
        bob.position.copy(this.bobber);
        if (Math.random() < dt * 6) this.water.addRipple(this.bobber.x, this.bobber.z, 0.5, 0.9);
        this.angler.updateLine(_v1, this.bobber, 0.25, this.camera, this._uwFx ? null : surf);
        this.angler.updateRig(this.bobber, this.baitPos, this.camera, !!this._uwFx);
        this.angler.bobberRing.visible = false;
        ui.setPrompt('今だ！ <b>クリック / Space</b> でアワセ！');
        if (this.stateTime > this.biteWindow) this._missBite();
        break;
      }

      /* ---------------- ファイト ---------------- */
      case 'fight': {
        this.aimMarker.visible = false;
        this._updateFight(dt, _v1);
        break;
      }

      /* ---------------- 取り込み ---------------- */
      case 'landing': {
        const f = this.hookFish;
        this.aimMarker.visible = false;
        ui.showFight(false);
        ui.setPrompt('');
        if (!f) { this.fs = 'idle'; break; }
        const t = clamp01(this.stateTime / 0.85);
        _v2.copy(this.pos);
        _v2.y = this.visY + 1.15;
        _v2.x += Math.sin(this.yaw) * 1.1;
        _v2.z += Math.cos(this.yaw) * 1.1;
        f.pos.lerp(_v2, 1 - Math.exp(-6 * dt));
        f.state = 'landed';
        f.mesh.position.copy(f.pos);
        f.mesh.rotation.set(0, -this.yaw + Math.PI * 0.5, lerp(0, 0.5, t));
        this.bobber.copy(f.pos).y += 0.3;
        bob.position.copy(this.bobber);
        this.angler.updateLine(_v1, this.bobber, 0.9, this.camera);
        if (this.stateTime > 0.8 && !this.cardShown) this._showCatchCard();
        break;
      }

      case 'card': {
        const f = this.hookFish;
        if (f) {
          f.mesh.position.copy(f.pos);
          f.mesh.rotation.z = 0.5 + Math.sin(this.time * 3) * 0.12;
        }
        this.angler.updateLine(_v1, this.bobber, 0.9, this.camera);
        break;
      }
    }
  }

  _waitPrompt() {
    if (this.hookFish) {
      const d = this.hookFish.pos.distanceTo(this.baitPos);
      if (d < 4.5) return '…<b>何かが寄ってきた</b>（Vで水中カメラ）';
    }
    const d = this.terrain.depthAt(this.bobber.x, this.bobber.z);
    const bd = Math.min(this.bait.depth, Math.max(0.35, d - 0.35));
    return `アタリを待つ…（水深 ${fmt1(d)}m / エサの層 ${fmt1(bd)}m）　<b>クリック</b>で回収`;
  }

  /* ---------------- 着水 ---------------- */
  _onLandWater() {
    const x = this.bobber.x, z = this.bobber.z;
    // 桟橋・陸の張り出し・岩を挟んで着水した場合は糸が掛かっている
    const obstruct = this.lineObstruction(this.angler.getRodTip(_v1), this.bobber, 0.62);
    if (obstruct) {
      this._snagLine(obstruct);
      return;
    }
    this.fs = 'wait';
    this.stateTime = 0;
    this.castDist = Math.hypot(x - this.pos.x, z - this.pos.z);
    this.audio.splash(0.55 + this.castPower * 0.5);
    this.water.addSplash(x, this.water.surfaceY(x, z), z, 16, 0.9 + this.castPower * 0.5);
    this.water.addRipple(x, z, 1.0 + this.castPower * 0.7, 1.9);
    this.water.addRipple(x, z, 0.6, 1.3);
    // 近くの魚を驚かせる（上手いキャストなら控えめ）
    this.school.startle(x, z, this.castPerfect ? 1.4 : 2.6 + this.castPower * 2.2);
    // アタリまでの時間
    const attract = this.bait.attract * this.rod.attract * this.env.weather.bite * (this.castPerfect ? 1.18 : 1);
    const depth = this.terrain.depthAt(x, z);
    let base = rand(2.2, 7.0) / attract;
    if (depth < 0.9) base *= 1.7;
    this.biteTimer = base;
    this.hookFish = null;
  }

  _onLandGround() {
    this.fs = 'flight';
    this.retrieving = true;
    this.stateTime = 0;
    this.ui.toast('陸に落ちた…回収します', 'bad');
    this.audio.deny();
  }

  /* ---------------- アタリの主を決める ---------------- */
  _chooseBiter() {
    const x = this.bobber.x, z = this.bobber.z;
    const depth = this.terrain.depthAt(x, z);
    const baitDepth = -this.baitY;

    // ゴミ抽選
    const junkP = 0.085 * this.bait.junk * (depth < 1.4 ? 1.8 : 1) * (this.state.totalCaught < 3 ? 0.3 : 1);
    let sp = null;
    if (Math.random() < junkP) {
      sp = pick(JUNK);
    } else {
      sp = this.rollSpecies(depth, { bait: true, baitDepth });
    }
    if (!sp) { this.biteTimer = rand(2, 4); return; }

    // ゴミは泳いで来ないので、その場で引っ掛かる
    if (sp.rarity === 0) {
      const junkFish = this.school.reserve();
      junkFish.spawn(sp, Math.round(rand(sp.len[0], sp.len[1]) * 10) / 10,
        _v2.set(x + rand(-0.3, 0.3), this.baitY - 0.1, z + rand(-0.3, 0.3)));
      junkFish.state = 'nibble';
      junkFish.timer = 6;
      this.hookFish = junkFish;
      this.approachT = 0;
      return;
    }

    // その魚種の個体が近くにいれば呼び寄せる
    let fish = null;
    let bestD = 1e9;
    {
      for (const f of this.school.fishes) {
        if (!f.active || f.species !== sp) continue;
        if (f.state !== 'wander') continue;
        const d = Math.hypot(f.pos.x - x, f.pos.z - z);
        if (d < 18 && d < bestD) { bestD = d; fish = f; }
      }
    }
    if (!fish) {
      // 視界の外から呼ぶ
      fish = this.school.reserve();
      const a = rand(0, TAU);
      const len = rollLength(sp, this.bait.rare * 0.25);
      let ok = false;
      for (let i = 0; i < 20; i++) {
        const r = rand(5.5, 9.5);
        const px = x + Math.cos(a + i * 0.7) * r;
        const pz = z + Math.sin(a + i * 0.7) * r;
        const d = this.terrain.depthAt(px, pz);
        if (d < 0.8) continue;
        const y = -clamp(Math.min(baitDepth + rand(-1, 1), d - 0.4), 0.35, Math.max(0.4, d - 0.35));
        fish.spawn(sp, len, _v2.set(px, y, pz));
        fish._depthBias = Math.random();
        ok = true;
        break;
      }
      if (!ok) { this.biteTimer = rand(2, 4); return; }
    }

    fish.state = 'approach';
    fish.timer = 14;
    this.hookFish = fish;
    this.approachT = 0;
  }

  _startBite() {
    const sp = this.hookFish.species;
    this.fs = 'bite';
    this.stateTime = 0;
    this.biteWindow = lerp(1.55, 0.85, clamp01(sp.rarity / 5)) * (sp.tags.includes('trout') ? 0.8 : 1);
    this.audio.bite();
    this.ui.biteAlert();
    this.water.addSplash(this.bobber.x, this.water.surfaceY(this.bobber.x, this.bobber.z), this.bobber.z, 8, 0.5);
  }

  _missBite() {
    const f = this.hookFish;
    if (f) {
      f.state = 'flee';
      f.timer = 3;
      _v2.set(f.pos.x - this.pos.x, 0, f.pos.z - this.pos.z).normalize().multiplyScalar(22);
      f.target.set(f.pos.x + _v2.x, f.pos.y - 1, f.pos.z + _v2.z);
    }
    this.hookFish = null;
    this.fs = 'wait';
    this.stateTime = 0;
    this.biteTimer = rand(3, 6);
    this.audio.escape();
    this.ui.toast('アワセが遅れた…逃げられた', 'bad');
  }

  /* =========================================================
     ファイト
     ========================================================= */
  _updateFight(dt, tipPos) {
    const F = this.fight;
    const f = this.hookFish;
    if (!f) { this.fs = 'idle'; return; }
    const sp = f.species;
    const cap = this.line.cap;
    F.time += dt;

    const P = F.pattern;

    /* --- 突進 --- */
    F.runTimer -= dt;
    if (F.running) {
      F.runDur -= dt;
      // 跳ねている間は突進を終わらせない（「走ったら離す」だけで跳ねにも対応できる）
      if (F.runDur <= 0 && F.jumpT <= 0 && F.jumpQueued <= 0) {
        F.running = false;
        F.runTimer = rand(1.8, 4.2) * P.runGap / (0.6 + sp.agg * 0.8);
      }
    } else if (F.runTimer <= 0 && F.stamina > 0.16 && P.runGap < 50) {
      F.running = true;
      F.runDur = rand(0.7, 1.9) * P.runDur * (0.7 + sp.agg * 0.5);
      this.audio.drag();
      // ジャンパーは走りの途中で跳ねる
      if (P.jump > 0 && F.jumps < 4 && Math.random() < 0.8) F.jumpQueued = F.runDur * rand(0.3, 0.55);
      else if (F.pull0 >= 1.2 && Math.random() < 0.4) this.ui.toast('走った！ <b>糸を送れ</b>', 'bad');
    }

    /* --- 首振り（振っている間は巻いても進まず、張力だけ上がる） --- */
    if (P.shake > 0 && F.stamina > 0.12) {
      F.shakeT -= dt;
      if (F.shakeOn) F.shakeAge += dt;
      if (F.shakeT <= 0) {
        F.shakeOn = !F.shakeOn;
        F.shakeAge = 0;
        const span = F.shakeOn ? (P.shakeOn || [0.34, 0.62]) : (P.shakeOff || [0.65, 1.35]);
        F.shakeT = rand(span[0], span[1]);
        if (F.shakeOn) this.audio.drag();
      }
    } else {
      F.shakeOn = false;
    }
    // 演出は始まった瞬間から、ペナルティは猶予の後から
    const shakeBite = F.shakeOn && F.shakeAge > (P.shakeGrace || 0);

    /* --- ジャンプ（予告 → 0.62秒の空中） --- */
    if (F.jumpQueued > 0) {
      F.jumpQueued -= dt;
      if (F.jumpQueued <= 0) {
        F.jumpT = P.jumpDur || 0.62;
        F.jumps++;
        this.audio.splash(1.0);
        this.ui.toast('跳ねた！ <b>糸を送れ</b>', 'bad');
      }
    }
    if (F.jumpT > 0) F.jumpT = Math.max(0, F.jumpT - dt);
    const jumping = F.jumpT > 0;
    const jumpDur = P.jumpDur || 0.62;
    const jumpBite = jumping && F.jumpT < jumpDur - (P.jumpGrace || 0);

    const reeling = this.actionHeld;
    const pull = F.pull0 * P.pull * (F.running ? 2.0 * P.runPull : 1.0) * (0.5 + 0.5 * F.stamina);

    if (reeling) {
      const resist = clamp(1.70 - pull * 0.75, 0.35, 1.60) * (shakeBite ? P.shakeReel : 1);
      const rate = this.rod.reel * 0.28 * resist;
      F.dist -= rate * dt;
      let gain = (0.08 + pull * 0.55) * P.tensionGain;
      if (shakeBite) gain *= P.shakeGain;
      if (jumpBite) gain *= P.jumpTension;
      F.tension += gain * dt / this.rod.power;
      this.audio.reelTick(0.7 + resist);
    } else {
      F.dist += pull * 0.032 * P.lineOut * dt;
      F.tension -= (1.30 + pull * 0.30) * P.tensionDecay * dt;
      if (F.running) F.tension += pull * 0.30 * dt;
      // 跳ねている間に糸を送れていれば、魚が余計に消耗する
      if (jumping) F.stamina -= (P.jumpDrain || 0) * dt;
    }
    F.tension = clamp(F.tension, 0, cap * 1.2);

    // 体力（テンションを掛け続けると疲れる）
    const tRatio = clamp01(F.tension / cap);
    F.stamina -= (0.022 + tRatio * 0.17 + (reeling ? 0.02 : 0)) * P.staminaDrain * dt / Math.max(0.4, sp.sta);
    F.stamina = clamp01(F.stamina);

    /* --- 魚の位置（見た目） --- */
    if (!this.bobberFar) this.bobberFar = this.bobber.clone();
    const near = _v2.set(this.pos.x, 0, this.pos.z);
    near.x += Math.sin(this.yaw) * 1.6;
    near.z += Math.cos(this.yaw) * 1.6;
    const far = _v3.copy(this.bobberFar);

    F.lateral = damp(F.lateral, (F.running ? Math.sin(F.time * 1.7) * 1.9 : Math.sin(F.time * 0.9) * 0.7), 3, dt);
    const t = clamp01(F.dist);
    const fx = lerp(near.x, far.x, t);
    const fz = lerp(near.z, far.z, t);
    // 横ずれ（線と直交方向）
    const dx = far.x - near.x, dz = far.z - near.z;
    const dl = Math.hypot(dx, dz) || 1;
    const px = -dz / dl, pz = dx / dl;
    const wx = fx + px * F.lateral;
    const wz = fz + pz * F.lateral;
    const depth = this.terrain.depthAt(wx, wz);
    const surf = this.water.surfaceY(wx, wz);
    // 疲れると浮いてくる
    const wantDepth = clamp(lerp(0.35, 2.4, F.stamina) * lerp(0.4, 1.4, t), 0.2, Math.max(0.25, depth - 0.25));
    let fy = Math.min(surf - 0.12, -wantDepth + surf);
    if (jumping) {
      // 空中に跳ね上がる（0 → 1 → 0 の弧）
      const jt = 1 - F.jumpT / (P.jumpDur || 0.62);
      fy = surf + Math.sin(Math.PI * jt) * (0.45 + Math.min(1.1, F.pull0 * 0.32));
      if (Math.random() < dt * 26) {
        this.water.addSplash(wx, surf, wz, 6, 1.0);
        this.water.addRipple(wx, wz, 0.8, 1.2);
      }
    }
    f.pos.set(wx, fy, wz);
    f.state = 'hooked';
    f.mesh.position.copy(f.pos);
    // 向き（プレイヤーに引かれる方向を向く／跳ねている間は上向き）
    const jumpUp = jumping && F.jumpT > (P.jumpDur || 0.62) * 0.5;
    _v1.set(near.x - wx, jumping ? (jumpUp ? 0.85 : -0.85) : 0.05, near.z - wz).normalize();
    const roll = jumping ? Math.sin(F.time * 22) * 0.9
      : F.shakeOn ? Math.sin(F.time * 26) * 0.55
        : Math.sin(F.time * 7) * 0.5 * (F.running ? 1 : 0.35);
    f._orient(dt, _v1, roll);
    f._wiggle(dt,
      2.2 + (F.running ? 2.2 : 0) + (F.shakeOn ? 3.4 : 0) + (jumping ? 3.0 : 0),
      0.1 + (F.running ? 0.09 : 0) + (F.shakeOn ? 0.13 : 0));

    // 水面の演出
    if (!jumping && f.pos.y > surf - 0.35) {
      if (Math.random() < dt * 14) {
        this.water.addSplash(wx, surf, wz, 4, 0.5 + F.pull0 * 0.2);
        this.water.addRipple(wx, wz, 0.55, 1.0);
      }
    }
    // 首振りは水面にも波紋を出す（見て分かるように）
    if (F.shakeOn && Math.random() < dt * 9) {
      this.water.addRipple(wx, wz, 0.5, 0.8);
    }

    /* --- ウキ / 糸 --- */
    this.bobber.copy(f.pos).lerp(this.angler.getRodTip(_v1), 0.32);
    this.bobber.y = Math.max(this.bobber.y, surf - 0.18);
    this.angler.bobber.visible = true;
    this.angler.bobber.position.copy(this.bobber);
    // 糸は水面で切って、水中は描かない（水中カメラ中は見せる）
    this.angler.updateLine(this.angler.getRodTip(_v1), f.pos,
      clamp01(1 - tRatio) * 0.55, this.camera, this._uwFx ? null : surf);
    this.angler.updateRig(this.bobber, f.pos, this.camera, false);

    /* --- UI --- */
    // 魚種とレア度は取り込むまで伏せる（引きの強さだけを見せる）
    this.hudDepth = depth;
    this.ui.showFight(true, {
      name: pullLabel(F.pull0),
      sub: jumping ? '⚠ 跳ねた！'
        : F.shakeOn ? '⚠ 首を振っている'
          : F.running ? '⚠ 走っている'
            : `${P.name}｜${reeling ? '巻いている' : '待機'}`,
      tension: tRatio,
      dist: t,
      stam: F.stamina,
      reeling,
    });
    this.ui.setPrompt(jumping
      ? '跳ねている！ <b>離して</b>糸を送れ（送れれば魚が消耗する）'
      : F.shakeOn
        ? '首を振っている！ <b>巻くのを止めて</b>やり過ごせ'
        : F.running
          ? '走っている！ テンションが上がる — <b>危なければ離せ</b>'
          : '<b>押し続けて</b>巻き上げろ（テンションは白線の内側で）');

    /* --- 決着 --- */
    if (F.tension >= cap) return this._lineSnap();
    if (F.dist >= 1.0) return this._fishEscaped();
    if (F.dist <= 0.03) return this._land();
  }

  _lineSnap() {
    this.audio.snap();
    this.ui.toast('💥 <b>ラインが切れた…！</b>', 'bad');
    if (this.fight && this.fight.pull0 > this.line.cap * 1.35) {
      setTimeout(() => this.ui.toast('この魚には道具が足りない。<b>Bキー</b>でラインとロッドを強化しよう', 'gold'), 1200);
    }
    this.state.snapped++;
    this._releaseFish(true);
  }

  _fishEscaped() {
    this.audio.escape();
    this.ui.toast('魚に走り切られた…', 'bad');
    this.state.escaped++;
    this._releaseFish(true);
  }

  _releaseFish(flee) {
    const f = this.hookFish;
    if (f) {
      if (flee) {
        f.state = 'flee';
        f.timer = 4;
        _v2.set(f.pos.x - this.pos.x, 0, f.pos.z - this.pos.z).normalize().multiplyScalar(30);
        f.target.set(f.pos.x + _v2.x, f.pos.y - 2, f.pos.z + _v2.z);
      } else {
        f.despawn();
      }
    }
    this.hookFish = null;
    this.fight = null;
    this.bobberFar = null;
    this.ui.showFight(false);
    this.underwaterCam = false;
    this.retrieving = true;
    this.fs = 'flight';
    this.stateTime = 0;
    this.saveState();
  }

  /* ---------------- 釣り上げ ---------------- */
  _land() {
    const f = this.hookFish;
    const sp = f.species;
    this.fs = 'landing';
    this.stateTime = 0;
    this.cardShown = false;
    this.underwaterCam = false;
    const surf = this.water.surfaceY(f.pos.x, f.pos.z);
    this.water.addSplash(f.pos.x, surf, f.pos.z, 24, 1.2);
    this.water.addRipple(f.pos.x, f.pos.z, 1.4, 1.6);
    this.audio.catchFanfare(sp.rarity);
    this.ui.showFight(false);
  }

  _showCatchCard() {
    this.cardShown = true;
    const f = this.hookFish;
    const sp = f.species;
    const len = Math.round(f.length * 10) / 10;
    const weight = weightOf(sp, len);
    const value = valueOf(sp, len);
    const xp = xpOf(sp, len);
    const s = this.state;

    const rec = s.records[sp.id];
    const isNew = !rec;
    const record = !!rec && len > rec.maxLen;
    if (isNew) {
      s.records[sp.id] = { count: 1, maxLen: len, maxWeight: weight, firstAt: Date.now() };
    } else {
      rec.count++;
      rec.maxLen = Math.max(rec.maxLen, len);
      rec.maxWeight = Math.max(rec.maxWeight, weight);
    }
    s.money += value;
    s.totalEarned += value;
    s.totalCaught++;
    s.maxLen = Math.max(s.maxLen, len);
    if (sp.rarity === 5) s.legendCaught++;
    if (timeBand(s.clock) === 'night') s.nightCaught++;
    this._gainXp(xp);

    this.fs = 'card';
    this.ui.showCatch({ sp, len, weight, value, xp, record, isNew });
    this._checkAchievements();
    Save.saveNow(s);
  }

  dismissCatch() {
    if (this.fs !== 'card') { this.ui.hideCatch(); return; }
    this.ui.hideCatch();
    if (this.hookFish) this.hookFish.despawn();
    this.hookFish = null;
    this.fight = null;
    this.bobberFar = null;
    this.fs = 'idle';
    this.angler.bobber.visible = false;
    this.angler.hideLine();
    this.audio.click();
    if (this.playing && !this.ui.isBlocking() && !document.pointerLockElement) {
      const p = this.canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    }
  }

  _gainXp(xp) {
    const s = this.state;
    s.xp += xp;
    let leveled = 0;
    while (s.xp >= Save.xpForLevel(s.level)) {
      s.level++;
      leveled++;
    }
    if (leveled) {
      this.audio.levelUp();
      setTimeout(() => {
        this.ui.toast(`⬆️ <b>レベル ${s.level}</b> になった！新しい道具が解禁されるかも`, 'gold');
      }, 500);
    }
  }

  _checkAchievements() {
    const s = this.state;
    const stats = {
      totalCaught: s.totalCaught,
      maxLen: s.maxLen,
      speciesCount: Object.keys(s.records).length,
      legendCaught: s.legendCaught,
      totalEarned: s.totalEarned,
    };
    for (const a of ACHIEVEMENTS) {
      if (s.achievements.includes(a.id)) continue;
      if (a.test(stats)) {
        s.achievements.push(a.id);
        setTimeout(() => this.ui.toast(`🏅 実績解除: <b>${a.name}</b>`, 'gold'), 900);
      }
    }
  }
}
