'use strict';

// 앱·트레이 아이콘 PNG 를 만든다 (외부 도구 없이). `node scripts/make-icons.js`
// 모양: 강조색 둥근 사각형 + 흰 메모 줄 세 개(마지막 줄은 짧게) — "던진 메모가 정리된다"

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// 둥근 사각형 안쪽까지의 거리(음수 = 안) — 가장자리를 부드럽게
function roundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r, Math.min(x, x1 - r)), cy = Math.max(y0 + r, Math.min(y, y1 - r));
  const inside = x >= x0 && x <= x1 && y >= y0 && y <= y1;
  const d = Math.hypot(x - cx, y - cy) - r;
  return (x > x0 + r && x < x1 - r) || (y > y0 + r && y < y1 - r) ? (inside ? -Math.min(x - x0, x1 - x, y - y0, y1 - y) : 1) : d;
}
const BG = [91, 91, 214];
function pixel(x, y, s) {
  const u = x / s, v = y / s;
  const d = roundRect(u, v, 0.04, 0.04, 0.96, 0.96, 0.24) * s;
  const a = Math.max(0, Math.min(1, 0.5 - d));
  if (a <= 0) return [0, 0, 0, 0];
  const lines = [[0.26, 0.74, 0.33], [0.26, 0.74, 0.5], [0.26, 0.56, 0.67]];
  let w = 0;
  for (const [l, r, cy] of lines) {
    const ld = roundRect(u, v, l, cy - 0.045, r, cy + 0.045, 0.045) * s;
    w = Math.max(w, Math.max(0, Math.min(1, 0.5 - ld)));
  }
  const c = BG.map((ch) => Math.round(ch * (1 - w) + 255 * w));
  return [c[0], c[1], c[2], Math.round(a * 255)];
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
for (const s of [16, 32, 256]) fs.writeFileSync(path.join(out, 'icon-' + s + '.png'), png(s, pixel));
console.log('icons written to ' + out);
