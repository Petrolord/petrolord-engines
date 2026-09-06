// Wellsite Studio WS3: the lag engine (spec sections 14 and 15). Lag is
// counted in pump strokes, the mudlogging practice, never as a constant
// time: the strokes to bring a sample from the bit to surface are the
// annular volume above the cut point over the pump displacement, and
// time is whatever the pump log says those strokes took, rate changes,
// connections and shutdowns included.
//
// Annular volumes come from the drilling engine's wellVolumes (sanctioned
// edge wellsite -> drilling): the string is built bottom-up to the bit
// depth (BHA then drillpipe), the survey is extended to the bit along the
// last attitude when it stops short, and the hole sections carry the
// casing ID where cased.
//
// Inputs (SI): geometry rows { from_md_m, to_md_m, cased, hole_id_m,
// casing_id_m } or engine rows { fromMd, toMd, holeIdM }; bha bottom-up
// [{ lengthM, odM, idM }]; drillpipe { odM, idM }; stations [{ md, inc,
// azi }] or null; pump log [{ utcMs, spm }] sorted; bit depth history
// [{ utcMs, mdM }] sorted.

import { wellVolumes } from '../drilling/wellControl.js';

const MIN = 60000;
const DEG = Math.PI / 180;

/** Stored hole sections to the engine geometry shape. */
export function engineGeometry(sections) {
  return (sections || []).map((s) => {
    if (Number.isFinite(s.fromMd)) return { fromMd: s.fromMd, toMd: s.toMd, holeIdM: s.holeIdM, cased: !!s.cased };
    const cased = !!s.cased;
    return { fromMd: s.from_md_m, toMd: s.to_md_m, holeIdM: cased ? s.casing_id_m : s.hole_id_m, cased };
  });
}

/** The drillstring at a bit depth: the BHA (bottom up) plus drillpipe to surface. */
export function stringAtBit({ bha = [], drillpipe, bitMdM }) {
  if (!(bitMdM > 0)) throw new Error('Bit depth must be positive.');
  if (!drillpipe || !(drillpipe.odM > 0) || !(drillpipe.idM > 0)) throw new Error('Drillpipe needs an outside and an inside diameter.');
  const out = [];
  let len = 0;
  for (const c of bha) {
    if (len >= bitMdM) break;
    const l = Math.min(c.lengthM, bitMdM - len);
    out.push({ lengthM: l, odM: c.odM, idM: c.idM, label: c.label || 'BHA' });
    len += l;
  }
  if (bitMdM - len > 1e-9) out.push({ lengthM: bitMdM - len, odM: drillpipe.odM, idM: drillpipe.idM, label: drillpipe.label || 'drillpipe' });
  return out;
}

/** Survey stations reaching the bit depth: extended along the last attitude, or a vertical path when there is no survey. */
export function stationsToBit(stations, bitMdM) {
  const st = Array.isArray(stations) && stations.length >= 2 ? stations : [{ md: 0, inc: 0, azi: 0 }, { md: Math.max(bitMdM, 1), inc: 0, azi: 0 }];
  const last = st[st.length - 1];
  if (last.md >= bitMdM) return st;
  return [...st, { md: bitMdM, inc: last.inc, azi: last.azi }];
}

/** Annulus rows from the bit to surface at a bit depth. */
export function annulusSections({ geometry, bha, drillpipe, stations, bitMdM }) {
  const geom = engineGeometry(geometry);
  if (!geom.length) throw new Error('At least one hole section is needed for the lag.');
  const string = stringAtBit({ bha, drillpipe, bitMdM });
  const st = stationsToBit(stations, bitMdM);
  const v = wellVolumes({ stations: st, string, geometry: geom });
  const rows = v.annulusRows.map((r) => {
    const mid = (r.fromMd + r.toMd) / 2;
    const sec = geom.find((g) => mid >= g.fromMd - 1e-9 && mid <= g.toMd + 1e-9);
    return { ...r, cased: sec ? sec.cased : null };
  });
  const covered = rows.reduce((a, r) => a + (r.toMd - r.fromMd), 0);
  const warnings = [];
  if (bitMdM - covered > 0.5) warnings.push(`The hole sections cover ${covered} m of the ${bitMdM} m to the bit, the rest is not in the lag.`);
  return { rows, annulusVolumeM3: v.annulusVolumeM3, stringVolumeM3: v.stringVolumeM3, bitMd: v.bitMd, warnings };
}

/** Lag strokes for a sample cut at a bit depth. */
export function lagStrokesAt(lagCtx, bitMdM) {
  if (!(lagCtx && lagCtx.m3PerStroke > 0)) throw new Error('Pump displacement must be positive.');
  const a = annulusSections({ ...lagCtx, bitMdM });
  return { lagStrokes: a.annulusVolumeM3 / lagCtx.m3PerStroke, annulusVolumeM3: a.annulusVolumeM3, bitMdM, m3PerStroke: lagCtx.m3PerStroke, rows: a.rows, warnings: a.warnings };
}

/** Minutes for a number of strokes at a steady rate; null when the pumps are off. */
export function lagTimeMin({ lagStrokes, spm }) {
  return spm > 0 ? lagStrokes / spm : null;
}

// ---- pump log ------------------------------------------------------------

export function validatePumpLog(events) {
  const errors = [];
  if (!Array.isArray(events)) return ['The pump log must be a list.'];
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    if (!Number.isFinite(e.utcMs)) errors.push(`Pump event ${i + 1} has no time.`);
    if (!(Number.isFinite(e.spm) && e.spm >= 0)) errors.push(`Pump event ${i + 1} needs a rate of zero or more strokes per minute.`);
    if (i > 0 && e.utcMs < events[i - 1].utcMs) errors.push(`Pump event ${i + 1} is out of time order.`);
  }
  return errors;
}

/** The pump rate in force at an instant (zero before the first entry). */
export function spmAt(events, utcMs) {
  let spm = 0;
  for (const e of events) { if (e.utcMs <= utcMs) spm = e.spm; else break; }
  return spm;
}

/** Strokes pumped between two instants under the piecewise-constant log. */
export function strokesBetween(events, t0Ms, t1Ms) {
  if (!(t1Ms > t0Ms)) return 0;
  let total = 0;
  let t = t0Ms;
  let spm = spmAt(events, t0Ms);
  for (const e of events) {
    if (e.utcMs <= t0Ms) continue;
    if (e.utcMs >= t1Ms) break;
    total += spm * (e.utcMs - t) / MIN;
    t = e.utcMs;
    spm = e.spm;
  }
  total += spm * (t1Ms - t) / MIN;
  return total;
}

/** The instant at which `strokes` will have been pumped after t0, if the log (held constant after its last entry) gets there. */
export function timeForStrokes(events, t0Ms, strokes) {
  if (!(strokes > 0)) return { reached: true, utcMs: t0Ms };
  let remaining = strokes;
  let t = t0Ms;
  let spm = spmAt(events, t0Ms);
  const later = events.filter((e) => e.utcMs > t0Ms);
  for (const e of later) {
    const can = spm * (e.utcMs - t) / MIN;
    if (can >= remaining) return { reached: true, utcMs: t + (remaining / spm) * MIN };
    remaining -= can;
    t = e.utcMs;
    spm = e.spm;
  }
  if (spm > 0) return { reached: true, utcMs: t + (remaining / spm) * MIN, extrapolated: true };
  return { reached: false, strokesRemaining: remaining, lastUtcMs: t };
}

// ---- bit depth history ---------------------------------------------------

/** Bit depth at an instant: linear between recorded points, flat outside them. */
export function bitDepthAt(history, utcMs) {
  if (!history || !history.length) return null;
  if (utcMs <= history[0].utcMs) return history[0].mdM;
  for (let i = 1; i < history.length; i += 1) {
    const a = history[i - 1];
    const b = history[i];
    if (utcMs <= b.utcMs) {
      const f = b.utcMs === a.utcMs ? 1 : (utcMs - a.utcMs) / (b.utcMs - a.utcMs);
      return a.mdM + f * (b.mdM - a.mdM);
    }
  }
  return history[history.length - 1].mdM;
}

/** The first instant the bit reached a depth (null if it has not). */
export function cutTimeOf(history, mdM) {
  if (!history || !history.length) return null;
  if (mdM <= history[0].mdM) return history[0].utcMs;
  for (let i = 1; i < history.length; i += 1) {
    const a = history[i - 1];
    const b = history[i];
    if (mdM > a.mdM && mdM <= b.mdM) {
      const f = (mdM - a.mdM) / (b.mdM - a.mdM);
      return a.utcMs + f * (b.utcMs - a.utcMs);
    }
  }
  return null;
}

// ---- predictions ---------------------------------------------------------

/**
 * When does a sample cut at cutMdM at cutUtcMs reach surface?
 * lagCtx: { geometry, bha, drillpipe, stations, m3PerStroke }
 */
export function arrivalPrediction({ cutUtcMs, cutMdM, lagCtx, pumpLog, nowUtcMs = null }) {
  const { lagStrokes, warnings } = lagStrokesAt(lagCtx, cutMdM);
  const now = Number.isFinite(nowUtcMs) ? nowUtcMs : cutUtcMs;
  const strokesDone = Math.min(lagStrokes, strokesBetween(pumpLog, cutUtcMs, Math.max(now, cutUtcMs)));
  const r = timeForStrokes(pumpLog, cutUtcMs, lagStrokes);
  const spmNow = spmAt(pumpLog, now);
  const remaining = Math.max(0, lagStrokes - strokesDone);
  let note = '';
  if (spmNow === 0 && remaining > 0) note = 'Pumps are off, lag time is undefined until circulation restarts.';
  else if (r.extrapolated) note = 'Arrival assumes the current pump rate holds.';
  return {
    lagStrokes, strokesDone, strokesRemaining: remaining, reached: r.reached && r.utcMs <= now,
    arrivalUtcMs: r.reached ? r.utcMs : null, spmNow,
    lagTimeAtCurrentSpmMin: spmNow > 0 ? remaining / spmNow : null, note, warnings,
  };
}

/**
 * The lagged sample depth now: solve strokesBetween(Tcut, now) = lagStrokes(bitDepthAt(Tcut))
 * for the cut time Tcut (bisection on a monotone function).
 */
export function laggedDepthNow({ nowUtcMs, bitDepthHistory, pumpLog, lagCtx }) {
  if (!bitDepthHistory || !bitDepthHistory.length) return { laggedMdM: null, converged: false, note: 'No bit depth has been recorded.' };
  const cache = new Map();
  const lagAt = (md) => {
    const key = Math.round(md * 1000);
    if (!cache.has(key)) cache.set(key, lagStrokesAt(lagCtx, md).lagStrokes);
    return cache.get(key);
  };
  const t0 = Math.min(bitDepthHistory[0].utcMs, pumpLog.length ? pumpLog[0].utcMs : bitDepthHistory[0].utcMs);
  const f = (t) => strokesBetween(pumpLog, t, nowUtcMs) - lagAt(bitDepthAt(bitDepthHistory, t));
  const f0 = f(t0);
  if (f0 < 0) {
    // not enough strokes since the record began to bring the earliest cuttings up
    const first = bitDepthAt(bitDepthHistory, t0);
    return { laggedMdM: null, converged: false, cutUtcMs: null, lagStrokes: lagAt(first), strokesBack: strokesBetween(pumpLog, t0, nowUtcMs), note: 'Cuttings from the start of the record have not reached surface yet.' };
  }
  let lo = t0;
  let hi = nowUtcMs;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (f(mid) >= 0) lo = mid; else hi = mid;
  }
  const cut = lo;
  const md = bitDepthAt(bitDepthHistory, cut);
  return { laggedMdM: md, cutUtcMs: cut, lagStrokes: lagAt(md), strokesBack: strokesBetween(pumpLog, cut, nowUtcMs), converged: true, note: '' };
}

/** The status-bar readout. */
export function lagReadout({ nowUtcMs, bitMdM, bitDepthHistory, pumpLog, lagCtx }) {
  const bit = Number.isFinite(bitMdM) ? bitMdM : bitDepthAt(bitDepthHistory, nowUtcMs);
  const out = { bitMdM: bit, spmNow: spmAt(pumpLog, nowUtcMs), lagStrokes: null, lagTimeMin: null, laggedMdM: null, bottomsUpUtcMs: null, warnings: [], note: '' };
  if (!(bit > 0)) return { ...out, note: 'No bit depth has been recorded.' };
  try {
    const l = lagStrokesAt(lagCtx, bit);
    out.lagStrokes = l.lagStrokes;
    out.warnings = l.warnings;
    out.lagTimeMin = lagTimeMin({ lagStrokes: l.lagStrokes, spm: out.spmNow });
    const bu = timeForStrokes(pumpLog, nowUtcMs, l.lagStrokes);
    out.bottomsUpUtcMs = bu.reached ? bu.utcMs : null;
    const lagged = laggedDepthNow({ nowUtcMs, bitDepthHistory, pumpLog, lagCtx });
    out.laggedMdM = lagged.laggedMdM;
    out.note = lagged.note || (out.spmNow === 0 ? 'Pumps are off, lag time is undefined until circulation restarts.' : '');
  } catch (e) { out.note = e.message; }
  return out;
}
