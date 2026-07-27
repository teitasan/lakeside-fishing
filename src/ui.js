/* ===========================================================
   HUD / モーダル / 図鑑・ショップ
   =========================================================== */
import { SPECIES, RARITY, GEAR, GEAR_LABEL, ACHIEVEMENTS, valueOf } from './data.js';
import { PROFILES, BODY, profileAt } from './fish.js';
import { fmtInt, fmt1, fmt2, fmtClock, timeBandLabel, clamp01 } from './util.js';
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
      weatherName: $('weather-name'), depth: $('depth'), caught: $('caught-count'),
      prompt: $('prompt'), power: $('power-meter'), powerFill: $('power-fill'),
      powerBand: $('power-band'), powerMark: $('power-mark'),
      powerTrack: document.querySelector('.pm-track'), aim: $('aim'),
      fight: $('fight-panel'), fightName: $('fight-name'), fightSub: $('fight-sub'),
      tension: $('tension-fill'), dist: $('dist-fill'), stam: $('stam-fill'),
      danger: $('danger-flash'), biteAlert: $('bite-alert'), toasts: $('toasts'),
      loading: $('loading'), title: $('title-screen'),
      catchCard: $('catch-card'), shop: $('shop'), journal: $('journal'), pause: $('pause'),
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
    $('card-weight').textContent = `${fmt2(weight)} kg`;
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
      const stats = [];
      if (kind === 'rod') {
        stats.push(`巻取 ×${it.reel.toFixed(2)}`, `竿の力 ×${it.power.toFixed(2)}`, `集魚 ×${it.attract.toFixed(2)}`);
      } else if (kind === 'line') {
        stats.push(`強度 ×${it.cap.toFixed(2)}`);
      } else {
        stats.push(`狙う水深 ${it.depth >= 20 ? '底' : it.depth.toFixed(1) + 'm'}`,
          `アタリ ×${it.attract.toFixed(2)}`, `レア度 ×${it.rare.toFixed(2)}`);
      }
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
          <div class="jm">${rec.count} 匹 / 最大 ${fmt1(rec.maxLen)} cm<br>${fmt2(rec.maxWeight)} kg・${fmtInt(valueOf(sp, rec.maxLen))} G</div>`;
      } else if (sp.rarity === 0) {
        info.innerHTML = `
          <div class="jn"><span>???</span><span class="jr">${RARITY[0].label}</span></div>
          <div class="jm">未発見<br>&nbsp;</div>`;
      } else {
        info.innerHTML = `
          <div class="jn"><span>???</span><span class="jr">${RARITY[sp.rarity].label}</span></div>
          <div class="jm">未発見<br>水深 ${sp.depth[0]}〜${sp.depth[1]} m</div>`;
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

  openPause() {
    this.renderLakeInfo();
    this.el.pause.classList.add('open');
    this.openModal = 'pause';
  }

  closeAll() {
    for (const k of ['shop', 'journal', 'pause']) this.el[k].classList.remove('open');
    if (this.openModal !== 'catch') this.openModal = null;
    this.game.audio.click();
  }

  isBlocking() { return this.openModal !== null; }
}
