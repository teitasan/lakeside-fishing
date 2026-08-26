# 湖畔のフィッシング
### Lakeside Fishing

**[English](README.en.md)** | 日本語

**朝焼けの湖で、静かに糸を垂れる。**  
深場には *湖の主* が眠っているという。

### ▶ [ブラウザで遊ぶ](https://teitasan.github.io/lakeside-fishing/)

インストール不要・ブラウザだけで完結。音が出ます。PC + マウス推奨。  
**日本語 / English** 両対応（タイトル画面またはメニューから切替）。タイトルから **みんなで遊ぶ** で同じ湖に入れます（マルチプレイは Cloudflare Worker 経由・Access 認証が必要）。

![Lakeside Fishing](docs/screenshot.png)

<p>
<img src="docs/firstperson.png" width="32.5%" alt="First person">
<img src="docs/underwater.png" width="32.5%" alt="Underwater camera">
<img src="docs/journal.png" width="32.5%" alt="Journal">
</p>
<p>
<img src="docs/cast.png" width="49%" alt="Casting">
<img src="docs/fight.png" width="49%" alt="Fight">
</p>

---

## どんなゲーム？

湖畔を歩き、タナとエサを選び、キャストして待つ——静かな釣りを軸にした 3D フィッシングゲームです。

- **狙って投げる** — 見下ろすと近く、水平にすると遠く。緑の帯で離せば狙い通り
- **場所と層が命** — 浅場・深場、表層・中層・底層。魚ごとに居場所が違う
- **ファイトは竿と音で** — 張って巻く、走ったら送る。跳ね・首振りにも反応
- **図鑑と測量** — 魚と地形を集め、歩いた／投げた所だけ湖が地図になる
- **毎回ちがう湖** — シード生成。昼夜・天候で釣れる魚も変わる
- **道具を育てる** — ロッド・ライン・エサ。レベルで上位が解禁

| | |
| --- | --- |
| 魚・生きもの | 30 種 + ゴミ 4 種 |
| 装備 | ロッド 5 / ライン 9 / エサ 7 |
| 実績 | 9 |
| 視点 | 一人称・水中カメラ |
| 対応言語 | 日本語 / English |

---

## 遊び方（ひと息）

1. **マウスで狙う** → 長押しして緑の帯で離す（キャスト）
2. **`E`** でタナ（表層 / 中層 / 底層）を選ぶ
3. ウキが沈んだら **すぐにクリック**（アワセ）
4. ヒット後は **押し続けて巻く** / **離してテンションを抜く**
5. 釣果でお金と経験値。`B` でショップ、`Q` で図鑑

詳しいパラメータやシミュレータは [パラメータ解説](https://teitasan.github.io/lakeside-fishing/manual.html) へ。

---

## 操作

| | |
| --- | --- |
| 視点 | マウス（クリックでロック / Esc で解除） |
| 移動 / ダッシュ | `W` `A` `S` `D` / `Shift` |
| キャスト・アワセ・巻く | クリック or `Space` |
| タナ | `E` |
| 図鑑 / ショップ / マップ | `Q` / `B` / `M` |
| 水中カメラ | `V`（仕掛けが水中のとき） |
| 表示切替 / メニュー | `U` / `Esc` |

言語はタイトル画面またはメニューから切り替えできます。

---

## ヒント

- 水深とタナを合わせる。`E` の画面に「ここで食いつく魚」が出る
- 大物は道具不足だとラインが切れる。ライン＝強度、ロッド＝巻きと粘り
- 夜・雨・深場・高級エサ。噂の **湖の主** と **イトウ** はそこにある
- メニューの「ひと休み」で 1 時間進められる

---

## ローカルで動かす

```bash
./serve.sh
# または: python3 -m http.server 8000
```

`http://localhost:8000` を開く。`file://` では動きません。WebGL2 対応ブラウザ推奨。
**シングルプレイのみ**（静的サーバー）。マルチプレイは下記 Worker を使います。

### マルチプレイ Worker（Node.js 22 推奨）

```bash
npm install
npm run dev:mp
# または: npx wrangler dev --local --persist-to /tmp/lakeside-fishing-wrangler-state
```

`http://localhost:8787` を開き、タイトルから **みんなで遊ぶ** を選ぶ。
ローカルでは `ACCESS_REQUIRED=false` のため Cloudflare Access なしで接続できます。

```bash
node scripts/run-tests.mjs
node scripts/run-mp-protocol-test.mjs
```

---

## デプロイ構成

| 役割 | 配信先 | 内容 |
| --- | --- | --- |
| シングルプレイ | [GitHub Pages](https://teitasan.github.io/lakeside-fishing/) | 静的 HTML / JS / アセット |
| マルチプレイ | Cloudflare Worker | WebSocket `/ws`、ボイス `/api/voice/join` |

`main` への push で GitHub Pages と Worker がそれぞれ自動デプロイされます。

### GitHub Pages（静的サイト）

- ワークフロー: `.github/workflows/deploy-pages.yml`
- プロジェクトサイトのベースパス: `/lakeside-fishing/`（相対パス `./` で解決）
- リポジトリ変数 **`MP_ORIGIN`** にマルチプレイ Worker の origin（例: `https://your-worker.example.workers.dev`）を設定すると、デプロイ時に `index.html` の `<meta name="lakeside-mp-origin">` へ注入されます。ソースコードに本番 URL を直書きしません。
- 未設定の場合は同一 origin フォールバック（ローカル Worker 開発向け）。

### Cloudflare Worker（マルチプレイ専用）

- ワークフロー: `.github/workflows/deploy-cloudflare.yml`（`wrangler deploy --env production`）
- 静的アセットは配信しません。`/ws` と `/api/voice/join` のみ。

本番 Worker に設定する環境変数（`wrangler.jsonc` の `env.production.vars` またはダッシュボード）:

| 変数 | 用途 |
| --- | --- |
| `ACCESS_REQUIRED` | 本番は `true`（ローカル dev は `false`） |
| `CF_ACCESS_TEAM_DOMAIN` | Access チームドメイン（例: `yourteam.cloudflareaccess.com`） |
| `CF_ACCESS_AUD` | Access アプリケーションの AUD タグ |
| `CORS_ORIGINS` | GitHub Pages の origin（例: `https://teitasan.github.io`） |

シークレット: `REALTIMEKIT_API_TOKEN`（既存どおり `wrangler secret put`）。

### Cloudflare Access（手動設定・必須）

マルチプレイを公開する前に、Zero Trust で **同じ Access アプリケーション** が次の両方を保護していることを確認してください。

1. **`/ws`** — WebSocket アップグレード（パス: `/ws` または `/ws*`)
2. **`/api/voice/join`** — ボイス参加 API（パス: `/api/voice/join` または `/api/voice/*`)

推奨手順:

1. Cloudflare Zero Trust → **Access** → **Applications** → Self-hosted アプリを作成
2. **Application domain** に Worker のホスト名を指定
3. **Path** に `/ws` と `/api/voice/join` をカバーするルールを追加（別アプリ 2 本でも可）
4. 許可する IdP / メール / グループの **Policy** を設定
5. アプリ詳細の **Application Audience (AUD) Tag** を `CF_ACCESS_AUD` に設定
6. チームドメインを `CF_ACCESS_TEAM_DOMAIN` に設定

Worker は `Cf-Access-Jwt-Assertion` を検証します。Access 未設定のまま `ACCESS_REQUIRED=true` だと接続は 401 になります。

**GitHub Pages からのクロスオリジン接続:** プレイヤーは Worker ドメインで Access に一度サインインしている必要があります（ブラウザが Worker 向け Cookie を保持）。初回は Worker URL を開いてログインしてから、Pages 版で **みんなで遊ぶ** を選んでください。

---

## クレジット

- 釣り人・竿モデル: [Quaternius](https://quaternius.com/)（CC0）
- エンジン: Three.js（リポジトリ内に同梱・外部通信なし）
- 後処理: [postprocessing](https://github.com/pmndrs/postprocessing)（リポジトリ内に同梱）

シングルプレイ → [teitasan.github.io/lakeside-fishing](https://teitasan.github.io/lakeside-fishing/)
マルチプレイ Worker → リポジトリ変数 `MP_ORIGIN` で指定した Worker URL
