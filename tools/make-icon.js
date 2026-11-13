'use strict';
// Draws plugin/.claude-plugin/icon.png (1024 x 1024): the Engineering OS diamond above three model dots.
// No dependencies: shapes are sampled 4x4 per pixel for anti-aliasing and written as a PNG with zlib.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const N = 1024;
const SS = 4;
const BG = [22, 25, 29];
const INK = [231, 234, 238];
const DOTS = [[60, 195, 176], [111, 155, 255], [177, 140, 255]]; // haiku, sonnet, opus

function roundedSquare(x, y) { // background with rounded corners
  const r = 220, m = 0;
  const cx = Math.min(Math.max(x, m + r), N - m - r);
  const cy = Math.min(Math.max(y, m + r), N - m - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function diamond(x, y, cx, cy, half) { return Math.abs(x - cx) + Math.abs(y - cy) <= half; }
function shape(x, y) {
  if (!roundedSquare(x, y)) return null;
  const cx = 512, cy = 430;
  if (diamond(x, y, cx, cy, 250) && !diamond(x, y, cx, cy, 170)) return INK;
  if (diamond(x, y, cx, cy, 95)) return INK;
  const dy = 800;
  for (let i = 0; i < 3; i++) {
    const dx = 512 + (i - 1) * 190;
    if ((x - dx) ** 2 + (y - dy) ** 2 <= 62 * 62) return DOTS[i];
  }
  return BG;
}

const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const c = shape(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
    }
    const o = y * (N * 4 + 1) + 1 + x * 4;
    raw[o] = a ? Math.round(r / a) : 0;
    raw[o + 1] = a ? Math.round(g / a) : 0;
    raw[o + 2] = a ? Math.round(b / a) : 0;
    raw[o + 3] = Math.round((a / (SS * SS)) * 255);
  }
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'plugin', '.claude-plugin', 'icon.png');
fs.writeFileSync(out, png);
console.log('wrote ' + out + ' (' + png.length + ' bytes)');
