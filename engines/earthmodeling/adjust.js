// Well adjustment (Earth Modeling EM1, 2026-09-06): make a framework
// surface pass through the well tops it is tied to. The tie residual
// r_i = pick TVDSS - surface z (metres positive down) at each tie
// position is spread over the grid as a correction field and added to
// the surface. The field is the Franke-Little compact-support inverse
// distance interpolant
//
//   c(x) = sum_i w_i(x) r_i / (w_0 + sum_i w_i(x)),
//   w_i = ((R - d_i)+ / (R d_i))^2,  w_0 = 1 / R^2
//
// (Franke 1982, "Scattered data interpolation: tests of some methods",
// with a zero-valued background weight w_0). It equals r_i at the tie
// itself (w_i is unbounded there), halves at R/2 for a lone tie, falls
// continuously to zero at the radius R, and is zero wherever no tie is
// within R. Without w_0 a lone tie would correct the whole disc by r_i
// and step to zero at R, which the oracle caught. Pure functions, no
// I/O; validated against tools/validation/earthmodel/oracle_adjust.py
// through test-data/earthmodel/adjust_cases.json.

import { NULL_VALUE } from '../../lib/gridding/numeric';
import { isNull, gridXY, sampleAtXY } from '../../lib/gridding/gridmath';

/**
 * Correction field for one surface from its tie residuals.
 * @param {Array<{x:number,y:number,residualM:number}>} ties (null residuals skipped)
 * @param {{x0,y0,dx,dy,nx,ny,rotation_deg?}} spec
 * @param {number} radius influence radius (world units), > 0
 * @returns {{field: Float64Array, used: number}} correction per node (0 where untouched)
 */
export function residualField(ties, spec, radius) {
  if (!(radius > 0) || !Number.isFinite(radius)) throw new Error('Well adjustment needs an influence radius greater than zero.');
  const pts = (ties || []).filter((t) => Number.isFinite(t?.x) && Number.isFinite(t?.y) && Number.isFinite(t?.residualM));
  const { nx, ny } = spec;
  const field = new Float64Array(nx * ny);
  if (!pts.length) return { field, used: 0 };
  const w0 = 1 / (radius * radius);
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const w = gridXY(spec, r, c);
      let num = 0; let den = 0; let exact = null;
      for (const p of pts) {
        const d = Math.hypot(p.x - w.x, p.y - w.y);
        if (d >= radius) continue;
        if (d < 1e-9) { exact = p.residualM; break; }
        const wi = ((radius - d) / (radius * d)) ** 2;
        num += wi * p.residualM;
        den += wi;
      }
      field[r * nx + c] = exact !== null ? exact : den > 0 ? num / (w0 + den) : 0;
    }
  }
  return { field, used: pts.length };
}

/** Surface plus correction; null nodes stay null. Same array type out. */
export function applyCorrection(z, field) {
  if (z.length !== field.length) throw new Error('The correction field must share the surface frame.');
  const out = new (ArrayBuffer.isView(z) ? z.constructor : Float64Array)(z.length);
  for (let i = 0; i < z.length; i++) out[i] = isNull(z[i]) ? NULL_VALUE : z[i] + field[i];
  return out;
}

/**
 * @param {Array<Float32Array|Float64Array>} grids shallow -> deep
 * @param {{x0,y0,dx,dy,nx,ny}} spec
 * @param {Array<{well,top,x,y,tvdss,residualM,surfaceIndex:number}>} ties
 * @param {{radius:number, enabled?:boolean[]}} opts
 */
export function adjustSurfaces(grids, spec, ties, { radius, enabled = null } = {}) {
  const out = grids.slice();
  const report = [];
  const tiesAfter = [];
  for (let s = 0; s < grids.length; s++) {
    const on = enabled ? Boolean(enabled[s]) : true;
    const mine = (ties || []).filter((t) => t.surfaceIndex === s && Number.isFinite(t.residualM));
    if (!on || !mine.length) {
      report.push({ surface: s, ties: mine.length, adjusted: false, before: maxAbs(mine.map((t) => t.residualM)), after: null });
      continue;
    }
    const { field } = residualField(mine, spec, radius);
    out[s] = applyCorrection(grids[s], field);
    const after = mine.map((t) => {
      const zs = sampleAtXY(out[s], spec, t.x, t.y);
      const a = isNull(zs) ? null : t.tvdss - zs;
      tiesAfter.push({ well: t.well, top: t.top, surfaceIndex: s, before: t.residualM, after: a });
      return a;
    });
    report.push({ surface: s, ties: mine.length, adjusted: true, before: maxAbs(mine.map((t) => t.residualM)), after: maxAbs(after) });
  }
  return { grids: out, report, tiesAfter };
}

function maxAbs(vals) {
  const v = vals.filter((x) => Number.isFinite(x)).map(Math.abs);
  return v.length ? Math.max(...v) : null;
}

/** A default influence radius: three times the median spacing between ties. */
export function defaultRadius(ties, fallback = 1000) {
  const pts = (ties || []).filter((t) => Number.isFinite(t?.x) && Number.isFinite(t?.y));
  if (pts.length < 2) return fallback;
  const d = [];
  for (let i = 0; i < pts.length; i++) {
    let best = Infinity;
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      const h = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (h > 0 && h < best) best = h;
    }
    if (Number.isFinite(best)) d.push(best);
  }
  if (!d.length) return fallback;
  d.sort((a, b) => a - b);
  return 3 * d[Math.floor(d.length / 2)];
}
