/* ===========================================================
   HUD / モーダル / 図鑑・ショップ
   =========================================================== */
import {
  SPECIES, RARITY, GEAR, GEAR_LABEL, ACHIEVEMENTS, RIG_LAYERS,
  valueOf, fightPattern, gearStats, swimLayer, depthFit, BED_LABEL,
  colorsOf, ALBINO_EYE, TERRAIN_KINDS, TERRAIN_GROUPS, SPECIES_BY_ID,
} from './data.js';
import { PROFILES, BODY, profileAt, CRUST_SHAPES } from './fish.js';
import { fmtInt, fmt1, fmtWeight, fmtClock, timeBand, timeBandLabel, clamp01, lerp as lerpN } from './util.js';
import { xpForLevel } from './save.js';
import { iconHtml, iconLabel, loadIcon, preloadIcons, JUNK_ICONS } from './icons.js';

const $ = (id) => document.getElementById(id);

/* ゲーム内の時間帯区分（dawn/day/dusk/night）に対応する短い表記 */
const TIME_SHORT = { dawn: '朝', day: '昼', dusk: '夕', night: '夜' };
const WEATHER_SHORT = { clear: '晴', cloudy: '曇', rain: '雨' };
const LAYER_SHORT = [['top', '表'], ['mid', '中'], ['bottom', '底']];

/* 図鑑詳細の段階解禁（釣った数）。デバッグ全表示時は即解禁
   サイズ・売値を先に開き、釣り判断に直結する生息水深を最後にする */
const DETAIL_UNLOCK = {
  minLen: 1,  // 最小サイズ
  maxLen: 2,  // 最大サイズ
  value: 3,   // 売値の目安
  depth: 5,   // 生息水深
};

/** 好みのキーだけ短いラベルでつなぐ（差が小さければ always） */
function preferShort(map, names, always = 'いつでも') {
  const keys = Object.keys(names);
  const vals = keys.map((k) => map[k] ?? 1);
  const hi = Math.max(...vals), lo = Math.min(...vals);
  if (hi - lo < 0.15) return always;
  return keys.filter((k) => (map[k] ?? 1) >= hi - 0.05).map((k) => names[k]).join('・');
}

/** 遊泳層を短いラベルで表示（居る層だけ） */
function swimLayerMarks(sp) {
  const L = swimLayer(sp);
  let on = LAYER_SHORT.filter(([id]) => L[id] >= 0.8);
  if (!on.length) {
    on = [LAYER_SHORT.reduce((a, x) => (L[x[0]] > L[a[0]] ? x : a))];
  }
  return on.map(([, label]) => label).join('・');
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
  const prof = PROFILES[sp.shape] || PROFILES.slim;
  const B = BODY[sp.shape] || BODY.slim;
  const pad = W * 0.08;
  const L = W - pad * 2;
  const bodyH = Math.min(H * 0.62, L * B.h * 1.18);
  const cx = pad, cy = H * 0.52;
  const nose = cx + L * 0.99;
  const tailX = cx + L * 0.16;

  // 体（上下対称の輪郭）
  ctx.beginPath();
  const N = 34;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = tailX + (nose - tailX) * t;
    const y = cy - profileAt(prof, t) * bodyH * 0.5;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  for (let i = N; i >= 0; i--) {
    const t = i / N;
    const x = tailX + (nose - tailX) * t;
    const y = cy + profileAt(prof, t) * bodyH * 0.5 * 0.92;
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, cy - bodyH * 0.5, 0, cy + bodyH * 0.5);
  grad.addColorStop(0, cols.top);
  grad.addColorStop(0.42, cols.mid);
  grad.addColorStop(1, cols.belly);
  ctx.fillStyle = grad;
  ctx.fill();
  if (sp.rarity >= 4 && !opts.albino) {
    ctx.strokeStyle = sp.rarity === 5 ? 'rgba(255,224,150,.95)' : 'rgba(214,170,255,.8)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  ctx.fillStyle = cols.fin;

  // 尾びれ
  const th = bodyH * (0.62 + B.fork * 0.55);
  ctx.beginPath();
  ctx.moveTo(tailX + 1, cy - bodyH * 0.06);
  ctx.lineTo(cx, cy - th * 0.5);
  ctx.lineTo(cx + L * 0.085, cy);
  ctx.lineTo(cx, cy + th * 0.5);
  ctx.lineTo(tailX + 1, cy + bodyH * 0.06);
  ctx.closePath();
  ctx.fill();

  // 背びれ（背中の輪郭に沿わせる）
  const dorsalAt = (t) => cy - profileAt(prof, t) * bodyH * 0.5;
  const t0 = 0.34, t1 = 0.62;
  ctx.beginPath();
  ctx.moveTo(tailX + (nose - tailX) * t0, dorsalAt(t0) + 1);
  ctx.lineTo(tailX + (nose - tailX) * ((t0 + t1) / 2), cy - bodyH * (0.5 + B.dorsal * 1.35));
  ctx.lineTo(tailX + (nose - tailX) * t1, dorsalAt(t1) + 1);
  ctx.closePath();
  ctx.fill();

  // 尻びれ
  ctx.beginPath();
  ctx.moveTo(tailX + (nose - tailX) * 0.22, cy + bodyH * 0.30);
  ctx.lineTo(tailX + (nose - tailX) * 0.30, cy + bodyH * (0.42 + B.dorsal * 0.7));
  ctx.lineTo(tailX + (nose - tailX) * 0.40, cy + bodyH * 0.33);
  ctx.closePath();
  ctx.fill();

  // 胸びれ
  ctx.beginPath();
  ctx.moveTo(tailX + (nose - tailX) * 0.70, cy + bodyH * 0.10);
  ctx.lineTo(tailX + (nose - tailX) * 0.60, cy + bodyH * 0.36);
  ctx.lineTo(tailX + (nose - tailX) * 0.72, cy + bodyH * 0.22);
  ctx.closePath();
  ctx.fill();

  // 目
  const ex = tailX + (nose - tailX) * (sp.shape === 'gar' ? 0.80 : 0.86);
  const ey = cy - bodyH * 0.15;
  const er = Math.max(1.8, bodyH * 0.05);
  ctx.beginPath();
  ctx.arc(ex, ey, er, 0, Math.PI * 2);
  ctx.fillStyle = opts.albino ? '#ffe8ea' : '#fbfbf8';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(ex + er * 0.22, ey, er * 0.55, 0, Math.PI * 2);
  ctx.fillStyle = opts.albino ? ALBINO_EYE : '#0e0e12';
  ctx.fill();

  // 口
  ctx.strokeStyle = 'rgba(0,0,0,.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(nose - L * 0.02, cy + bodyH * 0.02);
  ctx.lineTo(nose - L * (sp.shape === 'gar' ? 0.14 : 0.08), cy + bodyH * 0.09);
  ctx.stroke();

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

  if (sp.shape === 'crab') {
    /* 正面から見たカニ（横に広い甲羅・左右に脚・前にハサミ） */
    const u = Math.min(W / 78, H / 44);            // 基準寸法
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
  const u = Math.min(W / 86, H / 40);
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
      fight: $('fight-panel'), fightName: $('fight-name'), fightSub: $('fight-sub'),
      tension: $('tension-fill'), dist: $('dist-fill'), stam: $('stam-fill'),
      distNum: $('dist-num'), distMark: $('dist-mark'), map: $('map-window'),
      danger: $('danger-flash'), biteAlert: $('bite-alert'), toasts: $('toasts'),
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
      d.innerHTML = `<span class="nm">${L.name}</span><span class="mt"></span>`;
      d.addEventListener('click', () => {
        g.setRigLayer(L.id);
        this.renderRig();
        g.audio.reelTick(0.35);
      });
      col.appendChild(d);
    }
    $('btn-reset').addEventListener('click', () => {
      if (confirm('セーブデータを削除して最初からやり直しますか？')) g.resetSave();
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
      this.toast('描画品質を変更しました', 'good');
    });
    $('opt-shadow').addEventListener('change', (e) => {
      s.shadow = e.target.checked;
      g.applyQuality();
      g.saveState();
    });

    $('opt-debug').checked = !!s.debug;
    $('opt-debug').addEventListener('change', (e) => g.debug.setEnabled(e.target.checked));

    /* --- 湖（シード） --- */
    $('opt-randomlake').checked = !!s.randomLake;
    $('opt-randomlake').addEventListener('change', (e) => {
      s.randomLake = e.target.checked;
      g.saveState();
      this.toast(s.randomLake ? '次の読み込みから湖が毎回変わります' : '湖を固定しました', 'good');
    });
    $('btn-seed-random').addEventListener('click', () => {
      if (confirm('新しい湖を生成します。（お金・レベル・図鑑は引き継がれます）')) g.newRandomLake();
    });
    $('btn-seed-apply').addEventListener('click', () => {
      const v = $('opt-seed').value.trim();
      if (!v) return;
      if (String(g.state.seed) === v) { this.toast('すでにこの湖です'); return; }
      if (confirm(`シード ${v} の湖に切り替えます。`)) g.setLakeSeed(v);
    });
    $('opt-seed').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('btn-seed-apply').click();
      e.stopPropagation();
    });
  }

  /** ポーズ画面の湖情報を更新 */
  renderLakeInfo() {
    const g = this.game;
    if (!g.lakeStats) return;
    const i = g.lakeInfo();
    $('opt-seed').value = String(i.seed);
    $('lake-info').innerHTML = `
      <div><span class="k">桟橋の先</span><b>水深 ${fmt1(i.dockDepth)} m</b></div>
      <div><span class="k">深い淵</span><b>${fmt1(i.holeDepth)} m</b>　<span style="opacity:.7">先端から ${i.holeWhere}${i.holeCount > 1 ? `／ほかに ${i.holeCount - 1} か所` : ''}</span></div>
      <div><span class="k">浅い平場</span><b>${fmt1(i.flatDepth)} m</b>　<span style="opacity:.7">先端から ${i.flatWhere}${i.flatCount > 1 ? `／ほかに ${i.flatCount - 1} か所` : ''}</span></div>
      <div><span class="k">狙える水深</span><b>${fmt1(i.minDepth)} 〜 ${fmt1(i.maxDepth)} m</b></div>`;
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

  showFight(on, d = {}) {
    this.el.fight.classList.toggle('on', on);
    if (!on) return;
    this.el.fight.classList.toggle('reeling', !!d.reeling);
    if (d.name !== this._last.fightName) {
      this.el.fightName.textContent = d.name;
      this._last.fightName = d.name;
    }
    if (d.sub !== this._last.fightSub) {
      this.el.fightSub.innerHTML = d.sub || '';
      this._last.fightSub = d.sub;
    }
    this.el.tension.style.width = (clamp01(d.tension) * 100).toFixed(1) + '%';
    this.el.dist.style.width = (clamp01(d.dist) * 100).toFixed(1) + '%';
    // 残りメートルと「掛けた地点」の目印（バーの上限は掛けた距離＋余裕）
    const dm = Math.max(0, Math.round(d.distM ?? 0));
    if (dm !== this._last.distM) {
      this.el.distNum.textContent = `${dm} m`;
      this._last.distM = dm;
    }
    const hk = (clamp01(d.hookAt ?? 1) * 100).toFixed(1) + '%';
    if (hk !== this._last.hookAt) {
      this.el.distMark.style.left = hk;
      this._last.hookAt = hk;
    }
    this.el.stam.style.width = (clamp01(d.stam) * 100).toFixed(1) + '%';
    const danger = d.tension > 0.82;
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
      this.el.weatherName.textContent = w.name;
      this._last.weather = w.key;
    }
    const dep = g.hudDepth;
    const depStr = dep > 0 ? `${fmt1(dep)} m` : '—';
    if (this._last.depth !== depStr) {
      this.el.depth.textContent = depStr;
      this._last.depth = depStr;
    }
    // タナ（層の名前だけ。実際の深さは水深から自動なので出さない）
    const rigStr = g.rigLayer.name;
    if (this._last.rig !== rigStr) {
      this.el.rig.textContent = rigStr;
      this._last.rig = rigStr;
    }
    const aimStr = g.hudAim > 0 ? `${fmt1(g.hudAim)} m` : '—';
    if (this._last.aim !== aimStr) {
      this.el.aim.textContent = aimStr;
      this._last.aim = aimStr;
    }
    if (this._last.caught !== s.totalCaught) {
      this.el.caught.textContent = `${s.totalCaught} 匹`;
      this._last.caught = s.totalCaught;
    }
    const rod = GEAR.rod.find((r) => r.id === s.gear.rod);
    const bait = GEAR.bait.find((b) => b.id === s.gear.bait);
    const rodTxt = `${rod.icon}|${rod.name}`;
    if (this._last.rod !== rodTxt) {
      this.el.gearRod.innerHTML = iconLabel(rod.icon, rod.name, 'ico gear');
      this._last.rod = rodTxt;
    }
    // エサは残り個数も出す（少なくなったら色を変える）
    const n = (s.baitStock && s.baitStock[bait.id]) || 0;
    const baitTxt = `${bait.icon}|${bait.name}|${n}`;
    if (this._last.bait !== baitTxt) {
      this.el.gearBait.innerHTML = iconLabel(bait.icon, bait.name, 'ico gear')
        + `<b class="bait-n${n <= 0 ? ' out' : n <= 3 ? ' low' : ''}">×${n}</b>`;
      this._last.bait = baitTxt;
    }
  }

  /* ---------------- 釣果カード ---------------- */
  showCatch(info) {
    const { sp, len, weight, value, xp, record, isNew, albino, isNewAlbino, title } = info;
    const r = RARITY[sp.rarity];
    const rib = $('card-rarity');
    rib.textContent = r.label;
    rib.className = 'card-ribbon r' + sp.rarity;
    // 釣果カードだけ接頭詞付き（図鑑は素の名前）
    $('card-name').textContent = title
      || (albino ? `${sp.name}（アルビノ）` : sp.name);
    $('card-len').textContent = `${fmt1(len)} cm`;
    $('card-weight').textContent = fmtWeight(weight);
    $('card-value').textContent = `${fmtInt(value)} G`;
    $('card-xp').textContent = `+${fmtInt(xp)}`;
    $('card-flavor').textContent = sp.flavor;
    $('card-record').classList.toggle('hidden', !record);
    $('card-new').classList.toggle('hidden', !isNew);
    const albinoNew = $('card-albino-new');
    if (albinoNew) albinoNew.classList.toggle('hidden', !isNewAlbino);
    drawFishIcon($('fish-icon'), sp, { albino: !!albino });
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
          <div class="nm">${it.name}${isBait ? ` <b class="stock${stock <= 0 ? ' out' : stock <= 3 ? ' low' : ''}">在庫 ${stock}</b>` : ''}${equipped ? ' <small style="opacity:.7">（装備中）</small>' : ''}</div>
          <div class="ds">${it.desc}</div>
          <div class="stats">${stats.map((x) => `<i>${x}</i>`).join('')}</div>
        </div>
        <div class="act"></div>`;
      const act = div.querySelector('.act');
      if (isBait) {
        if (!locked && !equipped && stock > 0) {
          const e = document.createElement('button');
          e.className = 'btn ghost';
          e.textContent = '装備';
          e.onclick = () => { g.equip(kind, it.id); this.renderShop(); };
          act.appendChild(e);
        }
        if (locked) {
          act.innerHTML = `<span class="locked">Lv ${it.level} で解禁</span>`;
        } else {
          const b = document.createElement('button');
          b.className = 'btn ghost';
          b.innerHTML = `<small style="opacity:.7">${it.pack}個</small> <span class="price">${it.price ? fmtInt(it.price) + ' G' : '無料'}</span>`;
          b.disabled = s.money < it.price;
          b.onclick = () => { if (g.buy(kind, it.id)) this.renderShop(); };
          act.appendChild(b);
        }
      } else if (equipped) {
        act.innerHTML = '<span style="color:var(--gold);font-size:12px">装備中</span>';
      } else if (owned) {
        const b = document.createElement('button');
        b.className = 'btn ghost';
        b.textContent = '装備';
        b.onclick = () => { g.equip(kind, it.id); this.renderShop(); };
        act.appendChild(b);
      } else if (locked) {
        act.innerHTML = `<span class="locked">Lv ${it.level} で解禁</span>`;
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
      t.textContent = GEAR_LABEL[t.dataset.tab];
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
      cv.width = 200; cv.height = 68;
      art.appendChild(cv);
      const hasAlbino = !!(rec && sp.rarity > 0 && (rec.albinoCaught || reveal));
      const showAlbino = !!(hasAlbino && this.journalShowAlbino[sp.id]);
      if (hasAlbino) {
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = 'albino-badge' + (showAlbino ? ' on' : '');
        badge.textContent = 'アルビノ';
        badge.title = 'クリックでアルビノ表示を切替';
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
          <div class="jn"><span>${sp.name}</span><span class="jr" style="color:${RARITY[sp.rarity].color}">${RARITY[sp.rarity].label}</span></div>
          <div class="jm"><span class="jsz">最大 ${fmt1(rec.maxLen)} cm</span><span class="jcnt">${rec.count} 匹</span></div>`;
      } else if (rec) {
        info.innerHTML = `
          <div class="jn"><span>${sp.name}</span><span class="jr" style="color:${RARITY[sp.rarity].color}">${RARITY[sp.rarity].label}</span></div>
          <div class="jm"><span class="jsz">—</span><span class="jcnt">—</span></div>`;
      } else {
        info.innerHTML = `
          <div class="jn"><span>???</span><span class="jr" style="color:${RARITY[sp.rarity].color}">${RARITY[sp.rarity].label}</span></div>
          <div class="jm">未発見</div>`;
      }
      d.appendChild(info);
      if (rec) {
        d.classList.add('clickable');
        d.title = 'クリックで詳細';
        d.addEventListener('click', () => this.openFishDetail(sp, rec));
      }
      grid.appendChild(d);
      // デバッグ表示のときは姿も見せる（未発見のマークは文言で分かる）
      drawFishIcon(cv, sp, { unknown: !rec, albino: showAlbino });
    }
    $('journal-progress').innerHTML =
      `魚 ${knownFish}/${totalFish}・その他 ${known - knownFish}/${SPECIES.length - totalFish}`
      + (reveal ? '<small style="color:var(--gold);margin-left:8px">デバッグ：全表示</small>' : '');
    const got = ACHIEVEMENTS.filter((a) => s.achievements.includes(a.id));
    $('journal-ach').innerHTML =
      `<b>実績 ${got.length}/${ACHIEVEMENTS.length}</b> ` +
      ACHIEVEMENTS.map((a) => {
        const ok = s.achievements.includes(a.id);
        return `<span style="margin-left:10px;opacity:${ok ? 1 : 0.4};display:inline-flex;align-items:center;gap:4px">${iconHtml(ok ? 'ui-medal' : 'ui-empty', 'ico tiny')} ${a.name}<small style="opacity:.6">（${a.desc}）</small></span>`;
      }).join('');
    this.el.journal.classList.add('open');
    this.openModal = 'journal';
  }

  /* ---------------- 図鑑・魚の詳細 ---------------- */
  openFishDetail(sp, rec) {
    const r = RARITY[sp.rarity];
    const rib = $('fd-rarity');
    rib.textContent = r.label;
    rib.className = 'card-ribbon r' + sp.rarity;
    const reveal = !!(rec && rec.dbg) || !!this.game.revealAll;
    const hasAlbino = !!(rec && sp.rarity > 0 && (rec.albinoCaught || this.game.revealAll));
    const albinoView = !!(hasAlbino && this.journalShowAlbino[sp.id]);
    $('fd-name').textContent = albinoView ? `${sp.name}（アルビノ）` : sp.name;
    $('fd-flavor').textContent = sp.flavor || '';

    const [lo, hi] = sp.len;
    const vLo = valueOf(sp, lo), vHi = valueOf(sp, hi);
    const fp = fightPattern(sp);
    const caught = (rec && !rec.dbg) ? (rec.count || 0) : 0;
    const unlock = (need) => reveal || caught >= need;
    const locked = (need) =>
      `???<small style="opacity:.55;font-weight:500">（あと${need - caught}匹でアンロック）</small>`;

    $('fd-badges').innerHTML = [
      ['layer', '遊泳層', swimLayerMarks(sp)],
      ['time', '時間帯', preferShort(sp.times, TIME_SHORT)],
      ['weather', '天候', preferShort(sp.weather, WEATHER_SHORT)],
      ['fight', 'ファイト', fp.name],
    ].map(([cls, k, v]) =>
      `<span class="fd-badge ${cls}"><small>${k}</small>${v}</span>`
    ).join('');

    const rows = [
      ['釣った数', `${caught} 匹`],
      ['最大記録', caught > 0 ? `${fmt1(rec.maxLen)} cm / ${fmtWeight(rec.maxWeight)}` : '—'],
      ['最小サイズ', unlock(DETAIL_UNLOCK.minLen)
        ? `${fmt1(lo)} cm` : locked(DETAIL_UNLOCK.minLen)],
      ['最大サイズ', unlock(DETAIL_UNLOCK.maxLen)
        ? `${fmt1(hi)} cm` : locked(DETAIL_UNLOCK.maxLen)],
      ['売値の目安', unlock(DETAIL_UNLOCK.value)
        ? `${fmtInt(vLo)} 〜 ${fmtInt(vHi)} G` : locked(DETAIL_UNLOCK.value)],
      ['生息水深', unlock(DETAIL_UNLOCK.depth)
        ? `${sp.depth[0]} 〜 ${sp.depth[1]} m` : locked(DETAIL_UNLOCK.depth)],
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
    $('map-depth').textContent = d > 0 ? `${fmt1(d)} m` : '陸';
    $('map-legend').innerHTML =
      '<div><i style="background:#7ad6ce"></i>浅い　<i style="background:#122e60"></i>深い</div>'
      + '<div><i style="background:#c8b78a"></i>汀線　<i style="background:#568442"></i>陸</div>'
      + '<div><i style="background:#c86bff"></i>深い淵　<i style="background:#6de08a"></i>浅い平場</div>'
      + '<div><i style="background:#ff9a5a"></i>沈み岩 ● / 立ち枯れ ◆</div>'
      + '<div><i style="background:#ffd479"></i>桟橋　<i style="background:#ff5d5d"></i>いまの仕掛け</div>';

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
        h.textContent = TERRAIN_GROUPS[group];
        grid.appendChild(h);
      }
      const show = seen || reveal;
      const d = document.createElement('div');
      d.className = 'jcard tcard' + (show ? '' : ' unknown');
      const cv = document.createElement('canvas');
      cv.width = 200; cv.height = 68;
      d.appendChild(cv);
      const info = document.createElement('div');
      const fish = seen ? rec.fish.map((id) => SPECIES_BY_ID[id]).filter(Boolean) : [];
      info.innerHTML = `
        <div class="jn"><span>${show ? k.name : '???'}</span><span class="jt">${k.rule}</span></div>
        <div class="jm">${show ? k.desc : '<span style="opacity:.7">まだ投げていない場所</span>'}
          ${show ? `<br><span style="opacity:.62">${k.fish}</span>` : ''}
          ${seen ? `<br><span style="opacity:.5">${rec.casts} 回投げた・初めて見た水深 ${fmt1(rec.depth)} m</span>` : ''}
          ${!seen && reveal ? '<br><span style="color:var(--gold)">未発見（デバッグ表示）</span>' : ''}</div>
        ${fish.length ? `<div class="jfish">${fish.map((sp) => `<i style="color:${RARITY[sp.rarity].color}">${sp.name}</i>`).join('')}</div>` : ''}`;
      d.appendChild(info);
      grid.appendChild(d);
      drawTerrainIcon(cv, k.id, { unknown: !show });
    }
    $('journal-progress').innerHTML = `地形 ${known}/${TERRAIN_KINDS.length}`
      + (reveal ? '<small style="color:var(--gold);margin-left:8px">デバッグ：全表示</small>' : '');
    $('journal-ach').innerHTML =
      '<b>地形図鑑</b> <small style="opacity:.7">初めてそこに投げた時に登録されます。'
      + '1 回のキャストで「水深帯 ＋ 底質 ＋ 地形の特徴」がまとめて埋まることもあります。'
      + '釣れた魚はその地形に記録されます。</small>';
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
      el.querySelector('.mt').textContent = L.short;
    }
    $('rig-depth').textContent = spot != null ? `${fmt1(spot)} m` : '—';
    const st = this._rigStruct;
    $('rig-bed').innerHTML = this._rigBed
      ? `${BED_LABEL[this._rigBed]}${st ? `<span style="color:var(--gold)"> ＋${st.kind === 'rock' ? '沈み岩' : '立ち枯れ'}</span>` : ''}`
      : '—';
    const bn = g.baitCount();
    $('rig-bait').innerHTML = `${iconLabel(g.bait.icon, g.bait.name, 'ico gear')}`
      + `<b class="bait-n${bn <= 0 ? ' out' : bn <= 3 ? ' low' : ''}">×${bn}</b>`;
    $('rig-note').textContent = `${cur.desc}（いまは${timeBandLabel(g.state.clock)}）`;

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
    const mark = (sp) => (score(sp) >= 0.75 ? '◎' : score(sp) >= 0.45 ? '○' : '△');
    $('rig-fish').innerHTML = spot == null
      ? '<i class="unknown">狙う場所を決めると出ます</i>'
      : here.length
        ? known.map((sp) => `<i style="color:${RARITY[sp.rarity].color}">${sp.name} ${mark(sp)}</i>`).join('')
          + (unknown ? `<i class="unknown">??? ×${unknown}</i>` : '')
        : '<i class="unknown">この層で食う魚は居ない</i>';
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
   地形図鑑のサムネイル（断面図）
   水面と湖底の断面を描いて、その地形の特徴を一目で見せる
   =========================================================== */
export function drawTerrainIcon(canvas, id, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const un = !!opts.unknown;
  const SURF = 12;                       // 水面の y
  // 空（水面より上）
  ctx.fillStyle = un ? '#1a2230' : '#243447';
  ctx.fillRect(0, 0, W, SURF);
  // 水
  const wg = ctx.createLinearGradient(0, SURF, 0, H);
  if (un) { wg.addColorStop(0, '#1d2836'); wg.addColorStop(1, '#151d28'); }
  else { wg.addColorStop(0, '#2f6f86'); wg.addColorStop(1, '#123043'); }
  ctx.fillStyle = wg;
  ctx.fillRect(0, SURF, W, H - SURF);
  // 水面のライン
  ctx.strokeStyle = un ? 'rgba(255,255,255,.10)' : 'rgba(190,235,255,.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= W; x += 4) ctx.lineTo(x, SURF + Math.sin(x * 0.13) * 1.1);
  ctx.stroke();

  const bedCol = { sand: '#8d7c56', rock: '#6d7370', mud: '#4a463a', def: '#5d6a63' };
  /** 底の形（x → y）を塗る */
  const fillBed = (fn, col) => {
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 2) ctx.lineTo(x, fn(x));
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = un ? '#20262e' : col;
    ctx.fill();
    ctx.strokeStyle = un ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.30)';
    ctx.beginPath();
    for (let x = 0; x <= W; x += 2) ctx.lineTo(x, fn(x));
    ctx.stroke();
  };
  const rock = (x, y, r, col = '#6d7370') => {
    ctx.fillStyle = un ? '#262c34' : col;
    ctx.beginPath();
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const rr = r * (0.72 + ((i * 37) % 11) / 22);
      ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.72);
    }
    ctx.closePath();
    ctx.fill();
  };
  const weeds = (x0, x1, base, h) => {
    ctx.strokeStyle = un ? 'rgba(255,255,255,.10)' : '#4f7a3c';
    ctx.lineWidth = 1.6;
    for (let x = x0; x < x1; x += 7) {
      ctx.beginPath();
      ctx.moveTo(x, base);
      ctx.quadraticCurveTo(x + 3, base - h * 0.6, x + ((x % 3) - 1) * 4, base - h);
      ctx.stroke();
    }
  };
  const dots = (fn, col) => {
    ctx.fillStyle = un ? 'rgba(255,255,255,.05)' : col;
    for (let i = 0; i < 60; i++) {
      const x = (i * 37) % W;
      const y = fn(x) + 3 + ((i * 13) % 9);
      if (y < H) ctx.fillRect(x, y, 1.4, 1.4);
    }
  };

  const flat = (y) => () => y;
  switch (id) {
    /* --- 水深帯 --- */
    case 'shallow': { const f = (x) => 30 + Math.sin(x * 0.05) * 2; fillBed(f, bedCol.sand); dots(f, 'rgba(255,240,200,.35)'); break; }
    case 'midwater': { const f = (x) => 46 + Math.sin(x * 0.04) * 2.5; fillBed(f, bedCol.def); break; }
    case 'deep': { const f = flat(H - 5); fillBed(f, bedCol.mud); break; }
    /* --- 底質 --- */
    case 'bed-sand': { const f = (x) => 44 + Math.sin(x * 0.09) * 1.6; fillBed(f, bedCol.sand); dots(f, 'rgba(255,240,200,.45)'); break; }
    case 'bed-rock': {
      const f = (x) => 46 + Math.sin(x * 0.07) * 2;
      fillBed(f, bedCol.rock);
      for (let i = 0; i < 9; i++) rock(10 + i * 22 + ((i * 7) % 6), f(10 + i * 22) - 1, 3 + ((i * 5) % 4));
      break;
    }
    case 'bed-mud': { const f = (x) => 48 + Math.sin(x * 0.03) * 1.2; fillBed(f, bedCol.mud); dots(f, 'rgba(120,110,80,.5)'); break; }
    /* --- 地形 --- */
    case 'break': {
      const f = (x) => 24 + 34 / (1 + Math.exp(-(x - 96) * 0.16));
      fillBed(f, bedCol.def);
      ctx.strokeStyle = un ? 'rgba(255,255,255,.10)' : 'rgba(255,220,140,.7)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(96, 20); ctx.lineTo(96, H - 2); ctx.stroke();
      ctx.setLineDash([]);
      break;
    }
    case 'shelf': {
      const f = (x) => (x < 150 ? 32 + Math.sin(x * 0.06) * 1.2 : 32 + (x - 150) * 0.62);
      fillBed(f, bedCol.sand);
      dots(f, 'rgba(255,240,200,.35)');
      break;
    }
    case 'weedbed': {
      const f = (x) => 40 + Math.sin(x * 0.05) * 2;
      fillBed(f, '#5a6a44');
      weeds(6, W - 4, 40, 22);
      break;
    }
    case 'hole': {
      const f = (x) => 26 + 34 * Math.exp(-((x - 100) ** 2) / 2600);
      ctx.save();
      fillBed((x) => H - 2, bedCol.mud);
      ctx.restore();
      fillBed(f, bedCol.mud);
      break;
    }
    case 'edge': {
      const f = (x) => 58 - Math.max(0, (60 - x)) * 1.1;
      ctx.fillStyle = un ? '#20262e' : '#6a6a4a';
      ctx.beginPath(); ctx.moveTo(0, H); ctx.lineTo(0, 4); ctx.lineTo(46, 4); ctx.lineTo(62, SURF + 2);
      for (let x = 62; x <= W; x += 2) ctx.lineTo(x, Math.min(H - 2, 20 + (x - 62) * 0.22));
      ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
      weeds(6, 74, 12, 16);
      break;
    }
    /* --- ストラクチャー --- */
    case 'sunkrock': {
      const f = (x) => 50 + Math.sin(x * 0.05) * 1.5;
      fillBed(f, bedCol.rock);
      rock(88, 46, 11); rock(112, 49, 8); rock(72, 50, 7);
      break;
    }
    case 'snag': {
      const f = (x) => 54 + Math.sin(x * 0.05) * 1.5;
      fillBed(f, bedCol.def);
      ctx.strokeStyle = un ? '#2a3038' : '#5a4a36';
      ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(100, 54); ctx.lineTo(96, 22); ctx.stroke();
      ctx.lineWidth = 2.4;
      for (const [dx, dy] of [[16, -6], [-15, -4], [12, 8]]) {
        ctx.beginPath(); ctx.moveTo(97, 30 - dy); ctx.lineTo(97 + dx, 24 - dy - 4); ctx.stroke();
      }
      break;
    }
    case 'dock': {
      const f = (x) => 52 + Math.sin(x * 0.05) * 1.5;
      fillBed(f, bedCol.def);
      ctx.fillStyle = un ? '#2a3038' : '#7a5b3c';
      ctx.fillRect(0, 2, W, 7);
      for (const px of [30, 96, 162]) ctx.fillRect(px, 9, 5, 44);
      break;
    }
    default: { fillBed(flat(50), bedCol.def); break; }
  }
  if (un) {
    ctx.fillStyle = 'rgba(255,255,255,.30)';
    ctx.font = 'bold 15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('?', W / 2, H / 2 + 5);
  }
}
