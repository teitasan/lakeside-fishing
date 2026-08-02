/* ===========================================================
   セーブデータ（localStorage）
   =========================================================== */

import {
  BAITS, BAIT_ALIAS, LINES, LINE_ALIAS, RIG_LAYERS, SPECIES_BY_ID,
} from './data.js';

const KEY = 'lakeside-fishing-save-v1';

/** シードを持たない旧セーブ用（これまで固定で使っていた湖） */
export const LEGACY_SEED = 20240711;

export function defaultState() {
  return {
    version: 1,
    money: 120,
    xp: 0,
    level: 1,
    totalCaught: 0,
    totalEarned: 0,
    maxLen: 0,
    legendCaught: 0,
    nightCaught: 0,
    snapped: 0,
    escaped: 0,
    clock: 9, // 9時スタート
    rigLayer: 'mid', // 狙う層（タナ）: top|mid|bottom。実際の深さは水深×比率
    seed: null, // 湖のシード（null = 起動時にランダムで決める）
    gear: { rod: 'bamboo', line: 'nylon2', bait: 'worm' },
    owned: { rod: ['bamboo'], line: ['nylon2'], bait: ['worm'] },
    // エサの在庫（id -> 個数）。魚が触ると減る。ミミズは 0G なので詰まらない
    baitStock: { worm: 10 },
    records: {}, // id -> {count, maxLen, maxWeight, albinoCaught?}
    terrain: {}, // 地形図鑑: id -> {casts, depth, fish[]}（初めて投げた時に登録）
    map: { seed: null, cells: '' }, // 湖の測量（M キー）: 歩いた／投げた所だけ地形が分かる
    achievements: [],
    // volume = 効果音 / bgm = 環境音（雨・風・水・虫）
    // fpv = 一人称視点（ホイールを手前まで回すと切り替わる）
    settings: { volume: 0.7, bgm: 0.7, sens: 1.0, quality: 'mid', shadow: true, randomLake: false, debug: false, fpv: false },
  };
}

/** 湖のシード（1〜0xffffffff） */
export const randomLakeSeed = () => (Math.floor(Math.random() * 0xfffffffe) + 1) >>> 0;

export function hasSave() {
  try {
    return !!localStorage.getItem(KEY);
  } catch (e) {
    return false;
  }
}

export function load() {
  const base = defaultState();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const data = JSON.parse(raw);
    // 浅いマージ + 既知のネストは個別マージ（バージョン差に耐える）
    const out = { ...base, ...data };
    out.gear = { ...base.gear, ...(data.gear || {}) };
    out.settings = { ...base.settings, ...(data.settings || {}) };
    out.owned = {
      rod: uniq([...base.owned.rod, ...((data.owned && data.owned.rod) || [])]),
      line: uniq([...base.owned.line, ...((data.owned && data.owned.line) || [])]),
      bait: uniq([...base.owned.bait, ...((data.owned && data.owned.bait) || [])]),
    };
    out.records = (data.records && typeof data.records === 'object') ? data.records : {};
    for (const id of Object.keys(out.records)) {
      if (!SPECIES_BY_ID[id]) delete out.records[id]; // 削除された種（例: 白龍魚）
    }
    out.map = (data.map && typeof data.map === 'object'
      && typeof data.map.cells === 'string') ? data.map : { seed: null, cells: '' };
    out.terrain = (data.terrain && typeof data.terrain === 'object') ? data.terrain : {};
    for (const [k, v] of Object.entries(out.terrain)) {
      if (!v || typeof v !== 'object') { delete out.terrain[k]; continue; }
      v.casts = typeof v.casts === 'number' && isFinite(v.casts) ? v.casts : 1;
      v.depth = typeof v.depth === 'number' && isFinite(v.depth) ? v.depth : 0;
      v.fish = Array.isArray(v.fish) ? v.fish.filter((id) => SPECIES_BY_ID[id]) : [];
    }
    out.achievements = Array.isArray(data.achievements) ? data.achievements : [];
    for (const k of ['money', 'xp', 'level', 'totalCaught', 'totalEarned', 'maxLen', 'clock']) {
      if (typeof out[k] !== 'number' || !isFinite(out[k])) out[k] = base[k];
    }
    // タナが m 指定だった頃のセーブ → 3 択に読み替える（保存側の値だけを見る）
    if (!RIG_LAYERS.some((l) => l.id === data.rigLayer)) {
      const d = typeof data.rigDepth === 'number' ? data.rigDepth : null;
      out.rigLayer = d === null ? 'mid' : d <= 3 ? 'top' : d <= 12 ? 'mid' : 'bottom';
    }
    delete out.rigDepth;
    // ライン刷新（素材だけ→素材×号数）：旧 id を対応する号数へ読み替える
    const lineIds = new Set(LINES.map((l) => l.id));
    const toLine = (id) => (lineIds.has(id) ? id : LINE_ALIAS[id]);
    out.gear.line = toLine(out.gear.line) || base.gear.line;
    out.owned.line = uniq(out.owned.line.map(toLine).filter(Boolean));
    if (!out.owned.line.includes(out.gear.line)) out.owned.line.push(out.gear.line);
    // ルアー廃止（spoon/frog/crank）：装備・所持を対応するエサに読み替える
    const baitIds = new Set(BAITS.map((b) => b.id));
    const toBait = (id) => (baitIds.has(id) ? id : BAIT_ALIAS[id]);
    out.gear.bait = toBait(out.gear.bait) || base.gear.bait;
    out.owned.bait = uniq(out.owned.bait.map(toBait).filter(Boolean));
    if (!out.owned.bait.includes(out.gear.bait)) out.owned.bait.push(out.gear.bait);
    /* エサの在庫。旧セーブ（在庫の概念が無かった頃）は、持っていたエサに
       1 束ぶんを配って引き継ぐ。装備中のエサが 0 なら 1 束足す */
    const packOf = (id) => (BAITS.find((b) => b.id === id) || {}).pack || 10;
    const stock = {};
    const raw0 = data.baitStock && typeof data.baitStock === 'object' ? data.baitStock : null;
    for (const b of BAITS) {
      if (raw0) {
        const n = raw0[b.id] ?? raw0[Object.keys(BAIT_ALIAS).find((k) => BAIT_ALIAS[k] === b.id && raw0[k] !== undefined)];
        if (typeof n === 'number' && isFinite(n) && n > 0) stock[b.id] = Math.max(0, Math.floor(n));
      } else if (out.owned.bait.includes(b.id)) {
        stock[b.id] = packOf(b.id);
      }
    }
    const total = Object.values(stock).reduce((a, n) => a + n, 0);
    if (total <= 0) {
      // 全部切らしていたら詰まないようにミミズだけ配る（ショップでも 0G）
      stock.worm = packOf('worm');
      out.gear.bait = 'worm';
    } else if (!(stock[out.gear.bait] > 0)) {
      // 装備中のエサが切れていたら、在庫のある一番安いエサに持ち替える
      out.gear.bait = BAITS.filter((b) => stock[b.id] > 0).sort((a, b) => a.price - b.price)[0].id;
    }
    out.baitStock = stock;
    // 旧セーブ（seed を持たない）は、これまでと同じ湖を保つ
    if (data.seed === undefined || data.seed === null) out.seed = LEGACY_SEED;
    else if (typeof data.seed !== 'number' || !isFinite(data.seed)) out.seed = null;
    return out;
  } catch (e) {
    console.warn('セーブデータの読み込みに失敗しました', e);
    return base;
  }
}

let pending = null;
export function save(state) {
  // 連続呼び出しをまとめる
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('セーブに失敗しました', e);
    }
  }, 400);
}

export function saveNow(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) { /* noop */ }
}

export function wipe() {
  try {
    localStorage.removeItem(KEY);
  } catch (e) { /* noop */ }
}

function uniq(a) {
  return [...new Set(a)];
}

/** レベルアップに必要な累積XP */
export function xpForLevel(level) {
  return Math.round(55 * Math.pow(level, 1.42));
}
