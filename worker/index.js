/* Worker: multiplayer room + RealtimeKit voice (static site served separately) */
import { MultiplayerRoom } from './room/MultiplayerRoom.js';
import { verifyAccessRequest, corsHeaders, isAllowedOrigin, withCors } from './access.js';

export { MultiplayerRoom };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/voice/join') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      }
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: corsHeaders(request, env) });
      }
      if (env.ACCESS_REQUIRED === 'true' && !isAllowedOrigin(request.headers.get('Origin'), env)) {
        return new Response('Origin not allowed', { status: 403 });
      }
      const denied = await verifyAccessRequest(request, env);
      if (denied) return withCors(denied, request, env);
      const room = (url.searchParams.get('room') || 'lake-1').slice(0, 32);
      const id = env.ROOM.idFromName(room);
      const resp = await env.ROOM.get(id).fetch(request);
      return withCors(resp, request, env);
    }

    if (url.pathname === '/ws') {
      if (env.ACCESS_REQUIRED === 'true' && !isAllowedOrigin(request.headers.get('Origin'), env)) {
        return new Response('Origin not allowed', { status: 403 });
      }
      const denied = await verifyAccessRequest(request, env);
      if (denied) return denied;
      const room = (url.searchParams.get('room') || 'lake-1').slice(0, 32);
      const id = env.ROOM.idFromName(room);
      return env.ROOM.get(id).fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
