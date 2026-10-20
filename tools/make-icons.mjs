// 拡張機能のアイコン（PNG）を生成する。外部のライブラリ・画像ソフトは使わない。
//
// 絵の意味: 「ブラウザの窓（表示中のページ）」と、その右に開いた「サイドパネル（琥珀色）」、
//           パネルの中の「きらめき（AI）」。ページを見ながら、横のパネルで AI に相談する、という使い方そのもの。
// 色: 紫の背景に、白い窓と琥珀色のパネル。「右クリックで日本語に翻訳」（青い四角に白い「訳」）とは、
//     色も形も違うので、ツールバーに並べても見分けられる。
//
// 実行: node tools/make-icons.mjs [--preview <プレビューの PNG の出力先>]
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'extension', 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4; // 1 ピクセルを SS × SS 個に分けて塗り、ふちをなめらかにする

// ---------------------------------------------------------------- 色

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const C = {
  bgFrom: hex('#8B5CF6'),
  bgTo: hex('#4C1D95'),
  window: hex('#FFFFFF'),
  titleBar: hex('#DDD6FE'),
  line: hex('#C4B5FD'),
  panelFrom: hex('#FCD34D'),
  panelTo: hex('#F59E0B'),
  spark: hex('#FFFFFF'),
};

// ---------------------------------------------------------------- 図形（128 × 128 の座標）

function inRoundRect(x, y, rx, ry, rw, rh, r) {
  if (x < rx || y < ry || x > rx + rw || y > ry + rh) return false;
  const cx = x < rx + r ? rx + r : x > rx + rw - r ? rx + rw - r : x;
  const cy = y < ry + r ? ry + r : y > ry + rh - r ? ry + rh - r : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 4 つの角を持つ、きらめき。R: 先端までの長さ、r: くびれの位置
function sparkle(cx, cy, R, r) {
  return [
    [cx, cy - R], [cx + r, cy - r], [cx + R, cy], [cx + r, cy + r],
    [cx, cy + R], [cx - r, cy + r], [cx - R, cy], [cx - r, cy - r],
  ];
}

const WIN = { x: 14, y: 26, w: 100, h: 76, r: 11 }; // 窓
const TITLE_H = 15; // タイトルバーの高さ
const PANEL_X = 76; // サイドパネルが始まる位置
const BIG = sparkle(95, 63, 16, 4.6);
const SMALL = sparkle(88, 89, 6, 1.9);
// 16px の小さなサイズでは、パネルを広げ、きらめきを大きくして、小さな点にならないようにする
const PANEL_X_TINY = 68;
const BIG_TINY = sparkle(91, 64, 22, 7.5);
const LINES = [
  [24, 49, 38, 7],
  [24, 63, 30, 7],
  [24, 77, 34, 7],
];

// 点 (x, y) の色 [r, g, b, a]。detail: 小さいサイズでは、細かい飾りを省いて、形をはっきりさせる
function paint(x, y, detail) {
  if (!inRoundRect(x, y, 0, 0, 128, 128, 28)) return [0, 0, 0, 0];
  let color = mix(C.bgFrom, C.bgTo, (x + y) / 256);

  if (inRoundRect(x, y, WIN.x, WIN.y, WIN.w, WIN.h, WIN.r)) {
    if (x >= (detail ? PANEL_X : PANEL_X_TINY)) {
      color = mix(C.panelFrom, C.panelTo, (y - WIN.y) / WIN.h); // サイドパネル
      const spark = detail ? inPolygon(x, y, BIG) || inPolygon(x, y, SMALL) : inPolygon(x, y, BIG_TINY);
      if (spark) color = C.spark;
    } else {
      color = y < WIN.y + TITLE_H ? C.titleBar : C.window; // ページ
      if (detail && LINES.some(([lx, ly, lw, lh]) => inRoundRect(x, y, lx, ly, lw, lh, lh / 2))) color = C.line;
    }
  }
  return [color[0], color[1], color[2], 255];
}

// ---------------------------------------------------------------- 描画と PNG 書き出し

function render(size) {
  const detail = size >= 32;
  const rgba = Buffer.alloc(size * size * 4);
  const scale = 128 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [cr, cg, cb, ca] = paint((px + (sx + 0.5) / SS) * scale, (py + (sy + 0.5) / SS) * scale, detail);
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const o = (py * size + px) * 4;
      if (a > 0) {
        rgba[o] = Math.round(r / a);
        rgba[o + 1] = Math.round(g / a);
        rgba[o + 2] = Math.round(b / a);
      }
      rgba[o + 3] = Math.round(a / (SS * SS));
    }
  }
  return rgba;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 4 + body.length);
  return out;
}
function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 8 ビット
  header[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // フィルターなし
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 実行

mkdirSync(outDir, { recursive: true });
const rendered = new Map();
for (const size of SIZES) {
  const rgba = render(size);
  rendered.set(size, rgba);
  const file = path.join(outDir, `icon${size}.png`);
  writeFileSync(file, encodePng(size, size, rgba));
  console.log(`作成: ${path.relative(path.join(here, '..'), file)}`);
}

// 確認用のプレビュー（配布物には含めない）: 各サイズを、明るい背景・暗い背景に、整数倍で並べる
const previewIndex = process.argv.indexOf('--preview');
if (previewIndex >= 0 && process.argv[previewIndex + 1]) {
  const cell = 160;
  const rows = [hex('#FFFFFF'), hex('#202124')];
  const width = cell * SIZES.length;
  const height = cell * rows.length;
  const sheet = Buffer.alloc(width * height * 4);
  rows.forEach((bg, row) => {
    SIZES.forEach((size, col) => {
      const zoom = Math.max(1, Math.floor((cell - 24) / size));
      const shown = size * zoom;
      const ox = col * cell + Math.floor((cell - shown) / 2);
      const oy = row * cell + Math.floor((cell - shown) / 2);
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const o = ((row * cell + y) * width + col * cell + x) * 4;
          sheet[o] = bg[0];
          sheet[o + 1] = bg[1];
          sheet[o + 2] = bg[2];
          sheet[o + 3] = 255;
        }
      }
      const src = rendered.get(size);
      for (let y = 0; y < shown; y++) {
        for (let x = 0; x < shown; x++) {
          const s = (Math.floor(y / zoom) * size + Math.floor(x / zoom)) * 4;
          const a = src[s + 3] / 255;
          const o = ((oy + y) * width + ox + x) * 4;
          for (let k = 0; k < 3; k++) sheet[o + k] = Math.round(src[s + k] * a + sheet[o + k] * (1 - a));
        }
      }
    });
  });
  writeFileSync(process.argv[previewIndex + 1], encodePng(width, height, sheet));
  console.log(`プレビュー: ${process.argv[previewIndex + 1]}`);
}
