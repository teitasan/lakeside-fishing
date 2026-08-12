/* ===========================================================
   エントリポイント
   =========================================================== */
import { Game, AUTOSTART_KEY } from './game.js';
import { hasSave } from './save.js';
import { iconHtml } from './icons.js';
import { t, setLang } from './i18n.js';

const canvas = document.getElementById('scene');
const loadingLabel = document.querySelector('#loading span');

function fatal(msg) {
  const l = document.getElementById('loading');
  l.classList.remove('done');
  l.innerHTML = `<div style="max-width:520px;text-align:center;line-height:2;letter-spacing:0">
    <p style="font-size:15px;color:#ffb0b0">${msg}</p>
    <p style="font-size:12px;opacity:.6">${t('ui.fatal.helpHtml')}</p></div>`;
}

async function boot() {
  let game;
  try {
    game = new Game(canvas);
    setLang(game.state.settings.lang || 'ja');
    window.__game = game; // デバッグ用
  } catch (e) {
    console.error(e);
    fatal(t('ui.fatal.init', { message: e.message }));
    return;
  }

  try {
    await game.build(async (msg) => {
      loadingLabel.textContent = msg + '…';
      // 描画スレッドに1フレーム譲ってローディング表示を更新する
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    });
  } catch (e) {
    console.error(e);
    fatal(t('ui.fatal.build', { message: e.message }));
    return;
  }

  game.ui.hideLoading();
  if (hasSave()) document.getElementById('btn-continue').classList.remove('hidden');

  // 湖を作り直して再読み込みした場合は、タイトルを飛ばしてそのまま再開
  let autostart = false;
  try {
    autostart = sessionStorage.getItem(AUTOSTART_KEY) === '1';
    if (autostart) sessionStorage.removeItem(AUTOSTART_KEY);
  } catch (e) { /* noop */ }
  if (autostart) {
    game.start(true);
    game.ui.toast(t('ui.toast.newLakeToast', {
      icon: iconHtml('ui-map'),
      seed: game.state.seed,
    }), 'gold');
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    try {
      game.update(dt);
    } catch (e) {
      console.error(e);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot();
