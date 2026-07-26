/* ===========================================================
   エントリポイント
   =========================================================== */
import { Game } from './game.js';
import { hasSave } from './save.js';

const canvas = document.getElementById('scene');
const loadingLabel = document.querySelector('#loading span');

function fatal(msg) {
  const l = document.getElementById('loading');
  l.classList.remove('done');
  l.innerHTML = `<div style="max-width:520px;text-align:center;line-height:2;letter-spacing:0">
    <p style="font-size:15px;color:#ffb0b0">${msg}</p>
    <p style="font-size:12px;opacity:.6">WebGL2 対応ブラウザ（Chrome / Edge / Firefox / Safari 最新版）でお試しください。<br>
    また、<code>file://</code> で直接開くと動きません。簡易サーバー経由で開いてください。</p></div>`;
}

async function boot() {
  let game;
  try {
    game = new Game(canvas);
    window.__game = game; // デバッグ用
  } catch (e) {
    console.error(e);
    fatal('初期化に失敗しました: ' + e.message);
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
    fatal('世界の生成に失敗しました: ' + e.message);
    return;
  }

  game.ui.hideLoading();
  if (hasSave()) document.getElementById('btn-continue').classList.remove('hidden');

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
