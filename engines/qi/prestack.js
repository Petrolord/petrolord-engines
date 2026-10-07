// Prestack gathers for a QI study (QI programme Q3, Milestone C; SOW
// sections 2 and 3): offset binning, the RMS-to-interval velocity (Dix),
// the incidence angle of each offset at each time, angle gathers, angle
// partial stacks and the usable-angle coverage.
//
// The angle of a sample at offset x and zero-offset two-way time t0 is the
// straight-ray estimate of Walden (1991, Geophysical Prospecting 39):
//   sin(theta) = (Vint / Vrms) * x / sqrt(x^2 + (Vrms t0)^2)
// with Vrms and Vint at t0. It is checked here against an exact ray trace
// through flat layers (Snell's law with the ray parameter solved for the
// offset), which is the known truth for a layered earth. Gathers are taken
// as NMO-corrected (flat events). Pure, float64.

const fin = Number.isFinite;
const DEG = 180 / Math.PI;

/** Dix interval velocities from an RMS velocity function sampled at increasing two-way times. */
export function dixInterval(vrms, t0) {
  if (vrms.length !== t0.length || vrms.length < 2) throw new Error('Dix needs matching RMS velocities and times, two or more.');
  const out = new Float64Array(vrms.length);
  out[0] = vrms[0];
  for (let i = 1; i < vrms.length; i++) {
    const dt = t0[i] - t0[i - 1];
    if (!(dt > 0)) throw new Error('The times must increase.');
    const num = vrms[i] ** 2 * t0[i] - vrms[i - 1] ** 2 * t0[i - 1];
    if (!(num > 0)) throw new Error(`The RMS velocities give no real interval velocity at ${t0[i]} s.`);
    out[i] = Math.sqrt(num / dt);
  }
  return out;
}

/** RMS velocity and two-way time at the base of each flat layer (the forward model Dix inverts). */
export function layeredRms(layers) {
  let t = 0; let s = 0;
  return layers.map((l) => {
    const dt = (2 * l.thicknessM) / l.v;
    t += dt; s += l.v * l.v * dt;
    return { t0: t, vrms: Math.sqrt(s / t) };
  });
}

/**
 * The exact incidence angle (degrees) at the base of layer `target` for a
 * source-receiver offset, by ray tracing through flat layers above it.
 * @param {Array<{thicknessM: number, v: number}>} layers top down
 * @param {number} target index of the reflecting interface's upper layer
 * @param {number} offsetM
 * @returns {number} the angle in the target layer, degrees
 */
export function rayTraceAngle(layers, target, offsetM) {
  if (!(offsetM >= 0)) throw new Error('The offset must be zero or positive.');
  if (offsetM === 0) return 0;
  const above = layers.slice(0, target + 1);
  const vmax = Math.max(...above.map((l) => l.v));
  const xOf = (p) => 2 * above.reduce((s, l) => s + (l.thicknessM * p * l.v) / Math.sqrt(1 - (p * l.v) ** 2), 0);
  let lo = 0; let hi = (1 - 1e-12) / vmax;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (xOf(mid) < offsetM) lo = mid; else hi = mid;
  }
  return Math.asin(((lo + hi) / 2) * layers[target].v) * DEG;
}

/** The straight-ray angle (degrees) of Walden (1991) at offset x, time t0 (s), with Vrms and Vint at t0. */
export function waldenAngle(offsetM, t0S, vrms, vint) {
  if (!(t0S > 0) || !(vrms > 0) || !(vint > 0)) return NaN;
  const s = ((vint / vrms) * offsetM) / Math.sqrt(offsetM * offsetM + (vrms * t0S) ** 2);
  return s >= 1 ? 90 : Math.asin(s) * DEG;
}

/**
 * Offset bins: bin k holds offsets in [k w, (k + 1) w), centred at (k + 0.5) w.
 * @returns {{index: Int32Array, centres: number[], fold: number[]}}
 */
export function binOffsets(offsets, widthM) {
  if (!(widthM > 0)) throw new Error('The offset bin width must be positive.');
  const index = Int32Array.from(offsets, (o) => (fin(o) && o >= 0 ? Math.floor(o / widthM) : -1));
  const n = Math.max(0, ...index) + 1;
  const fold = new Array(n).fill(0);
  for (const k of index) if (k >= 0) fold[k] += 1;
  return { index, centres: Array.from({ length: n }, (_, k) => (k + 0.5) * widthM), fold };
}

/**
 * An NMO-corrected offset gather mapped to angle bins: each live sample goes
 * to the bin of its Walden angle; a bin is the mean of what falls in it.
 * @param {Object} p
 * @param {ArrayLike<number>[]} p.traces one per offset, ns samples (nulls as non-finite or |v| >= 1e29)
 * @param {number[]} p.offsets metres, one per trace
 * @param {ArrayLike<number>} p.vrms RMS velocity per sample (m/s)
 * @param {ArrayLike<number>} p.vint interval velocity per sample (m/s)
 * @param {number} p.dtMs
 * @param {number[]} p.edges angle bin edges in degrees, increasing (n + 1 for n bins)
 * @param {number} [p.t0Ms] time of the first sample
 * @returns {{gather: Float64Array[], fold: Int32Array[]}} per angle bin, ns samples (NaN where empty)
 */
export function angleGather({ traces, offsets, vrms, vint, dtMs, edges, t0Ms = 0 }) {
  const ns = vrms.length;
  const nb = edges.length - 1;
  if (nb < 1) throw new Error('Give at least one angle bin (two edges).');
  const sum = Array.from({ length: nb }, () => new Float64Array(ns));
  const fold = Array.from({ length: nb }, () => new Int32Array(ns));
  traces.forEach((tr, j) => {
    const x = offsets[j];
    for (let i = 0; i < ns; i++) {
      const v = tr[i];
      if (!fin(v) || Math.abs(v) >= 1e29) continue;
      const a = waldenAngle(x, (t0Ms + i * dtMs) / 1000, vrms[i], vint[i]);
      if (!fin(a)) continue;
      let b = -1;
      for (let k = 0; k < nb; k++) if (a >= edges[k] && a < edges[k + 1]) { b = k; break; }
      if (b < 0) continue;
      sum[b][i] += v; fold[b][i] += 1;
    }
  });
  return { gather: sum.map((s, k) => s.map((v, i) => (fold[k][i] ? v / fold[k][i] : NaN))), fold };
}

/** A partial stack over angle bins [from, to): the fold-weighted mean of the bins (NaN where none has data). */
export function partialStack({ gather, fold }, from, to) {
  const ns = gather[0].length;
  const out = new Float64Array(ns);
  for (let i = 0; i < ns; i++) {
    let s = 0; let n = 0;
    for (let k = from; k < to; k++) if (fold[k][i] > 0) { s += gather[k][i] * fold[k][i]; n += fold[k][i]; }
    out[i] = n ? s / n : NaN;
  }
  return out;
}

/**
 * The usable angle per sample: the far edge of the last angle bin, counting
 * from the nearest, with at least minFold traces (degrees; NaN when even the
 * first bin has too few).
 */
export function usableAngle({ fold }, edges, minFold = 1) {
  const ns = fold[0].length;
  return Float64Array.from({ length: ns }, (_, i) => {
    let last = -1;
    for (let k = 0; k < fold.length; k++) { if (fold[k][i] >= minFold) last = k; else break; }
    return last >= 0 ? edges[last + 1] : NaN;
  });
}
