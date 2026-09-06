// Wellsite Studio WS3: the sampling programme and sample lifecycle
// (spec sections 13 and 16). The programme is versioned and authorised;
// scheduled depths come from it; a sample's status is the highest stage
// it has reached; a sample past its predicted arrival by more than the
// tolerance is overdue for review, never "missed" (the app cannot know).

import { arrivalPrediction, cutTimeOf } from './lag.js';

export const SAMPLE_STAGES = Object.freeze(['scheduled', 'due', 'caught', 'washed', 'dried', 'described', 'photographed', 'bagged']);
export const DEFAULT_MANDATORY = Object.freeze(['caught', 'described', 'bagged']);
const stageIndex = (s) => SAMPLE_STAGES.indexOf(s);

/** Programme rows: [{ fromMdM, toMdM|null, intervalM }], the last row may be open-ended. */
export function validateProgramme(p) {
  const errors = [];
  const rows = p && Array.isArray(p.rows) ? p.rows : null;
  if (!rows || !rows.length) return ['A sampling programme needs at least one row.'];
  rows.forEach((r, i) => {
    const n = i + 1;
    if (!Number.isFinite(r.fromMdM) || r.fromMdM < 0) errors.push(`Row ${n} needs a start depth.`);
    if (r.toMdM != null && !(r.toMdM > r.fromMdM)) errors.push(`Row ${n} needs an end depth below its start.`);
    if (!(r.intervalM > 0)) errors.push(`Row ${n} needs a positive sample interval.`);
    if (r.toMdM == null && i < rows.length - 1) errors.push(`Row ${n} is open-ended but is not the last row.`);
    if (i > 0 && rows[i - 1].toMdM != null && r.fromMdM < rows[i - 1].toMdM) errors.push(`Row ${n} overlaps row ${i}.`);
  });
  return errors;
}

/** Scheduled sample depths between two depths, walking each row from its start in its interval. */
export function scheduledDepths(p, { fromMdM = 0, toMdM }) {
  const out = [];
  for (let i = 0; i < p.rows.length; i += 1) {
    const r = p.rows[i];
    const end = Math.min(r.toMdM == null ? Infinity : r.toMdM, toMdM);
    const n = Math.floor((end - r.fromMdM) / r.intervalM + 1e-9);
    for (let k = 1; k <= n; k += 1) {
      const md = r.fromMdM + k * r.intervalM;
      if (md < fromMdM - 1e-9) continue;
      if (md > toMdM + 1e-9) break;
      // a depth on a row boundary belongs to the row that ends there
      if (out.length && Math.abs(out[out.length - 1].mdM - md) < 1e-9) continue;
      out.push({ mdM: md, programmeVersion: p.version, rowIndex: i });
    }
  }
  return out;
}

/** A new programme version; refuses an unauthorised change. */
export function applyProgrammeChange(p, rows, { authorisedBy, atUtc, reason }) {
  if (!(authorisedBy && String(authorisedBy).trim())) throw new Error('A sampling programme change needs the person who authorised it.');
  const next = { version: (p && p.version ? p.version : 0) + 1, rows, authorisedBy, authorisedAtUtc: atUtc, reason: reason || '' };
  const errors = validateProgramme(next);
  if (errors.length) throw new Error(errors[0]);
  return next;
}

export function statusConfig({ mandatory = DEFAULT_MANDATORY } = {}) {
  const m = mandatory.filter((s) => SAMPLE_STAGES.includes(s));
  return { mandatory: m };
}

/** The status of a sample from its stage rows: the highest stage reached. */
export function highestStage(stages) {
  let best = 'scheduled';
  for (const s of stages || []) if (stageIndex(s.stage ?? s) > stageIndex(best)) best = s.stage ?? s;
  return best;
}

/** May the sample advance to `to` given the stages it has? Mandatory predecessors cannot be skipped. */
export function canAdvance(stages, to, cfg = statusConfig()) {
  if (!SAMPLE_STAGES.includes(to)) return { ok: false, reason: `Unknown stage ${to}.` };
  const have = new Set((stages || []).map((s) => s.stage ?? s));
  if (have.has(to)) return { ok: false, reason: `The sample is already ${to}.` };
  for (const m of cfg.mandatory) {
    if (stageIndex(m) < stageIndex(to) && !have.has(m)) return { ok: false, reason: `Stage ${to} needs the mandatory stage ${m} first.` };
  }
  return { ok: true, reason: '' };
}

/** The stage row to append (the caller stores it). */
export function advance(stages, to, { atUtc, by, note = null }, cfg = statusConfig()) {
  const c = canAdvance(stages, to, cfg);
  if (!c.ok) throw new Error(c.reason);
  return { stage: to, atUtc, by, note };
}

/**
 * Where a scheduled sample stands right now.
 * @returns {{state:'scheduled'|'in_transit'|'due'|'overdue'|'caught'|'at_surface', minutesPastArrival:number|null}}
 */
export function dueState(sample, { bitMdM, nowUtcMs, arrivalUtcMs = null, toleranceMin = 15, stages = [] }) {
  const status = highestStage(stages);
  if (stageIndex(status) >= stageIndex('caught')) return { state: 'caught', minutesPastArrival: null, status };
  if (!(bitMdM >= sample.mdM)) return { state: 'scheduled', minutesPastArrival: null, status };
  if (arrivalUtcMs == null) return { state: 'in_transit', minutesPastArrival: null, status };
  const past = (nowUtcMs - arrivalUtcMs) / 60000;
  if (past < 0) return { state: 'in_transit', minutesPastArrival: past, status };
  if (past <= toleranceMin) return { state: 'due', minutesPastArrival: past, status };
  return { state: 'overdue', minutesPastArrival: past, status };
}

/** Samples cut but not yet at surface. */
export function inTransit(samples, { bitMdM, laggedMdM }) {
  const lagged = Number.isFinite(laggedMdM) ? laggedMdM : -Infinity;
  return samples.filter((s) => s.mdM <= bitMdM && s.mdM > lagged && stageIndex(highestStage(s.stages)) < stageIndex('caught'));
}

/** Predicted arrival of every cut sample from the bit history and pump log. */
export function expectedArrivals(samples, { bitDepthHistory, pumpLog, lagCtx, nowUtcMs }) {
  const out = [];
  for (const s of samples) {
    const cut = cutTimeOf(bitDepthHistory, s.mdM);
    if (cut == null) { out.push({ sampleId: s.id, mdM: s.mdM, cutUtcMs: null, arrivalUtcMs: null, note: 'Not yet drilled.' }); continue; }
    const p = arrivalPrediction({ cutUtcMs: cut, cutMdM: s.mdM, lagCtx, pumpLog, nowUtcMs });
    out.push({ sampleId: s.id, mdM: s.mdM, cutUtcMs: cut, arrivalUtcMs: p.arrivalUtcMs, reached: p.reached, strokesRemaining: p.strokesRemaining, lagTimeAtCurrentSpmMin: p.lagTimeAtCurrentSpmMin, note: p.note });
  }
  return out;
}
