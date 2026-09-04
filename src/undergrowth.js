/* ===========================================================
   下草（低木・シダ・草の塊）

   木を増やしても «森の中» には見えない。地面と幹の境目がそのまま見えて
   いて、林床が «緑に塗った板» のままだからで、実際に効くのは木の本数より
   目の高さから下の層になる。FF14 のグリダニアも
     大木 → 中型樹木 → 低木 → 草・花
   と層に分けて、下の層ほど «簡単なメッシュ＋透過テクスチャ» を大量に置く。

   ここも同じ作りにする。1 株はカードを数枚立てただけで、絵はキャンバスに
   描いた葉群。近景 3 枚 / 中景 2 枚、それより遠いと段そのものを持たない
   ので描かれない（LodInstances が «バケツが無い＝描かない» を面倒みる）。

   カードとテクスチャの作りは水草（waterPlants.js）と同じものを使い回す。
   =========================================================== */
import * as THREE from 'three';
import { LodInstances, tintAt } from './lodInstances.js?v=20260830-zone5';
import {
  newOut, toGeometry, cardFan, paintBlade, leafGreen, PLANT_FADE_BAND,
} from './waterPlants.js?v=20260830-zone5';
import { applyPatches, lodDitherFade } from './materialPatch.js?v=20260830-zone5';
import { makeRng, TAU, lerp, clamp01, spreadOrder } from './util.js?v=20260830-zone5';

/** 近景 / 中景。これより遠い株は段を持たないので描かれない */
export const UNDER_LOD = [22, 48];
export const UNDER_VARIANTS = 3;

/** 種ごとの実寸と見た目。clumping / patchScale は terrain の塊配置用 */
export const UNDER_KINDS = {
  /* 低木。林縁と木の根元に置いて «地面と幹の境目» を隠す */
  bush: {
    height: [0.55, 1.15], aspect: 1.15, cards: [5, 3], tex: 512,
    clumping: 0.55, patchScale: 6,
  },
  // シダ。林床の主役。傘のように葉を広げる
  fern: {
    height: [0.4, 0.75], aspect: 1.55, cards: [3, 2], tex: 384,
    clumping: 0.72, patchScale: 7,
  },
  // 草の塊。数で地面を埋める係
  herb: {
    height: [0.28, 0.55], aspect: 1.25, cards: [3, 2], tex: 320,
    clumping: 0.18, patchScale: 9,
  },
  /* 苔マット。林床の最低層。参考の forest-moss 相当 */
  moss: {
    height: [0.03, 0.08], aspect: 1.85, cards: [4, 2], tex: 256,
    clumping: 0.22, patchScale: 3.5,
  },
  /* ワラビ。腰高の弓形房。参考の bracken 相当 */
  bracken: {
    height: [0.62, 1.12], aspect: 1.38, cards: [4, 2], tex: 448,
    clumping: 0.78, patchScale: 11,
  },
  /* イバラ。暗い広葉と這う枝。参考の bramble 相当 */
  bramble: {
    height: [0.36, 0.78], aspect: 1.22, cards: [4, 2], tex: 416,
    clumping: 0.78, patchScale: 6,
  },
  /* クサヨモギ。細いアーチ状の房。参考の wood-rush 相当 */
  rush: {
    height: [0.16, 0.36], aspect: 1.08, cards: [3, 2], tex: 288,
    clumping: 0.40, patchScale: 5,
  },
};

/* ---------------- テクスチャ ---------------- */

/** 小さな丸葉を 1 枚。低木の葉はリボンではなく «丸» */
function paintRoundLeaf(g, x, y, r, ang, fill) {
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  g.fillStyle = fill;
  g.beginPath();
  g.ellipse(0, 0, r, r * 0.72, 0, 0, TAU);
  g.fill();
  // 中肋。丸のままだと «点» にしか見えない
  g.strokeStyle = 'rgba(255,255,235,0.14)';
  g.lineWidth = Math.max(0.6, r * 0.12);
  g.beginPath();
  g.moveTo(-r * 0.85, 0);
  g.lineTo(r * 0.85, 0);
  g.stroke();
  g.restore();
}

/**
 * シダの葉 1 本。中軸に沿って小葉を並べる（羽状複葉）。
 * pinnae（小葉）の数と幅で bracken / fern を分ける。
 */
function paintFrond(g, { x0, y0, len, ang, bend, W, v, warm, pinnae = 16, pinLen = 0.20, pinW = 0.42 }) {
  const dx = Math.sin(ang), dy = -Math.cos(ang);
  const pt = (t) => {
    // 二次曲線。先だけ垂れる
    const px = x0 + dx * len * t;
    const py = y0 + dy * len * t + bend * len * t * t * 0.55;
    return [px, py];
  };
  // 中軸
  g.strokeStyle = leafGreen(v * 0.72, warm);
  g.lineWidth = Math.max(1, W * 0.006);
  g.beginPath();
  g.moveTo(x0, y0);
  for (let t = 0.05; t <= 1.001; t += 0.05) g.lineTo(...pt(t));
  g.stroke();

  // 小葉。根元ほど長く、先へ向かって短くなる
  const n = pinnae;
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    const [px, py] = pt(t);
    const [px2, py2] = pt(Math.min(1, t + 0.05));
    const tx = Math.atan2(py2 - py, px2 - px);
    const rachis = Math.atan2(Math.cos(tx), -Math.sin(tx));
    const pl = len * pinLen * Math.sin(Math.PI * Math.pow(t, 0.55)) * (1 - t * 0.35);
    for (const side of [-1, 1]) {
      paintBlade(g, {
        x0: px,
        y0: py,
        len: pl,
        width: pl * pinW,
        ang: rachis + side * (0.95 - t * 0.35),
        bend: 0.25 * side,
        hueBase: leafGreen(v * 0.80, warm),
        hueTip: leafGreen(v, warm + 0.06),
        ribbon: false,
      });
    }
  }
}

/** 苔の小さな束。ほぼ水平に広がる */
function paintMossTuft(g, cx, cy, W, rng) {
  const n = 10 + Math.round(rng() * 6);
  for (let i = 0; i < n; i++) {
    const a = rng() * TAU;
    const r = W * (0.02 + rng() * 0.14);
    const px = cx + Math.cos(a) * r;
    const py = cy - W * (0.01 + rng() * 0.05);
    const len = W * (0.018 + rng() * 0.028);
    paintBlade(g, {
      x0: px, y0: py, len, width: len * 0.55,
      ang: (rng() - 0.5) * 2.4,
      bend: 0.15 + rng() * 0.25,
      hueBase: leafGreen(255 * (0.34 + rng() * 0.12), -0.08),
      hueTip: leafGreen(255 * (0.52 + rng() * 0.16), -0.04),
      ribbon: false,
    });
  }
}

/** イバラの広葉 1 枚 */
function paintBrambleLeaf(g, x, y, W, ang, fill) {
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  g.fillStyle = fill;
  g.beginPath();
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const yy = -W * 0.5 + W * t;
    const half = W * 0.34 * Math.pow(Math.sin(t * Math.PI), 0.65)
      * (1 + Math.sin(t * Math.PI * 5) * 0.08);
    if (i === 0) g.moveTo(-half, yy); else g.lineTo(-half, yy);
  }
  for (let i = 12; i >= 0; i--) {
    const t = i / 12;
    const yy = -W * 0.5 + W * t;
    const half = W * 0.34 * Math.pow(Math.sin(t * Math.PI), 0.65)
      * (1 + Math.sin(t * Math.PI * 5) * 0.08);
    g.lineTo(half, yy);
  }
  g.closePath();
  g.fill();
  g.strokeStyle = 'rgba(255,255,230,0.10)';
  g.lineWidth = Math.max(0.5, W * 0.018);
  g.beginPath(); g.moveTo(0, -W * 0.42); g.lineTo(0, W * 0.42); g.stroke();
  g.restore();
}

/**
 * 株 1 つぶんのカードテクスチャ。下端中央が株元。
 * @param {'bush'|'fern'|'herb'} kind
 */
export function makeUndergrowthTexture(kind, variant = 0) {
  const cfg = UNDER_KINDS[kind];
  const W = cfg.tex;
  const H = Math.round(W / cfg.aspect);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  const rng = makeRng(0x51f3 ^ (kind.length * 0x9e37) ^ (variant * 0x2c1b) ^ kind.charCodeAt(0) * 977);

  const cx = W * 0.5, base = H - 1;

  if (kind === 'bush') {
    /* 丸葉の塊。外へ行くほど暗くせず、下だけ落とす。
       «球» に見せたいのではなく «葉の塊» に見せたい */
    const R = W * 0.46;
    for (let i = 0; i < 260; i++) {
      const a = rng() * TAU;
      const rr = Math.pow(rng(), 0.55);
      const ex = cx + Math.cos(a) * rr * R;
      // 下端は株元に集める（逆さの雫）
      const ey = base - H * 0.06 - H * 0.9 * (0.15 + 0.85 * Math.pow(rng(), 0.7));
      // 逆さの雫。上は丸く、下は株元へすぼめる
      const uy = (base - ey) / H;
      if (Math.hypot((ex - cx) / (R * Math.min(1, 0.35 + uy * 1.3)),
        (ey - (base - H * 0.55)) / (H * 0.52)) > 1.05) continue;
      const depth = 1 - (base - ey) / H;      // 下ほど 1
      const v = 255 * lerp(0.74, 0.40, depth * 0.9) * (0.84 + rng() * 0.26);
      paintRoundLeaf(g, ex, ey, W * (0.028 + rng() * 0.026), rng() * TAU,
        leafGreen(Math.min(255, v), -0.05 + rng() * 0.13));
    }
    // 細い枝を数本。葉だけだと «苔の塊» に見える
    g.strokeStyle = 'rgba(74,58,42,0.55)';
    for (let i = 0; i < 7; i++) {
      const a = (i / 7 - 0.5) * 1.5;
      g.lineWidth = Math.max(1, W * 0.006);
      g.beginPath();
      g.moveTo(cx, base);
      g.quadraticCurveTo(cx + Math.sin(a) * W * 0.16, base - H * 0.45,
        cx + Math.sin(a) * W * 0.34, base - H * (0.55 + rng() * 0.3));
      g.stroke();
    }
  } else if (kind === 'fern') {
    const n = 7;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const a = (t - 0.5) * 2.1;
      const len = H * (0.78 + rng() * 0.22) * (1 - Math.abs(t - 0.5) * 0.45);
      paintFrond(g, {
        x0: cx + (rng() - 0.5) * W * 0.04,
        y0: base,
        len,
        ang: a,
        bend: 0.55 + rng() * 0.35,
        W,
        v: 255 * (0.62 + rng() * 0.3),
        warm: -0.04 + rng() * 0.14,
      });
    }
  } else if (kind === 'bracken') {
    const n = 5 + (variant % 2);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const a = (t - 0.5) * 2.35;
      const len = H * (0.82 + rng() * 0.18) * (1 - Math.abs(t - 0.5) * 0.35);
      paintFrond(g, {
        x0: cx + (rng() - 0.5) * W * 0.06,
        y0: base,
        len,
        ang: a,
        bend: 0.72 + rng() * 0.42,
        W,
        v: 255 * (0.58 + rng() * 0.28),
        warm: 0.02 + rng() * 0.12,
        pinnae: 18,
        pinLen: 0.24,
        pinW: 0.36,
      });
    }
  } else if (kind === 'moss') {
    const tufts = 14 + variant * 2;
    for (let i = 0; i < tufts; i++) {
      const a = rng() * TAU;
      const rr = Math.pow(rng(), 0.7) * W * 0.42;
      paintMossTuft(g, cx + Math.cos(a) * rr, base - H * (0.02 + rng() * 0.06), W, rng);
    }
  } else if (kind === 'bramble') {
    g.strokeStyle = 'rgba(42,32,24,0.62)';
    for (let i = 0; i < 5; i++) {
      const a = (i / 5 - 0.5) * 1.8 + (rng() - 0.5) * 0.3;
      g.lineWidth = Math.max(1, W * 0.007);
      g.beginPath();
      g.moveTo(cx, base);
      g.quadraticCurveTo(
        cx + Math.sin(a) * W * 0.22, base - H * 0.42,
        cx + Math.sin(a) * W * 0.38, base - H * (0.55 + rng() * 0.35),
      );
      g.stroke();
    }
    for (let i = 0; i < 38; i++) {
      const a = (rng() - 0.5) * 2.4;
      const dist = H * (0.12 + rng() * 0.78);
      const px = cx + Math.sin(a) * W * 0.34 * rng();
      const py = base - dist;
      const lw = W * (0.08 + rng() * 0.06);
      const v = 255 * (0.36 + rng() * 0.22);
      paintBrambleLeaf(g, px, py, lw, a + (rng() - 0.5) * 0.8,
        leafGreen(v, -0.06 + rng() * 0.08));
    }
  } else if (kind === 'rush') {
    for (let i = 0; i < 52; i++) {
      const a = (rng() - 0.5) * 2.6;
      const len = H * (0.45 + rng() * 0.55);
      paintBlade(g, {
        x0: cx + (rng() - 0.5) * W * 0.28,
        y0: base,
        len,
        width: W * (0.008 + rng() * 0.010),
        ang: a,
        bend: 0.65 + rng() * 0.75,
        hueBase: leafGreen(255 * (0.48 + rng() * 0.18), 0.04),
        hueTip: leafGreen(255 * (0.78 + rng() * 0.22), 0.12 + rng() * 0.08),
      });
    }
  } else {
    // 草の塊：細い葉を放射状に、少しだけ丸葉を混ぜる
    for (let i = 0; i < 46; i++) {
      const a = (rng() - 0.5) * 2.2;
      const len = H * (0.55 + rng() * 0.45);
      paintBlade(g, {
        x0: cx + (rng() - 0.5) * W * 0.22,
        y0: base,
        len,
        width: W * (0.012 + rng() * 0.016),
        ang: a,
        bend: 0.5 + rng() * 0.6,
        hueBase: leafGreen(255 * (0.42 + rng() * 0.2), 0.02),
        hueTip: leafGreen(255 * (0.72 + rng() * 0.28), 0.10 + rng() * 0.1),
      });
    }
    for (let i = 0; i < 10; i++) {
      paintRoundLeaf(g, cx + (rng() - 0.5) * W * 0.5, base - H * (0.05 + rng() * 0.35),
        W * (0.022 + rng() * 0.02), (rng() - 0.5) * 1.2,
        leafGreen(255 * (0.5 + rng() * 0.3), 0.05));
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/* ---------------- ジオメトリ ---------------- */

/**
 * 株 1 つ。高さ 1 に正規化してあるので scale がそのまま実寸になる。
 * 低木だけはカードを小さい輪に散らして «塊» の厚みを出す。
 */
export function emitUndergrowth(kind, lod, variant = 0) {
  const cfg = UNDER_KINDS[kind];
  const out = newOut();
  const nMax = cfg.cards[0];
  const n = cfg.cards[Math.min(lod, cfg.cards.length - 1)];
  const w = cfg.aspect;
  const rng = makeRng(0x77c1 ^ (variant * 0x9e37) ^ kind.charCodeAt(1) * 131);
  const order = spreadOrder(nMax);

  /** 決めた向きの «先頭 take 枚» を 1 枚ずつ立てる（n=1 の cardFan が 1 枚） */
  const fan = (take, opt) => {
    for (const k of order.slice(0, take)) {
      cardFan(out, { ...opt, n: 1, az0: opt.az0 + (k / nMax) * Math.PI });
    }
  };

  if (kind === 'bush') {
    // 2 束を少しずらして立てる。1 点から出すと «開いた本» に見える
    for (let s = 0; s < 2; s++) {
      const a = rng() * TAU, d = 0.14 * s, az0 = rng() * Math.PI;
      fan(Math.max(1, n - s), {
        cx: Math.cos(a) * d, cy: 0, cz: Math.sin(a) * d,
        w: w * (1 - s * 0.22), h: 1 - s * 0.18, lean: 0.10, az0,
      });
    }
  } else if (kind === 'moss') {
    fan(n, { cx: 0, cy: 0, cz: 0, w: w * 1.15, h: 1, lean: 0.22, az0: rng() * Math.PI });
  } else if (kind === 'bramble') {
    for (let s = 0; s < 2; s++) {
      const a = rng() * TAU, d = 0.12 * s;
      fan(Math.max(1, n - s), {
        cx: Math.cos(a) * d, cy: 0, cz: Math.sin(a) * d,
        w: w * (0.92 - s * 0.12), h: 0.88 - s * 0.10, lean: 0.14, az0: rng() * Math.PI,
      });
    }
  } else {
    fan(n, { cx: 0, cy: 0, cz: 0, w, h: 1, lean: 0.06, az0: rng() * Math.PI });
  }
  const geo = toGeometry(out);

  /* 頂点色（株元を暗く、先を明るく）。
     カード 1 枚が単色だと «板» に見えるし、株の中は光が回らないので
     根元は暗いのが正しい。
     なお vertexColors を立てたら color 属性は «必須»。無いと WebGL の
     既定値 (0,0,0) が掛かって株が真っ黒になる（実際に一度そうなった）。 */
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const v = 0.52 + 0.48 * Math.pow(clamp01(pos.getY(i)), 0.7);
    col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/* ---------------- 配置 ---------------- */

export class Undergrowth {
  constructor(scene, opts = {}) {
    const seed = opts.seed ?? 1;
    this.mats = {};
    this.set = new LodInstances(scene, {
      lodDist: [...UNDER_LOD],
      hysteresis: 5,
      interval: 0.2,
      fadeBand: PLANT_FADE_BAND,
    });
    const caps = opts.capacity || {};
    /* 風。低いものほど揺れは小さく速い */
    const WIND = {
      bush: { strength: 0.030, freq: 1.5, gustiness: 0.7, bendPow: 1.4 },
      fern: { strength: 0.045, freq: 2.1, gustiness: 0.8, bendPow: 1.2 },
      herb: { strength: 0.050, freq: 2.6, gustiness: 0.9, bendPow: 1.1 },
      moss: { strength: 0.008, freq: 1.2, gustiness: 0.35, bendPow: 1.8 },
      bracken: { strength: 0.042, freq: 1.8, gustiness: 0.75, bendPow: 1.25 },
      bramble: { strength: 0.028, freq: 1.4, gustiness: 0.65, bendPow: 1.5 },
      rush: { strength: 0.048, freq: 2.4, gustiness: 0.85, bendPow: 1.15 },
    };
    const wind = (o) => (m) => (opts.addWindSway ? opts.addWindSway(m, o) : m);

    for (const kind of Object.keys(UNDER_KINDS)) {
      for (let va = 0; va < UNDER_VARIANTS; va++) {
        const key = `${kind}|${va}`;
        this.mats[key] = applyPatches(new THREE.MeshStandardMaterial({
          map: makeUndergrowthTexture(kind, va),
          transparent: false,
          alphaTest: 0.32,
          /* カードは表裏 2 枚ぶん索引してあるので FrontSide でよい。
             DoubleSide にすると裏から見た面の法線が反転して黒くなる */
          side: THREE.FrontSide,
          roughness: 0.92,
          metalness: 0,
          // 株ごとの色ムラ（instanceColor）は vertexColors を立てないと届かない
          vertexColors: true,
          /* 段の切り替えはディザでクロスフェードする。入れないと帯の中で
             2 段ぶんが同時に不透明で描かれて、株が二重に見える */
        }), [wind(WIND[kind]), (m) => lodDitherFade(m, PLANT_FADE_BAND)]);
        for (let lod = 0; lod < UNDER_LOD.length; lod++) {
          const cap = (caps[kind] || [900, 2600])[lod] ?? 1200;
          this.set.register(key, lod,
            [{ geo: emitUndergrowth(kind, lod, va), mat: this.mats[key] }],
            Math.ceil(cap / UNDER_VARIANTS) + 24);
        }
      }
    }
    this.rng = makeRng(seed ^ 0x2f18);
  }

  /** 株を 1 つ足す。height は実寸（m） */
  add(kind, x, y, z, height, variant, ry) {
    const t = tintAt(x, z, 0.30, 0.16);
    this.set.add(x, y, z, { x: height, y: height, z: height },
      `${kind}|${variant}`, ry, t);
  }

  update(dt, cameraPos) { this.set.update(dt, cameraPos); }
  get meshes() { return this.set.meshes; }
  get swayMaterials() { return Object.values(this.mats); }
  dispose() { this.set.dispose(); }
}
