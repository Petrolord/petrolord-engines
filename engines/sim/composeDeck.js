// Deck composer: a validated spec -> one runnable Eclipse-format deck for
// OPM Flow (FIELD units, three-phase black oil with dissolved gas). The
// spec carries plain data rows the Suite derives from the fluid/scal
// engines; nothing here computes physics. The generated deck goes through
// the exact same worker validation and run path as an uploaded one.
import { fmt } from './deckFormat.js';
import {
  emitPVTO, emitPVDG, emitPVTW, emitROCK, emitDENSITY,
} from './emitPvt.js';
import { emitSWOF, emitSGOF } from './emitSatFns.js';
import { emitGrid, gridCellCount } from './emitGrid.js';
import {
  emitWELSPECS, emitCOMPDAT, emitWCONPROD, emitWCONINJE, emitTSTEP,
  scheduleStepCount,
} from './emitSchedule.js';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** '2026-01-01' -> "1 'JAN' 2026". */
export function eclDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) throw new Error(`composeDeck: startDate must be YYYY-MM-DD, got '${iso}'`);
  return `${Number(m[3])} '${MONTHS[Number(m[2]) - 1]}' ${m[1]}`;
}

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
    need(w.i >= 1 && w.i <= spec.grid.nx && w.j >= 1 && w.j <= spec.grid.ny,
      `Well ${w.name || '?'} is outside the grid.`);
    need(w.k1 >= 1 && w.k2 <= spec.grid.nz, `Well ${w.name || '?'} completion is outside the layers.`);
  });
  need(Array.isArray(spec?.schedule?.steps) && scheduleStepCountSafe(spec) > 0,
    'A schedule with at least one timestep is required.');
  return { ok: errors.length === 0, errors };
}

function scheduleStepCountSafe(spec) {
  try {
    return scheduleStepCount(spec?.schedule?.steps || []);
  } catch {
    return 0;
  }
}

const SUMMARY_FIELD = ['FOPR', 'FOPT', 'FWPR', 'FWCT', 'FGPR', 'FGOR', 'FPR'];
const SUMMARY_WELL = ['WOPR', 'WWPR', 'WGPR', 'WBHP', 'WWCT'];

export function composeDeck(spec) {
  const { ok, errors } = validateSpec(spec);
  if (!ok) throw new Error(`composeDeck: invalid spec:\n- ${errors.join('\n- ')}`);

  const { grid, pvt, satfn, equil, wells, schedule } = spec;
  const producers = wells.filter((w) => w.type === 'producer');
  const injectors = wells.filter((w) => w.type !== 'producer');

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
    `  ${wells.length} ${grid.nz} 2 ${wells.length} /`,
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
  // top node) across depth — the undersaturated-uniform S3 scope.
  const bottomDepth = grid.topsDepth + grid.layers.reduce((s, l) => s + Number(l.dz), 0);
  const owc = equil.owc ?? bottomDepth + 100;
  const goc = equil.goc ?? grid.topsDepth - 100;
  const rsTop = pvt.pvtoRecords[pvt.pvtoRecords.length - 1].rs;
  const solution = [
    'SOLUTION',
    '',
    'EQUIL',
    `  ${fmt(equil.datumDepth, 2)} ${fmt(equil.datumPressure, 2)} ${fmt(owc, 2)} 0 ${fmt(goc, 2)} 0 1 0 0 /`,
    '',
    'RSVD',
    `  ${fmt(grid.topsDepth, 2)} ${fmt(rsTop, 4)}`,
    `  ${fmt(bottomDepth, 2)} ${fmt(rsTop, 4)} /`,
    '',
  ].join('\n');

  const summary = [
    'SUMMARY',
    '',
    ...SUMMARY_FIELD,
    '',
    ...SUMMARY_WELL.flatMap((k) => [k, '/', '']),
  ].join('\n');

  const scheduleSec = [
    'SCHEDULE',
    '',
    'RPTSCHED',
    "  'RESTART=0' /",
    '',
    emitWELSPECS(wells),
    emitCOMPDAT(wells),
    emitWCONPROD(producers),
    emitWCONINJE(injectors),
    emitTSTEP(schedule.steps),
    'END',
    '',
  ].join('\n');

  return [
    '-- Generated by Petrolord Reservoir Simulation Studio (S3 deck builder)',
    `-- Cells: ${gridCellCount(grid)}, wells: ${wells.length}, steps: ${scheduleStepCount(schedule.steps)}`,
    '',
    runspec,
    gridSec,
    props,
    solution,
    summary,
    scheduleSec,
  ].join('\n');
}
