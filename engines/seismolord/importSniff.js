// Content sniffing for Seismolord's import door: suggest what a file IS
// (a gridded surface, horizon picks or fault sticks) from its content
// alone, so the dialog never depends on the file extension. The user can
// always override the suggestion.

import { detectHorizonFormat, GRID_FORMATS, parseCharismaTokens, parseIesxRow } from './horizonImport';
import { charismaFaultRow, iesxLooksLikeFaults } from './faultImport';
import { parseXYZGrid } from '../../lib/gridding/surfaceImport';
import { isCommentLine, splitLines } from './importText';

/** Within one PROFILE block, does the segment (stick) index change? */
function iesxSegmentsVary(text) {
  let seg = null;
  for (const raw of splitLines(text).slice(0, 2000)) {
    const s = raw.trim();
    if (!s) continue;
    if (/^(PROFILE|EOD)\b/i.test(s)) { seg = null; continue; }
    if (/^SNAPPING/i.test(s)) continue;
    const r = parseIesxRow(raw);
    if (r.error) continue;
    if (seg != null && r.seg !== seg) return true;
    seg = r.seg;
  }
  return false;
}

/**
 * Suggest the import kind for a file's text.
 * @returns {{kind: 'surface'|'picks'|'faults', format: string, reason: string}}
 */
export function suggestImportKind(text) {
  const det = detectHorizonFormat(text);
  const fmt = det.format;
  if (GRID_FORMATS.includes(fmt)) {
    return { kind: 'surface', format: fmt, reason: 'a gridded surface file' };
  }
  if (fmt === 'iesx') {
    if (iesxLooksLikeFaults(text) || iesxSegmentsVary(text)) {
      return { kind: 'faults', format: 'iesx', reason: 'an IESX fault-stick file' };
    }
    return { kind: 'picks', format: 'iesx', reason: 'an IESX horizon file' };
  }
  if (fmt === 'charisma') {
    const first = splitLines(text).map((l) => l.trim())
      .find((s) => s && !isCommentLine(s) && /INLINE/i.test(s) && /\d/.test(s));
    if (first && charismaFaultRow(parseCharismaTokens(first))) {
      return { kind: 'faults', format: 'charisma', reason: 'Charisma fault sticks (a fault name and stick number end each row)' };
    }
    return { kind: 'picks', format: 'charisma', reason: 'Charisma 3D interpretation lines' };
  }
  if (fmt === 'xyz') {
    const first = splitLines(text).map((l) => l.trim()).find((s) => s && !isCommentLine(s));
    const cells = first ? first.split(/[\s,;]+/) : [];
    if (cells.length === 4 && /^\d+$/.test(cells[3])) {
      return { kind: 'faults', format: 'xyzn', reason: 'x y z rows with a whole-number stick column' };
    }
    try {
      parseXYZGrid(text);
      return { kind: 'surface', format: 'xyz', reason: 'XYZ points on a regular grid' };
    } catch (e) {
      return { kind: 'picks', format: 'xyz', reason: 'scattered XYZ points' };
    }
  }
  if (fmt === 'columns') {
    const s = det.suggested || {};
    const header = (det.header || []).join(' ');
    if (s.stick != null || /fault/i.test(header)) {
      return { kind: 'faults', format: 'columns', reason: 'a table with fault or stick columns' };
    }
    return { kind: 'picks', format: 'columns', reason: 'a table of interpretation points' };
  }
  return { kind: 'picks', format: fmt, reason: 'interpretation points' };
}
