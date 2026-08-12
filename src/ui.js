/* ===========================================================
   HUD / モーダル / 図鑑・ショップ
   =========================================================== */
import {
  SPECIES, RARITY, GEAR, ACHIEVEMENTS, RIG_LAYERS,
  valueOf, fightPattern, gearStats, swimLayer, depthFit,
  colorsOf, ALBINO_EYE, TERRAIN_KINDS, SPECIES_BY_ID,
  catchDisplayName, catchDisplayPrefix,
} from './data.js';
import { PROFILES, BODY, profileAt, CRUST_SHAPES, lookOf } from './fish.js';
import { textureTypeFor, fishTextureImage } from './fishTextures.js';
import { terrainIconImage } from './terrainIcons.js';
import { fmtInt, fmt1, fmtWeight, fmtClock, timeBand, timeBandLabel, clamp01, lerp as lerpN, smoothstep } from './util.js';
import { xpForLevel } from './save.js';
import { iconHtml, iconLabel, loadIcon, preloadIcons, JUNK_ICONS } from './icons.js';
import {
  t, setLang, applyDom, joinList, speciesName, speciesFlavor, gearName, gearDesc,
  terrainName, terrainRule, terrainDesc, terrainFish, achievementName, achievementDesc,
  fightName, rigName, rigShort, rigDesc, rarityLabel, bedLabel, weatherName,
  terrainGroupLabel, gearKindLabel, structLabel, timeShort, weatherShort, layerShort,
  fishCount,
} from './i18n.js';

const $ = (id) => document.getElementById(id);

/* 図鑑詳細の段階解禁（釣った数）。デバッグ全表示時は即解禁
   サイズ・売値を先に開き、釣り判断に直結する生息水深を最後にする */
const DETAIL_UNLOCK = {
  minLen: 1,  // 最小サイズ
  maxLen: 2,  // 最大サイズ
  value: 3,   // 売値の目安
  depth: 5,   // 生息水深
};

/** 好みのキーだけ短いラベルでつなぐ（差が小さければ always） */
function preferShort(map, label, always = t('ui.journal.always')) {
  const keys = Object.keys(map);
  const vals = keys.map((k) => map[k] ?? 1);
  const hi = Math.max(...vals), lo = Math.min(...vals);
  if (hi - lo < 0.15) return always;
  return joinList(keys.filter((k) => (map[k] ?? 1) >= hi - 0.05).map(label));
}

/** 遊泳層を短いラベルで表示（居る層だけ） */
function swimLayerMarks(sp) {
  const L = swimLayer(sp);
  const layers = ['top', 'mid', 'bottom'];
  let on = layers.filter((id) => L[id] >= 0.8);
  if (!on.length) {
    on = [layers.reduce((a, id) => (L[id] > L[a] ? id : a))];
  }
  return joinList(on.map(layerShort));
}

/**
 * 図鑑アイコンの相対サイズ。
 * キャンバスいっぱいに揃えるとメダカも大型も同じに見えるので、
 * 代表体長（または opts.len）で 0.34〜1.0 に落とす。
 */
function iconSizeScale(sp, opts = {}) {
  const cm = opts.len != null
    ? opts.len
    : (sp.len ? (sp.len[0] + sp.len[1]) * 0.5 : 30);
  const lo = 4;
  const hi = 150;
  const t = clamp01((cm - lo) / (hi - lo));
  // 中型が潰れすぎないよう少し緩やかに
  return lerpN(0.34, 1, Math.pow(t, 0.72));
}

preloadIcons([
  ...Object.values(JUNK_ICONS),
  'ui-medal', 'ui-empty', 'ui-coin', 'ui-sparkle', 'ui-trophy',
  'weather-clear', 'weather-cloudy', 'weather-rain',
]);

/* ---------------- 魚のシルエット描画 ---------------- */
export function drawFishIcon(canvas, sp, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!sp) return;

  if (opts.unknown) {
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.font = `${Math.floor(H * 0.5)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', W / 2, H / 2);
    return;
  }

  if (sp.rarity === 0) {
    const img = loadIcon(JUNK_ICONS[sp.id] || 'junk-driftwood');
    const draw = () => {
      const s = Math.min(W, H) * 0.72;
      ctx.drawImage(img, (W - s) / 2, (H - s) / 2, s, s);
    };
    if (img.complete && img.naturalWidth) draw();
    else img.addEventListener('load', () => { ctx.clearRect(0, 0, W, H); draw(); }, { once: true });
    return;
  }

  /* 図鑑慣習に合わせ頭を左へ（カニは正面なので反転しない） */
  const faceLeft = sp.shape !== 'crab';
  if (faceLeft) {
    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
  }

  if (CRUST_SHAPES.includes(sp.shape)) {
    drawCrustIcon(ctx, sp, W, H, opts);
    if (faceLeft) ctx.restore();
    return;
  }

  const cols = colorsOf(sp, opts.albino);
  const look = lookOf(sp);
  const prof = PROFILES[sp.shape] || PROFILES.slim;
  const B = BODY[sp.shape] || BODY.slim;
  const fork = look.fork != null ? look.fork : B.fork;
  const sizeScale = iconSizeScale(sp, opts);

  /* 体型比を保ってキャンバスに収め、さらに種の体長で相対サイズを付ける。
     背びれ高を unitH にフル加算すると deep/コイ系の胴が極端に短くなるので、
     ヒレは一部だけ見積もる（はみ出しは許容） */
  const bodyAspect = B.h * look.h;                         // 体長に対する体高
  const snoutU = look.snout * 0.16;
  const tailU = B.tail * look.tailLen * (0.7 + fork * 0.35);
  const finU = B.dorsal * look.dorsalH * 0.85;
  const unitW = 1 + snoutU + tailU;
  const unitH = bodyAspect + finU * 0.4;
  const fit = Math.min((W * 0.92) / unitW, (H * 0.88) / Math.max(0.14, unitH)) * sizeScale;
  const bodyLen = fit;                                     // 胴の長さ
  const bodyH = fit * bodyAspect;
  const snoutPad = fit * snoutU;
  const tailReach = fit * tailU;
  const totalW = bodyLen + snoutPad + tailReach;
  const left = (W - totalW) * 0.5;
  const cy = H * 0.52;
  const tailX = left + tailReach * 0.62;
  const nose = tailX + bodyLen + snoutPad;
  const span = bodyLen + snoutPad;                         // 口まわりの相対寸法用
  const cx = left;                                         // 尾びれ先端側
  const xAt = (t) => tailX + (nose - tailX) * t;
  const dorsalAt = (t) => cy - profileAt(prof, t) * bodyH * 0.5 * (1 - look.headFlat * 0.15 * t);

  // 体（上下対称の輪郭。snout で口先を細く長く）
  const bodyPath = () => {
    ctx.beginPath();
    const N = 36;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      let r = profileAt(prof, t);
      if (look.snout > 0 && t > 0.78) r *= 1 - smoothstep(0.78, 1, t) * look.snout * 0.45;
      const x = xAt(t);
      const y = cy - r * bodyH * 0.5;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    for (let i = N; i >= 0; i--) {
      const t = i / N;
      let r = profileAt(prof, t);
      if (look.snout > 0 && t > 0.78) r *= 1 - smoothstep(0.78, 1, t) * look.snout * 0.45;
      const x = xAt(t);
      const y = cy + r * bodyH * 0.5 * 0.92 * (1 - look.headFlat * 0.2 * Math.max(0, t - 0.5));
      ctx.lineTo(x, y);
    }
    ctx.closePath();
  };
  // AI 生成テクスチャを体に貼る（3D と同じ向き・主役。未ロード時は種色グラデ）
  const texType = textureTypeFor(sp, look, !!opts.albino);
  const texImg = texType ? fishTextureImage(texType) : null;
  const hasTex = !!(texImg && texImg.complete && texImg.naturalWidth);
  bodyPath();
  if (hasTex) {
    // 3D の頂点色ティント（白寄り）に合わせて下地を薄くし、テクスチャをそのまま載せる
    ctx.fillStyle = '#f2f0ea';
    ctx.fill();
    ctx.save();
    bodyPath();
    ctx.clip();
    const bodyTop = cy - bodyH * 0.55;
    const bodyBot = cy + bodyH * 0.55;
    ctx.drawImage(texImg, tailX, bodyTop, Math.max(1, nose - tailX), Math.max(1, bodyBot - bodyTop));
    ctx.restore();
  } else {
    const grad = ctx.createLinearGradient(0, cy - bodyH * 0.5, 0, cy + bodyH * 0.5);
    grad.addColorStop(0, cols.top);
    grad.addColorStop(0.42, cols.mid);
    grad.addColorStop(1, cols.belly);
    ctx.fillStyle = grad;
    ctx.fill();
  }

  if (sp.rarity >= 4 && !opts.albino) {
    bodyPath();
    ctx.strokeStyle = sp.rarity === 5 ? 'rgba(255,224,150,.95)' : 'rgba(214,170,255,.8)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  // エラ蓋斑（ブルーギル）— テクスチャでは表現しづらいので残す
  if (!opts.albino && look.cheek) {
    ctx.fillStyle = '#1a1824';
    ctx.beginPath();
    ctx.arc(xAt(0.84), cy - bodyH * 0.02, bodyH * 0.08, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = cols.fin;

  // 尾びれ（種類別）
  const th = bodyH * (0.55 + fork * 0.55) * look.tailLen;
  ctx.beginPath();
  if (look.tail === 'round' || look.tail === 'ribbon') {
    ctx.moveTo(tailX + 1, cy - bodyH * 0.08);
    ctx.quadraticCurveTo(cx - span * 0.02, cy - th * 0.55, cx, cy);
    ctx.quadraticCurveTo(cx - span * 0.02, cy + th * 0.55, tailX + 1, cy + bodyH * 0.08);
  } else if (look.tail === 'truncate') {
    ctx.moveTo(tailX + 1, cy - bodyH * 0.1);
    ctx.lineTo(cx + span * 0.02, cy - th * 0.45);
    ctx.lineTo(cx + span * 0.02, cy + th * 0.45);
    ctx.lineTo(tailX + 1, cy + bodyH * 0.1);
  } else if (look.tail === 'hetero') {
    // 3D と同様、上葉長め・下葉短め（帆のように大きくしない）
    ctx.moveTo(tailX + 1, cy - bodyH * 0.05);
    ctx.lineTo(cx + span * 0.02, cy - th * 0.42);
    ctx.lineTo(cx, cy - th * 0.22);
    ctx.lineTo(cx + span * 0.03, cy + th * 0.22);
    ctx.lineTo(tailX + 1, cy + bodyH * 0.06);
  } else {
    const notch = look.tail === 'softfork' ? 0.1 : 0.085;
    ctx.moveTo(tailX + 1, cy - bodyH * 0.06);
    ctx.lineTo(cx, cy - th * 0.5);
    ctx.lineTo(cx + span * notch, cy);
    ctx.lineTo(cx, cy + th * 0.5);
    ctx.lineTo(tailX + 1, cy + bodyH * 0.06);
  }
  ctx.closePath();
  ctx.fill();

  // 背びれ
  if (look.ribbon) {
    ctx.beginPath();
    ctx.moveTo(xAt(0.75), dorsalAt(0.75));
    ctx.lineTo(xAt(0.55), cy - bodyH * 0.62);
    ctx.lineTo(xAt(0.2), cy - bodyH * 0.55);
    ctx.lineTo(xAt(0.12), dorsalAt(0.12));
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(xAt(0.65), cy + bodyH * 0.35);
    ctx.lineTo(xAt(0.4), cy + bodyH * 0.55);
    ctx.lineTo(xAt(0.15), cy + bodyH * 0.45);
    ctx.lineTo(xAt(0.12), cy + bodyH * 0.28);
    ctx.closePath();
    ctx.fill();
  } else {
    const t0 = clamp01(0.42 + look.dorsalX * 0.5);
    const t1 = clamp01(t0 + 0.22 * look.dorsalLen);
    const tip = t0 + (t1 - t0) * (1 - look.dorsalTip * 0.5);
    ctx.beginPath();
    ctx.moveTo(xAt(t0), dorsalAt(t0) + 1);
    ctx.lineTo(xAt(tip), cy - bodyH * (0.5 + B.dorsal * 1.35 * look.dorsalH));
    ctx.lineTo(xAt(t1), dorsalAt(t1) + 1);
    ctx.closePath();
    ctx.fill();

    // 尻びれ
    ctx.beginPath();
    ctx.moveTo(xAt(0.22), cy + bodyH * 0.30);
    ctx.lineTo(xAt(0.30), cy + bodyH * (0.42 + B.dorsal * 0.7 * look.analH));
    ctx.lineTo(xAt(0.40), cy + bodyH * 0.33);
    ctx.closePath();
    ctx.fill();

    // 脂びれ
    if (look.adipose) {
      ctx.beginPath();
      ctx.moveTo(xAt(0.28), dorsalAt(0.28));
      ctx.lineTo(xAt(0.24), cy - bodyH * 0.58);
      ctx.lineTo(xAt(0.20), dorsalAt(0.20));
      ctx.closePath();
      ctx.fill();
    }
  }

  // 胸びれ
  ctx.beginPath();
  ctx.moveTo(xAt(0.70), cy + bodyH * 0.10);
  ctx.lineTo(xAt(0.70 - 0.1 * look.pec), cy + bodyH * 0.36 * look.pec);
  ctx.lineTo(xAt(0.72), cy + bodyH * 0.22);
  ctx.closePath();
  ctx.fill();

  // ヒゲ
  if (look.whiskers > 0) {
    ctx.strokeStyle = cols.mid;
    ctx.lineWidth = Math.max(1, bodyH * 0.03);
    ctx.lineCap = 'round';
    for (let k = 0; k < look.whiskers; k++) {
      ctx.beginPath();
      ctx.moveTo(xAt(0.9), cy + bodyH * (0.05 + k * 0.06));
      ctx.quadraticCurveTo(
        xAt(0.96), cy + bodyH * (0.18 + k * 0.1) * look.whiskerLen,
        xAt(0.88), cy + bodyH * (0.28 + k * 0.12) * look.whiskerLen
      );
      ctx.stroke();
    }
  }

  // 目
  const ex = xAt(look.eyeX + 0.5);
  const ey = cy - bodyH * (look.eyeY + 0.02);
  const er = Math.max(1.6, bodyH * 0.055 * look.eye);
  ctx.beginPath();
  ctx.arc(ex, ey, er, 0, Math.PI * 2);
  ctx.fillStyle = opts.albino ? '#ffe8ea' : '#fbfbf8';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(ex + er * 0.22, ey, er * 0.55, 0, Math.PI * 2);
  ctx.fillStyle = opts.albino ? ALBINO_EYE : '#0e0e12';
  ctx.fill();

  // 口
  ctx.strokeStyle = 'rgba(0,0,0,.4)';
  ctx.lineWidth = look.mouth === 'wide' || look.mouth === 'beak' ? 1.6 : 1;
  ctx.beginPath();
  if (look.mouth === 'beak') {
    ctx.moveTo(nose - span * 0.01, cy);
    ctx.lineTo(nose - span * (0.12 + look.snout * 0.06), cy + bodyH * 0.06);
    ctx.stroke();
  } else if (look.mouth === 'up') {
    ctx.moveTo(nose - span * 0.02, cy - bodyH * 0.02);
    ctx.lineTo(nose - span * 0.08, cy - bodyH * 0.1);
    ctx.stroke();
  } else if (look.mouth === 'sucker') {
    ctx.arc(nose - span * 0.03, cy + bodyH * 0.06, bodyH * 0.06, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.moveTo(nose - span * 0.02, cy + bodyH * 0.02);
    ctx.lineTo(nose - span * (look.mouth === 'wide' ? 0.1 : 0.07), cy + bodyH * 0.09);
    ctx.stroke();
  }

  if (faceLeft) ctx.restore();
}

/* ---------------- 甲殻類のシルエット（エビ・ザリガニは横から、カニは正面から） ---------------- */
function drawCrustIcon(ctx, sp, W, H, opts = {}) {
  const c = colorsOf(sp, opts.albino);
  const eyeCol = opts.albino ? ALBINO_EYE : '#101014';
  const seg = (pts, w, col) => {
    ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
  };
  const ell = (x, y, rx, ry, rot, fill) => {
    ctx.fillStyle = fill;
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); ctx.fill();
  };

  const sizeScale = iconSizeScale(sp, opts);

  if (sp.shape === 'crab') {
    /* 正面から見たカニ（横に広い甲羅・左右に脚・前にハサミ） */
    const u = Math.min(W / 78, H / 44) * sizeScale;
    const cx = W * 0.5, cy = H * 0.54;
    const cw = 20 * u, ch = 11 * u;
    // 脚（甲羅の後ろに描く）
    for (const sg of [1, -1]) {
      for (let i = 0; i < 4; i++) {
        const t = i / 3;
        const bx = cx + sg * cw * (0.45 + t * 0.4), by = cy - ch * (0.3 - t * 0.5);
        const kx = cx + sg * cw * (1.05 + t * 0.42), ky = cy + ch * (0.15 + t * 0.28);
        seg([[bx, by], [kx, ky], [kx + sg * cw * 0.16, ky + ch * (0.95 - t * 0.25)]], 2.1 * u, c.fin);
      }
      // ハサミ（前に持ち上げる）
      const ax = cx + sg * cw * 0.5, ay = cy + ch * 0.35;
      const ex = cx + sg * cw * 1.0, ey = cy + ch * 1.05;
      seg([[ax, ay], [ex, ey]], 3 * u, c.mid);
      ell(ex + sg * cw * 0.16, ey + ch * 0.1, cw * 0.2, ch * 0.24, sg * 0.5, c.mid);
      seg([[ex + sg * cw * 0.26, ey - ch * 0.02], [ex + sg * cw * 0.44, ey - ch * 0.22]], 2.2 * u, c.belly);
    }
    // 甲羅
    ell(cx, cy, cw, ch, 0, c.mid);
    ctx.save();
    ctx.beginPath(); ctx.ellipse(cx, cy, cw, ch, 0, 0, Math.PI * 2); ctx.clip();
    ell(cx, cy - ch * 0.75, cw * 0.95, ch * 0.8, 0, c.top);     // 甲の上半分を濃く
    ctx.restore();
    // 目
    for (const sg of [1, -1]) ell(cx + sg * cw * 0.34, cy + ch * 0.1, 1.9 * u, 1.9 * u, 0, eyeCol);
    return;
  }

  /* エビ・ザリガニ（座標は頭右。呼び出し側で左右反転して左向きに） */
  const crayfish = sp.shape === 'crayfish';
  const u = Math.min(W / 86, H / 40) * sizeScale;
  const cx = W * 0.47, cy = H * 0.5;
  const bl = 30 * u;                                   // 頭から尾までの半分ほど
  const bh = (crayfish ? 6.2 : 5.2) * u;               // 胴の太さ

  // 触角（背景側）
  for (const sg of [1, -1]) {
    ctx.strokeStyle = c.top; ctx.lineWidth = 1.2 * u; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx + bl * 0.6, cy - bh * 0.35);
    ctx.quadraticCurveTo(cx + bl * (crayfish ? 0.95 : 1.1), cy + sg * bh * (crayfish ? 1.0 : 1.5),
      cx + bl * (crayfish ? 1.02 : 1.28), cy + sg * bh * (crayfish ? 1.9 : 2.6));
    ctx.stroke();
  }
  // 歩脚
  for (let i = 0; i < 4; i++) {
    const x = cx + bl * (0.36 - i * 0.16);
    seg([[x, cy + bh * 0.5], [x - bl * 0.03, cy + bh * 1.25], [x - bl * 0.1, cy + bh * 1.6]], 1.5 * u, c.fin);
  }
  // ハサミ脚
  for (const sg of [1, -1]) {
    const ax = cx + bl * 0.45, ay = cy + bh * 0.45;
    const ex = ax + bl * (crayfish ? 0.3 : 0.52), ey = ay + sg * bh * (crayfish ? 0.35 : 0.5) + bh * 0.15;
    seg([[ax, ay], [ex, ey]], (crayfish ? 3.2 : 1.9) * u, crayfish ? c.mid : c.fin);
    ell(ex + bl * 0.08, ey + bh * 0.05, bl * (crayfish ? 0.13 : 0.09), bh * (crayfish ? 0.5 : 0.3), sg * 0.35, c.mid);
    seg([[ex + bl * 0.16, ey], [ex + bl * (crayfish ? 0.3 : 0.22), ey - bh * 0.18]], 1.7 * u, c.belly);
  }
  // 尾扇
  ctx.fillStyle = c.fin;
  ctx.beginPath();
  ctx.moveTo(cx - bl * 0.52, cy + bh * 0.25);
  ctx.lineTo(cx - bl * 0.8, cy - bh * 0.75);
  ctx.lineTo(cx - bl * 0.86, cy + bh * 0.55);
  ctx.lineTo(cx - bl * 0.74, cy + bh * 1.3);
  ctx.closePath();
  ctx.fill();
  // 胴（頭から尾へ一本の輪郭。背側を少し反らせる）
  const nose = cx + bl * 0.66, tail = cx - bl * 0.55;
  const th = (t) => bh * (0.5 + 0.55 * Math.sin(Math.PI * Math.min(1, 0.25 + t * 0.85)));  // 頭側が太い
  ctx.beginPath();
  ctx.moveTo(tail, cy + bh * 0.1);
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    ctx.lineTo(tail + (nose - tail) * t, cy - th(t) - bh * 0.1 * Math.sin(Math.PI * t));
  }
  for (let i = 20; i >= 0; i--) {
    const t = i / 20;
    ctx.lineTo(tail + (nose - tail) * t, cy + th(t) * 0.82 + bh * 0.1 * (1 - t));
  }
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, cy - bh * 1.2, 0, cy + bh * 1.1);
  grad.addColorStop(0, c.top); grad.addColorStop(0.45, c.mid); grad.addColorStop(1, c.belly);
  ctx.fillStyle = grad;
  ctx.fill();
  // 節（腹側の細い線）
  ctx.strokeStyle = 'rgba(0,0,0,.22)'; ctx.lineWidth = 1 * u;
  for (let i = 1; i <= 4; i++) {
    const t = 0.1 + i * 0.1;
    const x = tail + (nose - tail) * t;
    ctx.beginPath();
    ctx.moveTo(x, cy - th(t) * 0.85);
    ctx.lineTo(x, cy + th(t) * 0.7);
    ctx.stroke();
  }
  // 額角と目
  seg([[nose - bl * 0.02, cy - bh * 0.35], [nose + bl * (crayfish ? 0.14 : 0.2), cy - bh * 0.95]], 1.7 * u, c.top);
  ell(nose - bl * 0.12, cy - bh * 0.38, 2.1 * u, 2.1 * u, 0, eyeCol);
}

/* ===========================================================
   UI コントローラ
   =========================================================== */
export class UI {
  constructor(game) {
    this.game = game;
    this._last = {};
    this._toasts = [];
    this.openModal = null;
    this.journalShowAlbino = Object.create(null); // sp.id -> bool（図鑑でアルビノ表示中）

    this.el = {
      body: document.body,
      money: $('money'), level: $('level'), xpFill: $('xp-fill'), xpText: $('xp-text'),
      gearRod: $('gear-rod'), gearBait: $('gear-bait'),
      clock: $('clock'), dayLabel: $('daylabel'), weatherIcon: $('weather-icon'),
      weatherName: $('weather-name'), depth: $('depth'), rig: $('rig'), caught: $('caught-count'),
      prompt: $('prompt'), power: $('power-meter'), powerFill: $('power-fill'),
      powerBand: $('power-band'), powerMark: $('power-mark'),
      powerTrack: document.querySelector('.pm-track'), aim: $('aim'),
      fight: $('fight-panel'), tension: $('tension-fill'), map: $('map-window'),
      danger: $('danger-flash'), tensionVig: $('tension-vignette'),
      biteAlert: $('bite-alert'), toasts: $('toasts'),
      loading: $('loading'), title: $('title-screen'),
      catchCard: $('catch-card'), shop: $('shop'), journal: $('journal'), pause: $('pause'),
      rigWin: $('rig-window'), fishDetail: $('fish-detail'),
    };

    this._bind();
  }

  _bind() {
    const g = this.game;

    $('btn-start').addEventListener('click', () => g.start(false));
    $('btn-continue').addEventListener('click', () => g.start(true));
    $('btn-card-ok').addEventListener('click', () => g.dismissCatch());
    // カード全体・背景クリックでも次へ（Space と同じ）
    this.el.catchCard.addEventListener('click', (e) => {
      if (e.target.closest('#card-albino-badge')) return;
      g.dismissCatch();
    });
    $('btn-resume').addEventListener('click', () => this.closeAll());
    $('btn-rest').addEventListener('click', () => g.rest());
    $('btn-rig-close').addEventListener('click', () => this.closeAll());
    $('btn-map-close').addEventListener('click', () => this.closeAll());
    $('btn-fish-detail-close').addEventListener('click', () => this.closeFishDetail());
    $('btn-fish-detail-ok').addEventListener('click', () => this.closeFishDetail());
    this.el.fishDetail.addEventListener('click', (e) => {
      if (e.target === this.el.fishDetail) this.closeFishDetail();
    });
    /* 3 つの層のボタンを作る（クリックで選択） */
    const col = $('rig-col');
    for (const L of RIG_LAYERS) {
      const d = document.createElement('div');
      d.className = `rig-band ${L.id}`;
      d.dataset.layer = L.id;
      d.innerHTML = `<span class="nm">${rigName(L)}</span><span class="mt"></span>`;
      d.addEventListener('click', () => {
        g.setRigLayer(L.id);
        this.renderRig();
        g.audio.reelTick(0.35);
      });
      col.appendChild(d);
    }
    $('btn-reset').addEventListener('click', () => {
      if (confirm(t('ui.confirm.reset'))) g.resetSave();
    });

    document.querySelectorAll('[data-close]').forEach((b) =>
      b.addEventListener('click', () => this.closeAll())
    );

    document.querySelectorAll('.tab').forEach((t) =>
      t.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        this.shopTab = t.dataset.tab;
        this.renderShop();
        g.audio.click();
      })
    );
    this.shopTab = 'rod';

    // 図鑑のタブ（さかな / 地形）
    this.journalTab = 'fish';
    document.querySelectorAll('.jtab').forEach((t) =>
      t.addEventListener('click', () => {
        document.querySelectorAll('.jtab').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        this.journalTab = t.dataset.jtab;
        this.openJournal();
        g.audio.click();
      })
    );

    // 設定
    const s = g.state.settings;
    const langSelects = [...document.querySelectorAll('.opt-lang')];
    langSelects.forEach((select) => {
      select.value = s.lang || 'ja';
      select.addEventListener('change', (e) => {
        const lang = e.target.value;
        s.lang = lang;
        setLang(lang);
        langSelects.forEach((other) => { other.value = lang; });
        g.saveState();
        this.applyLanguage();
      });
    });
    $('opt-volume').value = Math.round(s.volume * 100);
    $('opt-bgm').value = Math.round((s.bgm ?? 0.7) * 100);
    $('opt-sens').value = Math.round(s.sens * 100);
    $('opt-quality').value = s.quality;
    $('opt-shadow').checked = s.shadow;
    $('opt-volume').addEventListener('input', (e) => {
      s.volume = e.target.value / 100;
      g.audio.setVolume(s.volume);
      g.saveState();
    });
    $('opt-bgm').addEventListener('input', (e) => {
      s.bgm = e.target.value / 100;
      g.audio.setBgm(s.bgm);
      g.saveState();
    });
    $('opt-sens').addEventListener('input', (e) => {
      s.sens = e.target.value / 100;
      g.saveState();
    });
    $('opt-quality').addEventListener('change', (e) => {
      s.quality = e.target.value;
      g.applyQuality();
      g.saveState();
      this.toast(t('ui.toast.qualityChanged'), 'good');
    });
    $('opt-shadow').addEventListener('change', (e) => {
      s.shadow = e.target.checked;
      g.applyQuality();
      g.saveState();
    });
    $('opt-fightui').value = s.fightUi || 'tension';
    this.fightUi = s.fightUi || 'tension';
    $('opt-fightui').addEventListener('change', (e) => {
      this.setFightUi(e.target.value);
      g.saveState();
    });

    $('opt-debug').checked = !!s.debug;
    $('opt-debug').addEventListener('change', (e) => g.debug.setEnabled(e.target.checked));

    /* --- 湖（シード） --- */
    $('opt-randomlake').checked = !!s.randomLake;
    $('opt-randomlake').addEventListener('change', (e) => {
      s.randomLake = e.target.checked;
      g.saveState();
      this.toast(t(s.randomLake ? 'ui.toast.lakeRandomOn' : 'ui.toast.lakeRandomOff'), 'good');
    });
    $('btn-seed-random').addEventListener('click', () => {
      if (confirm(t('ui.confirm.newLake'))) g.newRandomLake();
    });
    $('btn-seed-apply').addEventListener('click', () => {
      const v = $('opt-seed').value.trim();
      if (!v) return;
      if (String(g.state.seed) === v) { this.toast(t('ui.toast.alreadyLake')); return; }
      if (confirm(t('ui.confirm.seedLake', { seed: v }))) g.setLakeSeed(v);
    });
    $('opt-seed').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('btn-seed-apply').click();
      e.stopPropagation();
    });
  }

  applyLanguage() {
    applyDom();
    this._last = {};
    document.querySelectorAll('.opt-lang').forEach((select) => {
      select.value = this.game.state.settings.lang || 'ja';
    });
    for (const el of document.querySelectorAll('#rig-col .rig-band')) {
      const layer = RIG_LAYERS.find((x) => x.id === el.dataset.layer);
      if (layer) el.querySelector('.nm').textContent = rigName(layer);
    }
    this.updateHUD(this.game);
    if (this.openModal === 'shop') this.renderShop();
    else if (this.openModal === 'journal') this.openJournal();
    else if (this.openModal === 'fishDetail' && this._detailInfo) {
      this.openFishDetail(this._detailInfo.sp, this._detailInfo.rec);
    } else if (this.openModal === 'map') this.openMap();
    else if (this.openModal === 'rig') this.renderRig();
    else if (this.openModal === 'pause') this.renderLakeInfo();
    else if (this.openModal === 'catch' && this.catchInfo) this.showCatch(this.catchInfo);
  }

  /** ポーズ画面の湖情報を更新 */
  renderLakeInfo() {
    const g = this.game;
    if (!g.lakeStats) return;
    const i = g.lakeInfo();
    $('opt-seed').value = String(i.seed);
    $('lake-info').innerHTML = `
      <div>${t('ui.lakeInfo.dockTipHtml', { depth: fmt1(i.dockDepth) })}</div>
      <div>${t('ui.lakeInfo.holeHtml', {
        depth: fmt1(i.holeDepth),
        where: i.holeWhere,
        more: i.holeCount > 1 ? t('ui.lakeInfo.otherSpots', { n: i.holeCount - 1 }) : '',
      })}</div>
      <div>${t('ui.lakeInfo.flatHtml', {
        depth: fmt1(i.flatDepth),
        where: i.flatWhere,
        more: i.flatCount > 1 ? t('ui.lakeInfo.otherSpots', { n: i.flatCount - 1 }) : '',
      })}</div>
      <div>${t('ui.lakeInfo.reachHtml', {
        min: fmt1(i.minDepth), max: fmt1(i.maxDepth),
      })}</div>`;
  }

  /* ---------------- 汎用 ---------------- */
  hideLoading() {
    this.el.loading.classList.add('done');
    setTimeout(() => { this.el.loading.style.display = 'none'; }, 620);
  }

  toast(msg, type = '') {
    const d = document.createElement('div');
    d.className = 'toast ' + type;
    d.innerHTML = msg;
    this.el.toasts.appendChild(d);
    setTimeout(() => {
      d.classList.add('out');
      setTimeout(() => d.remove(), 400);
    }, 2600);
    while (this.el.toasts.children.length > 4) this.el.toasts.firstChild.remove();
  }

  setPrompt(html) {
    if (this._last.prompt === html) return;
    this._last.prompt = html;
    this.el.prompt.innerHTML = html || '';
    this.el.prompt.classList.toggle('on', !!html);
  }

  /** @param target 狙った距離に必要なパワー / tol 許容差 */
  showPower(on, v = 0, target = null, tol = 0.06) {
    this.el.power.classList.toggle('on', on);
    if (!on) return;
    this.el.powerFill.style.width = (clamp01(v) * 100).toFixed(1) + '%';
    if (target === null) return;
    const lo = clamp01(target - tol), hi = clamp01(target + tol);
    this.el.powerBand.style.left = (lo * 100).toFixed(1) + '%';
    this.el.powerBand.style.width = ((hi - lo) * 100).toFixed(1) + '%';
    this.el.powerMark.style.left = (clamp01(target) * 100).toFixed(1) + '%';
    this.el.powerTrack.classList.toggle('on-target', Math.abs(v - target) <= tol);
  }

  biteAlert() {
    const e = this.el.biteAlert;
    e.classList.remove('on');
    void e.offsetWidth;
    e.classList.add('on');
    setTimeout(() => e.classList.remove('on'), 900);
  }

  /** ファイト中の表示量を切り替える（設定・U キーの両方から呼ばれる） */
  setFightUi(mode, state = null) {
    const order = ['tension', 'none'];
    this.fightUi = order.includes(mode) ? mode : 'tension';
    if (state) state.settings.fightUi = this.fightUi;
    const sel = $('opt-fightui');
    if (sel) sel.value = this.fightUi;
    return this.fightUi;
  }

  /** U キー用。tension → none → tension と回す */
  cycleFightUi(state = null) {
    const order = ['tension', 'none'];
    const next = order[(order.indexOf(this.fightUi || 'tension') + 1) % order.length];
    return this.setFightUi(next, state);
  }

  showFight(on, d = {}) {
    /* 表示量は 'tension'（テンションだけ）か 'none'。'none' でもファイト自体は続くので、
       パネルを出さずに画面端の赤（とドラグ音・竿のしなり）で限界を伝える */
    const showPanel = on && (this.fightUi || 'tension') !== 'none';
    this.el.fight.classList.toggle('on', showPanel);
    /* 画面端の赤いにじみ。ファイトが終わったら必ず 0 に戻す必要があるので、
       パネルを出すかどうかに関わらず、早期 return より前で処理する。
       濃さは game 側が「切れるまでの残り秒数」から出した danger を使う
       （テンションの % だと、引きの強い魚は 80%→切れるまで 0.3 秒しかなく
       警告として間に合わなかった） */
    const vk = on ? clamp01(d.danger ?? 0) : 0;
    const vig = Math.pow(vk, 1.3).toFixed(3);
    if (vig !== this._last.tensionVig) {
      this.el.tensionVig.style.opacity = vig;
      this._last.tensionVig = vig;
    }
    if (!showPanel) return;
    // 巻いている間は枠が光る（専用のバーを増やさずに巻けているかを伝える）
    this.el.fight.classList.toggle('reeling', !!d.reeling);
    this.el.tension.style.width = (clamp01(d.tension) * 100).toFixed(1) + '%';
    // バーの点滅も残り秒数ベースに揃える（テンション 82% 固定だと猶予が魚ごとに揃わない）
    const danger = (d.danger ?? 0) > 0.35;
    if (danger !== this._last.danger) {
      this.el.danger.classList.toggle('on', danger);
      this._last.danger = danger;
    }
  }

  /* ---------------- HUD ---------------- */
  updateHUD(g) {
    const s = g.state;
    if (this._last.money !== s.money) {
      this.el.money.textContent = fmtInt(s.money);
      this._last.money = s.money;
    }
    if (this._last.level !== s.level) {
      this.el.level.textContent = s.level;
      this._last.level = s.level;
    }
    const need = xpForLevel(s.level);
    const prev = s.level > 1 ? xpForLevel(s.level - 1) : 0;
    const cur = Math.max(0, s.xp - prev);
    const p = clamp01(cur / Math.max(1, need - prev));
    if (this._last.xp !== s.xp) {
      this.el.xpFill.style.width = (p * 100).toFixed(1) + '%';
      this.el.xpText.textContent = `${fmtInt(cur)} / ${fmtInt(need - prev)}`;
      this._last.xp = s.xp;
    }
    const hourStr = fmtClock(s.clock);
    if (this._last.clock !== hourStr) {
      this.el.clock.textContent = hourStr;
      this.el.dayLabel.textContent = timeBandLabel(s.clock);
      this._last.clock = hourStr;
    }
    const w = g.env.weather;
    if (this._last.weather !== w.key) {
      this.el.weatherIcon.innerHTML = iconHtml(w.icon, 'ico weather');
      this.el.weatherName.textContent = weatherName(w);
      this._last.weather = w.key;
    }
    const dep = g.hudDepth;
    const depStr = dep > 0 ? `${fmt1(dep)} m` : '—';
    if (this._last.depth !== depStr) {
      this.el.depth.textContent = depStr;
      this._last.depth = depStr;
    }
    // タナ（層の名前だけ。実際の深さは水深から自動なので出さない）
    const rigStr = rigName(g.rigLayer);
    if (this._last.rig !== rigStr) {
      this.el.rig.textContent = rigStr;
      this._last.rig = rigStr;
    }
    // 狙い距離／竿の飛距離。頭打ちなら「これ以上は届かない」が分かる
    const aimStr = g.hudAim > 0 ? `${fmt1(g.hudAim)} / ${g.castRange} m` : `— / ${g.castRange} m`;
    if (this._last.aim !== aimStr) {
      this.el.aim.textContent = aimStr;
      this._last.aim = aimStr;
    }
    if (this._last.caught !== s.totalCaught) {
      this.el.caught.textContent = fishCount(s.totalCaught);
      this._last.caught = s.totalCaught;
    }
    const rod = GEAR.rod.find((r) => r.id === s.gear.rod);
    const bait = GEAR.bait.find((b) => b.id === s.gear.bait);
    const rodTxt = `${rod.icon}|${gearName(rod)}`;
    if (this._last.rod !== rodTxt) {
      this.el.gearRod.innerHTML = iconLabel(rod.icon, gearName(rod), 'ico gear');
      this._last.rod = rodTxt;
    }
    // エサは残り個数も出す（少なくなったら色を変える）
    const n = (s.baitStock && s.baitStock[bait.id]) || 0;
    const baitTxt = `${bait.icon}|${gearName(bait)}|${n}`;
    if (this._last.bait !== baitTxt) {
      this.el.gearBait.innerHTML = iconLabel(bait.icon, gearName(bait), 'ico gear')
        + `<b class="bait-n${n <= 0 ? ' out' : n <= 3 ? ' low' : ''}">×${n}</b>`;
      this._last.bait = baitTxt;
    }
  }

  /* ---------------- 釣果カード ---------------- */
  showCatch(info) {
    this.catchInfo = info;
    const { sp, len, weight, value, xp, record, isNew, albino, isNewAlbino } = info;
    const rib = $('card-rarity');
    rib.textContent = rarityLabel(sp);
    rib.className = 'card-ribbon r' + sp.rarity;
    // 釣果カードだけ接頭詞付き（図鑑は素の名前）。接頭詞は細字
    const prefix = catchDisplayPrefix(sp, len, weight, albino);
    const title = catchDisplayName(sp, len, weight, albino);
    const base = speciesName(sp);
    $('card-name').innerHTML = prefix
      ? `<span class="catch-prefix">${prefix}</span>${base}`
      : (title || base);
    $('card-len').textContent = `${fmt1(len)} cm`;
    $('card-weight').textContent = fmtWeight(weight);
    $('card-value').textContent = `${fmtInt(value)} G`;
    $('card-xp').textContent = `+${fmtInt(xp)}`;
    $('card-flavor').textContent = speciesFlavor(sp);
    $('card-record').classList.toggle('hidden', !record);
    $('card-new').classList.toggle('hidden', !isNew);
    const albinoNew = $('card-albino-new');
    if (albinoNew) albinoNew.classList.toggle('hidden', !isNewAlbino);
    drawFishIcon($('fish-icon'), sp, { albino: !!albino, len });
    const badge = $('card-albino-badge');
    if (badge) {
      badge.classList.toggle('hidden', !albino);
      badge.classList.toggle('on', !!albino);
    }
    this.el.catchCard.classList.add('open');
    this.openModal = 'catch';
  }

  hideCatch() {
    this.el.catchCard.classList.remove('open');
    if (this.openModal === 'catch') this.openModal = null;
  }

  /* ---------------- ショップ ---------------- */
  openShop() {
    this.renderShop();
    this.el.shop.classList.add('open');
    this.openModal = 'shop';
  }

  renderShop() {
    const g = this.game, s = g.state;
    $('shop-money').textContent = fmtInt(s.money);
    const kind = this.shopTab;
    const list = GEAR[kind];
    const wrap = $('shop-list');
    wrap.innerHTML = '';
    const isBait = kind === 'bait';
    for (const it of list) {
      const stock = isBait ? g.baitCount(it.id) : 0;
      const owned = isBait ? stock > 0 : s.owned[kind].includes(it.id);
      const equipped = s.gear[kind] === it.id;
      const locked = s.level < it.level;
      const div = document.createElement('div');
      div.className = 'item' + (equipped ? ' equipped' : owned ? ' owned' : '');
      // 内部数値はマスクし、言葉だけで示す（data.js gearStats）
      const stats = gearStats(kind, it).map(([k, v]) => `${k} <b>${v}</b>`);
      div.innerHTML = `
        <div class="ic">${iconHtml(it.icon, 'ico shop')}</div>
        <div class="body">
          <div class="nm">${gearName(it)}${isBait ? ` <b class="stock${stock <= 0 ? ' out' : stock <= 3 ? ' low' : ''}">${t('ui.shop.stock', { n: stock })}</b>` : ''}${equipped ? ` <small style="opacity:.7">(${t('ui.shop.equipped')})</small>` : ''}</div>
          <div class="ds">${gearDesc(it)}</div>
          <div class="stats">${stats.map((x) => `<i>${x}</i>`).join('')}</div>
        </div>
        <div class="act"></div>`;
      const act = div.querySelector('.act');
      if (isBait) {
        if (!locked && !equipped && stock > 0) {
          const e = document.createElement('button');
          e.className = 'btn ghost';
          e.textContent = t('ui.shop.equip');
          e.onclick = () => { g.equip(kind, it.id); this.renderShop(); };
          act.appendChild(e);
        }
        if (locked) {
          act.innerHTML = `<span class="locked">${t('ui.shop.unlockLv', { level: it.level })}</span>`;
        } else {
          const b = document.createElement('button');
          b.className = 'btn ghost';
          b.innerHTML = `<small style="opacity:.7">${t('ui.shop.pack', { n: it.pack })}</small> <span class="price">${it.price ? fmtInt(it.price) + ' G' : t('ui.shop.free')}</span>`;
          b.disabled = s.money < it.price;
          b.onclick = () => { if (g.buy(kind, it.id)) this.renderShop(); };
          act.appendChild(b);
        }
      } else if (equipped) {
        act.innerHTML = `<span style="color:var(--gold);font-size:12px">${t('ui.shop.equipped')}</span>`;
      } else if (owned) {
        const b = document.createElement('button');
        b.className = 'btn ghost';
        b.textContent = t('ui.shop.equip');
        b.onclick = () => { g.equip(kind, it.id); this.renderShop(); };
        act.appendChild(b);
      } else if (locked) {
        act.innerHTML = `<span class="locked">${t('ui.shop.unlockLv', { level: it.level })}</span>`;
      } else {
        const b = document.createElement('button');
        b.className = 'btn ghost';
        b.innerHTML = `<span class="price">${fmtInt(it.price)} G</span>`;
        b.disabled = s.money < it.price;
        b.onclick = () => { if (g.buy(kind, it.id)) this.renderShop(); };
        act.appendChild(b);
      }
      wrap.appendChild(div);
    }
    // タブのラベル更新
    document.querySelectorAll('.tab').forEach((t) => {
      t.textContent = gearKindLabel(t.dataset.tab);
    });
  }

  /* ---------------- 図鑑 ---------------- */
  openJournal() {
    if (this.journalTab === 'terrain') return this.openTerrainJournal();
    const s = this.game.state;
    const reveal = this.game.revealAll;
    const grid = $('journal-grid');
    grid.innerHTML = '';
    let known = 0, knownFish = 0, totalFish = 0;
    // レア度順、ゴミは最後
    const order = [...SPECIES].sort((a, b) =>
      (a.rarity === 0 ? 9 : a.rarity) - (b.rarity === 0 ? 9 : b.rarity) || a.len[1] - b.len[1]);
    for (const sp of order) {
      const rec = s.records[sp.id] || (reveal
        ? { count: 0, maxLen: sp.len[0], maxWeight: 0, dbg: true }
        : null);
      if (sp.rarity > 0) totalFish++;
      if (rec && !rec.dbg) { known++; if (sp.rarity > 0) knownFish++; }
      const d = document.createElement('div');
      d.className = 'jcard r' + sp.rarity + (rec ? '' : ' unknown');
      const art = document.createElement('div');
      art.className = 'fish-art';
      const cv = document.createElement('canvas');
      cv.width = 240; cv.height = 100;
      art.appendChild(cv);
      const hasAlbino = !!(rec && sp.rarity > 0 && (rec.albinoCaught || reveal));
      const showAlbino = !!(hasAlbino && this.journalShowAlbino[sp.id]);
      if (hasAlbino) {
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = 'albino-badge' + (showAlbino ? ' on' : '');
        badge.textContent = t('ui.card.albino');
        badge.title = t('ui.card.albinoTitle');
        badge.addEventListener('click', (e) => {
          e.stopPropagation();
          this.journalShowAlbino[sp.id] = !this.journalShowAlbino[sp.id];
          const on = !!this.journalShowAlbino[sp.id];
          badge.classList.toggle('on', on);
          drawFishIcon(cv, sp, { albino: on });
          this.game.audio.click();
        });
        art.appendChild(badge);
      }
      d.appendChild(art);
      const info = document.createElement('div');
      if (rec && !rec.dbg) {
        info.innerHTML = `
          <div class="jn"><span>${speciesName(sp)}</span><span class="jr" style="color:${RARITY[sp.rarity].color}">${rarityLabel(sp)}</span></div>
          <div class="jm"><span class="jsz">${t('ui.journal.maxCm', { n: fmt1(rec.maxLen) })}</span><span class="jcnt">${fishCount(rec.count)}</span></div>`;
      } else if (rec) {
        info.innerHTML = `
          <div class="jn"><span>${speciesName(sp)}</span><span class="jr" style="color:${RARITY[sp.rarity].color}">${rarityLabel(sp)}</span></div>
          <div class="jm"><span class="jsz">—</span><span class="jcnt">—</span></div>`;
      } else {
        info.innerHTML = `
          <div class="jn"><span>???</span><span class="jr" style="color:${RARITY[sp.rarity].color}">${rarityLabel(sp)}</span></div>
          <div class="jm">${t('ui.journal.unknown')}</div>`;
      }
      d.appendChild(info);
      if (rec) {
        d.classList.add('clickable');
        d.title = t('ui.journal.detailHint');
        d.addEventListener('click', () => this.openFishDetail(sp, rec));
      }
      grid.appendChild(d);
      // デバッグ表示のときは姿も見せる（未発見のマークは文言で分かる）
      drawFishIcon(cv, sp, { unknown: !rec, albino: showAlbino });
    }
    $('journal-progress').innerHTML = t('ui.journal.progressFish', {
      n: knownFish,
      m: totalFish,
      left: known - knownFish,
      0: SPECIES.length - totalFish,
    }) + (reveal ? `<small style="color:var(--gold);margin-left:8px">${t('ui.journal.debugAll')}</small>` : '');
    const got = ACHIEVEMENTS.filter((a) => s.achievements.includes(a.id));
    $('journal-ach').innerHTML =
      `<b>${t('ui.journal.achProgress', { n: got.length, m: ACHIEVEMENTS.length })}</b> ` +
      ACHIEVEMENTS.map((a) => {
        const ok = s.achievements.includes(a.id);
        return `<span style="margin-left:10px;opacity:${ok ? 1 : 0.4};display:inline-flex;align-items:center;gap:4px">${iconHtml(ok ? 'ui-medal' : 'ui-empty', 'ico tiny')} ${achievementName(a)}<small style="opacity:.6"> (${achievementDesc(a)})</small></span>`;
      }).join('');
    this.el.journal.classList.add('open');
    this.openModal = 'journal';
  }

  /* ---------------- 図鑑・魚の詳細 ---------------- */
  openFishDetail(sp, rec) {
    this._detailInfo = { sp, rec };
    const rib = $('fd-rarity');
    rib.textContent = rarityLabel(sp);
    rib.className = 'card-ribbon r' + sp.rarity;
    const reveal = !!(rec && rec.dbg) || !!this.game.revealAll;
    const hasAlbino = !!(rec && sp.rarity > 0 && (rec.albinoCaught || this.game.revealAll));
    const albinoView = !!(hasAlbino && this.journalShowAlbino[sp.id]);
    $('fd-name').textContent = speciesName(sp)
      + (albinoView ? t('ui.journal.albinoSuffix') : '');
    $('fd-flavor').textContent = speciesFlavor(sp);

    const [lo, hi] = sp.len;
    const vLo = valueOf(sp, lo), vHi = valueOf(sp, hi);
    const fp = fightPattern(sp);
    const caught = (rec && !rec.dbg) ? (rec.count || 0) : 0;
    const unlock = (need) => reveal || caught >= need;
    const locked = (need) =>
      `???<small style="opacity:.55;font-weight:500"> (${t('ui.journal.unlockLeft', { n: need - caught })})</small>`;

    $('fd-badges').innerHTML = [
      ['layer', t('ui.journal.badgeLayer'), swimLayerMarks(sp)],
      ['time', t('ui.journal.badgeTime'), preferShort(sp.times, timeShort)],
      ['weather', t('ui.journal.badgeWeather'), preferShort(sp.weather, weatherShort)],
      ['fight', t('ui.journal.badgeFight'), fightName(fp)],
    ].map(([cls, k, v]) =>
      `<span class="fd-badge ${cls}"><small>${k}</small>${v}</span>`
    ).join('');

    const rows = [
      [t('ui.journal.statCaught'), fishCount(caught)],
      [t('ui.journal.statMax'), caught > 0 ? `${fmt1(rec.maxLen)} cm / ${fmtWeight(rec.maxWeight)}` : '—'],
      [t('ui.journal.statMinSize'), unlock(DETAIL_UNLOCK.minLen)
        ? `${fmt1(lo)} cm` : locked(DETAIL_UNLOCK.minLen)],
      [t('ui.journal.statMaxSize'), unlock(DETAIL_UNLOCK.maxLen)
        ? `${fmt1(hi)} cm` : locked(DETAIL_UNLOCK.maxLen)],
      [t('ui.journal.statValue'), unlock(DETAIL_UNLOCK.value)
        ? `${fmtInt(vLo)}–${fmtInt(vHi)} G` : locked(DETAIL_UNLOCK.value)],
      [t('ui.journal.statDepth'), unlock(DETAIL_UNLOCK.depth)
        ? `${sp.depth[0]}–${sp.depth[1]} m` : locked(DETAIL_UNLOCK.depth)],
    ];

    $('fd-stats').innerHTML = rows.map(([k, v]) =>
      `<div><span>${k}</span><b>${v}</b></div>`
    ).join('');

    drawFishIcon($('fd-icon'), sp, { albino: albinoView });
    const badge = $('fd-albino-badge');
    if (badge) {
      const can = hasAlbino;
      badge.classList.toggle('hidden', !can);
      badge.classList.toggle('on', albinoView);
      badge.onclick = (e) => {
        e.stopPropagation();
        if (!can) return;
        this.journalShowAlbino[sp.id] = !this.journalShowAlbino[sp.id];
        this.openFishDetail(sp, rec);
      };
    }
    this.el.fishDetail.classList.add('open');
    this.openModal = 'fishDetail';
    this.game.audio.click();
  }

  closeFishDetail() {
    if (!this.el.fishDetail.classList.contains('open')) return;
    this.el.fishDetail.classList.remove('open');
    if (this.openModal === 'fishDetail') {
      this.openModal = this.el.journal.classList.contains('open') ? 'journal' : null;
    }
    this.game.audio.click();
  }

  /* ---------------- マップ（測量図） ---------------- */
  openMap() {
    const g = this.game, t = g.terrain;
    const cv = $('map-canvas');
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const N = g.mapN, step = g.mapStep;
    const span = N * step;                       // 描く範囲（= WATER_REGION）
    const P = (x, z) => [((x + span / 2) / span) * W, ((z + span / 2) / span) * H];

    ctx.fillStyle = '#0b1118';
    ctx.fillRect(0, 0, W, H);
    const cw = W / N + 0.6;                      // 少し重ねて隙間を消す

    /* --- 測量済みのセルを地形色で塗る --- */
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        if (!g.mapHas(i, j)) continue;
        const x = (i + 0.5) * step - span / 2;
        const z = (j + 0.5) * step - span / 2;
        const h = t.heightAt(x, z);
        let col;
        if (h < 0) {
          const d = -h;
          // 浅い＝明るい水色 → 深い＝濃紺
          const k = clamp01(d / 24);
          const r = Math.round(lerpN(122, 18, k));
          const gg = Math.round(lerpN(214, 46, k));
          const b = Math.round(lerpN(206, 96, k));
          col = `rgb(${r},${gg},${b})`;
        } else if (h < 1.1) {
          col = '#c8b78a';                       // 汀線の砂
        } else {
          const k = clamp01((h - 1.1) / 26);
          const r = Math.round(lerpN(86, 44, k));
          const gg = Math.round(lerpN(132, 84, k));
          const b = Math.round(lerpN(66, 52, k));
          col = `rgb(${r},${gg},${b})`;
        }
        ctx.fillStyle = col;
        const [px, py] = P(x - step / 2, z - step / 2);
        ctx.fillRect(px, py, cw, cw);
      }
    }

    /* --- 見つけた地形（淵・浅い平場） --- */
    const seenAt = (x, z) => {
      const i = Math.floor((x + span / 2) / step), j = Math.floor((z + span / 2) / step);
      return i >= 0 && j >= 0 && i < N && j < N && g.mapHas(i, j);
    };
    const ring = (o, col) => {
      if (!seenAt(o.x, o.z)) return;
      const [cx, cy] = P(o.x, o.z);
      ctx.strokeStyle = col; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, (o.r * 0.75 / span) * W, 0, Math.PI * 2); ctx.stroke();
    };
    for (const o of t.lake.holes) ring(o, 'rgba(200,107,255,.85)');
    for (const o of t.lake.flats) ring(o, 'rgba(109,224,138,.85)');

    /* --- 見つけた水中ストラクチャー --- */
    for (const st of t.structures || []) {
      if (!seenAt(st.x, st.z)) continue;
      const [sx, sy] = P(st.x, st.z);
      ctx.fillStyle = '#ff9a5a';
      ctx.beginPath();
      if (st.kind === 'rock') ctx.arc(sx, sy, 2.6, 0, Math.PI * 2);
      else { ctx.moveTo(sx, sy - 3); ctx.lineTo(sx + 3, sy); ctx.lineTo(sx, sy + 3); ctx.lineTo(sx - 3, sy); }
      ctx.fill();
    }

    /* --- 桟橋 --- */
    if (seenAt(t.dockEnd.x, t.dockEnd.z) || seenAt(t.dockStart.x, t.dockStart.z)) {
      const [ax, ay] = P(t.dockStart.x, t.dockStart.z);
      const [bx, by] = P(t.dockEnd.x, t.dockEnd.z);
      ctx.strokeStyle = '#ffd479'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }

    /* --- 仕掛けの位置（投げている間） --- */
    if (['flight', 'wait', 'nibble', 'bite', 'fight'].includes(g.fs)) {
      const [bx, by] = P(g.bobber.x, g.bobber.z);
      ctx.strokeStyle = '#ff5d5d'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(bx, by, 4.5, 0, Math.PI * 2); ctx.stroke();
    }

    /* --- プレイヤー（向き付き） --- */
    const [ux, uy] = P(g.pos.x, g.pos.z);
    ctx.save();
    ctx.translate(ux, uy);
    ctx.rotate(-g.yaw + Math.PI);      // 画面上向き = -Z
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -7); ctx.lineTo(4.6, 5); ctx.lineTo(0, 2.6); ctx.lineTo(-4.6, 5);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    /* --- スケール --- */
    ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 1.5;
    const bar = (100 / span) * W;
    ctx.beginPath(); ctx.moveTo(12, H - 14); ctx.lineTo(12 + bar, H - 14); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.7)';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText('100 m', 14, H - 20);

    $('map-progress').textContent = `${(g.mapProgress() * 100).toFixed(1)}%`;
    const at = g.fs === 'idle' || g.fs === 'charge' ? g.aimPoint : g.bobber;
    const d = at ? t.depthAt(at.x, at.z) : 0;
    $('map-depth').textContent = d > 0 ? `${fmt1(d)} m` : t('ui.map.land');
    $('map-legend').innerHTML = t('ui.map.legendHtml');

    this.el.map.classList.add('open');
    this.openModal = 'map';
  }

  /* ---------------- 地形図鑑 ---------------- */
  openTerrainJournal() {
    const s = this.game.state;
    const reveal = this.game.revealAll;
    const grid = $('journal-grid');
    grid.innerHTML = '';
    let known = 0;
    let group = null;
    for (const k of TERRAIN_KINDS) {
      const rec = s.terrain[k.id];
      const seen = !!rec;
      if (seen) known++;
      if (k.group !== group) {
        group = k.group;
        const h = document.createElement('div');
        h.className = 'jgroup';
        h.textContent = terrainGroupLabel(group);
        grid.appendChild(h);
      }
      const show = seen || reveal;
      const d = document.createElement('div');
      d.className = 'jcard tcard' + (show ? '' : ' unknown');
      const cv = document.createElement('canvas');
      cv.width = 320; cv.height = 120;
      d.appendChild(cv);
      const info = document.createElement('div');
      const fish = seen ? rec.fish.map((id) => SPECIES_BY_ID[id]).filter(Boolean) : [];
      info.innerHTML = `
        <div class="jn"><span>${show ? terrainName(k) : '???'}</span><span class="jt">${terrainRule(k)}</span></div>
        <div class="jm">${show ? terrainDesc(k) : `<span style="opacity:.7">${t('ui.journal.terrainUnknown')}</span>`}
          ${show ? `<br><span style="opacity:.62">${terrainFish(k)}</span>` : ''}
          ${seen ? `<br><span style="opacity:.5">${t('ui.journal.terrainCasts', { n: rec.casts, depth: fmt1(rec.depth) })}</span>` : ''}
          ${!seen && reveal ? `<br><span style="color:var(--gold)">${t('ui.journal.terrainDebug')}</span>` : ''}</div>
        ${fish.length ? `<div class="jfish">${fish.map((sp) => `<i style="color:${RARITY[sp.rarity].color}">${speciesName(sp)}</i>`).join('')}</div>` : ''}`;
      d.appendChild(info);
      grid.appendChild(d);
      drawTerrainIcon(cv, k.id, { unknown: !show });
    }
    $('journal-progress').innerHTML = t('ui.journal.terrainProgress', {
      n: known, m: TERRAIN_KINDS.length,
    }) + (reveal ? `<small style="color:var(--gold);margin-left:8px">${t('ui.journal.debugAll')}</small>` : '');
    $('journal-ach').innerHTML = t('ui.journal.terrainFootHtml');
    this.el.journal.classList.add('open');
    this.openModal = 'journal';
  }

  /* ---------------- 仕掛け（タナ） ---------------- */
  openRig() {
    // 開いた時点の狙い先の水深と時間帯で判定する（開いている間はゲームが止まる）
    this._rigSpotDepth = this.game.hudDepth > 0 ? this.game.hudDepth : null;
    this._rigBand = timeBand(this.game.state.clock);
    // 狙い先の底質と、近くの水中ストラクチャー
    const g0 = this.game;
    const at = g0.fs === 'idle' || g0.fs === 'charge' ? g0.aimPoint : g0.bobber;
    this._rigBed = at && this._rigSpotDepth ? g0.terrain.bedAt(at.x, at.z).kind : null;
    this._rigStruct = at && this._rigSpotDepth ? g0.terrain.structureNear(at.x, at.z, 4.5) : null;
    this.renderRig();
    this.el.rigWin.classList.add('open');
    this.openModal = 'rig';
  }

  renderRig() {
    const g = this.game, s = g.state;
    const spot = this._rigSpotDepth;
    const cur = g.rigLayer;
    const eff = spot != null ? g.rigDepthFor(spot, cur) : null;

    for (const el of document.querySelectorAll('#rig-col .rig-band')) {
      const L = RIG_LAYERS.find((x) => x.id === el.dataset.layer);
      el.classList.toggle('on', L.id === cur.id);
      el.querySelector('.nm').textContent = rigName(L);
      el.querySelector('.mt').textContent = rigShort(L);
    }
    $('rig-depth').textContent = spot != null ? `${fmt1(spot)} m` : '—';
    const st = this._rigStruct;
    $('rig-bed').innerHTML = this._rigBed
      ? (st
        ? t('ui.rig.withStruct', { bed: bedLabel(this._rigBed), struct: structLabel(st.kind) })
        : bedLabel(this._rigBed))
      : '—';
    const bn = g.baitCount();
    $('rig-bait').innerHTML = `${iconLabel(g.bait.icon, gearName(g.bait), 'ico gear')}`
      + `<b class="bait-n${bn <= 0 ? ' out' : bn <= 3 ? ' low' : ''}">×${bn}</b>`;
    $('rig-note').textContent = rigDesc(cur)
      + t('ui.rig.noteSuffix', { time: timeBandLabel(g.state.clock) });

    /* ここ（その水深）× この層 で食いつく魚。生息水深と遊泳層の両方で絞る。
       図鑑と同じ扱いで、未発見はまとめて「???」の数だけ見せる */
    const band = this._rigBand;
    const score = (sp) => depthFit(sp, spot, band) * swimLayer(sp, band)[cur.id];
    const here = spot == null ? [] : SPECIES
      .filter((sp) => sp.rarity > 0 && depthFit(sp, spot, band) > 0.35 && swimLayer(sp, band)[cur.id] >= 0.5)
      .sort((a, b) => score(b) - score(a));
    const known = here.filter((sp) => s.records[sp.id] || g.revealAll);
    const unknown = here.length - known.length;
    // ◎ ＝ その層にぴったり、○ ＝ まあまあ、△ ＝ 端の方（時間帯で変わる）
    const mark = (sp) => t(score(sp) >= 0.75 ? 'ui.prompt.ideal'
      : score(sp) >= 0.45 ? 'ui.prompt.fair' : 'ui.prompt.fringe');
    $('rig-fish').innerHTML = spot == null
      ? `<i class="unknown">${t('ui.rig.pickSpot')}</i>`
      : here.length
        ? known.map((sp) => `<i style="color:${RARITY[sp.rarity].color}">${speciesName(sp)} ${mark(sp)}</i>`).join('')
          + (unknown ? `<i class="unknown">${t('ui.prompt.noTargetFish', { n: unknown })}</i>` : '')
        : `<i class="unknown">${t('ui.rig.noFish')}</i>`;
  }

  openPause() {
    this.renderLakeInfo();
    this.el.pause.classList.add('open');
    this.openModal = 'pause';
  }

  closeAll() {
    for (const k of ['shop', 'journal', 'pause', 'rigWin', 'map', 'fishDetail']) this.el[k].classList.remove('open');
    if (this.openModal !== 'catch') this.openModal = null;
    this.game.audio.click();
  }

  isBlocking() { return this.openModal !== null; }
}

/* ===========================================================
   地形図鑑のサムネイル（AI 生成断面イラスト）
   未ロード時は簡易断面をフォールバック描画
   =========================================================== */
export function drawTerrainIcon(canvas, id, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const un = !!opts.unknown;
  const img = terrainIconImage(id);
  if (img && img.complete && img.naturalWidth) {
    ctx.drawImage(img, 0, 0, W, H);
    if (un) {
      ctx.fillStyle = 'rgba(12, 18, 28, 0.58)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(255,255,255,.32)';
      ctx.font = `bold ${Math.floor(H * 0.28)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', W / 2, H / 2);
    }
    return;
  }
  // フォールバック：簡易断面
  drawTerrainIconFallback(ctx, W, H, id, un);
}

function drawTerrainIconFallback(ctx, W, H, id, un) {
  const SURF = Math.floor(H * 0.18);
  ctx.fillStyle = un ? '#1a2230' : '#243447';
  ctx.fillRect(0, 0, W, SURF);
  const wg = ctx.createLinearGradient(0, SURF, 0, H);
  if (un) { wg.addColorStop(0, '#1d2836'); wg.addColorStop(1, '#151d28'); }
  else { wg.addColorStop(0, '#2f6f86'); wg.addColorStop(1, '#123043'); }
  ctx.fillStyle = wg;
  ctx.fillRect(0, SURF, W, H - SURF);
  ctx.strokeStyle = un ? 'rgba(255,255,255,.10)' : 'rgba(190,235,255,.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= W; x += 4) ctx.lineTo(x, SURF + Math.sin(x * 0.13) * 1.1);
  ctx.stroke();

  const bedCol = { sand: '#8d7c56', rock: '#6d7370', mud: '#4a463a', def: '#5d6a63' };
  const fillBed = (fn, col) => {
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 2) ctx.lineTo(x, fn(x));
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = un ? '#20262e' : col;
    ctx.fill();
  };
  const sy = H / 68; // 旧 68px 座標からのスケール
  const fDeep = () => H - 5 * sy;
  switch (id) {
    case 'shallow': fillBed((x) => (30 + Math.sin(x * 0.05) * 2) * sy, bedCol.sand); break;
    case 'midwater': fillBed((x) => (46 + Math.sin(x * 0.04) * 2.5) * sy, bedCol.def); break;
    case 'deep': fillBed(fDeep, bedCol.mud); break;
    case 'bed-sand': fillBed((x) => (44 + Math.sin(x * 0.09) * 1.6) * sy, bedCol.sand); break;
    case 'bed-rock': fillBed((x) => (46 + Math.sin(x * 0.07) * 2) * sy, bedCol.rock); break;
    case 'bed-mud': fillBed((x) => (48 + Math.sin(x * 0.03) * 1.2) * sy, bedCol.mud); break;
    case 'break': fillBed((x) => (24 + 34 / (1 + Math.exp(-(x - W * 0.48) * 0.16))) * sy, bedCol.def); break;
    case 'shelf': fillBed((x) => (x < W * 0.75 ? 32 + Math.sin(x * 0.06) * 1.2 : 32 + (x - W * 0.75) * 0.4) * sy, bedCol.sand); break;
    case 'weedbed': fillBed((x) => (40 + Math.sin(x * 0.05) * 2) * sy, '#5a6a44'); break;
    case 'hole': fillBed((x) => (26 + 34 * Math.exp(-((x - W * 0.5) ** 2) / (W * W * 0.065))) * sy, bedCol.mud); break;
    case 'edge': fillBed((x) => Math.min(H - 2, (20 + Math.max(0, x - W * 0.3) * 0.22) * sy), bedCol.sand); break;
    case 'sunkrock': fillBed((x) => (50 + Math.sin(x * 0.05) * 1.5) * sy, bedCol.rock); break;
    case 'snag': fillBed((x) => (54 + Math.sin(x * 0.05) * 1.5) * sy, bedCol.def); break;
    case 'dock': fillBed((x) => (52 + Math.sin(x * 0.05) * 1.5) * sy, bedCol.def); break;
    default: fillBed(() => H * 0.72, bedCol.def); break;
  }
  if (un) {
    ctx.fillStyle = 'rgba(255,255,255,.30)';
    ctx.font = `bold ${Math.floor(H * 0.28)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', W / 2, H / 2);
  }
}
