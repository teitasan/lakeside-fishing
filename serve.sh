#!/usr/bin/env bash
# 湖畔のフィッシング — ローカルサーバー起動
set -e
PORT="${1:-8000}"
cd "$(dirname "$0")"
echo "→ http://localhost:${PORT} をブラウザで開いてください（Ctrl+C で終了）"
if command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "$PORT"
elif command -v npx >/dev/null 2>&1; then
  exec npx --yes serve -l "$PORT" .
else
  echo "python3 も npx も見つかりません。任意の静的サーバーでこのフォルダを配信してください。" >&2
  exit 1
fi
