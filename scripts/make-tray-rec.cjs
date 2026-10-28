'use strict';
/**
 * Иконка трея на время записи: та же иконка с красной точкой.
 *
 *     node scripts/make-tray-rec.cjs
 *
 * Рисуется один раз и лежит в assets/. Скрипт нужен, чтобы точку можно было
 * перерисовать, не открывая графический редактор: иконка трея должна
 * совпадать с остальными по форме, а не быть нарисованной заново.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ASSETS = path.join(__dirname, '..', 'assets');

function crcTable() {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
}
const TABLE = crcTable();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Разбор PNG: только 8 бит на канал, RGBA. */
function decode(file) {
  const b = fs.readFileSync(file);
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  const depth = b[24];
  const color = b[25];
  if (depth !== 8 || color !== 6) throw new Error(file + ': нужен PNG 8 бит RGBA');
  let off = 8;
  const idat = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('ascii', off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? row[x - bpp] : 0;
      const up = prev ? prev[x] : 0;
      const upLeft = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += left;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        v += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      row[x] = v & 0xff;
    }
  }
  return { width, height, data: out };
}

/** Рисует точку с белым ободком, чтобы её было видно на любой панели. */
function stampDot(img, color) {
  const { width, height, data } = img;
  const cx = width - width * 0.28;
  const cy = height - height * 0.28;
  const r = Math.max(3, width * 0.3);
  const ring = r + Math.max(1, width * 0.06);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const i = (y * width + x) * 4;
      if (d <= r) {
        data[i] = color[0];
        data[i + 1] = color[1];
        data[i + 2] = color[2];
        data[i + 3] = 255;
      } else if (d <= ring) {
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = 255;
      }
    }
  }
}

function encode(img, file) {
  const { width, height, data } = img;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
}

// Красная точка: идёт запись.
const busy = decode(path.join(ASSETS, 'tray.png'));
stampDot(busy, [56, 132, 255]);
encode(busy, path.join(ASSETS, 'tray-busy.png'));

const busyMono = decode(path.join(ASSETS, 'trayTemplate.png'));
stampDot(busyMono, [0, 0, 0]);
encode(busyMono, path.join(ASSETS, 'trayTemplate-busy.png'));

// Цветной трей: красная точка.
const color = decode(path.join(ASSETS, 'tray.png'));
stampDot(color, [229, 72, 77]);
encode(color, path.join(ASSETS, 'tray-rec.png'));

// Шаблонный трей macOS: цвет заменяется системой, поэтому точка чёрная.
const mono = decode(path.join(ASSETS, 'trayTemplate.png'));
stampDot(mono, [0, 0, 0]);
encode(mono, path.join(ASSETS, 'trayTemplate-rec.png'));

console.log('assets/tray-rec.png, tray-busy.png и их шаблоны готовы');
