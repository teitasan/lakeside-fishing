/* ===========================================================
   地形図鑑サムネイル（AI 生成の断面イラスト）
   assets/terrain/{id}.webp
   =========================================================== */
import { TERRAIN_KINDS } from './data.js';

const TEX_URL = (id) => `./assets/terrain/${id}.webp`;

/** HTMLImageElement キャッシュ */
const imgCache = new Map();
let preloadPromise = null;

/** 起動時に全地形分を読む */
export function preloadTerrainIcons() {
  if (preloadPromise) return preloadPromise;
  preloadPromise = Promise.all(TERRAIN_KINDS.map((k) => new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { imgCache.set(k.id, img); resolve(img); };
    img.onerror = () => {
      console.warn('地形図鑑画像の読み込みに失敗:', k.id);
      resolve(null);
    };
    img.src = TEX_URL(k.id);
  })));
  return preloadPromise;
}

/** 図鑑 2D 用 Image（未ロードなら null） */
export function terrainIconImage(id) {
  return imgCache.get(id) || null;
}
