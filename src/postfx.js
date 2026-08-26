/* ===========================================================
   後処理（pmndrs postprocessing を vendor 同梱で使用）
   high 品質のときだけ Bloom を有効化する。
   カスタムシェーダ（water/sky）は uLinearOut=1 でリニア出力し、
   トーンマップ + sRGB エンコードはここで 1 回だけ行う
   =========================================================== */
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  ToneMappingEffect,
  ToneMappingMode,
  KernelSize,
} from 'postprocessing';
import * as THREE from 'three';

export class PostFX {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.PerspectiveCamera} camera
   * @param {{quality: string, water: object, sky: object, exposure: number}} opts
   */
  constructor(renderer, scene, camera, opts = {}) {
    this.enabled = false;
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.composer = null;

    // カスタムシェーダをリニア出力へ切り替える（composer 経由のときだけ）
    this._linearTargets = [];
    if (opts.water?.uniforms?.uLinearOut) this._linearTargets.push(opts.water.uniforms.uLinearOut);
    if (opts.sky?.uLinearOut) this._linearTargets.push(opts.sky.uLinearOut);

    if (opts.quality === 'high') this._build();
    this.setLinearOutput(this.enabled);
  }

  setLinearOutput(on) {
    for (const u of this._linearTargets) u.value = on ? 1 : 0;
  }

  /** composer を作る（初回・品質を high に変えたとき） */
  _build() {
    this.composer = new EffectComposer(this.renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: Math.min(4, this.renderer.capabilities.maxSamples || 0),
    });
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = new BloomEffect({
      luminanceThreshold: 0.62,
      luminanceSmoothing: 0.28,
      intensity: 0.55,
      mipmapBlur: true,
      kernelSize: KernelSize.LARGE,
    });
    // three 側はレンダーターゲット描画ではトーンマップしないので、
    // 最後のパスで ACES を一度だけ適用して sRGB へエンコードする。
    // ACES の露出は three がプログラム束縛時に renderer.toneMappingExposure を
    // 自動アップロードしてくれる（tonemapping_pars_fragment の uniform）ので、
    // ここでは供給しない。ゲーム側の EXPOSURE がそのまま効く
    this.toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    const pass = new EffectPass(this.camera, bloom, this.toneMapping);
    pass.encodeOutput = true;   // リニア -> sRGB は EffectPass の最後で行う
    this.composer.addPass(pass);
    this.enabled = true;
  }

  /** 品質変更。high 以外では composer を破棄して直描画に戻す */
  setQuality(q) {
    const want = q === 'high';
    if (want === this.enabled) return;
    if (want) {
      this._build();
      const size = this.renderer.getSize(new THREE.Vector2());
      this.setSize(size.width, size.height);
    } else {
      this.dispose();
      this.enabled = false;
    }
    this.setLinearOutput(want);
  }

  setSize(width, height) {
    // EffectComposer.setSize は renderer.setSize も行う（CSS ピクセル単位）。
    // 描画バッファサイズを渡すとキャンバスが拡大されてしまうので、
    // renderer と同じ CSS サイズをそのまま渡す
    if (this.composer) this.composer.setSize(width, height);
  }

  /** 毎フレームの描画。composer 無効時は renderer.render をそのまま呼ぶ */
  render(dt) {
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this.composer) {
      this.composer.dispose();
      this.composer = null;
    }
    // composer は autoClear を無効化するので、直描画へ戻すときに元へ戻す
    this.renderer.autoClear = true;
  }
}
