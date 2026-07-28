/* ===========================================================
   HUD / モーダル / 図鑑・ショップ
   =========================================================== */
import {
  SPECIES, RARITY, GEAR, GEAR_LABEL, ACHIEVEMENTS, RIG_LAYERS,
  valueOf, gearStats, swimLayer, swimLayerLabel, depthFit,
} from './data.js';
import { PROFILES, BODY, profileAt, CRUST_SHAPES } from './fish.js';
import { fmtInt, fmt1, fmtWeight, fmtClock, timeBandLabel, clamp01 } from './util.js';
import { xpForLevel } from './save.js';

const $ = (id) => document.getElementById(id);
const JUNK_EMOJI = { boot: '🥾', can: '🥫', weeds: '🌿', driftwood: '🪵' };

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
    ctx.font = `${Math.floor(H * 0.62)}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(JUNK_EMOJI[sp.id] || '🗑️', W / 2, H * 0.54);
    return;
  }

  if (CRUST_SHAPES.includes(sp.shape)) { drawCrustIcon(ctx, sp, W, H); return; }

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
  grad.addColorStop(0, sp.colors.top);
  grad.addColorStop(0.42, sp.colors.mid);
  grad.addColorStop(1, sp.colors.belly);
  ctx.fillStyle = grad;
  ctx.fill();
  if (sp.rarity >= 4) {
    ctx.strokeStyle = sp.rarity === 5 ? 'rgba(255,224,150,.95)' : 'rgba(214,170,255,.8)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  ctx.fillStyle = sp.colors.fin;

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
  ctx.fillStyle = '#fbfbf8';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(ex + er * 0.22, ey, er * 0.55, 0, Math.PI * 2);
  ctx.fillStyle = '#0e0e12';
  ctx.fill();

  // 口
  ctx.strokeStyle = 'rgba(0,0,0,.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(nose - L * 0.02, cy + bodyH * 0.02);
  ctx.lineTo(nose - L * (sp.shape === 'gar' ? 0.14 : 0.08), cy + bodyH * 0.09);
  ctx.stroke();
}

/* ---------------- 甲殻類のシルエット（エビ・ザリガニは横から、カニは正面から） ---------------- */
function drawCrustIcon(ctx, sp, W, H) {
  const c = sp.colors;
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
    for (const sg of [1, -1]) ell(cx + sg * cw * 0.34, cy + ch * 0.1, 1.9 * u, 1.9 * u, 0, '#101014');
    return;
  }

  /* エビ・ザリガニ（頭が右） */
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
  ell(nose - bl * 0.12, cy - bh * 0.38, 2.1 * u, 2.1 * u, 0, '#101014');
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
      danger: $('danger-flash'), biteAlert: $('bite-alert'), toasts: $('toasts'),
      loading: $('loading'), title: $('title-screen'),
      catchCard: $('catch-card'), shop: $('shop'), journal: $('journal'), pause: $('pause'),
      rigWin: $('rig-window'),
    };

    this._bind();
  }

  _bind() {
    const g = this.game;

    $('btn-start').addEventListener('click', () => g.start(false));
    $('btn-continue').addEventListener('click', () => g.start(true));
    $('btn-card-ok').addEventListener('click', () => g.dismissCatch());
    $('btn-resume').addEventListener('click', () => this.closeAll());
    $('btn-rest').addEventListener('click', () => g.rest());
    $('btn-rig-close').addEventListener('click', () => this.closeAll());
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
      <div><span class="k">深い淵</span><b>${fmt1(i.holeDepth)} m</b>　<span style="opacity:.7">先端から ${i.holeWhere}</span></div>
      <div><span class="k">藻場</span><b>${fmt1(i.flatDepth)} m</b>　<span style="opacity:.7">先端から ${i.flatWhere}</span></div>
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
      this.el.fightSub.textContent = d.sub || '';
      this._last.fightSub = d.sub;
    }
    this.el.tension.style.width = (clamp01(d.tension) * 100).toFixed(1) + '%';
    this.el.dist.style.width = (clamp01(d.dist) * 100).toFixed(1) + '%';
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
      this.el.weatherIcon.textContent = w.icon;
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
    const rodTxt = `${rod.icon} ${rod.name}`;
    if (this._last.rod !== rodTxt) {
      this.el.gearRod.textContent = rodTxt;
      this._last.rod = rodTxt;
    }
    const baitTxt = `${bait.icon} ${bait.name}`;
    if (this._last.bait !== baitTxt) {
      this.el.gearBait.textContent = baitTxt;
      this._last.bait = baitTxt;
    }
  }

  /* ---------------- 釣果カード ---------------- */
  showCatch(info) {
    const { sp, len, weight, value, xp, record, isNew } = info;
    const r = RARITY[sp.rarity];
    const rib = $('card-rarity');
    rib.textContent = r.label;
    rib.className = 'card-ribbon r' + sp.rarity;
    $('card-name').textContent = sp.name;
    $('card-len').textContent = `${fmt1(len)} cm`;
    $('card-weight').textContent = fmtWeight(weight);
    $('card-value').textContent = `${fmtInt(value)} G`;
    $('card-xp').textContent = `+${fmtInt(xp)}`;
    $('card-flavor').textContent = sp.flavor;
    $('card-record').classList.toggle('hidden', !record);
    $('card-new').classList.toggle('hidden', !isNew);
    drawFishIcon($('fish-icon'), sp);
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
    for (const it of list) {
      const owned = s.owned[kind].includes(it.id);
      const equipped = s.gear[kind] === it.id;
      const locked = s.level < it.level;
      const div = document.createElement('div');
      div.className = 'item' + (equipped ? ' equipped' : owned ? ' owned' : '');
      // 内部数値はマスクし、言葉だけで示す（data.js gearStats）
      const stats = gearStats(kind, it).map(([k, v]) => `${k} <b>${v}</b>`);
      div.innerHTML = `
        <div class="ic">${it.icon}</div>
        <div class="body">
          <div class="nm">${it.name}${equipped ? ' <small style="opacity:.7">（装備中）</small>' : ''}</div>
          <div class="ds">${it.desc}</div>
          <div class="stats">${stats.map((x) => `<i>${x}</i>`).join('')}</div>
        </div>
        <div class="act"></div>`;
      const act = div.querySelector('.act');
      if (equipped) {
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
    const s = this.game.state;
    const grid = $('journal-grid');
    grid.innerHTML = '';
    let known = 0, knownFish = 0, totalFish = 0;
    // レア度順、ゴミは最後
    const order = [...SPECIES].sort((a, b) =>
      (a.rarity === 0 ? 9 : a.rarity) - (b.rarity === 0 ? 9 : b.rarity) || a.len[1] - b.len[1]);
    for (const sp of order) {
      const rec = s.records[sp.id];
      if (sp.rarity > 0) totalFish++;
      if (rec) { known++; if (sp.rarity > 0) knownFish++; }
      const d = document.createElement('div');
      d.className = 'jcard r' + sp.rarity + (rec ? '' : ' unknown');
      const cv = document.createElement('canvas');
      cv.width = 200; cv.height = 68;
      d.appendChild(cv);
      const info = document.createElement('div');
      if (rec) {
        info.innerHTML = `
          <div class="jn"><span>${sp.name}</span><span class="jr" style="color:${RARITY[sp.rarity].color}">${RARITY[sp.rarity].label}</span></div>
          <div class="jm">${rec.count} 匹 / 最大 ${fmt1(rec.maxLen)} cm<br>${fmtWeight(rec.maxWeight)}・${fmtInt(valueOf(sp, rec.maxLen))} G<br><span style="opacity:.55">水深 ${sp.depth[0]}〜${sp.depth[1]} m・${swimLayerLabel(sp)}</span></div>`;
      } else if (sp.rarity === 0) {
        info.innerHTML = `
          <div class="jn"><span>???</span><span class="jr">${RARITY[0].label}</span></div>
          <div class="jm">未発見<br>&nbsp;</div>`;
      } else {
        info.innerHTML = `
          <div class="jn"><span>???</span><span class="jr">${RARITY[sp.rarity].label}</span></div>
          <div class="jm">未発見<br>水深 ${sp.depth[0]}〜${sp.depth[1]} m・${swimLayerLabel(sp)}</div>`;
      }
      d.appendChild(info);
      grid.appendChild(d);
      drawFishIcon(cv, sp, { unknown: !rec });
    }
    $('journal-progress').textContent =
      `魚 ${knownFish}/${totalFish}・その他 ${known - knownFish}/${SPECIES.length - totalFish}`;
    const got = ACHIEVEMENTS.filter((a) => s.achievements.includes(a.id));
    $('journal-ach').innerHTML =
      `<b>実績 ${got.length}/${ACHIEVEMENTS.length}</b> ` +
      ACHIEVEMENTS.map((a) => {
        const ok = s.achievements.includes(a.id);
        return `<span style="margin-left:10px;opacity:${ok ? 1 : 0.4}">${ok ? '🏅' : '▫️'} ${a.name}<small style="opacity:.6">（${a.desc}）</small></span>`;
      }).join('');
    this.el.journal.classList.add('open');
    this.openModal = 'journal';
  }

  /* ---------------- 仕掛け（タナ） ---------------- */
  openRig() {
    // 開いた時点の狙い先の水深で深さを計算する（開いている間はゲームが止まる）
    this._rigSpotDepth = this.game.hudDepth > 0 ? this.game.hudDepth : null;
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
    $('rig-note').textContent = cur.desc;

    /* ここ（その水深）× この層 で食いつく魚。生息水深と遊泳層の両方で絞る。
       図鑑と同じ扱いで、未発見はまとめて「???」の数だけ見せる */
    const here = spot == null ? [] : SPECIES
      .filter((sp) => sp.rarity > 0 && depthFit(sp, spot) > 0.35 && swimLayer(sp)[cur.id] >= 0.5)
      .sort((a, b) => (depthFit(b, spot) * swimLayer(b)[cur.id]) - (depthFit(a, spot) * swimLayer(a)[cur.id]));
    const known = here.filter((sp) => s.records[sp.id]);
    const unknown = here.length - known.length;
    $('rig-fish').innerHTML = spot == null
      ? '<i class="unknown">狙う場所を決めると出ます</i>'
      : here.length
        ? known.map((sp) => `<i style="color:${RARITY[sp.rarity].color}">${sp.name}</i>`).join('')
          + (unknown ? `<i class="unknown">??? ×${unknown}</i>` : '')
        : '<i class="unknown">この層で食う魚は居ない</i>';
  }

  openPause() {
    this.renderLakeInfo();
    this.el.pause.classList.add('open');
    this.openModal = 'pause';
  }

  closeAll() {
    for (const k of ['shop', 'journal', 'pause', 'rigWin']) this.el[k].classList.remove('open');
    if (this.openModal !== 'catch') this.openModal = null;
    this.game.audio.click();
  }

  isBlocking() { return this.openModal !== null; }
}
