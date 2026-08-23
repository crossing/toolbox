// The golden matrix and the version boundaries below were validated outside
// this suite against two independent implementations: `qrencode -8 -l L -m 0`
// (module-for-module identical output for byte strings of 1, 5, 217, 1000 and
// 2953 bytes) and zbar, which decoded every rendered symbol back to its input.
// Only the mask choice can legitimately differ between conforming encoders —
// the standard's finder-pattern penalty is worded ambiguously enough that
// libqrencode and this file disagree on one of the seven test strings, and
// both codes scan.

import { describe, expect, it } from "vitest";
import { encodeQr, qrSvg, QrError } from "../src/qr";

const HELLO = [
  "#######..#.##.#######",
  "#.....#..###..#.....#",
  "#.###.#.##.##.#.###.#",
  "#.###.#..#.#..#.###.#",
  "#.###.#...#.#.#.###.#",
  "#.....#.....#.#.....#",
  "#######.#.#.#.#######",
  "........##.##........",
  "###.########.##...#..",
  "...#....#.....#....#.",
  "#.#...#...#.#...#####",
  "##..#...#.#...#....#.",
  "#.#..##..##.#.#.#.#..",
  "........##.#.#.#..##.",
  "#######.#..#.###..###",
  "#.....#.######.##....",
  "#.###.#.#..#.###..###",
  "#.###.#...#...##..##.",
  "#.###.#.###.#...#.#.#",
  "#.....#.##....#.#..#.",
  "#######.##..#.##..###",
];

function render(matrix: boolean[][]): string[] {
  return matrix.map((row) => row.map((dark) => (dark ? "#" : ".")).join(""));
}

describe("encodeQr", () => {
  it("reproduces a known symbol exactly", () => {
    expect(render(encodeQr("HELLO"))).toEqual(HELLO);
  });

  it("picks the smallest version the data fits in", () => {
    // Byte-mode capacity at level L: 17 bytes in version 1, 32 in version 2,
    // 2953 in version 40. Each step adds four modules per side.
    expect(encodeQr("x".repeat(17)).length).toBe(21);
    expect(encodeQr("x".repeat(18)).length).toBe(25);
    expect(encodeQr("x".repeat(32)).length).toBe(25);
    expect(encodeQr("x".repeat(33)).length).toBe(29);
    expect(encodeQr("x".repeat(2953)).length).toBe(177);
  });

  it("refuses what will not fit", () => {
    expect(() => encodeQr("x".repeat(2954))).toThrow(QrError);
  });

  it("counts bytes, not characters", () => {
    // A WhatsApp ref is ASCII, but nothing here should assume that: "Ω" is
    // two UTF-8 bytes, so 9 of them will not fit where 17 ASCII bytes do.
    expect(encodeQr("Ω".repeat(8)).length).toBe(21);
    expect(encodeQr("Ω".repeat(9)).length).toBe(25);
  });

  it("holds a WhatsApp-sized pairing ref", () => {
    // ref,noise-key,identity-key,adv-secret — a little over 200 bytes.
    const qr = ["2@" + "A".repeat(70), "B".repeat(44), "C".repeat(44), "D".repeat(24)].join(",");
    expect(qr.length).toBeGreaterThan(180);
    expect(encodeQr(qr).length).toBe(49); // version 8, which holds 192 bytes
  });

  it("lays down the function patterns every decoder looks for", () => {
    const m = encodeQr("finder patterns");
    const size = m.length;
    for (const [cx, cy] of [
      [3, 3],
      [size - 4, 3],
      [3, size - 4],
    ]) {
      // 7×7 finder: dark ring, light ring, 3×3 dark core.
      expect(m[cy!]![cx!]).toBe(true);
      expect(m[cy! - 1]![cx! - 1]).toBe(true);
      expect(m[cy! - 2]![cx!]).toBe(false);
      expect(m[cy! - 3]![cx!]).toBe(true);
    }
    // Timing patterns alternate along row and column 6, starting dark at 8.
    for (let i = 8; i < size - 8; i++) {
      expect(m[6]![i]).toBe(i % 2 === 0);
      expect(m[i]![6]).toBe(i % 2 === 0);
    }
    // The module below the top-left format strip is always dark.
    expect(m[size - 8]![8]).toBe(true);
  });
});

describe("qrSvg", () => {
  it("wraps the symbol in a quiet zone and coalesces horizontal runs", () => {
    const svg = qrSvg("HELLO");
    // 21 modules + 4 on each side.
    expect(svg).toContain(`viewBox="0 0 29 29"`);
    // The top-left finder's first row is one 7-module run, not seven rects.
    expect(svg).toContain(`<rect x="4" y="4" width="7" height="1"/>`);
    const rects = svg.match(/<rect /g)?.length ?? 0;
    expect(rects).toBeLessThan(21 * 21);
  });

  it("is self-contained and safely embeddable", () => {
    const svg = qrSvg("2@abc,def", { label: "pairing code" });
    expect(svg.startsWith("<svg xmlns=")).toBe(true);
    expect(svg).toContain("<title>pairing code</title>");
    expect(svg).not.toContain("script");
  });
});
