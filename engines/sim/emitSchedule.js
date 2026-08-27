// SCHEDULE-section emitters. Wells are either vertical (I, J with a
// K1-K2 completion window) or deviated (S4): an explicit `connections`
// list from wellPath.connectionsFromPath, one COMPDAT entry per
// penetrated cell with the traversal direction in item 13. History
// periods (S4) serialize as WCONHIST/WCONINJH blocks advanced by DATES.
import { fmt, eclDate, daysBetween } from './deckFormat.js';

const PHASE_OF = { producer: 'OIL', water_injector: 'WATER', gas_injector: 'GAS' };

function checkWell(w) {
  if (!w.name || !/^[A-Za-z0-9_-]{1,8}$/.test(w.name)) {
    throw new Error(`emitSchedule: well name '${w.name}' must be 1-8 plain characters`);
  }
  if (!PHASE_OF[w.type]) throw new Error(`emitSchedule: unknown well type '${w.type}'`);
  if (Array.isArray(w.connections)) {
    if (!w.connections.length) throw new Error(`emitSchedule: ${w.name} has an empty connections list`);
    w.connections.forEach((c) => {
      [c.i, c.j, c.k].forEach((n) => {
        if (!Number.isInteger(n) || n < 1) {
          throw new Error(`emitSchedule: ${w.name} has a connection with non-integer i/j/k`);
        }
      });
      if (c.dir && !['X', 'Y', 'Z'].includes(c.dir)) {
        throw new Error(`emitSchedule: ${w.name} connection direction '${c.dir}' must be X, Y or Z`);
      }
    });
    return;
  }
  [w.i, w.j, w.k1, w.k2].forEach((n) => {
    if (!Number.isInteger(n) || n < 1) throw new Error(`emitSchedule: ${w.name} needs integer i/j/k1/k2 >= 1`);
  });
  if (w.k2 < w.k1) throw new Error(`emitSchedule: ${w.name} has k2 < k1`);
}

/** Head cell (I, J) — explicit i/j, or the first connection's cell. */
export function wellHeadIJ(w) {
  if (Number.isInteger(w.i) && Number.isInteger(w.j)) return { i: w.i, j: w.j };
  if (Array.isArray(w.connections) && w.connections.length) {
    return { i: w.connections[0].i, j: w.connections[0].j };
  }
  throw new Error(`emitSchedule: ${w.name} has neither i/j nor connections`);
}

/** wells: [{name, group?, i?, j?, connections?, refDepth, type}] */
export function emitWELSPECS(wells) {
  const lines = ['WELSPECS'];
  wells.forEach((w) => {
    checkWell(w);
    const { i, j } = wellHeadIJ(w);
    lines.push(`  '${w.name}' '${w.group || 'G1'}' ${i} ${j} ${fmt(w.refDepth, 2)} '${PHASE_OF[w.type]}' /`);
  });
  lines.push('/', '');
  return lines.join('\n');
}

/** wells: [{name, i, j, k1, k2, wellboreRadiusFt?}] or
 *  [{name, connections: [{i, j, k, dir?}], wellboreRadiusFt?}] */
export function emitCOMPDAT(wells) {
  const lines = ['COMPDAT'];
  wells.forEach((w) => {
    checkWell(w);
    const diam = fmt(2 * (w.wellboreRadiusFt ?? 0.25), 4);
    if (Array.isArray(w.connections)) {
      w.connections.forEach((c) => {
        lines.push(`  '${w.name}' ${c.i} ${c.j} ${c.k} ${c.k} 'OPEN' 1* 1* ${diam} 3* '${c.dir || 'Z'}' /`);
      });
    } else {
      lines.push(`  '${w.name}' ${w.i} ${w.j} ${w.k1} ${w.k2} 'OPEN' 1* 1* ${diam} /`);
    }
  });
  lines.push('/', '');
  return lines.join('\n');
}

/** Connection count per well — WELLDIMS needs the maximum. */
export function wellConnectionCount(w, nz) {
  if (Array.isArray(w.connections)) return w.connections.length;
  return (w.k2 ?? 1) - (w.k1 ?? 1) + 1 || nz;
}

/**
 * Producers: control { mode: 'ORAT'|'LRAT'|'BHP', rate?, bhpMin }.
 * Rate in STB/d; bhpMin is the BHP floor (psia).
 */
export function emitWCONPROD(producers) {
  if (!producers.length) return '';
  const lines = ['WCONPROD'];
  producers.forEach((w) => {
    const c = w.control || {};
    const mode = c.mode || 'ORAT';
    if (!['ORAT', 'LRAT', 'BHP'].includes(mode)) {
      throw new Error(`emitWCONPROD: ${w.name} has unsupported mode '${mode}'`);
    }
    const bhp = fmt(c.bhpMin ?? 1000, 2);
    if (mode === 'BHP') {
      lines.push(`  '${w.name}' 'OPEN' 'BHP' 5* ${bhp} /`);
    } else if (mode === 'ORAT') {
      lines.push(`  '${w.name}' 'OPEN' 'ORAT' ${fmt(c.rate ?? 0, 3)} 4* ${bhp} /`);
    } else {
      lines.push(`  '${w.name}' 'OPEN' 'LRAT' 3* ${fmt(c.rate ?? 0, 3)} 1* ${bhp} /`);
    }
  });
  lines.push('/', '');
  return lines.join('\n');
}

/**
 * Injectors: control { rate, bhpMax }. Water rate STB/d, gas rate Mscf/d.
 */
export function emitWCONINJE(injectors) {
  if (!injectors.length) return '';
  const lines = ['WCONINJE'];
  injectors.forEach((w) => {
    const c = w.control || {};
    const phase = w.type === 'gas_injector' ? 'GAS' : 'WATER';
    lines.push(`  '${w.name}' '${phase}' 'OPEN' 'RATE' ${fmt(c.rate ?? 0, 3)} 1* ${fmt(c.bhpMax ?? 10000, 2)} /`);
  });
  lines.push('/', '');
  return lines.join('\n');
}

/** Observed producer rates for one history period:
 *  [{name, orat, wrat, grat}] (STB/d, STB/d, Mscf/d). */
export function emitWCONHIST(rows) {
  if (!rows.length) return '';
  const lines = ['WCONHIST'];
  rows.forEach((r) => {
    [r.orat, r.wrat, r.grat].forEach((v) => {
      if (!Number.isFinite(Number(v)) || Number(v) < 0) {
        throw new Error(`emitWCONHIST: ${r.name} needs non-negative orat/wrat/grat`);
      }
    });
    lines.push(`  '${r.name}' 'OPEN' 'ORAT' ${fmt(r.orat, 3)} ${fmt(r.wrat, 3)} ${fmt(r.grat, 3)} /`);
  });
  lines.push('/', '');
  return lines.join('\n');
}

/** Observed injector rates: [{name, phase: 'WATER'|'GAS', rate}]
 *  (STB/d water, Mscf/d gas). */
export function emitWCONINJH(rows) {
  if (!rows.length) return '';
  const lines = ['WCONINJH'];
  rows.forEach((r) => {
    if (!['WATER', 'GAS'].includes(r.phase)) {
      throw new Error(`emitWCONINJH: ${r.name} phase must be WATER or GAS`);
    }
    if (!Number.isFinite(Number(r.rate)) || Number(r.rate) < 0) {
      throw new Error(`emitWCONINJH: ${r.name} needs a non-negative rate`);
    }
    lines.push(`  '${r.name}' '${r.phase}' 'OPEN' ${fmt(r.rate, 3)} /`);
  });
  lines.push('/', '');
  return lines.join('\n');
}

/** One DATES record advancing the simulator to `iso`. */
export function emitDATES(iso) {
  return ['DATES', `  ${eclDate(iso)} /`, '/', ''].join('\n');
}

/**
 * History schedule: periods of observed rates, each starting at its
 * `date` and lasting until the next period (the last until `endDate`).
 * history: {
 *   periods: [{date, prod: [{name, orat, wrat, grat}],
 *              inj?: [{name, phase, rate}]}],
 *   endDate,
 * }
 * The first period's date must equal the deck START date (the composer
 * validates); each period emits its rate blocks then a DATES advancing
 * to the next boundary, so the block count equals periods.length.
 */
export function emitHistorySchedule(history) {
  const { periods, endDate } = history;
  if (!Array.isArray(periods) || !periods.length) {
    throw new Error('emitHistorySchedule: history needs at least one period');
  }
  const parts = [];
  periods.forEach((p, idx) => {
    const next = idx + 1 < periods.length ? periods[idx + 1].date : endDate;
    if (daysBetween(p.date, next) <= 0) {
      throw new Error(`emitHistorySchedule: period dates must ascend (${p.date} -> ${next})`);
    }
    parts.push(emitWCONHIST(p.prod || []));
    parts.push(emitWCONINJH(p.inj || []));
    parts.push(emitDATES(next));
  });
  return parts.filter(Boolean).join('\n');
}

/** Report steps a history block contributes (one DATES per period). */
export function historyStepCount(history) {
  return history?.periods?.length ?? 0;
}

/** steps: [{count, dtDays}] -> repeated TSTEP blocks. */
export function emitTSTEP(steps) {
  const total = steps.reduce((s, x) => s + x.count, 0);
  if (!total) throw new Error('emitTSTEP: schedule has no steps');
  const lines = [];
  steps.forEach((s) => {
    if (!Number.isInteger(s.count) || s.count < 1 || !(s.dtDays > 0)) {
      throw new Error('emitTSTEP: each entry needs integer count >= 1 and dtDays > 0');
    }
    lines.push('TSTEP', ` ${s.count}*${fmt(s.dtDays, 3)} /`, '');
  });
  return lines.join('\n');
}

export function scheduleStepCount(steps) {
  return steps.reduce((s, x) => s + x.count, 0);
}
