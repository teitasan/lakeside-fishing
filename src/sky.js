/* ===========================================================
   空・太陽・時間帯・天候
   =========================================================== */
import * as THREE from 'three';
import { COMMON_GLSL } from './shaders.js?v=20260830-forest6';
import { clamp01, lerp, smoothstep, rand, TAU, damp } from './util.js';

/* 時刻ごとの色キーフレーム（hour, 天頂色, 地平色, 太陽色, 環境光係数） */
const KEYS = [
  { h: 0.0, zen: 0x020711, hor: 0x081120, sun: 0x16253c, amb: 0.14, dir: 0.05 },
  { h: 4.2, zen: 0x081527, hor: 0x18203a, sun: 0x2c3550, amb: 0.18, dir: 0.09 },
  { h: 5.4, zen: 0x18375c, hor: 0x7d4f5c, sun: 0xff8f52, amb: 0.40, dir: 0.55 },
  { h: 6.4, zen: 0x2a5c96, hor: 0xf7a068, sun: 0xffb478, amb: 0.66, dir: 1.9 },
  { h: 8.5, zen: 0x2d74be, hor: 0x9fc6e4, sun: 0xffeecd, amb: 0.90, dir: 2.9 },
  { h: 12.0, zen: 0x1f66c6, hor: 0xafd2ec, sun: 0xfffaf0, amb: 1.0, dir: 3.3 },
  { h: 15.5, zen: 0x2a6dbe, hor: 0xb6cee0, sun: 0xfff2d8, amb: 0.95, dir: 2.9 },
  { h: 17.6, zen: 0x24508c, hor: 0xf19256, sun: 0xffa055, amb: 0.68, dir: 1.7 },
  { h: 18.8, zen: 0x17305c, hor: 0xa85a50, sun: 0xf5713c, amb: 0.42, dir: 0.5 },
  { h: 20.0, zen: 0x0a1832, hor: 0x232743, sun: 0x333b5c, amb: 0.22, dir: 0.11 },
  { h: 24.0, zen: 0x020711, hor: 0x081120, sun: 0x16253c, amb: 0.14, dir: 0.05 },
];

export const WEATHERS = {
  clear: { key: 'clear', name: '晴れ', icon: 'weather-clear', cloud: 0.14, rain: 0, bite: 1.0, weight: 44 },
  cloudy: { key: 'cloudy', name: 'くもり', icon: 'weather-cloudy', cloud: 0.72, rain: 0, bite: 1.12, weight: 34 },
  rain: { key: 'rain', name: '雨', icon: 'weather-rain', cloud: 0.95, rain: 0.85, bite: 1.3, weight: 22 },
};

const c1 = new THREE.Color();
const c2 = new THREE.Color();

export class Environment {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.exposure = opts.exposure ?? 1.0;
    this.hour = 9;
    this.sunDir = new THREE.Vector3(0.3, 0.6, 0.4).normalize();
    this.nightAmount = 0;
    this.horizonColor = new THREE.Color(0x9fc4de);
    this.zenithColor = new THREE.Color(0x2c72cc);
    this.sunColor = new THREE.Color(0xffffff);
    this.fogColor = new THREE.Color(0x9fc4de);

    /* ---- 天候 ---- */
    this.weather = WEATHERS.clear;
    this.nextWeather = WEATHERS.clear;
    this.weatherTimer = rand(3, 6); // 残りゲーム内時間
    this.cloudiness = this.weather.cloud;
    this.rainIntensity = 0;

    this._buildSky();
    this._buildLights();
    this._buildRain();

    scene.fog = new THREE.Fog(this.fogColor.getHex(), 90, 620);
  }

  /* ---------------- 空ドーム ---------------- */
  _buildSky() {
    const geo = new THREE.SphereGeometry(1500, 48, 24);
    this.skyUniforms = {
      uZenith: { value: new THREE.Color(0x2c72cc) },
      uHorizon: { value: new THREE.Color(0xd3e8f8) },
      uSunColor: { value: new THREE.Color(0xffffff) },
      uSunDir: { value: this.sunDir.clone() },
      uNight: { value: 0 },
      uCloud: { value: 0.2 },
      uTime: { value: 0 },
      uExposure: { value: this.exposure },
      uLinearOut: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.skyUniforms,
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        ${COMMON_GLSL}
        uniform vec3 uZenith, uHorizon, uSunColor, uSunDir;
        uniform float uNight, uCloud, uTime, uExposure, uLinearOut;
        varying vec3 vDir;

        void main() {
          vec3 dir = normalize(vDir);
          float hy = dir.y;

          // 基本グラデーション
          float g = pow(clamp(hy, 0.0, 1.0), 0.62);
          vec3 col = mix(uHorizon, uZenith, g);
          // 地平線下（湖の向こう）は暗く
          col *= 1.0 - smoothstep(0.0, -0.16, hy) * 0.55;

          // 太陽
          float sd = max(dot(dir, uSunDir), 0.0);
          float disc = smoothstep(0.9994, 0.99975, sd);
          col += uSunColor * disc * 14.0 * (1.0 - uNight);
          col += uSunColor * pow(sd, 220.0) * 1.6;
          col += uSunColor * pow(sd, 9.0) * 0.30;
          col += uSunColor * pow(sd, 2.2) * 0.09;

          // 月
          vec3 mdir = -uSunDir;
          float md = max(dot(dir, mdir), 0.0);
          float moonDisc = smoothstep(0.9992, 0.99965, md);
          col += vec3(0.95, 0.97, 1.0) * moonDisc * 9.0 * uNight;
          col += vec3(0.45, 0.55, 0.85) * pow(md, 30.0) * 0.26 * uNight;

          // 星
          if (uNight > 0.02 && hy > -0.02) {
            vec2 suv = dir.xz / (abs(dir.y) + 0.25);
            vec2 cell = floor(suv * 120.0);
            float n = hash21(cell);
            float bright = smoothstep(0.9962, 0.9995, n);
            float tw = 0.55 + 0.45 * sin(uTime * 2.4 + n * 240.0);
            float horizonFade = smoothstep(-0.02, 0.22, hy);
            col += vec3(0.85, 0.9, 1.0) * bright * tw * 1.7 * uNight * horizonFade;

            /* --- 天の川 ---
               星空の帯を、ふくらみを持たせたノイズで表す。中心線は
               大円（軸を少し傾けた銀河面）で、そこからの距離で明るさを決める */
            vec3 gal = normalize(vec3(0.42, 1.0, 0.26));
            float gd = abs(dot(dir, gal));
            float band = exp(-gd * gd * 34.0);
            float dust = fbm4(suv * 2.6 + vec2(3.1, -7.4));
            float milky = band * (0.35 + 0.65 * smoothstep(0.25, 0.75, fbm4(suv * 5.2 + 11.0)));
            milky *= mix(0.45, 1.15, dust) * horizonFade;
            col += vec3(0.62, 0.70, 0.92) * milky * 0.30
                 + vec3(0.85, 0.80, 0.95) * band * 0.12;
          }

          // 雲
          float above = smoothstep(0.005, 0.30, hy);
          if (above > 0.001) {
            vec2 cuv = dir.xz / max(hy, 0.055) * 0.85;
            cuv += vec2(uTime * 0.010, uTime * 0.004);
            float f = fbm4(cuv * 0.55);
            float f2 = vnoise(cuv * 1.6 + 13.7);
            float shape = f * 0.78 + f2 * 0.22;
            float cover = smoothstep(0.62 - uCloud * 0.42, 0.90 - uCloud * 0.30, shape);
            cover *= above;

            float sunUp = clamp(uSunDir.y, 0.0, 1.0);
            vec3 lit = mix(vec3(0.95, 0.86, 0.78), vec3(1.02, 1.0, 0.98), sunUp);
            vec3 dark = mix(vec3(0.16, 0.18, 0.24), vec3(0.42, 0.45, 0.52), sunUp);
            float rim = pow(max(dot(dir, uSunDir), 0.0), 4.0);
            vec3 cloudCol = mix(dark, lit, clamp(0.35 + shape * 0.7, 0.0, 1.0));
            cloudCol += uSunColor * rim * 0.5 * (1.0 - uNight);
            cloudCol *= mix(0.28, 1.0, 1.0 - uNight * 0.8);
            col = mix(col, cloudCol, cover * 0.92);
          }

          gl_FragColor = vec4(encodeOut(col, uExposure, uLinearOut), 1.0);

        }
      `,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1000;
    this.scene.add(this.sky);
  }

  /* ---------------- ライト ---------------- */
  _buildLights() {
    this.sun = new THREE.DirectionalLight(0xffffff, 3.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const cam = this.sun.shadow.camera;
    cam.near = 1;
    cam.far = 340;
    cam.left = -60; cam.right = 60; cam.top = 60; cam.bottom = -60;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.06;
    this.sunTarget = new THREE.Object3D();
    this.sun.target = this.sunTarget;
    this.scene.add(this.sun, this.sunTarget);

    this.moon = new THREE.DirectionalLight(0x9fb6e8, 0.0);
    this.scene.add(this.moon);

    this.hemi = new THREE.HemisphereLight(0xa9ccea, 0x3b4a3a, 0.9);
    this.scene.add(this.hemi);
  }

  /* ---------------- 雨 ---------------- */
  _buildRain() {
    this.rainMax = 1800;
    this.rainCount = 1400;
    const pos = new Float32Array(this.rainMax * 6);
    this.rainParticles = new Float32Array(this.rainMax * 3);
    for (let i = 0; i < this.rainMax; i++) {
      this.rainParticles[i * 3] = rand(-55, 55);
      this.rainParticles[i * 3 + 1] = rand(-8, 46);
      this.rainParticles[i * 3 + 2] = rand(-55, 55);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0xd2e6f2, transparent: true, opacity: 0.42, depthWrite: false, fog: true,
    });
    this.rain = new THREE.LineSegments(geo, mat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.scene.add(this.rain);
  }

  /** 天候の進行（dtHours: 経過ゲーム内時間） */
  tickWeather(dtHours) {
    this.weatherTimer -= dtHours;
    if (this.weatherTimer <= 0) {
      const list = Object.values(WEATHERS);
      let total = 0;
      for (const w of list) total += w === this.weather ? w.weight * 0.35 : w.weight;
      let r = Math.random() * total;
      let chosen = list[0];
      for (const w of list) {
        r -= w === this.weather ? w.weight * 0.35 : w.weight;
        if (r <= 0) { chosen = w; break; }
      }
      this.weather = chosen;
      this.weatherTimer = rand(2.5, 6.5);
      return chosen;
    }
    return null;
  }

  setWeather(key) {
    if (WEATHERS[key]) {
      this.weather = WEATHERS[key];
      this.weatherTimer = rand(3, 6);
    }
  }

  /** 1フレーム更新 */
  update(dt, hour, camera, focus) {
    this.hour = hour;
    const t = ((hour % 24) + 24) % 24;

    // --- キーフレーム補間 ---
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1].h <= t) i++;
    const A = KEYS[i], B = KEYS[i + 1];
    const f = clamp01((t - A.h) / (B.h - A.h));

    this.zenithColor.copy(c1.setHex(A.zen)).lerp(c2.setHex(B.zen), f);
    this.horizonColor.copy(c1.setHex(A.hor)).lerp(c2.setHex(B.hor), f);
    this.sunColor.copy(c1.setHex(A.sun)).lerp(c2.setHex(B.sun), f);
    const ambI = lerp(A.amb, B.amb, f);
    const dirI = lerp(A.dir, B.dir, f);

    // --- 太陽方向 ---
    const ang = ((t - 6) / 24) * TAU;
    this.sunDir.set(Math.cos(ang), Math.sin(ang), 0.34).normalize();
    this.nightAmount = clamp01(smoothstep(0.08, -0.16, this.sunDir.y));

    // --- 天候の滑らかな遷移 ---
    this.cloudiness = damp(this.cloudiness, this.weather.cloud, 0.4, dt);
    this.rainIntensity = damp(this.rainIntensity, this.weather.rain, 0.35, dt);

    const cloudDim = 1 - this.cloudiness * 0.45;

    // --- 空 uniforms ---
    const u = this.skyUniforms;
    u.uTime.value += dt;
    u.uZenith.value.copy(this.zenithColor);
    u.uHorizon.value.copy(this.horizonColor);
    u.uSunColor.value.copy(this.sunColor);
    u.uSunDir.value.copy(this.sunDir);
    u.uNight.value = this.nightAmount;
    u.uCloud.value = this.cloudiness;

    // --- フォグ ---
    this.fogColor.copy(this.horizonColor).lerp(this.zenithColor, 0.28);
    if (this.cloudiness > 0.4) this.fogColor.lerp(c1.setRGB(0.42, 0.46, 0.5), (this.cloudiness - 0.4) * 0.5);
    if (this.underwater) {
      // 水中カメラ用：短距離の青緑フォグ
      this.fogColor.setRGB(0.055, 0.16, 0.19).multiplyScalar(lerp(1, 0.35, this.nightAmount));
      this.scene.fog.color.copy(this.fogColor);
      /* 水中の減衰は PostFX の指数散乱が担当する。ここは標準マテリアル用の
         遠方バックストップに留める。線形フォグを主役にすると、水が波長選択で
         濁っていく感じが出ず「平たい水色の板」になってしまう */
      this.scene.fog.near = lerp(14, 6, this.nightAmount);
      this.scene.fog.far = lerp(120, 62, this.nightAmount);
    } else {
      this.scene.fog.color.copy(this.fogColor);
      this.scene.fog.near = lerp(150, 30, this.rainIntensity);
      this.scene.fog.far = lerp(900, 210, this.rainIntensity);
    }

    // --- ライト ---
    this.sun.color.copy(this.sunColor);
    this.sun.intensity = dirI * cloudDim;
    this.moon.intensity = this.nightAmount * 0.34 * cloudDim;
    this.moon.position.copy(this.sunDir).multiplyScalar(-160);
    this.hemi.intensity = lerp(0.22, 0.78, ambI) * lerp(1, 1.35, this.cloudiness)
      + (this.underwater ? 1.15 * lerp(1, 0.3, this.nightAmount) : 0);
    this.hemi.color.copy(this.horizonColor).lerp(this.zenithColor, 0.5);
    this.hemi.groundColor.setRGB(0.10 + 0.12 * ambI, 0.13 + 0.13 * ambI, 0.09 + 0.1 * ambI);

    // 影カメラを注視点に追従
    const fx = focus ? focus.x : 0, fz = focus ? focus.z : 0;
    this.sunTarget.position.set(fx, 0, fz);
    this.sun.position.set(fx + this.sunDir.x * 150, this.sunDir.y * 150 + 6, fz + this.sunDir.z * 150);
    this.sun.visible = this.sunDir.y > -0.12 && this.sun.intensity > 0.02;

    // 空ドームをカメラに追従
    if (camera) this.sky.position.copy(camera.position);

    // --- 雨 ---
    this._updateRain(dt, camera);
  }

  _updateRain(dt, camera) {
    const vis = !this.underwater && this.rainIntensity > 0.03;
    this.rain.visible = vis;
    if (!vis || !camera) return;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const p = this.rainParticles;
    const arr = this.rain.geometry.attributes.position.array;
    const speed = 34 + 26 * this.rainIntensity;
    const windX = 5 * this.rainIntensity;
    const len = 1.1 + 0.9 * this.rainIntensity;
    const active = Math.min(this.rainCount, Math.floor(this.rainCount * clamp01(this.rainIntensity / 0.85)));
    const HX = 55, HY = 27;

    for (let i = 0; i < this.rainMax; i++) {
      const i3 = i * 3, i6 = i * 6;
      if (i >= active) {
        arr[i6] = arr[i6 + 1] = arr[i6 + 2] = 0;
        arr[i6 + 3] = arr[i6 + 4] = arr[i6 + 5] = 0;
        continue;
      }
      p[i3] += windX * dt;
      p[i3 + 1] -= speed * dt;
      // カメラ相対でラップ
      let x = p[i3], y = p[i3 + 1], z = p[i3 + 2];
      if (x < cx - HX) x += HX * 2; else if (x > cx + HX) x -= HX * 2;
      if (z < cz - HX) z += HX * 2; else if (z > cz + HX) z -= HX * 2;
      if (y < cy - HY * 0.5) y += HY * 1.6;
      else if (y > cy + HY) y -= HY * 1.6;
      p[i3] = x; p[i3 + 1] = y; p[i3 + 2] = z;

      arr[i6] = x; arr[i6 + 1] = y; arr[i6 + 2] = z;
      arr[i6 + 3] = x + windX * 0.04 * len;
      arr[i6 + 4] = y - len * 1.6;
      arr[i6 + 5] = z;
    }
    this.rain.geometry.attributes.position.needsUpdate = true;
    this.rain.material.opacity = 0.2 + 0.34 * this.rainIntensity;
  }

  setQuality(q) {
    const size = q === 'high' ? 2560 : q === 'low' ? 1024 : 2048;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;
      }
    }
    this.rainCount = q === 'low' ? 600 : q === 'high' ? 1800 : 1400;
  }
}
