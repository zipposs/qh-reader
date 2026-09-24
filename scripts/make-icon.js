'use strict';
// 生成应用图标 assets/icon.ico（多尺寸 PNG），与欢迎页的 “M↓” 标志一致。用法：node scripts/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const TOP = [0x21, 0x8b, 0xff]; // 渐变上端
const BOTTOM = [0x09, 0x69, 0xda]; // 渐变下端

// 64×64 设计坐标：圆角矩形 + 两条折线（M 与向下箭头），线宽 5
const RECT = { x: 2, y: 2, w: 60, h: 60, r: 14 };
const STROKE = 2.5;
const LINES = [
  [[14, 44], [14, 20], [23, 32], [32, 20], [32, 44]],
  [[44, 20], [44, 42]],
  [[37, 35], [44, 42], [51, 35]],
];

function inRoundRect(x, y) {
  const { x: rx, y: ry, w, h, r } = RECT;
  if (x < rx || y < ry || x > rx + w || y > ry + h) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function onStroke(x, y) {
  for (const line of LINES) {
    for (let i = 0; i < line.length - 1; i++) if (distToSegment(x, y, line[i], line[i + 1]) <= STROKE) return true;
  }
  return false;
}

function render(size) {
  const ss = size <= 32 ? 8 : 4; // 超采样抗锯齿
  const px = Buffer.alloc(size * size * 4);
  const scale = 64 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) * scale;
          const v = (y + (sy + 0.5) / ss) * scale;
          if (!inRoundRect(u, v)) continue;
          if (onStroke(u, v)) fg++;
          else bg++;
        }
      }
      const n = ss * ss;
      const a = (bg + fg) / n;
      const i = (y * size + x) * 4;
      if (!a) continue;
      const t = y / (size - 1);
      const base = TOP.map((c, k) => c + (BOTTOM[k] - c) * t);
      const w = fg / (bg + fg);
      px[i] = Math.round(base[0] + (255 - base[0]) * w);
      px[i + 1] = Math.round(base[1] + (255 - base[1]) * w);
      px[i + 2] = Math.round(base[2] + (255 - base[2]) * w);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, size, px);
}

// ---------- PNG / ICO 编码 ----------
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // 色彩平面
    e.writeUInt16LE(32, 6); // 位深
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
const images = SIZES.map((size) => ({ size, png: render(size) }));
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(images));
fs.writeFileSync(path.join(outDir, 'icon.png'), images[images.length - 1].png);
console.log('已生成 assets/icon.ico 与 assets/icon.png');
