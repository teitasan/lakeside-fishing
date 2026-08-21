/* Node 2クライアントでマルチプロトコルを検証 */
const URL_WS = process.argv[2] || 'ws://localhost:8787/ws';
const PROTO = 2;
const fail = (msg) => { console.error(`NG: ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`OK: ${msg}`);

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_WS), queue = [], waiters = [];
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const w = waiters.shift(); if (w) w(m); else queue.push(m); };
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'join', v: PROTO, name }));
      const next = (timeoutMs = 5000) => new Promise((res, rej) => {
        if (queue.length) return res(queue.shift());
        const timer = setTimeout(() => rej(new Error(`timeout ${name}`)), timeoutMs);
        waiters.push((m) => { clearTimeout(timer); res(m); });
      });
      const nextType = async (type, timeoutMs = 6000) => {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) { const m = await next(Math.max(100, end - Date.now())); if (m.t === type) return m; }
        throw new Error(`timeout ${name}:${type}`);
      };
      resolve({ ws, next, nextType, send: (o) => ws.send(JSON.stringify(o)) });
    };
    ws.onerror = () => reject(new Error(`connect failed: ${name}`));
  });
}

const a = await connect('Alice');
const wa = await a.nextType('welcome');
if (typeof wa.clock !== 'number' || !Array.isArray(wa.fish) || !wa.weather) fail('welcome world state不足');
ok('welcomeに時刻・天候・共有魚snapshotあり');
a.send({ t: 's', x: 10.5, y: 1.2, z: -3.25, yaw: 0.5, a: 'walk' });
await new Promise((r) => setTimeout(r, 250));

const b = await connect('ボブ');
const wb = await b.nextType('welcome');
const alice = wb.players.find((p) => p.id === wa.id);
if (!alice || alice.x !== 10.5) fail('参加時player snapshot不正');
await a.nextType('join');
ok('2人参加・位置snapshot・日本語名');

a.send({ t: 's', x: 12, y: 1.2, z: -3, yaw: 1, a: 'run' });
const state = await b.nextType('s');
if (state.id !== wa.id || state.x !== 12) fail('位置relay不正');
ok('位置relay');

// Aliceの餌を共有し、いずれ共有魚がapproaching/reservedになることを確認。
a.send({ t: 'bait', x: 10, y: -2, z: -3, baitType: 'worm', rigLayer: 'mid' });
let candidate = null;
const until = Date.now() + 20000;
while (Date.now() < until && !candidate) {
  const snap = await a.nextType('fish_snapshot', 3000);
  candidate = snap.fish.find((f) => f.targetBaitId === `b:${wa.id}` || f.ownerPlayerId === wa.id);
}
if (!candidate) fail('共有餌へ寄る魚が現れない');
ok(`共有魚 ${candidate.id} がAliceの餌を認識`);

// reservedまで待ち、hook排他を通す。
while (Date.now() < until && candidate.ownerPlayerId !== wa.id) {
  const snap = await a.nextType('fish_snapshot', 3000);
  candidate = snap.fish.find((f) => f.id === candidate.id) || candidate;
}
if (candidate.ownerPlayerId !== wa.id) fail('bite予約が成立しない');
a.send({ t: 'hook', fishId: candidate.id });
const hooked = await b.nextType('fish_hooked');
if (hooked.fishId !== candidate.id || hooked.playerId !== wa.id) fail('hook排他不正');
ok('bite予約→hook排他');

a.send({ t: 'fight', fishId: candidate.id, x: 8, y: -1, z: -2 });
a.send({ t: 'fight_end', fishId: candidate.id, result: 'escaped' });
const escaped = await b.nextType('fish_escaped');
if (escaped.fishId !== candidate.id) fail('escape共有不正');
ok('ファイト終了→同一fishIdを湖へ返却');

b.ws.close();
await a.nextType('leave');
ok('切断通知');
a.ws.close();
console.log('\nすべてのマルチプレイプロトコルテストに合格');
process.exit(0);
