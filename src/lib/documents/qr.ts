/**
 * Les QR codes des appareils — sans dépendance.
 *
 * POURQUOI CE MODULE EST ÉCRIT ICI PLUTÔT QU'INSTALLÉ
 * Le QR collé sur une machine est le seul chemin par lequel un gardien ou un
 * syndic entre dans l'application. Il doit donc exister hors ligne, dans un
 * déploiement local, et sans qu'une bibliothèque supplémentaire soit téléchargée
 * au moment où l'on en a besoin. Ce module encode donc lui-même la norme
 * ISO/IEC 18004, en mode octet et au niveau de correction M — le niveau qui
 * laisse une marque lisible même abîmée, sans gonfler la matrice.
 *
 * CE QU'IL COUVRE, ET CE QU'IL NE COUVRE PAS
 * Versions 1 à 10 (jusqu'à 213 octets utiles), un seul mode — octets —, et les
 * huit masques essayés pour retenir celui qui se lit le mieux. C'est tout ce
 * qu'une URL de scan demande. Un texte plus long lève une erreur nommée plutôt
 * que de produire un QR silencieusement faux.
 *
 * Module serveur : le rendu PNG passe par `node:zlib`. La matrice et le SVG,
 * eux, ne dépendent de rien.
 */

import { deflateSync } from "node:zlib";

// ─── Tables de la version 1 à 10, niveau M ──────────────────

interface BlockSpec {
  count: number;
  dataCodewords: number;
}

interface VersionSpec {
  totalCodewords: number;
  ecPerBlock: number;
  blocks: readonly BlockSpec[];
}

/**
 * La capacité de chaque version au niveau M.
 *
 * `totalCodewords` est le nombre total de mots du symbole (données + correction) ;
 * la somme des blocs doit toujours y mener, et c'est vérifié à l'import — une
 * table fausse produirait un QR qui se lit de travers sans jamais lever.
 */
const VERSIONS_M: readonly VersionSpec[] = [
  { totalCodewords: 26, ecPerBlock: 10, blocks: [{ count: 1, dataCodewords: 16 }] },
  { totalCodewords: 44, ecPerBlock: 16, blocks: [{ count: 1, dataCodewords: 28 }] },
  { totalCodewords: 70, ecPerBlock: 26, blocks: [{ count: 1, dataCodewords: 44 }] },
  { totalCodewords: 100, ecPerBlock: 18, blocks: [{ count: 2, dataCodewords: 32 }] },
  { totalCodewords: 134, ecPerBlock: 24, blocks: [{ count: 2, dataCodewords: 43 }] },
  { totalCodewords: 172, ecPerBlock: 16, blocks: [{ count: 4, dataCodewords: 27 }] },
  { totalCodewords: 196, ecPerBlock: 18, blocks: [{ count: 4, dataCodewords: 31 }] },
  {
    totalCodewords: 242,
    ecPerBlock: 22,
    blocks: [
      { count: 2, dataCodewords: 38 },
      { count: 2, dataCodewords: 39 },
    ],
  },
  {
    totalCodewords: 292,
    ecPerBlock: 22,
    blocks: [
      { count: 3, dataCodewords: 36 },
      { count: 2, dataCodewords: 37 },
    ],
  },
  {
    totalCodewords: 346,
    ecPerBlock: 26,
    blocks: [
      { count: 4, dataCodewords: 43 },
      { count: 1, dataCodewords: 44 },
    ],
  },
];

/** Les centres des motifs d'alignement, par version. */
const ALIGNMENT_POSITIONS: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** Bits du niveau M dans l'information de format (`00`). */
const EC_LEVEL_M_BITS = 0b00;

// ─── Corps de Galois GF(256) ────────────────────────────────

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

{
  let value = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Le polynôme générateur de Reed-Solomon pour `degree` mots de correction. */
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMultiply(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Les mots de correction d'un bloc de données. */
function rsRemainder(data: Uint8Array, degree: number): Uint8Array {
  const generator = rsGenerator(degree);
  const remainder = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[degree - 1] = 0;
    for (let i = 0; i < degree; i++) {
      remainder[i] ^= gfMultiply(generator[i + 1], factor);
    }
  }
  return remainder;
}

// ─── Encodage des données ───────────────────────────────────

function pushBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function dataCodewordCount(spec: VersionSpec): number {
  return spec.blocks.reduce(
    (sum, block) => sum + block.count * block.dataCodewords,
    0
  );
}

/**
 * Vérification de la table à l'import.
 *
 * Une ligne fausse produirait un symbole qui se dessine et ne se lit pas — le
 * pire défaut possible ici, parce qu'il n'apparaît qu'au scan, sur un téléphone,
 * chez un client. La somme des blocs doit mener exactement au nombre de mots
 * de la version ; si elle n'y mène pas, le module refuse de se charger.
 */
for (const [index, spec] of VERSIONS_M.entries()) {
  const blocks = spec.blocks.reduce((sum, block) => sum + block.count, 0);
  const total = dataCodewordCount(spec) + blocks * spec.ecPerBlock;
  if (total !== spec.totalCodewords) {
    throw new Error(
      `Table QR incohérente à la version ${index + 1} : ` +
        `${total} mots au lieu de ${spec.totalCodewords}.`
    );
  }
}

/**
 * Le message complet : données, bourrage, découpage en blocs, correction, puis
 * entrelacement — l'ordre dans lequel les blocs se répartissent dans la matrice.
 */
function buildCodewords(bytes: Uint8Array, spec: VersionSpec): Uint8Array {
  const capacity = dataCodewordCount(spec);
  const version = VERSIONS_M.indexOf(spec) + 1;
  const countBits = version <= 9 ? 8 : 16;

  const bits: number[] = [];
  pushBits(bits, 0b0100, 4); // mode octet
  pushBits(bits, bytes.length, countBits);
  for (const byte of bytes) pushBits(bits, byte, 8);

  if (bits.length > capacity * 8) {
    throw new Error(
      `QR trop long : ${bytes.length} octets pour ${capacity} disponibles ` +
        `en version ${version}.`
    );
  }

  // Terminateur, alignement sur l'octet, puis les deux octets de bourrage
  // alternés que la norme impose — sans eux, un lecteur lit du vide.
  const terminated = Math.min(4, capacity * 8 - bits.length);
  pushBits(bits, 0, terminated);
  while (bits.length % 8 !== 0) bits.push(0);

  const data = new Uint8Array(capacity);
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ?? 0);
    data[i / 8] = byte;
  }
  for (let i = bits.length / 8, pad = 0; i < capacity; i++, pad++) {
    data[i] = pad % 2 === 0 ? 0xec : 0x11;
  }

  const blocks: { data: Uint8Array; ec: Uint8Array }[] = [];
  let offset = 0;
  for (const group of spec.blocks) {
    for (let i = 0; i < group.count; i++) {
      const chunk = data.slice(offset, offset + group.dataCodewords);
      offset += group.dataCodewords;
      blocks.push({ data: chunk, ec: rsRemainder(chunk, spec.ecPerBlock) });
    }
  }

  const maxData = Math.max(...blocks.map((block) => block.data.length));
  const out: number[] = [];
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) {
      if (i < block.data.length) out.push(block.data[i]);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const block of blocks) out.push(block.ec[i]);
  }

  // Les bits de reste de la matrice valent zéro ; `placeData` les ajoute.
  return Uint8Array.from(out);
}

// ─── Construction de la matrice ─────────────────────────────

/** -1 : module de données pas encore écrit ; 0/1 : module fixe. */
type Matrix = Int8Array;

function setModule(
  matrix: Matrix,
  reserved: Uint8Array,
  size: number,
  row: number,
  col: number,
  dark: boolean
): void {
  if (row < 0 || row >= size || col < 0 || col >= size) return;
  matrix[row * size + col] = dark ? 1 : 0;
  reserved[row * size + col] = 1;
}

function drawFinder(
  matrix: Matrix,
  reserved: Uint8Array,
  size: number,
  row0: number,
  col0: number
): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const row = row0 + r;
      const col = col0 + c;
      if (row < 0 || row >= size || col < 0 || col >= size) continue;
      const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const dark =
        inside &&
        (r === 0 ||
          r === 6 ||
          c === 0 ||
          c === 6 ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      setModule(matrix, reserved, size, row, col, dark);
    }
  }
}

function drawAlignment(
  matrix: Matrix,
  reserved: Uint8Array,
  size: number,
  centerRow: number,
  centerCol: number
): void {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
      setModule(matrix, reserved, size, centerRow + r, centerCol + c, dark);
    }
  }
}

/** Une matrice vierge, avec ses motifs fonctionnels posés et réservés. */
function buildBase(
  size: number,
  version: number
): { matrix: Matrix; reserved: Uint8Array } {
  const matrix = new Int8Array(size * size).fill(-1);
  const reserved = new Uint8Array(size * size);

  drawFinder(matrix, reserved, size, 0, 0);
  drawFinder(matrix, reserved, size, 0, size - 7);
  drawFinder(matrix, reserved, size, size - 7, 0);

  // Les deux lignes de synchronisation, entre les trois repères.
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    setModule(matrix, reserved, size, 6, i, dark);
    setModule(matrix, reserved, size, i, 6, dark);
  }

  // Le module toujours sombre, à côté du repère inférieur gauche.
  setModule(matrix, reserved, size, size - 8, 8, true);

  // Les positions d'alignement, sauf celles qui recouvrent un repère.
  const positions = ALIGNMENT_POSITIONS[version - 1];
  for (const row of positions) {
    for (const col of positions) {
      const overlapsFinder =
        (row === 6 && col === 6) ||
        (row === 6 && col === size - 7) ||
        (row === size - 7 && col === 6);
      if (overlapsFinder) continue;
      drawAlignment(matrix, reserved, size, row, col);
    }
  }

  // L'information de format, réservée avant que les données ne s'y installent.
  //
  // La colonne 6 et la ligne 6 sont sautées : ce sont les deux lignes de
  // synchronisation, qui traversent cette zone et gardent leur motif alterné.
  // Les écraser avec la réservation du format laisserait un QR aux lignes de
  // synchronisation fausses — un défaut qu'aucun essai fonctionnel ne signale,
  // puisque le symbole se dessine quand même.
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) setModule(matrix, reserved, size, 8, i, false);
    if (i !== 6) setModule(matrix, reserved, size, i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    setModule(matrix, reserved, size, 8, size - 8 + i, false);
    setModule(matrix, reserved, size, size - 7 + i, 8, false);
  }

  // L'information de version, à partir de la version 7.
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        setModule(matrix, reserved, size, i, size - 11 + j, false);
        setModule(matrix, reserved, size, size - 11 + j, i, false);
      }
    }
  }

  return { matrix, reserved };
}

/** Le parcours en zigzag, de bas en haut puis de haut en bas. */
function placeData(
  matrix: Matrix,
  reserved: Uint8Array,
  size: number,
  bits: readonly number[]
): void {
  let index = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    // La colonne 6 est celle des synchronisations : on la saute par paires.
    if (right === 6) right = 5;

    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let c = 0; c < 2; c++) {
        const col = right - c;
        const position = row * size + col;
        if (reserved[position]) continue;
        matrix[position] = bits[index] ?? 0;
        index += 1;
      }
    }
    upward = !upward;
  }
}

function maskBit(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

function applyMask(
  matrix: Matrix,
  reserved: Uint8Array,
  size: number,
  mask: number
): void {
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const position = row * size + col;
      if (reserved[position]) continue;
      if (maskBit(mask, row, col)) matrix[position] ^= 1;
    }
  }
}

function bitLength(value: number): number {
  let length = 0;
  while (value !== 0) {
    length += 1;
    value >>>= 1;
  }
  return length;
}

function formatBits(mask: number): number {
  const data = (EC_LEVEL_M_BITS << 3) | mask;
  let remainder = data << 10;
  while (bitLength(remainder) - 11 >= 0) {
    remainder ^= 0x537 << (bitLength(remainder) - 11);
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

function versionBits(version: number): number {
  let remainder = version << 12;
  while (bitLength(remainder) - 13 >= 0) {
    remainder ^= 0x1f25 << (bitLength(remainder) - 13);
  }
  return (version << 12) | remainder;
}

function writeFormat(matrix: Matrix, size: number, mask: number): void {
  const bits = formatBits(mask);
  const put = (row: number, col: number, index: number) => {
    matrix[row * size + col] = (bits >>> index) & 1;
  };

  for (let i = 0; i < 15; i++) {
    // Première copie, autour du repère supérieur gauche.
    if (i < 6) put(8, i, i);
    else if (i === 6) put(8, 7, i);
    else if (i === 7) put(8, 8, i);
    else if (i === 8) put(7, 8, i);
    else put(14 - i, 8, i);

    // Seconde copie, répartie entre les deux autres repères.
    if (i < 7) put(size - 1 - i, 8, i);
    else put(8, size - 15 + i, i);
  }
}

function writeVersion(matrix: Matrix, size: number, version: number): void {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    matrix[Math.floor(i / 3) * size + (size - 11 + (i % 3))] = dark ? 1 : 0;
    matrix[(size - 11 + (i % 3)) * size + Math.floor(i / 3)] = dark ? 1 : 0;
  }
}

/** Le score de lisibilité de la norme — on retient le masque le plus bas. */
function penalty(matrix: Matrix, size: number): number {
  let score = 0;
  const at = (row: number, col: number) => matrix[row * size + col];

  // Règle 1 : les séries de cinq modules ou plus de la même couleur.
  for (let row = 0; row < size; row++) {
    let run = 1;
    for (let col = 1; col < size; col++) {
      if (at(row, col) === at(row, col - 1)) run += 1;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    if (run >= 5) score += run - 2;
  }
  for (let col = 0; col < size; col++) {
    let run = 1;
    for (let row = 1; row < size; row++) {
      if (at(row, col) === at(row - 1, col)) run += 1;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    if (run >= 5) score += run - 2;
  }

  // Règle 2 : les blocs 2 × 2 de la même couleur.
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const value = at(row, col);
      if (
        value === at(row, col + 1) &&
        value === at(row + 1, col) &&
        value === at(row + 1, col + 1)
      ) {
        score += 3;
      }
    }
  }

  // Règle 3 : le motif de repère déguisé, 1:1:3:1:1 entouré de quatre clairs.
  const pattern = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const reversed = [...pattern].reverse();
  const matches = (values: readonly number[]) =>
    values.every((value, index) => value === pattern[index]) ||
    values.every((value, index) => value === reversed[index]);

  for (let row = 0; row < size; row++) {
    for (let col = 0; col <= size - 11; col++) {
      const values: number[] = [];
      for (let i = 0; i < 11; i++) values.push(at(row, col + i));
      if (matches(values)) score += 40;
    }
  }
  for (let col = 0; col < size; col++) {
    for (let row = 0; row <= size - 11; row++) {
      const values: number[] = [];
      for (let i = 0; i < 11; i++) values.push(at(row + i, col));
      if (matches(values)) score += 40;
    }
  }

  // Règle 4 : l'écart de la proportion de modules sombres à 50 %.
  let dark = 0;
  for (let i = 0; i < size * size; i++) if (matrix[i] === 1) dark += 1;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

// ─── API publique ───────────────────────────────────────────

/**
 * La matrice de modules d'un texte, `true` pour un module sombre.
 *
 * Le résultat inclut les repères et les synchronisations ; il ne comprend pas
 * la zone de silence, que les rendus ajoutent.
 */
export function qrMatrix(text: string): boolean[][] {
  if (text.length === 0) throw new Error("QR impossible : le texte est vide.");

  const bytes = new TextEncoder().encode(text);
  let version = 1;
  for (; version <= VERSIONS_M.length; version++) {
    const spec = VERSIONS_M[version - 1];
    const capacityBits = dataCodewordCount(spec) * 8;
    const neededBits = 4 + (version <= 9 ? 8 : 16) + bytes.length * 8;
    if (neededBits <= capacityBits) break;
  }
  if (version > VERSIONS_M.length) {
    throw new Error(
      `QR impossible : ${bytes.length} octets dépassent la capacité d'une ` +
        `version 10 au niveau M (213 octets, indicateur de longueur compris).`
    );
  }

  const spec = VERSIONS_M[version - 1];
  const size = 17 + 4 * version;
  const codewords = buildCodewords(bytes, spec);

  const bits: number[] = [];
  for (const codeword of codewords) pushBits(bits, codeword, 8);

  const { matrix, reserved } = buildBase(size, version);
  placeData(matrix, reserved, size, bits);

  let best: { score: number; matrix: Matrix } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = Int8Array.from(matrix);
    applyMask(candidate, reserved, size, mask);
    writeFormat(candidate, size, mask);
    const score = penalty(candidate, size);
    if (!best || score < best.score) best = { score, matrix: candidate };
  }

  const chosen = best!.matrix;
  writeVersion(chosen, size, version);

  const rows: boolean[][] = [];
  for (let row = 0; row < size; row++) {
    const line: boolean[] = [];
    for (let col = 0; col < size; col++) {
      line.push(chosen[row * size + col] === 1);
    }
    rows.push(line);
  }
  return rows;
}

// ─── PNG ────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, checksum]);
}

/**
 * Le QR en PNG, en niveaux de gris.
 *
 * `scale` est le nombre de pixels par module. Le PNG est écrit à la main plutôt
 * que par une bibliothèque : treize octets d'en-tête, des lignes de pixels
 * dégonflées par `zlib`, et deux marqueurs — c'est moins de code que la
 * dépendance qu'il faudrait télécharger pour le faire.
 */
export function qrPng(text: string, scale = 6, quietZone = 4): Buffer {
  const matrix = qrMatrix(text);
  const side = (matrix.length + quietZone * 2) * scale;

  const raw = Buffer.alloc((side + 1) * side, 0xff);
  for (let y = 0; y < side; y++) {
    const rowStart = y * (side + 1);
    raw[rowStart] = 0; // filtre « None »
    const moduleRow = Math.floor(y / scale) - quietZone;
    for (let x = 0; x < side; x++) {
      const moduleCol = Math.floor(x / scale) - quietZone;
      if (moduleRow < 0 || moduleCol < 0) continue;
      if (moduleRow >= matrix.length || moduleCol >= matrix.length) continue;
      if (matrix[moduleRow][moduleCol]) raw[rowStart + 1 + x] = 0x00;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8; // 8 bits par échantillon
  header[9] = 0; // niveaux de gris
  header[10] = 0; // compression deflate
  header[11] = 0; // filtre adaptatif
  header[12] = 0; // pas d'entrelacement

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * L'adresse publique que le QR ouvre.
 *
 * `NEXTAUTH_URL` d'abord : c'est l'adresse que le déploiement a déclarée, et
 * celle qu'un téléphone doit atteindre. Le repli local n'existe que pour un
 * poste de développement où la variable manque.
 */
export function scanUrlFor(elevatorId: string): string {
  const base = (process.env.NEXTAUTH_URL ?? "http://localhost:3000").replace(
    /\/+$/,
    ""
  );
  return `${base}/scan/${encodeURIComponent(elevatorId)}`;
}
