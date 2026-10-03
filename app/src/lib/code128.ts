/**
 * Code 128, subset C: the symbology Finnish banks scan the virtuaaliviivakoodi from
 * (Finanssiala's "Pankkiviivakoodi" guide). Subset C packs two digits per symbol, so the
 * 54-digit code is 27 symbols between the start, the checksum and the stop.
 *
 * Each pattern lists bar/space widths in modules, starting with a bar.
 */
export const CODE128_PATTERNS: readonly string[] = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

const START_C = 105;
const STOP = 106;

/** The code values for a digit string: start C, the digit pairs, the mod-103 checksum, stop. */
export function code128cValues(digits: string): number[] {
  if (!/^(\d\d)+$/.test(digits)) throw new RangeError("Code 128 C needs an even number of digits");
  const pairs: number[] = [];
  for (let i = 0; i < digits.length; i += 2) pairs.push(Number(digits.slice(i, i + 2)));
  const checksum = pairs.reduce((sum, value, index) => sum + value * (index + 1), START_C) % 103;
  return [START_C, ...pairs, checksum, STOP];
}

/** Alternating bar/space widths in modules, starting and ending with a bar. */
export function code128cBars(digits: string): number[] {
  return code128cValues(digits).flatMap((value) => [...CODE128_PATTERNS[value]].map(Number));
}

export interface BarRect { x: number; y: number; width: number; height: number }

/** 0.5 mm in PDF points: the widest module the bank guide allows. */
const MAX_MODULE = 1.417;
const QUIET_MODULES = 10;

/**
 * Bars as rectangles for a PDF: the module is as wide as fits (at most 0.5 mm) with a ten-module
 * quiet zone on both sides, which scanners need to find the start.
 */
export function barcodeRects(
  digits: string,
  box: { x: number; y: number; maxWidth: number; height: number }
): { rects: BarRect[]; module: number; width: number } {
  const bars = code128cBars(digits);
  const modules = bars.reduce((sum, w) => sum + w, 0) + 2 * QUIET_MODULES;
  const moduleWidth = Math.min(MAX_MODULE, box.maxWidth / modules);
  const rects: BarRect[] = [];
  let x = box.x + QUIET_MODULES * moduleWidth;
  bars.forEach((width, index) => {
    if (index % 2 === 0) rects.push({ x, y: box.y, width: width * moduleWidth, height: box.height });
    x += width * moduleWidth;
  });
  return { rects, module: moduleWidth, width: modules * moduleWidth };
}
