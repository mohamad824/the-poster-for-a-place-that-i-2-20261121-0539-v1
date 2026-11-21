// LUMARIS — travel poster for a place that isn't there.
// Procedural poster: sunset sky, glowing teal sea, one lighthouse on a rock spire,
// lantern boats, hand-built geometric letterforms. Pure Node 22 stdlib only.
// Deterministic: seeded PRNG, no Date, no Math.random, no network.
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";

const W = 1024;
const H = 1024;

// ---------------------------------------------------------------- framebuffer
const buf = new Uint8Array(W * H * 3);

function setPx(x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
}

function blendPx(x: number, y: number, r: number, g: number, b: number, a: number): void {
  if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
  if (a >= 1) { setPx(x, y, r, g, b); return; }
  const i = (y * W + x) * 3;
  buf[i] = Math.round(buf[i] * (1 - a) + r * a);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - a) + g * a);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - a) + b * a);
}

type RGB = [number, number, number];

function fillRect(x: number, y: number, w: number, h: number, c: RGB, a = 1): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(W - 1, Math.ceil(x + w) - 1);
  const y1 = Math.min(H - 1, Math.ceil(y + h) - 1);
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      if (a >= 1) setPx(xx, yy, c[0], c[1], c[2]);
      else blendPx(xx, yy, c[0], c[1], c[2], a);
    }
  }
}

function fillCircle(cx: number, cy: number, rad: number, c: RGB, a = 1): void {
  const r = Math.ceil(rad);
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= rad * rad) blendPx(x, y, c[0], c[1], c[2], a);
    }
  }
}

function fillEllipse(cx: number, cy: number, rx: number, ry: number, c: RGB, a = 1): void {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) blendPx(x, y, c[0], c[1], c[2], a);
    }
  }
}

function fillPoly(pts: Array<[number, number]>, c: RGB, a = 1): void {
  let minY = Infinity, maxY = -Infinity;
  for (const [, py] of pts) { if (py < minY) minY = py; if (py > maxY) maxY = py; }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(H - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1p] = pts[i];
      const [x2, y2p] = pts[(i + 1) % pts.length];
      if ((y1p <= y && y < y2p) || (y2p <= y && y < y1p)) {
        xs.push(x1 + ((y - y1p) / (y2p - y1p)) * (x2 - x1));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k]));
      const xb = Math.min(W - 1, Math.floor(xs[k + 1]));
      for (let x = xa; x <= xb; x++) blendPx(x, y, c[0], c[1], c[2], a);
    }
  }
}

function thickLine(x1: number, y1: number, x2: number, y2: number, w: number, c: RGB, a = 1): void {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (w / 2), ny = (dx / len) * (w / 2);
  fillPoly([[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]], c, a);
  fillCircle(x1, y1, w / 2, c, a);
  fillCircle(x2, y2, w / 2, c, a);
}

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function lerpC(c1: RGB, c2: RGB, t: number): RGB {
  return [Math.round(lerp(c1[0], c2[0], t)), Math.round(lerp(c1[1], c2[1], t)), Math.round(lerp(c1[2], c2[2], t))];
}

// Vertical gradient between stops: [position 0..1, color]
function vgrad(y0: number, y1: number, stops: Array<[number, RGB]>): void {
  for (let y = y0; y < y1; y++) {
    const t = (y - y0) / Math.max(1, y1 - y0 - 1);
    let c: RGB = stops[stops.length - 1][1];
    for (let s = 0; s < stops.length - 1; s++) {
      if (t >= stops[s][0] && t <= stops[s + 1][0]) {
        const f = (t - stops[s][0]) / Math.max(0.0001, stops[s + 1][0] - stops[s][0]);
        c = lerpC(stops[s][1], stops[s + 1][1], f);
        break;
      }
    }
    fillRect(0, y, W, 1, c);
  }
}

// ---------------------------------------------------------------- seeded PRNG
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261121);

// ---------------------------------------------------------------- letterforms
// Bold geometric 5x7 bitmap capitals, drawn by hand in code.
const FONT: Record<string, string[]> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".####", "#....", "#....", "#....", "#....", "#....", ".####"],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".####", "#....", "#....", "#.###", "#...#", "#...#", ".###."],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
};

function textWidth(text: string, scale: number, spacing: number): number {
  return text.length * 5 * scale + (text.length - 1) * spacing;
}

function drawText(text: string, cx: number, y: number, scale: number, spacing: number, c: RGB, shadow: RGB | null, shadowDx = 5, shadowDy = 6): void {
  const w = textWidth(text, scale, spacing);
  const x0 = Math.round(cx - w / 2);
  const draw = (ox: number, oy: number, col: RGB, a: number) => {
    let cxp = x0 + ox;
    for (const ch of text) {
      const glyph = FONT[ch] ?? FONT[" "];
      for (let row = 0; row < 7; row++) {
        for (let cc = 0; cc < 5; cc++) {
          if (glyph[row][cc] === "#") {
            fillRect(cxp + cc * scale, y + oy + row * scale, scale, scale, col, a);
          }
        }
      }
      cxp += 5 * scale + spacing;
    }
  };
  if (shadow) draw(shadowDx, shadowDy, shadow, 0.55);
  draw(0, 0, c, 1);
}

// ---------------------------------------------------------------- palette
const CREAM: RGB = [255, 246, 220];
const GOLD: RGB = [255, 210, 122];
const SUN_CORE: RGB = [255, 246, 207];
const CORAL: RGB = [228, 87, 74];
const DARK: RGB = [43, 30, 56];
const ROCK: RGB = [51, 35, 63];
const TEAL_LIGHT: RGB = [127, 212, 194];

// ---------------------------------------------------------------- sky
vgrad(0, 600, [
  [0.0, [43, 35, 80]],
  [0.28, [110, 58, 107]],
  [0.5, [198, 90, 82]],
  [0.68, [240, 138, 75]],
  [0.85, [255, 180, 96]],
  [1.0, [255, 196, 107]],
]);

// Early stars in the upper corners (away from the name)
for (let i = 0; i < 34; i++) {
  const left = rand() < 0.5;
  const sx = left ? 44 + rand() * 70 : 910 + rand() * 70;
  const sy = 44 + rand() * 170;
  fillCircle(sx, sy, rand() < 0.75 ? 1 : 2, [255, 240, 210], 0.25 + rand() * 0.35);
}

// Sun: glow rings then disc, low on the horizon to the right of the spire
const SUN_X = 700, SUN_Y = 588;
for (let r = 210; r > 60; r -= 12) {
  fillCircle(SUN_X, SUN_Y, r, GOLD, 0.05 + (210 - r) * 0.0009);
}
fillCircle(SUN_X, SUN_Y, 58, SUN_CORE);
fillCircle(SUN_X, SUN_Y, 46, [255, 252, 230]);

// Clouds: soft horizontal peach ellipses
const clouds: Array<[number, number, number, number, RGB, number]> = [
  [250, 360, 185, 20, [255, 158, 122], 0.26],
  [780, 330, 205, 22, [255, 170, 130], 0.28],
  [600, 432, 160, 22, [255, 190, 150], 0.30],
  [180, 470, 140, 20, [255, 178, 140], 0.28],
  [850, 472, 150, 20, [255, 185, 145], 0.28],
  [430, 300, 130, 18, [255, 200, 165], 0.22],
];
for (const [cx, cy, rx, ry, col, a] of clouds) fillEllipse(cx, cy, rx, ry, col, a);

// ---------------------------------------------------------------- sea
vgrad(600, 1024, [
  [0.0, [63, 184, 166]],
  [0.3, [32, 140, 140]],
  [0.65, [14, 92, 102]],
  [1.0, [7, 48, 63]],
]);
// Bright horizon band
fillRect(0, 600, W, 4, [255, 214, 130], 0.55);

// Sun reflection: shimmering gold column under the sun
for (let y = 612; y < 990; y += 9) {
  const depth = (y - 600) / 390;
  const wdt = 30 + rand() * 110 * (0.4 + depth);
  const cx = SUN_X + (rand() - 0.5) * 34;
  fillRect(cx - wdt / 2, y, wdt, 4, GOLD, 0.30 * (1 - depth * 0.7));
}
// Lighthouse reflection column
for (let y = 632; y < 780; y += 12) {
  const depth = (y - 620) / 160;
  fillRect(505 - 26 + rand() * 20, y, 34 + rand() * 26, 4, GOLD, 0.16 * (1 - depth * 0.6));
}
// Wave lines: gentle sine strokes, denser near the bottom
for (let i = 0; i < 46; i++) {
  const yBase = 640 + i * 8.4;
  const phase = i * 1.7;
  for (let x = 0; x < W; x += 18) {
    const y = yBase + Math.sin(x * 0.012 + phase) * 3;
    fillRect(x, y, 12, 2, TEAL_LIGHT, 0.07 + (i % 5 === 0 ? 0.06 : 0));
  }
}

// ---------------------------------------------------------------- rock spire
fillPoly(
  [[398, 622], [438, 522], [452, 448], [470, 398], [486, 392], [524, 392], [540, 448], [556, 520], [612, 622]],
  ROCK,
);
// Warm rim light on the sun side of the rock
thickLine(548, 448, 606, 612, 6, [224, 112, 79], 0.55);
thickLine(540, 448, 524, 396, 5, [224, 112, 79], 0.35);
// Shadow facet on the far side
fillPoly([[398, 622], [438, 522], [452, 448], [470, 398], [452, 470], [430, 560], [420, 622]], [30, 20, 42], 0.5);

// ---------------------------------------------------------------- lighthouse
// Tapered tower, striped cream / coral
const towerTopY = 304, towerBotY = 445;
const topHalf = 23, botHalf = 37;
function towerHalfAt(y: number): number {
  const t = (y - towerTopY) / (towerBotY - towerTopY);
  return topHalf + (botHalf - topHalf) * t;
}
const bands: Array<[number, number, RGB]> = [
  [304, 332, CREAM],
  [332, 360, CORAL],
  [360, 388, CREAM],
  [388, 416, CORAL],
  [416, 445, CREAM],
];
for (const [yA, yB, col] of bands) {
  const hA = towerHalfAt(yA), hB = towerHalfAt(yB);
  fillPoly([[505 - hA, yA], [505 + hA, yA], [505 + hB, yB], [505 - hB, yB]], col);
}
// Right-side shading on the tower for roundness
fillPoly([[505, 304], [505 + topHalf, 304], [505 + botHalf, 445], [505, 445]], [0, 0, 0], 0.10);
// Gallery deck
fillRect(474, 286, 62, 18, [46, 31, 51]);
fillRect(478, 290, 3, 12, CREAM, 0.5);
fillRect(492, 290, 3, 12, CREAM, 0.5);
fillRect(506, 290, 3, 12, CREAM, 0.5);
fillRect(520, 290, 3, 12, CREAM, 0.5);
// Lamp room
fillRect(488, 256, 34, 30, [46, 31, 51]);
fillRect(492, 260, 26, 22, [255, 233, 168]);
fillRect(503, 260, 4, 22, [46, 31, 51]);
fillRect(492, 269, 26, 3, [46, 31, 51], 0.6);
// Dome + finial
fillEllipse(505, 256, 20, 10, [46, 31, 51]);
fillCircle(505, 242, 3, [46, 31, 51]);
fillRect(503, 236, 4, 8, [46, 31, 51]);

// Light beam sweeping left across the dusk sky (one light source, visible effect)
fillPoly([[496, 268], [170, 228], [170, 330], [496, 288]], GOLD, 0.16);
fillPoly([[514, 268], [830, 232], [830, 300], [514, 288]], GOLD, 0.08);
// Lamp glow
fillCircle(505, 271, 78, GOLD, 0.13);
fillCircle(505, 271, 44, GOLD, 0.22);

// Lantern village: tiny lit houses hugging the spire's base — the stay itself
function house(hx: number, hy: number, s: number): void {
  const w = 34 * s, h = 26 * s;
  fillRect(hx - w / 2, hy - h, w, h, [40, 27, 48]);
  fillPoly([[hx - w / 2 - 4 * s, hy - h], [hx, hy - h - 16 * s], [hx + w / 2 + 4 * s, hy - h]], [228, 87, 74]);
  fillRect(hx - 5 * s, hy - h + 9 * s, 10 * s, 9 * s, GOLD);
  fillRect(hx + 8 * s, hy - h + 8 * s, 6 * s, 6 * s, GOLD, 0.85);
}
house(425, 608, 0.9);
house(588, 608, 0.85);
house(458, 618, 0.7);
house(556, 618, 0.65);

// ---------------------------------------------------------------- lantern boats
function boat(bx: number, by: number, s: number, flip: boolean): void {
  const dir = flip ? -1 : 1;
  // Hull
  fillPoly(
    [[bx - 34 * s, by], [bx + 34 * s, by], [bx + 22 * s, by + 20 * s], [bx - 22 * s, by + 20 * s]],
    [38, 26, 46],
  );
  // Mast + lantern
  thickLine(bx, by, bx, by - 42 * s, 3, [38, 26, 46]);
  fillCircle(bx, by - 48 * s, 7 * s, GOLD);
  fillCircle(bx, by - 48 * s, 15 * s, GOLD, 0.30);
  // Small flag
  fillPoly([[bx, by - 42 * s], [bx + 14 * s * dir, by - 37 * s], [bx, by - 32 * s]], CORAL);
  // Lantern light on the water
  fillRect(bx - 18 * s, by + 26 * s, 36 * s, 3, GOLD, 0.30);
  fillRect(bx - 10 * s, by + 34 * s, 20 * s, 3, GOLD, 0.18);
}
boat(300, 700, 1.0, false);
boat(772, 782, 0.8, true);
boat(176, 852, 0.62, false);

// ---------------------------------------------------------------- birds
function bird(bx: number, by: number, s: number): void {
  thickLine(bx - 10 * s, by - 4 * s, bx, by + 3 * s, 3, DARK, 0.85);
  thickLine(bx, by + 3 * s, bx + 10 * s, by - 4 * s, 3, DARK, 0.85);
}
bird(300, 330, 1.0);
bird(352, 372, 0.8);
bird(742, 312, 1.0);
bird(688, 356, 0.8);
bird(252, 428, 0.9);
bird(818, 398, 0.7);

// ---------------------------------------------------------------- foreground headlands
fillPoly([[0, 1024], [0, 952], [60, 918], [150, 928], [210, 962], [190, 1024]], [32, 20, 46]);
fillPoly([[1024, 1024], [1024, 940], [950, 912], [880, 930], [850, 968], [880, 1024]], [32, 20, 46]);
// Lantern posts on the headlands
function lanternPost(px: number, py: number): void {
  thickLine(px, py, px, py - 30, 3, [32, 20, 46]);
  fillCircle(px, py - 36, 6, GOLD);
  fillCircle(px, py - 36, 14, GOLD, 0.30);
}
lanternPost(92, 920);
lanternPost(938, 914);
// Tiny wildflowers on the headland tops
const flowers: Array<[number, number, RGB]> = [
  [70, 924, [255, 158, 187]], [120, 922, [255, 246, 220]], [160, 934, [255, 158, 187]],
  [60, 940, [255, 210, 122]], [905, 922, [255, 246, 220]], [960, 924, [255, 158, 187]],
  [895, 938, [255, 210, 122]], [130, 940, [255, 210, 122]],
];
for (const [fx, fy, fc] of flowers) fillCircle(fx, fy, 3, fc, 0.9);

// ---------------------------------------------------------------- border
fillRect(24, 24, 976, 6, CREAM, 0.92);
fillRect(24, 994, 976, 6, CREAM, 0.92);
fillRect(24, 24, 6, 976, CREAM, 0.92);
fillRect(994, 24, 6, 976, CREAM, 0.92);
fillRect(40, 40, 944, 2, CREAM, 0.45);
fillRect(40, 982, 944, 2, CREAM, 0.45);
fillRect(40, 40, 2, 944, CREAM, 0.45);
fillRect(982, 40, 2, 944, CREAM, 0.45);

// ---------------------------------------------------------------- type
drawText("LUMARIS", 512, 70, 18, 24, CREAM, [42, 27, 69]);
drawText("WHERE THE SEA GLOWS AT DUSK", 512, 214, 4, 6, CREAM, [42, 27, 69]);

// ---------------------------------------------------------------- PNG encode
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  const crcData = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  out.writeUInt32BE(crc32(crcData), 8 + data.length);
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function encodePng(): Buffer {
  const stride = W * 3;
  const raw = Buffer.alloc(H * (stride + 1));
  const prev = new Uint8Array(stride);
  for (let y = 0; y < H; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 4; // Paeth filter
    const src = y * stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= 3 ? buf[src + i - 3] : 0;
      const up = prev[i];
      const upLeft = i >= 3 ? prev[i - 3] : 0;
      raw[rowStart + 1 + i] = (buf[src + i] - paeth(left, up, upLeft)) & 0xff;
    }
    prev.set(buf.subarray(src, src + stride));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "entry.png"), encodePng());
