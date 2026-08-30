/* ===========================================================
   水辺〜水中の植物：ヨシ・マコモ・クロモ

   ・ヨシ（Phragmites australis）抽水。細い稈が束で立ち、細長い葉が垂れ、
     背の高い稈の先に穂（円錐花序）が付く。汀線から水深 1m ほどまで。
   ・マコモ（Zizania latifolia）抽水。稈は目立たず、幅の広い葉身が
     株元から扇状に出て弓なりに垂れる。水深 0.1〜1.3m。
   ・クロモ（Hydrilla verticillata）沈水。細い茎に小さな葉が輪生し、
     流れに大きく傾く。水深 0.7〜4.5m。

   葉身はアルファ抜きのカードではなくリボンのジオメトリで作る。
   実物が «幅を持ったひも» なので、そのまま形にしたほうが安く正確で、
   アルファテストの重ね描きも起きない。断面は「左端・中肋・右端」の
   3 点にして中肋を持ち上げる（V に折れるので平板に見えない）。
   穂とクロモの輪生葉だけは形が細かすぎるのでカード + テクスチャ。
   =========================================================== */
import * as THREE from 'three';
import { LodInstances, tintAt } from './lodInstances.js?v=20260830-zone4';
import { makeRng, TAU, clamp01, lerp, spreadOrder } from './util.js?v=20260830-zone4';
import { applyPatches, lodDitherFade } from './materialPatch.js?v=20260830-zone4';

/**
 * 抽水植物（ヨシ・マコモ）の LOD しきい値。
 * 全部カードなので 1 株 4〜12 三角しかない。近景を絞って株数を稼ぎ、
 * 遠景はカード 1 枚だけにして «岸の縁» を 130m まで残す。
 */
export const EMERGENT_LOD = [32, 88, 190];
/** 沈水植物（クロモ）。水の吸収で 55m 先はもう見えない */
export const SUBMERGED_LOD = [34, 78];

/** 段の境界でクロスフェードする帯の幅（m） */
export const PLANT_FADE_BAND = 8;

/** LOD ごとのカード枚数。1 枚だと真横から消えるので遠景でも 1 枚は残す */
const CARDS_PER_LOD = [3, 2, 1];

/**
 * 葉群カードの横／縦比。makeBladeTexture の縦横比と必ず揃える
 * （ずれるとカード上で葉が伸び縮みして «針金» に見える）
 */
export const BLADE_ASPECT = { reed: 1 / 2.6, manomo: 1 / 0.95, tuft: 1, hydrilla: 1 / 0.75 };

/** 種ごとの見た目のバリエーション数 */
export const PLANT_VARIANTS = 3;

/* ---------------- ジオメトリの部品 ---------------- */

export const newOut = () => ({ pos: [], nor: [], uv: [], idx: [] });

export function toGeometry(out) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(out.nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(out.uv, 2));
  g.setIndex(out.idx);
  return g;
}

function unit(x, y, z) {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/**
 * 葉群を表すカードを方位を変えて n 枚立てる。原点は下端中央。
 * 1 枚だと真横から消えるので最低 2 枚、近景は 3 枚。
 */
export function cardFan(out, { cx, cy, cz, w, h, n = 3, az0 = 0, lean = 0 }) {
  for (let i = 0; i < n; i++) {
    const a = az0 + (i / n) * Math.PI;      // 180° ぶんで足りる（両面描画）
    const ax = Math.cos(a), az = Math.sin(a);
    const base = out.pos.length / 3;
    for (let k = 0; k < 4; k++) {
      const sx = (k === 0 || k === 3) ? -0.5 : 0.5;
      const sy = (k < 2) ? 0 : 1;
      // lean で上端を少し倒す（株が «板» に見えるのを崩す）
      out.pos.push(
        cx + ax * sx * w + ax * sy * lean * w,
        cy + sy * h,
        cz + az * sx * w + az * sy * lean * w
      );
      /* 法線はカードの面ではなく «ほぼ真上＋わずかに外» にする。
         面法線だと 1 枚ごとに明暗が割れて板の集合に見える。
         葉は光を透かすので、上向き寄りのほうが見た目も近い */
      const ox = ax * sx * 0.70, oz = az * sx * 0.70;
      out.nor.push(...unit(ox, 1.0, oz));
      out.uv.push(k === 0 || k === 3 ? 0 : 1, sy);
    }
    pushQuad(out, base);
  }
}

/**
 * 1 枚のカードを «表と裏の 2 枚» として索引する。
 *
 * DoubleSide に頼ってはいけない。three の法線反転は面の向きではなく
 * gl_FrontFacing で決まるので、上向きの法線を持つカードを裏から見ると
 * 法線が真下を向き、上からの光が当たらず真っ黒になる。
 * 巻きの違う三角形を 2 枚入れておけば、どちらから見ても «表» が描かれ、
 * 法線は反転しないまま上を向く（頂点は共有なので索引が増えるだけ）。
 */
export function pushQuad(out, base) {
  out.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  out.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
}

/* ---------------- テクスチャ ---------------- */

/* ---------------- 葉群テクスチャ ----------------
   葉身をジオメトリのリボンで作るのをやめ、«葉の束を描いた» カードにする。
   リボンだと
     ・シルエットが多角形で硬い（縁がギザギザに立つ）
     ・1 枚が単色で、根元の暗さや葉先の透け（光が抜ける感じ）が出ない
     ・幅 1〜2cm の板なので遠くでピクセル未満になりチラつく
   の 3 つが同時に効いて «安っぽい» 見え方になる。
   絵で描けば 1 カード 2 三角で 15 枚ぶんの葉が入り、縁も色も柔らかくなる。 */

/** 1 枚の葉を塗る。根元から先端へ細くなり、根元は暗く先端は明るい */
export function paintBlade(g, {
  x0, y0, len, width, ang, bend, hueBase, hueTip, ribbon: rib = true,
}) {
  const dx = Math.sin(ang), dy = -Math.cos(ang);
  /* 中間点は素直に進み、先端だけ下へ落とす（bend）。
     等分に曲げると円弧になって «針» に見えるので、
     二次曲線の制御点を «伸びる» 側に置いて先だけ垂らす */
  const mx = x0 + dx * len * 0.55;
  const my = y0 + dy * len * 0.55 + bend * len * 0.10;
  const ex = x0 + dx * len * 0.92;
  const ey = y0 + dy * len * 0.92 + Math.abs(bend) * len * 0.62;
  // 法線方向（幅を取る向き）
  const nx = -dy, ny = dx;

  const grd = g.createLinearGradient(x0, y0, ex, ey);
  grd.addColorStop(0, hueBase);
  grd.addColorStop(0.55, hueTip);
  grd.addColorStop(1, hueTip);
  g.fillStyle = grd;

  g.beginPath();
  g.moveTo(x0 - nx * width * 0.5, y0 - ny * width * 0.5);
  g.quadraticCurveTo(mx - nx * width * 0.42, my - ny * width * 0.42, ex, ey);
  g.quadraticCurveTo(mx + nx * width * 0.42, my + ny * width * 0.42,
    x0 + nx * width * 0.5, y0 + ny * width * 0.5);
  g.closePath();
  g.fill();

  // 中肋のハイライト。これがあると «板» ではなく «葉» に見える
  if (rib) {
    g.strokeStyle = 'rgba(255,255,235,0.16)';
    g.lineWidth = Math.max(0.7, width * 0.10);
    g.beginPath();
    g.moveTo(x0, y0);
    g.quadraticCurveTo(mx, my, ex, ey);
    g.stroke();
  }
}

/** 緑を 1 枚ぶん決める。v で明るさ、warm で黄寄り／青寄り */
export function leafGreen(v, warm) {
  const r = Math.round(v * (0.44 + warm * 0.30));
  const gg = Math.round(v * (0.78 + warm * 0.10));
  const b = Math.round(v * (0.30 - warm * 0.10));
  return `rgb(${r},${gg},${b})`;
}

/**
 * 葉群のカード用テクスチャ。
 *
 * 配置は 2 通り。
 *   fan  株元 1 点から放射（マコモ・水中の房）
 *   axis 垂直な軸に沿って高さを変えて付き、強く垂れる（ヨシ）
 * ヨシを fan で描くと «剣が束になった» 形になってユッカに見えるので、
 * 稈に沿って付いて先が垂れる形をそのまま描く必要がある。
 *
 * @param {'reed'|'manomo'|'tuft'} kind
 */
/** 種ごとのテクスチャ幅。クロモは葉が 1〜2cm しかないので細かく描く */
const TEX_W = { reed: 384, manomo: 384, tuft: 384, hydrilla: 768 };

export function makeBladeTexture(kind, W = TEX_W[kind] ?? 384) {
  const cfg = {
    reed: {
      /* ヨシの葉は稈から 30〜50° で出て、外半分が弓なりに垂れる。
         66〜87°（ほぼ水平）で描いていたので «横に広がりすぎ» に見えた。
         葉長も 20〜40cm が実物で、株高の 26〜44%（3m の株で 0.8〜1.3m）は
         長すぎた。短く立てたぶん枚数を増やして密度を保つ。
         カードも縦長（h 1.85 → 2.6）にして横幅を 1.6m → 1.15m へ絞る */
      layout: 'axis', h: 2.6, blades: 64,
      len: [0.09, 0.17], width: [0.010, 0.020],
      tilt: [0.42, 0.88], bend: [0.35, 0.80], from: [0.09, 0.96],
      v: [150, 208], warm: [0.02, 0.42],
      // 稈と穂もここに描く。管ジオメトリをやめてカード 1 枚で株にする
      culms: [5, 8], plumes: [2, 4],
    },
    manomo: {
      /* マコモの葉身は実物で 幅 2〜3cm × 長さ 1〜2m。
         h 0.72 だと株の広がりが 1.5〜2.5m になり（実物は 1〜1.5m）、
         そのぶん葉幅も 2.8〜5.3cm まで太っていた。
         カードを縦長（0.95）にして幅を約半分に絞る。
         細くしたぶん枚数で密度を稼ぐ */
      layout: 'fan', h: 0.95, blades: 50,
      len: [0.66, 1.10], width: [0.008, 0.014],
      tilt: [0.35, 1.30], bend: [0.35, 0.85], from: 0.13,
      v: [158, 218], warm: [0.08, 0.52],
    },
    tuft: {
      layout: 'fan', h: 1.0, blades: 24,
      len: [0.48, 0.92], width: [0.022, 0.044],
      tilt: [0.30, 1.15], bend: [0.30, 0.80], from: 0.11,
      v: [108, 168], warm: [-0.06, 0.26],
    },
    hydrilla: {
      /* クロモは «マット» なので縦長より横広。細い茎に輪生葉が付いた
         小枝を数本、1 枚に描く。
         葉は実物で 5〜20mm、節間 1〜2cm しかない。カードを 2.2m 幅で
         取っていたときは葉長 10〜16cm・節間 12cm ＝ 実物の 5〜8 倍で、
         これが «クロモがデカい» の正体だった */
      layout: 'sprig', h: 0.75, sprigs: [7, 11],
      v: [110, 158], warm: [-0.16, 0.10],
    },
  }[kind];
  const H = Math.round(W * cfg.h);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const rng = makeRng({ reed: 0x71c4a9, manomo: 0x2ab73f, tuft: 0x5e91d2, hydrilla: 0x3d51b8 }[kind]);
  g.lineCap = 'round';

  // ヨシの稈は葉より奥。先に描く
  if (cfg.culms) {
    const n = Math.round(lerp(cfg.culms[0], cfg.culms[1], rng()));
    let plumed = false;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const x = W * (0.14 + t * 0.72 + (rng() - 0.5) * 0.06);
      const top = H * (0.04 + rng() * 0.20);
      const lean = (rng() - 0.5) * W * 0.07;
      const v = 132 + Math.round(rng() * 52);
      g.strokeStyle = `rgb(${Math.round(v * 0.72)},${Math.round(v * 0.80)},${Math.round(v * 0.42)})`;
      g.lineWidth = W * (0.009 + rng() * 0.006);
      g.beginPath();
      g.moveTo(x, H);
      g.quadraticCurveTo(x + lean * 0.4, H * 0.5, x + lean, top);
      g.stroke();
      // 穂は伸びきった稈だけ。全部に付けると «穂の壁» になる
      if (top < H * 0.10 && cfg.plumes && !plumed) {
        plumed = true;
        paintPlume(g, x + lean, top, W * 0.045, H * 0.085, rng);
      }
    }
  }

  /* 奥→手前の順に塗る。奥を暗くしておくと 1 枚のカードの中に
     «葉が重なった奥行き» が出る。これが無いと切り絵に見える */
  const layers = 3;
  for (let L = 0; L < layers; L++) {
    const depth = L / (layers - 1);
    if (cfg.layout === 'sprig') {
      const n = Math.round(lerp(cfg.sprigs[0], cfg.sprigs[1], rng()) / layers);
      for (let i = 0; i < n; i++) {
        const x0 = W * (0.10 + rng() * 0.80);
        const len = H * (0.55 + rng() * 0.42);
        const vv = lerp(cfg.v[0], cfg.v[1], rng()) * lerp(0.58, 1.0, depth);
        paintSprig(g, x0, H * 0.99, len, (rng() - 0.5) * 1.1, W, vv,
          lerp(cfg.warm[0], cfg.warm[1], rng()), rng);
      }
      continue;
    }
    const n = Math.round(cfg.blades / layers);
    for (let i = 0; i < n; i++) {
      const t = (i + rng()) / n;
      const side = (i % 2 ? 1 : -1) * (rng() < 0.12 ? -1 : 1);
      let x0, y0;
      if (cfg.layout === 'axis') {
        // 稈に沿って上下に散らす
        x0 = W * (0.14 + rng() * 0.72);
        y0 = H * (1 - lerp(cfg.from[0], cfg.from[1], t));
      } else {
        x0 = W * (0.5 + (t - 0.5) * cfg.from * 2 * (0.6 + rng() * 0.8));
        y0 = H * (0.995 - rng() * 0.04);
      }
      const tilt = lerp(cfg.tilt[0], cfg.tilt[1], rng());
      const len = H * lerp(cfg.len[0], cfg.len[1], rng());
      const width = W * lerp(cfg.width[0], cfg.width[1], rng());
      const vv = lerp(cfg.v[0], cfg.v[1], rng()) * lerp(0.60, 1.0, depth);
      const warm = lerp(cfg.warm[0], cfg.warm[1], rng());
      paintBlade(g, {
        x0, y0, len, width,
        ang: side * tilt,
        // bend は «外へ倒れたあと重力で下がる» ぶん。符号は倒れた向きと同じ
        bend: side * lerp(cfg.bend[0], cfg.bend[1], rng()),
        hueBase: leafGreen(vv * 0.56, warm * 0.5),
        hueTip: leafGreen(vv, warm),
        ribbon: depth > 0.4,
      });
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return { tex, aspect: W / H };
}

/** ヨシの穂（円錐花序）を稈の先に描く */
function paintPlume(g, x, y, w, h, rng) {
  for (let i = 0; i < 40; i++) {
    const t = i / 39;
    const yy = y + h * t;
    const side = i % 2 ? 1 : -1;
    const L = w * (0.35 + t * 0.95) * (0.7 + rng() * 0.6);
    // 紫を強く出すと造花に見える。赤褐色〜淡い黄褐色に寄せる
    const v = 120 + Math.round(rng() * 58);
    g.strokeStyle = `rgba(${v},${Math.round(v * 0.80)},${Math.round(v * 0.70)},${0.45 + rng() * 0.4})`;
    g.lineWidth = w * 0.13;
    g.beginPath();
    g.moveTo(x, yy);
    g.quadraticCurveTo(x + side * L * 0.6, yy + L * 0.1, x + side * L, yy + L * 0.7);
    g.stroke();
  }
}

/** クロモの小枝：細い茎に輪生葉。1 枚のカードに数本まとめて描く */
function paintSprig(g, x0, y0, len, tilt, W, v, warm, rng) {
  const dx = Math.sin(tilt), dy = -Math.cos(tilt);
  const ex = x0 + dx * len, ey = y0 + dy * len;
  g.strokeStyle = leafGreen(v * 0.62, warm * 0.4);
  g.lineWidth = W * 0.0035;
  g.beginPath();
  g.moveTo(x0, y0);
  g.quadraticCurveTo(x0 + dx * len * 0.5, y0 + dy * len * 0.5 + len * 0.06, ex, ey);
  g.stroke();
  // 節ごとに 5〜7 枚の披針形の葉を輪生させる。節間は実物で 1〜2cm
  const nodes = Math.max(6, Math.round(len / (W * 0.020)));
  for (let i = 1; i <= nodes; i++) {
    const t = i / (nodes + 0.5);
    const px = x0 + dx * len * t;
    const py = y0 + dy * len * t + len * 0.06 * t * t;
    const leaves = 5 + ((i * 3) % 3);
    for (let j = 0; j < leaves; j++) {
      const spread = -1 + 2 * (j / (leaves - 1));
      const ang = tilt + spread * 1.35 + (rng() - 0.5) * 0.2;
      // 葉は実物で 5〜20mm。カード幅に対する比で 1.0〜1.8%
      const L = W * (0.010 + rng() * 0.008);
      g.strokeStyle = leafGreen(v * (0.85 + rng() * 0.3), warm);
      g.lineWidth = W * 0.0045;
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(px + Math.sin(ang) * L, py - Math.cos(ang) * L * 0.55);
      g.stroke();
    }
  }
}

/* ---------------- 種ごとの株 ---------------- */
/* どの株も «高さ 1» に正規化したカードのファン 1 セットだけで作る。
   LodInstances の scale がそのまま実寸（m）になる。

   稈も穂も輪生葉もテクスチャに描き込んで、管ジオメトリは持たない。
   実測した現実の密度（ヨシ 50〜200 稈/m2, マコモ 夏 100〜200 芽/m2）を
   出すには 1 株あたり 10 三角ていどまで落とす必要があり、
   管を持ったままでは «わしゃわしゃ» にならない。 */

/** ヨシ：稈・葉・穂すべて 1 枚のテクスチャに入っている */
export function planReed(rng) {
  return { kind: 'reed', az: rng() * TAU, lean: 0.08 + rng() * 0.06 };
}
/** マコモ：幅の広い葉身の扇 */
export function planManomo(rng) {
  return { kind: 'manomo', az: rng() * TAU, lean: 0.14 + rng() * 0.10 };
}
/** クロモ：細い茎に輪生葉の小枝が数本ぶん入ったマット */
export function planHydrilla(rng) {
  return { kind: 'hydrilla', az: rng() * TAU, lean: 0.18 + rng() * 0.14 };
}

export function planFor(kind, rng) {
  if (kind === 'reed') return planReed(rng);
  if (kind === 'manomo') return planManomo(rng);
  return planHydrilla(rng);
}

/**
 * 設計図から LOD ごとのジオメトリを起こす。
 * 段が変わるのはカードの枚数だけで、大きさも向きも設計図のまま。
 * 乱数を引き直すと境界で株の形が別物に化けて «別の草に入れ替わった» と分かる。
 */
export function emitPlant(plan, lod) {
  const out = newOut();
  const h = plan.kind === 'reed' ? 1.0 : 0.96;
  const nMax = CARDS_PER_LOD[0];
  const n = CARDS_PER_LOD[Math.min(lod, CARDS_PER_LOD.length - 1)];
  /* 段ごとに az0 + (i/n)·π と割り直すと、3 枚 → 2 枚で «全部の» カードが
     別の向きになって、近づいた瞬間に株の形が変わって見える。
     向きは最大枚数ぶんを先に決め、段はその «先頭何枚» を取る
     （少ないほうの向きが多いほうの部分集合になる）。
     3 枚のときの並びは 0,1,2 のままなので、近景の見た目は変わらない */
  for (const k of spreadOrder(nMax).slice(0, n)) {
    cardFan(out, {
      cx: 0, cy: 0, cz: 0, h,
      w: h * BLADE_ASPECT[plan.kind],
      n: 1, az0: plan.az + (k / nMax) * Math.PI, lean: plan.lean,
    });
  }
  return { card: toGeometry(out) };
}

/**
 * 沈水植物の小さな房。湖底プロップの «藻» に使う
 * （円錐 1 個のままだとクロモの隣で浮く）。
 */
export function buildSubmergedTuft(seed = 1) {
  const rng = makeRng(seed >>> 0);
  const out = newOut();
  const h = 0.95;
  cardFan(out, {
    cx: 0, cy: 0, cz: 0, h,
    w: h * BLADE_ASPECT.tuft, n: 3, az0: rng() * TAU, lean: 0.22,
  });
  return toGeometry(out);
}

/* ---------------- 群落の管理 ---------------- */

/**
 * ヨシ・マコモ・クロモの群落。
 * @param {THREE.Scene} scene
 * @param {{quality?: string, seed?: number,
 *          addWindSway?: Function, addUnderwaterCaustics?: Function,
 *          patchUwMaterial?: Function, causticsUniforms?: object}} opts
 */
export class WaterPlants {
  constructor(scene, opts = {}) {
    const q = opts.quality || 'mid';
    const seed = (opts.seed ?? 1) >>> 0;
    this.quality = q;
    this.swayMaterials = [];
    this.uwMaterials = [];

    /* 株が数万あるので振り直しの間隔は長めに取る。
       1 回の rebuild で全株の行列を作り直すため */
    this.emergent = new LodInstances(scene,
      { lodDist: EMERGENT_LOD, hysteresis: 5, interval: 0.22, fadeBand: PLANT_FADE_BAND });
    this.submerged = new LodInstances(scene,
      { lodDist: SUBMERGED_LOD, hysteresis: 4, interval: 0.22, fadeBand: PLANT_FADE_BAND });

    this.bladeTex = {
      reed: makeBladeTexture('reed').tex,
      manomo: makeBladeTexture('manomo').tex,
      tuft: makeBladeTexture('tuft').tex,
      hydrilla: makeBladeTexture('hydrilla').tex,
    };

    /* --- マテリアル ---
       抽水植物は «風で揺れる» と «水面下だけ caustics が乗る» の両方が要る。
       水面をまたいで生えているので、どちらか片方だと不自然になる */
    const wind = (o) => (m) => (opts.addWindSway ? opts.addWindSway(m, o) : m);
    const caust = (m) => (opts.addUnderwaterCaustics && opts.causticsUniforms
      ? opts.addUnderwaterCaustics(m, opts.causticsUniforms, 'plant-caustics')
      : m);

    /* カードは巻きの違う三角形を 2 枚持たせてあるので FrontSide でよい。
       DoubleSide にすると裏面で法線が反転して真っ黒になる。
       色はテクスチャ任せ（color は白）。mipmap で二値アルファは痩せるので
       alphaTest は低めに取る */
    const bladeBase = (tex) => ({
      map: tex, roughness: 0.88, metalness: 0,
      side: THREE.FrontSide, alphaTest: 0.26, transparent: false,
    });
    const reedWind = { strength: 0.045, freq: 1.9, gustiness: 0.75, bendPow: 1.35 };
    const manomoWind = { strength: 0.055, freq: 1.6, gustiness: 0.8, bendPow: 1.15 };

    const fade = (m) => lodDitherFade(m, PLANT_FADE_BAND);
    this.mats = {
      reed: applyPatches(new THREE.MeshStandardMaterial(
        bladeBase(this.bladeTex.reed)), [wind(reedWind), caust, fade]),
      manomo: applyPatches(new THREE.MeshStandardMaterial(
        bladeBase(this.bladeTex.manomo)), [wind(manomoWind), caust, fade]),
    };
    if (opts.addWindSway) this.swayMaterials.push(this.mats.reed, this.mats.manomo);

    /* クロモは完全に沈水なので水中プロップと同じ扱い。
       流れによる揺れ・caustics・距離での間引きが一式入る。
       沈水植物は水を受けて大きく倒れるので、陸の草より振れ幅を大きく取る */
    const uw = opts.patchUwMaterial
      ? (m, sway) => opts.patchUwMaterial(m, { causticsUniforms: opts.causticsUniforms, sway })
      : (m) => m;
    this.mats.hydrilla = applyPatches(new THREE.MeshStandardMaterial(
      bladeBase(this.bladeTex.hydrilla)), [(m) => uw(m, 5.4), fade]);
    if (opts.patchUwMaterial) this.uwMaterials.push(this.mats.hydrilla);

    /* --- 株の形をバリエーションぶん焼く ---
       設計図は 1 株につき 1 回だけ引き、そこから各段を起こす */
    const salt = { reed: 0x1f3d, manomo: 0x7a51, hydrilla: 0xc2e9 };
    const caps = opts.capacity || {};
    for (const name of ['reed', 'manomo', 'hydrilla']) {
      const set = name === 'hydrilla' ? this.submerged : this.emergent;
      const tiers = set.lodDist.length;
      for (let va = 0; va < PLANT_VARIANTS; va++) {
        const plan = planFor(name, makeRng(seed ^ salt[name] ^ (va * 0x9e37)));
        for (let lod = 0; lod < tiers; lod++) {
          const g = emitPlant(plan, lod);
          /* 容量は段ごとに変える。近景は «岸から半径 16m の帯» にしか
             入らないので、遠景と同じ枠を確保するのは丸ごと無駄になる */
          const cap = (caps[name] || [400, 1600, 4000])[lod] ?? 1600;
          set.register(`${name}|${va}`, lod, [{ geo: g.card, mat: this.mats[name] }],
            Math.ceil(cap / PLANT_VARIANTS) + 24);
        }
      }
    }
  }

  /**
   * 株を足す。height は実寸（m）。
   * @param {string} kind reed | manomo | hydrilla
   */
  add(kind, x, y, z, height, variant, ry) {
    const set = kind === 'hydrilla' ? this.submerged : this.emergent;
    set.add(x, y, z, height, `${kind}|${variant}`, ry, tintAt(x, z, 0.26, 0.13));
  }

  /** LOD の振り直し。1 フレームに 1 回 */
  update(dt, cameraPos) {
    this.emergent.update(dt, cameraPos);
    this.submerged.update(dt, cameraPos);
  }

  counts() {
    return { emergent: this.emergent.counts(), submerged: this.submerged.counts() };
  }

  get meshes() {
    return [...this.emergent.meshes, ...this.submerged.meshes];
  }

  /** 完全に水中の物。水面の鏡像には絶対に写らないので反射パスから外せる */
  get submergedMeshes() {
    return this.submerged.meshes;
  }

  dispose() {
    this.emergent.dispose();
    this.submerged.dispose();
  }
}
