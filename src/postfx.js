/* ===========================================================
   後処理（pmndrs postprocessing を vendor 同梱で使用）
   全品質で composer を使い、水中カメラ時は UnderwaterEffect を適用。
   high 品質のときだけ Bloom を追加する。
   カスタムシェーダ（water/sky）は全品質で uLinearOut=1 のリニア出力にし、
   トーンマップ + sRGB エンコードは ToneMappingEffect で 1 回だけ行う
   =========================================================== */
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  ToneMappingEffect,
  ToneMappingMode,
  KernelSize,
  Effect,
  EffectAttribute,
} from 'postprocessing';
import * as THREE from 'three';

const UNDERWATER_FRAG = /* glsl */ `
uniform float uStrength;
uniform float uTime;
uniform vec3 uSunDir;
uniform float uNight;
uniform float uRain;
uniform float uCloud;
uniform vec3 uAbsorb;
uniform vec3 uCamPos;
uniform float uCamNear;
uniform float uCamFar;
uniform float uWaterY;
uniform float uLinear;
uniform vec2 uSunUv;      // 水面上の太陽を投影した画面座標（光の柱の起点）
uniform float uSunOn;     // 太陽が画面内・水面上にあるか 0..1
uniform float uTurbidity; // 濁り（1 で標準）

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm2(vec2 p) {
  return vnoise(p) * 0.6667 + vnoise(p * 2.03) * 0.3333;
}

float eyeZ(float depth) {
  float z = depth * 2.0 - 1.0;
  return (2.0 * uCamNear * uCamFar) / (uCamFar + uCamNear - z * (uCamFar - uCamNear));
}

void mainUv(inout vec2 uv) {
  if (uStrength < 0.001) return;
  vec2 n = vec2(
    fbm2(uv * 14.0 + vec2(uTime * 0.06, uTime * 0.05)),
    fbm2(uv * 14.0 + vec2(5.7, 2.3) + vec2(uTime * 0.05, -uTime * 0.06))
  );
  uv += (n - 0.5) * 0.0007 * uStrength * (1.0 - uRain * 0.35);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  if (uStrength < 0.001) {
    outputColor = inputColor;
    return;
  }

  float depth = readDepth(uv);
  float viewZ = eyeZ(depth);
  float dist = max(0.0, viewZ);

  vec3 col = inputColor.rgb;

  /* --- 体積散乱（Beer-Lambert + 単一散乱の内向き加算） ---
     以前は線形の THREE.Fog がほぼすべてを担っていたため、水が「平たい
     水色の板」に見えていた。水は指数かつ波長選択で減衰するので、
     透過に exp を、抜けた分に散乱光を足す形へ置き換える。
     こうすると遠くが「水の色に収束」し、近くだけ素の色が残る */
  float camDepth = max(0.0, uWaterY - uCamPos.y);
  vec3 sigma = uAbsorb * uTurbidity;
  vec3 trans = exp(-sigma * dist);

  float sunGate = smoothstep(-0.05, 0.35, uSunDir.y) * (1.0 - uNight * 0.88) * (1.0 - uCloud * 0.55);
  /* 水中の環境光は深さで指数的に落ちる。20m 潜れば同じ湖底でも別の暗さになる */
  float ambient = exp(-camDepth * 0.085) * mix(0.28, 1.0, sunGate);
  vec3 scatterCol = mix(vec3(0.085, 0.30, 0.34), vec3(0.020, 0.075, 0.105), uNight);
  vec3 inscatter = scatterCol * ambient * (vec3(1.0) - trans);

  col = col * trans + inscatter * uStrength;

  /* --- 光の柱（薄明光線） ---
     水面で屈折した平行光が濁りに散乱して筋になる。太陽の画面位置から
     放射状にノイズを引くだけの近似だが、水中の絵で一番効く要素 */
  if (uSunOn > 0.001) {
    vec2 d = uv - uSunUv;
    float r = length(d);
    float ang = atan(d.y, d.x);
    float shaft = fbm2(vec2(ang * 5.2, r * 2.4 - uTime * 0.11));
    shaft += fbm2(vec2(ang * 11.0 + 3.7, r * 1.3 + uTime * 0.07)) * 0.6;
    shaft = smoothstep(0.62, 1.05, shaft);
    float reach = exp(-camDepth * 0.14) * (1.0 - smoothstep(0.05, 0.95, r));
    vec3 shaftCol = vec3(0.42, 0.78, 0.86);
    col += shaftCol * shaft * reach * sunGate * uSunOn * uStrength * 0.13
         * (1.0 - uRain * 0.4);
  }

  /* --- 水面直下の明るみ --- */
  float surfaceLight = exp(-camDepth * 0.42);
  col += vec3(0.30, 0.66, 0.76) * surfaceLight * sunGate * uStrength * 0.05
       * mix(0.35, 1.0, uLinear);

  /* 周辺減光：水中は視界が閉じる */
  float vig = 1.0 - smoothstep(0.32, 0.92, length(uv - 0.5) * 1.42);
  col *= mix(1.0, 0.62 + 0.38 * vig, uStrength);

  /* コントラストをわずかに落として水中感を出す */
  col = mix(col, col * col, 0.015 * uStrength);

  outputColor = vec4(col, inputColor.a);
}
`;

class UnderwaterEffect extends Effect {
  constructor() {
    super('UnderwaterEffect', UNDERWATER_FRAG, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map([
        ['uStrength', new THREE.Uniform(0)],
        ['uTime', new THREE.Uniform(0)],
        ['uSunDir', new THREE.Uniform(new THREE.Vector3(0, 1, 0))],
        ['uNight', new THREE.Uniform(0)],
        ['uRain', new THREE.Uniform(0)],
        ['uCloud', new THREE.Uniform(0)],
        ['uAbsorb', new THREE.Uniform(new THREE.Vector3(0.36, 0.15, 0.09))],
        ['uCamPos', new THREE.Uniform(new THREE.Vector3())],
        ['uCamNear', new THREE.Uniform(0.1)],
        ['uCamFar', new THREE.Uniform(3000)],
        ['uWaterY', new THREE.Uniform(0)],
        ['uLinear', new THREE.Uniform(0)],
        ['uSunUv', new THREE.Uniform(new THREE.Vector2(0.5, 0.9))],
        ['uSunOn', new THREE.Uniform(0)],
        ['uTurbidity', new THREE.Uniform(1)],
      ]),
    });
  }
}

export class PostFX {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.PerspectiveCamera} camera
   * @param {{quality: string, water: object, sky: object, exposure: number}} opts
   */
  constructor(renderer, scene, camera, opts = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.quality = opts.quality || 'mid';
    this.composer = null;
    this.underwater = null;
    this.bloom = null;
    this.toneMapping = null;
    this.effectPass = null;

    this._linearTargets = [];
    if (opts.water?.uniforms?.uLinearOut) this._linearTargets.push(opts.water.uniforms.uLinearOut);
    if (opts.sky?.uLinearOut) this._linearTargets.push(opts.sky.uLinearOut);

    this._build(this.quality);
  }

  setLinearOutput(on) {
    for (const u of this._linearTargets) u.value = on ? 1 : 0;
    if (this.underwater) this.underwater.uniforms.get('uLinear').value = on ? 1 : 0;
  }

  _build(q) {
    this.dispose();
    this.quality = q;
    const high = q === 'high';
    // EffectPass は dispose 時に Effect も破棄するため、品質変更ごとに作り直す。
    this.underwater = new UnderwaterEffect();

    this.composer = new EffectComposer(this.renderer, {
      frameBufferType: high ? THREE.HalfFloatType : undefined,
      multisampling: high ? Math.min(4, this.renderer.capabilities.maxSamples || 0) : 0,
    });
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    const effects = [];
    if (high) {
      this.bloom = new BloomEffect({
        luminanceThreshold: 0.62,
        luminanceSmoothing: 0.28,
        intensity: 0.55,
        mipmapBlur: true,
        kernelSize: KernelSize.LARGE,
      });
      effects.push(this.bloom);
    } else {
      this.bloom = null;
    }
    effects.push(this.underwater);
    // composer の入力を全品質でリニアに揃え、ここで ACES と sRGB 変換を一度だけ行う。
    this.toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    effects.push(this.toneMapping);

    this.effectPass = new EffectPass(this.camera, ...effects);
    this.effectPass.encodeOutput = true;
    this.composer.addPass(this.effectPass);
    this.setLinearOutput(true);
  }

  /** 水中カメラ用 uniform を更新（毎フレーム） */
  updateUnderwater(ctx) {
    if (!ctx || !this.underwater) return;
    const u = this.underwater.uniforms;
    const strength = ctx.strength ?? 0;
    u.get('uStrength').value = strength;
    u.get('uTime').value = ctx.time ?? 0;
    u.get('uSunDir').value.copy(ctx.sunDir);
    u.get('uNight').value = ctx.night ?? 0;
    u.get('uRain').value = ctx.rain ?? 0;
    u.get('uCloud').value = ctx.cloud ?? 0;
    u.get('uAbsorb').value.copy(ctx.absorb);
    u.get('uCamPos').value.copy(ctx.camPos);
    u.get('uCamNear').value = ctx.camNear ?? 0.1;
    u.get('uCamFar').value = ctx.camFar ?? 3000;
    u.get('uWaterY').value = ctx.waterY ?? 0;
    if (ctx.sunUv) u.get('uSunUv').value.copy(ctx.sunUv);
    u.get('uSunOn').value = ctx.sunOn ?? 0;
    u.get('uTurbidity').value = ctx.turbidity ?? 1;
    // 水中でもBloomは残すが、視界を白く曇らせないよう大幅に弱める。
    if (this.bloom) this.bloom.intensity = THREE.MathUtils.lerp(0.55, 0.10, strength);
  }

  /** 品質変更 */
  setQuality(q) {
    if (q === this.quality && this.composer) return;
    this._build(q);
    const size = this.renderer.getSize(new THREE.Vector2());
    this.setSize(size.width, size.height);
  }

  setSize(width, height) {
    if (this.composer) this.composer.setSize(width, height);
  }

  render(dt) {
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this.composer) {
      this.composer.dispose();
      this.composer = null;
    }
    this.effectPass = null;
    this.bloom = null;
    this.toneMapping = null;
    this.underwater = null;
    this.renderer.autoClear = true;
  }
}
