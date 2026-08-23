// A QR encoder, because a phone has to point its camera at something.
//
// WhatsApp's linking QR is a ~200-character ASCII string the bridge receives
// over the wire; turning it into modules is the management page's job. The
// alternative was an npm dependency inside the Worker bundle for an algorithm
// that has not changed since 2006 — this is ISO/IEC 18004 byte mode at error
// correction level L, which is all a screen-displayed, seconds-lived QR needs.
//
// Level L only: it keeps the block tables to two arrays instead of eight, and
// nothing here ever encodes anything that has to survive being printed and
// smudged. Versions 1–40 are supported, so the size ceiling is the format's.
//
// The tests check output against `qrencode -l L -m 0 -t ASCII`, module for
// module, over strings shaped like the ones WhatsApp actually sends.

const ECC_CODEWORDS_PER_BLOCK_L = [
  -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30,
  30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
];

const NUM_ERROR_CORRECTION_BLOCKS_L = [
  -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14,
  15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
];

/** Level L's two format-info bits, per Table 12. */
const FORMAT_BITS_L = 1;

const MIN_VERSION = 1;
const MAX_VERSION = 40;

export class QrError extends Error {}

/** Total data+ECC modules available in a version, before the format overhead. */
function numRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(version: number): number {
  return (
    Math.floor(numRawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK_L[version]! * NUM_ERROR_CORRECTION_BLOCKS_L[version]!
  );
}

/** Row/column centres of the alignment patterns, ascending. */
function alignmentPatternPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = version * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// --- GF(256) -----------------------------------------------------------------
// Arithmetic modulo the QR field's primitive polynomial x^8+x^4+x^3+x^2+1.

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function reedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  // Multiply out (x - r^0)(x - r^1)…(x - r^(degree-1)), keeping only the
  // coefficients below x^degree; the leading 1 is implicit.
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < degree) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] = result[i]! ^ gfMultiply(divisor[i]!, factor);
  }
  return result;
}

// --- bit stream --------------------------------------------------------------

function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function encodeBytes(data: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(data.length, charCountBits(version));
  for (const b of data) push(b, 8);

  const capacityBits = numDataCodewords(version) * 8;
  push(0, Math.min(4, capacityBits - bits.length)); // terminator
  push(0, (8 - (bits.length % 8)) % 8); // pad to a whole codeword
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
    codewords.push(byte);
  }
  return codewords;
}

/** Split into blocks, append each block's ECC, and interleave the lot. */
function addEccAndInterleave(data: number[], version: number): number[] {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS_L[version]!;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK_L[version]!;
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks: number[][] = [];
  const eccBlocks: number[][] = [];
  const divisor = reedSolomonDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const length = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const block = data.slice(k, k + length);
    k += length;
    blocks.push(block);
    eccBlocks.push(reedSolomonRemainder(block, divisor));
  }

  const result: number[] = [];
  // Column-major over the blocks: codeword 0 of every block, then codeword 1,
  // and so on. Short blocks simply have nothing to contribute to the last
  // data column.
  for (let i = 0; i < shortBlockLen - blockEccLen + 1; i++) {
    for (let j = 0; j < numBlocks; j++) {
      if (i < blocks[j]!.length) result.push(blocks[j]![i]!);
    }
  }
  for (let i = 0; i < blockEccLen; i++) {
    for (let j = 0; j < numBlocks; j++) result.push(eccBlocks[j]![i]!);
  }
  return result;
}

// --- the matrix --------------------------------------------------------------

class Matrix {
  readonly size: number;
  readonly modules: boolean[][];
  /** Modules claimed by function patterns, which masking must not touch. */
  private reserved: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  private set(x: number, y: number, dark: boolean, reserve = true): void {
    this.modules[y]![x] = dark;
    if (reserve) this.reserved[y]![x] = true;
  }

  isReserved(x: number, y: number): boolean {
    return this.reserved[y]![x]!;
  }

  drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      // Timing patterns.
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);

    const align = alignmentPatternPositions(this.version);
    for (let i = 0; i < align.length; i++) {
      for (let j = 0; j < align.length; j++) {
        // The three corners already carry finder patterns.
        const corner =
          (i === 0 && j === 0) ||
          (i === 0 && j === align.length - 1) ||
          (i === align.length - 1 && j === 0);
        if (!corner) this.drawAlignment(align[i]!, align[j]!);
      }
    }

    // Format and version areas are reserved now and filled once the mask is
    // known; the dark module is permanent.
    this.reserveFormatAreas();
    if (this.version >= 7) this.drawVersion();
  }

  private drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
          this.set(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  private drawAlignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  private reserveFormatAreas(): void {
    for (let i = 0; i <= 8; i++) {
      if (i !== 6) {
        this.set(i, 8, false);
        this.set(8, i, false);
      }
    }
    // (6,8) and (8,6) belong to the timing patterns, not to the format area.
    for (let i = 0; i < 8; i++) {
      this.set(this.size - 1 - i, 8, false);
      this.set(8, this.size - 1 - i, false);
    }
    this.set(8, this.size - 8, true); // the always-dark module
  }

  drawFormat(mask: number): void {
    const data = (FORMAT_BITS_L << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;

    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));

    for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(i));
    this.set(8, this.size - 8, true);
  }

  private drawVersion(): void {
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  }

  /** The zigzag: two-module columns, right to left, skipping the timing column. */
  drawCodewords(codewords: number[]): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isReserved(x, y) && i < codewords.length * 8) {
            this.modules[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.isReserved(x, y)) continue;
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0; break;
          case 7: invert = ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0; break;
          default: throw new QrError(`mask ${mask} is not one of 0–7`);
        }
        if (invert) this.modules[y]![x] = !this.modules[y]![x];
      }
    }
  }

  /** Section 8.8.2's four penalty rules; lower is better. */
  penalty(): number {
    const N1 = 3, N2 = 3, N3 = 40, N4 = 10;
    let result = 0;
    const size = this.size;

    for (const transposed of [false, true]) {
      for (let i = 0; i < size; i++) {
        let runColor = false;
        let runLength = 0;
        const history = [0, 0, 0, 0, 0, 0, 0];
        for (let j = 0; j < size; j++) {
          const dark = transposed ? this.modules[j]![i]! : this.modules[i]![j]!;
          if (dark === runColor) {
            runLength++;
            if (runLength === 5) result += N1;
            else if (runLength > 5) result++;
          } else {
            this.pushRun(runLength, history);
            if (!runColor) result += this.finderPenaltyCount(history) * N3;
            runColor = dark;
            runLength = 1;
          }
        }
        result += this.finderPenaltyTerminate(runColor, runLength, history) * N3;
      }
    }

    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = this.modules[y]![x]!;
        if (
          c === this.modules[y]![x + 1]! &&
          c === this.modules[y + 1]![x]! &&
          c === this.modules[y + 1]![x + 1]!
        ) {
          result += N2;
        }
      }
    }

    let dark = 0;
    for (const row of this.modules) for (const cell of row) if (cell) dark++;
    const total = size * size;
    // How far the dark ratio strays from 50%, in whole 5% steps.
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * N4;
    return result;
  }

  private pushRun(run: number, history: number[]): void {
    if (history[0] === 0) history[0] = this.size; // light margin before the first run
    history.pop();
    history.unshift(run);
  }

  private finderPenaltyCount(history: number[]): number {
    const n = history[1]!;
    const core =
      n > 0 &&
      history[2] === n &&
      history[3] === n * 3 &&
      history[4] === n &&
      history[5] === n;
    return (
      (core && history[0]! >= n * 4 && history[6]! >= n ? 1 : 0) +
      (core && history[6]! >= n * 4 && history[0]! >= n ? 1 : 0)
    );
  }

  private finderPenaltyTerminate(runColor: boolean, runLength: number, history: number[]): number {
    let length = runLength;
    if (runColor) {
      this.pushRun(length, history);
      length = 0;
    }
    length += this.size; // light margin after the last run
    this.pushRun(length, history);
    return this.finderPenaltyCount(history);
  }
}

/**
 * Encode `text` as a QR symbol, returning one boolean row per module row.
 * The mask is chosen by penalty score, as the standard requires; there is no
 * quiet zone in the returned matrix.
 */
export function encodeQr(text: string): boolean[][] {
  const data = new TextEncoder().encode(text);
  let version = MIN_VERSION;
  for (; version <= MAX_VERSION; version++) {
    const capacity = numDataCodewords(version) * 8;
    if (4 + charCountBits(version) + data.length * 8 <= capacity) break;
  }
  if (version > MAX_VERSION) {
    throw new QrError(`${data.length} bytes will not fit in a level-L QR symbol`);
  }

  const codewords = addEccAndInterleave(encodeBytes(data, version), version);
  const matrix = new Matrix(version);
  matrix.drawFunctionPatterns();
  matrix.drawCodewords(codewords);

  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    matrix.applyMask(mask);
    matrix.drawFormat(mask);
    const penalty = matrix.penalty();
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
    matrix.applyMask(mask); // masking is its own inverse
  }
  matrix.applyMask(bestMask);
  matrix.drawFormat(bestMask);
  return matrix.modules;
}

/**
 * The same symbol as a standalone SVG. One `<rect>` per horizontal run of dark
 * modules rather than per module: a version-10 code is ~3,000 dark modules and
 * ~400 runs, which is the difference between a 200 KB response and a 20 KB one.
 */
export function qrSvg(text: string, options: { quietZone?: number; label?: string } = {}): string {
  const modules = encodeQr(text);
  const quiet = options.quietZone ?? 4;
  const size = modules.length + quiet * 2;
  const rects: string[] = [];
  for (let y = 0; y < modules.length; y++) {
    let runStart = -1;
    for (let x = 0; x <= modules[y]!.length; x++) {
      const dark = x < modules[y]!.length && modules[y]![x]!;
      if (dark && runStart < 0) runStart = x;
      if (!dark && runStart >= 0) {
        rects.push(`<rect x="${runStart + quiet}" y="${y + quiet}" width="${x - runStart}" height="1"/>`);
        runStart = -1;
      }
    }
  }
  const title = options.label ? `<title>${options.label}</title>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 8}" height="${size * 8}" shape-rendering="crispEdges" role="img">${title}<rect width="${size}" height="${size}" fill="#fff"/><g fill="#000">${rects.join("")}</g></svg>`;
}
