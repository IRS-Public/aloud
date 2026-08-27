#!/usr/bin/env node
// Regenerate order-status.png, the bundled sample screenshot for the demo.
// It is a drawn wireframe of the sample "Order status" screen, at half the
// fixture's pixel geometry (fixture: 1080x2400 at 420dpi -> image 540x1200).
// No image libraries: flat rectangles, a tiny 5x7 pixel font, and a minimal
// PNG encoder over node:zlib.
//
//   node src/demo/fixtures/make-screenshot.mjs

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const W = 540;
const H = 1200;
const px = new Uint8Array(W * H * 3).fill(0xff); // white background

const set = (x, y, [r, g, b]) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const o = (y * W + x) * 3;
  px[o] = r;
  px[o + 1] = g;
  px[o + 2] = b;
};
const rect = (x, y, w, h, c) => {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) set(i, j, c);
};
const frame = (x, y, w, h, t, c) => {
  rect(x, y, w, t, c);
  rect(x, y + h - t, w, t, c);
  rect(x, y, t, h, c);
  rect(x + w - t, y, t, h, c);
};

// 5x7 font, uppercase subset used by the sample screen's labels.
const FONT = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};
const text = (s, x, y, scale, c) => {
  let cx = x;
  for (const ch of s.toUpperCase()) {
    const glyph = FONT[ch] ?? FONT[" "];
    glyph.forEach((row, gy) => {
      for (let gx = 0; gx < 5; gx++) {
        if (row[gx] === "1") rect(cx + gx * scale, y + gy * scale, scale, scale, c);
      }
    });
    cx += 6 * scale;
  }
  return cx - x - scale; // drawn width
};
const textW = (s, scale) => s.length * 6 * scale - scale;

const INK = [0x11, 0x11, 0x13];
const MUTED = [0x66, 0x6b, 0x73];
const LINE = [0xd5, 0xd7, 0xdb];
const BAR = [0x9a, 0xa0, 0xa6];
const ACCENT = [0x1a, 0x1a, 0x2e];
const WHITE = [0xff, 0xff, 0xff];

// App header
text("EXAMPLE SHOP", 24, 24, 2, MUTED);
rect(0, 48, W, 1, LINE);

// Heading: TextView [48,150][600,240] -> [24,75][300,120]
text("ORDER STATUS", 24, 82, 4, INK);

// Share icon button (the unlabeled control): [906,132][1032,258] -> 63px box
frame(453, 66, 63, 63, 2, LINE);
for (let i = 0; i < 9; i++) rect(484 - i, 78 + i, 1 + 2 * i, 1, INK); // arrow head
rect(482, 78, 5, 24, INK); // arrow stem
frame(468, 100, 33, 20, 3, INK); // tray

// Shipped line: TextView [48,320][1032,430] -> bars for body text
rect(24, 168, 460, 12, BAR);
rect(24, 190, 300, 12, BAR);

// Track package button: [48,520][1032,664] -> [24,260][516,332]
rect(24, 260, 492, 72, ACCENT);
text("TRACK PACKAGE", 24 + Math.round((492 - textW("TRACK PACKAGE", 3)) / 2), 285, 3, WHITE);

// Cancel order button, deliberately 32x32dp: [48,760][132,844] -> 42px box
frame(24, 380, 42, 42, 2, LINE);
text("X", 24 + Math.round((42 - textW("X", 3)) / 2), 390, 3, INK);

// ── minimal PNG encoder (truecolor 8-bit, filter 0) ──
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // truecolor
const raw = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 3)] = 0; // filter: none
  Buffer.from(px.buffer, y * W * 3, W * 3).copy(raw, y * (1 + W * 3) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), "order-status.png");
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
