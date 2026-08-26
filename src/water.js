/* ===========================================================
   水面：波シェーダ / 波紋 / 水しぶき
   CPU と GPU で同一の波関数を使い、ウキが正しく浮くようにする
   =========================================================== */
import * as THREE from 'three';
import { COMMON_GLSL } from './shaders.js?v=20260826-envgfx';
import { WATER_REGION } from './lakefield.js';
import { smoothstep, rand, TAU } from './util.js';

/** 波の定義（dir は正規化して使用） */
export const WAVES = [
  { dx: 1.00, dz: 0.20, len: 15.0, amp: 0.150, speed: 1.05 },
  { dx: 0.62, dz: -0.78, len: 8.60, amp: 0.095, speed: 1.30 },
  { dx: -0.34, dz: 0.94, len: 5.10, amp: 0.058, speed: 1.65 },
  { dx: 0.88, dz: 0.47, len: 3.05, amp: 0.032, speed: 2.20 },
  { dx: -0.72, dz: -0.69, len: 1.85, amp: 0.018, speed: 2.95 },
];

const W = WAVES.map((w) => {
  const l = Math.hypot(w.dx, w.dz);
  const k = TAU / w.len;
  return { dx: w.dx / l, dz: w.dz / l, k, amp: w.amp, om: w.speed * k };
});

export const MAX_WAVE_AMP = W.reduce((a, w) => a + w.amp, 0);

/** 波の高さ（wind: 1 で標準） */
export function waveHeight(x, z, t, wind = 1) {
  let h = 0;
  for (let i = 0; i < W.length; i++) {
    const w = W[i];
    h += w.amp * Math.sin((w.dx * x + w.dz * z) * w.k - t * w.om);
  }
  return h * wind;
}

/** 波の法線（解析微分） */
export function waveNormal(x, z, t, wind = 1, out = new THREE.Vector3()) {
  let dx = 0, dz = 0;
  for (let i = 0; i < W.length; i++) {
    const w = W[i];
    const c = Math.cos((w.dx * x + w.dz * z) * w.k - t * w.om) * w.amp * w.k * wind;
    dx += c * w.dx;
    dz += c * w.dz;
  }
  return out.set(-dx, 1, -dz).normalize();
}

/** GPU 用に同じ式を GLSL として生成 */
function waveGLSL() {
  let sum = '', dsum = '';
  W.forEach((w, i) => {
    const ph = `((${w.dx.toFixed(5)} * p.x + ${w.dz.toFixed(5)} * p.y) * ${w.k.toFixed(5)} - t * ${w.om.toFixed(5)})`;
    sum += `  h += ${w.amp.toFixed(5)} * sin(${ph});\n`;
    dsum += `  c = cos(${ph}) * ${(w.amp * w.k).toFixed(6)};\n` +
      `  d += vec2(${w.dx.toFixed(5)}, ${w.dz.toFixed(5)}) * c;\n`;
  });
  return /* glsl */ `
float waveH(vec2 p, float t) {
  float h = 0.0;
${sum}  return h;
}
vec2 waveD(vec2 p, float t) {
  vec2 d = vec2(0.0);
  float c;
${dsum}  return d;
}
`;
}

/* --- planar reflection 用の一時オブジェクト（GC 抑制） --- */
const _reflMat4 = new THREE.Matrix4();
const _reflVP = new THREE.Matrix4();
const _reflPlaneCam = new THREE.Plane();
const _reflClip = new THREE.Vector4();
const _reflV = new THREE.Vector3();

/**
 * 射影行列の near 面を任意平面（カメラ空間）へ置き換える。
 * Lengyel, "Oblique View Frustum Depth Projection and Clipping" 相当。
 */
function _calcOblique(proj, clip) {
  const e = proj.elements;
  const qx = (Math.sign(clip.x) + e[8]) / e[0];
  const qy = (Math.sign(clip.y) + e[9]) / e[5];
  const qz = -1.0;
  const f = 1.0 / (e[10] + qx * e[8] + qy * e[9] + qz * e[14]);
  e[2] = clip.x * f;
  e[6] = clip.y * f;
  e[10] = clip.z * f + 1.0;
  e[14] = clip.w * f;
}

export class Water {
  constructor(scene, terrain, opts = {}) {
    this.scene = scene;
    this.terrain = terrain;
    this.time = 0;
    this.wind = 1;

    const segs = opts.quality === 'low' ? 150 : opts.quality === 'high' ? 300 : 230;
    const geo = new THREE.PlaneGeometry(WATER_REGION, WATER_REGION, segs, segs);
    geo.rotateX(-Math.PI / 2);

    this.uniforms = {
      uTime: { value: 0 },
      uWind: { value: 1 },
      uHeightTex: { value: terrain.heightTexture },
      uRegion: { value: WATER_REGION },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(0xffffff) },
      uZenith: { value: new THREE.Color(0x2c72cc) },
      uHorizon: { value: new THREE.Color(0xd3e8f8) },
      uFogColor: { value: new THREE.Color(0xd3e8f8) },
      uFogNear: { value: 90 },
      uFogFar: { value: 620 },
      uNight: { value: 0 },
      uRain: { value: 0 },
      uShallow: { value: new THREE.Color(0x40907e) },
      uDeep: { value: new THREE.Color(0x0a2740) },
      uExposure: { value: opts.exposure ?? 1.0 },
      uCamPos: { value: new THREE.Vector3() },
      /* 水中の見え方：シーンを一度描いたテクスチャを、水を通る距離で減衰させて合成する。
         「不透明度で水を被せる」方式だと湖底の色との差で境目が出るため */
      uSceneColor: { value: null },
      uSceneDepth: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uCamNear: { value: 0.1 },
      uCamFar: { value: 3000 },
      // 1m あたりの吸収（赤から先に消える）
      uAbsorb: { value: new THREE.Vector3(0.46, 0.20, 0.13) },
      uDebug: { value: 0 },   // 1=シーンテクスチャ 2=水の厚み（開発用）
      uLinearOut: { value: 0 },
      /* --- 平面反射（planar reflection） ---
         ミラーカメラで水面より上を描いたテクスチャを、波の法線で揺らして貼る */
      uReflColor: { value: null },
      uTexMat: { value: new THREE.Matrix4() },
      uHasRefl: { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: false,
      side: THREE.DoubleSide,
      depthWrite: true,
      vertexShader: /* glsl */ `
        ${waveGLSL()}
        uniform float uTime, uWind, uRegion;
        uniform sampler2D uHeightTex;
        varying vec3 vWorld;
        varying vec2 vWaveD;
        varying float vDepth;
        varying float vFogDepth;
        varying float vWaveH;

        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vec2 uv = wp.xz / uRegion + 0.5;
          float ground = texture2D(uHeightTex, clamp(uv, vec2(0.0005), vec2(0.9995))).r;
          float depth = max(0.0, -ground);
          vDepth = depth;

          float damp = smoothstep(0.0, 1.6, depth) * 0.85 + 0.15 * smoothstep(0.0, 5.0, depth);
          float h = waveH(wp.xz, uTime) * uWind * damp;
          vWaveH = h;
          vWaveD = waveD(wp.xz, uTime) * uWind * damp;
          wp.y += h;

          vWorld = wp.xyz;
          vec4 mv = viewMatrix * wp;
          vFogDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        ${COMMON_GLSL}
        uniform vec3 uSunDir, uSunColor, uZenith, uHorizon, uFogColor, uShallow, uDeep, uCamPos, uAbsorb;
        uniform float uTime, uNight, uRain, uFogNear, uFogFar, uExposure, uWind, uCamNear, uCamFar;
        uniform sampler2D uSceneColor, uSceneDepth, uReflColor;
        uniform mat4 uTexMat;
        uniform float uHasRefl;
        uniform vec2 uResolution;
        uniform float uDebug;
        uniform float uLinearOut;
        varying vec3 vWorld;
        varying vec2 vWaveD;
        varying float vDepth;
        varying float vFogDepth;
        varying float vWaveH;

        /* 細かいさざ波の法線用の傾き。1 周波数だけを流すと一体で動いて
           不自然なので、周波数ごとに向き・速さの違う層を重ねて分散関係
           （波長が違うと伝わる速さも向きも少しずつ変わる）を簡易に真似る
           （tompng/gpuocean の「ノイズをスクロールさせた複製を合成する」
           手法のアイデア。あちらは WebGPU + 事前焼き込みテクスチャだが、
           このゲームは全部その場計算の GLSL ノイズなので、素の関数を
           周波数・向き違いで複数回呼ぶだけで同じ考え方を再現できる） */
        vec2 rippleSlope(vec2 xz, float t) {
          const float EPS = 0.08;
          vec2 d = vec2(0.0);
          float n;
          vec2 p;

          p = xz * 0.9 + vec2(0.97, 0.24) * t * 0.55;
          n = fbm2(p);
          d += vec2(n - fbm2(p + vec2(EPS, 0.0)), n - fbm2(p + vec2(0.0, EPS))) * 1.3;

          p = xz * 1.6 + vec2(0.60, -0.80) * t * 0.85;
          n = fbm2(p);
          d += vec2(n - fbm2(p + vec2(EPS, 0.0)), n - fbm2(p + vec2(0.0, EPS))) * 1.0;

          p = xz * 2.6 - vec2(-0.29, 0.96) * t * 0.6;
          n = vnoise(p);
          d += vec2(n - vnoise(p + vec2(EPS, 0.0)), n - vnoise(p + vec2(0.0, EPS))) * 0.7;

          p = xz * 4.2 + vec2(-0.79, -0.61) * t * 1.3;
          n = vnoise(p);
          d += vec2(n - vnoise(p + vec2(EPS, 0.0)), n - vnoise(p + vec2(0.0, EPS))) * 0.45;

          p = xz * 6.5 - vec2(0.89, 0.45) * t * 1.7;
          n = vnoise(p);
          d += vec2(n - vnoise(p + vec2(EPS, 0.0)), n - vnoise(p + vec2(0.0, EPS))) * 0.28;

          return d;
        }

        /** 深度テクスチャの値 → ビュー空間の z 距離（m） */
        float eyeZ(float depth) {
          float z = depth * 2.0 - 1.0;                                   // NDC
          return (2.0 * uCamNear * uCamFar) / (uCamFar + uCamNear - z * (uCamFar - uCamNear));
        }

        vec3 skyAt(vec3 dir) {
          float g = pow(clamp(dir.y, 0.0, 1.0), 0.62);
          vec3 c = mix(uHorizon, uZenith, g);
          float sd = max(dot(dir, uSunDir), 0.0);
          c += uSunColor * pow(sd, 9.0) * 0.34;
          c += uSunColor * pow(sd, 2.2) * 0.10;
          return c;
        }

        void main() {
          if (vDepth <= 0.02) discard;

          // --- 法線（大波 + 細かいリップル） ---
          vec2 rip = rippleSlope(vWorld.xz, uTime);
          float ripAmt = (0.55 + uRain * 1.5) * smoothstep(0.0, 1.2, vDepth);
          vec3 N = normalize(vec3(-vWaveD.x - rip.x * ripAmt, 1.0, -vWaveD.y - rip.y * ripAmt));

          vec3 V = normalize(uCamPos - vWorld);
          bool under = dot(N, V) < 0.0;
          if (under) N = -N;

          float ndv = clamp(dot(N, V), 0.0, 1.0);
          float fres = pow(1.0 - ndv, 5.0) * 0.94 + 0.045;

          // --- 反射 ---
          vec3 R = reflect(-V, N);
          R.y = abs(R.y);
          vec3 refl = skyAt(R);

          /* --- 平面反射 ---
             水面より上を描いたミラー画像。波の法線で反射ベクトルの足元を
             揺らしてサンプリングする（uv は uTexMat が画面座標へ運ぶ）。
             RT に焼いた色は sRGB 済みなので、そのまま合成してよい */
          if (uHasRefl > 0.5) {
            vec3 Rd = reflect(-V, N);
            float dist = length(vWorld - uCamPos);
            // 波の傾きに応じて反射点を横へずらす（揺れの主役）
            vec4 rp = uTexMat * vec4(vWorld + Rd * (0.35 + dist * 0.10), 1.0);
            vec2 ruv = clamp(rp.xy / rp.w, 0.0, 1.0);
            vec3 mirror = texture2D(uReflColor, ruv).rgb;
            // 空だけの領域（RT の初期化色）との差が少ない所ほど信頼する
            float mirrorW = smoothstep(0.02, 0.25, fres) * (under ? 0.35 : 1.0);
            refl = mix(refl, mirror, mirrorW * 0.85);
          }

          /* --- 水中の見え方 ---
             シーンを描いたテクスチャから「水面より奥にある物」を取り出し、
             水を通る距離ぶん指数関数で減衰させる。距離はピクセルごとに
             連続なので、透ける／透けないの境目が出ない */
          vec2 suv = gl_FragCoord.xy / uResolution;
          float sceneZ = eyeZ(texture2D(uSceneDepth, suv).x);
          // ビュー空間の z 差を視線方向の長さに直す
          float rayScale = length(vWorld - uCamPos) / max(vFogDepth, 0.001);
          float path = max(0.0, sceneZ - vFogDepth) * rayScale;
          vec3 sceneCol = texture2D(uSceneColor, suv).rgb;

          float dn = smoothstep(0.4, 13.0, path);
          vec3 body = mix(uShallow, uDeep, dn);
          body *= mix(0.22, 1.0, 1.0 - uNight * 0.82);

          /* --- 水面で反射する光（空 + 太陽・月のきらめき） --- */
          vec3 surf = refl;
          vec3 H = normalize(V + uSunDir);
          float spec = pow(max(dot(N, H), 0.0), 620.0) * 5.5
                     + pow(max(dot(N, H), 0.0), 48.0) * 0.35;
          surf += uSunColor * spec * (1.0 - uNight) * (1.0 - uRain * 0.4);
          vec3 MH = normalize(V - uSunDir);
          float mnd = max(dot(N, MH), 0.0);
          surf += vec3(0.72, 0.82, 1.0) * (pow(mnd, 300.0) * 1.5 + pow(mnd, 34.0) * 0.10) * uNight;

          /* --- 泡（渚からの水深で表情を変える） ---
             渚のすぐそばは面でべったり、沖へ離れるほどノイズのしきい値を
             上げてまばらな筋になってから消えるようにする。以前は
             「0.42m より浅いか」で泡の強さがほぼ決め打ち（一律）だったので、
             連続的に変化するようにした。広げすぎると岸全体が白く
             うるさく見えるので、届く範囲は控えめにしてある。
             泡の塊の大きさはノイズの周波数（xz の係数）で調整する */
          float lap = smoothstep(0.55, 0.0, vDepth + vWaveH * 1.3);
          float lapN = fbm2(vWorld.xz * 2.0 + vec2(uTime * 0.25, uTime * 0.18));
          float lapThresh = mix(0.85, -0.15, lap);
          float shoreFoam = clamp(smoothstep(lapThresh, lapThresh + 0.55, lapN) * lap, 0.0, 1.0);
          float crest = smoothstep(0.62, 0.95, vWaveH / ${MAX_WAVE_AMP.toFixed(3)} / max(uWind, 0.35));
          float crestFoam = crest * smoothstep(0.35, 0.75, vnoise(vWorld.xz * 2.2 + uTime * 0.3)) * 0.5;
          float foam = clamp(shoreFoam + crestFoam, 0.0, 1.0);
          vec3 foamCol = mix(vec3(0.72, 0.78, 0.80), vec3(1.0), 0.5) * mix(0.35, 1.0, 1.0 - uNight * 0.7);

          // --- 雨粒 ---
          if (uRain > 0.02) {
            vec2 rp = vWorld.xz * 3.4;
            float t = uTime * 3.0;
            float cellT = floor(t);
            vec2 cell = floor(rp);
            float r = hash21(cell + cellT * 7.1);
            float ring = fract(t);
            float d = length(fract(rp) - vec2(0.5));
            float drop = smoothstep(0.02, 0.0, abs(d - ring * 0.5)) * step(0.86, r) * (1.0 - ring);
            surf += vec3(0.5) * drop * uRain;
          }

          /* --- 合成 ---
             下から来る光（湖底が水で減衰したもの）と、水面の反射をフレネルで混ぜる。
             不透明度で被せる方式と違い、湖底は「水の色に溶けていく」ので境目が出ない */
          vec3 bodyEnc = encodeOut(body, uExposure, uLinearOut);
          vec3 trans = exp(-uAbsorb * path);
          vec3 below = mix(bodyEnc, sceneCol, trans);
          vec3 outc = mix(below, encodeOut(surf, uExposure, uLinearOut), under ? 0.35 : fres);
          outc = mix(outc, encodeOut(foamCol, uExposure, uLinearOut), foam * 0.9);

          if (uDebug > 0.5) {
            if (uDebug < 1.5) { gl_FragColor = vec4(sceneCol, 1.0); return; }
            gl_FragColor = vec4(vec3(clamp(path / 12.0, 0.0, 1.0)), 1.0); return;
          }
          // --- フォグ ---
          float fog = smoothstep(uFogNear, uFogFar, vFogDepth);
          outc = mix(outc, encodeOut(uFogColor, uExposure, uLinearOut), fog);
          gl_FragColor = vec4(outc, 1.0);
        }
      `,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'water';
    scene.add(this.mesh);

    this._buildRipples();
    this._buildSplash();

    /* 水面より下を写すレンダーターゲット。水越しの絵はぼやけて見えるので
       解像度は 0.6 倍で足りる（負荷も下がる） */
    this.rtScale = opts.quality === 'low' ? 0.4 : opts.quality === 'high' ? 0.7 : 0.55;
    this.rt = null;

    /* --- 平面反射の準備 ---
       low 品質では無効。ミラー RT は小さめで十分（揺らして見るので） */
    this.reflEnabled = opts.quality !== 'low';
    if (this.reflEnabled) {
      const reflSize = opts.quality === 'high' ? 512 : 320;
      this.reflRT = new THREE.WebGLRenderTarget(reflSize, reflSize, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
        depthBuffer: true,
      });
      this.reflRT.texture.colorSpace = THREE.SRGBColorSpace;
      // 描画漏れの領域は空色で埋める（skyAt の近似色）
      this.reflClearColor = new THREE.Color(0x8fb8d8);
      this.reflCam = new THREE.PerspectiveCamera();
      // render() 内の updateMatrixWorld() に position/quaternion を壊されないよう
      // 通常の autoUpdate のまま使う（_updateReflCam が同期する）
      this.reflPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      this.uniforms.uReflColor.value = this.reflRT.texture;
      this.uniforms.uHasRefl.value = 1;
      this._reflSkip = 0;
    }
  }

  /** 画面サイズに合わせてレンダーターゲットを用意する */
  _ensureRT(renderer) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(2, Math.floor(size.x * this.rtScale));
    const h = Math.max(2, Math.floor(size.y * this.rtScale));
    if (this.rt && this.rt.width === w && this.rt.height === h) return;
    if (this.rt) this.rt.dispose();
    const depth = new THREE.DepthTexture(w, h);
    depth.type = THREE.UnsignedIntType;
    this.rt = new THREE.WebGLRenderTarget(w, h, {
      depthTexture: depth,
      depthBuffer: true,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    this.rt.texture.colorSpace = THREE.SRGBColorSpace;   // 画面と同じ色空間で受け取る
    this.uniforms.uSceneColor.value = this.rt.texture;
    this.uniforms.uSceneDepth.value = depth;
    this.uniforms.uResolution.value.set(size.x, size.y);
  }

  /**
   * 水面を隠した状態でシーンを 1 枚描いておく（毎フレーム、本描画の直前に呼ぶ）。
   * これを水面シェーダが読んで、水中の減衰込みで合成する
   */
  /** 水越しには写らないもの（空・雨・陸の木や岩）を登録しておくと、キャプチャを軽くできる */
  setCaptureHidden(list) {
    this._extraHidden = (list || []).filter(Boolean);
  }

  /* ---------------- 平面反射 ---------------- */
  /**
   * 主カメラを水面（y=0）で鏡映しにしたミラーカメラを作る。
   * 斜めクリッピング平面（oblique projection）で「水面より上」だけを描く。
   */
  _updateReflCam(camera) {
    const cam = this.reflCam;
    const p = this.reflPlane;
    // 反射は水面の少し上（0.06m）で切る：波の峰が平面を突き抜けて
    // 映り込みが欠けるのを防ぐ。高すぎると岸が切れるので小さく抑える
    p.constant = 0.06;
    // 鏡映: M' = S * M（S は y=0 平面での反転）
    _reflMat4.makeScale(1, -1, 1).multiply(camera.matrixWorld);
    // 鏡映で利き手が反転するので、three の慣例（カメラは -Z を向く）へ戻す:
    // z 軸ベクトル（3 列目）と z 行（3 行目）、平行移動の z 成分を反転する
    const e = _reflMat4.elements;
    e[2] *= -1; e[6] *= -1; e[10] *= -1; e[14] *= -1;
    e[8] *= -1; e[9] *= -1;
    cam.matrixWorld.copy(_reflMat4);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    // three は render() 内で camera.updateMatrixWorld() を呼び、matrixAutoUpdate
    // なら matrix を position/quaternion から作り直す。手計算した結果を保持するため
    // decompose で同期しておく（scale は鏡映で負になるが decompose/invert で不変）
    cam.matrix.copy(_reflMat4);
    cam.matrix.decompose(cam.position, cam.quaternion, cam.scale);
    cam.projectionMatrix.copy(camera.projectionMatrix);
    // 射影行列に斜めクリッピング平面（水面）を焼き込む
    _reflPlaneCam.copy(p).applyMatrix4(cam.matrixWorldInverse);
    _reflClip.set(
      _reflPlaneCam.normal.x, _reflPlaneCam.normal.y, _reflPlaneCam.normal.z, _reflPlaneCam.constant
    );
    if (_reflClip.w >= 0) {   // 平面がカメラの裏側ならクリップ不要
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
      return cam;
    }
    _calcOblique(cam.projectionMatrix, _reflClip);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    return cam;
  }

  /**
   * 水面より上をミラーカメラで描いて RT に焼く（本描画の直前に呼ぶ）。
   * 負荷軽減のため 30Hz に間引く。
   */
  captureReflection(renderer, scene, camera) {
    if (!this.reflEnabled) return;
    if (++this._reflSkip < 2 && this._reflOnce) return;   // 30Hz に間引く
    this._reflSkip = 0;
    this._reflOnce = true;
    const cam = this._updateReflCam(camera);
    // ワールド → uv 変換行列をシェーダへ渡す（world→clip→[0,1]）
    _reflVP.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.uniforms.uTexMat.value.copy(_reflVP);

    const hidden = [this.mesh, this.splash];
    for (const r of this.ripples) hidden.push(r.mesh);
    hidden.push(...(this._extraHidden || []).filter(Boolean));
    const vis = hidden.map((o) => o.visible);
    for (const o of hidden) o.visible = false;
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.reflRT);
    renderer.setClearColor(this.reflClearColor, 1);
    renderer.clear();
    // 影は本描画（capture 内）で更新済みなのでここでは作り直さない
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.render(scene, cam);
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.setClearColor(null, 0);
    renderer.setRenderTarget(prevTarget);
    hidden.forEach((o, i) => { o.visible = vis[i]; });
  }

  capture(renderer, scene, camera) {
    this._ensureRT(renderer);
    this.uniforms.uCamNear.value = camera.near;
    this.uniforms.uCamFar.value = camera.far;
    const hidden = [this.mesh, this.splash, ...(this._extraHidden || [])];
    for (const r of this.ripples) hidden.push(r.mesh);
    const vis = hidden.map((o) => o.visible);
    for (const o of hidden) o.visible = false;
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    // 影はこのパスで更新し、本描画では作り直さない（1 フレーム 2 回描くので）
    renderer.shadowMap.autoUpdate = true;
    renderer.render(scene, camera);
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(prevTarget);
    hidden.forEach((o, i) => { o.visible = vis[i]; });
  }

  /* ---------------- CPU 側のサンプリング ---------------- */
  surfaceY(x, z) {
    const depth = this.terrain.depthAt(x, z);
    if (depth <= 0) return 0;
    const damp = smoothstep(0, 1.6, depth) * 0.85 + 0.15 * smoothstep(0, 5, depth);
    return waveHeight(x, z, this.time, this.wind) * damp;
  }

  surfaceNormal(x, z, out) {
    const depth = this.terrain.depthAt(x, z);
    const damp = depth <= 0 ? 0 : smoothstep(0, 1.6, depth) * 0.85 + 0.15 * smoothstep(0, 5, depth);
    return waveNormal(x, z, this.time, this.wind * damp, out);
  }

  /* ---------------- 波紋 ---------------- */
  _buildRipples() {
    this.ripples = [];
    const geo = new THREE.RingGeometry(0.62, 0.98, 40, 1);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 18; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xdff2ff, transparent: true, opacity: 0, depthWrite: false, fog: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.renderOrder = 3;
      this.scene.add(m);
      this.ripples.push({ mesh: m, life: 0, dur: 1, size: 1, x: 0, z: 0 });
    }
    this._rippleIdx = 0;
  }

  addRipple(x, z, size = 1, dur = 1.6) {
    const r = this.ripples[this._rippleIdx++ % this.ripples.length];
    r.life = 0; r.dur = dur; r.size = size; r.x = x; r.z = z;
    r.mesh.visible = true;
    r.mesh.position.set(x, this.surfaceY(x, z) + 0.03, z);
    r.mesh.scale.setScalar(0.25 * size);
    r.mesh.material.opacity = 0.85;
  }

  /* ---------------- 水しぶき ---------------- */
  _buildSplash() {
    const MAX = 220;
    this.splashMax = MAX;
    this.splashParts = [];
    const pos = new Float32Array(MAX * 3);
    const col = new Float32Array(MAX * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setDrawRange(0, 0);

    // 円形スプライト
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(230,245,255,0.75)');
    g.addColorStop(1, 'rgba(200,230,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;

    const mat = new THREE.PointsMaterial({
      size: 0.3, map: tex, transparent: true, depthWrite: false, fog: false,
      blending: THREE.AdditiveBlending, vertexColors: true, sizeAttenuation: true,
    });
    this.splash = new THREE.Points(geo, mat);
    this.splash.frustumCulled = false;
    this.splash.renderOrder = 4;
    this.scene.add(this.splash);
    for (let i = 0; i < MAX; i++) {
      this.splashParts.push({ alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, dur: 1, sz: 1 });
    }
  }

  addSplash(x, y, z, count = 14, power = 1) {
    let added = 0;
    for (let i = 0; i < this.splashMax && added < count; i++) {
      const p = this.splashParts[i];
      if (p.alive) continue;
      p.alive = true;
      const a = rand(0, TAU);
      const sp = rand(0.6, 2.6) * power;
      p.x = x + Math.cos(a) * rand(0, 0.16) * power;
      p.z = z + Math.sin(a) * rand(0, 0.16) * power;
      p.y = y + rand(0, 0.1);
      p.vx = Math.cos(a) * sp * 0.55;
      p.vz = Math.sin(a) * sp * 0.55;
      p.vy = rand(1.4, 4.2) * power;
      p.life = 0;
      p.dur = rand(0.5, 1.1);
      p.sz = rand(0.5, 1.3);
      added++;
    }
  }

  /* ---------------- 更新 ---------------- */
  update(dt, camera, env) {
    this.time += dt;
    const u = this.uniforms;
    u.uTime.value = this.time;
    this.wind = 1 + env.rainIntensity * 1.15 + env.cloudiness * 0.18;
    u.uWind.value = this.wind;
    u.uSunDir.value.copy(env.sunDir);
    u.uSunColor.value.copy(env.sunColor);
    u.uZenith.value.copy(env.zenithColor);
    u.uHorizon.value.copy(env.horizonColor);
    u.uFogColor.value.copy(env.fogColor);
    u.uFogNear.value = env.scene.fog.near;
    u.uFogFar.value = env.scene.fog.far;
    u.uNight.value = env.nightAmount;
    u.uRain.value = env.rainIntensity;
    u.uCamPos.value.copy(camera.position);

    // 波紋
    for (const r of this.ripples) {
      if (!r.mesh.visible) continue;
      r.life += dt;
      const t = r.life / r.dur;
      if (t >= 1) { r.mesh.visible = false; continue; }
      const sc = (0.25 + t * 2.6) * r.size;
      r.mesh.scale.setScalar(sc);
      r.mesh.material.opacity = 0.8 * (1 - t) * (1 - t);
      r.mesh.position.y = this.surfaceY(r.x, r.z) + 0.03;
    }

    // しぶき
    const posAttr = this.splash.geometry.attributes.position;
    const colAttr = this.splash.geometry.attributes.color;
    let n = 0;
    for (let i = 0; i < this.splashMax; i++) {
      const p = this.splashParts[i];
      if (!p.alive) continue;
      p.life += dt;
      if (p.life >= p.dur) { p.alive = false; continue; }
      p.vy -= 9.8 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const surf = this.surfaceY(p.x, p.z);
      if (p.y < surf) {
        p.alive = false;
        if (p.vy < -1.2 && Math.random() < 0.25) this.addRipple(p.x, p.z, 0.28, 0.9);
        continue;
      }
      const a = (1 - p.life / p.dur) * 0.95;
      posAttr.array[n * 3] = p.x;
      posAttr.array[n * 3 + 1] = p.y;
      posAttr.array[n * 3 + 2] = p.z;
      colAttr.array[n * 3] = a * p.sz;
      colAttr.array[n * 3 + 1] = a * p.sz;
      colAttr.array[n * 3 + 2] = a * p.sz;
      n++;
    }
    this.splash.geometry.setDrawRange(0, n);
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
  }
}
