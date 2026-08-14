// examples/world/mini-canvas.mjs — a from-scratch OffscreenCanvas stand-in.
//
// src/output/epub.js is deliberately browser-only: its cover art comes from
// OffscreenCanvas, which Node does not have. This is NOT part of the package
// (nothing under examples/ ships in the npm tarball) — it exists purely so
// this example script can call buildEpub() under plain `node`, without
// pulling a canvas library into anyone's dependency tree.
//
// It implements exactly the subset epub.js's `_renderCover` calls: fillRect,
// strokeRect, path stroking, fillText/measureText against a tiny hand-drawn
// 5x7 bitmap font (uppercase only — text is upper-cased on render), and
// convertToBlob() via a minimal hand-rolled PNG encoder (zlib for the
// compressed IDAT, Node's only real dependency here, and a built-in).

import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';

const GLYPH_W = 5;
const GLYPH_H = 7;

// One 5-wide x 7-tall glyph per row-string ('#' = ink, '.' = empty). Covers
// what a generated title/subtitle/tagline/brand actually contains: letters,
// digits, space, and light punctuation. Anything else renders as a blank
// cell of the same width, so word-wrap measurement stays consistent.
const FONT = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.####', '#....', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '.#.#.', '..#..', '..#..', '..#..', '.#.#.', '#...#'],
  Y: ['#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '.##..', '..#..'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  "'": ['.##..', '.##..', '..#..', '.....', '.....', '.....', '.....'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  '&': ['.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#'],
};

function parseColor(str) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(str ?? ''));
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ─── Minimal PNG encoder (RGB, no alpha, one IDAT, filter-none scanlines) ────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgb) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 2;  // color type: RGB
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: None
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdrData),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── The canvas-shaped surface epub.js draws on ──────────────────────────────

class MiniCtx {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
    this.font = '10px serif';
    this.textAlign = 'left';
    this._path = [];
  }

  _fontSize() {
    const m = /(\d+(?:\.\d+)?)px/.exec(this.font ?? '');
    return m ? parseFloat(m[1]) : 10;
  }

  _setPx(x, y, rgb) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return;
    const i = (y * this.canvas.width + x) * 3;
    this.canvas._buf[i] = rgb[0]; this.canvas._buf[i + 1] = rgb[1]; this.canvas._buf[i + 2] = rgb[2];
  }

  fillRect(x, y, w, h) {
    const rgb = parseColor(this.fillStyle);
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this._setPx(xx, yy, rgb);
  }

  strokeRect(x, y, w, h) {
    const rgb = parseColor(this.strokeStyle);
    const lw = Math.max(1, Math.round(this.lineWidth));
    for (let t = 0; t < lw; t++) {
      for (let xx = x; xx < x + w; xx++) { this._setPx(xx, y + t, rgb); this._setPx(xx, y + h - 1 - t, rgb); }
      for (let yy = y; yy < y + h; yy++) { this._setPx(x + t, yy, rgb); this._setPx(x + w - 1 - t, yy, rgb); }
    }
  }

  beginPath() { this._path = []; }
  moveTo(x, y) { this._path = [[x, y]]; }
  lineTo(x, y) { this._path.push([x, y]); }

  stroke() {
    const rgb = parseColor(this.strokeStyle);
    const lw = Math.max(1, Math.round(this.lineWidth));
    for (let i = 1; i < this._path.length; i++) {
      this._line(this._path[i - 1][0], this._path[i - 1][1], this._path[i][0], this._path[i][1], rgb, lw);
    }
  }

  _line(x0, y0, x1, y1, rgb, lw) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy, x = x0, y = y0;
    const half = Math.floor(lw / 2);
    for (;;) {
      for (let ox = -half; ox <= half; ox++) for (let oy = -half; oy <= half; oy++) this._setPx(x + ox, y + oy, rgb);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }

  measureText(text) {
    const scale = Math.max(1, Math.round(this._fontSize() / GLYPH_H));
    return { width: String(text).length * (GLYPH_W + 1) * scale };
  }

  fillText(text, x, y) {
    const scale = Math.max(1, Math.round(this._fontSize() / GLYPH_H));
    const totalW = String(text).length * (GLYPH_W + 1) * scale;
    let cx = this.textAlign === 'center' ? x - totalW / 2 : x;
    const rgb = parseColor(this.fillStyle);
    for (const raw of String(text)) {
      const rows = FONT[raw.toUpperCase()] ?? FONT[' '];
      for (let ry = 0; ry < GLYPH_H; ry++) {
        const row = rows[ry];
        for (let rx = 0; rx < GLYPH_W; rx++) {
          if (row[rx] !== '#') continue;
          const px = cx + rx * scale, py = y - GLYPH_H * scale + ry * scale;
          for (let ox = 0; ox < scale; ox++) for (let oy = 0; oy < scale; oy++) this._setPx(px + ox, py + oy, rgb);
        }
      }
      cx += (GLYPH_W + 1) * scale;
    }
  }
}

class MiniOffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this._buf = Buffer.alloc(width * height * 3, 0);
  }
  getContext(kind) {
    if (kind !== '2d') return null;
    this._ctx ??= new MiniCtx(this);
    return this._ctx;
  }
  async convertToBlob({ type } = {}) {
    const png = encodePng(this.width, this.height, this._buf);
    return new Blob([png], { type: type || 'image/png' });
  }
}

// Install the global epub.js's `_renderCover` reaches for. Idempotent.
export function installMiniCanvasPolyfill() {
  if (typeof globalThis.OffscreenCanvas !== 'function') {
    globalThis.OffscreenCanvas = MiniOffscreenCanvas;
  }
}
