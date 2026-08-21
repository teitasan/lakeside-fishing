/* ===========================================================
   エントリポイント
   =========================================================== */
import { Game, AUTOSTART_KEY } from './game.js';
import { hasSave } from './save.js';
import { iconHtml } from './icons.js';
import { t, setLang } from './i18n.js';
import { MP_SESSION_KEY } from './network/multiplayer.js';
import { installMultiplayerRuntime } from './multiplayer/runtime.js';
import { RoomChat } from './multiplayer/chat.js';
installMultiplayerRuntime(Game);
const canvas=document.getElementById('scene'),loadingLabel=document.querySelector('#loading span');
function fatal(msg){const l=document.getElementById('loading');l.classList.remove('done');l.innerHTML=`<div style="max-width:520px;text-align:center;line-height:2;letter-spacing:0"><p style="font-size:15px;color:#ffb0b0">${msg}</p><p style="font-size:12px;opacity:.6">${t('ui.fatal.helpHtml')}</p></div>`}
function addChatHint(){const bar=document.getElementById('hint-bar');if(!bar||document.getElementById('hint-chat'))return;const el=document.createElement('span');el.id='hint-chat';el.innerHTML='<b>チャット</b> Enter';bar.appendChild(el)}
async function boot(){let mpName=null;try{mpName=sessionStorage.getItem(MP_SESSION_KEY);if(mpName)sessionStorage.removeItem(MP_SESSION_KEY)}catch(e){}let game;try{game=new Game(canvas,{multiplayer:!!mpName,playerName:mpName||''});setLang(game.state.settings.lang||'ja');window.__game=game}catch(e){console.error(e);fatal(t('ui.fatal.init',{message:e.message}));return}try{await game.build(async msg=>{loadingLabel.textContent=msg+'…';await new Promise(r=>requestAnimationFrame(()=>setTimeout(r,0)))})}catch(e){console.error(e);fatal(t('ui.fatal.build',{message:e.message}));return}game.ui.hideLoading();if(hasSave())document.getElementById('btn-continue').classList.remove('hidden');let autostart=false;try{autostart=sessionStorage.getItem(AUTOSTART_KEY)==='1';if(autostart)sessionStorage.removeItem(AUTOSTART_KEY)}catch(e){}if(mpName){game.startMultiplayer();addChatHint();const chat=new RoomChat(game.mp);game.roomChat=chat;game.mp.onChat=m=>chat.add(m);game.mp.onSystem=m=>chat.add({...m,system:true})}else if(autostart){game.start(true);game.ui.toast(t('ui.toast.newLakeToast',{icon:iconHtml('ui-map'),seed:game.state.seed}),'gold')}let last=performance.now();function frame(now){const dt=Math.min(.1,(now-last)/1000);last=now;try{game.update(dt)}catch(e){console.error(e)}requestAnimationFrame(frame)}requestAnimationFrame(frame)}boot();
