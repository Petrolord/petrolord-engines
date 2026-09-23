// Synthetic field with exact truth (Tops to Horizons plan, TP0).
//
// An analytic layered earth: interfaces are depth surfaces (TVDSS, metres,
// positive down) over the survey lattice, each with a gentle dip and fold;
// layers between them carry an interval velocity and a density. Normal
// faults are dipping planes that drop the hanging wall by a known throw.
// An unconformity (surface type 'SU') truncates the dipping layers below it,
// so some tops are absent in some wells. Wells (vertical or deviated) carry
// exact tops (MD by bisection along the minimum-curvature path), a
// checkshot table, and sonic/density logs.
//
// Seismic traces are built analytically, not by sampling a spike train:
// trace(t) = sum_k RC_k * ricker(t - t_k), with t_k the interface's exact
// two-way time at that trace. So every horizon time, top time, event
// polarity and fault position is known exactly, and a picker can be scored
// against the truth to sub-sample precision.
//
// Pure math, deterministic, worker-safe, no I/O. Used by the engine gates
// and by the Suite's benchmark harness.

import { computeWellPath, positionAtMd } from './wellPath';
import { worldToIlxl, ilxlToWorld } from './surveyGeometry';
import { NULL_VALUE } from './manifest';

const NULL_F32 = Math.fround(NULL_VALUE);

/** Deterministic PRNG (mulberry32). */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal from a uniform PRNG (Box-Muller). */
function gauss(rng) {
  const u = Math.max(1e-12, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Ricker amplitude at time offset tMs for peak frequency fHz. */
export function ricker(tMs, fHz) {
  const x = (Math.PI * fHz * tMs / 1000) ** 2;
  return (1 - 2 * x) * Math.exp(-x);
}

/**
 * The default field: 70 x 60 lattice at 25 m, 4 ms, 30 Hz Ricker.
 *
 * Interfaces (top down):
 *   Seabed-like overburden to TOP_A (strong positive contrast, a peak);
 *   TOP_B (soft layer below: negative contrast, a trough);
 *   TOP_C and TOP_C2 only 8 m apart (below tuning, lambda/4 about 25 m);
 *   SU unconformity (surface type 'SU');
 *   TOP_D and TOP_E dip more steeply and are truncated by SU on the
 *   up-dip side, so they are absent in some wells.
 * One normal fault crossing the survey, throw 40 m, dip 60 degrees.
 */
export const DEFAULT_FIELD_SPEC = Object.freeze({
  nIl: 70,
  nXl: 60,
  binM: 25,
  dtMs: 4,
  ns: 420,
  freqHz: 30,
  origin: { x: 500000, y: 6000000 },
  overburden: { v: 2000, rho: 2.05 },
  interfaces: [
    {
      name: 'TOP_A', surfaceType: 'formation_top', z0: 700, gIl: 0.8, gXl: 0.4, fold: 12, v: 2600, rho: 2.3,
    },
    {
      name: 'TOP_B', surfaceType: 'formation_top', z0: 860, gIl: 0.8, gXl: 0.5, fold: 12, v: 2200, rho: 2.15,
    },
    {
      name: 'TOP_C', surfaceType: 'formation_top', z0: 1010, gIl: 0.9, gXl: 0.5, fold: 10, v: 2900, rho: 2.4,
    },
    {
      name: 'TOP_C2', surfaceType: 'formation_top', z0: 1018, gIl: 0.9, gXl: 0.5, fold: 10, v: 2500, rho: 2.25,
    },
    {
      name: 'SU', surfaceType: 'SU', z0: 1150, gIl: 0.6, gXl: 0.3, fold: 6, v: 3100, rho: 2.45, unconformity: true,
    },
    {
      name: 'TOP_D', surfaceType: 'formation_top', z0: 1120, gIl: 2.6, gXl: 0.4, fold: 4, v: 2700, rho: 2.35, belowUnconformity: true,
    },
    {
      name: 'TOP_E', surfaceType: 'formation_top', z0: 1240, gIl: 2.6, gXl: 0.4, fold: 4, v: 3400, rho: 2.55, belowUnconformity: true,
    },
  ],
  faults: [
    {
      name: 'F1', il0: 0, xl0: 38, dIl: 1, dXl: -0.25, dipDeg: 60, throwM: 40, zRefM: 1000,
    },
  ],
  wells: [
    { name: 'W-1', il: 12, xl: 12, kbM: 25 },
    { name: 'W-2', il: 55, xl: 15, kbM: 25 },
    { name: 'W-3', il: 20, xl: 50, kbM: 25 },
    {
      name: 'W-4', il: 45, xl: 30, kbM: 25, kickoffMd: 500, buildDegPer30m: 2, maxIncDeg: 30, aziDeg: 45,
    },
    { name: 'W-5', il: 62, xl: 52, kbM: 25 },
  ],
  tdMdM: 1900,
  noise: 0,
  seed: 7,
});

/**
 * Build the field.
 *
 * @param {Object} [overrides] fields of DEFAULT_FIELD_SPEC to replace
 * @returns {Object} field: {spec, geom, affine, dtUs, getTrace, traceAt,
 *   interfaceDepthAt, interfaceTwtAt, truth: {horizons, faults, tuningM},
 *   wells, velocityAt}
 */
export function buildSyntheticField(overrides = {}) {
  const spec = { ...DEFAULT_FIELD_SPEC, ...overrides };
  const {
    nIl, nXl, binM, dtMs, ns, freqHz, origin, overburden, interfaces, faults,
  } = spec;
  const affine = {
    origin: { x: origin.x, y: origin.y },
    ilVec: { x: binM, y: 0 },
    xlVec: { x: 0, y: binM },
  };
  const geom = { nIl, nXl, ns };

  // signed map distance (m) of a lattice point from each fault's trace,
  // positive on the hanging-wall side
  const faultGeo = faults.map((f) => {
    const len = Math.hypot(f.dIl, f.dXl);
    const nI = -f.dXl / len;           // unit normal in lattice units
    const nX = f.dIl / len;
    return {
      ...f,
      signedDist: (il, xl) => ((il - f.il0) * nI + (xl - f.xl0) * nX) * binM,
      tanDip: Math.tan((f.dipDeg * Math.PI) / 180),
    };
  });

  const baseDepth = (itf, il, xl) => itf.z0 + itf.gIl * il * (binM / 25) + itf.gXl * xl * (binM / 25)
    + itf.fold * Math.sin(il / 9) * Math.cos(xl / 11);

  /** Fault throw to add at a footwall depth z for a lattice point. */
  const throwAt = (il, xl, z) => {
    let add = 0;
    for (const f of faultGeo) {
      const d = f.signedDist(il, xl);
      const planeD = (z - f.zRefM) / f.tanDip;   // fault moves toward the hanging wall with depth
      if (d > planeD) add += f.throwM;
    }
    return add;
  };

  const suIndex = interfaces.findIndex((i) => i.unconformity);

  /**
   * Depths of every interface at a lattice point (TVDSS m), null where a
   * layer is truncated by the unconformity (absent).
   */
  const depthsAt = (il, xl) => {
    const zf = interfaces.map((itf) => baseDepth(itf, il, xl));
    const su = suIndex >= 0 ? zf[suIndex] : null;
    const out = zf.map((z, k) => {
      const itf = interfaces[k];
      if (itf.belowUnconformity && su != null && z <= su + 1e-9) return null; // eroded
      return z;
    });
    // monotonic above the unconformity (thin beds stay ordered)
    return out.map((z) => (z == null ? null : z + throwAt(il, xl, z)));
  };

  /** Interval stack at a point: [{zTop, v, rho}] from datum down. */
  const columnAt = (il, xl) => {
    const zs = depthsAt(il, xl);
    const layers = [{ zTop: 0, v: overburden.v, rho: overburden.rho, name: null }];
    const present = interfaces
      .map((itf, k) => ({ itf, z: zs[k] }))
      .filter((p) => p.z != null)
      .sort((a, b) => a.z - b.z);
    for (const p of present) layers.push({ zTop: p.z, v: p.itf.v, rho: p.itf.rho, name: p.itf.name });
    return layers;
  };

  /** TWT (ms) of a depth z at a lattice point. */
  const twtAtDepth = (il, xl, z) => {
    const col = columnAt(il, xl);
    let t = 0;
    for (let k = 0; k < col.length; k++) {
      const top = col[k].zTop;
      const bot = k + 1 < col.length ? col[k + 1].zTop : Infinity;
      if (z <= top) break;
      const dz = Math.min(z, bot) - top;
      t += (2 * dz / col[k].v) * 1000;
    }
    return t;
  };

  /** Interface two-way times at a point: name -> {twtMs, rc} (present only). */
  const eventsAt = (il, xl) => {
    const col = columnAt(il, xl);
    const out = [];
    let t = 0;
    for (let k = 1; k < col.length; k++) {
      t += (2 * (col[k].zTop - col[k - 1].zTop) / col[k - 1].v) * 1000;
      const i1 = col[k - 1].v * col[k - 1].rho;
      const i2 = col[k].v * col[k].rho;
      out.push({
        name: col[k].name, twtMs: t, zM: col[k].zTop, rc: (i2 - i1) / (i2 + i1),
      });
    }
    return out;
  };

  const rng = makeRng(spec.seed);
  const noiseCache = new Map();
  const halfMs = 2.5 * (1000 / (Math.PI * freqHz)) * 1.6;

  /** Analytic trace at integer lattice (il, xl). */
  const traceAt = (il, xl) => {
    const tr = new Float32Array(ns);
    for (const e of eventsAt(il, xl)) {
      const s0 = Math.max(0, Math.floor((e.twtMs - halfMs) / dtMs));
      const s1 = Math.min(ns - 1, Math.ceil((e.twtMs + halfMs) / dtMs));
      for (let s = s0; s <= s1; s++) tr[s] += e.rc * ricker(s * dtMs - e.twtMs, freqHz);
    }
    if (spec.noise > 0) {
      const key = il * nXl + xl;
      let nz = noiseCache.get(key);
      if (!nz) {
        const r = makeRng(spec.seed * 7919 + key);
        nz = new Float32Array(ns);
        for (let s = 0; s < ns; s++) nz[s] = gauss(r) * spec.noise;
        noiseCache.set(key, nz);
      }
      for (let s = 0; s < ns; s++) tr[s] += nz[s];
    }
    return tr;
  };
  // rng is reserved for future stochastic layers (keeps the seed stable)
  void rng;

  /** Truth horizon grids: name -> Float32Array of SAMPLE indices (1e30 absent). */
  const horizons = {};
  for (const itf of interfaces) horizons[itf.name] = new Float32Array(nIl * nXl).fill(NULL_F32);
  for (let il = 0; il < nIl; il++) {
    for (let xl = 0; xl < nXl; xl++) {
      for (const e of eventsAt(il, xl)) {
        const s = e.twtMs / dtMs;
        if (s >= 0 && s < ns) horizons[e.name][il * nXl + xl] = s;
      }
    }
  }

  // ---- wells -----------------------------------------------------------
  const wells = spec.wells.map((w) => buildWell(w));

  function buildWell(w) {
    const surf = ilxlToWorld(affine, w.il, w.xl);
    const td = w.tdMdM || spec.tdMdM;
    let deviation;
    if (w.kickoffMd) {
      deviation = [{ md: 0, inc: 0, azi: w.aziDeg }, { md: w.kickoffMd, inc: 0, azi: w.aziDeg }];
      let md = w.kickoffMd;
      let inc = 0;
      while (md < td) {
        md = Math.min(td, md + 30);
        inc = Math.min(w.maxIncDeg, inc + w.buildDegPer30m);
        deviation.push({ md, inc, azi: w.aziDeg });
      }
    } else {
      deviation = [{ md: 0, inc: 0, azi: 0 }, { md: td, inc: 0, azi: 0 }];
    }
    const kb = w.kbM || 0;
    const path = computeWellPath(deviation, { surfaceX: surf.x, surfaceY: surf.y, kb });
    const at = (md) => {
      const p = positionAtMd(deviation, path, md);
      const ij = worldToIlxl(affine, p.x, p.y);
      return { ...p, il: ij.i, xl: ij.j };
    };
    // lateral position rounded to the lattice for the earth model (the
    // model is defined on the lattice; the well's continuous position is
    // kept for display)
    const cellOf = (p) => ({
      il: Math.min(nIl - 1, Math.max(0, Math.round(p.il))),
      xl: Math.min(nXl - 1, Math.max(0, Math.round(p.xl))),
    });

    // tops: the MD where the path's TVDSS meets each interface's depth
    const tops = [];
    for (const itf of interfaces) {
      const f = (md) => {
        const p = at(md);
        const c = cellOf(p);
        const zs = depthsAt(c.il, c.xl);
        const z = zs[interfaces.indexOf(itf)];
        return z == null ? null : p.tvdss - z;
      };
      // scan for a sign change, then bisect
      let prevMd = 0;
      let prev = f(0);
      let found = null;
      for (let md = 10; md <= td; md += 10) {
        const v = f(md);
        if (prev != null && v != null && prev < 0 && v >= 0) {
          let lo = prevMd;
          let hi = md;
          for (let it = 0; it < 60; it++) {
            const mid = (lo + hi) / 2;
            const fm = f(mid);
            if (fm == null) break;
            if (fm < 0) lo = mid; else hi = mid;
          }
          found = (lo + hi) / 2;
          break;
        }
        prevMd = md;
        prev = v;
      }
      if (found != null) {
        const p = at(found);
        const c = cellOf(p);
        tops.push({
          name: itf.name,
          md: found,
          surfaceType: itf.surfaceType,
          tvdss: p.tvdss,
          il: p.il,
          xl: p.xl,
          cell: c,
          twtMs: twtAtDepth(c.il, c.xl, p.tvdss),
        });
      }
    }

    // checkshots every 20 m TVDSS below datum, at the path's own position
    const checkshots = [];
    for (let md = 0; md <= td; md += 5) {
      const p = at(md);
      if (p.tvdss < 0) continue;
      if (checkshots.length && p.tvdss - checkshots[checkshots.length - 1].tvdss_m < 20) continue;
      const c = cellOf(p);
      checkshots.push({ tvdss_m: p.tvdss, twt_ms: twtAtDepth(c.il, c.xl, p.tvdss) });
    }
    if (checkshots.length && checkshots[0].tvdss_m > 0) checkshots.unshift({ tvdss_m: 0, twt_ms: 0 });

    // logs every 0.5 m MD: sonic (us/m) and density (g/cc) of the layer at depth
    const stepM = 0.5;
    const n = Math.floor(td / stepM) + 1;
    const md = new Float64Array(n);
    const dt = new Float64Array(n);
    const rho = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      md[i] = i * stepM;
      const p = at(md[i]);
      const c = cellOf(p);
      const col = columnAt(c.il, c.xl);
      let layer = col[0];
      for (const l of col) if (p.tvdss >= l.zTop) layer = l;
      dt[i] = 1e6 / layer.v;
      rho[i] = layer.rho;
    }
    return {
      name: w.name,
      surfaceX: surf.x,
      surfaceY: surf.y,
      kbM: kb,
      tdMdM: td,
      deviation,
      il: w.il,
      xl: w.xl,
      tops,
      checkshots,
      logs: { md, dtUsPerM: dt, rho },
    };
  }

  // ---- fault truth --------------------------------------------------------
  const faultTruth = faultGeo.map((f) => ({
    name: f.name,
    throwM: f.throwM,
    dipDeg: f.dipDeg,
    /** Lattice xl of the fault at inline il and depth z (m), or null. */
    lineAt: { il0: f.il0, xl0: f.xl0, dIl: f.dIl, dXl: f.dXl, zRefM: f.zRefM },
    /** Signed map distance (m) from the fault plane at depth z: > 0 hanging wall. */
    sideAt: (il, xl, z) => f.signedDist(il, xl) - (z - f.zRefM) / f.tanDip,
  }));

  const vMean = interfaces.reduce((a, i) => a + i.v, 0) / interfaces.length;

  return {
    spec,
    geom,
    affine,
    dtUs: dtMs * 1000,
    dtMs,
    getTrace: async (il, xl) => traceAt(il, xl),
    traceAt,
    depthsAt,
    twtAtDepth,
    eventsAt,
    truth: {
      horizons,
      faults: faultTruth,
      // quarter wavelength at the mean interval velocity and the Ricker's
      // peak frequency: the classic tuning thickness
      tuningM: vMean / freqHz / 4,
    },
    wells,
  };
}
