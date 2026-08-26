const encoder = new TextEncoder();
const decoder = new TextDecoder();
let certCache = { at: 0, keys: [] };

function b64urlDecode(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
}

async function loadCerts(teamDomain) {
  const now = Date.now();
  if (certCache.keys.length && now - certCache.at < 3600000) return certCache.keys;
  const r = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`Access certs ${r.status}`);
  const j = await r.json();
  certCache = { at: now, keys: j.keys || [] };
  return certCache.keys;
}

async function verifyJwt(token, env) {
  const team = env.CF_ACCESS_TEAM_DOMAIN;
  const aud = env.CF_ACCESS_AUD;
  if (!team || !aud) throw new Error('Access env incomplete');

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(decoder.decode(b64urlDecode(headerB64)));
    payload = JSON.parse(decoder.decode(b64urlDecode(payloadB64)));
  } catch (e) {
    return null;
  }

  const iss = `https://${team}`;
  if (payload.iss !== iss) return null;
  if (payload.aud !== aud) return null;
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;

  const keys = await loadCerts(team);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlDecode(sigB64),
    encoder.encode(`${headerB64}.${payloadB64}`),
  );
  return ok ? payload : null;
}

export async function verifyAccessRequest(request, env) {
  if (env.ACCESS_REQUIRED !== 'true') return null;

  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return new Response('Cloudflare Access required', { status: 401 });
  }

  try {
    const identity = await verifyJwt(jwt, env);
    if (!identity) return new Response('Invalid Access token', { status: 403 });
    return null;
  } catch (e) {
    console.error('[access]', e);
    return new Response('Access verification failed', { status: 503 });
  }
}

export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!isAllowedOrigin(origin, env)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Vary': 'Origin',
  };
}

export function isAllowedOrigin(origin, env) {
  const allowed = String(env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return !!origin && allowed.includes(origin);
}

export function withCors(response, request, env) {
  const extra = corsHeaders(request, env);
  if (!Object.keys(extra).length) return response;
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
