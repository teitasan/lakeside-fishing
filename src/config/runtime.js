/** Same-origin multiplayer endpoints (Worker-hosted game only). */
const DEFAULT_ROOM = 'lake-1';

export function isMultiplayerAvailable() {
  if (typeof location === 'undefined') return true;
  return !location.hostname.endsWith('.github.io');
}

export function multiplayerWsUrl(room = DEFAULT_ROOM) {
  const origin = typeof location !== 'undefined' ? location.origin : 'http://localhost';
  const u = new URL('/ws', origin);
  u.searchParams.set('room', String(room || DEFAULT_ROOM).slice(0, 32));
  const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${u.host}${u.pathname}${u.search}`;
}

export function multiplayerVoiceJoinUrl(room = DEFAULT_ROOM) {
  const origin = typeof location !== 'undefined' ? location.origin : 'http://localhost';
  const u = new URL('/api/voice/join', origin);
  u.searchParams.set('room', String(room || DEFAULT_ROOM).slice(0, 32));
  return u.toString();
}
