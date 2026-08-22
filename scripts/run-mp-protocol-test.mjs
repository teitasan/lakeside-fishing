#!/usr/bin/env node
/* wrangler dev を一時 persist-to で起動し mp-protocol-test を実行 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = process.env.MP_TEST_PORT || '8787';
const url = process.env.MP_TEST_WS || `ws://127.0.0.1:${port}/ws`;
const persistDir = mkdtempSync(join(tmpdir(), 'lakeside-mp-'));
const wranglerBin = join(root, 'node_modules', '.bin', 'wrangler');
const wranglerCmd = wranglerBin;

let output = '';
const child = spawn(wranglerCmd, ['dev', '--local', '--port', port, '--persist-to', persistDir], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
});

child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });

let rejectReady;
let readyCleanup = () => {};
const ready = new Promise((resolve, reject) => {
  rejectReady = reject;
  const timer = setTimeout(() => reject(new Error('wrangler dev timeout')), 90000);
  let settled = false;
  const finish = (fn, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearInterval(tick);
    fn(value);
  };
  const tick = setInterval(async () => {
    if (/Ready on|listening on|http:\/\/127\.0\.0\.1/i.test(output)) {
      finish(resolve);
      return;
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.ok) {
        finish(resolve);
      }
    } catch (e) {}
  }, 500);
  readyCleanup = () => {
    settled = true;
    clearTimeout(timer);
    clearInterval(tick);
  };
});
child.once('error', (error) => rejectReady?.(error));

let failure = null;
try {
  await ready;
  await new Promise((r) => setTimeout(r, 1500));
  const test = spawn(process.execPath, [join(root, 'scripts/mp-protocol-test.mjs'), url], {
    cwd: root,
    stdio: 'inherit',
  });
  const code = await new Promise((res) => test.on('close', res));
  if (code !== 0) throw new Error(`mp-protocol-test exit ${code}`);
} catch (e) {
  failure = e;
  console.error(`NG: ${e.message || String(e)}`);
} finally {
  readyCleanup();
  try { child.kill('SIGTERM'); } catch (e) {}
  await new Promise((r) => setTimeout(r, 500));
  try { rmSync(persistDir, { recursive: true, force: true }); } catch (e) {}
}

if (failure) process.exit(1);
console.log('OK mp-protocol-test (wrangler dev + persist-to)');
