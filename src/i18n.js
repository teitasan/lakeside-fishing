/* ===========================================================
   多言語（日本語既定 / 英語）
   ------------------------------------------------------------
   表示文言は locales/*.js。data.js の日本語フィールドは ja 時の本体、
   en 時は locales/en.js の同 id を優先する。
   =========================================================== */
import en from './locales/en.js';
import ja from './locales/ja.js';

const catalogs = { ja, en };
let lang = 'ja';
const listeners = new Set();

export function getLang() {
  return lang;
}

export function isEn() {
  return lang === 'en';
}

/** 言語を切り替えて DOM 静的文言を張り直し、購読者へ通知 */
export function setLang(next) {
  const n = next === 'en' ? 'en' : 'ja';
  if (n === lang) {
    applyDom();
    return lang;
  }
  lang = n;
  try {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = catalogs[lang].meta?.docLang || lang;
    }
  } catch (e) { /* noop */ }
  try {
    if (typeof document !== 'undefined') {
      document.title = t('ui.documentTitle');
    }
  } catch (e) { /* noop */ }
  applyDom();
  for (const fn of listeners) {
    try { fn(lang); } catch (e) { console.error(e); }
  }
  return lang;
}

export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function dig(obj, path) {
  let v = obj;
  for (const p of String(path).split('.')) {
    if (v == null) return undefined;
    v = v[p];
  }
  return v;
}

function interpolate(s, vars) {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, k) => (
    vars[k] != null ? String(vars[k]) : `{${k}}`
  ));
}

/** UI キー（例: 'ui.toast.welcome'）を現在言語で返す */
export function t(key, vars) {
  let v = dig(catalogs[lang], key);
  if (v == null && lang !== 'ja') v = dig(catalogs.ja, key);
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return key;
  return interpolate(v, vars);
}

/** リスト結合（日本語は「・」、英語は ", "） */
export function joinList(parts) {
  return parts.filter((x) => x != null && x !== '').join(t('ui.toast.joinDot'));
}

function enField(table, id, field) {
  return dig(en, `${table}.${id}.${field}`);
}

export function speciesName(sp) {
  if (!sp) return '';
  if (lang === 'en') return enField('species', sp.id, 'name') || sp.name;
  return sp.name;
}

export function speciesFlavor(sp) {
  if (!sp) return '';
  if (lang === 'en') return enField('species', sp.id, 'flavor') || sp.flavor || '';
  return sp.flavor || '';
}

function gearTableFor(it) {
  if (!it) return null;
  if (dig(en, `rods.${it.id}`)) return 'rods';
  if (dig(en, `lines.${it.id}`)) return 'lines';
  if (dig(en, `baits.${it.id}`)) return 'baits';
  return null;
}

export function gearName(it) {
  if (!it) return '';
  if (lang === 'en') {
    const table = gearTableFor(it);
    if (table) return enField(table, it.id, 'name') || it.name;
  }
  return it.name;
}

export function gearDesc(it) {
  if (!it) return '';
  if (lang === 'en') {
    const table = gearTableFor(it);
    if (table) return enField(table, it.id, 'desc') || it.desc || '';
  }
  return it.desc || '';
}

export function terrainName(tr) {
  if (!tr) return '';
  if (lang === 'en') return enField('terrain', tr.id, 'name') || tr.name;
  return tr.name;
}

export function terrainRule(tr) {
  if (!tr) return '';
  if (lang === 'en') return enField('terrain', tr.id, 'rule') || tr.rule || '';
  return tr.rule || '';
}

export function terrainDesc(tr) {
  if (!tr) return '';
  if (lang === 'en') return enField('terrain', tr.id, 'desc') || tr.desc || '';
  return tr.desc || '';
}

export function terrainFish(tr) {
  if (!tr) return '';
  if (lang === 'en') return enField('terrain', tr.id, 'fish') || tr.fish || '';
  return tr.fish || '';
}

export function achievementName(a) {
  if (!a) return '';
  if (lang === 'en') return enField('achievements', a.id, 'name') || a.name;
  return a.name;
}

export function achievementDesc(a) {
  if (!a) return '';
  if (lang === 'en') return enField('achievements', a.id, 'desc') || a.desc || '';
  return a.desc || '';
}

export function fightName(fp) {
  if (!fp) return '';
  if (lang === 'en') return dig(en, `fight.${fp.id}.name`) || fp.name;
  return fp.name;
}

export function fightHint(fp) {
  if (!fp) return '';
  if (lang === 'en') return dig(en, `fight.${fp.id}.hint`) || fp.hint || '';
  return fp.hint || '';
}

export function rigName(layer) {
  if (!layer) return '';
  if (lang === 'en') return dig(en, `rig.${layer.id}.name`) || layer.name;
  return layer.name;
}

export function rigShort(layer) {
  if (!layer) return '';
  if (lang === 'en') return dig(en, `rig.${layer.id}.short`) || layer.short || '';
  return layer.short || '';
}

export function rigDesc(layer) {
  if (!layer) return '';
  if (lang === 'en') return dig(en, `rig.${layer.id}.desc`) || layer.desc || '';
  return layer.desc || '';
}

export function rarityLabel(keyOrSp) {
  const key = typeof keyOrSp === 'object' ? keyOrSp.rarity : keyOrSp;
  if (lang === 'en') return dig(en, `rarity.${key}`) || String(key);
  return dig(ja, `rarity.${key}`) || String(key);
}

export function tagLabel(tag) {
  if (lang === 'en') return dig(en, `tags.${tag}`) || tag;
  return dig(ja, `tags.${tag}`) || tag;
}

export function bedLabel(bed) {
  if (lang === 'en') return dig(en, `bed.${bed}`) || bed;
  return dig(ja, `bed.${bed}`) || bed;
}

export function weatherName(w) {
  const key = typeof w === 'object' ? w.key : w;
  if (lang === 'en') return dig(en, `weather.${key}.name`) || key;
  return dig(ja, `weather.${key}.name`) || (typeof w === 'object' ? w.name : key);
}

export function terrainGroupLabel(g) {
  if (lang === 'en') return dig(en, `terrainGroups.${g}`) || g;
  return dig(ja, `terrainGroups.${g}`) || g;
}

export function gearKindLabel(kind) {
  if (lang === 'en') return dig(en, `gearKind.${kind}`) || kind;
  return dig(ja, `gearKind.${kind}`) || kind;
}

export function structLabel(kind) {
  if (lang === 'en') return dig(en, `struct.${kind}`) || kind;
  return dig(ja, `struct.${kind}`) || kind;
}

export function dirLabel(key) {
  if (lang === 'en') return dig(en, `dir.${key}`) || key;
  return dig(ja, `dir.${key}`) || key;
}

export function timeShort(band) {
  return t(`timeShort.${band}`);
}

export function weatherShort(key) {
  return t(`weatherShort.${key}`);
}

export function layerShort(id) {
  return t(`layerShort.${id}`);
}

export function prefixWord(key) {
  return t(`prefix.${key}`);
}

export function fishCount(n) {
  return t('ui.journal.countFish', { n });
}

/** data-i18n / data-i18n-html / data-i18n-title を現在言語で反映 */
export function applyDom(root) {
  if (typeof document === 'undefined') return;
  const scope = root || document;
  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (!key) return;
    const val = t(key);
    if (val !== key) el.textContent = val;
  });
  scope.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const key = el.getAttribute('data-i18n-html');
    if (!key) return;
    const val = t(key);
    if (val !== key) el.innerHTML = val;
  });
  scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    if (!key) return;
    const val = t(key);
    if (val !== key) el.setAttribute('title', val);
  });
  scope.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const key = el.getAttribute('data-i18n-aria');
    if (!key) return;
    const val = t(key);
    if (val !== key) el.setAttribute('aria-label', val);
  });
  scope.querySelectorAll('option[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (!key) return;
    const val = t(key);
    if (val !== key) el.textContent = val;
  });
}
