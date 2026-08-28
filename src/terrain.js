/* ===========================================================
   地形・湖底・岸辺の装飾・桟橋
   =========================================================== */
import * as THREE from 'three';
import { CAUSTICS_GLSL } from './shaders.js?v=20260828-snellwin2';
import { waveGLSL } from './waveField.js?v=20260828-lakescale1';
import { UnderwaterPropScatter, addUnderwaterCaustics, patchUwMaterial } from './underwaterProps.js?v=20260828-waterplants6';
import { WaterPlants, buildSubmergedTuft } from './waterPlants.js?v=20260828-waterplants6';
import { makeRng, clamp, clamp01, lerp, smoothstep, TAU, lineSagProfile } from './util.js';
import { makeTileableHeightField } from './tileableNoise.js?v=20260827-orgnoise4';
import { TreeSet, VARIANTS as TREE_VARIANTS } from './trees.js?v=20260828-vegetation3';
import { SPECIES_IDS } from './treeSkeleton.js?v=20260828-vegetation3';
import { WORLD_SIZE, WATER_REGION, MAX_DEPTH, resolveLake } from './lakefield.js';

export { WORLD_SIZE, WATER_REGION, MAX_DEPTH };

const DOCK_HALF_W = 1.62;   // 床の半幅（見た目 3.4m のうち内側）
const OBS_CELL = 8;         // 障害物グリッドのセルサイズ(m)
const DOCK_WOOD_TILE = 0.62; // 桟橋テクスチャ 1 枚ぶんの実寸 (m)

/** BoxGeometry（1 セグメント）の各面 UV を実寸 / tile でスケールする */
function scaleBoxUVs(geo, width, height, depth, tile = DOCK_WOOD_TILE) {
  const uv = geo.attributes.uv;
  const faceWH = [
    [depth, height], [depth, height],
    [width, depth], [width, depth],
    [width, height], [width, height],
  ];
  for (let f = 0; f < 6; f++) {
    const uScale = faceWH[f][0] / tile;
    const vScale = faceWH[f][1] / tile;
    for (let i = 0; i < 4; i++) {
      const idx = f * 4 + i;
      uv.setXY(idx, uv.getX(idx) * uScale, uv.getY(idx) * vScale);
    }
  }
  uv.needsUpdate = true;
}

/** 杭テクスチャの縦木目を、箱の長辺へ回す */
function swapBoxUVs(geo) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getY(i), uv.getX(i));
  uv.needsUpdate = true;
}

function scaleCylinderUVs(geo, radius, height, tile = DOCK_WOOD_TILE) {
  const uv = geo.attributes.uv;
  const uScale = (Math.PI * 2 * radius) / tile;
  const vScale = height / tile;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * uScale, uv.getY(i) * vScale);
  }
  uv.needsUpdate = true;
}

function makeDockWoodMat(map, fallbackColor, roughness, causticsUniforms, cacheKey, mapTint = 0xffffff) {
  return addUnderwaterCaustics(
    new THREE.MeshStandardMaterial({
      map: map || null,
      color: map ? mapTint : fallbackColor,
      roughness,
    }),
    causticsUniforms,
    cacheKey
  );
}

/** InstancedMesh の Y スケールを UV.y に乗せる（杭の高さごとに木目が伸びないように） */
function withInstanceUvY(mat, cacheKey) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader) => {
    if (typeof prev === 'function') prev(shader);
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
#ifdef USE_MAP
#ifdef USE_INSTANCING
        vMapUv.y *= length(instanceMatrix[1].xyz);
#endif
#endif`
    );
  };
  const prevKey = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () =>
    `${typeof prevKey === 'function' ? prevKey() : cacheKey}-inst-uvy`;
  return mat;
}

const tmpColor = new THREE.Color();
const tmpSand = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const _dl = { al: 0, si: 0 };
const _dl2 = { al: 0, si: 0 };

/* ===========================================================
   渚の濡れ砂

   乾いた砂と水中の砂が同じアルベドで直結していると、水際が
   「紙を切って貼った」ように見える。ここでは
     ・いま水を被っている帯（遡上に追従して前後する）
     ・引き波が置いていった泡の名残
     ・毛管上昇でいつも湿っている帯
   の 3 段を作る。判定は水面シェーダと同じ高さテクスチャ基準なので、
   汀線の位置が水と地形でずれない。
   =========================================================== */
const SHORE_WET_GLSL = /* glsl */ `
uniform sampler2D uShoreHeightTex;
uniform float uShoreRegion;
uniform float uShoreTime;
uniform float uShoreWind;
uniform float uShoreTop;

${waveGLSL({ prefix: 'sw' })}

float shoreHash(vec2 p) {
  p = fract(p * vec2(127.31, 311.71));
  p += dot(p, p + 41.23);
  return fract(p.x * p.y);
}

float shoreNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = shoreHash(i);
  float b = shoreHash(i + vec2(1.0, 0.0));
  float c = shoreHash(i + vec2(0.0, 1.0));
  float d = shoreHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/* color / roughness / normal の 3 か所で使い回すので 1 回だけ評価する */
vec3 gShoreWet = vec3(0.0);

/** x = 濡れ具合 0..1、y = 泡の名残 0..1、z = 渚バンド（砂の作り込み用） */
vec3 shoreWetness(vec3 wp) {
  vec2 uv = clamp(wp.xz / uShoreRegion + 0.5, vec2(0.0005), vec2(0.9995));
  float ground = texture2D(uShoreHeightTex, uv).r;
  // 渚バンドの外（山側・深場）は何もしない
  float band = smoothstep(-0.60, -0.12, ground)
             * (1.0 - smoothstep(uShoreTop * 2.2, uShoreTop * 4.5, ground));
  if (band < 0.002) return vec3(0.0);
  // 陸側だけを濡らす（水中側は水シェーダの減衰が担当する）
  float onLand = smoothstep(-0.14, 0.02, ground);
  float now = swShoreRunUp(wp.xz, uShoreTime) * uShoreWind;
  float past = max(now, swShoreRunUp(wp.xz, uShoreTime - 2.1) * uShoreWind);
  float wetNow = smoothstep(0.035, -0.035, ground - now);
  float wetPast = smoothstep(0.09, -0.09, ground - past);
  // 毛管上昇の上端はノイズで崩す（真横一直線の境目にしない）
  float top = uShoreTop * (0.62 + 0.76 * shoreNoise(wp.xz * 0.42));
  float capillary = 1.0 - smoothstep(0.0, top, max(ground, 0.0));
  float wet = clamp(max(wetNow, wetPast * 0.82) + capillary * 0.34, 0.0, 1.0) * onLand;
  /* 引き波が残した泡：いま水が無いところにだけ、まばらなレースで乗る。
     ここを広く強く塗ると砂浜が白い斑（牛柄）になるので、面積も濃さも絞る。
     遡上が届いた上端ほど泡が残るので、そこへ寄せる */
  float laceLod = 1.0 - smoothstep(6.0, 24.0, length(wp - cameraPosition));
  float lace = smoothstep(0.60, 0.88, shoreNoise(wp.xz * 5.5))
             * mix(0.20, 1.0, smoothstep(0.42, 0.82, shoreNoise(wp.xz * 13.0)))
             * mix(0.55, 1.0, laceLod);
  float atReach = mix(0.30, 1.0, smoothstep(0.12, 0.0, abs(ground - past)));
  float residue = clamp(wetPast - wetNow, 0.0, 1.0) * lace * onLand * atReach;
  return vec3(wet, residue, band);
}

/**
 * 渚の砂を「無地」から救う。粒のムラ、満潮線の漂着物、濡れによる暗色化、
 * 引き波が残した泡の 4 段を、乾いた砂側だけに乗せる。
 */
vec3 shoreDress(vec3 base, vec3 wp, float under) {
  vec3 sw = gShoreWet;
  if (sw.z < 0.002) return base;
  float dry = sw.z * (1.0 - under);
  /* 手続きノイズには mipmap が無いので、遠景では 1 px より細かい模様が
     エイリアスして大きな斑（牛柄）になる。距離で帯域を落とす */
  float lod = 1.0 - smoothstep(5.0, 20.0, length(wp - cameraPosition));
  float fine = dry * lod;
  // 砂の粒ムラ
  float grain = shoreNoise(wp.xz * 6.0) * 0.6 + shoreNoise(wp.xz * 1.8) * 0.4;
  base *= mix(1.0, mix(0.965, 1.035, grain), fine);
  // 小石：まばらな明暗の点（強くすると牛柄になるので控えめに）
  float peb = smoothstep(0.90, 0.99, shoreNoise(wp.xz * 3.2 + 13.7));
  base = mix(base, base * mix(0.88, 1.10, shoreNoise(wp.xz * 9.0)), peb * fine * 0.30);
  // 満潮線に残る漂着物のすじ
  float wrack = smoothstep(0.60, 0.86, shoreNoise(wp.xz * 2.7))
              * smoothstep(0.26, 0.04, abs(wp.y - uShoreTop * 1.2)) * dry;
  base = mix(base, vec3(0.30, 0.26, 0.19), wrack * 0.45);
  // 濡れた砂は暗く濃くなる（これが無いと水際が紙を貼ったように見える）
  base *= mix(1.0, 0.66, sw.x);
  // 引き波が置いていった泡
  base = mix(base, vec3(0.88, 0.91, 0.92), sw.y * 0.32);
  return base;
}
`;

/** 湖底のmicro normal・roughness・色ムラを1枚にまとめたタイルテクスチャ。 */
function createBedDetailTexture() {
  const size = 128;
  const height = makeTileableHeightField(size, 0xbed0421, {
    octaves: 4,
    baseFrequency: 9,
    secondaryFrequency: 15,
    secondaryMix: 0.4,
    gain: 0.48,
    amplitude: 3.6,
  });
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const h = height(x, y);
      const sx = (height(x + 1, y) - height(x - 1, y)) * 0.72;
      const sz = (height(x, y + 1) - height(x, y - 1)) * 0.72;
      const i = (y * size + x) * 4;
      data[i] = Math.round(clamp01(sx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round(clamp01(sz * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round(clamp01(h * 0.42 + 0.5) * 255);
      data[i + 3] = Math.round(clamp01(0.5 + h * 0.34) * 255);
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

/**
 * 植生マテリアルに風揺れを注入する。
 *
 * 揺れは 2 帯域に分ける。
 *   bend    株ごとに位相が決まる大きなしなり。根元は動かず先端ほど曲がる。
 *           幹・枝と葉に「同じ式」を掛けるのが肝で、葉だけ動かすと
 *           近くで見たとき葉が枝から剥がれて浮いているように見える。
 *   flutter 葉カードごとに位相が違う細かい震え（aFlutter 属性が要る）。
 *           こちらは葉だけに掛ける。
 *
 * インスタンス座標を bend の位相源にするので、追加ジオメトリも CPU 更新も要らない。
 *
 * @param {THREE.Material} mat
 * @param {{strength?: number, freq?: number, gustiness?: number,
 *          bendPow?: number, flutter?: number, flutterFreq?: number}} opts
 *   bendPow  1 で高さに比例（草・葦）。木の幹は根元が硬いので 1.6 前後にすると
 *            «下は動かず梢だけ大きく揺れる» 曲がり方になる
 *   flutter  0 で無効。>0 なら aFlutter 属性を位相にした細かい震えを足す
 */
function addWindSway(mat, {
  strength = 0.06,     // 先端の最大振れ幅（ローカル単位）
  freq = 1.6,          // 基本の揺れ速さ
  gustiness = 0.5,     // 突風の強さ（0 で一定風）
  bendPow = 1,         // 高さ方向の効き。>1 で根元が硬くなる
  flutter = 0,         // 葉のこまかい震え
  flutterFreq = 3.1,
} = {}) {
  const useFlutter = flutter > 0;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = { value: 0 };
    shader.uniforms.uWindStrength = { value: strength };
    shader.uniforms.uWindGust = { value: gustiness };
    shader.uniforms.uWindFlutter = { value: flutter };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uWindTime;
        uniform float uWindStrength;
        uniform float uWindGust;
        uniform float uWindFlutter;
        ${useFlutter ? 'attribute float aFlutter;' : ''}`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          // ローカルの高さ（幹・葉とも原点が根元なので y のみで良い）
          float swayH = clamp(transformed.y, 0.0, 8.0);
          float swayW = ${bendPow === 1 ? 'swayH' : `pow(swayH, ${bendPow.toFixed(2)})`};
          // インスタンス位置で位相をずらす（隣の木が同じタイミングで揺れない）
          vec3 ipos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float phase = dot(ipos.xz, vec2(0.71, 0.53));
          // 全体をなびかせる風 + 局所的なそよぎ
          float g = 1.0 + uWindGust * sin(uWindTime * 0.9 + phase * 0.35) * sin(uWindTime * 2.13 + phase);
          float w1 = sin(uWindTime * ${freq.toFixed(2)} + phase);
          float w2 = sin(uWindTime * ${(freq * 2.37).toFixed(2)} + phase * 1.7 + 1.3);
          transformed.x += (w1 * 0.7 + w2 * 0.3) * g * uWindStrength * swayW;
          transformed.z += (w2 * 0.7 - w1 * 0.3) * g * uWindStrength * swayW * 0.62;
${useFlutter ? `          /* 葉カードごとの震え。位相は房ごとに固定なので、
             1 枚のカードが引き延ばされずに丸ごと動く */
          float fa = aFlutter;
          float f1 = sin(uWindTime * ${flutterFreq.toFixed(2)} + fa);
          float f2 = sin(uWindTime * ${(flutterFreq * 1.73).toFixed(2)} + fa * 2.3);
          float fw = uWindFlutter * g * mix(0.35, 1.0, swayH);
          transformed.x += (f1 * 0.7 + f2 * 0.3) * fw;
          transformed.y += sin(uWindTime * ${(flutterFreq * 0.81).toFixed(2)} + fa * 1.9) * fw * 0.55;
          transformed.z += (f2 * 0.7 - f1 * 0.3) * fw;` : ''}
        }`
      );
    mat.userData.windUniforms = shader.uniforms;
  };
  mat.customProgramCacheKey = () =>
    `wind-sway-${strength}-${freq}-${gustiness}-${bendPow}-${flutter}-${flutterFreq}`;
  mat.userData._windBase = strength;
  mat.userData._flutterBase = flutter;
  return mat;
}

/** 風の時刻を進める（terrain.updateLamp などから毎フレーム呼ぶ） */
export function tickVegetationWind(list, t, windPow = 1) {
  for (const m of list) {
    const u = m.userData?.windUniforms;
    if (!u || !u.uWindTime) continue;   // 初回コンパイル前
    u.uWindTime.value = t;
    if (u.uWindStrength) u.uWindStrength.value = m.userData._windBase * windPow;
    if (u.uWindFlutter) u.uWindFlutter.value = m.userData._flutterBase * windPow;
  }
}

/** 線分 vs AABB（スラブ法） */
function segBoxHit(p0, p1, min, max) {
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 3; i++) {
    const d = p1[i] - p0[i];
    if (Math.abs(d) < 1e-9) {
      if (p0[i] < min[i] || p0[i] > max[i]) return false;
      continue;
    }
    let ta = (min[i] - p0[i]) / d, tb = (max[i] - p0[i]) / d;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * 水中の立ち枯れ（ローポリ）。
 * 歪んだ幹・折れた梢・枝・根張りで「沈んだ枯れ木」に見せる。
 */
function makeSnagGroup(t, bedY, woodMat, tipMat) {
  const g = new THREE.Group();
  const h = t.h;
  const r0 = t.r * 0.52;
  const v = t.v;

  // 幹：下太・上細、途中でいびつ、梢は折れて尖る
  const trunkPts = [];
  for (let i = 0; i <= 11; i++) {
    const u = i / 11;
    let rad = r0 * lerp(1.25, 0.38, Math.pow(u, 0.85));
    rad *= 1 + Math.sin(u * 17 + v * 9) * 0.1 + Math.sin(u * 5 + 2) * 0.05;
    if (u > 0.82) rad *= lerp(1, 0.12 + v * 0.18, (u - 0.82) / 0.18);
    trunkPts.push(new THREE.Vector2(Math.max(0.025, rad), u * h));
  }
  const trunk = new THREE.Mesh(new THREE.LatheGeometry(trunkPts, 7), woodMat);
  g.add(trunk);

  // 折れた梢の破片（斜めに刺さった感じ）
  const tip = new THREE.Mesh(new THREE.ConeGeometry(r0 * 0.32, h * 0.14, 5), tipMat);
  tip.position.set(r0 * 0.08, h * 0.97, -r0 * 0.05);
  tip.rotation.set(0.35 + v * 0.4, v * 2.1, -0.25);
  g.add(tip);

  // 枝：幹の中腹〜上から外へ伸び、先は折れている
  const nBranch = 4 + (v > 0.55 ? 1 : 0);
  for (let k = 0; k < nBranch; k++) {
    const along = 0.32 + (k / Math.max(1, nBranch - 1)) * 0.52;
    const len = h * (0.28 + (1 - k / nBranch) * 0.32 + (v % 0.3) * 0.15);
    const br = r0 * (0.42 - k * 0.04);
    const ba = k * (TAU / nBranch) + v * 1.7;
    const pitch = 0.75 + (k % 3) * 0.22 + v * 0.15;

    const bPts = [];
    for (let i = 0; i <= 6; i++) {
      const u = i / 6;
      let rad = br * (1 - u * 0.72);
      if (u > 0.78) rad *= 0.35; // 折れた先端
      bPts.push(new THREE.Vector2(Math.max(0.015, rad), u * len));
    }
    const branch = new THREE.Mesh(new THREE.LatheGeometry(bPts, 5), woodMat);
    const trunkR = r0 * lerp(1.1, 0.4, along);
    branch.position.set(Math.cos(ba) * trunkR * 0.65, along * h, Math.sin(ba) * trunkR * 0.65);
    branch.quaternion.setFromEuler(new THREE.Euler(
      pitch,
      ba,
      (k % 2 === 0 ? 1 : -1) * (0.25 + v * 0.35)
    ));
    g.add(branch);

    // 小枝（半分の枝にだけ）
    if (k % 2 === 0) {
      const twLen = len * (0.28 + v * 0.12);
      const twig = new THREE.Mesh(
        new THREE.CylinderGeometry(br * 0.18, br * 0.32, twLen, 4),
        woodMat
      );
      twig.geometry.translate(0, twLen * 0.5, 0);
      twig.position.set(0, len * (0.4 + (k % 3) * 0.08), 0);
      twig.rotation.set(0.2, ba * 0.3, 1.05 + v * 0.4);
      branch.add(twig);
    }
  }

  // 根張り：底に這う短い根
  const nRoot = 3 + (v > 0.45 ? 1 : 0);
  for (let k = 0; k < nRoot; k++) {
    const ra = k * (TAU / nRoot) + v * 0.8;
    const rl = r0 * (2.0 + (k % 2) * 0.6 + v * 0.5);
    const root = new THREE.Mesh(
      new THREE.CylinderGeometry(r0 * 0.12, r0 * 0.38, rl, 5),
      woodMat
    );
    root.geometry.translate(0, rl * 0.5, 0);
    root.position.set(Math.cos(ra) * r0 * 0.35, r0 * 0.05, Math.sin(ra) * r0 * 0.35);
    root.quaternion.setFromEuler(new THREE.Euler(1.05 + (k % 2) * 0.2, ra, 0.15));
    g.add(root);
  }

  // 幹の途中に短い折れ枝の切り株
  const stub = new THREE.Mesh(
    new THREE.CylinderGeometry(r0 * 0.22, r0 * 0.28, r0 * 0.9, 5),
    tipMat
  );
  stub.geometry.translate(0, r0 * 0.45, 0);
  stub.position.set(-r0 * 0.55, h * (0.4 + v * 0.15), r0 * 0.1);
  stub.quaternion.setFromEuler(new THREE.Euler(1.2, v * 3, 0.4));
  g.add(stub);

  // 全体を少し傾ける（沈んで傾いた枯れ木）
  const lean = 0.1 + v * 0.28;
  g.rotation.set(lean * 0.35, t.rot, lean);
  g.position.set(t.x, bedY - r0 * 0.15, t.z);
  return g;
}

export class Terrain {
  /**
   * @param {THREE.Scene} scene
   * @param {object} opts  lake（lakefield.resolveLake の結果）または seed
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.quality = opts.quality || 'mid';

    // 地形の数学部分は lakefield.js（検証済みの湖）に委譲
    this.lake = opts.lake || resolveLake(opts.seed ?? 20240711).lake;
    this.seed = this.lake.seed;
    this.noise = this.lake.noise;
    this.hole = this.lake.hole;
    this.flat = this.lake.flat;
    this.dockAngle = this.lake.dock.angle;

    this.obstacles = [];        // [x, z, r, x, z, r, ...]
    this._obsGrid = new Map();

    this._buildHeightTexture();
    this.bedDetailTexture = createBedDetailTexture();
    /* 渚の濡れ砂は水面シェーダと同じ高さテクスチャ・同じ遡上式を見る */
    this._shoreUniforms = {
      uShoreHeightTex: { value: this.heightTexture },
      uShoreRegion: { value: WATER_REGION },
      uShoreTime: { value: 0 },
      uShoreWind: { value: 1 },
      uShoreTop: { value: 0.34 },
    };
    this._causticsUniforms = opts.causticsUniforms || null;
    /* 遠景インポスターを起動時に 1 回だけ焼くのに使う。無ければ中景で代用する */
    this._renderer = opts.renderer || null;
    this._dockTextures = opts.dockTextures || null;
    this._buildTerrainMesh(opts.bedTextures || null);
    this._findDock();
    this._buildDock();
    this._buildProps();
    this.underwaterProps = new UnderwaterPropScatter(this.scene, this, {
      causticsUniforms: this._causticsUniforms,
      quality: this.quality,
      // 湖底の «藻» を円錐からカードの房に差し替える（クロモと質感を揃える）
      weedGeo: buildSubmergedTuft(this.seed ^ 0x6c1b),
      weedMap: this.waterPlants?.bladeTex?.tuft || null,
    });
  }

  /** 品質変更（水中プロップの密度のみランタイム反映） */
  setQuality(q) {
    this.quality = q;
    this.underwaterProps?.setQuality(q);
    const u = this.mesh?.material?.userData?.bedUniforms;
    if (u?.uBedDetailStrength) {
      u.uBedDetailStrength.value = q === 'high' ? 0.34 : q === 'low' ? 0.16 : 0.25;
    }
  }

  /** 水中プロップ：カメラ・流れ・時刻 */
  updateUnderwaterProps(time, camera, flowDir, flowStrength) {
    this.underwaterProps?.update(time, camera, flowDir, flowStrength);
    // クロモも水中プロップと同じマテリアルなので、流れと caustics を同じ値で回す
    for (const mat of this.waterPlants?.uwMaterials || []) {
      const u = mat.userData?.uwUniforms;
      if (!u) continue;
      if (u.uUwTime) u.uUwTime.value = time;
      if (u.uUwCamPos) u.uUwCamPos.value.copy(camera.position);
      if (u.uFlowDir) u.uFlowDir.value.set(flowDir.x, flowDir.z);
      if (u.uFlowStrength) u.uFlowStrength.value = flowStrength;
    }
  }

  /** 渚の濡れ砂：水面と同じ時刻・風速を渡す（毎フレーム） */
  updateShore(time, wind) {
    const u = this._shoreUniforms;
    u.uShoreTime.value = time;
    u.uShoreWind.value = wind;
  }

  static _loadRepeatTexture(url) {
    return new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(url, (tex) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        resolve(tex);
      }, undefined, reject);
    });
  }

  /** 砂地・岩場・泥底のタイルテクスチャを読み込む */
  static loadBedTextures() {
    return Promise.all([
      Terrain._loadRepeatTexture('./assets/textures/bed-sand.webp'),
      Terrain._loadRepeatTexture('./assets/textures/bed-rock.webp'),
      Terrain._loadRepeatTexture('./assets/textures/bed-mud.webp'),
    ]).then(([sand, rock, mud]) => ({ sand, rock, mud }));
  }

  /** 桟橋の木材アルベド（床板 / 杭・桁） */
  static loadDockTextures() {
    return Promise.all([
      Terrain._loadRepeatTexture('./assets/textures/dock-plank.webp'),
      Terrain._loadRepeatTexture('./assets/textures/dock-piling.webp'),
    ]).then(([plank, piling]) => ({ plank, piling }));
  }

  /* ---------------- 高さ関数（lakefield へ委譲） ---------------- */
  shoreRadius(x, z) { return this.lake.shoreRadius(x, z); }
  heightAt(x, z) { return this.lake.heightAt(x, z); }

  depthAt(x, z) {
    return Math.max(0, -this.heightAt(x, z));
  }

  isWater(x, z) {
    return this.heightAt(x, z) < 0;
  }

  normalAt(x, z, e = 0.7) {
    const hL = this.heightAt(x - e, z), hR = this.heightAt(x + e, z);
    const hD = this.heightAt(x, z - e), hU = this.heightAt(x, z + e);
    return new THREE.Vector3(hL - hR, 2 * e, hD - hU).normalize();
  }

  slopeAt(x, z, e = 1.2) {
    const hL = this.heightAt(x - e, z), hR = this.heightAt(x + e, z);
    const hD = this.heightAt(x, z - e), hU = this.heightAt(x, z + e);
    const dx = (hR - hL) / (2 * e), dz = (hU - hD) / (2 * e);
    return Math.sqrt(dx * dx + dz * dz);
  }

  /* ---------------- 水面シェーダ用の高さテクスチャ ---------------- */
  _buildHeightTexture() {
    const N = 512;
    const data = new Float32Array(N * N);
    const half = WATER_REGION / 2;
    for (let j = 0; j < N; j++) {
      const z = (j / (N - 1)) * WATER_REGION - half;
      for (let i = 0; i < N; i++) {
        const x = (i / (N - 1)) * WATER_REGION - half;
        data[j * N + i] = this.heightAt(x, z);
      }
    }
    const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.FloatType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.heightTexture = tex;
  }

  /* ---------------- 地形メッシュ ---------------- */
  _buildTerrainMesh(bedTextures) {
    const segs = this.quality === 'low' ? 150 : this.quality === 'high' ? 260 : 210;
    const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, segs, segs);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const beds = new Float32Array(pos.count);

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = this.heightAt(x, z);
      pos.setY(i, h);
      const slope = this.slopeAt(x, z, WORLD_SIZE / segs);
      this._terrainColor(h, slope, x, z, tmpColor);
      colors[i * 3] = tmpColor.r;
      colors[i * 3 + 1] = tmpColor.g;
      colors[i * 3 + 2] = tmpColor.b;
      beds[i] = h < 0.2 ? this.lake.bedAt(x, z, slope).v : 0.5;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aBed', new THREE.BufferAttribute(beds, 1));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.94,
      metalness: 0,
      flatShading: true,
    });
    if (bedTextures) this._applyBedTextures(mat, bedTextures, this._causticsUniforms);
    else this._applyTerrainCaustics(mat, this._causticsUniforms);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.name = 'terrain';
    this.scene.add(this.mesh);
  }

  /**
   * 湖底だけ砂／岩／泥のタイルテクスチャをブレンドして貼る。
   * 陸は従来どおり頂点色のまま。
   */
  _applyBedTextures(mat, tex, causticsUniforms) {
    const uniforms = {
      uBedSand: { value: tex.sand },
      uBedRock: { value: tex.rock },
      uBedMud: { value: tex.mud },
      uBedScale: { value: 1 / 12 }, // 1 タイル ≈ 12 m
      uBedDetail: { value: this.bedDetailTexture },
      uBedDetailScale: { value: 1 / 1.8 },
      uBedDetailStrength: { value: this.quality === 'high' ? 0.34 : this.quality === 'low' ? 0.16 : 0.25 },
    };
    Object.assign(uniforms, this._shoreUniforms);
    if (causticsUniforms) Object.assign(uniforms, causticsUniforms);
    mat.userData.bedUniforms = uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute float aBed;
          varying float vBed;
          varying vec3 vBedWorldPos;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vBed = aBed;
          vBedWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          ${CAUSTICS_GLSL}
          ${SHORE_WET_GLSL}
          uniform sampler2D uBedSand;
          uniform sampler2D uBedRock;
          uniform sampler2D uBedMud;
          uniform sampler2D uBedDetail;
          uniform float uBedScale;
          uniform float uBedDetailScale;
          uniform float uBedDetailStrength;
          varying float vBed;
          varying vec3 vBedWorldPos;`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          {
            float under = smoothstep(0.12, -0.28, vBedWorldPos.y);
            if (under > 0.001) {
              vec2 uv = vBedWorldPos.xz * uBedScale;
              vec3 mudC  = texture2D(uBedMud,  uv).rgb;
              vec3 sandC = texture2D(uBedSand, uv).rgb;
              vec3 rockC = texture2D(uBedRock, uv).rgb;
              vec4 detail = texture2D(uBedDetail, vBedWorldPos.xz * uBedDetailScale);
              float v = vBed;
              float wMud  = 1.0 - smoothstep(0.28, 0.40, v);
              float wRock = smoothstep(0.62, 0.74, v);
              float wSand = max(0.0, 1.0 - wMud - wRock);
              float wSum = max(1e-4, wMud + wSand + wRock);
              vec3 bedCol = (mudC * wMud + sandC * wSand + rockC * wRock) / wSum;
              bedCol *= mix(0.88, 1.10, detail.b);
              float d = clamp(-vBedWorldPos.y / 16.0, 0.0, 1.0);
              bedCol *= mix(1.0, 0.38, d);
              diffuseColor.rgb = mix(diffuseColor.rgb, bedCol, under);
            }
            gShoreWet = shoreWetness(vBedWorldPos);
            diffuseColor.rgb = shoreDress(diffuseColor.rgb, vBedWorldPos, under);
          }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          {
            float under = smoothstep(0.12, -0.28, vBedWorldPos.y);
            vec4 detail = texture2D(uBedDetail, vBedWorldPos.xz * uBedDetailScale);
            float bedRough = mix(0.98, 0.88, smoothstep(0.28, 0.40, vBed));
            bedRough = mix(bedRough, 0.76, smoothstep(0.62, 0.74, vBed));
            bedRough = clamp(bedRough + (detail.a - 0.5) * 0.14, 0.66, 1.0);
          roughnessFactor = mix(roughnessFactor, bedRough, under);
          // 濡れた砂は鏡面が立つ。太陽が低いときの照り返しがここで出る
          roughnessFactor = mix(roughnessFactor, 0.28, gShoreWet.x * 0.85);
          }`
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          {
            float under = smoothstep(0.12, -0.28, vBedWorldPos.y);
            vec2 detailSlope = texture2D(uBedDetail, vBedWorldPos.xz * uBedDetailScale).xy * 2.0 - 1.0;
            vec3 detailView = mat3(viewMatrix) * vec3(-detailSlope.x, 0.0, -detailSlope.y);
            float detailAmt = uBedDetailStrength * max(under, gShoreWet.z * 0.28)
                            * (1.0 - gShoreWet.x * 0.65);
            normal = normalize(normal + detailView * detailAmt);
          }`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          totalEmissiveRadiance += causticLight(vBedWorldPos, normal);`
        );
    };
    mat.customProgramCacheKey = () => 'terrain-bed-tex-v6-shorewet-caustics';
  }

  /** 湖底テクスチャが使えない環境でも、頂点色の湖底へコースティクスを載せる。 */
  _applyTerrainCaustics(mat, causticsUniforms) {
    if (!causticsUniforms) return;
    mat.userData.causticsUniforms = causticsUniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this._shoreUniforms);
      Object.assign(shader.uniforms, causticsUniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vTerrainWorldPos;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vTerrainWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vTerrainWorldPos;
          ${CAUSTICS_GLSL}
          ${SHORE_WET_GLSL}`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          {
            float under = smoothstep(0.12, -0.28, vTerrainWorldPos.y);
            gShoreWet = shoreWetness(vTerrainWorldPos);
            diffuseColor.rgb = shoreDress(diffuseColor.rgb, vTerrainWorldPos, under);
          }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.28, gShoreWet.x * 0.85);`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          totalEmissiveRadiance += causticLight(vTerrainWorldPos, normal);`
        );
    };
    mat.customProgramCacheKey = () => 'terrain-vcolor-v3-shorewet-caustics';
  }

  _terrainColor(h, slope, x, z, out) {
    const n = this.noise.fbm(x * 0.09, z * 0.09, 2) * 0.5 + 0.5;
    const rocky = clamp01((slope - 0.5) * 1.6);

    if (h < -0.15) {
      /* 湖底：底質（砂地・岩場・泥底）で色を変える。
         深いほど暗く落として、水の透明度と合わせる */
      const bed = this.lake.bedAt(x, z, slope);
      const d = clamp01(-h / 16);
      const shade = lerp(1.0, 0.34, d);
      if (bed.kind === 'rock') {
        out.setRGB((0.40 + n * 0.10) * shade, (0.39 + n * 0.09) * shade, (0.36 + n * 0.08) * shade);
      } else if (bed.kind === 'sand') {
        out.setRGB((0.52 + n * 0.07) * shade, (0.46 + n * 0.06) * shade, (0.31 + n * 0.05) * shade);
      } else {
        // 泥底：砂より少し暗いベージュ（炭黒にしない）
        out.setRGB((0.42 + n * 0.06) * shade, (0.36 + n * 0.05) * shade, (0.24 + n * 0.04) * shade);
      }
      // 砂と岩の境目を少し混ぜて、パッチの縁を柔らかくする
      if (bed.v > 0.62 && bed.v < 0.74) out.multiplyScalar(0.94);
    } else if (h < 1.1) {
      // 汀線の砂浜
      const t = clamp01((h + 0.15) / 1.25);
      out.setRGB(0.52 + n * 0.07, 0.47 + n * 0.06, 0.36 + n * 0.05);
      out.lerp(tmpSand.setRGB(0.30 + n * 0.08, 0.36 + n * 0.09, 0.19), t * 0.55);
    } else {
      const t = clamp01((h - 1.1) / 22);
      // 草地 -> 深い森
      out.setRGB(
        lerp(0.24, 0.13, t) + n * 0.07,
        lerp(0.36, 0.24, t) + n * 0.09,
        lerp(0.15, 0.12, t) + n * 0.04
      );
      // 岩肌
      out.lerp(tmpSand.setRGB(0.30 + n * 0.06, 0.29 + n * 0.05, 0.27 + n * 0.05), rocky * 0.85);
      // 高山の雪
      const snow = smoothstep(58, 82, h) * (1 - clamp01(slope - 0.85));
      out.lerp(tmpSand.setRGB(0.92, 0.94, 0.98), clamp01(snow));
    }
  }

  /* ---------------- 桟橋（位置は lakefield が決定・検証済み） ---------------- */
  _findDock() {
    const d = this.lake.dock;
    const len = Math.hypot(d.end.x - d.start.x, d.end.z - d.start.z);
    this._dockU = { x: (d.end.x - d.start.x) / len, z: (d.end.z - d.start.z) / len };
    this._dockLen = len;
    this.shoreR0 = d.r0;
    this.dockDir = new THREE.Vector3(d.dir.x, 0, d.dir.z);   // 岸→湖心
    this.dockStart = new THREE.Vector3(d.start.x, 0, d.start.z);
    this.dockEnd = new THREE.Vector3(d.end.x, 0, d.end.z);
    this.dockY = d.y;
    this.spawnPos = this.dockEnd.clone().addScaledVector(this.dockDir, -3).setY(this.dockY);
  }

  _buildDock() {
    const g = new THREE.Group();
    const plankMap = this._dockTextures?.plank || null;
    const pilingMap = this._dockTextures?.piling || null;
    const woodMat = makeDockWoodMat(
      plankMap, 0x7a5b3c, 0.92, this._causticsUniforms, 'dock-wood-caustics-v1'
    );
    const woodDark = makeDockWoodMat(
      pilingMap, 0x5a4029, 0.95, this._causticsUniforms, 'dock-dark-caustics-v1', 0xc8b49a
    );
    const postMat = withInstanceUvY(
      makeDockWoodMat(
        pilingMap, 0x5a4029, 0.95, this._causticsUniforms, 'dock-post-caustics-v1', 0xc8b49a
      ),
      'dock-post-caustics-v1'
    );

    const a = this.dockStart, b = this.dockEnd;
    const len = a.distanceTo(b);
    const dir = new THREE.Vector3().subVectors(b, a).normalize();
    const yaw = Math.atan2(dir.x, dir.z);
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const W = 3.4;

    // 板（インスタンス）
    const plankCount = Math.max(6, Math.floor(len / 0.55));
    const plankGeo = new THREE.BoxGeometry(W, 0.12, 0.42);
    scaleBoxUVs(plankGeo, W, 0.12, 0.42);
    const planks = new THREE.InstancedMesh(plankGeo, woodMat, plankCount);
    planks.castShadow = true; planks.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const s = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    for (let i = 0; i < plankCount; i++) {
      const t = (i + 0.5) / plankCount;
      p.lerpVectors(a, b, t).setY(this.dockY);
      s.set(1, 1, 0.92 + (i % 3) * 0.04);
      m.compose(p, q, s);
      planks.setMatrixAt(i, m);
    }
    planks.instanceMatrix.needsUpdate = true;
    g.add(planks);

    // 縦桁
    const beamGeo = new THREE.BoxGeometry(0.22, 0.28, len);
    scaleBoxUVs(beamGeo, 0.22, 0.28, len);
    swapBoxUVs(beamGeo);
    for (const off of [-W / 2 + 0.2, W / 2 - 0.2]) {
      const beam = new THREE.Mesh(beamGeo, woodDark);
      beam.position.copy(mid).setY(this.dockY - 0.2);
      beam.position.x += Math.cos(yaw) * off;
      beam.position.z += -Math.sin(yaw) * off;
      beam.rotation.y = yaw;
      beam.castShadow = true;
      g.add(beam);
    }

    // 杭
    const postGeo = new THREE.CylinderGeometry(0.16, 0.19, 1, 7);
    scaleCylinderUVs(postGeo, 0.175, 1);
    const postRows = Math.max(2, Math.floor(len / 3.2));
    const posts = new THREE.InstancedMesh(postGeo, postMat, postRows * 2);
    posts.castShadow = true;
    let pi = 0;
    for (let i = 0; i < postRows; i++) {
      const t = (i + 0.5) / postRows;
      const base = new THREE.Vector3().lerpVectors(a, b, t);
      for (const off of [-W / 2 + 0.25, W / 2 - 0.25]) {
        const px = base.x + Math.cos(yaw) * off;
        const pz = base.z - Math.sin(yaw) * off;
        const bed = this.heightAt(px, pz);
        const bot = Math.min(bed - 0.4, this.dockY - 0.6);
        const hh = this.dockY - 0.28 - bot;
        p.set(px, bot + hh / 2, pz);
        s.set(1, hh, 1);
        m.compose(p, new THREE.Quaternion(), s);
        posts.setMatrixAt(pi++, m);
      }
    }
    posts.count = pi;
    posts.instanceMatrix.needsUpdate = true;
    g.add(posts);

    // 手すり（先端の3方向）
    const railMat = woodDark;
    const railPost = new THREE.CylinderGeometry(0.07, 0.08, 0.95, 6);
    scaleCylinderUVs(railPost, 0.075, 0.95);
    const barLen = W - 0.4;
    const railBar = new THREE.BoxGeometry(0.09, 0.09, barLen);
    scaleBoxUVs(railBar, 0.09, 0.09, barLen);
    swapBoxUVs(railBar);
    const tip = b.clone();
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const corners = [
      tip.clone().addScaledVector(right, -W / 2 + 0.2),
      tip.clone().addScaledVector(right, W / 2 - 0.2),
      tip.clone().addScaledVector(right, -W / 2 + 0.2).addScaledVector(dir, -1.9),
      tip.clone().addScaledVector(right, W / 2 - 0.2).addScaledVector(dir, -1.9),
    ];
    corners.forEach((cp) => {
      const rp = new THREE.Mesh(railPost, railMat);
      rp.position.copy(cp).setY(this.dockY + 0.48);
      rp.castShadow = true;
      g.add(rp);
    });
    // 先端の横バー
    const bar = new THREE.Mesh(railBar, railMat);
    bar.position.copy(tip).setY(this.dockY + 0.9);
    bar.rotation.y = yaw + Math.PI / 2;
    g.add(bar);

    // 灯篭（夜に点く）
    const lampPostGeo = new THREE.CylinderGeometry(0.08, 0.1, 2.2, 7);
    scaleCylinderUVs(lampPostGeo, 0.09, 2.2);
    const lampPost = new THREE.Mesh(lampPostGeo, woodDark);
    const lampBase = a.clone().addScaledVector(dir, 1.2).addScaledVector(right, W / 2 - 0.15);
    lampPost.position.copy(lampBase).setY(this.dockY + 1.0);
    lampPost.castShadow = true;
    g.add(lampPost);

    this.lampMat = new THREE.MeshStandardMaterial({
      color: 0xffd9a0, emissive: 0xffb050, emissiveIntensity: 0, roughness: 0.5,
    });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), this.lampMat);
    bulb.position.copy(lampBase).setY(this.dockY + 2.15);
    g.add(bulb);
    this.lampLight = new THREE.PointLight(0xffb060, 0, 26, 2);
    this.lampLight.position.copy(bulb.position);
    g.add(this.lampLight);
    this.addObstacle(lampBase.x, lampBase.z, 0.26, this.dockY + 2.3);

    // 小舟（雰囲気）
    const boat = new THREE.Group();
    const hull = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.62, 2.6, 4, 10),
      makeDockWoodMat(
        pilingMap, 0x8a6a45, 0.9, this._causticsUniforms, 'boat-hull-caustics-v1'
      )
    );
    hull.rotation.z = Math.PI / 2;
    hull.scale.set(1, 1, 0.55);
    boat.add(hull);
    const inner = new THREE.Mesh(
      new THREE.BoxGeometry(3.0, 0.5, 0.9),
      new THREE.MeshStandardMaterial({ color: 0x2b2118, roughness: 1 })
    );
    inner.position.y = 0.45;
    boat.add(inner);
    boat.position.copy(a).addScaledVector(dir, 4).addScaledVector(right, -(W / 2 + 1.7));
    boat.position.y = 0.05;
    boat.rotation.y = yaw + 0.25;
    boat.castShadow = true;
    this.boat = boat;
    g.add(boat);
    // 小舟にも当たり判定（船体に沿って2点）
    for (const t of [-0.9, 0.9]) {
      this.addObstacle(boat.position.x + dir.x * t, boat.position.z + dir.z * t, 0.85, boat.position.y + 0.95);
    }

    this.dock = g;
    this.scene.add(g);
  }

  /** 桟橋の上か（歩行判定用） */
  /** 桟橋ローカル座標（along: 岸→沖 / side: 右） */
  _dockLocal(x, z, out = { al: 0, si: 0 }) {
    const a = this.dockStart;
    out.al = (x - a.x) * this._dockU.x + (z - a.z) * this._dockU.z;
    out.si = -(x - a.x) * this._dockU.z + (z - a.z) * this._dockU.x;
    return out;
  }

  /**
   * 桟橋の床の上か（矩形判定）。以前はカプセル判定だったため、
   * 先端の外側に半円状の「見えない床」ができていた。
   */
  onDock(x, z) {
    const p = this._dockLocal(x, z, _dl);
    if (p.al < 0 || p.al > this._dockLen) return null;
    if (Math.abs(p.si) > DOCK_HALF_W) return null;
    return this.dockY;
  }

  /** 桟橋の中心線までの距離（装飾の配置除外用） */
  distToDock(x, z) {
    const p = this._dockLocal(x, z, _dl);
    const al = clamp(p.al, 0, this._dockLen);
    const dAl = p.al - al;
    return Math.hypot(dAl, p.si);
  }

  /**
   * 線分が桟橋（床＋先端の手すり）を貫通するか。
   * 糸が桟橋を突き抜けて釣りができてしまうのを防ぐ。
   */
  dockBlocksSegment(x0, y0, z0, x1, y1, z1) {
    const a = this._dockLocal(x0, z0, _dl);
    const p0 = [a.al, y0, a.si];
    const b = this._dockLocal(x1, z1, _dl2);
    const p1 = [b.al, y1, b.si];
    const L = this._dockLen, W = DOCK_HALF_W, Y = this.dockY;
    // 床（桁も含む厚み）
    if (segBoxHit(p0, p1, [0, Y - 0.42, -W], [L, Y + 0.18, W])) return true;
    // 先端の手すり
    if (segBoxHit(p0, p1, [L - 2.3, Y - 0.42, -W], [L, Y + 1.05, W])) return true;
    return false;
  }

  /* ---------------- 障害物（岩・木） ---------------- */
  /** @param top 上端の高さ（糸の判定に使う） */
  /** 水中ストラクチャーが近くにあるか（あれば一番近いものを返す） */
  structureNear(x, z, radius = 4.5) {
    let best = null, bd = radius * radius;
    for (const t of this.structures || []) {
      const d = (t.x - x) ** 2 + (t.z - z) ** 2;
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  /** 底質（'mud' | 'sand' | 'rock'） */
  bedAt(x, z) { return this.lake.bedAt(x, z); }

  addObstacle(x, z, r, top = 0) {
    this.obstacles.push(x, z, r, top);
    const key = ((Math.floor(x / OBS_CELL) & 1023) << 10) | (Math.floor(z / OBS_CELL) & 1023);
    let arr = this._obsGrid.get(key);
    if (!arr) { arr = []; this._obsGrid.set(key, arr); }
    arr.push(this.obstacles.length - 4);
  }

  /** (x,z) が半径 rad の円として障害物にぶつかるか */
  blockedAt(x, z, rad = 0.32) {
    const cx = Math.floor(x / OBS_CELL), cz = Math.floor(z / OBS_CELL);
    const o = this.obstacles;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this._obsGrid.get((((cx + dx) & 1023) << 10) | ((cz + dz) & 1023));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const i = arr[k];
          const ddx = x - o[i], ddz = z - o[i + 1], rr = o[i + 2] + rad;
          if (ddx * ddx + ddz * ddz < rr * rr) return true;
        }
      }
    }
    return false;
  }

  /** (x,z) を覆っている障害物の上端の最大値（無ければ -Infinity） */
  obstacleTopAt(x, z) {
    const cx = Math.floor(x / OBS_CELL), cz = Math.floor(z / OBS_CELL);
    const o = this.obstacles;
    let top = -Infinity;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this._obsGrid.get((((cx + dx) & 1023) << 10) | ((cz + dz) & 1023));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const i = arr[k];
          const ddx = x - o[i], ddz = z - o[i + 1], rr = o[i + 2];
          if (ddx * ddx + ddz * ddz < rr * rr && o[i + 3] > top) top = o[i + 3];
        }
      }
    }
    return top;
  }

  /**
   * 糸（ロッド先端 → 到達点）が地形や岩を貫通するか。
   * たるみ（sag）も考慮した曲線でサンプリングする。
   * @returns {null|{x:number,y:number,z:number,ground:number,kind:string}}
   */
  lineBlocked(x0, y0, z0, x1, y1, z1, opts = {}) {
    const tol = opts.tol ?? 0.22;
    const slack = opts.slack ?? 0.5;
    const dx = x1 - x0, dz = z1 - z0;
    const dist = Math.hypot(dx, dz, y1 - y0);
    if (dist < 1) return null;
    const sag = Math.min(dist * 0.16, 1.2) * slack;
    // 地形の細部ノイズは波長 18m 程度なので 1.6m 刻みで十分
    const N = Math.min(40, Math.max(8, Math.ceil(dist / 1.6)));
    for (let i = 1; i < N; i++) {
      const t = i / N;
      const x = x0 + dx * t, z = z0 + dz * t;
      const y = y0 + (y1 - y0) * t - lineSagProfile(t) * sag;   // 描画と同じたるみの形
      const g = this.heightAt(x, z);
      if (y + tol < g) return { x, y, z, ground: g, kind: 'terrain' };
      const ot = this.obstacleTopAt(x, z);
      if (ot > -Infinity && y + tol < ot) return { x, y, z, ground: ot, kind: 'rock' };
    }
    return null;
  }

  /* ---------------- 岸辺の装飾 ---------------- */
  _buildProps() {
    const rng = makeRng(this.seed ^ 0x5a5a);
    const q = this.quality;
    /* 遠景がインポスター 4 ポリなので、本数は近景の面積だけで決まる。
       900 本だと 20m 間隔の疎林で「植えた公園」に見えるため増やす */
    const treeTarget = q === 'low' ? 700 : q === 'high' ? 2000 : 1400;
    const rockTarget = q === 'low' ? 120 : 260;
    /* 水辺〜水中の植物。遠景は描かないので本数を増やしても近景の面積で決まる */
    const plantScale = q === 'low' ? 0.42 : q === 'high' ? 1 : 0.7;
    const PLANT = {
      reed: Math.round(1500 * plantScale),
      manomo: Math.round(700 * plantScale),
      hydrilla: Math.round(1900 * plantScale),
    };

    /* --- 木（ブナ・スギ） ---
       円柱＋円錐をやめ、骨格から起こした枝と葉カードにする。
       近景 / 中景 / 遠景インポスターの 3 段を種 × バリエーションごとに
       持ち、カメラ距離で振り分ける（trees.js / treeSkeleton.js） */
    this.treeSet = new TreeSet(this.scene, {
      quality: q,
      renderer: this._renderer,
      seed: this.seed ^ 0x7ee5,
      addWindSway,
      capacity: Math.ceil(treeTarget / SPECIES_IDS.length / TREE_VARIANTS) + 40,
    });

    // 岩・葦の配置でも使い回すスクラッチ
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const qt = new THREE.Quaternion();
    const s = new THREE.Vector3();

    let ti = 0, tries = 0;
    while (ti < treeTarget && tries < treeTarget * 30) {
      tries++;
      const ang = rng() * TAU;
      const rr = this.shoreRadius(Math.cos(ang) * 150, Math.sin(ang) * 150);
      const dist = rr + 5 + Math.pow(rng(), 0.7) * 230;
      const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
      const h = this.heightAt(x, z);
      if (h < 1.6 || h > 66) continue;
      if (this.slopeAt(x, z) > 0.62) continue;
      if (this.distToDock(x, z) < 3.6) continue;
      if (Math.hypot(x - this.spawnPos.x, z - this.spawnPos.z) < 6) continue;

      /* 樹種の分布：スギは沢筋〜低い斜面に群れて生え、ブナは尾根まで上がる。
         完全なランダムだと 2 種が均一に混ざって「植えた林」に見えるので、
         ゆるいノイズで塊にする */
      const patch = this.noise.fbm(x * 0.011, z * 0.011, 2);
      const cedarBias = clamp01(0.62 - (h - 6) / 46) * 0.85;
      const kind = (patch * 0.5 + 0.5) < cedarBias + (rng() - 0.5) * 0.22 ? 'cedar' : 'beech';
      const va = rng() < 0.5 ? 0 : 1;

      // 樹高（m）。高いところほど風衝で低くなる
      const alt = clamp01(h / 80);
      const height = kind === 'cedar'
        ? lerp(16, 30, rng()) * lerp(1, 0.62, alt)
        : lerp(11, 22, rng()) * lerp(1, 0.66, alt);

      this.treeSet.add(x, h - 0.15, z, height, kind, va, rng() * TAU);
      // 幹の当たり判定。半径は樹高から逆算する（ジオメトリは樹高 1 に正規化済み）
      const trunkR = (this.treeSet.trunkR[kind] || 0.02) * height;
      this.addObstacle(x, z, Math.max(trunkR * 1.15, 0.28), h - 0.15 + height * 0.9);
      ti++;
    }
    this.treeCount = ti;

    // 水面より上にしか存在しない物（水越しには絶対に写らないので、
    // 水中描画用のシーン取り込みでは省いて負荷を下げる）。
    // 岸の岩は水際にまたがって置かれる＝水中部分が見えるので入れない
    this.overWaterProps = this.treeSet.meshes.slice();
    // reedMat は後段（葦）で生成するので、ここでは葉だけ入れて後で追加する
    this.swayMaterials = this.treeSet.swayMaterials.slice();

    /* --- 岩 --- */
    const rockGeo = new THREE.IcosahedronGeometry(1, 0);
    const rockMat = addUnderwaterCaustics(
      new THREE.MeshStandardMaterial({ color: 0x6b6b66, roughness: 0.95, flatShading: true }),
      this._causticsUniforms,
      'shore-rock-caustics-v1'
    );
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockTarget);
    rocks.castShadow = true; rocks.receiveShadow = true;
    let ri = 0; tries = 0;
    while (ri < rockTarget && tries < rockTarget * 40) {
      tries++;
      const ang = rng() * TAU;
      const rr = this.shoreRadius(Math.cos(ang) * 150, Math.sin(ang) * 150);
      const dist = rr + (rng() * 2 - 1) * 26;
      const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
      const h = this.heightAt(x, z);
      if (h < -2.5 || h > 14) continue;
      if (this.distToDock(x, z) < 3.4) continue;
      const sc = 0.5 + Math.pow(rng(), 2) * 3.4;
      const rsx = sc * (0.7 + rng() * 0.6), rsy = sc * (0.5 + rng() * 0.5), rsz = sc * (0.7 + rng() * 0.6);
      qt.setFromEuler(new THREE.Euler(rng() * TAU, rng() * TAU, rng() * TAU));
      p.set(x, h + sc * 0.15, z);
      s.set(rsx, rsy, rsz);
      m.compose(p, qt, s);
      rocks.setMatrixAt(ri++, m);
      // 岩の当たり判定（水中の小石は無視／上端は岩の高さ）
      if (h > -0.9 && sc > 0.65) {
        this.addObstacle(x, z, Math.max(rsx, rsz) * 0.72, h + sc * 0.15 + rsy * 0.82);
      }
    }
    rocks.count = ri;
    rocks.instanceMatrix.needsUpdate = true;
    this.scene.add(rocks);

    /* --- 水中のストラクチャー（沈み岩・立ち枯れ） ---
       湖底に置いて、必ず水面より下に収める。糸は水面上を通るので
       キャストの邪魔にはならないが、水中カメラで見えて魚が付く */
    this.structures = [];
    {
      const sRockMat = addUnderwaterCaustics(
        new THREE.MeshStandardMaterial({ color: 0x4e5550, roughness: 0.98, flatShading: true }),
        this._causticsUniforms,
        'sunk-rock-caustics-v1'
      );
      const sRocks = new THREE.InstancedMesh(
        rockGeo, sRockMat, Math.max(1, this.lake.structures.length * 3)
      );
      sRocks.receiveShadow = true;
      const snagMat = addUnderwaterCaustics(new THREE.MeshStandardMaterial({
        color: 0x5c4a36, roughness: 1, flatShading: true,
      }), this._causticsUniforms, 'snag-wood-caustics-v1');
      const snagTipMat = addUnderwaterCaustics(new THREE.MeshStandardMaterial({
        color: 0x3d342a, roughness: 1, flatShading: true,
      }), this._causticsUniforms, 'snag-tip-caustics-v1');
      const snagRoot = new THREE.Group();
      snagRoot.name = 'snags';
      let si = 0;
      for (const t of this.lake.structures) {
        const bedY = this.heightAt(t.x, t.z);
        if (t.kind === 'rock') {
          // 3 つの岩を寄せて 1 つのシモリにする
          for (let k = 0; k < 3; k++) {
            const ox = (k === 0 ? 0 : (k === 1 ? 1 : -1)) * t.r * 0.75;
            const oz = (k === 0 ? 0 : (k === 1 ? -1 : 1)) * t.r * 0.55;
            const sc = t.r * (k === 0 ? 1 : 0.62) * (0.85 + t.v * 0.3);
            qt.setFromEuler(new THREE.Euler(t.rot + k, t.rot * 1.7, t.v * 3));
            p.set(t.x + ox, bedY + sc * 0.35, t.z + oz);
            s.set(sc, sc * (0.55 + t.v * 0.35), sc);
            m.compose(p, qt, s);
            if (si < sRocks.count) sRocks.setMatrixAt(si++, m);
          }
        } else {
          snagRoot.add(makeSnagGroup(t, bedY, snagMat, snagTipMat));
        }
        // 当たり判定（上端は水面下なので、糸には掛からない＝キャストの邪魔をしない）
        this.addObstacle(t.x, t.z, t.r * 1.15, bedY + t.h);
        this.structures.push({ x: t.x, z: t.z, kind: t.kind, r: t.r, top: bedY + t.h, depth: t.depth });
      }
      sRocks.count = si;
      sRocks.instanceMatrix.needsUpdate = true;
      this.scene.add(sRocks, snagRoot);
    }

    /* --- 水辺〜水中の植物（ヨシ・マコモ・クロモ） ---
       円錐 1 個の «葦» をやめ、種ごとに株を組んで生やす。
       水深の帯で棲み分けさせ、さらにノイズで «群落» に固める。
       等確率で撒くと岸をぐるりと均一に縁取って、植えた花壇に見える */
    this.waterPlants = new WaterPlants(this.scene, {
      quality: q,
      seed: this.seed ^ 0x2f19,
      capacity: Math.ceil(Math.max(...Object.values(PLANT)) / 3) + 60,
      addWindSway,
      addUnderwaterCaustics,
      patchUwMaterial,
      causticsUniforms: this._causticsUniforms,
    });

    const BANDS = [
      /* kind, 目標数, 汀線からどこまで内側を探すか(m), 地面の高さの帯,
         株の高さ(m), 群落ノイズのしきい値と種 */
      { kind: 'reed', n: PLANT.reed, reach: 20, hMin: -0.95, hMax: 0.45, s0: 1.7, s1: 3.1, thr: -0.10, salt: 11.3 },
      { kind: 'manomo', n: PLANT.manomo, reach: 28, hMin: -1.30, hMax: -0.06, s0: 1.1, s1: 1.9, thr: 0.10, salt: -37.7 },
      { kind: 'hydrilla', n: PLANT.hydrilla, reach: 95, hMin: -4.60, hMax: -0.60, s0: 0.55, s1: 1.70, thr: -0.20, salt: 61.9 },
    ];

    this.plantCounts = {};
    for (const b of BANDS) {
      let placed = 0; tries = 0;
      while (placed < b.n && tries < b.n * 40) {
        tries++;
        const ang = rng() * TAU;
        const rr = this.shoreRadius(Math.cos(ang) * 150, Math.sin(ang) * 150);
        const dist = rr + 1.5 - Math.pow(rng(), 0.75) * b.reach;
        const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
        const h = this.heightAt(x, z);
        if (h < b.hMin || h > b.hMax) continue;
        if (this.slopeAt(x, z) > 1.15) continue;
        if (this.distToDock(x, z) < 2.4) continue;   // 板を突き抜けないように
        // 群落：同じ種は塊で生える。種ごとに salt を変えて場所をずらす
        if (this.noise.fbm(x * 0.042 + b.salt, z * 0.042 - b.salt, 2) < b.thr) continue;
        // 小さい株がやや多い（群落の縁は背が低い）
        const sc = lerp(b.s0, b.s1, Math.pow(rng(), 1.35));
        this.waterPlants.add(b.kind, x, h, z, sc, (rng() * 3) | 0, rng() * TAU);
        placed++;
      }
      this.plantCounts[b.kind] = placed;
    }
    this.swayMaterials.push(...this.waterPlants.swayMaterials);
  }

  /** 夜間の灯り更新 */
  updateLamp(nightAmount, dt) {
    const target = nightAmount;
    this.lampMat.emissiveIntensity = lerp(this.lampMat.emissiveIntensity, target * 2.4, 0.06);
    this.lampLight.intensity = lerp(this.lampLight.intensity, target * 26, 0.06);
  }

  /** 風揺れの時刻を進める（windPow: 雨天ほど強く） */
  updateWind(time, windPow = 1) {
    if (this.swayMaterials) tickVegetationWind(this.swayMaterials, time * 1.0, windPow);
  }

  /** 木・水辺の植物の LOD をカメラ距離で振り直す（変化時だけ行列を作り直す） */
  updateTrees(dt, cameraPos) {
    this.treeSet?.update(dt, cameraPos);
    this.waterPlants?.update(dt, cameraPos);
  }
}
