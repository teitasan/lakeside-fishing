/* Worker: static assets + multiplayer room + RealtimeKit voice bootstrap */
import { MultiplayerRoom } from './room/MultiplayerRoom.js';
export { MultiplayerRoom };
export default {async fetch(request,env){const url=new URL(request.url);if(url.pathname==='/ws'||url.pathname==='/api/voice/join'){const room=(url.searchParams.get('room')||'lake-1').slice(0,32),id=env.ROOM.idFromName(room);return env.ROOM.get(id).fetch(request)}return env.ASSETS.fetch(request)}};
