// Analytical aquifer emitters (Reservoir Simulation Studio U2-004): a
// Fetkovich (AQUFETP) or Carter-Tracy (AQUCT, with its influence table
// AQUTAB) aquifer joined to one face of the grid (AQUANCON), in FIELD units.
// The spec carries plain numbers the Suite takes from a Material Balance case
// (mbal-1) or the form; nothing here computes physics. The influence table
// rows (tD, pD) are given by the caller.
//
// spec.aquifer = {
//   model: 'fetkovich' | 'carter_tracy',
//   datumDepth,                                  ft, the depth of the aquifer's initial pressure
//   initialPressure?,                            psia; omitted, the simulator takes the equilibrium pressure at the datum
//   fetkovich?: { volume, ct, pi },              initial water in the aquifer (bbl), total compressibility (1/psi),
//                                                productivity index (bbl/d/psi)
//   carterTracy?: { k, phi, ct, r0, h, theta,    mD, fraction, 1/psi, ft, ft, degrees
//                   influence?: [{ tD, pD }] },  the influence table (table 2); omitted, the simulator's table 1
//   connection: { face, i1, i2, j1, j2, k1, k2 } face 'I-', 'I+', 'J-', 'J+', 'K-' or 'K+'
// }
import { fmt } from './deckFormat.js';

export const AQUIFER_FACES = Object.freeze(['I-', 'I+', 'J-', 'J+', 'K-', 'K+']);
// OPM Flow 2026.04 does not handle the field totals FAQR and FAQT (seen in the
// worker gate: "Unhandled summary keyword"); the per-aquifer vectors it does.
export const AQUIFER_VECTORS = Object.freeze(['AAQR', 'AAQT', 'AAQP']);
const pos = (v) => Number.isFinite(Number(v)) && Number(v) > 0;
/** Twelve significant figures, so a compressibility of 3.1e-6 1/psi keeps its digits (fmt would round it to 0.000003). */
const sig = (v) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`emitAquifer: non-finite value ${v}`); return String(parseFloat(n.toPrecision(12))); };

/** Structural checks, as messages (composeDeck's validateSpec adds them). */
export function aquiferErrors(aq, grid) {
  const e = [];
  if (!aq) return e;
  if (aq.model !== 'fetkovich' && aq.model !== 'carter_tracy') return [`Aquifer: model must be fetkovich or carter_tracy (got ${aq.model}).`];
  if (!Number.isFinite(Number(aq.datumDepth))) e.push('Aquifer: a datum depth is required.');
  if (aq.initialPressure != null && !pos(aq.initialPressure)) e.push('Aquifer: the initial pressure must be positive.');
  if (aq.model === 'fetkovich') {
    const f = aq.fetkovich || {};
    if (!pos(f.volume)) e.push('Aquifer (Fetkovich): the initial water volume must be positive.');
    if (!pos(f.ct)) e.push('Aquifer (Fetkovich): the total compressibility must be positive.');
    if (!pos(f.pi)) e.push('Aquifer (Fetkovich): the productivity index must be positive.');
  } else {
    const c = aq.carterTracy || {};
    ['k', 'ct', 'r0', 'h'].forEach((k) => { if (!pos(c[k])) e.push(`Aquifer (Carter-Tracy): ${k} must be positive.`); });
    if (!(pos(c.phi) && c.phi < 1)) e.push('Aquifer (Carter-Tracy): porosity must be in (0, 1).');
    if (!(pos(c.theta) && c.theta <= 360)) e.push('Aquifer (Carter-Tracy): the influence angle must be in (0, 360] degrees.');
    if (c.influence != null) {
      const rows = c.influence;
      if (!Array.isArray(rows) || rows.length < 2) e.push('Aquifer (Carter-Tracy): the influence table needs at least two rows.');
      else {
        for (let i = 0; i < rows.length; i += 1) {
          if (!(Number.isFinite(rows[i].tD) && Number.isFinite(rows[i].pD) && rows[i].tD >= 0 && rows[i].pD >= 0)) { e.push('Aquifer (Carter-Tracy): influence table values must be non-negative numbers.'); break; }
          if (i && !(rows[i].tD > rows[i - 1].tD && rows[i].pD >= rows[i - 1].pD)) { e.push('Aquifer (Carter-Tracy): influence table tD must increase and pD must not decrease.'); break; }
        }
      }
    }
  }
  const c = aq.connection || {};
  if (!AQUIFER_FACES.includes(c.face)) e.push(`Aquifer: the connection face must be one of ${AQUIFER_FACES.join(', ')}.`);
  const inBox = (lo, hi, n) => Number.isInteger(lo) && Number.isInteger(hi) && lo >= 1 && hi >= lo && hi <= n;
  if (grid && !(inBox(c.i1, c.i2, grid.nx) && inBox(c.j1, c.j2, grid.ny) && inBox(c.k1, c.k2, grid.nz))) e.push('Aquifer: the connected cells must be inside the grid.');
  return e;
}

/** Cells the connection names (AQUDIMS item 6). */
export const aquiferCellCount = (c) => (c.i2 - c.i1 + 1) * (c.j2 - c.j1 + 1) * (c.k2 - c.k1 + 1);

/** RUNSPEC AQUDIMS: one analytic aquifer, its connected cells, the influence tables (table 1 is the simulator's). */
export function emitAQUDIMS(aq) {
  const rows = aq.carterTracy?.influence?.length || 0;
  const tables = rows ? 2 : 1;
  return ['AQUDIMS', `  1* 1* ${tables} ${Math.max(36, rows)} 1 ${aquiferCellCount(aq.connection)} /`, ''].join('\n');
}

/** PROPS AQUTAB: the Carter-Tracy influence table (it becomes table 2), or nothing. */
export function emitAQUTAB(aq) {
  const rows = aq.model === 'carter_tracy' ? aq.carterTracy?.influence : null;
  if (!rows?.length) return '';
  return ['AQUTAB', ...rows.map((r) => `  ${sig(r.tD)} ${sig(r.pD)}`), '/', ''].join('\n');
}

const p0 = (aq) => (aq.initialPressure != null ? fmt(aq.initialPressure, 2) : '1*');

/** SOLUTION: AQUFETP or AQUCT, then AQUANCON. */
export function emitAquiferSolution(aq) {
  const lines = [];
  if (aq.model === 'fetkovich') {
    const f = aq.fetkovich;
    lines.push('AQUFETP', `  1 ${fmt(aq.datumDepth, 2)} ${p0(aq)} ${sig(f.volume)} ${sig(f.ct)} ${sig(f.pi)} 1 /`, '/', '');
  } else {
    const c = aq.carterTracy;
    const table = c.influence?.length ? 2 : 1;
    lines.push('AQUCT', `  1 ${fmt(aq.datumDepth, 2)} ${p0(aq)} ${sig(c.k)} ${sig(c.phi)} ${sig(c.ct)} ${sig(c.r0)} ${sig(c.h)} ${sig(c.theta)} 1 ${table} /`, '/', '');
  }
  const k = aq.connection;
  lines.push('AQUANCON', `  1 ${k.i1} ${k.i2} ${k.j1} ${k.j2} ${k.k1} ${k.k2} '${k.face}' /`, '/', '');
  return lines.join('\n');
}

/** SUMMARY: the aquifer's influx rate, cumulative influx and pressure (aquifer 1). */
export function emitAquiferSummary() {
  return AQUIFER_VECTORS.flatMap((k) => [k, '  1 /', '']).join('\n');
}
