/* Worker: multiplayer room + RealtimeKit voice (static site served separately) */
import { MultiplayerRoom } from './room/MultiplayerRoom.js';
import { corsHeaders, isAllowedOrigin, withCors } from './cors.js';

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
      const origin = request.headers.get('Origin');
      if (origin && !isAllowedOrigin(origin, env)) {
        return new Response('Origin not allowed', { status: 403, headers: corsHeaders(request, env) });
      }
      const room = (url.searchParams.get('room') || 'lake-1').slice(0, 32);
      const id = env.ROOM.idFromName(room);
      const resp = await env.ROOM.get(id).fetch(request);
      return withCors(resp, request, env);
    }

    if (url.pathname === '/ws') {
      const room = (url.searchParams.get('room') || 'lake-1').slice(0, 32);
      const id = env.ROOM.idFromName(room);
      return env.ROOM.get(id).fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
