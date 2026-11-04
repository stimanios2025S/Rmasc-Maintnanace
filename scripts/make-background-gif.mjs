/**
 * Fabrique l'arrière-plan animé de l'interface à partir d'une image PNG.
 *
 * Le dépôt ne contient pas de GIF animé prêt à l'emploi : ce script décode
 * l'image fournie dans `public/bg-fallback.png`, la quantifie en 256 couleurs et
 * produit un GIF89a à deux images — l'originale et un léger panoramique — pour
 * que le fond soit réellement animé sans dépendre d'une bibliothèque externe.
 *
 *   node scripts/make-background-gif.mjs
 *
 * Les deux images sont des vues complètes : le défilement de la page ne les
 * étire pas, puisque le CSS les fixe (`background-attachment` / couche
 * `position: fixed`).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const SOURCE = "public/bg-fallback.png";
const TARGET = "public/bg-animated.gif";
const FRAME_DELAY = 140; // centièmes de seconde — 1,4 s par image

// ─── Lecture du PNG ─────────────────────────────────────────

const png = readFileSync(SOURCE);
if (png.slice(0, 8).toString("hex") !== "89504e470d0a1a0a") {
  throw new Error("Le fichier source n'est pas un PNG.");
}

let offset = 8;
let width = 0;
let height = 0;
const idat = [];

while (offset < png.length) {
  const length = png.readUInt32BE(offset);
  const type = png.toString("ascii", offset + 4, offset + 8);
  const chunk = png.subarray(offset + 8, offset + 8 + length);

  if (type === "IHDR") {
    width = chunk.readUInt32BE(0);
    height = chunk.readUInt32BE(4);
    const bitDepth = chunk[8];
    const colorType = chunk[9];
    const interlace = chunk[12];
    if (bitDepth !== 8 || colorType !== 2 || interlace !== 0) {
      throw new Error(
        `PNG non pris en charge (profondeur ${bitDepth}, type ${colorType}, entrelacement ${interlace}).`
      );
    }
  } else if (type === "IDAT") {
    idat.push(chunk);
  } else if (type === "IEND") {
    break;
  }

  offset += 12 + length;
}

const raw = inflateSync(Buffer.concat(idat));
const bpp = 3;
const stride = width * bpp;
const pixels = Buffer.alloc(height * stride);

let position = 0;
for (let y = 0; y < height; y++) {
  const filter = raw[position++];
  const line = raw.subarray(position, position + stride);
  position += stride;

  const previous =
    y > 0
      ? pixels.subarray((y - 1) * stride, y * stride)
      : Buffer.alloc(stride);
  const current = pixels.subarray(y * stride, (y + 1) * stride);

  for (let x = 0; x < stride; x++) {
    const left = x >= bpp ? current[x - bpp] : 0;
    const up = previous[x];
    const upLeft = x >= bpp ? previous[x - bpp] : 0;
    const value = line[x];

    let decoded;
    switch (filter) {
      case 0:
        decoded = value;
        break;
      case 1:
        decoded = value + left;
        break;
      case 2:
        decoded = value + up;
        break;
      case 3:
        decoded = value + Math.floor((left + up) / 2);
        break;
      case 4: {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        decoded = value + predictor;
        break;
      }
      default:
        throw new Error(`Filtre PNG inconnu : ${filter}`);
    }

    current[x] = decoded & 0xff;
  }
}

// ─── Quantification et trames ───────────────────────────────

/** Palette 3-3-2 : 8 niveaux de rouge, 8 de vert, 4 de bleu. */
const palette = Buffer.alloc(256 * 3);
for (let i = 0; i < 256; i++) {
  palette[i * 3] = Math.round((((i >> 5) & 7) * 255) / 7);
  palette[i * 3 + 1] = Math.round((((i >> 2) & 7) * 255) / 7);
  palette[i * 3 + 2] = Math.round(((i & 3) * 255) / 3);
}

function quantize(shiftX, shiftY) {
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(width - 1, x + shiftX);
      const sy = Math.min(height - 1, y + shiftY);
      const at = (sy * width + sx) * 3;
      const r = pixels[at];
      const g = pixels[at + 1];
      const b = pixels[at + 2];
      indices[y * width + x] = ((r >> 5) << 5) | ((g >> 5) << 2) | (b >> 6);
    }
  }
  return indices;
}

// ─── Compression LZW du GIF ─────────────────────────────────

function lzwEncode(indices, minCodeSize = 8) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  const dictionary = new Map();
  const output = [];

  let bitBuffer = 0;
  let bitCount = 0;

  const writeCode = (code) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      output.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  };

  writeCode(clearCode);

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const next = indices[i];
    const key = (prefix << 8) | next;
    const known = dictionary.get(key);

    if (known !== undefined) {
      prefix = known;
      continue;
    }

    writeCode(prefix);

    if (nextCode < 4096) {
      dictionary.set(key, nextCode++);
      if (nextCode === 1 << codeSize && codeSize < 12) codeSize++;
    } else {
      writeCode(clearCode);
      dictionary.clear();
      codeSize = minCodeSize + 1;
      nextCode = endCode + 1;
    }

    prefix = next;
  }

  writeCode(prefix);
  writeCode(endCode);

  if (bitCount > 0) output.push(bitBuffer & 0xff);
  return Buffer.from(output);
}

// ─── Assemblage du GIF ──────────────────────────────────────

function blockTerminator(buffer) {
  const parts = [];
  for (let at = 0; at < buffer.length; at += 255) {
    const chunk = buffer.subarray(at, Math.min(at + 255, buffer.length));
    parts.push(Buffer.from([chunk.length]), chunk);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function imageDescriptor(width, height) {
  const descriptor = Buffer.alloc(10);
  descriptor[0] = 0x2c;
  descriptor.writeUInt16LE(0, 1);
  descriptor.writeUInt16LE(0, 3);
  descriptor.writeUInt16LE(width, 5);
  descriptor.writeUInt16LE(height, 7);
  descriptor[9] = 0;
  return descriptor;
}

function graphicControl(delay) {
  const control = Buffer.alloc(8);
  control[0] = 0x21;
  control[1] = 0xf9;
  control[2] = 0x04;
  control[3] = 0x04; // disposal 1, pas de transparence
  control.writeUInt16LE(delay, 4);
  control[6] = 0;
  control[7] = 0;
  return control;
}

const frames = [quantize(0, 0), quantize(10, 5)];

const parts = [];
parts.push(Buffer.from("GIF89a", "ascii"));

const screen = Buffer.alloc(7);
screen.writeUInt16LE(width, 0);
screen.writeUInt16LE(height, 2);
screen[4] = 0xf7; // table globale, 256 couleurs
screen[5] = 0;
screen[6] = 0;
parts.push(screen);
parts.push(palette);

// Boucle infinie (extension NETSCAPE2.0).
parts.push(
  Buffer.from([
    0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32,
    0x2e, 0x30, 0x03, 0x01, 0x00, 0x00, 0x00,
  ])
);

for (const frame of frames) {
  parts.push(graphicControl(FRAME_DELAY));
  parts.push(imageDescriptor(width, height));
  parts.push(Buffer.from([8]));
  parts.push(blockTerminator(lzwEncode(frame)));
}

parts.push(Buffer.from([0x3b]));

const gif = Buffer.concat(parts);
writeFileSync(TARGET, gif);
console.log(
  `${TARGET} — ${width}x${height}, ${frames.length} images, ${Math.round(
    gif.length / 1024
  )} Ko`
);
