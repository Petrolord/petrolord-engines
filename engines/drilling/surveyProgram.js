// Survey-program compositing (Well Design Studio WD4): a wellbore is
// rarely surveyed by one tool — a survey program assigns instruments to
// MD intervals (e.g. MWD to casing point, then a new MWD run to TD).
// Positional uncertainty composes by the ISCWSA tie-on convention: at a
// tool change the accumulated covariance FREEZES (it is carried as the
// tie-on uncertainty), and the new run's error sources accumulate from
// zero relative to the tie point — a systematic error of run 2 is not
// correlated with run 1's, which is exactly what distinguishes a
// program from one long run of the same tool.
//
// Implementation: each run is evaluated as a sub-survey through
// computeErrorModel (a tied-on sub-survey starts below the datum, so no
// station-0 depth seed is injected and the tie station contributes zero
// fresh error — the carry is added back here). Depth-dependent weights
// (DSF ∝ MD, DST ∝ MD·TVD) keep their ABSOLUTE depths because the
// sub-survey preserves real MD/TVD.
//
// Pure math, worker-safe, no I/O.

import { computeErrorModel, prepareSurvey, ERROR_MODELS } from './errorModel.js';

/**
 * Instrument library. Only oracle-validated models ship as tools; UI
 * pickers should treat `validated: true` as the trust marker. New tools
 * are added here as their error models pass validation gates.
 */
export const TOOL_LIBRARY = [
  {
    id: 'iscwsa-mwd-rev4',
    label: 'MWD — ISCWSA Rev4 (fixed rig)',
    model: 'ISCWSA MWD Rev4',
    validated: true,
    description: 'Standard magnetic MWD per the ISCWSA/OWSG Rev4 agreed model '
      + '(27 sources; equals OWSG MWD Rev.2). Validated against the official '
      + 'ISCWSA example Well #1 workbook.',
  },
];

export function toolById(toolId) {
  const tool = TOOL_LIBRARY.find((t) => t.id === toolId);
  if (!tool) throw new Error(`Unknown survey tool: ${toolId}`);
  return tool;
}

function zeros33() { return [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; }

function addCov(a, b) {
  const out = zeros33();
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r][c] = a[r][c] + b[r][c];
  return out;
}

/**
 * Compile a survey program over a survey.
 *
 * stations: [{md, inc, azi, tvd?}] (degrees/metres; azi in
 * header.aziReference frame). header: as computeErrorModel. program:
 * ordered [{fromMd, toMd, toolId}] covering the full survey with no
 * gaps or overlaps (run boundaries snap to the nearest station at or
 * below toMd; the boundary station is the tie-on of the next run).
 *
 * Returns {md, totalCov, runs: [{toolId, model, fromIndex, toIndex,
 * fromMd, toMd, tieCov}]} — totalCov is the composited [n][3][3] NEV
 * covariance per station.
 */
export function compileSurveyProgram(stations, header, program) {
  if (!Array.isArray(program) || program.length === 0) {
    throw new Error('Survey program needs at least one run.');
  }
  const n = stations.length;
  const md = stations.map((s) => s.md);

  // Ensure every station carries a TVD so tied-on sub-surveys keep their
  // absolute depths for the stretch weighting.
  let full = stations;
  if (!stations.every((s) => Number.isFinite(s.tvd))) {
    const prep = prepareSurvey(stations, header);
    full = stations.map((s, i) => ({ ...s, tvd: prep.tvd[i] }));
  }

  // Resolve run boundaries to station indices.
  const runs = [];
  let cursor = 0;
  for (let r = 0; r < program.length; r++) {
    const { fromMd, toMd, toolId } = program[r];
    const tool = toolById(toolId);
    if (r === 0 && fromMd > md[0]) {
      throw new Error(`Survey program starts at ${fromMd} but the survey starts at ${md[0]}.`);
    }
    if (r > 0 && Math.abs(fromMd - program[r - 1].toMd) > 1e-9) {
      throw new Error(`Survey program has a gap or overlap at ${fromMd}.`);
    }
    let end = cursor;
    while (end < n - 1 && md[end + 1] <= toMd + 1e-9) end += 1;
    if (end === cursor && r < program.length - 1) {
      throw new Error(`Survey-program run ${toolId} [${fromMd}-${toMd}] covers no survey interval.`);
    }
    runs.push({
      toolId, model: tool.model, fromIndex: cursor, toIndex: end, fromMd, toMd,
    });
    cursor = end;
  }
  if (runs[runs.length - 1].toIndex < n - 1) {
    throw new Error('Survey program does not reach the end of the survey.');
  }

  const totalCov = new Array(n);
  let carry = zeros33();
  for (const run of runs) {
    const sub = full.slice(run.fromIndex, run.toIndex + 1);
    const res = computeErrorModel(sub, header, { model: run.model });
    run.tieCov = carry;
    for (let i = run.fromIndex; i <= run.toIndex; i++) {
      const local = res.totalCov[i - run.fromIndex];
      // The tie station belongs to both runs; keep the frozen value.
      if (totalCov[i] === undefined) totalCov[i] = addCov(carry, local);
    }
    carry = totalCov[run.toIndex];
  }
  return { md, totalCov, runs };
}
