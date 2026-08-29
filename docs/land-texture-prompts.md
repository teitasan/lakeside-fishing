# 陸のテクスチャ生成プロンプト

湖底には砂・岩・泥のタイル（`assets/textures/bed-*.webp`）があるのに、陸は
`_terrainColor()` の頂点色だけで塗られている。地形メッシュを同心円にして
`flatShading` を切った結果、その «テクスチャが無い» ことが見えるようになった。
ここで作るのはその穴を埋めるタイル。

## 何が必要か

`src/terrain.js` の `_terrainColor()` の分岐がそのまま必要なタイルの一覧になる。
目標色は、いまゲーム中で実際に出ている頂点色の平均を sRGB に直したもの。
新しいタイルはこの色を中心に振れていればよく、平均がここから外れると
これまでの見た目が変わってしまう。

| ファイル | 貼る場所 | 1 タイル | 解像度 | 目標色 |
|---|---|---|---|---|
| `land-beach.webp` | 汀線〜標高 1.1m の乾いた砂浜 | **2.0m** | 1024 | `#bcb99c` |
| `land-grass.webp` | 標高 1.1〜8m の湖畔の草地 | **3.0m** | 1024 | `#8eab73` |
| `land-forest.webp` | 標高 8m 以上の林床 | **3.0m** | 1024 | `#7f9e6e` |
| `land-rock.webp` | 傾き 0.5 超の岩肌（急斜面） | **4.0m** | 1024 | `#9e9a95` |

標高 58m 以上の雪は 400m 以遠にしか出ないので、頂点色のままでいい。

## 共通ルール（全プロンプトの先頭に付ける）

```
Seamless tileable texture, top-down orthographic view straight down at the ground,
completely flat and even ambient lighting, no cast shadows, no directional sunlight,
no highlights, no vignette, no depth of field, no perspective distortion.
Albedo / base color only — the lighting is done by the renderer.
The whole image covers exactly a {N} x {N} meter patch of real ground.
Photorealistic, natural, {場所} in Japan, late spring.
```

`{N}` に上の表のタイル寸法を入れる。**この 1 行が一番効く** —— 画像生成は
被写体の «実寸» を指定しないと、草を接写にしたり航空写真にしたりする。

### ネガティブ

```
shadow, cast shadow, directional light, sunlight, highlight, specular, glare,
vignette, depth of field, blur, bokeh, perspective, tilted camera, horizon,
sky, water, plants standing upright, single large object, logo, text, watermark,
border, frame, seam, high contrast, HDR, oversaturated, stylized, painterly
```

## プロンプト

### land-beach.webp — 砂浜（1 タイル 2.0m）

**注意**：地面の «粒» は [`makeTileablePebbleField`](../src/tileableNoise.js) が法線・
遮蔽・粗さで既に出している。このタイルが担うのは **色のムラだけ**。コントラストを
上げると粒が二重に乗ってザラザラになるので、低コントラストで作る。

```
Seamless tileable texture, top-down orthographic view straight down at the ground,
completely flat and even ambient lighting, no cast shadows, no directional sunlight,
no highlights, no vignette, no depth of field, no perspective distortion.
Albedo / base color only — the lighting is done by the renderer.
The whole image covers exactly a 2 x 2 meter patch of real ground.
Photorealistic, natural, freshwater lake shore in Japan, late spring.

Dry lake-shore sand, fine grey-beige quartz grains, sparse scattered small pebbles
2 to 4 cm across, a few bleached twigs and dried reed fragments, faint patches of
slightly darker damp sand. Very low contrast, soft and uniform overall, average
color close to #bcb99c. The surface detail comes from the renderer, so keep the
image almost flat in value.
```

### land-grass.webp — 草地（1 タイル 3.0m）

```
（共通ルール、N=3、場所 = lake shore meadow in Japan）

Short wild grass meadow seen from directly above, mixed species — fine green
blades, broader coarse grass, clover, a few dandelion rosettes. Uneven patchy
growth with small openings of bare brown soil and dried yellow-brown dead grass
between the tufts. Not a mown lawn, not turf. Average color close to #8eab73.
```

### land-forest.webp — 林床（1 タイル 3.0m）

ブナ + スギの混交林（[`treeSkeleton.js`](../src/treeSkeleton.js) の樹種）に合わせる。

```
（共通ルール、N=3、場所 = beech and cedar forest floor in Japan）

Forest floor seen from directly above, a layer of fallen beech leaves in brown
and ochre mixed with dark brown cedar needle litter, dark humus soil showing
through, scattered small twigs, patches of green moss and a few low ferns
pressed flat. Damp and matte. Average color close to #7f9e6e.
```

### land-rock.webp — 岩肌（1 タイル 4.0m）

3D の岩（[`rocks.js`](../src/rocks.js) の `makeRockTexture`、ベース `#7f7e78` の花崗岩）と
同じ石であるべきなので、**同系の灰色の花崗岩**を指定する。

```
（共通ルール、N=4、場所 = exposed bedrock on a hillside in Japan）

Exposed grey granite bedrock seen from directly above, coarse speckled
grain of quartz feldspar and dark mica, irregular fracture lines and shallow
cracks, patches of pale green-grey lichen and dark moss settled in the hollows,
thin traces of soil in the cracks. Average color close to #9e9a95.
```

## 出力の扱い

- **形式** sRGB の webp、アルファなし、1024×1024
- 置き場所 `assets/textures/`
- 読み込みは既存の `Terrain._loadRepeatTexture()` がそのまま使える
  （`RepeatWrapping` / `SRGBColorSpace` / `anisotropy 4`）

### タイル継ぎ目

画像生成はプロンプトで «seamless» と言っても実際にはまず繋がらない。
生成後に半分ずらして継ぎ目を消す処理が要る。判定は
[`scripts/ground-grain-test.mjs`](../scripts/ground-grain-test.mjs) と同じで、
**左端と右端の差が、隣り合うテクセルどうしの差を超えなければ目地には見えない**。

### Normal / Roughness / Height

画像生成に法線マップを描かせても使いものにならない。ベースカラーだけ作って、
残りはリポジトリ側で焼くほうがいい：

- **Height** ベースカラーの輝度をタイル境界をまたいでぼかしたもの
- **Normal** その中央差分（`createGroundDetailTexture()` と同じやり方）
- **Roughness** 輝度から。濡れた土や苔は低く、乾いた砂や落ち葉は高く
- **AO** 高さと、ラップ対応の箱ぼかしとの差（`boxBlurWrap()`）

つまり必要なのは **ベースカラー 4 枚だけ**。
