// PT7 scan tracer on hand-built images: every expected value is known by
// construction (the line equation), so the tests are goldens without a
// file. Image = {width, height, data RGBA}, the getImageData shape.

import {
  rgbToHsv, hexToRgb, rgbToHex, normalizeRoi, sampleRoiColor, colorMask,
  medianFilterMask, scanlineTrace, rejectOutliers, thinPoints, simplifyPoints,
  traceColorRoi,
} from '../engines/petrophysics/scanTrace.js';

function blank(w, h, rgb = [255, 255, 255]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}
function put(img, x, y, rgb) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2]; img.data[i + 3] = 255;
}
/** 3 px wide line x = x0 + slope*y over the whole height. */
function line(img, x0, slope, rgb, width = 3) {
  for (let y = 0; y < img.height; y++) {
    const xc = Math.round(x0 + slope * y);
    for (let dx = -(width >> 1); dx <= (width >> 1); dx++) put(img, xc + dx, y, rgb);
  }
}
function hline(img, y, rgb) { for (let x = 0; x < img.width; x++) put(img, x, y, rgb); }
function vline(img, x, rgb) { for (let y = 0; y < img.height; y++) put(img, x, y, rgb); }

const RED = [255, 0, 0];
const BLACK = [0, 0, 0];
const GRAY = [160, 160, 160];
const BLUE = [0, 0, 255];

describe('colour helpers', () => {
  test('rgbToHsv follows the OpenCV 8-bit convention', () => {
    expect(rgbToHsv(255, 0, 0)).toEqual({ h: 0, s: 255, v: 255 });
    expect(rgbToHsv(0, 255, 0)).toEqual({ h: 60, s: 255, v: 255 });
    expect(rgbToHsv(0, 0, 255)).toEqual({ h: 120, s: 255, v: 255 });
    expect(rgbToHsv(255, 255, 255)).toEqual({ h: 0, s: 0, v: 255 });
    expect(rgbToHsv(0, 0, 0)).toEqual({ h: 0, s: 0, v: 0 });
    expect(rgbToHsv(255, 0, 255).h).toBe(150); // magenta 300 deg -> 150
  });
  test('hex round trip', () => {
    expect(hexToRgb('#ff8000')).toEqual({ r: 255, g: 128, b: 0 });
    expect(hexToRgb('FF8000')).toEqual({ r: 255, g: 128, b: 0 });
    expect(hexToRgb('#fff')).toBeNull();
    expect(rgbToHex(255, 128, 0)).toBe('#ff8000');
  });
});

describe('ROI and colour sampling', () => {
  test('normalizeRoi accepts any corner order and clamps; too small throws', () => {
    const img = blank(50, 40);
    expect(normalizeRoi(img, { x1: 30, y1: 35, x2: 10, y2: 5 })).toEqual({ x1: 10, y1: 5, x2: 30, y2: 35, w: 20, h: 30 });
    expect(normalizeRoi(img, { x1: -5, y1: -5, x2: 500, y2: 500 })).toEqual({ x1: 0, y1: 0, x2: 50, y2: 40, w: 50, h: 40 });
    expect(normalizeRoi(img, null).w).toBe(50);
    expect(() => normalizeRoi(img, { x1: 0, y1: 0, x2: 2, y2: 10 })).toThrow(/too small/);
    expect(() => normalizeRoi(null, null)).toThrow(/Load an image/);
  });
  test('sampleRoiColor takes the median around the seed, so a seed on a red line reads red', () => {
    const img = blank(60, 100);
    line(img, 20, 0, RED);
    const c = sampleRoiColor(img, null, { seed: { x: 20, y: 50 }, window: 1 });
    expect(c).toMatchObject({ h: 0, s: 255, v: 255, hex: '#ff0000' });
    // ROI centre with no seed on a white field reads white
    const w = sampleRoiColor(img, { x1: 30, y1: 0, x2: 60, y2: 100 });
    expect(w.s).toBe(0);
    expect(w.v).toBe(255);
  });
});

describe('mask, filter, scanline', () => {
  test('colorMask isolates the seed colour; hue wraps; tolerance widens the band', () => {
    const img = blank(40, 10);
    line(img, 10, 0, RED, 1);
    line(img, 30, 0, BLUE, 1);
    const red = colorMask(img, null, rgbToHsv(...RED), 1);
    expect(red.count).toBe(10);
    expect(red.mask[0 * 40 + 10]).toBe(1);
    expect(red.mask[0 * 40 + 30]).toBe(0);
    // a slightly orange seed (hue 8) still catches pure red (hue 0) and, via the wrap, hue 178
    put(img, 5, 0, [255, 0, 20]); // hue ~ 177
    const orange = colorMask(img, null, { h: 8, s: 255, v: 255 }, 1);
    expect(orange.mask[10]).toBe(1);
    expect(orange.mask[5]).toBe(1);
    // white never matches a chromatic seed even at tolerance 3 (saturation floor 20)
    const wide = colorMask(img, null, rgbToHsv(...RED), 3);
    expect(wide.mask[1]).toBe(0);
  });
  test('an achromatic seed masks by value: black line found, light gray grid ignored', () => {
    const img = blank(40, 10);
    line(img, 10, 0, BLACK, 1);
    line(img, 30, 0, GRAY, 1);
    const m = colorMask(img, null, rgbToHsv(...BLACK), 1);
    expect(m.mask[10]).toBe(1);
    expect(m.mask[30]).toBe(0);
    expect(m.count).toBe(10);
  });
  test('medianFilterMask removes isolated speckle and keeps a 3 px line', () => {
    const w = 30; const h = 30;
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let dx = -1; dx <= 1; dx++) mask[y * w + 15 + dx] = 1;
    mask[5 * w + 3] = 1; // speckle
    const out = medianFilterMask(mask, w, h, 5);
    expect(out[5 * w + 3]).toBe(0);
    expect(out[10 * w + 15]).toBe(1);
    expect(out[10 * w + 14]).toBe(1);
    expect(out[10 * w + 16]).toBe(1);
  });
  test('scanlineTrace picks the longest run per row and skips empty rows', () => {
    const w = 20; const h = 4;
    const mask = new Uint8Array(w * h);
    // row 0: short run at 2..3 and long run at 10..14 -> midpoint 12
    mask[2] = 1; mask[3] = 1; for (let x = 10; x <= 14; x++) mask[x] = 1;
    // row 1: empty; row 2: single pixel at 7; row 3: run 0..1 -> 0.5
    mask[2 * w + 7] = 1; mask[3 * w] = 1; mask[3 * w + 1] = 1;
    const pts = scanlineTrace(mask, w, h);
    expect(pts).toEqual([
      { x: 12, y: 0, run: 5 }, { x: 7, y: 2, run: 1 }, { x: 0.5, y: 3, run: 2 },
    ]);
  });
});

describe('post-processing', () => {
  test('rejectOutliers drops a point far from its neighbourhood median', () => {
    const pts = Array.from({ length: 30 }, (_, y) => ({ x: 10 + y * 0.2, y }));
    pts[15] = { x: 90, y: 15 };
    const { points, rejected } = rejectOutliers(pts);
    expect(rejected).toBe(1);
    expect(points).toHaveLength(29);
    expect(points.find((p) => p.y === 15)).toBeUndefined();
  });
  test('thinPoints keeps at most target points and always the first', () => {
    const pts = Array.from({ length: 1000 }, (_, y) => ({ x: 1, y }));
    const t = thinPoints(pts, 100);
    expect(t.length).toBeLessThanOrEqual(101);
    expect(t[0]).toEqual({ x: 1, y: 0 });
    expect(t[t.length - 1]).toEqual({ x: 1, y: 999 });
    expect(thinPoints(pts, 5000)).toHaveLength(1000);
  });
  test('simplifyPoints reduces a straight line to its ends and keeps a corner', () => {
    const straight = Array.from({ length: 50 }, (_, y) => ({ x: 3 + 0.5 * y, y }));
    expect(simplifyPoints(straight, 0.75)).toEqual([straight[0], straight[49]]);
    const bent = [...Array.from({ length: 25 }, (_, y) => ({ x: 0, y })), ...Array.from({ length: 25 }, (_, i) => ({ x: i + 1, y: 25 + i }))];
    const s = simplifyPoints(bent, 0.5);
    expect(s[0]).toEqual({ x: 0, y: 0 });
    expect(s[s.length - 1]).toEqual({ x: 25, y: 49 });
    expect(s.length).toBeGreaterThanOrEqual(3);
    expect(s.length).toBeLessThan(10);
    expect(simplifyPoints(straight, 0)).toEqual(straight);
  });
});

describe('traceColorRoi (whole pipeline)', () => {
  test('recovers a sloping red line to within half a pixel, one point per row, y ascending', () => {
    const img = blank(200, 300);
    line(img, 40, 0.4, RED);
    const { points, stats } = traceColorRoi(img, { seed: { x: 40, y: 0 } });
    expect(points).toHaveLength(300);
    let prev = -1;
    for (const p of points) {
      expect(p.y).toBeGreaterThan(prev);
      prev = p.y;
      expect(Math.abs(p.x - (40 + 0.4 * p.y))).toBeLessThanOrEqual(0.5);
    }
    expect(stats.rows_hit).toBe(300);
    expect(stats.rejected).toBe(0);
    expect(stats.seed_color.hex).toBe('#ff0000');
    expect(stats.seed_color.achromatic).toBe(false);
  });
  test('the ROI centre picks the colour when no seed is given; a seedHex wins over the seed', () => {
    const img = blank(120, 100);
    line(img, 60, 0, RED);
    const auto = traceColorRoi(img, { roi: { x1: 40, y1: 0, x2: 80, y2: 100 } });
    expect(auto.points).toHaveLength(100);
    expect(auto.points.every((p) => Math.abs(p.x - 60) <= 0.5)).toBe(true);
    const byHex = traceColorRoi(img, { seedHex: '#ff0000', seed: { x: 5, y: 5 } });
    expect(byHex.points).toHaveLength(100);
    expect(byHex.stats.seed_at).toBeNull();
  });
  test('gray grid lines and a blue neighbour curve do not disturb a red trace', () => {
    const img = blank(200, 200);
    for (let y = 0; y < 200; y += 20) hline(img, y, GRAY);
    for (let x = 0; x < 200; x += 25) vline(img, x, GRAY);
    line(img, 150, 0, BLUE);
    line(img, 50, 0.3, RED);
    const { points } = traceColorRoi(img, { seedHex: '#ff0000' });
    expect(points.length).toBeGreaterThanOrEqual(190);
    expect(points.every((p) => Math.abs(p.x - (50 + 0.3 * p.y)) <= 0.5)).toBe(true);
  });
  test('a black curve on a white grid traces via the achromatic path and ignores light gray rules', () => {
    const img = blank(160, 120);
    for (let x = 0; x < 160; x += 20) vline(img, x, GRAY);
    line(img, 30, 0.5, BLACK);
    const { points, stats } = traceColorRoi(img, { seed: { x: 30, y: 0 } });
    expect(stats.seed_color.achromatic).toBe(true);
    expect(points.length).toBeGreaterThanOrEqual(115);
    expect(points.every((p) => Math.abs(p.x - (30 + 0.5 * p.y)) <= 0.5)).toBe(true);
  });
  test('the box limits the trace to its rows and columns', () => {
    const img = blank(100, 200);
    line(img, 50, 0, RED);
    const { points, stats } = traceColorRoi(img, { roi: { x1: 20, y1: 50, x2: 80, y2: 150 } });
    expect(points[0].y).toBe(50);
    expect(points[points.length - 1].y).toBe(149);
    expect(stats.roi).toEqual({ x1: 20, y1: 50, x2: 80, y2: 150 });
  });
  test('errors say what to do: no colour match, and an empty box', () => {
    const img = blank(100, 100);
    expect(() => traceColorRoi(img, { seedHex: '#ff0000' })).toThrow(/No pixels of the curve colour/);
    line(img, 50, 0, RED);
    expect(() => traceColorRoi(img, { roi: { x1: 0, y1: 0, x2: 30, y2: 100 }, seedHex: '#ff0000' })).toThrow(/No pixels/);
    expect(() => traceColorRoi(img, { roi: { x1: 0, y1: 0, x2: 2, y2: 100 } })).toThrow(/too small/);
  });
  test('thinning and simplify options apply in image coordinates', () => {
    const img = blank(100, 2000);
    line(img, 20, 0.02, RED);
    const thin = traceColorRoi(img, { seedHex: '#ff0000', target: 400 });
    expect(thin.points.length).toBeLessThanOrEqual(401);
    const simple = traceColorRoi(img, { seedHex: '#ff0000', simplify: 1 });
    expect(simple.points.length).toBeLessThan(60);
    expect(simple.points[0].y).toBe(0);
    expect(simple.points[simple.points.length - 1].y).toBe(1999);
  });
});
