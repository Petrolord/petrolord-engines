// PVT keyword emitters (PROPS section). Pure serializers over rows the
// caller derives from the validated fluid engines — no correlations here.
// FIELD units: psia, RB/STB, Mscf/STB (Rs), RB/Mscf (Bg), cp, lb/ft3.
import { fmt, wrap } from './deckFormat.js';

/**
 * PVTO (live oil). records: ascending Rs, each
 *   { rs, p, bo, muo, undersat?: [{p, bo, muo}] }
 * where p is the bubble-point pressure of that Rs node and undersat rows
 * (ascending p > pb) extend the node at constant Rs. Eclipse requires the
 * last node to carry an undersaturated branch; the composer guarantees it.
 */
export function emitPVTO(records) {
  if (!records?.length) throw new Error('emitPVTO: no records');
  let lastRs = -Infinity;
  const lines = ['PVTO'];
  records.forEach((rec) => {
    if (!(rec.rs > lastRs)) throw new Error('emitPVTO: Rs must strictly increase');
    lastRs = rec.rs;
    const head = `  ${fmt(rec.rs, 4)}  ${fmt(rec.p, 2)} ${fmt(rec.bo, 5)} ${fmt(rec.muo, 5)}`;
    const branch = rec.undersat || [];
    if (!branch.length) {
      lines.push(`${head} /`);
    } else {
      lines.push(head);
      branch.forEach((u, i) => {
        if (!(u.p > rec.p)) throw new Error('emitPVTO: undersaturated p must exceed node pb');
        const tail = i === branch.length - 1 ? ' /' : '';
        lines.push(`         ${fmt(u.p, 2)} ${fmt(u.bo, 5)} ${fmt(u.muo, 5)}${tail}`);
      });
    }
  });
  lines.push('/', '');
  return lines.join('\n');
}

/** PVDG (dry gas): rows ascending p, { p, bg, mug } with Bg in RB/Mscf. */
export function emitPVDG(rows) {
  if (!rows?.length) throw new Error('emitPVDG: no rows');
  const lines = ['PVDG'];
  let lastP = -Infinity;
  rows.forEach((r) => {
    if (!(r.p > lastP)) throw new Error('emitPVDG: pressure must strictly increase');
    lastP = r.p;
    lines.push(`  ${fmt(r.p, 2)} ${fmt(r.bg, 6)} ${fmt(r.mug, 6)}`);
  });
  lines.push('/', '');
  return lines.join('\n');
}

/** PVTW: { pref, bw, cw, muw, viscosibility = 0 }. */
export function emitPVTW({ pref, bw, cw, muw, viscosibility = 0 }) {
  return ['PVTW', `  ${fmt(pref, 2)} ${fmt(bw, 5)} ${fmt(cw, 8)} ${fmt(muw, 5)} ${fmt(viscosibility, 6)} /`, ''].join('\n');
}

/** ROCK: { pref, cr }. */
export function emitROCK({ pref, cr }) {
  return ['ROCK', `  ${fmt(pref, 2)} ${fmt(cr, 8)} /`, ''].join('\n');
}

/** DENSITY (surface, lb/ft3): { oil, water, gas }. */
export function emitDENSITY({ oil, water, gas }) {
  return ['DENSITY', `  ${fmt(oil, 4)} ${fmt(water, 4)} ${fmt(gas, 5)} /`, ''].join('\n');
}

/**
 * Build PVTO records from a saturated black-oil table plus an
 * undersaturated closure for the top node.
 * satRows: ascending pressure up to pb, each { p, rs, bo, muo } (saturated
 * backbone from the fluid engine). undersat: ascending p rows above pb at
 * Rs = Rsb ({ p, bo, muo }). Non-physical duplicates (equal Rs from the
 * pressure grid) are collapsed keeping the lowest-p node.
 */
export function pvtoRecordsFromTable(satRows, undersat) {
  if (!satRows?.length) throw new Error('pvtoRecordsFromTable: no saturated rows');
  if (!undersat?.length) throw new Error('pvtoRecordsFromTable: last node needs an undersaturated branch');
  const records = [];
  satRows.forEach((r) => {
    const prev = records[records.length - 1];
    if (prev && !(r.rs > prev.rs + 1e-9)) return; // collapse duplicate Rs
    records.push({ rs: r.rs, p: r.p, bo: r.bo, muo: r.muo });
  });
  records[records.length - 1].undersat = undersat.map((u) => ({ p: u.p, bo: u.bo, muo: u.muo }));
  return records;
}

/** Convenience: wrap helper re-export for composers. */
export { wrap as _wrap };
