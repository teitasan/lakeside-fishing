/* ===========================================================
   Worker エントリポイント
   ------------------------------------------------------------
   - /ws          : マルチプレイの WebSocket。1 ルーム = 1 Durable Object
   - それ以外     : 静的アセット（ゲーム本体）
   =========================================================== */
import { MultiplayerRoom } from './room/MultiplayerRoom.js';

export { MultiplayerRoom };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      // 第一版はルーム 1 つ（固定名）。将来 ?room=xxx で分けられるようにしてある
      const room = (url.searchParams.get('room') || 'lake-1').slice(0, 32);
      const id = env.ROOM.idFromName(room);
      return env.ROOM.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
