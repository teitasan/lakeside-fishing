/* ===========================================================
   魚テクスチャ（種ごとの AI 生成画像・低解像）

   assets/fish/{id}.webp を読み、3D の map と図鑑アイコンに使う。
   甲殻類・ゴミ・アルビノは貼らない。
   =========================================================== */
import * as THREE from 'three';
import { REAL_FISH } from './data.js';

const CRUST = new Set(['shrimp', 'crayfish', 'crab']);

/** 体メッシュ用テクスチャを持つ種（甲殻類以外の生きもの） */
export const FISH_TEX_IDS = REAL_FISH
  .filter((sp) => !CRUST.has(sp.shape))
  .map((sp) => sp.id);

const TEX_URL = (id) => `./assets/fish/${id}.webp`;

/** THREE.Texture キャッシュ */
const texCache = new Map();
/** HTMLImageElement キャッシュ（図鑑 2D 用） */
const imgCache = new Map();

let preloadPromise = null;

function prepTexture(tex) {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 2; // 低解像なので異方性は控えめ
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** 起動時に全魚種分を読む */
export function preloadFishTextures() {
  if (preloadPromise) return preloadPromise;
  const loader = new THREE.TextureLoader();
  preloadPromise = Promise.all(FISH_TEX_IDS.map((id) => Promise.all([
    new Promise((resolve) => {
      loader.load(TEX_URL(id), (tex) => {
        texCache.set(id, prepTexture(tex));
        resolve(tex);
      }, undefined, () => {
        console.warn('魚テクスチャの読み込みに失敗:', id);
        resolve(null);
      });
    }),
    new Promise((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => { imgCache.set(id, img); resolve(img); };
      img.onerror = () => {
        console.warn('魚テクスチャ画像の読み込みに失敗:', id);
        resolve(null);
      };
      img.src = TEX_URL(id);
    }),
  ])));
  return preloadPromise;
}

/** 3D 用 Texture（未ロードなら null） */
export function fishTexture(id) {
  return texCache.get(id) || null;
}

/** 図鑑 2D 用 Image（未ロードなら null） */
export function fishTextureImage(id) {
  return imgCache.get(id) || null;
}

/** ヒレなど模様を乗せたくない部品用 UV（テクスチャ腹側・明るい帯） */
export const FIN_UV = { u: 0.5, v: 0.08 };

/**
 * 貼るテクスチャの id。種 id そのもの。
 * 甲殻類・ゴミ・アルビノは null
 */
export function textureTypeFor(sp, _look = null, albino = false) {
  if (albino || !sp || sp.rarity === 0) return null;
  if (CRUST.has(sp.shape)) return null;
  return sp.id;
}
