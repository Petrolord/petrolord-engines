// Scan tracer (Petrophysics Studio PT7): follow one coloured curve
// through a scanned log image without a click per point.
//
// Pure functions over an {width, height, data} RGBA buffer (the shape
// canvas getImageData returns), no DOM, no OpenCV. The method is the
// repo's retired OpenCV routine ported faithfully, so behaviour is
// predictable and every step is unit-testable on hand-built images:
//
//   1. sample the curve colour (median HSV in a small window around a
//      seed pixel, or the ROI centre when no seed is given)
//   2. mask pixels within a hue/saturation/value window of that colour
//      (achromatic seeds, black or gray curves, fall back to a value
//      window with a saturation ceiling, since hue is meaningless there)
//   3. 5x5 median (majority) filter to drop speckle
//   4. per scan line, the midpoint of the LONGEST masked run (a curve
//      crosses a row once; grid lines and labels are short or elsewhere)
//   5. reject outliers against a running median, thin to a target count,
//      optionally Douglas-Peucker simplify
//
// Depth increases downward in every log scan this feeds, so points are
// one per image row and come back sorted by y ascending.

/** RGB (0..255) -> HSV in the OpenCV 8-bit convention: h 0..179, s 0..255, v 0..255. */
export function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const v = max;
  const d = max - min;
  const s = max === 0 ? 0 : Math.round((d / max) * 255);
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * ((g - b) / d);
    else if (max === g) h = 120 + 60 * ((b - r) / d);
    else h = 240 + 60 * ((r - g) / d);
    if (h < 0) h += 360;
  }
  return { h: Math.round(h / 2) % 180, s, v };
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;
}

const median = (arr) => {
  const b = [...arr].sort((x, y) => x - y);
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
};

function assertImage(img) {
  if (!img || !(img.width > 0) || !(img.height > 0) || !img.data || img.data.length < img.width * img.height * 4) {
    throw new Error('Load an image first.');
  }
}

/** Clamp a rectangle {x1,y1,x2,y2} (any corner order) to the image; null = whole image. */
export function normalizeRoi(img, roi) {
  assertImage(img);
  const W = img.width;
  const H = img.height;
  const r = roi || { x1: 0, y1: 0, x2: W, y2: H };
  const x1 = Math.max(0, Math.min(W - 1, Math.floor(Math.min(r.x1, r.x2))));
  const y1 = Math.max(0, Math.min(H - 1, Math.floor(Math.min(r.y1, r.y2))));
  const x2 = Math.max(0, Math.min(W, Math.ceil(Math.max(r.x1, r.x2))));
  const y2 = Math.max(0, Math.min(H, Math.ceil(Math.max(r.y1, r.y2))));
  const w = x2 - x1;
  const h = y2 - y1;
  if (w < 3 || h < 3) throw new Error('The box is too small. Drag a larger box around the curve and trace again.');
  return { x1, y1, x2, y2, w, h };
}

function pixelHsv(img, x, y) {
  const i = (y * img.width + x) * 4;
  return rgbToHsv(img.data[i], img.data[i + 1], img.data[i + 2]);
}

/**
 * Median HSV of a (2w+1)^2 window around the seed (image coordinates),
 * or around the ROI centre when no seed is given. The seed window is 3x3;
 * the centre fallback scales with the ROI (1..7 px) as the original did.
 * @returns {{h:number,s:number,v:number,hex:string,at:{x:number,y:number}}}
 */
export function sampleRoiColor(img, roi, { seed = null, window: win = null } = {}) {
  const R = normalizeRoi(img, roi);
  const cx = seed ? Math.round(seed.x) : R.x1 + (R.w >> 1);
  const cy = seed ? Math.round(seed.y) : R.y1 + (R.h >> 1);
  // a clicked seed sits ON the curve, so a 3x3 window keeps a thin line's
  // colour in the majority; the ROI-centre fallback scans wider
  const w = win != null ? win : (seed ? 1 : Math.max(1, Math.min(7, Math.min(R.w, R.h) >> 4)));
  const Hs = [];
  const Ss = [];
  const Vs = [];
  const Rs = [];
  const Gs = [];
  const Bs = [];
  for (let dy = -w; dy <= w; dy++) {
    const yy = Math.min(img.height - 1, Math.max(0, cy + dy));
    for (let dx = -w; dx <= w; dx++) {
      const xx = Math.min(img.width - 1, Math.max(0, cx + dx));
      const i = (yy * img.width + xx) * 4;
      const p = rgbToHsv(img.data[i], img.data[i + 1], img.data[i + 2]);
      Hs.push(p.h); Ss.push(p.s); Vs.push(p.v);
      Rs.push(img.data[i]); Gs.push(img.data[i + 1]); Bs.push(img.data[i + 2]);
    }
  }
  return {
    h: median(Hs), s: median(Ss), v: median(Vs),
    hex: rgbToHex(median(Rs), median(Gs), median(Bs)),
    at: { x: cx, y: cy },
  };
}

/** Seeds below this saturation are treated as black or gray (no usable hue). */
export const ACHROMATIC_S = 40;

/**
 * Binary mask (Uint8Array, ROI-local, 1 = curve colour) of pixels within
 * the tolerance window of the seed colour. tolerance f is clamped to
 * 0.5..3 and widens every band linearly (hue +-12f, saturation floor
 * s-60f, value floor v-80f), exactly the retired routine's bands.
 * Achromatic seeds use |v - seed.v| <= 80f with saturation <= 60f + 40.
 */
export function colorMask(img, roi, color, tolerance = 1) {
  const R = normalizeRoi(img, roi);
  const f = Math.max(0.5, Math.min(3, Number(tolerance) || 1));
  const mask = new Uint8Array(R.w * R.h);
  const achromatic = color.s < ACHROMATIC_S;
  const sLo = Math.max(20, color.s - 60 * f);
  const vLo = Math.max(20, color.v - 80 * f);
  let count = 0;
  for (let y = 0; y < R.h; y++) {
    for (let x = 0; x < R.w; x++) {
      const p = pixelHsv(img, R.x1 + x, R.y1 + y);
      let hit;
      if (achromatic) {
        hit = Math.abs(p.v - color.v) <= 80 * f && p.s <= 60 * f + ACHROMATIC_S;
      } else {
        // hue wraps at 180 in the OpenCV scale
        const dh = Math.min(Math.abs(p.h - color.h), 180 - Math.abs(p.h - color.h));
        hit = dh <= 12 * f && p.s >= sLo && p.v >= vLo;
      }
      if (hit) { mask[y * R.w + x] = 1; count += 1; }
    }
  }
  return { mask, w: R.w, h: R.h, roi: R, count };
}

/** Binary median (majority) filter, k x k, edges clamped. k odd, default 5. */
export function medianFilterMask(mask, w, h, k = 5) {
  const r = k >> 1;
  const out = new Uint8Array(w * h);
  const need = ((k * k) >> 1) + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          n += mask[yy * w + xx];
        }
      }
      out[y * w + x] = n >= need ? 1 : 0;
    }
  }
  return out;
}

/**
 * One point per row: the midpoint of the longest masked run. Rows with
 * no masked pixel are skipped. Coordinates are ROI-local.
 * @returns {Array<{x:number,y:number,run:number}>}
 */
export function scanlineTrace(mask, w, h) {
  const pts = [];
  for (let y = 0; y < h; y++) {
    let bestLen = 0;
    let bestStart = -1;
    let x = 0;
    while (x < w) {
      if (mask[y * w + x]) {
        const start = x;
        while (x < w && mask[y * w + x]) x += 1;
        const len = x - start;
        if (len > bestLen) { bestLen = len; bestStart = start; }
      } else {
        x += 1;
      }
    }
    if (bestLen > 0) pts.push({ x: bestStart + (bestLen - 1) / 2, y, run: bestLen });
  }
  return pts;
}

/**
 * Drop points whose x strays more than maxDev px from the median x of a
 * `win`-point neighbourhood (label fragments, grid crossings).
 */
export function rejectOutliers(points, { win = 9, maxDev = 25 } = {}) {
  const n = points.length;
  const half = win >> 1;
  const keep = [];
  let rejected = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n - 1, i + half);
    const md = median(points.slice(a, b + 1).map((p) => p.x));
    if (Math.abs(points[i].x - md) > maxDev) rejected += 1;
    else keep.push(points[i]);
  }
  return { points: keep, rejected };
}

/** Keep every k-th point so about `target` remain; the first and last points always stay. */
export function thinPoints(points, target = 1200) {
  if (!(target > 0) || points.length <= target) return points.slice();
  const step = Math.ceil(points.length / target);
  const last = points.length - 1;
  return points.filter((_, i) => i % step === 0 || i === last);
}

/** Douglas-Peucker on {x,y} points; epsilon in px. epsilon <= 0 returns a copy. */
export function simplifyPoints(points, epsilon) {
  if (!points || points.length < 3 || !(epsilon > 0)) return points ? points.slice() : [];
  const sq = (v) => v * v;
  const dist2 = (p, a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (!dx && !dy) return sq(p.x - a.x) + sq(p.y - a.y);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
    return sq(p.x - (a.x + t * dx)) + sq(p.y - (a.y + t * dy));
  };
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let k = -1;
    let m = 0;
    for (let t = i + 1; t < j; t++) {
      const q = dist2(points[t], points[i], points[j]);
      if (q > m) { m = q; k = t; }
    }
    if (k !== -1 && m > epsilon * epsilon) {
      keep[k] = 1;
      stack.push([i, k], [k, j]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * The whole pipeline. Points come back in IMAGE coordinates, one per
 * row hit, y ascending.
 * @param {{width:number,height:number,data:Uint8ClampedArray|Uint8Array}} img
 * @param {{roi?:{x1,y1,x2,y2}|null, tolerance?:number, seed?:{x,y}|null,
 *   seedHex?:string|null, target?:number, simplify?:number,
 *   minRows?:number}} opts  seedHex wins over seed when both are given
 * @returns {{points:Array<{x:number,y:number}>, stats:Object}}
 */
export function traceColorRoi(img, {
  roi = null, tolerance = 1, seed = null, seedHex = null, target = 1200, simplify = 0, minRows = 3,
} = {}) {
  const R = normalizeRoi(img, roi);
  let color;
  if (seedHex) {
    const rgb = hexToRgb(seedHex);
    if (!rgb) throw new Error(`Not a colour: ${seedHex}`);
    color = { ...rgbToHsv(rgb.r, rgb.g, rgb.b), hex: rgbToHex(rgb.r, rgb.g, rgb.b), at: null };
  } else {
    color = sampleRoiColor(img, R, { seed });
  }
  const m = colorMask(img, R, color, tolerance);
  if (m.count === 0) {
    throw new Error('No pixels of the curve colour inside the box. Shift-click a point on the curve to pick its colour, widen the tolerance, or move the box.');
  }
  const filtered = medianFilterMask(m.mask, m.w, m.h, 5);
  const raw = scanlineTrace(filtered, m.w, m.h);
  if (raw.length < minRows) {
    throw new Error('No curve detected inside the box. Shift-click a point on the curve to pick its colour, widen the tolerance, or move the box.');
  }
  const { points: kept, rejected } = rejectOutliers(raw);
  let pts = thinPoints(kept, target).map((p) => ({ x: p.x + R.x1, y: p.y + R.y1 }));
  if (simplify > 0) pts = simplifyPoints(pts, simplify);
  return {
    points: pts,
    stats: {
      roi: { x1: R.x1, y1: R.y1, x2: R.x2, y2: R.y2 },
      seed_color: { h: color.h, s: color.s, v: color.v, hex: color.hex, achromatic: color.s < ACHROMATIC_S },
      seed_at: color.at,
      tolerance: Math.max(0.5, Math.min(3, Number(tolerance) || 1)),
      masked_pixels: m.count,
      rows_total: R.h,
      rows_hit: raw.length,
      rejected,
      points: pts.length,
    },
  };
}
