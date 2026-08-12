/**
 * docs/ 用スクショを現行ビルドから撮り直す
 */
import { chromium } from '/tmp/pw-shot/node_modules/playwright/index.mjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const BASE = process.env.SHOT_URL || 'http://127.0.0.1:8765/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(page) {
  await page.waitForFunction(() => !!(window.__game && window.__game.terrain && window.__game.ui), null, {
    timeout: 180000,
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('loading');
    return el && (el.classList.contains('done') || el.style.display === 'none');
  }, null, { timeout: 180000 });
  await sleep(400);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(DOCS, name), type: 'png' });
  console.log('wrote', name);
}

async function tick(page, n = 20) {
  for (let i = 0; i < n; i++) {
    await page.evaluate(() => window.__game.update(1 / 30));
    await sleep(16);
  }
}

async function clearToasts(page) {
  await page.evaluate(() => {
    const t = document.getElementById('toasts');
    if (t) t.innerHTML = '';
  });
}

/** 桟橋の先端寄りに立ち、沖を向く */
async function placeOnDock(page, { back = 1.8, pitch = -0.22 } = {}) {
  await page.evaluate(({ back, pitch }) => {
    const g = window.__game;
    const end = g.terrain.dockEnd;
    const dir = g.terrain.dockDir;
    g.pos.set(end.x - dir.x * back, 0, end.z - dir.z * back);
    g.yaw = Math.atan2(dir.x, dir.z);
    g.pitch = pitch;
    g._setFirstPerson(true, true);
    g.state.clock = 7.2;
  }, { back, pitch });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitReady(page);
  console.log('ready');

  await page.evaluate(() => {
    const g = window.__game;
    g.state.settings.lang = 'ja';
    g.state.settings.quality = 'high';
    g.state.settings.shadow = true;
    g.applyQuality();
  });
  await page.evaluate(async () => {
    const { setLang } = await import('/src/i18n.js');
    setLang('ja');
    window.__game.ui.applyLanguage();
  });

  await page.evaluate(() => window.__game.start(true));
  await sleep(1000);
  await clearToasts(page);

  // ---- ヒーロー：山と湖を広く（俯角浅め）----
  await placeOnDock(page, { back: 3.2, pitch: -0.08 });
  await tick(page, 45);
  await clearToasts(page);
  await page.evaluate(() => {
    window.__game.ui.setPrompt('');
  });
  await shot(page, 'screenshot.png');

  // ---- 一人称：竿と狙い輪が分かる俯角 ----
  await placeOnDock(page, { back: 1.6, pitch: -0.32 });
  await tick(page, 30);
  await clearToasts(page);
  await shot(page, 'firstperson.png');

  // ---- キャスト：邪魔にならない狙い＋パワーメーター ----
  await placeOnDock(page, { back: 1.4, pitch: -0.42 });
  await page.evaluate(() => {
    const g = window.__game;
    g.fs = 'idle';
    g.retrieving = false;
    g.hookFish = null;
    g.fight = null;
    g.underwaterCam = false;
    g.castObstruction = null;
    g._updateAim(true);
    // 桟橋を避けるため少し上を向き直し、距離を短めに
    g.pitch = -0.55;
    g._updateAim(true);
    g.fs = 'charge';
    g.stateTime = 1;
    g.charge = g.targetPower ?? 0.55;
    g.chargeDir = 1;
    g.ui.showPower(true, g.charge, g.targetPower ?? 0.55);
    g.ui.setPrompt('<b>今！</b> 離せば狙い通り・静かに落ちて魚が散らない');
    g.marker.visible = true;
    g.aimMarker.visible = true;
  });
  await tick(page, 25);
  await clearToasts(page);
  // 邪魔警告が出ていたら俯角をさらに調整
  await page.evaluate(() => {
    const g = window.__game;
    if (g.castObstruction) {
      g.pitch = -0.7;
      g._updateAim(true);
      g.castObstruction = null;
      g.charge = g.targetPower ?? 0.4;
      g.ui.showPower(true, g.charge, g.targetPower ?? 0.4);
      g.ui.setPrompt('<b>今！</b> 離せば狙い通り・静かに落ちて魚が散らない');
    }
  });
  await tick(page, 15);
  await shot(page, 'cast.png');

  // ---- 水中 ----
  await placeOnDock(page, { back: 1.6, pitch: -0.25 });
  await page.evaluate(() => {
    const g = window.__game;
    g.ui.showPower(false);
    const end = g.terrain.dockEnd;
    const dir = g.terrain.dockDir;
    const x = end.x + dir.x * 12;
    const z = end.z + dir.z * 12;
    const sy = g.water.surfaceY(x, z);
    g.bobber.set(x, sy - 0.05, z);
    g.angler.bobber.visible = true;
    g.angler.setBait(g.bait.id);
    g.fs = 'wait';
    g.stateTime = 3;
    g.castAcc = 1;
    g.underwaterCam = true;
    g._setUnderwaterFx(true);
    g.uwYaw = Math.atan2(g.bobber.x - g.pos.x, g.bobber.z - g.pos.z) + 0.35;
    g.uwPitch = -0.55;
    g.uwDist = 2.2;
    let i = 0;
    for (const f of g.school.fishes) {
      if (!f.species || f.species.rarity === 0) continue;
      f.active = true;
      f.state = i === 0 ? 'approach' : 'wander';
      const a = i * 1.1;
      f.pos.set(x + Math.cos(a) * (1.4 + i * 0.6), sy - (1.2 + i * 0.5), z + Math.sin(a) * (1.4 + i * 0.6));
      if (++i >= 5) break;
    }
    g.ui.setPrompt('…<b>何かが寄ってきた</b>（Vで水中カメラ）');
  });
  await tick(page, 40);
  await clearToasts(page);
  await shot(page, 'underwater.png');

  // ---- ファイト ----
  await placeOnDock(page, { back: 1.8, pitch: -0.2 });
  await page.evaluate(() => {
    const g = window.__game;
    g.underwaterCam = false;
    g._setUnderwaterFx(false);
    const end = g.terrain.dockEnd;
    const dir = g.terrain.dockDir;
    const x = end.x + dir.x * 11;
    const z = end.z + dir.z * 11;
    const sy = g.water.surfaceY(x, z);
    g.bobber.set(x, sy, z);
    g.angler.bobber.visible = true;
    const list = g.school.fishes || [];
    const f = list.find((x) => x.species && x.species.rarity >= 2)
      || list.find((x) => x.species && x.species.rarity > 0);
    if (f) {
      f.active = true;
      f.pos.set(x, sy - 2.0, z);
      g.hookFish = f;
      g._setHook();
      if (g.fight) {
        g.fight.tension = 0.62;
        g.fight.running = true;
        g.fight.runDur = 2;
        g.fight.spin = 0.8;
        g.fight.stamina = 0.65;
        g.fight.dist = 9;
      }
      g.ui.showFight(true, {
        tension: 0.62,
        danger: 0.15,
      });
      g.ui.setPrompt('クリック/スペースを <b>押し続けて巻く</b> / 魚が走ったら <b>離す</b>');
    }
  });
  await tick(page, 30);
  await clearToasts(page);
  await shot(page, 'fight.png');

  // ---- 図鑑 ----
  await page.evaluate(async () => {
    const g = window.__game;
    g.fs = 'idle';
    g.hookFish = null;
    g.fight = null;
    g.retrieving = false;
    g.angler.bobber.visible = false;
    g.underwaterCam = false;
    g._setUnderwaterFx(false);
    g.ui.showFight(false);
    g.ui.showPower(false);
    g.ui.setPrompt('');
    const { SPECIES } = await import('/src/data.js');
    let n = 0;
    for (const sp of SPECIES) {
      if (sp.rarity === 0) continue;
      if (n++ > 20) break;
      g.state.records[sp.id] = {
        count: 1 + (n % 5),
        maxLen: +(sp.len[0] + (sp.len[1] - sp.len[0]) * 0.45).toFixed(1),
        maxWeight: 0.12 + n * 0.03,
      };
    }
    g.state.totalCaught = 56;
    g.state.achievements = ['first', 'ten', 'species10'];
    g.ui.closeAll();
    g.ui.openJournal();
  });
  await sleep(1000);
  await shot(page, 'journal.png');

  // ---- デバッグ ----
  await placeOnDock(page, { back: 2.0, pitch: -0.18 });
  await page.evaluate(() => {
    const g = window.__game;
    g.ui.closeAll();
    g.state.settings.debug = true;
    g.debug.setEnabled(true);
    g.ui.setPrompt('');
  });
  await tick(page, 30);
  await clearToasts(page);
  await shot(page, 'debug.png');

  await browser.close();
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
