#!/usr/bin/env node
import assert from 'node:assert/strict';
import { getMultiplayerOrigin, multiplayerWsUrl, multiplayerVoiceJoinUrl } from '../src/config/runtime.js';

const savedLocation = globalThis.location;
const savedDocument = globalThis.document;

function withDom({ origin = 'https://pages.example.test/lakeside-fishing', meta = '' } = {}) {
  globalThis.location = { origin: new URL(origin).origin, protocol: new URL(origin).protocol, host: new URL(origin).host };
  globalThis.document = {
    querySelector(sel) {
      if (sel.includes(META_NAME) && meta) return { content: meta };
      return null;
    },
  };
}

const META_NAME = 'lakeside-mp-origin';

try {
  delete globalThis.__LAKESIDE_MP_ORIGIN__;
  withDom({ origin: 'http://localhost:8787' });
  assert.equal(getMultiplayerOrigin(), 'http://localhost:8787');
  assert.equal(multiplayerWsUrl(), 'ws://localhost:8787/ws?room=lake-1');
  assert.equal(multiplayerVoiceJoinUrl(), 'http://localhost:8787/api/voice/join?room=lake-1');

  withDom({ origin: 'https://teitasan.github.io', meta: 'https://mp.example.workers.dev' });
  assert.equal(getMultiplayerOrigin(), 'https://mp.example.workers.dev');
  assert.equal(multiplayerWsUrl('pond-2'), 'wss://mp.example.workers.dev/ws?room=pond-2');

  globalThis.__LAKESIDE_MP_ORIGIN__ = 'mp.example.workers.dev';
  assert.equal(getMultiplayerOrigin(), 'https://mp.example.workers.dev');
} finally {
  globalThis.location = savedLocation;
  globalThis.document = savedDocument;
  delete globalThis.__LAKESIDE_MP_ORIGIN__;
}

console.log('OK runtime config: multiplayer origin resolves from meta, inject, or same-origin');
