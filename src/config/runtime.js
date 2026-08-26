/** Multiplayer Worker origin — same-origin when unset (local wrangler dev). */
const META = 'lakeside-mp-origin';
const DEFAULT_ROOM = 'lake-1';

function normalizeOrigin(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s.includes('://') ? s : `https://${s}`);
    return u.origin;
  } catch (e) {
    return '';
  }
}

export function getMultiplayerOrigin() {
  const injected = typeof globalThis.__LAKESIDE_MP_ORIGIN__ === 'string'
    ? globalThis.__LAKESIDE_MP_ORIGIN__
    : '';
  const fromInjected = normalizeOrigin(injected);
  if (fromInjected) return fromInjected;

  const meta = typeof document !== 'undefined'
    ? document.querySelector(`meta[name="${META}"]`)
    : null;
  const fromMeta = normalizeOrigin(meta?.content);
  if (fromMeta) return fromMeta;

  return typeof location !== 'undefined' ? location.origin : '';
}

export function multiplayerWsUrl(room = DEFAULT_ROOM) {
  const origin = getMultiplayerOrigin();
  const u = new URL('/ws', origin);
  u.searchParams.set('room', String(room || DEFAULT_ROOM).slice(0, 32));
  const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${u.host}${u.pathname}${u.search}`;
}

export function multiplayerVoiceJoinUrl(room = DEFAULT_ROOM) {
  const origin = getMultiplayerOrigin();
  const u = new URL('/api/voice/join', origin);
  u.searchParams.set('room', String(room || DEFAULT_ROOM).slice(0, 32));
  return u.toString();
}

export function isCrossOriginMultiplayer() {
  if (typeof location === 'undefined') return false;
  return getMultiplayerOrigin() !== location.origin;
}
