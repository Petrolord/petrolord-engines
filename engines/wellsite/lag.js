// Wellsite Studio WS3: the lag engine (spec sections 14 and 15). Lag is
// counted in pump strokes, the mudlogging practice, never as a constant
// time: the strokes to bring a sample from the bit to surface are the
// annular volume above the cut point over the pump displacement, and
// time is whatever the pump log says those strokes took, rate changes,
// connections and shutdowns included.
//
// Floating rigs (tester note, 2026-09-07): a drillship or semi-submersible
// returns through a marine riser above the BOP, and a booster pump adds
// mud at the riser base. The returns therefore travel in TWO LEGS: bit to
// riser base on the main-pump flow alone, riser base to surface on main
// plus booster flow. The riser is described once (its base depth below
// the rotary table and its inside diameter) and the pump log carries the
// booster rate beside the main rate. With no riser and no booster every
// formula below reduces exactly to the land-rig case (goldens G1 to G4);
// the floater cases are G5 and G6.
//
// Annular volumes come from the drilling engine's wellVolumes (sanctioned
// edge wellsite -> drilling): the string is built bottom-up to the bit
// depth (BHA then drillpipe), the survey is extended to the bit along the
// last attitude when it stops short, and the hole sections carry the
// casing ID where cased. On a floater the hole sections start at the BOP
// and the engine puts the riser section above them.
//
// Inputs (SI): geometry rows { from_md_m, to_md_m, cased, hole_id_m,
// casing_id_m } or engine rows { fromMd, toMd, holeIdM }; bha bottom-up
// [{ lengthM, odM, idM }]; drillpipe { odM, idM }; stations [{ md, inc,
// azi }] or null; riser { toMd, idM } or null; m3PerStroke (main pump);
// boosterM3PerStroke (0 or absent on a land rig); pump log [{ utcMs, spm,
// boosterSpm }] sorted; bit depth history [{ utcMs, mdM }] sorted.

import { wellVolumes } from '../drilling/wellControl.js';

const MIN = 60000;

/** Stored hole sections to the engine geometry shape. */
export function engineGeometry(sections) {
  return (sections || []).map((s) => {
    if (Number.isFinite(s.fromMd)) return { fromMd: s.fromMd, toMd: s.toMd, holeIdM: s.holeIdM, cased: !!s.cased };
    const cased = !!s.cased;
    return { fromMd: s.from_md_m, toMd: s.to_md_m, holeIdM: cased ? s.casing_id_m : s.hole_id_m, cased };
  });
}

/** The marine riser as a geometry row above the hole sections, or null on a land rig. */
export function riserRow(riser) {
  if (!riser || !(riser.toMd > 0) || !(riser.idM > 0)) return null;
  return { fromMd: Number.isFinite(riser.fromMd) ? riser.fromMd : 0, toMd: riser.toMd, holeIdM: riser.idM, cased: true, riser: true };
}

/**
 * Geometry with the riser on top: hole sections that start above the riser
 * base are clipped to it (and reported), so the riser ID governs the riser.
 */
export function geometryWithRiser(geometry, riser) {
  const geom = engineGeometry(geometry);
  const r = riserRow(riser);
  if (!r) return { rows: geom, warnings: [] };
  const warnings = [];
  const below = [];
  for (const g of geom) {
    if (g.toMd <= r.toMd + 1e-9) { warnings.push(`Hole section ${g.fromMd} to ${g.toMd} m lies inside the riser and is ignored; hole sections on a floater start at the BOP (${r.toMd} m).`); continue; }
    if (g.fromMd < r.toMd - 1e-9) { warnings.push(`Hole section ${g.fromMd} to ${g.toMd} m overlaps the riser; clipped to start at the BOP (${r.toMd} m).`); below.push({ ...g, fromMd: r.toMd }); }
    else below.push(g);
  }
  return { rows: [r, ...below], warnings };
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

/** Annulus rows from the bit to surface at a bit depth (riser rows flagged, and their volume summed separately). */
export function annulusSections({ geometry, bha, drillpipe, stations, riser = null, bitMdM }) {
  const gw = geometryWithRiser(geometry, riser);
  const geom = gw.rows;
  if (!geom.length) throw new Error('At least one hole section is needed for the lag.');
  const string = stringAtBit({ bha, drillpipe, bitMdM });
  const st = stationsToBit(stations, bitMdM);
  const v = wellVolumes({ stations: st, string, geometry: geom });
  const riserBase = riserRow(riser) ? riserRow(riser).toMd : 0;
  let riserVolumeM3 = 0;
  const rows = v.annulusRows.map((r) => {
    const mid = (r.fromMd + r.toMd) / 2;
    const sec = geom.find((g) => mid >= g.fromMd - 1e-9 && mid <= g.toMd + 1e-9);
    const inRiser = riserBase > 0 && mid < riserBase;
    if (inRiser) riserVolumeM3 += r.volM3;
    return { ...r, cased: sec ? sec.cased : null, riser: inRiser };
  });
  const covered = rows.reduce((a, r) => a + (r.toMd - r.fromMd), 0);
  const warnings = [...gw.warnings];
  if (bitMdM - covered > 0.5) warnings.push(`The hole sections cover ${covered} m of the ${bitMdM} m to the bit, the rest is not in the lag.`);
  return { rows, annulusVolumeM3: v.annulusVolumeM3, riserVolumeM3, wellVolumeM3: v.annulusVolumeM3 - riserVolumeM3, stringVolumeM3: v.stringVolumeM3, bitMd: v.bitMd, warnings };
}

const boosterDisp = (ctx) => (ctx && ctx.boosterM3PerStroke > 0 ? ctx.boosterM3PerStroke : 0);

/** Main-pump strokes equivalent to the riser leg at a booster-to-main rate ratio. */
export function riserStrokesAtRatio(riserM3, ctx, ratio = 0) {
  const dm = ctx.m3PerStroke;
  const db = boosterDisp(ctx);
  return riserM3 / (dm + db * Math.max(0, ratio));
}

/**
 * The two legs of the lag for a sample cut at a bit depth: the well leg
 * (bit to riser base, or to surface on a land rig) and the riser leg.
 */
export function lagLegsAt(lagCtx, bitMdM) {
  if (!(lagCtx && lagCtx.m3PerStroke > 0)) throw new Error('Pump displacement must be positive.');
  const a = annulusSections({ ...lagCtx, bitMdM });
  return {
    bitMdM, wellM3: a.wellVolumeM3, riserM3: a.riserVolumeM3, annulusVolumeM3: a.annulusVolumeM3,
    wellStrokes: a.wellVolumeM3 / lagCtx.m3PerStroke, riserStrokesNoBooster: a.riserVolumeM3 / lagCtx.m3PerStroke,
    m3PerStroke: lagCtx.m3PerStroke, boosterM3PerStroke: boosterDisp(lagCtx), rows: a.rows, warnings: a.warnings,
  };
}

/**
 * Lag strokes for a sample cut at a bit depth, counted on the MAIN pump
 * stroke counter. With a booster running at `boosterSpm` while the main
 * pump runs at `spm`, the riser leg takes fewer main-pump strokes.
 */
export function lagStrokesAt(lagCtx, bitMdM, { spm = null, boosterSpm = 0 } = {}) {
  const legs = lagLegsAt(lagCtx, bitMdM);
  const ratio = spm > 0 && boosterSpm > 0 ? boosterSpm / spm : 0;
  const riserStrokes = riserStrokesAtRatio(legs.riserM3, lagCtx, ratio);
  return {
    lagStrokes: legs.wellStrokes + riserStrokes, wellStrokes: legs.wellStrokes, riserStrokes,
    annulusVolumeM3: legs.annulusVolumeM3, wellM3: legs.wellM3, riserM3: legs.riserM3,
    bitMdM, m3PerStroke: lagCtx.m3PerStroke, boosterRatio: ratio, rows: legs.rows, warnings: legs.warnings,
  };
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
    if (e.boosterSpm != null && !(Number.isFinite(e.boosterSpm) && e.boosterSpm >= 0)) errors.push(`Pump event ${i + 1} needs a booster rate of zero or more strokes per minute.`);
    if (i > 0 && e.utcMs < events[i - 1].utcMs) errors.push(`Pump event ${i + 1} is out of time order.`);
  }
  return errors;
}

/** The main and booster rates in force at an instant (zero before the first entry). */
export function ratesAt(events, utcMs) {
  let spm = 0;
  let boosterSpm = 0;
  for (const e of events) {
    if (e.utcMs <= utcMs) { spm = e.spm; boosterSpm = Number(e.boosterSpm) || 0; } else break;
  }
  return { spm, boosterSpm };
}

/** The main pump rate in force at an instant (zero before the first entry). */
export function spmAt(events, utcMs) {
  return ratesAt(events, utcMs).spm;
}

/** Flow in m3 per minute on a leg: the well leg sees the main pump only, the riser leg main plus booster. */
export function legFlowPerMin(rates, ctx, leg) {
  const main = rates.spm * ctx.m3PerStroke;
  if (leg !== 'riser') return main;
  return main + (rates.boosterSpm || 0) * boosterDisp(ctx);
}

/** Cubic metres pumped into a leg between two instants under the piecewise-constant log. */
export function volumeBetween(events, ctx, t0Ms, t1Ms, leg = 'well') {
  if (!(t1Ms > t0Ms)) return 0;
  let total = 0;
  let t = t0Ms;
  let q = legFlowPerMin(ratesAt(events, t0Ms), ctx, leg);
  for (const e of events) {
    if (e.utcMs <= t0Ms) continue;
    if (e.utcMs >= t1Ms) break;
    total += q * (e.utcMs - t) / MIN;
    t = e.utcMs;
    q = legFlowPerMin(ratesAt(events, e.utcMs), ctx, leg);
  }
  total += q * (t1Ms - t) / MIN;
  return total;
}

/** The instant at which `m3` will have been pumped into a leg after t0, if the log (held constant after its last entry) gets there. */
export function timeForVolume(events, ctx, t0Ms, m3, leg = 'well') {
  if (!(m3 > 0)) return { reached: true, utcMs: t0Ms };
  let remaining = m3;
  let t = t0Ms;
  let q = legFlowPerMin(ratesAt(events, t0Ms), ctx, leg);
  const later = events.filter((e) => e.utcMs > t0Ms);
  for (const e of later) {
    const can = q * (e.utcMs - t) / MIN;
    if (can >= remaining && q > 0) return { reached: true, utcMs: t + (remaining / q) * MIN };
    remaining -= can;
    t = e.utcMs;
    q = legFlowPerMin(ratesAt(events, e.utcMs), ctx, leg);
  }
  if (q > 0) return { reached: true, utcMs: t + (remaining / q) * MIN, extrapolated: true };
  return { reached: false, m3Remaining: remaining, lastUtcMs: t };
}

/** Main-pump strokes pumped between two instants under the piecewise-constant log. */
export function strokesBetween(events, t0Ms, t1Ms) {
  return volumeBetween(events, { m3PerStroke: 1 }, t0Ms, t1Ms, 'well');
}

/** The instant at which `strokes` main-pump strokes will have been pumped after t0. */
export function timeForStrokes(events, t0Ms, strokes) {
  const r = timeForVolume(events, { m3PerStroke: 1 }, t0Ms, strokes, 'well');
  if (!r.reached) return { reached: false, strokesRemaining: r.m3Remaining, lastUtcMs: r.lastUtcMs };
  return r;
}

/**
 * When a sample cut at cutUtcMs reaches surface: the well leg on the main
 * pump, then the riser leg on main plus booster. Returns the arrival and
 * the progress of each leg as of `nowUtcMs`.
 */
export function legArrival({ cutUtcMs, legs, lagCtx, pumpLog, nowUtcMs }) {
  const now = Number.isFinite(nowUtcMs) ? Math.max(nowUtcMs, cutUtcMs) : cutUtcMs;
  const t1 = timeForVolume(pumpLog, lagCtx, cutUtcMs, legs.wellM3, 'well');
  const wellDone = Math.min(legs.wellM3, volumeBetween(pumpLog, lagCtx, cutUtcMs, now, 'well'));
  if (!t1.reached) return { reached: false, arrivalUtcMs: null, wellDoneM3: wellDone, riserDoneM3: 0, extrapolated: false, riserStartUtcMs: null };
  if (!(legs.riserM3 > 0)) return { reached: true, arrivalUtcMs: t1.utcMs, wellDoneM3: wellDone, riserDoneM3: 0, extrapolated: !!t1.extrapolated, riserStartUtcMs: t1.utcMs };
  const t2 = timeForVolume(pumpLog, lagCtx, t1.utcMs, legs.riserM3, 'riser');
  const riserDone = now > t1.utcMs ? Math.min(legs.riserM3, volumeBetween(pumpLog, lagCtx, t1.utcMs, now, 'riser')) : 0;
  if (!t2.reached) return { reached: false, arrivalUtcMs: null, wellDoneM3: wellDone, riserDoneM3: riserDone, extrapolated: false, riserStartUtcMs: t1.utcMs };
  return { reached: true, arrivalUtcMs: t2.utcMs, wellDoneM3: wellDone, riserDoneM3: riserDone, extrapolated: !!(t1.extrapolated || t2.extrapolated), riserStartUtcMs: t1.utcMs };
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

/** Minutes to bring the remaining volumes up at the rates in force now; null when the main pump is off. */
function remainingMinutes(rates, ctx, wellLeftM3, riserLeftM3) {
  const qWell = legFlowPerMin(rates, ctx, 'well');
  if (!(qWell > 0)) return null;
  const qRiser = legFlowPerMin(rates, ctx, 'riser');
  return wellLeftM3 / qWell + (riserLeftM3 > 0 ? riserLeftM3 / qRiser : 0);
}

/**
 * When does a sample cut at cutMdM at cutUtcMs reach surface?
 * lagCtx: { geometry, bha, drillpipe, stations, riser, m3PerStroke, boosterM3PerStroke }
 */
export function arrivalPrediction({ cutUtcMs, cutMdM, lagCtx, pumpLog, nowUtcMs = null }) {
  const legs = lagLegsAt(lagCtx, cutMdM);
  const now = Number.isFinite(nowUtcMs) ? nowUtcMs : cutUtcMs;
  const rates = ratesAt(pumpLog, now);
  const ratio = rates.spm > 0 ? (rates.boosterSpm || 0) / rates.spm : 0;
  const lagStrokes = legs.wellStrokes + riserStrokesAtRatio(legs.riserM3, lagCtx, ratio);
  const a = legArrival({ cutUtcMs, legs, lagCtx, pumpLog, nowUtcMs: now });
  const wellLeft = Math.max(0, legs.wellM3 - a.wellDoneM3);
  const riserLeft = Math.max(0, legs.riserM3 - a.riserDoneM3);
  const strokesDone = Math.min(legs.wellStrokes, strokesBetween(pumpLog, cutUtcMs, Math.max(now, cutUtcMs)));
  const remaining = wellLeft / lagCtx.m3PerStroke + riserStrokesAtRatio(riserLeft, lagCtx, ratio);
  let note = '';
  if (rates.spm === 0 && remaining > 0) note = 'Pumps are off, lag time is undefined until circulation restarts.';
  else if (a.extrapolated) note = 'Arrival assumes the current pump rate holds.';
  return {
    lagStrokes, strokesDone, strokesRemaining: remaining, reached: a.reached && a.arrivalUtcMs <= now,
    arrivalUtcMs: a.reached ? a.arrivalUtcMs : null, spmNow: rates.spm, boosterSpmNow: rates.boosterSpm,
    lagTimeAtCurrentSpmMin: remainingMinutes(rates, lagCtx, wellLeft, riserLeft),
    legs: { wellM3: legs.wellM3, riserM3: legs.riserM3, wellDoneM3: a.wellDoneM3, riserDoneM3: a.riserDoneM3, riserStartUtcMs: a.riserStartUtcMs },
    note, warnings: legs.warnings,
  };
}

/**
 * The lagged sample depth now: the latest cut time whose sample has
 * reached surface (bisection; the arrival time is monotone in the cut time).
 */
export function laggedDepthNow({ nowUtcMs, bitDepthHistory, pumpLog, lagCtx }) {
  if (!bitDepthHistory || !bitDepthHistory.length) return { laggedMdM: null, converged: false, note: 'No bit depth has been recorded.' };
  const cache = new Map();
  const legsAt = (md) => {
    const key = Math.round(md * 1000);
    if (!cache.has(key)) cache.set(key, lagLegsAt(lagCtx, md));
    return cache.get(key);
  };
  const t0 = Math.min(bitDepthHistory[0].utcMs, pumpLog.length ? pumpLog[0].utcMs : bitDepthHistory[0].utcMs);
  // f(t) >= 0 when the sample cut at t is at surface by now
  const f = (t) => {
    const a = legArrival({ cutUtcMs: t, legs: legsAt(bitDepthAt(bitDepthHistory, t)), lagCtx, pumpLog, nowUtcMs });
    return a.reached ? nowUtcMs - a.arrivalUtcMs : -Infinity;
  };
  const f0 = f(t0);
  if (f0 < 0) {
    // not enough pumped since the record began to bring the earliest cuttings up
    const first = legsAt(bitDepthAt(bitDepthHistory, t0));
    const rates = ratesAt(pumpLog, nowUtcMs);
    const ratio = rates.spm > 0 ? (rates.boosterSpm || 0) / rates.spm : 0;
    return { laggedMdM: null, converged: false, cutUtcMs: null, lagStrokes: first.wellStrokes + riserStrokesAtRatio(first.riserM3, lagCtx, ratio), strokesBack: strokesBetween(pumpLog, t0, nowUtcMs), note: 'Cuttings from the start of the record have not reached surface yet.' };
  }
  let lo = t0;
  let hi = nowUtcMs;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (f(mid) >= 0) lo = mid; else hi = mid;
  }
  const cut = lo;
  const md = bitDepthAt(bitDepthHistory, cut);
  const legs = legsAt(md);
  const rates = ratesAt(pumpLog, nowUtcMs);
  const ratio = rates.spm > 0 ? (rates.boosterSpm || 0) / rates.spm : 0;
  return { laggedMdM: md, cutUtcMs: cut, lagStrokes: legs.wellStrokes + riserStrokesAtRatio(legs.riserM3, lagCtx, ratio), strokesBack: strokesBetween(pumpLog, cut, nowUtcMs), converged: true, note: '' };
}

/** The status-bar readout. */
export function lagReadout({ nowUtcMs, bitMdM, bitDepthHistory, pumpLog, lagCtx }) {
  const bit = Number.isFinite(bitMdM) ? bitMdM : bitDepthAt(bitDepthHistory, nowUtcMs);
  const rates = ratesAt(pumpLog, nowUtcMs);
  const out = { bitMdM: bit, spmNow: rates.spm, boosterSpmNow: rates.boosterSpm, lagStrokes: null, wellStrokes: null, riserStrokes: null, lagTimeMin: null, laggedMdM: null, bottomsUpUtcMs: null, riserM3: 0, wellM3: 0, warnings: [], note: '' };
  if (!(bit > 0)) return { ...out, note: 'No bit depth has been recorded.' };
  try {
    const l = lagStrokesAt(lagCtx, bit, { spm: rates.spm, boosterSpm: rates.boosterSpm });
    out.lagStrokes = l.lagStrokes;
    out.wellStrokes = l.wellStrokes;
    out.riserStrokes = l.riserStrokes;
    out.riserM3 = l.riserM3;
    out.wellM3 = l.wellM3;
    out.warnings = l.warnings;
    out.lagTimeMin = remainingMinutes(rates, lagCtx, l.wellM3, l.riserM3);
    const bu = legArrival({ cutUtcMs: nowUtcMs, legs: { wellM3: l.wellM3, riserM3: l.riserM3, wellStrokes: l.wellStrokes }, lagCtx, pumpLog, nowUtcMs });
    out.bottomsUpUtcMs = bu.reached ? bu.arrivalUtcMs : null;
    const lagged = laggedDepthNow({ nowUtcMs, bitDepthHistory, pumpLog, lagCtx });
    out.laggedMdM = lagged.laggedMdM;
    out.note = lagged.note || (out.spmNow === 0 ? 'Pumps are off, lag time is undefined until circulation restarts.' : '');
  } catch (e) { out.note = e.message; }
  return out;
}
