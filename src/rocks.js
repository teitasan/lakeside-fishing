/* ===========================================================
   岩：プロシージャル形状 + triplanar + 苔 + 濡れ境界 + LOD

   rockShape.js が作った素の配列をジオメトリにし、
     ・triplanar 投影で貼る（岩に UV を張ると必ずどこかで伸びる）
     ・ワールド法線の上向き成分で苔を出す（焼くと回転でずれる）
     ・水面からの高さで «水中＝暗い / 濡れ / 乾き» の 3 段に分ける
   を入れる。

   大きさで作りを分けるのが肝。
     大岩   3D + LOD、水面をまたいでシルエットが景観に効く
     中石   低ポリ 3D + LOD、InstancedMesh で撒く
     小石   近距離だけ 3D。遠くは地面テクスチャに任せる
   遠景の岩は木と違って板にしない。動かず、シルエットが単純で、
   半透明も細い枝も無いので、超低ポリのメッシュのままで十分。
   =========================================================== */
import * as THREE from 'three';
import { makeRockShape, ROCK_KINDS } from './rockShape.js?v=20260828-rocks6';
import { LodInstances, tintAt } from './lodInstances.js?v=20260828-rocks6';
import { applyPatches } from './materialPatch.js?v=20260828-rocks6';
import { makeRng, TAU, lerp } from './util.js';

/**
 * 大きさの階層。しきい値と、その階層で使う分割数（三角形数 = 20 * 4^detail）。
 *   boulder 大岩：1280 / 320 / 80
 *   cobble  中石： 320 /  80 / 20
 *   pebble  小石： 80 のみ。近くにしか出さない
 */
export const ROCK_TIERS = {
  boulder: { lodDist: [22, 70, 190], detail: [3, 2, 1] },
  cobble: { lodDist: [16, 48], detail: [2, 1] },
  pebble: { lodDist: [14], detail: [1] },
};

/** 形のバリエーション数（階層ごと） */
export const ROCK_VARIANTS = 5;

/* ---------------- テクスチャ ---------------- */

/** 端をまたぐ図形を反対側にも描いてタイル境界を消す */
function wrap2(g, size, x, y, fn) {
  for (const dx of [0, x < size * 0.5 ? size : -size]) {
    for (const dy of [0, y < size * 0.5 ? size : -size]) fn(x + dx, y + dy);
  }
}

/**
 * 花崗岩のアルベド。粒（石英・雲母）・色ムラ・細い割れ目の 3 層。
 * triplanar で 3 方向から貼るので、上下左右に継ぎ目が出ないよう
 * すべての図形を折り返して描く。
 */
export function makeRockTexture(size = 256, seed = 0x51a3f7) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const rng = makeRng(seed);

  // 地の色。暗いと «濡れ» や窪み AO と合わさって黒く沈む
  g.fillStyle = '#7f7e78';
  g.fillRect(0, 0, size, size);

  // 大きな色ムラ（風化した面と新鮮な面）
  for (let i = 0; i < 26; i++) {
    const x = rng() * size, y = rng() * size, r = size * (0.10 + rng() * 0.26);
    const v = 92 + Math.round(rng() * 64);
    wrap2(g, size, x, y, (xx, yy) => {
      const grd = g.createRadialGradient(xx, yy, 0, xx, yy, r);
      grd.addColorStop(0, `rgba(${v},${v - 2},${v - 8},${0.10 + rng() * 0.14})`);
      grd.addColorStop(1, `rgba(${v},${v - 2},${v - 8},0)`);
      g.fillStyle = grd;
      g.beginPath(); g.arc(xx, yy, r, 0, TAU); g.fill();
    });
  }

  // 粒。花崗岩は «白い石英 + 黒い雲母 + 薄桃の長石» の混合
  const grains = Math.round(size * size * 0.075);
  for (let i = 0; i < grains; i++) {
    const x = rng() * size, y = rng() * size;
    // 粒は小さく低コントラストに。大きいとコンクリートの骨材に見える
    const r = size * (0.0022 + rng() * 0.0060);
    const pick = rng();
    let col;
    if (pick < 0.34) {
      const v = 168 + Math.round(rng() * 40);
      col = `rgba(${v},${v},${v - 6},${0.22 + rng() * 0.30})`;
    } else if (pick < 0.62) {
      const v = 46 + Math.round(rng() * 40);
      col = `rgba(${v},${v},${v + 6},${0.24 + rng() * 0.34})`;
    } else {
      const v = 150 + Math.round(rng() * 44);
      col = `rgba(${v},${Math.round(v * 0.92)},${Math.round(v * 0.86)},${0.16 + rng() * 0.24})`;
    }
    wrap2(g, size, x, y, (xx, yy) => {
      g.fillStyle = col;
      g.beginPath(); g.arc(xx, yy, r, 0, TAU); g.fill();
    });
  }

  // 割れ目。細く暗い線を折れながら走らせる
  g.lineCap = 'round';
  for (let i = 0; i < 16; i++) {
    let x = rng() * size, y = rng() * size;
    const steps = 6 + Math.round(rng() * 10);
    let ang = rng() * TAU;
    const pts = [[x, y]];
    for (let k = 0; k < steps; k++) {
      ang += (rng() - 0.5) * 1.1;
      x += Math.cos(ang) * size * 0.05;
      y += Math.sin(ang) * size * 0.05;
      pts.push([x, y]);
    }
    const a = 0.16 + rng() * 0.24;
    for (const dx of [-size, 0, size]) {
      for (const dy of [-size, 0, size]) {
        g.strokeStyle = `rgba(38,36,34,${a})`;
        g.lineWidth = size * (0.002 + rng() * 0.004);
        g.beginPath();
        g.moveTo(pts[0][0] + dx, pts[0][1] + dy);
        for (const [px, py] of pts.slice(1)) g.lineTo(px + dx, py + dy);
        g.stroke();
      }
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** 苔のアルベド。まばらな塊と、粒状のムラ */
export function makeMossTexture(size = 256, seed = 0x2ba91c) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const rng = makeRng(seed);
  g.fillStyle = '#46612c';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 40; i++) {
    const x = rng() * size, y = rng() * size, r = size * (0.05 + rng() * 0.20);
    const v = 70 + Math.round(rng() * 76);
    wrap2(g, size, x, y, (xx, yy) => {
      const grd = g.createRadialGradient(xx, yy, 0, xx, yy, r);
      grd.addColorStop(0, `rgba(${Math.round(v * 0.62)},${v},${Math.round(v * 0.40)},${0.30 + rng() * 0.4})`);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(xx, yy, r, 0, TAU); g.fill();
    });
  }
  // 粒。苔は «べた塗り» にすると絨毯に見える
  const grains = Math.round(size * size * 0.05);
  for (let i = 0; i < grains; i++) {
    const x = rng() * size, y = rng() * size;
    const v = 52 + Math.round(rng() * 96);
    g.fillStyle = `rgba(${Math.round(v * 0.58)},${v},${Math.round(v * 0.36)},${0.25 + rng() * 0.45})`;
    g.beginPath(); g.arc(x, y, size * (0.003 + rng() * 0.008), 0, TAU); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/* ---------------- シェーダ ---------------- */

const ROCK_COMMON = /* glsl */ `
uniform sampler2D uRockTex;
uniform sampler2D uMossTex;
uniform vec3 uRockTint;
uniform vec2 uRockScale;     // x = 岩肌, y = 苔（1/m）
uniform vec3 uMossParams;    // x = 量, y = 上向きのしきい値, z = 水面からの立ち上がり
uniform vec2 uWetParams;     // x = 濡れが乾くまでの高さ(m), y = 濡れの暗さ
varying vec3 vRockWorldPos;
varying vec3 vRockWorldNormal;
varying float vRockCavity;

float rockHash(vec2 p) {
  p = fract(p * vec2(127.31, 311.71));
  p += dot(p, p + 41.23);
  return fract(p.x * p.y);
}
float rockNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rockHash(i), rockHash(i + vec2(1.0, 0.0)), f.x),
             mix(rockHash(i + vec2(0.0, 1.0)), rockHash(i + vec2(1.0, 1.0)), f.x), f.y);
}

/**
 * triplanar 投影。X/Y/Z の 3 方向から貼って法線で混ぜる。
 * 岩に UV を張ると、球状の展開では極で必ず伸び、
 * 平面展開では側面が伸びる。3 方向から貼れば上面・側面・斜面の
 * どこでもテクセル密度がほぼ一定になる。
 */
vec3 triplanar(sampler2D tex, vec3 wp, vec3 wn, float scale) {
  vec3 b = abs(wn);
  b = pow(b, vec3(4.0));
  b /= max(b.x + b.y + b.z, 1e-4);
  vec3 cx = texture2D(tex, wp.zy * scale).rgb;
  vec3 cy = texture2D(tex, wp.xz * scale).rgb;
  vec3 cz = texture2D(tex, wp.xy * scale).rgb;
  return cx * b.x + cy * b.y + cz * b.z;
}
`;

const ROCK_VERT = /* glsl */ `
{
  #ifdef USE_INSTANCING
    mat3 im = mat3(instanceMatrix);
    /* インスタンスは異方スケールなので、法線は逆転置で運ぶ。
       スケール成分の 2 乗で割るのがその近似 */
    vec3 sc = vec3(length(im[0]), length(im[1]), length(im[2]));
    vec3 rn = objectNormal / max(sc * sc, vec3(1e-6));
    vRockWorldNormal = normalize(mat3(modelMatrix) * (im * rn));
    vRockWorldPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  #else
    vRockWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
    vRockWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  #endif
  vRockCavity = aCavity;
}
`;

/**
 * 岩の見え方。
 *   水面下      いちばん暗い（濡れ + 水の吸収は水シェーダ側）
 *   水面すぐ上  濡れて暗く、つるつる
 *   その上      乾いた岩。上向きの面と窪みに苔
 */
const ROCK_FRAG = /* glsl */ `
{
  vec3 wn = normalize(vRockWorldNormal);
  vec3 rock = triplanar(uRockTex, vRockWorldPos, wn, uRockScale.x) * uRockTint;

  /* 窪みを暗くする（頂点に焼いた相対的な «へこみ» 量）。
     回転しても変わらない量なので、インスタンス化しても正しい */
  rock *= mix(1.0, 0.74, vRockCavity * 0.85);

  /* 苔：上向きで、水面より十分上、そして窪みに溜まる。
     ワールド法線から出すのが肝。頂点に焼くとインスタンスの回転で
     横面や下面へ苔が付く */
  float up = smoothstep(uMossParams.y, uMossParams.y + 0.50, wn.y);
  float above = smoothstep(0.05, uMossParams.z, vRockWorldPos.y);
  /* 苔の縁は «塗った» ように見えないよう 3 オクターブで崩す。
     patch は GLSL の予約語なので別名にする。
     xz だけでなく y も入れる（横から見たとき縞にならない） */
  vec3 mp = vRockWorldPos * uRockScale.y;
  float mossMask = rockNoise(mp.xz) * 0.5
                 + rockNoise(mp.xz * 2.7 + mp.y * 0.7 + 13.7) * 0.32
                 + rockNoise(mp.xz * 6.1 - mp.y * 1.3 + 41.3) * 0.18;
  float moss = uMossParams.x * up * above
             * smoothstep(0.40, 0.72, mossMask + vRockCavity * 0.22);
  vec3 mossCol = triplanar(uMossTex, vRockWorldPos, wn, uRockScale.y);
  rock = mix(rock, mossCol, clamp(moss, 0.0, 1.0));

  /* 濡れ：水面（y=0）より下は完全に濡れ、上は毛管と飛沫で
     uWetParams.x の高さまで残す。境界はノイズで崩す */
  float dryUp = uWetParams.x * (0.55 + 0.9 * rockNoise(vRockWorldPos.xz * 1.9));
  float wet = 1.0 - smoothstep(0.0, max(dryUp, 0.02), vRockWorldPos.y);
  wet = max(wet, step(vRockWorldPos.y, 0.0));
  // 濡れた岩は暗く、そして «つるつる» になる
  rock *= mix(1.0, uWetParams.y, wet);
  roughnessFactor = mix(roughnessFactor, 0.30, wet * 0.85);

  diffuseColor.rgb *= rock;
}
`;

/**
 * 岩のマテリアルに triplanar / 苔 / 濡れを注入する。
 * @param {THREE.Material} mat
 * @param {{rockTex: THREE.Texture, mossTex: THREE.Texture, tint?: number,
 *          rockScale?: number, mossScale?: number, moss?: number,
 *          mossUp?: number, mossAbove?: number, wetTop?: number, wetDark?: number}} o
 */
export function addRockLook(mat, o) {
  const uniforms = {
    uRockTex: { value: o.rockTex },
    uMossTex: { value: o.mossTex },
    uRockTint: { value: new THREE.Color(o.tint ?? 0xffffff) },
    uRockScale: { value: new THREE.Vector2(o.rockScale ?? 0.55, o.mossScale ?? 0.9) },
    uMossParams: { value: new THREE.Vector3(o.moss ?? 0.85, o.mossUp ?? 0.30, o.mossAbove ?? 0.55) },
    /* 濡れの暗さは 0.7 くらいが上限。0.5 まで落とすと、下向きの面は
       もともと日が当たらないので合わせて真っ黒になり岩肌が消える */
    uWetParams: { value: new THREE.Vector2(o.wetTop ?? 0.26, o.wetDark ?? 0.72) },
  };
  mat.userData.rockUniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float aCavity;\n${ROCK_COMMON}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${ROCK_VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${ROCK_COMMON}`)
      /* roughnessFactor を書き換えるので roughnessmap のあとに入れる。
         色は map の直後だと caustics より前に来る必要があるので
         同じく roughnessmap_fragment を目印にする */
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${ROCK_FRAG}`);
  };
  mat.customProgramCacheKey = () => 'rock-look-v1';
  return mat;
}

/* ---------------- ジオメトリ ---------------- */

/** rockShape の素の配列を BufferGeometry にする */
export function rockGeometry(shape) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(shape.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(shape.normal, 3));
  g.setAttribute('aCavity', new THREE.BufferAttribute(shape.cavity, 1));
  g.setIndex(new THREE.BufferAttribute(shape.index, 1));
  return g;
}

/**
 * 個別に置く岩を 1 つぶんのジオメトリとして作る（沈み岩など）。
 * 原点は底面中央、高さ 1 に正規化されている。
 */
export function makeSingleRock(kind, seed, detail = 2) {
  return rockGeometry(makeRockShape(kind, seed >>> 0, { detail }));
}

/* ---------------- 群れの管理 ---------------- */

/**
 * 岩の集合。階層（大岩 / 中石 / 小石）ごとに LOD を持つ。
 * @param {THREE.Scene} scene
 * @param {{quality?: string, seed?: number, causticsUniforms?: object,
 *          addUnderwaterCaustics?: Function, capacity?: object}} opts
 */
export class RockSet {
  constructor(scene, opts = {}) {
    const seed = (opts.seed ?? 1) >>> 0;
    this.quality = opts.quality || 'mid';
    this.rockTex = makeRockTexture();
    this.mossTex = makeMossTexture();
    this.materials = [];
    /* 階層ごとのマテリアル。沈み岩のような «個別に置く岩» でも
       同じ見え方（triplanar / 苔 / 濡れ）にしたいので外へ出す */
    this.mats = {};
    this.sets = {};

    const caust = (m) => (opts.addUnderwaterCaustics && opts.causticsUniforms
      ? opts.addUnderwaterCaustics(m, opts.causticsUniforms, 'rock-caustics-v2')
      : m);

    /* 階層ごとに «岩肌の細かさ» を変える。小石に大岩と同じ密度で
       貼ると粒が大きすぎて発泡スチロールに見える */
    const look = {
      /* wetTop はワールド Y の高さ。渚の勾配は 0.065 なので、
         0.30m も取ると «汀線から 4.6m» ぶんの砂浜の石まで濡れ扱いになって
         乾いた浜の石が黒くなる。高さで見ている以上ここは狭く取る */
      boulder: { rockScale: 1.15, mossScale: 1.5, moss: 0.80, wetTop: 0.12 },
      cobble: { rockScale: 2.6, mossScale: 3.0, moss: 0.60, wetTop: 0.08 },
      pebble: { rockScale: 6.0, mossScale: 6.0, moss: 0.26, wetTop: 0.05 },
    };

    for (const [tier, cfg] of Object.entries(ROCK_TIERS)) {
      const mat = applyPatches(new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.92, metalness: 0,
      }), [
        (m) => addRockLook(m, {
          rockTex: this.rockTex, mossTex: this.mossTex, ...look[tier],
        }),
        caust,
      ]);
      this.materials.push(mat);
      this.mats[tier] = mat;

      const set = new LodInstances(scene, {
        lodDist: cfg.lodDist, hysteresis: 5, interval: 0.2,
      });
      this.sets[tier] = set;
      const caps = (opts.capacity || {})[tier] || cfg.lodDist.map(() => 400);
      for (let va = 0; va < ROCK_VARIANTS; va++) {
        const kind = ROCK_KINDS[va % ROCK_KINDS.length];
        for (let lod = 0; lod < cfg.lodDist.length; lod++) {
          /* 同じ seed で detail だけ落とす。頂点は少なくなるが同じ
             ノイズ場を見るのでシルエットが変わらない */
          const shape = makeRockShape(kind, seed ^ (0x9e37 * (va + 1)) ^ (tier.length * 0x51ed), {
            detail: cfg.detail[lod],
          });
          set.register(`${tier}|${va}`, lod, [{
            geo: rockGeometry(shape), mat, shadow: tier === 'boulder',
          }], caps[lod] ?? 400);
        }
      }
    }
  }

  /**
   * 岩を 1 つ置く。
   * @param {string} tier boulder | cobble | pebble
   * @param {number} height 岩の高さ（m）。ジオメトリは高さ 1 に正規化済み
   * @param {{sx: number, sz: number}} spread 平面方向の伸び（1 で高さと同じ）
   */
  add(tier, x, y, z, height, spread, variant, ry) {
    const set = this.sets[tier];
    if (!set) return;
    set.add(x, y, z, { x: height * spread.sx, y: height, z: height * spread.sz },
      `${tier}|${variant}`, ry, tintAt(x, z, 0.22, 0.10));
  }

  update(dt, cameraPos) {
    for (const set of Object.values(this.sets)) set.update(dt, cameraPos);
  }

  counts() {
    const out = {};
    for (const [tier, set] of Object.entries(this.sets)) out[tier] = set.counts();
    return out;
  }

  get meshes() {
    return Object.values(this.sets).flatMap((s) => s.meshes);
  }

  dispose() {
    for (const set of Object.values(this.sets)) set.dispose();
  }
}
