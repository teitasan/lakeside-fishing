/* ===========================================================
   UI / 装備アイコン（assets/icons/*.webp）
   =========================================================== */

export const ICON_DIR = './assets/icons/';

const cache = new Map();

/** @param {string} id 拡張子なし（例: 'rod-bamboo'） */
export function iconSrc(id) {
  return `${ICON_DIR}${id}.webp`;
}

/** <img> HTML。トーストやショップ見出し用 */
export function iconHtml(id, cls = 'ico') {
  return `<img class="${cls}" src="${iconSrc(id)}" alt="" width="20" height="20" decoding="async" draggable="false">`;
}

export function iconLabel(id, text, cls = 'ico') {
  return `${iconHtml(id, cls)}${text ? ` ${text}` : ''}`;
}

/** キャンバス描画用。初回は読み込み開始だけして返す */
export function loadIcon(id) {
  let img = cache.get(id);
  if (img) return img;
  img = new Image();
  img.decoding = 'async';
  img.src = iconSrc(id);
  cache.set(id, img);
  return img;
}

/** よく使うアイコンを先読み */
export function preloadIcons(ids) {
  for (const id of ids) loadIcon(id);
}

export const JUNK_ICONS = {
  boot: 'junk-boot',
  can: 'junk-can',
  weeds: 'junk-weeds',
  driftwood: 'junk-driftwood',
};
