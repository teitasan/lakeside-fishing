/* ===========================================================
   水中プロップ散布：決定論的 InstancedMesh + GPU 揺れ / 距離間引き / コースティクス
   =========================================================== */
import * as THREE from 'three';
import { CAUSTICS_GLSL } from './shaders.js?v=20260828-uwgfx13';
import { makeRng, clamp01, smoothstep, TAU } from './util.js';
import { fitWeedScale, placeUpToTarget } from './underwaterScatterMath.js?v=20260827-lkwgfx';

const DENSITY = { low: 0.25, mid: 0.6, high: 1.0 };
const MAX = { weeds: 2200, pebbles: 2800, debris: 420 };

const UW_COMMON = /* glsl */ `
varying vec3 vUwWorldPos;
varying float vUwKeep;
uniform float uUwTime;
uniform vec3 uUwCamPos;
uniform vec2 uFlowDir;
uniform float uFlowStrength;
uniform float uSway;
`;

const UW_VERT = /* glsl */ `

float uwHash21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float uwKeepAt(vec3 wpos) {
  float dist = length(wpos - uUwCamPos);
  if (dist > 100.0) return 0.0;
  float h = uwHash21(floor(wpos.xz * 0.37));
  if (dist > 60.0) {
    float t = smoothstep(60.0, 100.0, dist);
    return step(h, mix(0.22, 0.0, t));
  }
  if (dist > 25.0) {
    float t = smoothstep(25.0, 60.0, dist);
    return step(h, mix(1.0, 0.28, t));
  }
  return 1.0;
}
`;

const UW_BEGIN = /* glsl */ `
{
  vec3 uwInstancePos = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vUwKeep = uwKeepAt(uwInstancePos);
  if (vUwKeep >= 0.001 && uSway > 0.001) {
    float dist = length(uwInstancePos - uUwCamPos);
    float motion = (1.0 - smoothstep(25.0, 60.0, dist) * 0.72) * vUwKeep;
    float phase = dot(uwInstancePos.xz, vec2(0.71, 0.53));
    float swayW = clamp(transformed.y, 0.0, 2.5);
    vec2 flowWorld = length(uFlowDir) > 1e-4 ? normalize(uFlowDir) : vec2(0.0, 1.0);
    vec3 flowWorld3 = vec3(flowWorld.x, 0.0, flowWorld.y);
    vec3 basisX = mat3(modelMatrix) * instanceMatrix[0].xyz;
    vec3 basisZ = mat3(modelMatrix) * instanceMatrix[2].xyz;
    float basisXLen = max(length(basisX), 1e-4);
    float basisZLen = max(length(basisZ), 1e-4);
    vec2 flow = vec2(
      dot(flowWorld3, basisX / basisXLen) / basisXLen,
      dot(flowWorld3, basisZ / basisZLen) / basisZLen
    );
    vec2 crossFlow = vec2(-flow.y, flow.x);
    float w1 = sin(uUwTime * 1.75 + phase);
    float w2 = sin(uUwTime * 2.35 + phase * 1.65 + 1.1);
    float g = 0.65 + 0.35 * sin(uUwTime * 0.85 + phase * 0.2);
    vec2 bend = flow * w1 + crossFlow * w2 * 0.28;
    transformed.x += bend.x * uFlowStrength * uSway * swayW * motion * g;
    transformed.z += bend.y * uFlowStrength * uSway * swayW * motion * g;
  }
  vUwWorldPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
}
`;

function patchUwMaterial(mat, { causticsUniforms, sway = 0.04, caustics = true } = {}) {
  mat.onBeforeCompile = (shader) => {
    if (causticsUniforms) Object.assign(shader.uniforms, causticsUniforms);
    shader.uniforms.uUwTime = { value: 0 };
    shader.uniforms.uUwCamPos = { value: new THREE.Vector3() };
    shader.uniforms.uFlowDir = { value: new THREE.Vector2(0, 1) };
    shader.uniforms.uFlowStrength = { value: 0.05 };
    shader.uniforms.uSway = { value: sway };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${UW_COMMON}\n${UW_VERT}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${UW_BEGIN}`)
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n  if (vUwKeep < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);'
      );

    if (caustics) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${UW_COMMON}\n${CAUSTICS_GLSL}`)
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>\n  totalEmissiveRadiance += causticLight(vUwWorldPos, normal);`
        );
    } else {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>\n${UW_COMMON}`
      );
    }
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <clipping_planes_fragment>',
      '#include <clipping_planes_fragment>\n  if (vUwKeep < 0.5) discard;'
    );

    mat.userData.uwUniforms = shader.uniforms;
  };
  mat.customProgramCacheKey = () => `uw-prop-v2-${sway}-${caustics ? 1 : 0}`;
  return mat;
}

/** InstancedMesh/通常Meshの両方で使える、水中部分限定のcaustics注入。 */
export function addUnderwaterCaustics(mat, causticsUniforms, cacheKey = 'uw-caustics-v2') {
  if (!causticsUniforms) return mat;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, causticsUniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\n        varying vec3 vUwCaustWorldPos;'
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vUwCaustWorldPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vUwCaustWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vUwCaustWorldPos;
        ${CAUSTICS_GLSL}`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += causticLight(vUwCaustWorldPos, normal);`
      );
  };
  mat.customProgramCacheKey = () => `${cacheKey}-normal-gated-v2`;
  return mat;
}

/** Low/Midを湖の一部へ偏らせないよう、canonical配置を決定論的に並べ替える。 */
function shuffleInstances(mesh, count, seed) {
  const rng = makeRng(seed >>> 0);
  const a = new THREE.Matrix4();
  const b = new THREE.Matrix4();
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    if (i === j) continue;
    mesh.getMatrixAt(i, a);
    mesh.getMatrixAt(j, b);
    mesh.setMatrixAt(i, b);
    mesh.setMatrixAt(j, a);
  }
}

export class UnderwaterPropScatter {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./terrain.js').Terrain} terrain
   * @param {{ causticsUniforms?: object, quality?: string }} opts
   */
  constructor(scene, terrain, opts = {}) {
    this.scene = scene;
    this.terrain = terrain;
    this.causticsUniforms = opts.causticsUniforms || null;
    this.quality = opts.quality || 'mid';
    this.group = new THREE.Group();
    this.group.name = 'underwaterProps';
    scene.add(this.group);
    this.meshes = [];
    this.materials = [];
    this._build();
    this.setQuality(this.quality);
  }

  _build() {
    const t = this.terrain;
    const rng = makeRng((t.seed ^ 0xa11ce) >>> 0);
    const lake = t.lake;

    const weedGeo = new THREE.ConeGeometry(0.05, 0.9, 4, 1, true);
    weedGeo.translate(0, 0.45, 0);
    const pebbleGeo = new THREE.IcosahedronGeometry(1, 0);
    const twigGeo = new THREE.CylinderGeometry(0.04, 0.06, 1, 4);
    twigGeo.translate(0, 0.5, 0);

    const weedMat = patchUwMaterial(
      new THREE.MeshStandardMaterial({
        color: 0x3f5a32, roughness: 1, side: THREE.DoubleSide, flatShading: true,
      }),
      { causticsUniforms: this.causticsUniforms, sway: 1.25 }
    );
    const pebbleMat = patchUwMaterial(
      new THREE.MeshStandardMaterial({ color: 0x5f635e, roughness: 0.97, flatShading: true }),
      { causticsUniforms: this.causticsUniforms, sway: 0 }
    );
    const debrisMat = patchUwMaterial(
      new THREE.MeshStandardMaterial({ color: 0x4a3d2e, roughness: 1, flatShading: true }),
      { causticsUniforms: this.causticsUniforms, sway: 0.12 }
    );

    const slots = {
      weeds: this._makeMesh(weedGeo, weedMat, MAX.weeds, 'weeds'),
      pebbles: this._makeMesh(pebbleGeo, pebbleMat, MAX.pebbles, 'pebbles'),
      debris: this._makeMesh(twigGeo, debrisMat, MAX.debris, 'debris'),
    };

    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const qt = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const UP = new THREE.Vector3(0, 1, 0);

    const tryPlace = (cat, x, z, composeFn) => {
      const slot = slots[cat];
      if (slot.index >= slot.max) return false;
      const h = t.heightAt(x, z);
      const d = -h;
      if (d < 0.35 || d > 18) return false;
      const slope = t.slopeAt(x, z);
      if (slope > 1.55) return false;
      if (t.distToDock(x, z) < 2.2) return false;
      const idx = slot.index;
      if (!composeFn(h, d, slope, x, z, idx)) return false;
      slot.index++;
      return true;
    };

    /* --- 構造物周辺の枝・根（優先度高） --- */
    for (const st of lake.structures) {
      const n = st.kind === 'snag' ? 14 + Math.floor(rng() * 10) : 6 + Math.floor(rng() * 5);
      placeUpToTarget(n, n * 8, () => {
        if (slots.debris.index >= MAX.debris) return null;
        const ang = rng() * TAU;
        const rad = st.r * (0.8 + rng() * 2.8);
        const x = st.x + Math.cos(ang) * rad;
        const z = st.z + Math.sin(ang) * rad;
        return tryPlace('debris', x, z, (h, d, slope, px, pz, idx) => {
          const len = 0.35 + rng() * 0.85;
          qt.setFromAxisAngle(UP, rng() * TAU);
          qt.multiply(new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang)),
            0.4 + rng() * 1.1
          ));
          p.set(px, h + len * 0.08, pz);
          s.set(1, len, 1);
          m.compose(p, qt, s);
          slots.debris.mesh.setMatrixAt(idx, m);
          return true;
        });
      });
    }

    /* --- 藻場（浅い平場）の水草 --- */
    for (const F of lake.flats) {
      let placed = 0;
      const target = 420 + Math.floor(rng() * 180);
      let tries = 0;
      while (placed < target && tries < target * 40 && slots.weeds.index < MAX.weeds) {
        tries++;
        const ang = rng() * TAU;
        const rad = Math.sqrt(rng()) * F.r * 0.92;
        const x = F.x + Math.cos(ang) * rad;
        const z = F.z + Math.sin(ang) * rad;
        if (!tryPlace('weeds', x, z, (h, d, slope, px, pz, idx) => {
          const wanted = clamp01(Math.abs(h) * 0.55 + 0.45) * (0.85 + rng() * 0.55);
          const sc = fitWeedScale(wanted, d);
          if (sc === null) return false;
          qt.setFromAxisAngle(UP, rng() * TAU);
          p.set(px, h, pz);
          s.set(1.15, sc, 1.15);
          m.compose(p, qt, s);
          slots.weeds.mesh.setMatrixAt(idx, m);
          return true;
        })) continue;
        placed++;
      }
    }

    /* --- 岩場の転石 --- */
    let bt = 0;
    while (slots.pebbles.index < MAX.pebbles && bt < MAX.pebbles * 32) {
      bt++;
      const ang = rng() * TAU;
      const sr = t.shoreRadius(Math.cos(ang), Math.sin(ang));
      const rr = sr * (0.05 + Math.pow(rng(), 0.55) * 0.95);
      const x = Math.cos(ang) * rr;
      const z = Math.sin(ang) * rr;
      if (!tryPlace('pebbles', x, z, (h, d, slope, px, pz, idx) => {
        const bed = lake.bedAt(px, pz, slope);
        if (bed.v < 0.58) return false;
        if (rng() > smoothstep(0.58, 0.9, bed.v)) return false;
        const cluster = t.noise.fbm(px * 0.075 + 17.4, pz * 0.075 - 8.9, 2) * 0.5 + 0.5;
        if (rng() > 0.5 + cluster * 0.65) return false;
        const sc = 0.22 + Math.pow(rng(), 2.1) * 0.95;
        if (sc * 0.45 > d - 0.25) return false;
        qt.setFromEuler(new THREE.Euler(rng() * TAU, rng() * TAU, rng() * TAU));
        p.set(px, h + sc * (0.04 - Math.min(0.45, slope) * 0.18), pz);
        s.set(sc * (0.8 + rng() * 0.4), sc * (0.35 + rng() * 0.28), sc * (0.8 + rng() * 0.4));
        m.compose(p, qt, s);
        slots.pebbles.mesh.setMatrixAt(idx, m);
        return true;
      })) continue;
    }

    /* --- 一般散布：底質・深度・斜面で種別 --- */
    let gt = 0;
    while (gt < 12000 && (slots.weeds.index < MAX.weeds || slots.pebbles.index < MAX.pebbles)) {
      gt++;
      const ang = rng() * TAU;
      const sr = t.shoreRadius(Math.cos(ang), Math.sin(ang));
      const rr = sr * (0.08 + Math.pow(rng(), 0.62) * 0.9);
      const x = Math.cos(ang) * rr;
      const z = Math.sin(ang) * rr;
      const h = t.heightAt(x, z);
      const d = -h;
      if (d < 0.5 || d > 16) continue;
      const slope = t.slopeAt(x, z);
      if (slope > 1.35) continue;
      const bed = lake.bedAt(x, z, slope);
      const nearFlat = lake.flats.some((F) => (F.x - x) ** 2 + (F.z - z) ** 2 < (F.r + 2) ** 2);

      if (bed.kind === 'rock' && slots.pebbles.index < MAX.pebbles && rng() < 0.72) {
        tryPlace('pebbles', x, z, (bh, bd, sl, px, pz, idx) => {
          const sc = 0.18 + Math.pow(rng(), 2.4) * 0.75;
          if (sc * 0.4 > bd - 0.2) return false;
          qt.setFromEuler(new THREE.Euler(rng() * TAU, rng() * TAU, rng() * TAU));
          p.set(px, bh + sc * 0.03, pz);
          s.set(sc, sc * 0.42, sc);
          m.compose(p, qt, s);
          slots.pebbles.mesh.setMatrixAt(idx, m);
          return true;
        });
      } else if ((bed.kind === 'mud' || nearFlat) && d < 5.5 && slots.weeds.index < MAX.weeds && rng() < 0.38) {
        tryPlace('weeds', x, z, (bh, bd, sl, px, pz, idx) => {
          const sc = fitWeedScale(0.55 + rng() * 0.95, bd);
          if (sc === null) return false;
          qt.setFromAxisAngle(UP, rng() * TAU);
          p.set(px, bh, pz);
          s.set(1, sc, 1);
          m.compose(p, qt, s);
          slots.weeds.mesh.setMatrixAt(idx, m);
          return true;
        });
      } else if (bed.kind === 'sand' && d < 3.2 && slots.weeds.index < MAX.weeds && rng() < 0.12) {
        tryPlace('weeds', x, z, (bh, bd, sl, px, pz, idx) => {
          const sc = fitWeedScale(0.35 + rng() * 0.55, bd);
          if (sc === null) return false;
          qt.setFromAxisAngle(UP, rng() * TAU);
          p.set(px, bh, pz);
          s.set(0.85, sc, 0.85);
          m.compose(p, qt, s);
          slots.weeds.mesh.setMatrixAt(idx, m);
          return true;
        });
      }
    }

    const shuffleSalt = { weeds: 0x51a7, pebbles: 0x9e37, debris: 0xd3b1 };
    for (const [name, slot] of Object.entries(slots)) {
      shuffleInstances(slot.mesh, slot.index, t.seed ^ shuffleSalt[name]);
      slot.mesh.count = slot.index;
      slot.mesh.userData.placedCount = slot.index;
      slot.mesh.instanceMatrix.needsUpdate = true;
      slot.mesh.computeBoundingSphere();
      this.group.add(slot.mesh);
      this.meshes.push(slot.mesh);
    }
    this.materials.push(weedMat, pebbleMat, debrisMat);
    this.counts = {
      weeds: slots.weeds.index,
      pebbles: slots.pebbles.index,
      debris: slots.debris.index,
    };
  }

  _makeMesh(geo, mat, max, name) {
    const mesh = new THREE.InstancedMesh(geo, mat, max);
    mesh.name = `uw-${name}`;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.frustumCulled = true;
    mesh.userData.maxCount = max;
    return { mesh, max, index: 0 };
  }

  setQuality(q) {
    this.quality = q;
    const f = DENSITY[q] ?? DENSITY.mid;
    this.activeCounts = {};
    for (const mesh of this.meshes) {
      const placed = mesh.userData.placedCount ?? mesh.userData.maxCount;
      mesh.count = Math.max(0, Math.floor(placed * f));
      this.activeCounts[mesh.name.replace(/^uw-/, '')] = mesh.count;
    }
  }

  /**
   * @param {number} time
   * @param {THREE.Camera} camera
   * @param {{ x: number, z: number }} flowDir
   * @param {number} flowStrength
   */
  update(time, camera, flowDir, flowStrength = 0.05) {
    for (const mat of this.materials) {
      const u = mat.userData?.uwUniforms;
      if (!u) continue;
      if (u.uUwTime) u.uUwTime.value = time;
      if (u.uUwCamPos) u.uUwCamPos.value.copy(camera.position);
      if (u.uFlowDir) u.uFlowDir.value.set(flowDir.x, flowDir.z);
      if (u.uFlowStrength) u.uFlowStrength.value = flowStrength;
    }
  }
}
