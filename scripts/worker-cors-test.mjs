#!/usr/bin/env node
import assert from 'node:assert/strict';
import { corsHeaders, isAllowedOrigin, withCors } from '../worker/cors.js';

const env = { CORS_ORIGINS: 'https://teitasan.github.io,https://pages.example.test' };

assert.equal(isAllowedOrigin('https://teitasan.github.io', env), true);
assert.equal(isAllowedOrigin('https://evil.example', env), false);
assert.equal(isAllowedOrigin('', env), false);

const allowedReq = new Request('https://worker.test/api/voice/join', {
  method: 'OPTIONS',
  headers: { Origin: 'https://teitasan.github.io' },
});
const allowed = corsHeaders(allowedReq, env);
assert.equal(allowed['Access-Control-Allow-Origin'], 'https://teitasan.github.io');
assert.equal(allowed['Access-Control-Allow-Methods'], 'POST, OPTIONS');
assert.equal(allowed['Access-Control-Allow-Credentials'], undefined);

const blockedReq = new Request('https://worker.test/api/voice/join', {
  method: 'OPTIONS',
  headers: { Origin: 'https://evil.example' },
});
assert.deepEqual(corsHeaders(blockedReq, env), {});

const wrapped = withCors(new Response('ok', { status: 200 }), allowedReq, env);
assert.equal(wrapped.headers.get('Access-Control-Allow-Origin'), 'https://teitasan.github.io');

console.log('OK worker cors: allowlist and voice preflight headers');
