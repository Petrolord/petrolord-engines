// Fault-stick READERS: the import mirror of pickExport's fault-stick
// writer, tolerant of the variants real files carry. Dialects
// (whitespace means one or more spaces or tabs):
//
//  - charisma: Charisma fault sticks (Petrel "Charisma fault sticks",
//    the seismiqb FAULT_STICKS layout, resqpy's writer):
//    `INLINE- <il> <xl> <x> <y> <z> <name> <stick#>`. The INLINE marker
//    may be split or joined (`INLINE-`, `INLINE -`, `INLINE-1001`,
//    `INLINE :`, `INLINE:1001`); an XLINE marker before the crossline
//    is accepted. Fault names may contain spaces: the name is every
//    token between z and the trailing stick number, and a row with no
//    name takes the caller's name. Lines with no number at all (column
//    headers) are skipped. A file whose rows all carry inline 0 and
//    crossline 0 (resqpy writes those placeholders) is located by X/Y.
//    A Charisma 3D HORIZON row (XLINE marker, nothing after z) is not a
//    fault row: detection refuses such a file.
//  - iesx: GeoQuest IESX fault sticks (Petrel "IESX fault sticks
//    (ASCII)", GeoFrame fault_gf card image): `PROFILE <fault> TYPE ...`
//    starts a fault, `SNAPPING PARAMETERS` is skipped, `EOD` closes a
//    block. Data rows use the IESX card-image columns (see
//    horizonImport.parseIesxRow): x [1-16], y [17-32], stick (segment)
//    index [33-35], type code [36-38], z [39-47]; token fallback
//    x y stick code z. A new stick starts whenever the stick index
//    changes or a PROFILE/EOD boundary passes; sticks keep file order.
//  - xyzn: plain `x y z stick#` rows (one fault, the caller's name).
//  - columns: generic ASCII with an explicit column mapping
//    (importText.parseMappedColumns): x, y, z (time), stick, name
//    (fault), optional il/xl. With no stick column, a blank line ends a
//    stick (the DUG/.dufault convention).
//
// parseFaultSticks is tolerant: a bad row becomes a reject { line,
// reason, column?, field?, text } and parsing continues; only a file
// with no readable row is refused (naming the first rejects).
// parseFaultStickFile keeps the older contract (throw on the first bad
// row) for existing callers.
//
// ORDER IS LOAD-BEARING: faultBarriers walks crossings in stored stick
// order and interpMesh lofts ribbons between consecutive sticks, so
// Charisma and mapped sticks are emitted sorted by their file stick
// number, IESX sticks in file order, and points keep file order within
// a stick.

import { worldToIlxl } from './surveyGeometry';
import {
  createRejects, describeReject, detectLineDelimiter, isCommentLine, isNullValue,
  isNumToken, parseMappedColumns, refuseNothingRead, splitCells, splitLines,
  suggestMappingFromHeader, toNum, unquote,
} from './importText';
import {
  commentedHeader, dropPlaceholderLineNumbers, parseCharismaTokens, parseIesxProfile, walkIesx,
} from './horizonImport';

export const FAULT_FORMAT_LABELS = {
  charisma: 'Charisma fault sticks',
  iesx: 'IESX fault sticks',
  xyzn: 'X/Y/Z + stick number',
  columns: 'Generic ASCII (column mapping)',
};

/** A Charisma-family row (parseCharismaTokens) that reads as a fault-stick row. */
export function charismaFaultRow(p) {
  if (p.error || p.values.length < 3) return false;
  if (p.trailing.length) return isNumToken(p.trailing[p.trailing.length - 1]);
  // `INLINE- il xl x y z stick#` with no name: a 4th number, no XLINE marker
  return p.values.length >= 4 && !p.hasXlMarker;
}

/**
 * Sniff a fault-stick file's dialect (tolerant detection).
 * @returns {{format: 'charisma'|'iesx'|'xyzn'|'columns', header?,
 *   suggested?, delimiter?}}
 */
export function detectFaultFormat(text) {
  const lines = splitLines(text);
  let sawContent = false;
  const comments = [];
  let headerRow = null;
  for (const raw of lines) {
    const s = raw.trim();
    if (!s) continue;
    sawContent = true;
    if (/^PROFILE\s/i.test(s)) return { format: 'iesx' };
    if (isCommentLine(s)) { comments.push(s); continue; }
    if (/INLINE/i.test(s) && /\d/.test(s)) {
      const p = parseCharismaTokens(s);
      if (charismaFaultRow(p)) return { format: 'charisma' };
      throw new Error(`Unrecognised fault-stick file: "${s}" reads as a Charisma horizon row `
        + '(no fault name or stick number after z). Import it as horizon picks.');
    }
    if (!/\d/.test(s)) {
      // a header row: remember it and let the first data row decide
      if (!headerRow) headerRow = s;
      continue;
    }
    if (headerRow && !/INLINE/i.test(s)) {
      const delimiter = detectLineDelimiter(headerRow);
      const header = splitCells(headerRow, delimiter);
      return { format: 'columns', header, suggested: suggestMappingFromHeader(header), delimiter };
    }
    const delimiter = detectLineDelimiter(s);
    const cells = splitCells(s, delimiter);
    const hc = commentedHeader(comments, cells);
    if (hc) return { format: 'columns', header: hc, suggested: suggestMappingFromHeader(hc), delimiter };
    if (cells.length >= 4 && cells.slice(0, 4).every(isNumToken)) return { format: 'xyzn', delimiter };
    return { format: 'columns', suggested: cells.length === 3 && cells.every(isNumToken) ? { x: 0, y: 1, z: 2 } : {}, delimiter };
  }
  throw new Error(sawContent ? 'The file has no fault-stick rows.' : 'The file is empty.');
}

/**
 * Sniff a fault-stick file's dialect (older contract: only the
 * self-describing dialects; anything needing a mapping is refused).
 * @returns {'charisma'|'iesx'|'xyzn'}
 */
export function detectFaultStickFormat(text) {
  const d = detectFaultFormat(text);
  if (d.format === 'columns') {
    const first = splitLines(text).map((l) => l.trim()).find((s) => s && !isCommentLine(s));
    throw new Error(`Unrecognised fault-stick file: first data line is "${first}".`);
  }
  return d.format;
}

const byStickNumber = (a, b) => {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return 0;
};

/** name -> (stickKey -> points[]) accumulator, first-appearance order. */
function faultAccumulator() {
  const byFault = new Map();
  return {
    add(name, stickKey, pt) {
      if (!byFault.has(name)) byFault.set(name, new Map());
      const sticks = byFault.get(name);
      if (!sticks.has(stickKey)) sticks.set(stickKey, []);
      sticks.get(stickKey).push(pt);
    },
    faults(sort) {
      return [...byFault.entries()].map(([name, sticks]) => {
        const keys = [...sticks.keys()];
        if (sort) keys.sort(byStickNumber);
        return { name, sticks: keys.map((k) => sticks.get(k)) };
      });
    },
  };
}

function parseCharismaFaults(text, fallbackName) {
  const rejects = createRejects();
  const acc = faultAccumulator();
  let ignored = 0;
  let nulls = 0;
  let points = 0;
  const all = [];
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    if (isCommentLine(s) || !/\d/.test(s)) { ignored += 1; continue; }
    const n = i + 1;
    const p = parseCharismaTokens(s);
    if (p.error) {
      rejects.add(n, p.error === 'no INLINE marker' ? 'not a Charisma row (no INLINE marker)' : p.error,
        { column: p.col, field: p.field, text: s });
      continue;
    }
    if (p.values.length < 3) {
      const missing = ['x', 'y', 'z'][p.values.length];
      const found = p.trailing[0];
      rejects.add(n, found != null ? `"${found}" is not a number (expected ${missing})`
        : `the row ends before ${missing}`, { column: p.trailingCol, field: missing, text: s });
      continue;
    }
    let stick;
    let name;
    if (p.trailing.length) {
      const last = p.trailing[p.trailing.length - 1];
      if (!isNumToken(last)) {
        rejects.add(n, `"${last}" is not a stick number (the row must end with one)`,
          { column: p.tokenCount, field: 'stick', text: s });
        continue;
      }
      stick = toNum(last);
      name = unquote(p.trailing.slice(0, -1).join(' '));
    } else if (p.values.length >= 4) {
      stick = p.values[3];
      name = '';
    } else {
      rejects.add(n, 'the row ends before the stick number', { column: p.tokenCount + 1, field: 'stick', text: s });
      continue;
    }
    name = name || p.name || fallbackName;
    const [x, y, z] = p.values;
    if (isNullValue(z)) { nulls += 1; continue; }
    const pt = { il: p.il, xl: p.xl, x, y, z };
    all.push(pt);
    acc.add(name, stick, pt);
    points += 1;
  }
  const lineNumbersIgnored = dropPlaceholderLineNumbers(all);
  return { faults: acc.faults(true), points, rejects, ignored, nulls, lineNumbersIgnored };
}

function parseIesxFaults(text, fallbackName) {
  const acc = faultAccumulator();
  let points = 0;
  let nulls = 0;
  let seq = 0;
  let prev = null;
  const { rejects, ignored } = walkIesx(text, fallbackName, (r, n, name, block) => {
    const key = `${name}\u0000${block}\u0000${r.seg}`;
    if (key !== prev) { seq += 1; prev = key; }
    if (isNullValue(r.z)) { nulls += 1; return; }
    const pt = { x: r.x, y: r.y, z: r.z };
    if (r.il != null) { pt.il = r.il; pt.xl = r.xl; }
    acc.add(name, seq, pt);
    points += 1;
  });
  return { faults: acc.faults(false), points, rejects, ignored, nulls };
}

function parseMappedFaults(text, mapping, fallbackName) {
  const out = parseMappedColumns(text, { delimiter: 'auto', headerLines: 'auto', ...mapping },
    { required: ['z'] });
  const acc = faultAccumulator();
  const hasStick = Number.isInteger(mapping?.columns?.stick);
  for (const r of out.records) {
    const pt = { z: r.z };
    if (r.x != null && r.y != null) { pt.x = r.x; pt.y = r.y; }
    if (r.il != null && r.xl != null) { pt.il = r.il; pt.xl = r.xl; }
    acc.add(r.name || fallbackName, hasStick ? r.stick : r.block, pt);
  }
  return {
    faults: acc.faults(true),
    points: out.records.length,
    rejects: out.rejects,
    ignored: out.ignored,
    nulls: out.nulls,
  };
}

/**
 * Tolerant fault-stick parse.
 *
 * @param {string} text
 * @param {Object} [opts]
 * @param {?string} [opts.format] force a dialect (else detected)
 * @param {?Object} [opts.mapping] column mapping for 'columns'
 * @param {string} [opts.fallbackName] name for rows with no fault name
 * @returns {{format: string, faults: Array<{name: string,
 *   sticks: Array<Array<{il?, xl?, x?, y?, z}>>}>, points: number,
 *   rejects: Array<{line, reason, column?, field?, text?}>,
 *   rejectCount: number, ignored: number, nulls: number}}
 */
export function parseFaultSticks(text, opts = {}) {
  const fallbackName = opts.fallbackName || 'Imported fault';
  const det = opts.format ? { format: opts.format } : detectFaultFormat(text);
  const fmt = det.format;
  let out;
  if (fmt === 'charisma') out = parseCharismaFaults(text, fallbackName);
  else if (fmt === 'iesx') out = parseIesxFaults(text, fallbackName);
  else if (fmt === 'xyzn') {
    out = parseMappedFaults(text, { columns: { x: 0, y: 1, z: 2, stick: 3 }, headerLines: 0 }, fallbackName);
  } else if (fmt === 'columns') {
    out = parseMappedFaults(text, opts.mapping || { columns: det.suggested || {} }, fallbackName);
  } else {
    throw new Error(`Unknown fault-stick format: ${fmt}`);
  }
  if (!out.points) throw refuseNothingRead('fault sticks', out.rejects);
  return {
    format: fmt,
    faults: out.faults,
    points: out.points,
    rejects: out.rejects.list,
    rejectCount: out.rejects.count,
    ignored: out.ignored || 0,
    nulls: out.nulls || 0,
    ...(out.lineNumbersIgnored ? { lineNumbersIgnored: true } : {}),
  };
}

/**
 * Parse a fault-stick file into named faults with ordered sticks
 * (older contract: throws on the first bad row, "Line <n>: ...").
 *
 * @returns {{format: string, faults: Array<{name: string,
 *   sticks: Array<Array<{il?: number, xl?: number, x: number,
 *   y: number, z: number}>>}>, points: number}}
 */
export function parseFaultStickFile(text, format = null, fallbackName = 'Imported fault') {
  const fmt = format || detectFaultStickFormat(text);
  const out = parseFaultSticks(text, { format: fmt, fallbackName });
  if (out.rejectCount) throw new Error(describeReject(out.rejects[0]));
  return { format: out.format, faults: out.faults, points: out.points };
}

/** IESX PROFILE header of a fault file names a fault ifdf. */
export const iesxLooksLikeFaults = (text) => splitLines(text).slice(0, 50)
  .some((l) => /^PROFILE\s/i.test(l.trim()) && /fault/i.test(parseIesxProfile(l.trim()).ifdf || ''));

/**
 * Land parsed fault sticks on the volume lattice as the stored
 * seismic_faults stick shape.
 *
 * Unlike horizon picks, stick points are CONTINUOUS lattice positions
 * (fractional il/xl indices draw, project and cross exactly —
 * faultBarriers and the 3D ribbons interpolate). Rows with il/xl line
 * numbers use them directly; xyzn rows resolve through the inverse
 * survey affine. A point more than half a bin outside the survey, or
 * whose z falls outside the volume time window, is skipped; a stick
 * left with fewer than two points is dropped whole (a one-point stick
 * cannot draw or loft).
 *
 * @param {Array<{name, sticks}>} faults parseFaultStickFile output
 * @param {{nIl: number, nXl: number, ns: number}} geom
 * @param {{il0: number, ilStep: number, xl0: number, xlStep: number}} lines
 * @param {?Object} affine survey affine (needed for xyzn rows only)
 * @param {(z: number) => number} zToSample positive-down ms -> sample
 * @returns {{faults: Array<{name: string,
 *   sticks: Array<{points: {il, xl, s}[]}>}>, placed: number,
 *   skipped: number, droppedSticks: number}}
 */
export function faultSticksToLattice(faults, geom, lines, affine, zToSample) {
  const out = [];
  let placed = 0;
  let skipped = 0;
  let droppedSticks = 0;
  for (const f of faults) {
    const sticks = [];
    for (const stick of f.sticks) {
      const pts = [];
      for (const r of stick) {
        let i;
        let j;
        if (r.il != null && r.xl != null) {
          i = (r.il - lines.il0) / lines.ilStep;
          j = (r.xl - lines.xl0) / lines.xlStep;
        } else {
          if (!affine) throw new Error('XYZ fault sticks need survey coordinates to locate cells.');
          const g = worldToIlxl(affine, r.x, r.y);
          if (!g) throw new Error('The survey affine is not invertible, so fault sticks cannot be placed.');
          i = g.i;
          j = g.j;
        }
        if (i < -0.5 || j < -0.5 || i > geom.nIl - 0.5 || j > geom.nXl - 0.5) {
          skipped += 1;
          continue;
        }
        const s = zToSample(r.z);
        if (!Number.isFinite(s) || s < 0 || s > geom.ns - 1) { skipped += 1; continue; }
        pts.push({ il: i, xl: j, s });
        placed += 1;
      }
      if (pts.length >= 2) sticks.push({ points: pts });
      else {
        droppedSticks += 1;
        placed -= pts.length;
        skipped += pts.length;
      }
    }
    if (sticks.length) out.push({ name: f.name, sticks });
  }
  if (!placed) {
    throw new Error('No fault sticks landed on this volume\'s lattice. Check that the '
      + 'file belongs to this survey (line numbering, coordinates and time range).');
  }
  return { faults: out, placed, skipped, droppedSticks };
}
