// SCHEDULE-section emitters. Wells are vertical (I, J with a K1-K2
// completion window) in the S3 scope; deviated trajectories via the
// drilling survey engine are an S4 idea.
import { fmt } from './deckFormat.js';

const PHASE_OF = { producer: 'OIL', water_injector: 'WATER', gas_injector: 'GAS' };

function checkWell(w) {
  if (!w.name || !/^[A-Za-z0-9_-]{1,8}$/.test(w.name)) {
    throw new Error(`emitSchedule: well name '${w.name}' must be 1-8 plain characters`);
  }
  if (!PHASE_OF[w.type]) throw new Error(`emitSchedule: unknown well type '${w.type}'`);
  [w.i, w.j, w.k1, w.k2].forEach((n) => {
    if (!Number.isInteger(n) || n < 1) throw new Error(`emitSchedule: ${w.name} needs integer i/j/k1/k2 >= 1`);
  });
  if (w.k2 < w.k1) throw new Error(`emitSchedule: ${w.name} has k2 < k1`);
}

/** wells: [{name, group?, i, j, refDepth, type}] */
export function emitWELSPECS(wells) {
  const lines = ['WELSPECS'];
  wells.forEach((w) => {
    checkWell(w);
    lines.push(`  '${w.name}' '${w.group || 'G1'}' ${w.i} ${w.j} ${fmt(w.refDepth, 2)} '${PHASE_OF[w.type]}' /`);
  });
  lines.push('/', '');
  return lines.join('\n');
}

/** wells: [{name, i, j, k1, k2, wellboreRadiusFt = 0.25}] */
export function emitCOMPDAT(wells) {
  const lines = ['COMPDAT'];
  wells.forEach((w) => {
    checkWell(w);
    const rw = w.wellboreRadiusFt ?? 0.25;
    lines.push(`  '${w.name}' ${w.i} ${w.j} ${w.k1} ${w.k2} 'OPEN' 1* 1* ${fmt(2 * rw, 4)} /`);
  });
  lines.push('/', '');
  return lines.join('\n');
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
