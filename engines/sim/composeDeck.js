// Deck composer: a validated spec -> one runnable Eclipse-format deck for
// OPM Flow (FIELD units, three-phase black oil with dissolved gas). The
// spec carries plain data rows the Suite derives from the fluid/scal
// engines; nothing here computes physics. The generated deck goes through
// the exact same worker validation and run path as an uploaded one.
//
// S4 additions: structural tops (grid.tops per-cell array), deviated
// wells (well.connections from wellPath), and a production-history
// schedule (schedule.history -> WCONHIST/WCONINJH + DATES, with the
// prediction TSTEP phase after it and observed-rate SUMMARY vectors).
import { fmt, eclDate, daysBetween } from './deckFormat.js';
import {
  emitPVTO, emitPVDG, emitPVTW, emitROCK, emitDENSITY,
} from './emitPvt.js';
import { emitSWOF, emitSGOF } from './emitSatFns.js';
import {
  emitGrid, gridCellCount, gridDepthRange, topsArray,
} from './emitGrid.js';
import {
  emitWELSPECS, emitCOMPDAT, emitWCONPROD, emitWCONINJE, emitTSTEP,
  emitHistorySchedule, historyStepCount, wellHeadIJ, wellConnectionCount,
  scheduleStepCount,
} from './emitSchedule.js';

export { eclDate };

/** Cheap structural validation with actionable messages (the worker still
 *  re-validates authoritatively). Returns { ok, errors }. */
export function validateSpec(spec) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  need(spec?.title, 'A title is required.');
  need(spec?.startDate, 'A start date is required.');
  need(spec?.grid?.nx > 0 && spec?.grid?.ny > 0 && spec?.grid?.nz > 0, 'Grid dimensions are required.');
  need(Array.isArray(spec?.grid?.layers) && spec.grid.layers.length === spec?.grid?.nz,
    'One layer entry per NZ layer is required.');
  if (spec?.grid) {
    try {
      topsArray(spec.grid);
    } catch (e) {
      errors.push(e.message.replace(/^emitGrid: /, 'Grid structure: '));
    }
  }
  need(Array.isArray(spec?.pvt?.pvtoRecords) && spec.pvt.pvtoRecords.length > 1,
    'A live-oil PVT table (at least 2 Rs nodes) is required.');
  need(Array.isArray(spec?.pvt?.pvdg) && spec.pvt.pvdg.length > 1, 'A gas PVT table is required.');
  need(spec?.pvt?.pvtw && spec?.pvt?.rock && spec?.pvt?.density, 'Water PVT, rock and density are required.');
  need(Array.isArray(spec?.satfn?.swof) && spec.satfn.swof.length > 2, 'A water-oil kr table is required.');
  need(Array.isArray(spec?.satfn?.sgof) && spec.satfn.sgof.length > 2, 'A gas-oil kr table is required.');
  need(spec?.equil && Number.isFinite(spec.equil.datumDepth) && Number.isFinite(spec.equil.datumPressure),
    'Equilibration datum depth and pressure are required.');
  need(Array.isArray(spec?.wells) && spec.wells.length > 0, 'At least one well is required.');
  (spec?.wells || []).forEach((w) => {
    if (Array.isArray(w.connections)) {
      need(w.connections.length > 0,
        `Well ${w.name || '?'} has a trajectory that misses the grid entirely.`);
      w.connections.forEach((c) => {
        need(c.i >= 1 && c.i <= spec.grid.nx && c.j >= 1 && c.j <= spec.grid.ny
          && c.k >= 1 && c.k <= spec.grid.nz,
        `Well ${w.name || '?'} has a connection outside the grid.`);
      });
      return;
    }
    need(w.i >= 1 && w.i <= spec.grid.nx && w.j >= 1 && w.j <= spec.grid.ny,
      `Well ${w.name || '?'} is outside the grid.`);
    need(w.k1 >= 1 && w.k2 <= spec.grid.nz, `Well ${w.name || '?'} completion is outside the layers.`);
  });

  const history = spec?.schedule?.history;
  if (history) {
    const periods = history.periods || [];
    need(periods.length > 0, 'History needs at least one rate period.');
    if (periods.length) {
      need(periods[0].date === spec.startDate,
        `The first history period (${periods[0].date}) must start on the deck start date (${spec.startDate}).`);
      let datesOk = true;
      try {
        for (let idx = 0; idx < periods.length; idx += 1) {
          const next = idx + 1 < periods.length ? periods[idx + 1].date : history.endDate;
          if (daysBetween(periods[idx].date, next) <= 0) datesOk = false;
        }
      } catch {
        datesOk = false;
      }
      need(datesOk, 'History period dates must be valid and strictly ascending up to the end date.');
      const names = new Set(spec.wells.map((w) => w.name));
      periods.forEach((p) => {
        [...(p.prod || []), ...(p.inj || [])].forEach((r) => {
          need(names.has(r.name), `History names well ${r.name}, which is not in the model.`);
        });
      });
    }
  }
  const predictionSteps = scheduleStepCountSafe(spec);
  need(predictionSteps > 0 || historyStepCount(history) > 0,
    'A schedule with at least one timestep (or a history) is required.');
  return { ok: errors.length === 0, errors };
}

function scheduleStepCountSafe(spec) {
  try {
    return scheduleStepCount(spec?.schedule?.steps || []);
  } catch {
    return 0;
  }
}

const SUMMARY_FIELD = ['FOPR', 'FOPT', 'FWPR', 'FWCT', 'FGPR', 'FGOR', 'FPR',
  'FWIR', 'FGIR', 'FWIT', 'FGIT'];
const SUMMARY_WELL = ['WOPR', 'WWPR', 'WGPR', 'WBHP', 'WWCT', 'WWIR', 'WGIR'];
const SUMMARY_FIELD_HIST = ['FOPRH', 'FWPRH', 'FGPRH', 'FWCTH', 'FGORH'];
const SUMMARY_WELL_HIST = ['WOPRH', 'WWPRH', 'WGPRH'];

export function composeDeck(spec) {
  const { ok, errors } = validateSpec(spec);
  if (!ok) throw new Error(`composeDeck: invalid spec:\n- ${errors.join('\n- ')}`);

  const { grid, pvt, satfn, equil, wells, schedule } = spec;
  const history = schedule.history || null;
  const producers = wells.filter((w) => w.type === 'producer');
  const injectors = wells.filter((w) => w.type !== 'producer');
  const depth = gridDepthRange(grid);
  const maxConn = Math.max(...wells.map((w) => wellConnectionCount(w, grid.nz)));

  const runspec = [
    'RUNSPEC',
    '',
    'TITLE',
    `  ${spec.title}`,
    '',
    'DIMENS',
    `  ${grid.nx} ${grid.ny} ${grid.nz} /`,
    '',
    'OIL',
    'WATER',
    'GAS',
    'DISGAS',
    '',
    'FIELD',
    '',
    'EQLDIMS',
    '  1 /',
    '',
    'TABDIMS',
    '  1 1 60 60 /',
    '',
    'WELLDIMS',
    `  ${wells.length} ${maxConn} 2 ${wells.length} /`,
    '',
    'START',
    `  ${eclDate(spec.startDate)} /`,
    '',
    'UNIFOUT',
    '',
  ].join('\n');

  const gridSec = ['GRID', '', 'INIT', '', emitGrid(grid)].join('\n');

  const props = [
    'PROPS',
    '',
    emitSWOF(satfn.swof),
    emitSGOF(satfn.sgof),
    emitDENSITY(pvt.density),
    emitPVTW(pvt.pvtw),
    emitPVDG(pvt.pvdg),
    emitPVTO(pvt.pvtoRecords),
    emitROCK(pvt.rock),
  ].join('\n');

  // EQUIL: datum, p@datum, OWC, Pc@OWC, GOC, Pc@GOC. With no explicit
  // contacts the composer keeps the whole box in the oil leg: OWC below
  // the reservoir, GOC above it. RSVD holds Rs constant (= the PVT table's
  // top node) across depth — the undersaturated-uniform scope. Structural
  // grids use the true depth envelope, not a single TOPS scalar.
  const owc = equil.owc ?? depth.bottomMax + 100;
  const goc = equil.goc ?? depth.topMin - 100;
  const rsTop = pvt.pvtoRecords[pvt.pvtoRecords.length - 1].rs;
  const solution = [
    'SOLUTION',
    '',
    'EQUIL',
    `  ${fmt(equil.datumDepth, 2)} ${fmt(equil.datumPressure, 2)} ${fmt(owc, 2)} 0 ${fmt(goc, 2)} 0 1 0 0 /`,
    '',
    'RSVD',
    `  ${fmt(depth.topMin, 2)} ${fmt(rsTop, 4)}`,
    `  ${fmt(depth.bottomMax, 2)} ${fmt(rsTop, 4)} /`,
    '',
  ].join('\n');

  const summary = [
    'SUMMARY',
    '',
    ...SUMMARY_FIELD,
    ...(history ? SUMMARY_FIELD_HIST : []),
    '',
    ...[...SUMMARY_WELL, ...(history ? SUMMARY_WELL_HIST : [])]
      .flatMap((k) => [k, '/', '']),
  ].join('\n');

  // With a history the producers run on observed rates (WCONHIST) until
  // the history end date; the prediction phase then switches every well
  // to its declared controls and marches TSTEP. Without one it is the
  // S3 prediction-only schedule.
  const predictionBlocks = (schedule.steps && scheduleStepCountSafe(spec) > 0)
    ? [emitWCONPROD(producers), emitWCONINJE(injectors), emitTSTEP(schedule.steps)]
    : [];
  const scheduleSec = [
    'SCHEDULE',
    '',
    'RPTSCHED',
    "  'RESTART=0' /",
    '',
    emitWELSPECS(wells),
    emitCOMPDAT(wells),
    ...(history ? [emitHistorySchedule(history)] : []),
    ...predictionBlocks,
    'END',
    '',
  ].join('\n');

  const stepTotal = scheduleStepCountSafe(spec) + historyStepCount(history);
  return [
    '-- Generated by Petrolord Reservoir Simulation Studio (deck builder)',
    `-- Cells: ${gridCellCount(grid)}, wells: ${wells.length}, steps: ${stepTotal}`,
    '',
    runspec,
    gridSec,
    props,
    solution,
    summary,
    scheduleSec,
  ].join('\n');
}

export { wellHeadIJ };
