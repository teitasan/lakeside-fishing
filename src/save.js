/* ===========================================================
   セーブデータ（localStorage）
   =========================================================== */

const KEY = 'lakeside-fishing-save-v1';

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
    gear: { rod: 'bamboo', line: 'nylon', bait: 'worm' },
    owned: { rod: ['bamboo'], line: ['nylon'], bait: ['worm'] },
    records: {}, // id -> {count, maxLen, maxWeight}
    achievements: [],
    settings: { volume: 0.7, sens: 1.0, quality: 'mid', shadow: true },
  };
}

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
    for (const k of ['money', 'xp', 'level', 'totalCaught', 'totalEarned', 'maxLen', 'clock']) {
      if (typeof out[k] !== 'number' || !isFinite(out[k])) out[k] = base[k];
    }
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
