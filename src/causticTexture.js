/* ===========================================================
   コースティクス網目テクスチャ（起動時に一度だけ生成）

   フラグメントで fbm を何枚も回すのをやめ、ボロノイ境界の明線を
   焼いたタイル可能テクスチャを 2 枚スクロールさせて干渉させる。
   RGB に微妙にずらした同じ模様を入れておくので、掛け合わせるだけで
   色収差（波長で焦点距離が違うために出る虹色の縁）が付いてくる。
   =========================================================== */
import * as THREE from 'three';
import { makeTileableCausticField } from './tileableNoise.js?v=20260828-caustnet2';

const DISPERSION = 0.85;   // texel 単位の色ずれ

export function createCausticTexture(size = 256) {
  const field = makeTileableCausticField(size, 0xca05713d, {
    cells: 7,
    ridge: 0.30,
    sharpness: 1.7,
    jitter: 0.94,
    layers: 2,
  });
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      data[i] = Math.round(field(x + DISPERSION, y + DISPERSION) * 255);
      data[i + 1] = Math.round(field(x, y) * 255);
      data[i + 2] = Math.round(field(x - DISPERSION, y - DISPERSION) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
