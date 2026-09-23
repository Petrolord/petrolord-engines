// Automatic well tie (Tops to Horizons plan, TP2): every well in one pass.
//
// For each well with a sonic (and ideally a density) log:
//   1. the seismic trace ALONG the borehole: at each sample, the trace of
//      the lattice cell the path passes through at that time (a deviated
//      well is not tied to one vertical trace);
//   2. a zero-phase statistical wavelet from the traces around the path;
//   3. the synthetic (buildSynthetic, the same recipe the Synthetics panel
//      uses);
//   4. shift and phase searched jointly: at every lag, the phase-optimal
//      correlation (phaseOptimal); the best lag wins, refined to
//      sub-sample by a parabola through its neighbours;
//   5. polarity is the phase's half-plane (beyond 90 degrees: reverse);
//   7. windowed QC and a quality class.
// fieldTieConvention then votes one polarity and phase for the field,
// weighted by each tie's correlation, and names the wells that disagree.
// tiedTimeConv turns a tie into the tightest time-depth relation
// ('tie'), which topsToEvents uses with its smallest uncertainty.
//
// Pure math over injected I/O (getTrace), worker-safe.

import { buildSynthetic, extractStatisticalWavelet } from './synthetics';
import { rotateConstantPhase, windowedTieQc } from './tieWarp';
import { buildWellLatticePath } from './wellSection';
import { computeWellPath, positionAtMd } from './wellPath';

const isNull = (v) => !Number.isFinite(v) || Math.abs(v) > 1.0e29;

/** An angle wrapped to (-180, 180], never negative zero. */
const wrapDeg = (d) => {
  let w = ((d % 360) + 360) % 360;
  if (w > 180) w -= 360;
  return w === 0 ? 0 : w;
};

/** Quality classes on the tie's correlation after shift and phase. */
export const TIE_QUALITY = Object.freeze({ good: 0.7, fair: 0.5 });

/**
 * The seismic trace along a well path: sample k takes the value of the
 * trace at the lattice cell the path occupies at time k.
 *
 * @param {(il: number, xl: number) => Promise<Float32Array>} getTrace
 * @param {{points: Array<{il: number, xl: number, s: ?number}>}} lattice
 *   buildWellLatticePath result
 * @param {{nIl: number, nXl: number, ns: number}} geom
 * @returns {Promise<{trace: Float32Array, cells: Array<{il, xl}>}>}
 */
export async function wellPathTrace(getTrace, lattice, geom) {
  const pts = lattice.points.filter((p) => p.s != null)
    .map((p) => ({
      s: p.s,
      il: Math.min(geom.nIl - 1, Math.max(0, Math.round(p.il))),
      xl: Math.min(geom.nXl - 1, Math.max(0, Math.round(p.xl))),
    }))
    .sort((a, b) => a.s - b.s);
  const out = new Float32Array(geom.ns).fill(Math.fround(1.0e30));
  if (!pts.length) return { trace: out, cells: [] };
  const cache = new Map();
  const get = async (il, xl) => {
    const k = il * geom.nXl + xl;
    if (!cache.has(k)) cache.set(k, await getTrace(il, xl));
    return cache.get(k);
  };
  let j = 0;
  for (let k = 0; k < geom.ns; k++) {
    while (j + 1 < pts.length && Math.abs(pts[j + 1].s - k) <= Math.abs(pts[j].s - k)) j += 1;
    const p = pts[j];
    // outside the path's time range the borehole has no seismic of its own
    if (k < pts[0].s - 1 || k > pts[pts.length - 1].s + 1) continue;
    out[k] = (await get(p.il, p.xl))[k];
  }
  const cells = [];
  const seen = new Set();
  for (const p of pts) {
    const key = p.il * geom.nXl + p.xl;
    if (!seen.has(key)) { seen.add(key); cells.push({ il: p.il, xl: p.xl }); }
  }
  return { trace: out, cells, traces: [...cache.values()] };
}

/** Normalized correlation of two traces over mutually live samples. */
function corrOf(a, b) {
  let num = 0; let aa = 0; let bb = 0; let m = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]; const y = b[i];
    if (isNull(x) || isNull(y) || Number.isNaN(x) || Number.isNaN(y)) continue;
    num += x * y; aa += x * x; bb += y * y; m += 1;
  }
  return m >= 8 && aa > 0 && bb > 0 ? num / Math.sqrt(aa * bb) : null;
}

/** Shift a trace down by lagMs (positive = later), linear interpolation. */
function shiftTrace(tr, lagMs, dtMs) {
  const out = new Float32Array(tr.length).fill(NaN);
  const L = lagMs / dtMs;
  for (let k = 0; k < tr.length; k++) {
    const x = k - L;
    const i = Math.floor(x);
    const f = x - i;
    if (i < 0 || i + 1 >= tr.length) continue;
    const a = tr[i]; const b = tr[i + 1];
    if (isNull(a) || isNull(b) || Number.isNaN(a) || Number.isNaN(b)) continue;
    out[k] = a + f * (b - a);
  }
  return out;
}

/**
 * Phase-optimal correlation of a (NaN-masked) synthetic with the seismic:
 * the synthetic is zero-filled for its quadrature (rotateConstantPhase
 * needs a gap-free trace), the rotation phi = atan2(<q, r>, <s, r>) is the
 * best constant phase, and the correlation is measured only where the log
 * exists and the seismic is live.
 * @returns {?{phi: number, corr: number, rotated: Float32Array}}
 */
function phaseOptimal(syn, seismic) {
  const n = Math.min(syn.length, seismic.length);
  const s0 = new Float32Array(syn.length);
  const mask = new Uint8Array(n);
  let m = 0;
  for (let i = 0; i < syn.length; i++) {
    const v = syn[i];
    const ok = !(Number.isNaN(v) || isNull(v));
    s0[i] = ok ? v : 0;
    if (i < n && ok && !isNull(seismic[i]) && !Number.isNaN(seismic[i])) { mask[i] = 1; m += 1; }
  }
  if (m < 16) return null;
  const q = rotateConstantPhase(s0, Math.PI / 2);
  let u = 0; let v = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    u += s0[i] * seismic[i];
    v += q[i] * seismic[i];
  }
  if (u === 0 && v === 0) return null;
  const phi = Math.atan2(v, u);
  const c = Math.cos(phi);
  const sn = Math.sin(phi);
  const rotated = new Float32Array(syn.length).fill(NaN);
  let num = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const a = c * s0[i] + sn * q[i];
    rotated[i] = a;
    num += a * seismic[i]; aa += a * a; bb += seismic[i] * seismic[i];
  }
  if (!(aa > 0 && bb > 0)) return null;
  return { phi, corr: num / Math.sqrt(aa * bb), rotated };
}

/**
 * Tie one well automatically.
 *
 * @param {Object} p
 * @param {Object} p.well {name, deviation?, tdMdM?, surfaceX, surfaceY, kbM,
 *   logs: {md, dtUsPerM, rho?}}
 * @param {Object} p.timeConv makeTvdssToTwt result (the untied relation)
 * @param {Object} p.affine @param {Object} p.geom @param {number} p.dtUs
 * @param {(il, xl) => Promise<Float32Array>} p.getTrace
 * @param {number} [p.maxShiftMs] bulk-shift search (default 40)
 * @param {?Float32Array} [p.wavelet] use this wavelet instead of extracting one
 * @returns {Promise<?Object>} null when the well cannot be tied (no sonic,
 *   no time, off survey); else {shiftMs, polarity, phaseDeg, corr, corr0,
 *   quality, qc, wavelet, synthetic, seismic, cells}
 */
export async function autoTieWell({
  well, timeConv, affine, geom, dtUs, getTrace, maxShiftMs = 40, wavelet = null,
}) {
  const logs = well.logs;
  if (!logs || !logs.dtUsPerM || !logs.md || !timeConv) return null;
  const dtMs = dtUs / 1000;
  const lattice = buildWellLatticePath({ ...well, tops: [] }, {
    affine, timeConv, geom, dtUs,
  });
  if (!lattice) return null;
  const { trace: seismic, cells, traces } = await wellPathTrace(getTrace, lattice, geom);

  const stations = well.deviation && well.deviation.length >= 2 ? well.deviation
    : [{ md: 0, inc: 0, azi: 0 }, { md: well.tdMdM, inc: 0, azi: 0 }];
  const path = computeWellPath(stations, { surfaceX: well.surfaceX, surfaceY: well.surfaceY, kb: well.kbM || 0 });
  const mdToTvdss = (md) => positionAtMd(stations, path, md)?.tvdss ?? null;
  // cell-aware time along the path (the model branch needs the cell)
  const tvdssToTwt = (z) => timeConv.toTwtMs(z);

  const wav = wavelet || extractStatisticalWavelet(traces.length ? traces : [seismic], dtMs);
  let syn;
  try {
    syn = buildSynthetic({
      dtCurve: logs.dtUsPerM,
      rhobCurve: logs.rho || null,
      mdArray: logs.md,
      mdToTvdss,
      tvdssToTwt,
      dtMs,
      ns: geom.ns,
      wavelet: wav,
    });
  } catch {
    return null;
  }
  const synthetic = syn.synthetic;
  // mask the synthetic outside the logged interval
  const s = new Float32Array(synthetic.length);
  for (let i = 0; i < s.length; i++) s[i] = syn.validity[i] ? synthetic[i] : NaN;
  // joint shift and phase: at every lag, the phase-optimal correlation of
  // the shifted synthetic (a 90 degree wavelet and a quarter-period shift
  // look alike on one event; over a broadband log they do not), then the
  // lag with the best one. Polarity is the phase's half-plane.
  const L = Math.round(maxShiftMs / dtMs);
  let best = null;
  for (let lag = -L; lag <= L; lag++) {
    const ph = phaseOptimal(shiftTrace(s, lag * dtMs, dtMs), seismic);
    if (!ph) continue;
    if (!best || ph.corr > best.corr) best = { lag, ...ph };
  }
  if (!best) return null;
  // sub-sample lag: parabola through the best lag's neighbours
  let shiftMs = best.lag * dtMs;
  const cm = phaseOptimal(shiftTrace(s, (best.lag - 1) * dtMs, dtMs), seismic);
  const cp = phaseOptimal(shiftTrace(s, (best.lag + 1) * dtMs, dtMs), seismic);
  if (cm && cp) {
    const d = cm.corr - 2 * best.corr + cp.corr;
    if (d < 0) {
      const off = (0.5 * (cm.corr - cp.corr)) / d;
      if (Math.abs(off) <= 1) shiftMs = (best.lag + off) * dtMs;
    }
  }
  const at = phaseOptimal(shiftTrace(s, shiftMs, dtMs), seismic) || best;
  let phaseDeg = (at.phi * 180) / Math.PI;
  let reverse = false;
  if (Math.abs(phaseDeg) > 90) {
    reverse = true;
    phaseDeg = phaseDeg > 0 ? phaseDeg - 180 : phaseDeg + 180;
  }
  const shifted = at.rotated;
  const corr0 = corrOf(shiftTrace(reverse ? s.map((v) => -v) : s, shiftMs, dtMs), seismic) ?? 0;
  const corr = at.corr;
  const qc = windowedTieQc(shifted, seismic, dtMs);
  const quality = corr >= TIE_QUALITY.good ? 'good' : corr >= TIE_QUALITY.fair ? 'fair' : 'poor';
  return {
    name: well.name,
    shiftMs,
    polarity: reverse ? 'reverse' : 'normal',
    phaseDeg,
    corr,
    corr0,
    quality,
    qc,
    wavelet: wav,
    synthetic: shifted,
    seismic,
    cells,
  };
}

/**
 * One polarity and phase for the field: a vote weighted by each tie's
 * correlation (ties rated 'poor' do not vote), with the phase as a
 * weighted circular mean snapped to the nearest 90 degrees when it is
 * within `snapDeg` of it. Wells that disagree are named.
 *
 * @param {Array<Object>} ties autoTieWell results (nulls ignored)
 * @param {{snapDeg?: number, phaseToleranceDeg?: number}} [opts]
 * @returns {{polarity: 'normal'|'reverse', phaseDeg: number, voters: number,
 *   agreement: number, outliers: Array<{name, reason}>}}
 */
export function fieldTieConvention(ties, { snapDeg = 20, phaseToleranceDeg = 45 } = {}) {
  const live = ties.filter((t) => t && t.quality !== 'poor');
  let wNormal = 0;
  let wReverse = 0;
  for (const t of live) {
    if (t.polarity === 'reverse') wReverse += t.corr; else wNormal += t.corr;
  }
  const polarity = wReverse > wNormal ? 'reverse' : 'normal';
  let c = 0; let s = 0;
  for (const t of live) {
    if (t.polarity !== polarity) continue;
    const r = (t.phaseDeg * Math.PI) / 180;
    c += t.corr * Math.cos(r);
    s += t.corr * Math.sin(r);
  }
  let phaseDeg = (c || s) ? (Math.atan2(s, c) * 180) / Math.PI : 0;
  const snapped = Math.round(phaseDeg / 90) * 90;
  if (Math.abs(phaseDeg - snapped) <= snapDeg) phaseDeg = snapped;
  const outliers = [];
  for (const t of ties) {
    if (!t) continue;
    if (t.quality === 'poor') { outliers.push({ name: t.name, reason: 'poor tie' }); continue; }
    if (t.polarity !== polarity) { outliers.push({ name: t.name, reason: 'opposite polarity' }); continue; }
    const d = Math.abs(((t.phaseDeg - phaseDeg + 540) % 360) - 180);
    if (d > phaseToleranceDeg) outliers.push({ name: t.name, reason: `phase ${t.phaseDeg.toFixed(1)} degrees` });
  }
  const total = wNormal + wReverse;
  return {
    polarity,
    phaseDeg: wrapDeg(phaseDeg),
    voters: live.length,
    agreement: total ? Math.max(wNormal, wReverse) / total : 0,
    outliers,
  };
}

/**
 * A tied time-depth relation: the well's relation shifted by the tie's
 * bulk shift, tagged 'tie' (the tightest uncertainty in topsToEvents).
 */
export function tiedTimeConv(timeConv, tie) {
  if (!timeConv || !tie) return timeConv;
  return {
    source: 'tie',
    toTwtMs(z, cell) {
      const t = timeConv.toTwtMs(z, cell);
      return t == null ? null : t + tie.shiftMs;
    },
  };
}

/** The tied relation as a checkshot table (for saving as derived checkshots). */
export function tiedCheckshots(checkshots, tie) {
  return checkshots.map((c) => ({ tvdss_m: c.tvdss_m, twt_ms: c.twt_ms + tie.shiftMs }));
}
