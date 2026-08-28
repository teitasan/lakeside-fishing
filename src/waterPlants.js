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
import { LodInstances, tintAt } from './lodInstances.js?v=20260828-waterplants7';
import { makeRng, TAU, clamp01, lerp } from './util.js';

/** 抽水植物（ヨシ・マコモ）の LOD しきい値。3 段目は描かない */
export const EMERGENT_LOD = [28, 78];
/** 沈水植物（クロモ）。水の吸収で 50m 先はもう見えない */
export const SUBMERGED_LOD = [22, 58];

/**
 * 葉群カードの横／縦比。makeBladeTexture の縦横比と必ず揃える
 * （ずれるとカード上で葉が伸び縮みして «針金» に見える）
 */
export const BLADE_ASPECT = { reed: 1 / 1.85, manomo: 1 / 0.72, tuft: 1 };

/** 種ごとの見た目のバリエーション数 */
export const PLANT_VARIANTS = 3;

/* ---------------- ジオメトリの部品 ---------------- */

const newOut = () => ({ pos: [], nor: [], uv: [], idx: [] });

function toGeometry(out) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(out.nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(out.uv, 2));
  g.setIndex(out.idx);
  return g;
}

/**
 * 中心線を作る。方位 az / 鉛直からの傾き tilt で立ち上がり、
 * 先端ほど強く垂れる（droop）。ヨシの葉もマコモの葉もこれ 1 本で表せる。
 */
function curvePts(origin, az, tilt, len, segs, droop) {
  const cx = Math.cos(az), cz = Math.sin(az);
  let dx = Math.sin(tilt) * cx, dy = Math.cos(tilt), dz = Math.sin(tilt) * cz;
  const pts = [{ x: origin.x, y: origin.y, z: origin.z }];
  const step = len / segs;
  let px = origin.x, py = origin.y, pz = origin.z;
  for (let i = 1; i <= segs; i++) {
    const t = (i - 1) / segs;
    // 垂れは «根元は硬く先端は柔らかい»。t を掛けるだけで弓なりになる
    dy -= droop * step * t;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    px += dx * step; py += dy * step; pz += dz * step;
    pts.push({ x: px, y: py, z: pz });
  }
  return pts;
}

function unit(x, y, z) {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** 中心線に沿って細い管（稈・茎）を張る */
function tube(out, pts, { r0, r1, radial = 4 }) {
  const base = out.pos.length / 3;
  const n = pts.length - 1;
  let prevNx = 1, prevNy = 0, prevNz = 0;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const r = lerp(r0, r1, t);
    const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, n)];
    let tx = b.x - a.x, ty = b.y - a.y, tz = b.z - a.z;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    // 平行移動フレーム（毎点で作り直すと管が捻れる）
    let d = prevNx * tx + prevNy * ty + prevNz * tz;
    let nx = prevNx - tx * d, ny = prevNy - ty * d, nz = prevNz - tz * d;
    if (Math.hypot(nx, ny, nz) < 1e-6) { nx = ty; ny = -tx; nz = 0; }
    [nx, ny, nz] = unit(nx, ny, nz);
    prevNx = nx; prevNy = ny; prevNz = nz;
    const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
    for (let j = 0; j <= radial; j++) {
      const ang = (j / radial) * TAU;
      const c = Math.cos(ang), s = Math.sin(ang);
      const ux = nx * c + bx * s, uy = ny * c + by * s, uz = nz * c + bz * s;
      out.pos.push(pts[i].x + ux * r, pts[i].y + uy * r, pts[i].z + uz * r);
      out.nor.push(ux, uy, uz);
      out.uv.push(j / radial, t);
    }
  }
  const ring = radial + 1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < radial; j++) {
      const a = base + i * ring + j, b = a + ring;
      out.idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
}

/**
 * 葉群を表すカードを方位を変えて n 枚立てる。原点は下端中央。
 * 1 枚だと真横から消えるので最低 2 枚、近景は 3 枚。
 */
function cardFan(out, { cx, cy, cz, w, h, n = 3, az0 = 0, lean = 0 }) {
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
function pushQuad(out, base) {
  out.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  out.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
}

/** 直交 2 枚のカード（穂・輪生葉）。原点は下端中央 */
function cards(out, { cx, cy, cz, w, h, cross = true, up = 1 }) {
  const planes = cross ? [[1, 0], [0, 1]] : [[1, 0]];
  for (const [ax, az] of planes) {
    const base = out.pos.length / 3;
    for (let k = 0; k < 4; k++) {
      const sx = (k === 0 || k === 3) ? -0.5 : 0.5;
      const sy = (k < 2) ? 0 : 1;
      out.pos.push(cx + ax * sx * w, cy + sy * h * up, cz + az * sx * w);
      out.nor.push(az * 0.4, 0.85, -ax * 0.4);
      out.uv.push(k === 0 || k === 3 ? 0 : 1, sy);
    }
    pushQuad(out, base);
  }
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
function paintBlade(g, {
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
function leafGreen(v, warm) {
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
export function makeBladeTexture(kind, W = 384) {
  const cfg = {
    reed: {
      layout: 'axis', h: 1.85, blades: 30,
      len: [0.30, 0.50], width: [0.016, 0.030],
      tilt: [1.15, 1.52], bend: [0.55, 1.05], from: [0.22, 0.97],
      v: [150, 208], warm: [0.02, 0.42],
    },
    manomo: {
      /* マコモの葉身は幅 2〜3cm × 長さ 1.5m ＝ 50:1 前後。
         幅を取りすぎると «肉厚» に見えてマコモではなくオリヅルランになる。
         細くしたぶん枚数で密度を稼ぐ */
      layout: 'fan', h: 0.72, blades: 34,
      len: [0.66, 1.10], width: [0.011, 0.021],
      tilt: [0.35, 1.30], bend: [0.35, 0.85], from: 0.13,
      v: [158, 218], warm: [0.08, 0.52],
    },
    tuft: {
      layout: 'fan', h: 1.0, blades: 24,
      len: [0.48, 0.92], width: [0.022, 0.044],
      tilt: [0.30, 1.15], bend: [0.30, 0.80], from: 0.11,
      v: [108, 168], warm: [-0.06, 0.26],
    },
  }[kind];
  const H = Math.round(W * cfg.h);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const rng = makeRng(kind === 'reed' ? 0x71c4a9 : kind === 'manomo' ? 0x2ab73f : 0x5e91d2);
  g.lineCap = 'round';

  /* 奥→手前の順に塗る。奥を暗くしておくと 1 枚のカードの中に
     «葉が重なった奥行き» が出る。これが無いと切り絵に見える */
  const layers = 3;
  for (let L = 0; L < layers; L++) {
    const depth = L / (layers - 1);
    const n = Math.round(cfg.blades / layers);
    for (let i = 0; i < n; i++) {
      const t = (i + rng()) / n;
      const side = (i % 2 ? 1 : -1) * (rng() < 0.12 ? -1 : 1);
      let x0, y0;
      if (cfg.layout === 'axis') {
        // 稈に沿って上下に散らす。中心軸は少し左右に振る
        x0 = W * (0.5 + (rng() - 0.5) * 0.10);
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

/* 穂も輪生葉も «縦に長いカード» に貼るので、テクスチャも同じ縦横比で描く。
   正方形のテクスチャを縦 3 倍のカードへ貼ると、穂も葉も 3 倍に伸びて
   «針金細工» に見える（最初これで失敗した） */
const PLUME_ASPECT = 3;
const WHORL_ASPECT = 3;

/** ヨシの穂（円錐花序）。細い枝が房になって垂れ、全体は密な筆になる */
export function makePlumeTexture(w = 128) {
  const h = w * PLUME_ASPECT;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const rng = makeRng(0x9a7c31);
  g.lineCap = 'round';
  const ax = w * 0.5;

  // 中軸
  g.strokeStyle = 'rgba(146,126,102,0.9)';
  g.lineWidth = w * 0.030;
  g.beginPath(); g.moveTo(ax, h); g.lineTo(ax, h * 0.03); g.stroke();

  /* 一次枝を上から下へ。上ほど短く、下ほど長く外へ張って垂れる。
     枝 1 本ごとに小穂（毛）を並べて密度を出す */
  const N = 88;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);                       // 0=穂先, 1=基部
    const y = h * (0.05 + t * 0.90);
    const side = i % 2 ? 1 : -1;
    const L = w * (0.10 + t * 0.44) * (0.72 + rng() * 0.56);
    const ex = ax + side * L, ey = y + L * (0.55 + rng() * 0.55);
    const v = 116 + Math.round(rng() * 62);
    // 紫褐色。緑を落として赤と青を残すと «枯れた穂» の色になる
    g.strokeStyle = `rgba(${v},${Math.round(v * 0.76)},${Math.round(v * 0.86)},${0.55 + rng() * 0.4})`;
    g.lineWidth = w * (0.012 + rng() * 0.012);
    g.beginPath();
    g.moveTo(ax, y);
    g.quadraticCurveTo(ax + side * L * 0.6, y - L * 0.10, ex, ey);
    g.stroke();
    // 小穂：枝に沿って細い毛を並べる。ここの本数が穂の «濃さ» を決める
    const hairs = 5 + Math.round(rng() * 4);
    for (let k = 0; k < hairs; k++) {
      const u = 0.22 + 0.74 * (k / hairs) + rng() * 0.08;
      const bx = ax + side * L * u, by = y + L * u * u * 0.55;
      const hl = w * 0.10 * (0.55 + rng() * 0.8);
      const vv = 150 + Math.round(rng() * 66);
      g.strokeStyle = `rgba(${vv},${Math.round(vv * 0.80)},${Math.round(vv * 0.88)},${0.35 + rng() * 0.4})`;
      g.lineWidth = w * 0.009;
      g.beginPath();
      g.moveTo(bx, by);
      g.lineTo(bx + (rng() - 0.5) * hl * 0.9, by + hl);
      g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** クロモの輪生葉。1 枚のカードに 3 節ぶん描いてカード数を減らす */
export function makeWhorlTexture(w = 128) {
  const h = w * WHORL_ASPECT;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const rng = makeRng(0x3d51b8);
  g.lineCap = 'round';
  const ax = w * 0.5;

  /* 茎は別ジオメトリで描くので、ここでは節をつなぐ細い線だけ。
     太い軸を描くとカードが «黒い棒» になって水中で目立つ */
  g.strokeStyle = 'rgba(66,92,58,0.75)';
  g.lineWidth = w * 0.030;
  g.beginPath(); g.moveTo(ax, h); g.lineTo(ax, 0); g.stroke();

  const nodes = 3;
  for (let n = 0; n < nodes; n++) {
    const y = h * (0.86 - n * 0.33);
    const leaves = 6;
    for (let i = 0; i < leaves; i++) {
      /* 輪生をカード 1 枚で表すので、放射方向を左右へ振り分ける。
         上下にも少し散らして «一列に並んだ» 感じを消す */
      const spread = -1 + 2 * (i / (leaves - 1));
      const ang = spread * 1.28 + (rng() - 0.5) * 0.24;
      const L = w * (0.44 + rng() * 0.20);
      const gr = 102 + Math.round(rng() * 46);
      g.strokeStyle = `rgb(${Math.round(gr * 0.50)},${gr + 14},${Math.round(gr * 0.60)})`;
      // 根元は太く先は細い。線幅を 2 段で引いて «披針形» に見せる
      const y0 = y + (rng() - 0.5) * h * 0.03;
      const ex = ax + Math.sin(ang) * L;
      const ey = y0 - Math.cos(ang) * L * 0.55;
      g.lineWidth = w * 0.048;
      g.beginPath();
      g.moveTo(ax, y0);
      g.quadraticCurveTo(ax + Math.sin(ang) * L * 0.45, y0 - Math.cos(ang) * L * 0.16,
        ax + Math.sin(ang) * L * 0.6, y0 - Math.cos(ang) * L * 0.32);
      g.stroke();
      g.lineWidth = w * 0.022;
      g.beginPath();
      g.moveTo(ax + Math.sin(ang) * L * 0.55, y0 - Math.cos(ang) * L * 0.30);
      g.quadraticCurveTo(ax + Math.sin(ang) * L * 0.9, y0 - Math.cos(ang) * L * 0.5, ex, ey);
      g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* ---------------- 種ごとの株 ---------------- */
/* どのジオメトリも «高さ 1» に正規化して作る。
   LodInstances の scale がそのまま実寸（m）になる。

   乱数で «設計図» を先に引き、ジオメトリはそこから LOD ごとに起こす。
   LOD ごとに乱数を回し直すと、境界をまたいだ瞬間に株の形そのものが
   別物に入れ替わって «別の草に化けた» ように見える。 */

/** ヨシの設計図 */
export function planReed(rng) {
  const culms = [];
  const n = 4 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    const az = rng() * TAU;
    const off = rng() * 0.10;
    const len = 0.66 + rng() * 0.34;
    const leaves = [];
    const nl = 3 + Math.floor(rng() * 3);
    for (let j = 0; j < nl; j++) {
      leaves.push({
        at: 0.28 + 0.64 * ((j + rng()) / nl),
        az: az + rng() * TAU,
        tilt: 0.98 + rng() * 0.38,
        len: len * (0.30 + rng() * 0.22),
        width: 0.019 * (0.8 + rng() * 0.4),
      });
    }
    // 穂は伸びきった稈だけ。全部に付けると «穂の壁» になる
    culms.push({
      az, off, len, leaves,
      tilt: 0.03 + rng() * 0.11,
      plume: len > 0.86 && rng() < 0.75,
    });
  }
  return { kind: 'reed', culms, bladeAz: rng() * TAU };
}

/** マコモの設計図 */
export function planManomo(rng) {
  const blades = [];
  const n = 7 + Math.floor(rng() * 5);
  const az0 = rng() * TAU;
  for (let i = 0; i < n; i++) {
    // 方位は黄金角。等分だと «扇» が規則的すぎて造花に見える
    blades.push({
      az: az0 + i * 2.399 + (rng() - 0.5) * 0.5,
      off: rng() * 0.06,
      tilt: 0.22 + rng() * 0.46,
      len: 0.72 + rng() * 0.30,
      width: 0.048 * (0.78 + rng() * 0.44),
    });
  }
  return { kind: 'manomo', blades, bladeAz: rng() * TAU };
}

/** クロモの設計図 */
export function planHydrilla(rng) {
  const stems = [];
  const n = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    stems.push({
      az: rng() * TAU,
      off: rng() * 0.07,
      // 沈水植物は水中で立とうとするが、流れで大きく倒れる（揺れは shader 側）
      tilt: 0.26 + rng() * 0.52,
      len: 0.70 + rng() * 0.30,
      /* 正で垂れ、負で反り返る。傾けて立ち上げると S 字になり、
         «まっすぐな棒» に見えなくなる。全部同じだと針山 */
      droop: -0.34 + rng() * 0.44,
    });
  }
  return { kind: 'hydrilla', stems };
}

export function planFor(kind, rng) {
  if (kind === 'reed') return planReed(rng);
  if (kind === 'manomo') return planManomo(rng);
  return planHydrilla(rng);
}

/** ヨシ：細い稈の束 + 垂れる細葉 + 穂 */
function emitReed(plan, lod) {
  const stem = newOut();
  const plume = newOut();
  const blade = newOut();
  const segs = lod ? 3 : 6;
  for (const c of plan.culms) {
    const origin = { x: Math.cos(c.az) * c.off, y: 0, z: Math.sin(c.az) * c.off };
    const pts = curvePts(origin, c.az, c.tilt, c.len, segs, 0.14);
    tube(stem, pts, { r0: 0.011, r1: 0.0045, radial: lod ? 3 : 4 });
    if (c.plume) {
      const top = pts[pts.length - 1];
      /* 穂は 0.040 幅 × その 3 倍の丈。株の高さ 1 に対する比なので、
         3m のヨシで 12cm × 36cm になる（0.085 だと 77cm の巨大な穂だった） */
      const pw = 0.040;
      cards(plume, { cx: top.x, cy: top.y, cz: top.z, w: pw, h: pw * PLUME_ASPECT, cross: !lod });
    }
  }
  /* 葉群は稈ごとではなく株ぜんたいで 1 セット。
     2〜3 枚のカードに «葉の束» を描いたテクスチャを貼る */
  const h = 0.88;
  cardFan(blade, {
    cx: 0, cy: 0.05, cz: 0, h,
    w: h * BLADE_ASPECT.reed, n: lod ? 2 : 3,
    az0: plan.bladeAz, lean: 0.10,
  });
  return [stem, plume, blade];
}

/** マコモ：株元から扇状に出る幅広の葉身。稈は見せない */
function emitManomo(plan, lod) {
  const blade = newOut();
  const h = 0.95;
  cardFan(blade, {
    cx: 0, cy: 0, cz: 0, h,
    w: h * BLADE_ASPECT.manomo, n: lod ? 2 : 3,
    az0: plan.bladeAz, lean: 0.16,
  });
  return [null, null, blade];
}

/** クロモ：細い茎に輪生葉。数本まとめて 1 株にする */
function emitHydrilla(plan, lod) {
  const stem = newOut();
  const leaf = newOut();
  const segs = lod ? 3 : 8;
  for (let i = 0; i < plan.stems.length; i++) {
    if (lod && i % 2) continue;
    const st = plan.stems[i];
    const origin = { x: Math.cos(st.az) * st.off, y: 0, z: Math.sin(st.az) * st.off };
    const pts = curvePts(origin, st.az, st.tilt, st.len, segs, st.droop);
    tube(stem, pts, { r0: 0.0032, r1: 0.0020, radial: 3 });
    const nodes = lod ? 4 : 9;
    for (let j = 0; j < nodes; j++) {
      const at = 0.10 + 0.86 * (j / nodes);
      const k = Math.min(Math.floor(at * segs), segs - 1);
      const p = pts[k];
      /* 輪生の直径は実物 2〜3cm。1px 未満になるので少し大げさにして 6cm 相当 */
      const lw = 0.050;
      cards(leaf, {
        cx: p.x, cy: p.y, cz: p.z,
        w: lw, h: lw * WHORL_ASPECT, cross: !lod,
      });
    }
  }
  return [stem, leaf, null];
}

/**
 * 設計図から LOD ごとのジオメトリを起こす。
 * @returns {{stem: THREE.BufferGeometry, extra: THREE.BufferGeometry|null}}
 */
export function emitPlant(plan, lod) {
  const [a, b, c] = plan.kind === 'reed' ? emitReed(plan, lod)
    : plan.kind === 'manomo' ? emitManomo(plan, lod)
      : emitHydrilla(plan, lod);
  const conv = (o) => (o && o.idx.length ? toGeometry(o) : null);
  return { stem: conv(a), extra: conv(b), blade: conv(c) };
}

/**
 * 沈水植物の小さな房。細いリボンを扇状に出しただけの安い株で、
 * 湖底プロップの «藻» に使う（円錐 1 個のままだとクロモの隣で浮く）。
 * 単一マテリアル・アルファ抜きなしなので InstancedMesh 1 本で済む。
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
 * マテリアルへのパッチを重ねて当てる。
 * addWindSway と addUnderwaterCaustics はどちらも onBeforeCompile を
 * 上書きするので、素直に両方呼ぶと後から当てたほうだけが効く。
 * 置換の目印（#include <common> など）は置換後も残るので、
 * コンパイル時に順番に呼べば両方が効く。
 */
function applyPatches(mat, patches) {
  const fns = [];
  const keys = [];
  for (const patch of patches) {
    if (!patch) continue;
    patch(mat);
    if (mat.onBeforeCompile) fns.push(mat.onBeforeCompile);
    keys.push(mat.customProgramCacheKey ? mat.customProgramCacheKey() : '');
  }
  mat.onBeforeCompile = (shader, renderer) => {
    for (const f of fns) f(shader, renderer);
  };
  const key = keys.join('|');
  mat.customProgramCacheKey = () => key;
  return mat;
}

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

    const cap = opts.capacity ?? (q === 'low' ? 420 : q === 'high' ? 1300 : 900);
    this.emergent = new LodInstances(scene, { lodDist: EMERGENT_LOD, hysteresis: 6 });
    this.submerged = new LodInstances(scene, { lodDist: SUBMERGED_LOD, hysteresis: 5 });

    this.plumeTex = makePlumeTexture();
    this.whorlTex = makeWhorlTexture();
    this.bladeTex = {
      reed: makeBladeTexture('reed').tex,
      manomo: makeBladeTexture('manomo').tex,
      tuft: makeBladeTexture('tuft').tex,
    };

    /* --- マテリアル ---
       抽水植物は «風で揺れる» と «水面下だけ caustics が乗る» の両方が要る。
       水面をまたいで生えているので、どちらか片方だと不自然になる */
    const wind = (o) => (m) => (opts.addWindSway ? opts.addWindSway(m, o) : m);
    const caust = (m) => (opts.addUnderwaterCaustics && opts.causticsUniforms
      ? opts.addUnderwaterCaustics(m, opts.causticsUniforms, 'plant-caustics')
      : m);

    const reedWind = { strength: 0.045, freq: 1.9, gustiness: 0.75, bendPow: 1.35 };
    const manomoWind = { strength: 0.055, freq: 1.6, gustiness: 0.8, bendPow: 1.15 };

    /* 葉群のカードは «描いた葉» なので色はテクスチャ任せ（color は白）。
       mipmap で二値アルファは痩せるので alphaTest は低めに取る */
    /* カードは巻きの違う三角形を 2 枚持たせてあるので FrontSide でよい。
       DoubleSide にすると裏面で法線が反転して真っ黒になる */
    const bladeBase = (tex) => ({
      map: tex, roughness: 0.88, metalness: 0,
      side: THREE.FrontSide, alphaTest: 0.26, transparent: false,
    });
    this.mats = {
      reedStem: applyPatches(new THREE.MeshStandardMaterial({
        color: 0x8a9455, roughness: 1, side: THREE.DoubleSide, flatShading: true,
      }), [wind(reedWind), caust]),
      reedPlume: applyPatches(new THREE.MeshStandardMaterial({
        map: this.plumeTex, roughness: 0.95, side: THREE.FrontSide,
        alphaTest: 0.34, transparent: false,
      }), [wind({ ...reedWind, strength: 0.06 })]),
      reedBlade: applyPatches(new THREE.MeshStandardMaterial(
        bladeBase(this.bladeTex.reed)), [wind(reedWind), caust]),
      manomo: applyPatches(new THREE.MeshStandardMaterial(
        bladeBase(this.bladeTex.manomo)), [wind(manomoWind), caust]),
    };
    if (opts.addWindSway) {
      this.swayMaterials.push(
        this.mats.reedStem, this.mats.reedPlume, this.mats.reedBlade, this.mats.manomo
      );
    }

    /* クロモは完全に沈水なので、水中プロップと同じ扱い。
       流れによる揺れ・caustics・距離での間引きが一式入る */
    const uw = opts.patchUwMaterial
      ? (m, sway) => opts.patchUwMaterial(m, { causticsUniforms: opts.causticsUniforms, sway })
      : (m) => m;
    /* 沈水植物は水を受けて大きく倒れる。陸の草と同じ振れ幅では «棒» に見える。
       茎と葉で同じ値を使う（違えると葉が茎から抜ける） */
    const uwSway = 5.4;
    this.mats.hydrillaStem = uw(new THREE.MeshStandardMaterial({
      color: 0x3c5636, roughness: 1, side: THREE.DoubleSide, flatShading: true,
    }), uwSway);
    this.mats.hydrillaLeaf = uw(new THREE.MeshStandardMaterial({
      map: this.whorlTex, roughness: 0.92, side: THREE.FrontSide,
      alphaTest: 0.30, transparent: false,
    }), uwSway);
    if (opts.patchUwMaterial) {
      this.uwMaterials.push(this.mats.hydrillaStem, this.mats.hydrillaLeaf);
    }

    /* --- 株の形をバリエーションぶん焼く ---
       設計図は 1 株につき 1 回だけ引き、そこから LOD 0/1 を起こす */
    const matFor = {
      reed: [this.mats.reedStem, this.mats.reedPlume, this.mats.reedBlade],
      manomo: [null, null, this.mats.manomo],
      hydrilla: [this.mats.hydrillaStem, this.mats.hydrillaLeaf, null],
    };
    const salt = { reed: 0x1f3d, manomo: 0x7a51, hydrilla: 0xc2e9 };
    for (const name of ['reed', 'manomo', 'hydrilla']) {
      const set = name === 'hydrilla' ? this.submerged : this.emergent;
      for (let va = 0; va < PLANT_VARIANTS; va++) {
        const plan = planFor(name, makeRng(seed ^ salt[name] ^ (va * 0x9e37)));
        for (let lod = 0; lod < 2; lod++) {
          const g = emitPlant(plan, lod);
          const parts = [];
          for (const [geo, mat] of [
            [g.stem, matFor[name][0]], [g.extra, matFor[name][1]], [g.blade, matFor[name][2]],
          ]) {
            if (geo && mat) parts.push({ geo, mat });
          }
          set.register(`${name}|${va}`, lod, parts, cap);
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
