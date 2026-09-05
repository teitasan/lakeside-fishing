# 水・小物のテクスチャ生成プロンプト

[`land-texture-prompts.md`](./land-texture-prompts.md) の続き。あちらは «陸に
テクスチャが無い» 穴を埋めるものだった。ここで埋めるのは、**手続き生成でしか
作れていない／単色のままの面**。

方針はあちらと同じ。

> 画像生成に法線マップを描かせても使いものにならない。ベースカラーだけ作って、
> 残りはリポジトリ側で焼く。

## 生成が要らないもの（先に潰す）

| 場所 | いまの状態 | やること |
|---|---|---|
| 桟橋の板・杭 | `dock-plank/piling.webp` 1024² **アルベドのみ**、`roughness` は定数 | 既存アルベドの輝度から法線・AO・粗さを焼く（[`bakeLandDetailMaps()`](../src/tileableNoise.js) がそのまま使える）。**新規生成は不要** |
| 陸・湖底の凹凸 | すでに 3 系統の法線＋視差マッピング | 手を入れない |

つまり画像を作ってもらう必要があるのは以下だけ。

## 一覧

| 優先 | ファイル | 置き換える先 | 解像度 | α | 実寸 |
|---|---|---|---|---|---|
| **A** | `foam.webp` | water.js の泡（`fbm2`+`vnoise`×2 の手続き） | 1024 | 不要 | 30cm |
| **A** | `rock-albedo.webp` | `makeRockTexture(256)` | 1024 | 不要 | 50cm |
| **A** | `rock-moss.webp` | `makeMossTexture(256)` | 1024 | 不要 | 50cm |
| **A** | `splash.webp` | water.js の 32² 放射グラデ | 512（2×2） | **必要** | — |
| **B** | `leaf-beech.webp` | `makeLeafTexture('beech')` | 1024（2×2） | **必要** | 60cm/枚 |
| **B** | `leaf-cedar.webp` | `makeLeafTexture('cedar')` | 1024（2×2） | **必要** | 60cm/枚 |
| **B** | `bed-grain.webp` | （新規。湖底アルベドの細目） | 1024 | 不要 | 1.8m |
| **B** | `piling-algae.webp` | （新規。杭の水際） | 512 | 不要 | 30cm |
| **C** | `rain-ring.webp` | water.js の解析リング | 512（4×4） | **必要** | — |

---

## 共通ルール

### 地面・表面タイル用（foam / rock / bed / algae）

```
Seamless tileable texture, orthographic view straight at the surface,
completely flat and even ambient lighting, no cast shadows, no directional sunlight,
no highlights, no specular, no vignette, no depth of field, no perspective distortion.
Albedo / base color only — the lighting is done by the renderer.
The whole image covers exactly a {N} x {N} patch of the real surface.
Photorealistic, natural, freshwater lake in Japan, late spring.
```

`{N}` に表の «実寸» を入れる。**この行が一番効く** —— 実寸を言わないと生成側が
勝手に接写にしたり引きにしたりする。

### アルファが要るもの（splash / leaf / rain）

背景は**純黒**（`#000000`）で、被写体だけを描く。透過 PNG が出せるならそれが
最良だが、出せない場合は**輝度をそのままアルファに使う**ので純黒必須。
グレーの背景や «白背景» は使えない。

### ネガティブ（全共通）

```
shadow, cast shadow, directional light, sunlight, highlight, specular, glare,
vignette, depth of field, blur, bokeh, perspective, tilted camera, horizon, sky,
logo, text, watermark, border, frame, seam, grid, collage, multiple panels,
HDR, oversaturated, stylized, painterly, illustration, 3d render, cgi
```

---

## A-1. `foam.webp` — 渚の泡

**いまの実装**：[`water.js`](../src/water.js) の泡は `fbm2` + `vnoise` ×2 の完全
手続き。コメントに「以前は fbm の特徴サイズが数メートルあり、泡ではなく煙に
見えていたので 5〜10 倍細かくした」と書いてあるとおり、ここは手続きノイズの限界。

**なぜ 30cm か**：シェーダの周波数がそのまま実寸を決めている。
粗いレース `3.4 cycles/m`（≒29cm）、中 `17`（≒6cm）、細 `38`（≒2.6cm）。
**1 枚に 30cm〜3cm の階層が全部入っていれば**、リップル法線と同じやり方で
1 枚を 3 スケールで叩ける（＝現行より軽くなる）。

```
Seamless tileable texture, orthographic view straight down at the water surface,
completely flat and even ambient lighting, no cast shadows, no directional sunlight,
no highlights, no specular, no vignette, no depth of field, no perspective distortion.
Albedo / base color only — the lighting is done by the renderer.
The whole image covers exactly a 30 x 30 cm patch of the real surface.
Photorealistic, natural, freshwater lake in Japan, late spring.

Sea-foam / wave foam seen from directly above: dense white froth broken into a
lace-like web, with open holes and thin torn strands where the foam has drained
away. Three clearly different scales must all be present in the same image —
large irregular openings roughly 10 to 20 cm across, clusters of small bubbles
2 to 5 cm across, and individual fine bubbles a few millimetres across packed
between them. Pure white to very pale cream foam. The gaps between the foam are
solid black. High contrast between foam and gap, but the foam itself is flat and
even in value with no shading inside the bubbles.
```

**受け取り側**：輝度を «泡の被覆率» として使う。色は水面側で付けるので白黒でよい。
グレーの中間調が «薄い泡» になるので、二値化はしないこと。

## A-2. `rock-albedo.webp` — 岩の肌

**いまの実装**：`makeRockTexture(256)` の canvas 描画。ベース `#7f7e78` の花崗岩。
[`rocks.js`](../src/rocks.js) は**トライプラナー**で世界座標に貼るので、UV の
継ぎ目は無いが、**3 段（boulder / cobble / pebble）で 0.87m / 0.38m / 0.17m の
3 スケールに同じ 1 枚を使う**。だから 50cm を狙って作れば全段でもつ。

**平均色を `#7f7e78` 付近から動かさないこと。** 濡れの暗化（×0.72）、窪みの
AO（×0.74）、苔の混ぜが全部この明るさ前提で調整されている。

```
Seamless tileable texture, orthographic view straight at the surface,
completely flat and even ambient lighting, no cast shadows, no directional sunlight,
no highlights, no specular, no vignette, no depth of field, no perspective distortion.
Albedo / base color only — the lighting is done by the renderer.
The whole image covers exactly a 50 x 50 cm patch of the real surface.
Photorealistic, natural, freshwater lake in Japan, late spring.

The surface of a grey granite boulder from a lake shore, coarse speckled grain of
quartz, feldspar and dark mica, fine hairline fracture cracks, shallow pitting and
small chips, faint rust-brown iron staining in a few places, a thin dusting of dried
silt in the hollows. No moss, no lichen, no plants, no water. Even mid-grey overall,
average color close to #7f7e78, moderate contrast.
```

## A-3. `rock-moss.webp` — 岩の苔

`makeMossTexture(256)`（ベース `#46612c`）の置き換え。**マスクは要らない** ——
どこに苔が付くかはシェーダが法線・水面からの高さ・窪みから決めている
（`ROCK_FRAG` の `mossMask`）。ここで欲しいのは «苔が付いている面の色» だけ。
これもトライプラナーなので継ぎ目は不要だが、タイル可能なほうが安全。

```
（共通ルール、N = 50 x 50 cm）

Thick damp moss growing on stone, seen from directly above. Dense low cushion moss
in mixed greens — deep forest green, olive, a few yellow-green and dried brown
patches. Fine granular texture of individual moss shoots. Fully covering the frame,
no stone showing through, no plants standing upright, no flowers.
Average color close to #46612c, matte and damp.
```

## A-4. `splash.webp` — 飛沫

**いまの実装**：[`water.js:924`](../src/water.js:924) の **32×32** 放射グラデ 1 枚。
キャストと魚とのやり取りの «音がしそうな瞬間» がこの解像度。

**2×2 のアトラスで 4 種**ください（1 セル 256、全体 512²）。パーティクルごとに
どのセルを引くかはこちら側でシェーダに属性を足します。

```
Black background, no background elements at all. Four separate cells arranged in a
2 x 2 grid, each cell exactly square, each cell containing one water splash element
centred with a small margin, the cells must not touch or overlap.
Photorealistic water, frozen high-speed photograph, completely flat and even
lighting, no cast shadows, no directional light, no lens flare, no depth of field.

Cell 1: a single round water droplet with a bright core and a soft translucent edge.
Cell 2: a small burst of 5 to 8 droplets of different sizes flying outward.
Cell 3: a wisp of fine mist and spray, soft and feathery, no distinct droplets.
Cell 4: an elongated teardrop streak, as if the droplet is moving fast.

All elements are white to very pale blue-white. Everything outside the water is
pure black #000000.
```

**受け取り側**：輝度をアルファに、色はほぼ白なのでそのまま使う。

## B-1/B-2. `leaf-beech.webp` / `leaf-cedar.webp` — 葉のカード

**いまの実装**：`makeLeafTexture(kind, 256)`、`LEAF_ATLAS = 2` の 2×2＝512²。
マテリアルは `alphaTest: 0.42` / `DoubleSide` / `vertexColors: true`。
樹種はブナとスギ（[`treeSkeleton.js`](../src/treeSkeleton.js)）。

対岸を全部埋めていて、しかも**水面に映り込む**主役なので、ここは効く。
`vertexColors` で株ごとに色を振るので、**テクスチャ側は彩度を上げすぎないこと**。

```
Black background, no background elements at all. Four separate cells arranged in a
2 x 2 grid, each cell exactly square, each cell containing one cluster of leaves
seen flat-on and filling most of the cell, the clusters must not touch or overlap.
The whole cell covers roughly a 60 x 60 cm cluster.
Photorealistic, natural, {樹種}, late spring, completely flat and even ambient
lighting, no cast shadows, no directional sunlight, no highlights, no gloss,
no depth of field. Albedo only.

{樹種ごとの記述}

Four different cluster shapes and densities. Leaves are matte, slightly dusty,
medium saturation — not glossy, not vivid. Everything that is not leaf is
pure black #000000, with a clean hard edge (this becomes the alpha channel).
```

- ブナ（`leaf-beech.webp`）の `{樹種}` = `Japanese beech (Fagus crenata)`、
  `{樹種ごとの記述}` =
  ```
  A cluster of Japanese beech leaves on thin twigs: oval leaves with wavy margins
  and clear parallel veins, arranged in flat sprays. Mixed fresh yellow-green and
  slightly older darker green, a few leaves with brown edges.
  ```
- スギ（`leaf-cedar.webp`）の `{樹種}` = `Japanese cedar (Cryptomeria japonica)`、
  `{樹種ごとの記述}` =
  ```
  A cluster of Japanese cedar foliage: dense awl-shaped needles spiralling around
  drooping branchlets, forming feathery cord-like sprays. Dark blue-green with a
  few rust-brown dead branchlets mixed in.
  ```

## B-3. `bed-grain.webp` — 湖底の細目アルベド

**いまの実装**：湖底のアルベドは `uBedScale = 1/12`（1 タイル 12m ＝ 8.5px/m）。
一方で**凹凸は `uBedDetailScale = 1/1.8`（1.8m）で細かい**。凹凸だけ細かくて
色が 12m 刻みなので、立方体モード・俯瞰・水中カメラで寄ると色だけがボケる。

これは既存の色に**乗算で重ねる**細目なので、**平均を中間グレー `#808080`
ちょうどに寄せてください**。ここがずれると湖底ぜんたいの色が変わる。

```
（共通ルール、N = 1.8 x 1.8 m、場所 = lake bed under shallow water in Japan）

Fine-grained lake bed sediment seen from directly above: damp silty sand with
scattered small pebbles 1 to 3 cm across, a few larger flat stones, thin drifts of
darker organic silt, a few waterlogged twigs and dead leaf fragments pressed into
the sand. Very low contrast, neutral grey overall with only faint warm and cool
variation, average color exactly mid-grey #808080. This is a detail layer that gets
multiplied over an existing color, so it must not carry a color cast of its own.
```

## B-4. `piling-algae.webp` — 杭の水際

**いまの実装**：無い。桟橋の杭は水に浸かっている部分も乾いた木のまま。
帯の位置はワールド Y からシェーダ側で決めるので、**帯そのものは描かないこと**
（描くと UV に依存して位置が狂う）。欲しいのは「浸かっている部分の面」だけ。

```
（共通ルール、N = 30 x 30 cm、場所 = a wooden piling below the waterline in a lake）

The submerged part of an old wooden post: dark waterlogged timber almost completely
covered in wet filamentous algae and slime — dark olive green, blackish brown and a
few paler grey-green patches, with fine hair-like algae strands all lying in one
direction. Small dark spots of encrusting growth. Matte and uniformly wet-looking.
Uniform over the whole frame, no clear waterline, no band, no gradient, no dry wood.
```

## C-1. `rain-ring.webp` — 雨粒のリング

**いまの実装**：[`water.js`](../src/water.js) の `smoothstep(0.02, 0.0, abs(d - ring*0.5))`
の解析リング 1 本。4×4＝16 コマのアトラス（1 セル 128、全体 512²）で、
1 コマ目が着弾、16 コマ目が消える直前。

```
Black background. A 4 x 4 grid of 16 cells, each cell exactly square, read left to
right then top to bottom as 16 frames of one animation. Photorealistic water,
completely flat and even lighting, no cast shadows, no directional light,
no depth of field.

Frame 1: a tiny bright impact point at the centre of the cell with a very small
crown of droplets. Frames 2 to 16: a single thin circular ripple ring expanding
outward from the centre, getting larger, thinner and fainter each frame, until it
almost fades out at the edge of the cell in frame 16. A second, much fainter inner
ring appears from frame 5 onward.

The rings are white to pale blue-white, thin and crisp. Everything else is
pure black #000000. All 16 cells are perfectly centred and the same size.
```

---

## 出力の扱い

- **形式** アルファ無しは sRGB webp。アルファが要るものは **PNG（RGBA）** で
  ください（webp のアルファでも構いませんが、PNG のほうが確実）
- **置き場所** `assets/textures/`
- **継ぎ目** タイル系（foam / rock / bed / algae）は生成後にこちらで
  [`makeSeamless()`](../scripts/process-land-textures.mjs) を通します。
  «seamless» とプロンプトに書いても実際にはまず繋がらないので、
  **生成側で頑張らなくてよい**
- **アトラス系**（splash / leaf / rain）は継ぎ目処理をしません。かわりに
  **セルが重ならず、余白が均等** であることが重要です。ここが崩れると
  隣のコマが滲んで出るので、そこだけ確認してもらえれば

## 焼く側（こちらの作業）

もらったベースカラーから、既存の [`bakeLandDetailMaps()`](../src/tileableNoise.js) で

- **Height** 輝度をタイル境界をまたいでぼかしたもの
- **Normal** その中央差分
- **Roughness** 輝度から（濡れた苔・藻は低く、乾いた岩は高く）
- **AO** 高さと、ラップ対応の箱ぼかしとの差

を焼きます。**必要なのはベースカラー（＋アルファ）だけ**です。
