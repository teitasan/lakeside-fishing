/* ===========================================================
   コースティクステクスチャ（起動時に一度だけ生成）

   フラグメントで fbm を何枚も回すのをやめ、屈折写像の「折り目」を焼いた
   タイル可能テクスチャを 2 枚スクロールさせて重ねる。
   折り目は長く伸びた曲線とカスプになるので、ボロノイの稜線や帯域制限
   ノイズの等高線のように「セルの格子」が水中に見えることがない。
   RGB には焦点距離をずらした同じ模様が入っているので色収差付き。
   理屈は makeTileableFoldCaustics のコメントに書いた。
   =========================================================== */
import * as THREE from 'three';
import { makeTileableFoldCaustics } from './tileableNoise.js?v=20260828-caustnet3';

/* 512 / frequency 14 で 1 タイル ≈ 9.5m（uCaustScale = 0.105）、
   つまりリップルの波長 ≈ 68cm、明線の太さ ≈ 数cm になる。
   256 まで落とすと明線がテクセル未満になり、遠景でギラつく砂目に化ける */
export const CAUSTIC_TEX_SIZE = 512;

export function createCausticTexture(size = CAUSTIC_TEX_SIZE) {
  const { data } = makeTileableFoldCaustics(size, 0x9101c5, {
    frequency: 14,
    second: 0.35,
    focus: 0.75,
    softness: 0.34,
    sharpen: 1.5,
    dispersion: 0.05,
    modulation: 0.45,
    modFrequency: 2,
    stencil: 4,
  });
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
