#!/usr/bin/env node
//
// Generates the extension icons.
//
// The Chrome Web Store requires a 128px icon and Chrome uses 16/32/48 for
// the toolbar, extensions page and context menus. Drawing them in code
// rather than committing four opaque PNGs means the mark can be adjusted
// by editing numbers, and nobody has to find the original artboard a year
// from now.
//
// Deliberately no image library: a rounded square and two chevrons are
// simple enough to rasterise directly, and adding a dependency to draw
// them would be the tail wagging the dog. PNG encoding is signature +
// IHDR + IDAT + IEND, and zlib comes with Node.
//
// Usage:
//   node scripts/generate-icons.js           # write src/icons/*.png
//   node scripts/generate-icons.js --preview # ASCII preview, writes nothing

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "src", "icons");

const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4; // rendered at 4x and averaged down for smooth edges

// Matches --accent in dashboard.css, so the toolbar icon and the UI agree.
const BLUE = [37, 99, 235];
const WHITE = [255, 255, 255];

// ---- Geometry -----------------------------------------------------------
//
// All coordinates are normalised to a 1x1 square centred on (0, 0), so the
// same numbers describe every size.

function roundedSquareDistance(x, y, half, radius) {
  const qx = Math.abs(x) - half + radius;
  const qy = Math.abs(y) - half + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return Math.min(Math.max(qx, qy), 0) + outside - radius;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// A chevron: two segments meeting at a point. `direction` -1 points left
// (a "<"), +1 points right (a ">").
function chevronDistance(x, y, centreX, direction, reach, height) {
  // direction -1 puts the tip on the LEFT (a "<"), +1 on the right (">").
  const tipX = centreX + direction * reach;
  const armX = centreX - direction * reach;
  return Math.min(
    distanceToSegment(x, y, armX, -height, tipX, 0),
    distanceToSegment(x, y, tipX, 0, armX, height),
  );
}

// Returns [r, g, b, a] for a point, or null for transparent.
function shade(x, y) {
  if (roundedSquareDistance(x, y, 0.5, 0.22) > 0) return null;

  const stroke = 0.052;
  const inChevron =
    chevronDistance(x, y, -0.17, -1, 0.085, 0.15) < stroke ||
    chevronDistance(x, y, 0.17, 1, 0.085, 0.15) < stroke;

  return inChevron ? WHITE : BLUE;
}

function renderPixels(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SUPERSAMPLE);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / size - 0.5;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / size - 0.5;
          const colour = shade(x, y);
          if (colour) {
            r += colour[0]; g += colour[1]; b += colour[2]; hits += 1;
          }
        }
      }
      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const offset = (py * size + px) * 4;
      if (hits === 0) continue; // leave fully transparent
      // Average only the covered samples so edge pixels keep their colour
      // and fade via alpha, rather than darkening toward black.
      pixels[offset] = Math.round(r / hits);
      pixels[offset + 1] = Math.round(g / hits);
      pixels[offset + 2] = Math.round(b / hits);
      pixels[offset + 3] = Math.round((hits / samples) * 255);
    }
  }
  return pixels;
}

// ---- PNG encoding -------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // colour type: RGBA
  // 10..12 = compression, filter, interlace — all 0

  // Each scanline is prefixed with its filter byte; 0 means "none".
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- Run ----------------------------------------------------------------

if (process.argv.includes("--preview")) {
  const size = 32;
  const pixels = renderPixels(size);
  for (let y = 0; y < size; y += 1) {
    let row = "";
    for (let x = 0; x < size; x += 1) {
      const o = (y * size + x) * 4;
      const alpha = pixels[o + 3];
      if (alpha < 40) row += " ";
      else if (pixels[o] > 200) row += "#";   // white chevron
      else row += ".";                        // blue field
    }
    console.log(row);
  }
} else {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const size of SIZES) {
    const file = join(OUT_DIR, `icon-${size}.png`);
    writeFileSync(file, encodePng(size, renderPixels(size)));
    console.log(`  src/icons/icon-${size}.png`);
  }
  console.log(`\nWrote ${SIZES.length} icons.`);
}
