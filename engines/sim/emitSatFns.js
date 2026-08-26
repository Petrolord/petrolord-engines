// Saturation-function emitters (PROPS section). Rows come from the scal
// domain's Corey builders (fullRange or mobile-window sampling) with Pc
// resampled onto the same saturation grid by the caller.
import { fmt } from './deckFormat.js';

function checkMonotonic(rows, key, label) {
  let last = -Infinity;
  rows.forEach((r) => {
    if (!(r[key] > last - 1e-12)) throw new Error(`${label}: ${key} must be non-decreasing`);
    last = r[key];
  });
}

/** SWOF rows: { Sw, krw, krow, pcow = 0 } ascending Sw. */
export function emitSWOF(rows) {
  if (!rows?.length) throw new Error('emitSWOF: no rows');
  checkMonotonic(rows, 'Sw', 'emitSWOF');
  const lines = ['SWOF'];
  rows.forEach((r) => {
    [r.krw, r.krow].forEach((v) => {
      if (!(v >= 0 && v <= 1.000001)) throw new Error('emitSWOF: kr outside [0, 1]');
    });
    lines.push(`  ${fmt(r.Sw, 5)} ${fmt(r.krw, 6)} ${fmt(r.krow, 6)} ${fmt(r.pcow ?? 0, 5)}`);
  });
  lines.push('/', '');
  return lines.join('\n');
}

/** SGOF rows: { Sg, krg, krog, pcog = 0 } ascending Sg. */
export function emitSGOF(rows) {
  if (!rows?.length) throw new Error('emitSGOF: no rows');
  checkMonotonic(rows, 'Sg', 'emitSGOF');
  const lines = ['SGOF'];
  rows.forEach((r) => {
    [r.krg, r.krog].forEach((v) => {
      if (!(v >= 0 && v <= 1.000001)) throw new Error('emitSGOF: kr outside [0, 1]');
    });
    lines.push(`  ${fmt(r.Sg, 5)} ${fmt(r.krg, 6)} ${fmt(r.krog, 6)} ${fmt(r.pcog ?? 0, 5)}`);
  });
  lines.push('/', '');
  return lines.join('\n');
}

/**
 * Linear resample of a Pc curve (rows {Sw, Pc_psi}, any monotone Sw grid)
 * onto target Sw points; clamps outside the source range. Used to align the
 * scal pcFromJ grid with the Corey Sw grid before emitting SWOF column 4.
 */
export function resamplePc(pcRows, swTargets) {
  if (!pcRows?.length) return swTargets.map(() => 0);
  const src = [...pcRows].sort((a, b) => a.Sw - b.Sw);
  return swTargets.map((sw) => {
    if (sw <= src[0].Sw) return src[0].Pc_psi;
    if (sw >= src[src.length - 1].Sw) return src[src.length - 1].Pc_psi;
    let k = 0;
    while (k + 1 < src.length && src[k + 1].Sw < sw) k += 1;
    const a = src[k];
    const b = src[k + 1];
    const t = (sw - a.Sw) / (b.Sw - a.Sw || 1);
    return a.Pc_psi + t * (b.Pc_psi - a.Pc_psi);
  });
}
