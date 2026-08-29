/**
 * 地形メッシュの «骨格»（THREE 非依存なので Node からも検証できる）。
 *
 * もとは 1000m 四方を 260 分割した一様格子だった。セルは 3.85m で、
 * プレイヤーがいる汀線 ±20m の帯には 13.5 万枚のうち 4400 枚しか無い。
 * 面積の 96% を占める深場と遠くの山が、三角形の 96% を持っていく。
 *
 * 一様に細かくするのは筋が悪い。1m セルにするには 216 万枚が要り、その
 * ほとんどが誰も近づかない場所に消える。だから «増やす» のではなく
 * «寄せる»：湖はもともと極座標（shoreAtAngle）で作られているので、
 * メッシュも同心円で組んで、汀線まわりのバンドだけ半径・角度とも細かくする。
 *
 * バンドの境目では分割数が変わる（T 字接合）ので、そこだけ扇形に縫う。
 */

export const TAU = Math.PI * 2;

/**
 * 内側から外側へのバンド。
 *
 * `seg` は 96 × (1, 2, 8, 4, 2, 1)。隣り合うバンドの分割数がかならず
 * 整数倍になっているので、境目を扇形で縫える。品質を落とすときは
 * `detail` を全バンドに同じだけ掛けるため、この比は保たれる。
 *
 * `step` は半径方向の間隔。汀線の半径は 116〜153m で、その内側の浅場も
 * 外側の浜も見えるので、92〜190m を 1.25m 刻みにして丸ごと覆う。
 * 弧は r=116 で 0.95m、r=190 で 1.55m。半径方向の 1.25m と釣り合う。
 */
export const RADIAL_BANDS = [
  { r0: 0, r1: 56, step: 6.0, seg: 96 },      // 湖の真ん中。深くて濁るので粗くてよい
  { r0: 56, r1: 92, step: 3.0, seg: 192 },    // 沖の湖底
  { r0: 92, r1: 190, step: 1.25, seg: 768 },  // ★ 汀線。ここに三角形を集める
  { r0: 190, r1: 270, step: 2.5, seg: 384 },  // 浜のうしろ
  { r0: 270, r1: 430, step: 5.0, seg: 192 },  // 林
  { r0: 430, r1: 720, step: 10.0, seg: 96 },  // 遠景の山。1000m 四方の角(707m)まで覆う
];

/** 品質ごとの倍率。分割数に掛け、間隔には逆数を掛ける */
export const DETAIL_BY_QUALITY = { low: 0.5, medium: 0.75, high: 1 };

/**
 * 同心円の地形格子を組む。
 *
 * @param {object} [opts]
 * @param {number} [opts.detail]  分割の倍率（1 = 高品質）
 * @param {Array}  [opts.bands]
 * @returns {{
 *   xz: Float32Array,     // 頂点の x,z（2 個ずつ）
 *   cell: Float32Array,   // 頂点ごとのセルの大きさ[m]。傾きを取る幅に使う
 *   index: Uint32Array,
 *   vertexCount: number,
 *   triangleCount: number,
 *   radius: number,
 * }}
 */
export function buildRadialGrid({ detail = 1, bands = RADIAL_BANDS } = {}) {
  const xz = [];
  const cell = [];
  const index = [];

  /** リングを 1 枚積む。閉じているので seg 個の頂点で足りる */
  const pushRing = (r, seg, cellSize) => {
    const base = xz.length / 2;
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * TAU;
      xz.push(Math.cos(a) * r, Math.sin(a) * r);
      cell.push(cellSize);
    }
    return base;
  };

  // 中心の 1 点。ここから最初のリングへ扇形に張る
  xz.push(0, 0);
  cell.push(bands[0].step / detail);

  /** @type {{base:number, seg:number}[]} 積んだリング（内側から） */
  const rings = [];

  for (const b of bands) {
    const seg = Math.round(b.seg * detail);
    const step = b.step / detail;
    // r0 は前のバンドが積んでいるので r0 + step から。刻みは割り切れるよう詰める
    const n = Math.max(1, Math.round((b.r1 - b.r0) / step));
    const dr = (b.r1 - b.r0) / n;
    for (let k = 1; k <= n; k++) {
      const r = b.r0 + dr * k;
      // 傾きを取る幅は «半径方向と弧の大きいほう»
      const cellSize = Math.max(dr, (TAU * r) / seg);
      rings.push({ base: pushRing(r, seg, cellSize), seg, r });
    }
  }

  // 中心 → 最初のリング
  {
    const { base, seg } = rings[0];
    for (let i = 0; i < seg; i++) {
      index.push(0, base + ((i + 1) % seg), base + i);
    }
  }

  for (let i = 0; i + 1 < rings.length; i++) {
    stitch(index, rings[i], rings[i + 1]);
  }

  return {
    xz: new Float32Array(xz),
    cell: new Float32Array(cell),
    index: new Uint32Array(index),
    vertexCount: xz.length / 2,
    triangleCount: index.length / 3,
    radius: bands[bands.length - 1].r1,
  };
}

/**
 * 隣り合う 2 枚のリングを張る。
 *
 * 分割数が同じならただの四角形。違うときは細かいほうのリングを
 * 何本かまとめて、粗いほうの頂点から扇形に張る。こうしないと
 * 境目に T 字が残って、動かすと隙間が開いて見える。
 */
function stitch(index, A, B) {
  const { base: a, seg: sa } = A;
  const { base: b, seg: sb } = B;

  if (sa === sb) {
    for (let i = 0; i < sa; i++) {
      const i1 = (i + 1) % sa;
      index.push(a + i, a + i1, b + i);
      index.push(a + i1, b + i1, b + i);
    }
    return;
  }

  if (sb % sa === 0) {
    // 外側が細かい。内側の頂点から外へ扇形に張る
    const k = sb / sa;
    for (let i = 0; i < sa; i++) {
      const i1 = (i + 1) % sa;
      const j0 = i * k;
      index.push(a + i, a + i1, b + ((j0 + k) % sb));
      for (let t = k - 1; t >= 0; t--) {
        index.push(a + i, b + ((j0 + t + 1) % sb), b + (j0 + t));
      }
    }
    return;
  }

  if (sa % sb === 0) {
    // 内側が細かい。外側の頂点から内へ扇形に張る
    const k = sa / sb;
    for (let j = 0; j < sb; j++) {
      const j1 = (j + 1) % sb;
      const i0 = j * k;
      for (let t = 0; t < k; t++) {
        index.push(b + j, a + ((i0 + t) % sa), a + ((i0 + t + 1) % sa));
      }
      index.push(b + j, a + ((i0 + k) % sa), b + j1);
    }
    return;
  }

  throw new Error(`リングの分割数が整数倍でない: ${sa} と ${sb}`);
}
