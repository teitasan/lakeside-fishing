/* マルチプレイのプロトコル疎通テスト（Node から 2 クライアントで接続する）
   使い方: node --experimental-websocket scripts/mp-protocol-test.mjs [URL]
   ゲーム本体とは独立。wrangler dev かデプロイ先の /ws に対して流す */

const URL_WS = process.argv[2] || 'ws://localhost:8787/ws';
const PROTO = 1;

const fail = (msg) => { console.error(`NG: ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`OK: ${msg}`);

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_WS);
    const queue = [];
    const waiters = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      const w = waiters.shift();
      if (w) w(m); else queue.push(m);
    };
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'join', v: PROTO, name }));
      resolve({
        ws,
        next: (timeoutMs = 4000) => new Promise((res, rej) => {
          if (queue.length) return res(queue.shift());
          const timer = setTimeout(() => rej(new Error(`timeout waiting for message (${name})`)), timeoutMs);
          waiters.push((m) => { clearTimeout(timer); res(m); });
        }),
        send: (obj) => ws.send(JSON.stringify(obj)),
      });
    };
    ws.onerror = (e) => reject(new Error(`connect failed: ${e.message || e}`));
  });
}

const a = await connect('Alice');
const welcomeA = await a.next();
if (welcomeA.t !== 'welcome') fail(`Alice: welcome ではなく ${welcomeA.t}`);
if (typeof welcomeA.clock !== 'number') fail('Alice: welcome に clock が無い');
ok(`Alice joined (id=${welcomeA.id}, clock=${welcomeA.clock.toFixed(2)}h, players=${welcomeA.players.length})`);

// Alice が位置を送っておく（Bob の welcome スナップショットに入るはず）
a.send({ t: 's', x: 10.5, y: 1.2, z: -3.25, yaw: 0.5, a: 'walk' });
await new Promise((r) => setTimeout(r, 300));

const b = await connect('ボブ');
const welcomeB = await b.next();
if (welcomeB.t !== 'welcome') fail(`Bob: welcome ではなく ${welcomeB.t}`);
const aliceInSnapshot = welcomeB.players.find((p) => p.id === welcomeA.id);
if (!aliceInSnapshot) fail('Bob: welcome のスナップショットに Alice が居ない');
if (aliceInSnapshot.x !== 10.5 || aliceInSnapshot.z !== -3.25) {
  fail(`Bob: Alice の位置が違う (${aliceInSnapshot.x}, ${aliceInSnapshot.z})`);
}
ok(`Bob joined。welcome に Alice の位置入りスナップショットあり (${aliceInSnapshot.x}, ${aliceInSnapshot.z})`);

const joinMsg = await a.next();
if (joinMsg.t !== 'join' || joinMsg.name !== 'ボブ') fail(`Alice: Bob の join が来ない (${JSON.stringify(joinMsg)})`);
ok('Alice に Bob の join が届いた（日本語の名前も通る）');

// 状態のリレー
a.send({ t: 's', x: 12, y: 1.2, z: -3, yaw: 1.0, a: 'run' });
const stateMsg = await b.next();
if (stateMsg.t !== 's' || stateMsg.id !== welcomeA.id || stateMsg.x !== 12 || stateMsg.a !== 'run') {
  fail(`Bob: Alice の状態リレーが違う (${JSON.stringify(stateMsg)})`);
}
ok('Alice → Server → Bob の状態リレーが 1 往復で届いた');

// 不正な座標は捨てられる（何も届かないこと）
a.send({ t: 's', x: 99999, y: 0, z: 0, yaw: 0, a: 'walk' });
let dropped = true;
try { await b.next(800); dropped = false; } catch (e) { /* timeout = 正しい */ }
if (!dropped) fail('Bob: 湖の外の座標が捨てられていない');
ok('範囲外の座標はサーバーで捨てられた');

// 退室通知
b.ws.close();
const leaveMsg = await a.next();
if (leaveMsg.t !== 'leave' || leaveMsg.id !== welcomeB.id) fail(`Alice: Bob の leave が来ない (${JSON.stringify(leaveMsg)})`);
ok('Alice に Bob の leave が届いた');

// バージョン不一致は拒否される
const badWs = new WebSocket(URL_WS);
const badResult = await new Promise((resolve) => {
  badWs.onopen = () => badWs.send(JSON.stringify({ t: 'join', v: 999, name: 'Old' }));
  badWs.onmessage = (ev) => resolve(JSON.parse(ev.data));
  setTimeout(() => resolve(null), 4000);
});
if (!badResult || badResult.t !== 'error' || badResult.code !== 'version') {
  fail(`古いプロトコルが拒否されない (${JSON.stringify(badResult)})`);
}
ok('プロトコルのバージョン不一致は error で拒否された');

a.ws.close();
console.log('\nすべてのプロトコルテストに合格');
process.exit(0);
