/**
 * 生成した陸アルベドをゲーム用タイルにする。
 *
 *  1. 平均色を頂点色の実測（docs/land-texture-prompts.md）へ合わせる
 *  2. 半分ずらして混ぜ、左右・上下端が隣テクセル並みに繋がるようにする
 *  3. 1024² sRGB webp で assets/textures/ へ書く
 *
 *   node scripts/process-land-textures.mjs --in <dir>
 *   node scripts/process-land-textures.mjs --verify
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const SIZE = 1024;

export const LAND_TILES = [
  { id: 'land-beach', hex: '#bcb99c', contrast: 0.82 },
  { id: 'land-grass', hex: '#8eab73', contrast: 1 },
  { id: 'land-forest', hex: '#7f9e6e', contrast: 1 },
  { id: 'land-rock', hex: '#9e9a95', contrast: 1 },
];

export function parseHex(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

export function meanRgb(rgb, n = SIZE) {
  const acc = [0, 0, 0];
  const pix = n * n;
  for (let i = 0; i < pix; i++) {
    acc[0] += rgb[i * 3];
    acc[1] += rgb[i * 3 + 1];
    acc[2] += rgb[i * 3 + 2];
  }
  return acc.map((v) => v / pix);
}

export function colorMatch(rgb, target, contrast = 1, n = SIZE) {
  const mean = meanRgb(rgb, n);
  const out = new Float64Array(rgb.length);
  const pix = n * n;
  for (let i = 0; i < pix; i++) {
    for (let c = 0; c < 3; c++) {
      const v = (rgb[i * 3 + c] - mean[c]) * contrast + target[c];
      out[i * 3 + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return out;
}

/** 端は 50% ずらし側、中央は元画像。境界の fade が 0 なのでラップで繋がる */
export function makeSeamless(src, n = SIZE) {
  const half = n >> 1;
  const out = new Float64Array(src.length);
  const fade = (t) => 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / n);
  const at = (x, y, c) => {
    const xx = ((x % n) + n) % n;
    const yy = ((y % n) + n) % n;
    return src[(yy * n + xx) * 3 + c];
  };
  for (let y = 0; y < n; y++) {
    const fy = fade(y);
    for (let x = 0; x < n; x++) {
      const w = fade(x) * fy;
      const i = (y * n + x) * 3;
      for (let c = 0; c < 3; c++) {
        out[i + c] = at(x + half, y + half, c) * (1 - w) + src[i + c] * w;
      }
    }
  }
  return out;
}

export function toUint8(src) {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = Math.round(src[i]);
  return out;
}

/**
 * 左端と右端（および上下）の差が、隣り合うテクセル差を超えなければ目地に見えない。
 * ground-grain-test.mjs と同じ判定。
 */
export function seamReport(rgb, n = SIZE) {
  let seam = 0;
  let neighbour = 0;
  const d = (i, j) => {
    let s = 0;
    for (let c = 0; c < 3; c++) {
      const a = rgb[i + c] - rgb[j + c];
      s += a * a;
    }
    return Math.sqrt(s);
  };
  for (let y = 0; y < n; y++) {
    const row = y * n * 3;
    seam = Math.max(seam, d(row, row + (n - 1) * 3));
    for (let x = 1; x < n; x++) {
      neighbour = Math.max(neighbour, d(row + x * 3, row + (x - 1) * 3));
    }
  }
  for (let x = 0; x < n; x++) {
    seam = Math.max(seam, d(x * 3, ((n - 1) * n + x) * 3));
    for (let y = 1; y < n; y++) {
      neighbour = Math.max(neighbour, d((y * n + x) * 3, ((y - 1) * n + x) * 3));
    }
  }
  return { seam, neighbour, ok: seam <= neighbour * 1.2 };
}

/** 焼いた結果の要約。ImageMagick の無い環境（CI）でも検査できるようにする */
export const DIGEST_PATH = 'assets/textures/land-tiles.json';

export function hasMagick() {
  return spawnSync('magick', ['-version'], { stdio: 'ignore' }).status === 0;
}

export function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function readDigest(root_ = root) {
  return JSON.parse(readFileSync(join(root_, DIGEST_PATH), 'utf8'));
}

function runMagick(args, input, encoding = 'buffer') {
  const r = spawnSync('magick', args, {
    input,
    encoding,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`magick ${args.join(' ')} failed: ${r.stderr || r.error}`);
  }
  return r.stdout;
}

export function decodeRgb(path, n = SIZE) {
  const buf = runMagick([path, '-colorspace', 'sRGB', '-depth', '8', 'rgb:-']);
  if (buf.length !== n * n * 3) {
    throw new Error(`${path}: expected ${n}x${n} rgb (${n * n * 3} B), got ${buf.length}`);
  }
  return new Uint8Array(buf);
}

function encodeWebp(rgb, outPath, n = SIZE) {
  runMagick([
    '-size', `${n}x${n}`,
    '-depth', '8',
    'rgb:-',
    '-colorspace', 'sRGB',
    '-quality', '88',
    outPath,
  ], Buffer.from(rgb));
}

function hexOf(rgb) {
  return `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

export function processTile(srcRgb, spec, n = SIZE) {
  const target = parseHex(spec.hex);
  const matched = colorMatch(srcRgb, target, spec.contrast, n);
  const tiled = makeSeamless(matched, n);
  const again = colorMatch(tiled, target, 1, n);
  const out = toUint8(again);
  return { rgb: out, mean: meanRgb(out, n), seam: seamReport(out, n) };
}

function defaultInDir() {
  return '/Users/apple/.cursor/projects/Users-apple-Fishing-Game/assets';
}

/** コミット済みの webp から要約を焼き直す（画像を作り直さずに digest だけ更新） */
function writeDigestFromWebp() {
  const out = LAND_TILES.map((spec) => {
    const webp = join(root, 'assets/textures', `${spec.id}.webp`);
    const rgb = decodeRgb(webp);
    const mean = meanRgb(rgb);
    const seam = seamReport(rgb);
    if (!seam.ok) throw new Error(`${spec.id}: tile seam visible`);
    return {
      id: spec.id,
      target: spec.hex,
      mean: mean.map((v) => Math.round(v * 10) / 10),
      seam: Math.round(seam.seam * 10) / 10,
      neighbour: Math.round(seam.neighbour * 10) / 10,
      sha256: sha256(webp),
      size: SIZE,
    };
  });
  writeFileSync(join(root, DIGEST_PATH), `${JSON.stringify(out, null, 2)}\n`);
  for (const t of out) {
    console.log(`  ${t.id.padEnd(12)} ${hexOf(t.mean)}  seam ${t.seam} / nbor ${t.neighbour}  ${t.sha256.slice(0, 12)}`);
  }
  console.log(`${DIGEST_PATH} を書き出しました`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--digest')) { writeDigestFromWebp(); return; }
  const verify = args.includes('--verify');
  const inIdx = args.indexOf('--in');
  const inDir = inIdx >= 0 ? args[inIdx + 1] : defaultInDir();
  const outDir = join(root, 'assets/textures');
  mkdirSync(outDir, { recursive: true });
  const written = [];

  for (const spec of LAND_TILES) {
    const webp = join(outDir, `${spec.id}.webp`);
    if (verify) {
      if (!existsSync(webp)) throw new Error(`missing ${webp}`);
      const rgb = decodeRgb(webp);
      const mean = meanRgb(rgb);
      const seam = seamReport(rgb);
      const target = parseHex(spec.hex);
      const drift = Math.max(...mean.map((v, i) => Math.abs(v - target[i])));
      console.log(
        `  ${spec.id}  mean ${hexOf(mean)}  target ${spec.hex}  drift ${drift.toFixed(1)}`
        + `  seam ${seam.seam.toFixed(1)} / nbor ${seam.neighbour.toFixed(1)}`,
      );
      if (drift > 3) throw new Error(`${spec.id}: mean drifted ${drift.toFixed(1)} from ${spec.hex}`);
      if (!seam.ok) throw new Error(`${spec.id}: tile seam ${seam.seam.toFixed(1)} > ${seam.neighbour.toFixed(1)}`);
      continue;
    }
    const srcPng = join(inDir, `${spec.id}.png`);
    if (!existsSync(srcPng)) throw new Error(`source not found: ${srcPng}`);
    const src = decodeRgb(srcPng);
    const { rgb, mean, seam } = processTile(src, spec);
    encodeWebp(rgb, webp);
    console.log(
      `  ${spec.id}  ${hexOf(mean)}  (target ${spec.hex})`
      + `  seam ${seam.seam.toFixed(1)} / nbor ${seam.neighbour.toFixed(1)}  ${seam.ok ? 'ok' : 'FAIL'}`,
    );
    if (!seam.ok) throw new Error(`${spec.id}: tile seam visible`);
    written.push({
      id: spec.id,
      target: spec.hex,
      mean: mean.map((v) => Math.round(v * 10) / 10),
      seam: Math.round(seam.seam * 10) / 10,
      neighbour: Math.round(seam.neighbour * 10) / 10,
      sha256: sha256(webp),
      size: SIZE,
    });
  }
  if (!verify) {
    /* ImageMagick はどこにでもある訳ではない（GitHub のランナーには無い）。
       焼いた結果をここに残しておけば、CI は webp を復号しなくても
       «コミットされている画像が、検査を通った画像そのものか» を
       ハッシュで確かめられる（→ land-texture-test.mjs） */
    writeFileSync(join(root, DIGEST_PATH), `${JSON.stringify(written, null, 2)}\n`);
    console.log(`  ${DIGEST_PATH} を更新`);
  }
  console.log(verify ? 'land textures: verified' : 'land textures: written');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
