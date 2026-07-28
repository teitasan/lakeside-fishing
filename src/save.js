/* ===========================================================
   セーブデータ（localStorage）
   =========================================================== */

import { BAITS, BAIT_ALIAS } from './data.js';

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
    clock: 5.6, // 夜明け前スタート
    rigDepth: 2.0, // 狙う層（タナ）m。プレイヤーが上下キーで決める
    seed: null, // 湖のシード（null = 起動時にランダムで決める）
    gear: { rod: 'bamboo', line: 'nylon', bait: 'worm' },
    owned: { rod: ['bamboo'], line: ['nylon'], bait: ['worm'] },
    records: {}, // id -> {count, maxLen, maxWeight}
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
    out.achievements = Array.isArray(data.achievements) ? data.achievements : [];
    for (const k of ['money', 'xp', 'level', 'totalCaught', 'totalEarned', 'maxLen', 'clock', 'rigDepth']) {
      if (typeof out[k] !== 'number' || !isFinite(out[k])) out[k] = base[k];
    }
    // ルアー廃止（spoon/frog/crank）：装備・所持を対応するエサに読み替える
    const baitIds = new Set(BAITS.map((b) => b.id));
    const toBait = (id) => (baitIds.has(id) ? id : BAIT_ALIAS[id]);
    out.gear.bait = toBait(out.gear.bait) || base.gear.bait;
    out.owned.bait = uniq(out.owned.bait.map(toBait).filter(Boolean));
    if (!out.owned.bait.includes(out.gear.bait)) out.owned.bait.push(out.gear.bait);
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
