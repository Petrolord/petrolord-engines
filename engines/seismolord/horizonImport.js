// Tolerant horizon READERS: every horizon dialect a tester is likely to
// hand Seismolord, read row by row so one bad line never sinks the file.
// Point dialects return labeled rows for pickImport.rowsToPickLattice;
// grid dialects return the surfaceImport grid for gridToPickLattice.
//
// Supported layouts (whitespace means one or more spaces or tabs):
//
//  charisma    Charisma 3D interpretation lines (Petrel "Charisma 3D
//              interpretation" export and hand-edited variants). The
//              INLINE marker may be split or joined, with ':', '-' or '='
//              or none: `INLINE : 1001`, `INLINE: 1001`, `INLINE:1001`,
//              `INLINE- 1001`, `INLINE - 1001`, `INLINE-1001`, `INLINE 1001`.
//              The crossline follows, with the same marker forms for
//              XLINE (also CROSSLINE, XL, CDP, TRACE) or bare. Then x y z
//              (the first three numbers after the crossline; further
//              numbers are ignored). An optional horizon NAME may lead the
//              row (`Top_Reservoir INLINE : 1001 ...`, quoted or not) or
//              trail it; rows group by name, so a multi-horizon file
//              yields one horizon per name. Lines with no number at all
//              (column headers such as `Inline Xline X Y Z`) are skipped.
//              A file whose rows all carry inline 0 and crossline 0 (the
//              resqpy writer's placeholder) is located by X/Y instead.
//  iesx        GeoQuest IESX / GeoFrame card-image horizon export
//              (3d_ci7m / 2d_ci7m, written by Petrel and OpendTect):
//              `PROFILE <name> TYPE ...` starts a horizon, `SNAPPING
//              PARAMETERS` is skipped, `EOD` ends a block. Data rows are
//              fixed columns x [1-16], y [17-32], segment [33-35],
//              type code [36-38], z [39-47] (1-based, inclusive); a 3D
//              row carries ` I <inline>` near its end and the crossline
//              as the 6th token. Rows too short for the fixed columns
//              fall back to tokens x y segment code z. z of MAXFLOAT
//              (3.4028235E+38) or 1.0E+30 is a null. OpendTect's writer
//              also prefixes rows with EOD and emits tab-indented value
//              echo lines; both are tolerated (the echoes are skipped).
//  earthvision EarthVision scattered data (`# Type: scattered data`,
//              `# Field: <n> <name>` header comments naming the columns,
//              default x y z [column row]); a `# Null...: <value>` header
//              adds a null sentinel.
//  cps3points  CPS-3 scattered points/lines: FFASCI / FFATTR header
//              lines and `->` segment separators, then `x y z` rows.
//  cps3, zmap, irap  CPS-3, ZMAP+ and Irap classic GRIDS through
//              surfaceImport (row/column order exactly as those readers
//              define it; nulls 1.0E+30). Sampled onto the lattice.
//  ilxlxyz     five numeric columns `il xl x y z`.
//  xyz         `x y z` (extra numeric columns ignored).
//  columns     generic ASCII with an explicit column mapping
//              (importText.parseMappedColumns): x, y, z, il, xl, name.
//              Detected for headered files (the mapping is suggested
//              from header names, including OpendTect's commented
//              `# "Inline" "Crossline" "Z"` header) and for rows led by a
//              text column.
//
// Every point reader returns { format, kind: 'points', horizons:
// [{ name, rows }], rejects, rejectCount, ignored, nulls } and throws
// only when no row at all could be read (naming the first rejects).

import { NULL_VALUE } from './manifest';
import { latticeSampleSurface } from './surfaceOnLattice';
import { parseSurfaceFile } from '../../lib/gridding/surfaceImport';
import {
  createRejects, isCommentLine, isNullValue, isNumToken, parseMappedColumns,
  refuseNothingRead, splitCells, splitLines, suggestMappingFromHeader, toNum, unquote,
  detectLineDelimiter,
} from './importText';

const NULL_F32 = Math.fround(NULL_VALUE);

export const HORIZON_FORMAT_LABELS = {
  charisma: 'Charisma 3D interpretation lines',
  iesx: 'IESX horizon',
  earthvision: 'EarthVision scattered data',
  cps3points: 'CPS-3 scattered points',
  cps3: 'CPS-3 grid',
  zmap: 'ZMAP+ grid',
  irap: 'Irap classic grid',
  ilxlxyz: 'IL/XL/X/Y/Z points',
  xyz: 'XYZ points',
  columns: 'Generic ASCII (column mapping)',
};

export const GRID_FORMATS = ['cps3', 'zmap', 'irap'];

// ---------------------------------------------------------------- Charisma

const XL_MARKER = /^(XLINE|CROSSLINE|XL|CDP|TRACE)/i;
const MARK_CHARS = /^[:=-]/;

/**
 * Read a marker-led number starting at token k: the marker word may be
 * joined to its punctuation and number (INLINE:1001, INLINE-1001) or
 * split (INLINE : 1001, INLINE- 1001, INLINE - 1001, INLINE 1001).
 * @returns {{value: number, next: number, col: number}|{error: string, col: number}}
 */
function readMarked(tok, k, wordLen) {
  let rest = tok[k].slice(wordLen);
  let idx = k;
  if (MARK_CHARS.test(rest)) rest = rest.slice(1);
  if (!rest) {
    idx += 1;
    rest = tok[idx] ?? '';
    // `INLINE : 1001`, `INLINE - 1001`, `INLINE :1001`, `INLINE -1001`
    // (line numbers are never negative, so a leading '-' is the marker)
    if (/^[:=-]$/.test(rest)) { idx += 1; rest = tok[idx] ?? ''; } else if (MARK_CHARS.test(rest)) rest = rest.slice(1);
  }
  if (!rest) return { error: 'the line number is missing', col: idx + 1 };
  if (!isNumToken(rest)) return { error: `"${rest}" is not a line number`, col: idx + 1 };
  return { value: toNum(rest), next: idx + 1, col: idx + 1 };
}

/**
 * Tokenise one Charisma-family row (horizon or fault stick).
 * @returns {{name: string, il: number, xl: number, hasXlMarker: boolean,
 *   values: number[], valueCols: number[], trailing: string[],
 *   trailingCol: number}|{error: string, col?: number, field?: string}}
 */
export function parseCharismaTokens(line) {
  const tok = line.trim().split(/\s+/);
  const iIdx = tok.findIndex((t) => /^INLINE/i.test(t));
  if (iIdx < 0) return { error: 'no INLINE marker' };
  const name = unquote(tok.slice(0, iIdx).join(' '));
  const il = readMarked(tok, iIdx, 6);
  if (il.error) return { error: il.error, col: il.col, field: 'inline' };
  let k = il.next;
  let xl;
  let hasXlMarker = false;
  const m = tok[k] ? XL_MARKER.exec(tok[k]) : null;
  if (m && !isNumToken(tok[k])) {
    hasXlMarker = true;
    xl = readMarked(tok, k, m[1].length);
  } else if (tok[k] != null && isNumToken(tok[k])) {
    xl = { value: toNum(tok[k]), next: k + 1, col: k + 1 };
  } else {
    xl = { error: tok[k] == null ? 'the crossline number is missing' : `"${tok[k]}" is not a crossline number`, col: k + 1 };
  }
  if (xl.error) return { error: xl.error, col: xl.col, field: 'crossline' };
  k = xl.next;
  const values = [];
  const valueCols = [];
  while (k < tok.length && isNumToken(tok[k])) {
    values.push(toNum(tok[k]));
    valueCols.push(k + 1);
    k += 1;
  }
  return {
    name, il: il.value, xl: xl.value, hasXlMarker, values, valueCols,
    trailing: tok.slice(k), trailingCol: k + 1, tokenCount: tok.length,
  };
}

const XYZ_FIELDS = ['x', 'y', 'z'];

function parseCharismaHorizon(text, fallbackName) {
  const rejects = createRejects();
  const groups = new Map();
  let ignored = 0;
  let nulls = 0;
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    if (isCommentLine(s) || !/\d/.test(s)) { ignored += 1; continue; }
    const n = i + 1;
    const p = parseCharismaTokens(s);
    if (p.error) {
      rejects.add(n, p.error === 'no INLINE marker'
        ? 'not a Charisma row (no INLINE marker)' : p.error, { column: p.col, field: p.field, text: s });
      continue;
    }
    if (p.values.length < 3) {
      const missing = XYZ_FIELDS[p.values.length];
      const col = p.trailingCol;
      const found = p.trailing[0];
      rejects.add(n, found != null ? `"${found}" is not a number (expected ${missing})`
        : `expected x y z after the crossline, found ${p.values.length} number${p.values.length === 1 ? '' : 's'}`,
      { column: col, field: missing, text: s });
      continue;
    }
    const [x, y, z] = p.values;
    if (isNullValue(z)) { nulls += 1; continue; }
    let name = p.name;
    if (!name && p.trailing.length && p.trailing.every((t) => !isNumToken(t))) {
      name = unquote(p.trailing.join(' '));
    }
    name = name || fallbackName;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({ il: p.il, xl: p.xl, x, y, z });
  }
  const horizons = [...groups.entries()].map(([name, rows]) => ({ name, rows }));
  const lineNumbersIgnored = dropPlaceholderLineNumbers(horizons.flatMap((h) => h.rows));
  return { horizons, rejects, ignored, nulls, lineNumbersIgnored };
}

/** All-zero il/xl (a writer that knew no line numbers): locate by XY. */
export function dropPlaceholderLineNumbers(rows) {
  if (!rows.length || !rows.every((r) => r.il === 0 && r.xl === 0)) return false;
  for (const r of rows) { delete r.il; delete r.xl; }
  return true;
}

// -------------------------------------------------------------------- IESX

/** IESX PROFILE header -> { name, ifdf } */
export function parseIesxProfile(s) {
  const m = /^PROFILE\s+(.*?)\s+TYPE\b/i.exec(s);
  const name = (m ? m[1] : s.replace(/^PROFILE\s*/i, '').split(/\s{2,}/)[0]).trim();
  const ifdf = (/(\S+\.i[fu]df)\b/i.exec(s) || [])[1] || null;
  return { name, ifdf };
}

const IESX_FIXED_MIN = 47;

/**
 * One IESX card-image data row. Fixed columns first (x [0,16), y
 * [16,32), segment [32,35), z [38,47), 0-based half-open); tokens
 * x y segment code z when the fixed columns do not read.
 * @returns {{x, y, seg, z, il?, xl?}|{error, col?, field?}}
 */
export function parseIesxRow(raw) {
  const tok = raw.trim().split(/\s+/);
  let out = null;
  if (raw.length >= IESX_FIXED_MIN) {
    const x = toNum(raw.slice(0, 16).trim());
    const y = toNum(raw.slice(16, 32).trim());
    const segTxt = raw.slice(32, 35).trim();
    const z = toNum(raw.slice(38, 47).trim());
    // a value that overflowed its field (runs past column 47) is not a
    // fixed-column row: fall through to tokens
    const overflow = raw.length > 47 && !/\s/.test(raw[47]);
    if (!overflow && [x, y, z].every(Number.isFinite) && /^-?\d+$/.test(segTxt)) {
      out = { x, y, seg: Number(segTxt), z };
    }
  }
  if (!out) {
    if (tok.length < 4) return { error: `an IESX row needs at least x y segment z, found ${tok.length} values` };
    const x = toNum(tok[0]);
    const y = toNum(tok[1]);
    if (!Number.isFinite(x)) return { error: `"${tok[0]}" is not a number`, col: 1, field: 'x' };
    if (!Number.isFinite(y)) return { error: `"${tok[1]}" is not a number`, col: 2, field: 'y' };
    if (!/^-?\d+$/.test(tok[2])) return { error: `"${tok[2]}" is not a segment number`, col: 3, field: 'segment' };
    const zIdx = tok.length >= 5 && /^\d+$/.test(tok[3]) ? 4 : 3;
    const z = toNum(tok[zIdx]);
    if (!Number.isFinite(z)) return { error: `"${tok[zIdx]}" is not a number`, col: zIdx + 1, field: 'z' };
    out = { x, y, seg: Number(tok[2]), z };
  }
  // 3D rows: ' I <inline>' marker; the crossline is the 6th token
  const iIdx = tok.lastIndexOf('I');
  if (iIdx > 4 && /^-?\d+$/.test(tok[iIdx + 1] || '') && isNumToken(tok[5] || '')) {
    out.il = Number(tok[iIdx + 1]);
    out.xl = toNum(tok[5]);
  }
  return out;
}

/**
 * Walk an IESX file: PROFILE blocks, EOD boundaries, OpendTect echo
 * lines. Calls onRow(row, lineNo, profileName, blockNo) for each good
 * data row.
 */
export function walkIesx(text, fallbackName, onRow) {
  const rejects = createRejects();
  let ignored = 0;
  let name = fallbackName;
  let ifdf = null;
  let block = 0;
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i];
    const s = raw.trim();
    if (!s) continue;
    const n = i + 1;
    if (/^PROFILE\b/i.test(s)) {
      const p = parseIesxProfile(s);
      name = p.name || fallbackName;
      ifdf = ifdf || p.ifdf;
      block += 1;
      continue;
    }
    if (/^SNAPPING\b/i.test(s) || isCommentLine(s)) { ignored += 1; continue; }
    if (/^EOD\b/i.test(s)) {
      block += 1;
      raw = raw.replace(/^\s*EOD/i, '   ');
      if (!raw.trim()) continue;
    }
    // OpendTect echo lines: tab/space-indented, one to three bare numbers
    const t = raw.trim().split(/\s+/);
    if (/^\s/.test(raw) && t.length <= 3 && t.every(isNumToken) && raw.trim().length < 40) {
      ignored += 1;
      continue;
    }
    const r = parseIesxRow(raw);
    if (r.error) {
      rejects.add(n, r.error, { column: r.col, field: r.field, text: s });
      continue;
    }
    onRow(r, n, name, block);
  }
  return { rejects, ignored, ifdf };
}

function parseIesxHorizon(text, fallbackName) {
  const groups = new Map();
  let nulls = 0;
  const { rejects, ignored, ifdf } = walkIesx(text, fallbackName, (r, n, name) => {
    if (isNullValue(r.z)) { nulls += 1; return; }
    if (!groups.has(name)) groups.set(name, []);
    const row = { x: r.x, y: r.y, z: r.z };
    if (r.il != null) { row.il = r.il; row.xl = r.xl; }
    groups.get(name).push(row);
  });
  const horizons = [...groups.entries()].map(([name, rows]) => ({ name, rows }));
  return { horizons, rejects, ignored, nulls, ifdf };
}

// ------------------------------------------------------------- EarthVision

function parseEarthVision(text, fallbackName) {
  const lines = splitLines(text);
  const fields = {};
  let nullValue = null;
  let name = null;
  for (const raw of lines) {
    const s = raw.trim();
    if (!s.startsWith('#')) continue;
    const f = /^#\s*Field:\s*(\d+)\s+(\S+)/i.exec(s);
    if (f) {
      const key = f[2].toLowerCase();
      const idx = Number(f[1]) - 1;
      if (key === 'x' || key === 'y') fields[key] = idx;
      else if (/^(column|col)$/.test(key)) fields.col = idx;
      else if (key === 'row') fields.row = idx;
      else if (fields.z == null) fields.z = idx;
    }
    const nv = /^#\s*Null[_ ]?(value)?\s*:?\s*(\S+)/i.exec(s);
    if (nv && isNumToken(nv[2])) nullValue = toNum(nv[2]);
    const d = /^#\s*(Description|Name):\s*(.+)$/i.exec(s);
    if (d && !/^no description$/i.test(d[2].trim())) name = name || d[2].trim();
  }
  const columns = { x: fields.x ?? 0, y: fields.y ?? 1, z: fields.z ?? 2 };
  const out = parseMappedColumns(text, { columns, delimiter: 'whitespace', headerLines: 0, nullValue },
    { required: ['x', 'y', 'z'] });
  const rows = out.records.map((r) => ({ x: r.x, y: r.y, z: r.z }));
  return {
    horizons: rows.length ? [{ name: name || fallbackName, rows }] : [],
    rejects: out.rejects,
    ignored: out.ignored,
    nulls: out.nulls,
  };
}

// ------------------------------------------------------- CPS-3 scattered

function parseCps3Points(text, fallbackName) {
  const rejects = createRejects();
  const rows = [];
  let ignored = 0;
  let nulls = 0;
  let nullValue = null;
  let segments = 0;
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    if (/^FF[A-Z]{4}/.test(s) || /^FS[A-Z]{4}/.test(s)) {
      if (/^FFASCI/.test(s)) {
        const nums = s.split(/\s+/).filter(isNumToken).map(toNum);
        const big = nums.find((v) => Math.abs(v) > 1e29);
        if (big != null) nullValue = big;
      }
      ignored += 1;
      continue;
    }
    if (s.startsWith('->')) { segments += 1; ignored += 1; continue; }
    if (isCommentLine(s)) { ignored += 1; continue; }
    const t = s.split(/[\s,]+/).filter(Boolean);
    const n = i + 1;
    let bad = false;
    for (let c = 0; c < 3; c++) {
      if (t[c] == null) {
        rejects.add(n, `the row ends before ${XYZ_FIELDS[c]} (expected x y z)`, { column: c + 1, field: XYZ_FIELDS[c], text: s });
        bad = true;
        break;
      }
      if (!isNumToken(t[c])) {
        rejects.add(n, `"${t[c]}" is not a number`, { column: c + 1, field: XYZ_FIELDS[c], text: s });
        bad = true;
        break;
      }
    }
    if (bad) continue;
    const z = toNum(t[2]);
    if (isNullValue(z) || (nullValue != null && z === nullValue)) { nulls += 1; continue; }
    rows.push({ x: toNum(t[0]), y: toNum(t[1]), z });
  }
  return {
    horizons: rows.length ? [{ name: fallbackName, rows }] : [], rejects, ignored, nulls, segments,
  };
}

// ------------------------------------------------------------- detection

/** First content lines (non-blank, non-comment) with their raw text;
 *  the first carries the comment lines that preceded it. */
function headLines(text, max = 200) {
  const out = [];
  const lines = splitLines(text);
  const comments = [];
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    if (isCommentLine(s)) {
      if (!out.length) comments.push(s);
      continue;
    }
    out.push({ s, raw: lines[i], n: i + 1, comments: out.length ? [] : comments });
  }
  return out;
}

/**
 * A commented header before the data (OpendTect writes
 * `# "Inline" "Crossline" "Z"` and, for multi-horizon exports, a name
 * column the header does not list): the last comment whose cells are
 * all words and which names a Z column. Returns the header cells lined
 * up with the data cells, or null.
 */
export function commentedHeader(comments, cells) {
  for (let k = comments.length - 1; k >= 0; k--) {
    const body = comments[k].replace(/^(#|!|\/\/)\s*/, '');
    const hc = splitCells(body, detectLineDelimiter(body));
    if (!hc.length || hc.some((c) => isNumToken(c)) || !hc.some((c) => /[a-z]/i.test(c))) continue;
    if (suggestMappingFromHeader(hc).z == null) continue;
    if (hc.length === cells.length) return hc;
    if (hc.length === cells.length - 1 && !isNumToken(cells[0])) return ['Name', ...hc];
  }
  return null;
}

const mappingPlaces = (m) => m.z != null
  && ((m.x != null && m.y != null) || (m.il != null && m.xl != null));

/**
 * Sniff a horizon file.
 * @returns {{format: string, header?: string[], suggested?: Object,
 *   delimiter?: string}}
 */
export function detectHorizonFormat(text) {
  const head = headLines(text);
  const all = splitLines(text).slice(0, 400).map((l) => l.trim()).filter(Boolean);
  if (!all.length) throw new Error('The file is empty.');
  if (all.some((s) => /^PROFILE\s/i.test(s))) return { format: 'iesx' };
  if (all.some((s) => s.startsWith('FSASCI'))) return { format: 'cps3' };
  if (all.some((s) => /^FF(ASCI|ATTR)/.test(s) || s.startsWith('->'))) return { format: 'cps3points' };
  if (all.some((s) => /^#\s*Type:\s*scattered/i.test(s) || /^#\s*Field:\s*\d/i.test(s))) {
    return { format: 'earthvision' };
  }
  if (all.some((s) => s.startsWith('@') && /GRID/i.test(s))) return { format: 'zmap' };
  if (head.length && /^-996(\s|$)/.test(head[0].s)) return { format: 'irap' };
  if (head.some((h) => /INLINE\s*[:=-]?\s*-?\d/i.test(h.s))) return { format: 'charisma' };
  if (!head.length) throw new Error('The file has no data rows (every line is blank or a comment).');

  const first = head[0];
  const delimiter = detectLineDelimiter(first.s);
  const cells = splitCells(first.s, delimiter);
  const numericCount = cells.filter(isNumToken).length;
  // a header row: no numbers at all
  if (numericCount === 0) {
    const suggested = suggestMappingFromHeader(cells);
    return { format: 'columns', header: cells, suggested, delimiter };
  }
  // OpendTect-style commented header before the data
  const hc = commentedHeader(first.comments, cells);
  if (hc) {
    const suggested = suggestMappingFromHeader(hc);
    if (mappingPlaces(suggested)) return { format: 'columns', header: hc, suggested, delimiter };
  }
  if (numericCount === cells.length) {
    const ints = (c) => /^-?\d+$/.test(c);
    if (cells.length >= 5 && ints(cells[0]) && ints(cells[1])) return { format: 'ilxlxyz', delimiter };
    if (cells.length >= 3) return { format: 'xyz', delimiter };
    return { format: 'columns', suggested: {}, delimiter };
  }
  // a text column leading numbers: a name column
  if (!isNumToken(cells[0]) && cells.slice(1).every(isNumToken)) {
    const k = cells.length - 1;
    let suggested = {};
    if (k >= 5) suggested = { name: 0, il: 1, xl: 2, x: 3, y: 4, z: 5 };
    else if (k === 4) suggested = { name: 0, il: 1, xl: 2, z: 3 };
    else if (k === 3) suggested = { name: 0, x: 1, y: 2, z: 3 };
    return { format: 'columns', suggested, delimiter };
  }
  return { format: 'columns', suggested: {}, delimiter };
}

// ----------------------------------------------------------------- parse

const finish = (format, out, what = 'horizon picks', hint = '') => {
  const horizons = out.horizons.filter((h) => h.rows.length);
  if (!horizons.length) throw refuseNothingRead(what, out.rejects, hint);
  return {
    format,
    kind: 'points',
    horizons,
    rows: horizons.reduce((n, h) => n + h.rows.length, 0),
    rejects: out.rejects.list,
    rejectCount: out.rejects.count,
    ignored: out.ignored || 0,
    nulls: out.nulls || 0,
    ...(out.lineNumbersIgnored ? { lineNumbersIgnored: true } : {}),
  };
};

/**
 * Parse a horizon file of any supported dialect.
 *
 * @param {string} text
 * @param {Object} [opts]
 * @param {?string} [opts.format] force a dialect (else detected)
 * @param {?Object} [opts.mapping] column mapping for 'columns' (see
 *   importText.parseMappedColumns); defaults to the detected suggestion
 * @param {string} [opts.fallbackName] name for rows with no horizon name
 * @returns {{format: string, kind: 'points', horizons: Array<{name,
 *   rows: Array<{il?, xl?, x?, y?, z}>}>, rows: number, rejects,
 *   rejectCount, ignored, nulls} | {format: string, kind: 'grid',
 *   grid: Object, horizons: Array<{name}>, rejects: [], rejectCount: 0}}
 */
export function parseHorizonFile(text, opts = {}) {
  const fallbackName = opts.fallbackName || 'Imported horizon';
  const det = opts.format ? { format: opts.format } : detectHorizonFormat(text);
  const fmt = det.format;
  if (GRID_FORMATS.includes(fmt)) {
    const grid = parseSurfaceFile(text, fmt);
    return {
      format: fmt, kind: 'grid', grid, horizons: [{ name: fallbackName }],
      rejects: [], rejectCount: 0, ignored: 0, nulls: 0,
    };
  }
  if (fmt === 'charisma') return finish(fmt, parseCharismaHorizon(text, fallbackName));
  if (fmt === 'iesx') return finish(fmt, parseIesxHorizon(text, fallbackName));
  if (fmt === 'earthvision') return finish(fmt, parseEarthVision(text, fallbackName));
  if (fmt === 'cps3points') return finish(fmt, parseCps3Points(text, fallbackName));
  let mapping;
  if (fmt === 'ilxlxyz') mapping = { columns: { il: 0, xl: 1, x: 2, y: 3, z: 4 } };
  else if (fmt === 'xyz') mapping = { columns: { x: 0, y: 1, z: 2 } };
  else if (fmt === 'columns') {
    mapping = opts.mapping || { columns: det.suggested || detectHorizonFormat(text).suggested || {} };
  } else {
    throw new Error(`Unknown horizon format: ${fmt}`);
  }
  const m = { delimiter: 'auto', headerLines: 'auto', ...mapping };
  const out = parseMappedColumns(text, m, { required: ['z'] });
  const groups = new Map();
  for (const r of out.records) {
    const name = r.name || fallbackName;
    if (!groups.has(name)) groups.set(name, []);
    const row = { z: r.z };
    if (r.x != null && r.y != null) { row.x = r.x; row.y = r.y; }
    if (r.il != null && r.xl != null) { row.il = r.il; row.xl = r.xl; }
    groups.get(name).push(row);
  }
  return finish(fmt, {
    horizons: [...groups.entries()].map(([name, rows]) => ({ name, rows })),
    rejects: out.rejects,
    ignored: out.ignored,
    nulls: out.nulls,
  });
}

/**
 * Land an imported GRID (CPS-3 / ZMAP+ / Irap) on the volume lattice as
 * a pick grid: bilinear lattice sampling (surfaceOnLattice, no values
 * invented across nulls or edges), then z -> sample. Cells outside the
 * grid or the volume time window are counted as skipped.
 *
 * @returns {{picks: Float32Array, placed: number, skipped: number}}
 */
export function gridToPickLattice(grid, geom, affine, zToSample) {
  if (grid.rotation_deg) {
    throw new Error('This grid is rotated. Import it as a surface, then sample it onto the volume from the map.');
  }
  const { values } = latticeSampleSurface(grid, affine, geom);
  const picks = new Float32Array(geom.nIl * geom.nXl).fill(NULL_F32);
  let placed = 0;
  let skipped = 0;
  for (let c = 0; c < values.length; c++) {
    const v = values[c];
    if (v === NULL_F32 || isNullValue(v)) continue;
    const s = zToSample(v);
    if (!Number.isFinite(s) || s < 0 || s > geom.ns - 1) { skipped += 1; continue; }
    picks[c] = s;
    placed += 1;
  }
  if (!placed) {
    throw new Error('No part of this grid lands on the volume: check that it belongs to this '
      + 'survey (coordinates and time range) and that the Z sign is right.');
  }
  return { picks, placed, skipped };
}
