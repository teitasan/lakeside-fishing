/* ===========================================================
   デバッグ表示（当たり判定・効果音・内部状態）
   ポーズ画面のボタン、または F3 でトグル
   =========================================================== */
import * as THREE from 'three';
import { TAU, clamp01, fmt1, fmt2, fmtClock } from './util.js';

/* 音の種類ごとの色分け */
const SOUND_COLORS = {
  cast: '#ffd479', charge: '#c9a86b', splash: '#7ee0ff', bite: '#ff6b6b',
  nibble: '#ffa8c0', hookSet: '#ff9a3d', reelTick: '#9fe0a8', drag: '#e0d06b',
  snap: '#ff4444', escape: '#c48cff', catchFanfare: '#ffd479', levelUp: '#7ee0ff',
  click: '#8a97a8', buy: '#6de08a', deny: '#ff8f8f', step: '#7a6a58',
};
const SOUND_METHODS = Object.keys(SOUND_COLORS);

const _v = new THREE.Vector3();

export class Debug {
  constructor(game) {
    this.game = game;
    this.enabled = false;
    this.built = false;
    this.sounds = new Map();      // name -> { count, last, dur }
    this.recent = [];             // 直近のイベント（新しい順）
    this._acc = 0;
    this._fps = 0;
    this._frames = 0;
    this._fpsAcc = 0;
    this._buildPanel();
    this._wrapAudio();
  }

  /* ---------------- 効果音のフック ---------------- */
  _wrapAudio() {
    const a = this.game.audio;
    for (const name of SOUND_METHODS) {
      const orig = a[name];
      if (typeof orig !== 'function') continue;
      a[name] = (...args) => {
        this.noteSound(name, args);
        return orig.apply(a, args);
      };
    }
  }

  noteSound(name, args) {
    const now = performance.now();
    let e = this.sounds.get(name);
    if (!e) { e = { count: 0, last: 0, arg: '' }; this.sounds.set(name, e); }
    e.count++;
    e.last = now;
    e.arg = args && args.length && typeof args[0] === 'number' ? fmt2(args[0]) : '';
    if (name !== 'reelTick' && name !== 'step') {
      this.recent.unshift({ name, t: now, arg: e.arg });
      if (this.recent.length > 12) this.recent.pop();
    }
  }

  /* ---------------- DOM パネル ---------------- */
  _buildPanel() {
    const el = document.createElement('div');
    el.id = 'dbg';
    el.innerHTML = `
      <div class="dbg-col">
        <div class="dbg-box" id="dbg-perf"></div>
        <div class="dbg-box" id="dbg-state"></div>
        <div class="dbg-box" id="dbg-legend"></div>
      </div>
      <div class="dbg-col right">
        <div class="dbg-box" id="dbg-sound"></div>
        <div class="dbg-box" id="dbg-fish"></div>
        <div class="dbg-box" id="dbg-lake"></div>
      </div>`;
    document.getElementById('app').appendChild(el);
    this.el = el;
    this.boxes = {
      perf: el.querySelector('#dbg-perf'),
      state: el.querySelector('#dbg-state'),
      lake: el.querySelector('#dbg-lake'),
      sound: el.querySelector('#dbg-sound'),
      fish: el.querySelector('#dbg-fish'),
      legend: el.querySelector('#dbg-legend'),
    };
    this.boxes.legend.innerHTML =
      '<b>当たり判定</b><div class="dbg-lgwrap">' +
      row('#6de08a', '歩ける床') + row('#ff5a4a', '糸ブロック') +
      row('#ffb84d', '障害物') + row('#7ee0ff', '水際 h=0') +
      row('#ffe08a', '歩ける限界 −0.55') + row('#c86bff', '淵') +
      row('#6de08a', '藻場') + row('#ffffff', 'プレイヤー r0.34') +
      row('#ff4dd2', 'エサ') + '</div>'
      + '<div style="font-size:9px;opacity:.5;margin-top:3px">障害物は 48m 以内・等高線は 140m 以内のみ表示</div>';
    function row(c, t) {
      return `<span class="dbg-lg"><i style="background:${c}"></i>${t}</span>`;
    }
  }

  /* ---------------- 3D ヘルパー ---------------- */
  _build3D() {
    const g = this.game;
    const scene = g.scene;
    const t = g.terrain;
    const root = new THREE.Group();
    root.name = 'debug';
    scene.add(root);
    this.root = root;

    const lineMat = (color, opacity = 0.9) =>
      new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, fog: false });

    const yaw = Math.atan2(t._dockU.x, t._dockU.z);
    const L = t._dockLen, HW = 1.62, Y = t.dockY;
    const along = (d) => _v.set(t.dockStart.x + t._dockU.x * d, 0, t.dockStart.z + t._dockU.z * d).clone();

    /* --- 歩ける床（矩形） --- */
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(HW * 2, L),
      new THREE.MeshBasicMaterial({ color: 0x6de08a, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, fog: false })
    );
    floor.rotation.set(-Math.PI / 2, 0, 0);
    floor.rotation.y = 0;
    const fc = along(L / 2); fc.y = Y + 0.03;
    floor.position.copy(fc);
    floor.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), yaw);
    root.add(floor);
    const floorEdge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(HW * 2, L)), lineMat(0x6de08a)
    );
    floorEdge.rotation.copy(floor.rotation);
    floorEdge.position.copy(floor.position);
    root.add(floorEdge);

    /* --- 糸をブロックする箱 --- */
    this.blockBoxes = [];
    const addBox = (alongCenter, yCenter, sizeAlong, sizeY) => {
      const box = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(HW * 2, sizeY, sizeAlong)),
        lineMat(0xff5a4a, 0.85)
      );
      const c = along(alongCenter); c.y = yCenter;
      box.position.copy(c);
      box.rotation.y = yaw;
      root.add(box);
      this.blockBoxes.push(box);
    };
    addBox(L / 2, Y - 0.12, L, 0.60);          // 床（桁を含む）
    addBox(L - 1.15, Y + 0.315, 2.3, 1.47);    // 先端の手すり

    /* --- 障害物の円（近くのものだけ毎回作り直す） ---
       obstacles は 1件 4要素 [x, z, r, top] で並んでいる */
    this.obstacleCount = t.obstacles.length / 4;
    this._obsSeg = 14;
    this._obsMax = 140;
    const obsBuf = new Float32Array(this._obsMax * this._obsSeg * 2 * 3);
    const obsGeo = new THREE.BufferGeometry();
    obsGeo.setAttribute('position', new THREE.BufferAttribute(obsBuf, 3));
    obsGeo.setDrawRange(0, 0);
    this.obsLines = new THREE.LineSegments(obsGeo, lineMat(0xffb84d, 0.8));
    this.obsLines.frustumCulled = false;
    root.add(this.obsLines);
    this._obsNear = 0;

    /* --- 水際と歩ける限界の等高線（近い区間だけ描く） --- */
    const makeContour = (targetH, color) => {
      const N = 320;
      const pts = new Float32Array((N + 1) * 3);
      for (let i = 0; i <= N; i++) {
        const ang = (i / N) * TAU;
        const cx = Math.cos(ang), cz = Math.sin(ang);
        let lo = 20, hi = 260;
        for (let k = 0; k < 22; k++) {
          const mid = (lo + hi) / 2;
          if (t.heightAt(cx * mid, cz * mid) < targetH) lo = mid; else hi = mid;
        }
        const r = (lo + hi) / 2;
        pts[i * 3] = cx * r;
        pts[i * 3 + 1] = targetH + 0.08;
        pts[i * 3 + 2] = cz * r;
      }
      const buf = new Float32Array(N * 2 * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(buf, 3));
      geo.setDrawRange(0, 0);
      const mesh = new THREE.LineSegments(geo, lineMat(color, 0.55));
      mesh.frustumCulled = false;
      root.add(mesh);
      return { pts, buf, mesh, n: N };
    };
    this._contours = [makeContour(0, 0x7ee0ff), makeContour(-0.55, 0xffe08a)];

    /* --- 地形フィーチャ --- */
    const featRing = (f, color) => {
      const N = 48, arr = [];
      for (let k = 0; k < N; k++) {
        const a0 = (k / N) * TAU, a1 = ((k + 1) / N) * TAU;
        arr.push(f.x + Math.cos(a0) * f.r, 0.1, f.z + Math.sin(a0) * f.r);
        arr.push(f.x + Math.cos(a1) * f.r, 0.1, f.z + Math.sin(a1) * f.r);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
      root.add(new THREE.LineSegments(geo, lineMat(color, 0.55)));
    };
    featRing(t.hole, 0xc86bff);
    featRing(t.flat, 0x6de08a);

    /* --- プレイヤーの当たり判定 --- */
    const pr = 0.34, N = 24, parr = [];
    for (let k = 0; k < N; k++) {
      const a0 = (k / N) * TAU, a1 = ((k + 1) / N) * TAU;
      parr.push(Math.cos(a0) * pr, 0, Math.sin(a0) * pr);
      parr.push(Math.cos(a1) * pr, 0, Math.sin(a1) * pr);
    }
    const pgeo = new THREE.BufferGeometry();
    pgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(parr), 3));
    this.playerRing = new THREE.LineSegments(pgeo, lineMat(0xffffff, 0.9));
    root.add(this.playerRing);

    /* --- 魚の状態マーカー --- */
    const cap = g.school.fishes.length;
    const fgeo = new THREE.BufferGeometry();
    fgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
    fgeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
    this.fishMarks = new THREE.Points(fgeo, new THREE.PointsMaterial({
      size: 0.55, vertexColors: true, transparent: true, opacity: 0.95,
      depthTest: false, sizeAttenuation: true, fog: false,
    }));
    this.fishMarks.frustumCulled = false;
    root.add(this.fishMarks);

    /* --- 餌の位置 --- */
    this.baitMark = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff4dd2, transparent: true, opacity: 0.8, depthTest: false, fog: false })
    );
    root.add(this.baitMark);

    root.traverse((o) => { o.renderOrder = 900; });
    this.built = true;
    this._rebuildNear();
  }

  /**
   * 近くの当たり判定だけを描き直す。
   * 全部（岩・木 800個近く）を常に描くと画面が線で埋まって読めないため。
   */
  _rebuildNear() {
    const g = this.game;
    const t = g.terrain;
    const px = g.pos.x, pz = g.pos.z;

    /* 障害物：半径 48m 以内 */
    const o = t.obstacles;
    const SEG = this._obsSeg;
    const arr = this.obsLines.geometry.attributes.position.array;
    const R2 = 48 * 48;
    let n = 0;
    for (let i = 0; i < o.length && n < this._obsMax; i += 4) {
      const dx = o[i] - px, dz = o[i + 1] - pz;
      if (dx * dx + dz * dz > R2) continue;
      const ox = o[i], oz = o[i + 1], or = o[i + 2];
      const oy = Math.max(t.heightAt(ox, oz), 0) + 0.1;
      let w = n * SEG * 6;
      for (let k = 0; k < SEG; k++) {
        const a0 = (k / SEG) * TAU, a1 = ((k + 1) / SEG) * TAU;
        arr[w++] = ox + Math.cos(a0) * or; arr[w++] = oy; arr[w++] = oz + Math.sin(a0) * or;
        arr[w++] = ox + Math.cos(a1) * or; arr[w++] = oy; arr[w++] = oz + Math.sin(a1) * or;
      }
      n++;
    }
    this._obsNear = n;
    this.obsLines.geometry.setDrawRange(0, n * SEG * 2);
    this.obsLines.geometry.attributes.position.needsUpdate = true;

    /* 等高線：半径 140m 以内の区間だけ */
    const CR2 = 140 * 140;
    for (const c of this._contours) {
      const p = c.pts, b = c.buf;
      let m = 0;
      for (let i = 0; i < c.n; i++) {
        const x0 = p[i * 3], z0 = p[i * 3 + 2];
        const x1 = p[(i + 1) * 3], z1 = p[(i + 1) * 3 + 2];
        const mx = (x0 + x1) * 0.5 - px, mz = (z0 + z1) * 0.5 - pz;
        if (mx * mx + mz * mz > CR2) continue;
        b[m++] = x0; b[m++] = p[i * 3 + 1]; b[m++] = z0;
        b[m++] = x1; b[m++] = p[(i + 1) * 3 + 1]; b[m++] = z1;
      }
      c.mesh.geometry.setDrawRange(0, m / 3);
      c.mesh.geometry.attributes.position.needsUpdate = true;
    }
  }

  /* ---------------- トグル ---------------- */
  toggle() { this.setEnabled(!this.enabled); }

  setEnabled(on) {
    this.enabled = !!on;
    if (this.enabled && !this.built) this._build3D();
    if (this.root) this.root.visible = this.enabled;
    document.body.classList.toggle('debug-on', this.enabled);
    const g = this.game;
    g.state.settings.debug = this.enabled;
    g.saveState();
    if (g.ui) {
      g.ui.toast(this.enabled ? '🔧 デバッグ表示 ON（F3 で切替）' : '🔧 デバッグ表示 OFF', 'good');
      const cb = document.getElementById('opt-debug');
      if (cb) cb.checked = this.enabled;
    }
  }

  /* ---------------- 毎フレーム ---------------- */
  update(dt) {
    // FPS は常に計測（表示は ON のときだけ）
    this._frames++;
    this._fpsAcc += dt;
    if (this._fpsAcc >= 0.5) {
      this._fps = this._frames / this._fpsAcc;
      this._frames = 0;
      this._fpsAcc = 0;
    }
    if (!this.enabled) return;

    const g = this.game;

    /* --- 3D の追従 --- */
    if (this.playerRing) {
      this.playerRing.position.set(g.pos.x, g.visY + 0.05, g.pos.z);
    }
    // いま糸が何かを貫通しているか
    this.lineObstruct = null;
    if (g.fs !== 'idle') {
      const tip = g.angler.getRodTip(_v);
      this.lineObstruct = g.lineObstruction(tip, g.bobber, 0.62);
    }
    if (this.blockBoxes) {
      const hit = this.lineObstruct === 'dock';
      for (const b of this.blockBoxes) b.material.color.setHex(hit ? 0xffffff : 0xff5a4a);
    }
    if (this.baitMark) {
      const show = ['wait', 'nibble', 'bite'].includes(g.fs);
      this.baitMark.visible = show;
      if (show) this.baitMark.position.copy(g.baitPos);
    }
    if (this.fishMarks) {
      const pos = this.fishMarks.geometry.attributes.position;
      const col = this.fishMarks.geometry.attributes.color;
      let n = 0;
      for (const f of g.school.fishes) {
        if (!f.active) continue;
        pos.array[n * 3] = f.pos.x;
        pos.array[n * 3 + 1] = f.pos.y + 0.5;
        pos.array[n * 3 + 2] = f.pos.z;
        const c = STATE_COLORS[f.state] || [1, 1, 1];
        col.array[n * 3] = c[0]; col.array[n * 3 + 1] = c[1]; col.array[n * 3 + 2] = c[2];
        n++;
      }
      this.fishMarks.geometry.setDrawRange(0, n);
      pos.needsUpdate = true;
      col.needsUpdate = true;
    }

    /* --- 近くの当たり判定は 2.5Hz で作り直す --- */
    this._nearAcc = (this._nearAcc || 0) + dt;
    if (this._nearAcc > 0.4) {
      this._nearAcc = 0;
      this._rebuildNear();
    }

    /* --- パネルは 10Hz --- */
    this._acc += dt;
    if (this._acc < 0.1) return;
    this._acc = 0;
    this._renderPanel();
  }

  _renderPanel() {
    const g = this.game;
    const r = g.renderer.info.render;
    const mem = g.renderer.info.memory;
    const B = this.boxes;

    B.perf.innerHTML = `<b>PERF</b>
${kv('fps', this._fps.toFixed(1))}${kv('frame', (1000 / Math.max(1, this._fps)).toFixed(1) + ' ms')}
${kv('draw calls', r.calls)}${kv('triangles', r.triangles.toLocaleString())}
${kv('geometries', mem.geometries)}${kv('textures', mem.textures)}
${kv('pixelRatio', g.renderer.getPixelRatio().toFixed(2))}${kv('quality', g.state.settings.quality)}`;

    const t = g.terrain;
    const gh = t.heightAt(g.pos.x, g.pos.z);
    const onDock = t.onDock(g.pos.x, g.pos.z);
    const F = g.fight;
    B.state.innerHTML = `<b>PLAYER / FISHING</b>
${kv('pos', `${g.pos.x.toFixed(1)}, ${g.pos.z.toFixed(1)}`)}${kv('visY', fmt2(g.visY))}
${kv('ground h', fmt2(gh))}${kv('slope', fmt2(t.slopeAt(g.pos.x, g.pos.z)))}
${kv('onDock', onDock !== null ? 'yes (' + fmt2(onDock) + ')' : 'no')}${kv('blocked', t.blockedAt(g.pos.x, g.pos.z, 0.34) ? '<span class="bad">YES</span>' : 'no')}
${kv('dock local', (() => { const p = t._dockLocal(g.pos.x, g.pos.z); return `${fmt1(p.al)} / ${fmt1(p.si)}`; })())}
${kv('yaw/pitch', `${g.yaw.toFixed(2)} / ${g.pitch.toFixed(2)}`)}${kv('move', fmt2(g.moveAmt))}
<hr>${kv('state', `<b class="hl">${g.fs}</b>`)}${kv('t', fmt1(g.stateTime) + 's')}
${kv('bite in', g.fs === 'wait' ? fmt1(Math.max(0, g.biteTimer)) + 's' : '—')}${kv('approach', g.hookFish ? fmt1(g.approachT) + 's' : '—')}
${kv('depth', fmt1(g.hudDepth) + ' m')}${kv('タナ', g.rigLayer.name + ' ' + fmt1(g.hudRig) + ' m')}
${kv('charge', fmt2(g.charge))}${kv('cast dist', fmt1(g.castDist) + ' m')}
${kv('line hit', this.lineObstruct ? `<span class="bad">${this.lineObstruct}</span>` : 'clear')}${kv('cast warn', g.fs === 'charge' && g.castObstruction ? `<span class="bad">${g.castObstruction}</span>` : '—')}
${kv('hooked', g.hookFish ? `${g.hookFish.species.name} ${fmt1(g.hookFish.length)}cm` : '—')}
${F ? `${kv('dist', fmt2(F.dist))}${kv('tension', `${fmt2(F.tension)} / ${g.line.cap} (${(F.tension / g.line.cap * 100).toFixed(0)}%)`)}
${kv('stamina', fmt2(F.stamina))}${kv('pull0', fmt2(F.pull0))}
${kv('pattern', `<b class="hl">${F.pattern.id}</b>`)}${kv('sizeF', fmt2(F.sizeF))}
${kv('running', F.running ? '<span class="bad">RUN</span>' : 'no')}${kv('shake/jump', `${F.shakeOn ? '<span class="bad">SHAKE</span>' : '-'} / ${F.jumpT > 0 ? '<span class="bad">JUMP</span>' : F.jumpQueued > 0 ? fmt1(F.jumpQueued) : '-'}`)}` : ''}`;

    const S = g.lakeStats || {};
    const env = g.env;
    B.lake.innerHTML = `<b>LAKE / ENV</b>
${kv('seed', g.state.seed)}${kv('tries', g.lakeTries || 1)}
${kv('shore r0', fmt1(S.shoreR0 || 0))}${kv('dock len', fmt1(t._dockLen))}
${kv('dock tip', fmt1(S.dockTipDepth || 0) + ' m')}${kv('clearance', fmt2(S.dockClearance || 0))}
${kv('hole', `${fmt1(S.holeDepth || 0)}m @${(S.holeFromDock || 0).toFixed(0)}m`)}${kv('flat', fmt1(S.flatDepth || 0) + ' m')}
${kv('castable', `${fmt1(S.minDepth || 0)}〜${fmt1(S.maxDepth || 0)} m`)}${kv('obstacles', `${this._obsNear || 0} / ${this.obstacleCount || 0} 表示`)}
<hr>${kv('clock', fmtClock(g.state.clock))}${kv('weather', env.weather.key)}
${kv('cloud', fmt2(env.cloudiness))}${kv('rain', fmt2(env.rainIntensity))}
${kv('night', fmt2(env.nightAmount))}${kv('sun.y', fmt2(env.sunDir.y))}
${kv('fog', `${env.scene.fog.near.toFixed(0)}–${env.scene.fog.far.toFixed(0)}`)}${kv('wind', fmt2(g.water.wind))}`;

    /* --- サウンド --- */
    const now = performance.now();
    const a = g.audio;
    const list = [...this.sounds.entries()].sort((x, y) => y[1].last - x[1].last).slice(0, 10);
    B.sound.innerHTML = `<b>🔊 AUDIO</b>
${kv('ctx', a.ctx ? a.ctx.state : 'none')}${kv('se / bgm', `${fmt2(a.volume)} / ${fmt2(a.bgm)}`)}
${kv('muffle', a.ready ? a.muffle.frequency.value.toFixed(0) + ' Hz' : '—')}${kv('rain g', a.ready ? fmt2(a.rainGain.gain.value) : '—')}
${kv('night g', a.ready ? fmt2(a.nightGain.gain.value) : '—')}${kv('events', this.recent.length ? this.recent[0].name : '—')}
<div class="dbg-snd">${list.map(([name, e]) => {
      const age = (now - e.last) / 1000;
      const hot = clamp01(1 - age / 1.2);
      const c = SOUND_COLORS[name] || '#fff';
      return `<div class="dbg-s" style="opacity:${(0.35 + hot * 0.65).toFixed(2)}">
        <i style="background:${c};box-shadow:0 0 ${(hot * 8).toFixed(1)}px ${c}"></i>
        <span class="n">${name}</span>
        <span class="c">×${e.count}</span>
        <span class="t">${age < 0.15 ? 'now' : age.toFixed(1) + 's'}</span>
        <span class="bar"><b style="width:${(hot * 100).toFixed(0)}%;background:${c}"></b></span>
      </div>`;
    }).join('')}</div>`;

    /* --- 魚 --- */
    const counts = {};
    let active = 0;
    for (const f of g.school.fishes) {
      if (!f.active) continue;
      active++;
      counts[f.state] = (counts[f.state] || 0) + 1;
    }
    const near = g.school.fishes
      .filter((f) => f.active)
      .map((f) => ({ f, d: Math.hypot(f.pos.x - g.pos.x, f.pos.z - g.pos.z) }))
      .sort((x, y) => x.d - y.d).slice(0, 6);
    B.fish.innerHTML = `<b>🐟 FISH (${active}/${g.school.count})</b>
${Object.entries(counts).map(([s, n]) => `<span class="dbg-tag" style="border-color:${stateHex(s)};color:${stateHex(s)}">${s} ${n}</span>`).join(' ')}
<div class="dbg-snd">${near.map(({ f, d }) => `<div class="dbg-s">
      <i style="background:${stateHex(f.state)}"></i>
      <span class="n">${f.species.name}</span>
      <span class="c">${fmt1(f.length)}cm</span>
      <span class="t">${fmt1(d)}m</span>
      <span class="c" style="min-width:52px">y${fmt1(f.pos.y)}</span>
    </div>`).join('')}</div>`;

    function kv(k, v) {
      return `<div class="dbg-kv"><span>${k}</span><b>${v}</b></div>`;
    }
  }
}

const STATE_COLORS = {
  wander: [0.42, 0.78, 1.0],
  approach: [1.0, 0.85, 0.28],
  nibble: [1.0, 0.55, 0.2],
  hooked: [1.0, 0.25, 0.25],
  flee: [0.75, 0.45, 1.0],
  jump: [0.55, 1.0, 0.7],
  landed: [1.0, 1.0, 1.0],
  idle: [0.5, 0.5, 0.5],
};
const stateHex = (s) => {
  const c = STATE_COLORS[s] || [1, 1, 1];
  return '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
};
