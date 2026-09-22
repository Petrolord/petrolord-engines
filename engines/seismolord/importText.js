// Shared plumbing for the tolerant interpretation READERS (horizon
// picks in horizonImport.js, fault sticks in faultImport.js): numeric
// token tests, a capped reject collector, the "nothing parsed" refusal,
// delimited-cell splitting and the generic column-mapped reader.
//
// Tolerant means a bad row never aborts the file: it is recorded as a
// reject { line, reason, column?, field?, text } (line 1-based, column
// 1-based) and parsing carries on. A file is refused outright only when
// NOTHING could be read, and the refusal names the first few rejects so
// the user sees which lines and columns failed.

/** Upper bound on stored rejects (the count keeps going past it). */
export const MAX_STORED_REJECTS = 1000;

/** Rejects named in a whole-file refusal message. */
export const REFUSAL_REJECTS_NAMED = 5;

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eEdD][+-]?\d+)?$/;

/** True for a plain decimal or exponent token (Fortran D exponents too). */
export const isNumToken = (t) => typeof t === 'string' && NUM_RE.test(t);

/** Token -> number, or NaN when it is not a plain numeric token. */
export const toNum = (t) => (isNumToken(t) ? Number(t.replace(/[dD]/, 'e')) : NaN);

/** The suite null sentinel window (1.0E+30, and MAXFLOAT 3.4E+38). */
export const isNullValue = (v) => !Number.isFinite(v) || Math.abs(v) > 1.0e29;

/** Comment lines every reader skips. */
export const isCommentLine = (s) => s.startsWith('#') || s.startsWith('!') || s.startsWith('//');

/** Strip one pair of surrounding quotes. */
export const unquote = (s) => String(s ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();

/** Raw text -> lines (CRLF, CR and LF all end a line). */
export const splitLines = (text) => String(text ?? '').split(/\r\n|\r|\n/);

/** Short, printable excerpt of a source line for a reject report. */
const excerpt = (s) => {
  const t = String(s ?? '').trim();
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
};

/**
 * Reject collector. `add` records one bad row; `count` keeps counting
 * past MAX_STORED_REJECTS so a huge broken file reports its real size.
 */
export function createRejects() {
  const list = [];
  let count = 0;
  return {
    list,
    get count() { return count; },
    add(line, reason, extra = {}) {
      count += 1;
      if (list.length < MAX_STORED_REJECTS) {
        const r = { line, reason };
        if (extra.column != null) r.column = extra.column;
        if (extra.field != null) r.field = extra.field;
        if (extra.text != null) r.text = excerpt(extra.text);
        list.push(r);
      }
    },
  };
}

/** One reject as a sentence: "Line 12, column 5 (z): not a number". */
export function describeReject(r) {
  const where = [`Line ${r.line}`];
  if (r.column != null) where.push(`column ${r.column}${r.field ? ` (${r.field})` : ''}`);
  else if (r.field) where.push(`(${r.field})`);
  return `${where.join(', ')}: ${r.reason}`;
}

/**
 * The whole-file refusal: nothing could be read. Names the first
 * REFUSAL_REJECTS_NAMED rejects; the full list rides on err.rejects.
 */
export function refuseNothingRead(what, rejects, hint = '') {
  const named = rejects.list.slice(0, REFUSAL_REJECTS_NAMED).map(describeReject);
  const more = rejects.count > named.length ? ` (${rejects.count} lines failed in all)` : '';
  const msg = rejects.count
    ? `No ${what} could be read from this file${more}. ${named.join('; ')}.${hint ? ` ${hint}` : ''}`
    : `No ${what} could be read from this file: it has no data rows.${hint ? ` ${hint}` : ''}`;
  const err = new Error(msg);
  err.rejects = rejects.list;
  err.rejectCount = rejects.count;
  return err;
}

/** Delimiter sniff on one line: most frequent of , ; tab, else whitespace. */
export function detectLineDelimiter(line) {
  const counts = [
    [',', (line.match(/,/g) || []).length],
    [';', (line.match(/;/g) || []).length],
    ['\t', (line.match(/\t/g) || []).length],
  ].sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : 'whitespace';
}

/** Split one line into trimmed string cells. */
export function splitCells(line, delimiter) {
  const s = line.trim();
  if (delimiter === 'whitespace') {
    // quoted names may hold spaces: keep "..." together
    const out = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
    return out;
  }
  return s.split(delimiter).map((c) => unquote(c));
}

// Header-name suggestions for a column mapping (first match wins).
const FIELD_PATTERNS = [
  ['il', /^(il|iline|inline|in[\s_-]?line|inl)$/i],
  ['xl', /^(xl|xline|crossline|cross[\s_-]?line|crl|trace|cdp)$/i],
  ['x', /^(x|easting|east|utm[\s_-]?x|x[\s_-]?coord(inate)?|cdp[\s_-]?x)$/i],
  ['y', /^(y|northing|north|utm[\s_-]?y|y[\s_-]?coord(inate)?|cdp[\s_-]?y)$/i],
  ['z', /^(z|twt|twt[\s_-]?ms|time|time[\s_-]?ms|depth|tvdss|tvd|value|elevation)$/i],
  ['stick', /^(stick|stick[\s_-]?(id|no|nr|number|index)|segment|seg|seg[\s_-]?id)$/i],
  ['name', /^(name|horizon|horizon[\s_-]?name|surface|fault|fault[\s_-]?name)$/i],
];

/**
 * Suggest a column mapping from header names.
 * @param {string[]} header
 * @returns {Object<string, number>} field -> 0-based column
 */
export function suggestMappingFromHeader(header) {
  const out = {};
  (header || []).forEach((raw, i) => {
    const h = unquote(raw).replace(/\s*\(.*\)\s*$/, '').trim();
    for (const [field, re] of FIELD_PATTERNS) {
      if (out[field] == null && re.test(h)) { out[field] = i; break; }
    }
  });
  return out;
}

const FIELD_LABELS = {
  x: 'X', y: 'Y', z: 'Z', il: 'inline', xl: 'crossline', name: 'name', stick: 'stick',
};

/**
 * Generic ASCII reader with an explicit column mapping.
 *
 * @param {string} text
 * @param {Object} mapping
 * @param {Object<string, number>} mapping.columns field -> 0-based
 *   column: numeric fields x, y, z, il, xl, stick; text field name
 * @param {'auto'|'whitespace'|','|'\t'|';'} [mapping.delimiter]
 * @param {number|'auto'} [mapping.headerLines] data rows to skip at the
 *   top ('auto': leading rows whose mapped numeric cells are not numbers)
 * @param {?number} [mapping.nullValue] extra null sentinel for z
 * @param {Object} opts
 * @param {string[]} opts.required fields that must be mapped
 * @returns {{records: Array<{line: number, block: number, x?, y?, z,
 *   il?, xl?, stick?, name?}>, rejects, ignored: number, nulls: number,
 *   delimiter: string}}
 */
export function parseMappedColumns(text, mapping, { required = ['z'] } = {}) {
  const cols = mapping?.columns || {};
  for (const f of required) {
    if (!Number.isInteger(cols[f]) || cols[f] < 0) {
      throw new Error(`Map a column to ${FIELD_LABELS[f] || f} before reading the file.`);
    }
  }
  const hasXY = Number.isInteger(cols.x) && Number.isInteger(cols.y);
  const hasLines = Number.isInteger(cols.il) && Number.isInteger(cols.xl);
  if (!hasXY && !hasLines) {
    throw new Error('Map X and Y columns, or inline and crossline columns, to place the points.');
  }
  const numeric = ['x', 'y', 'z', 'il', 'xl', 'stick'].filter((f) => Number.isInteger(cols[f]));
  const lines = splitLines(text);
  let delimiter = mapping.delimiter && mapping.delimiter !== 'auto' ? mapping.delimiter : null;
  let skip = mapping.headerLines ?? 'auto';
  const rejects = createRejects();
  const records = [];
  let ignored = 0;
  let nulls = 0;
  let block = 0;
  let sawData = false;
  let blankRun = false;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) {
      if (sawData && !blankRun) { block += 1; blankRun = true; }
      continue;
    }
    if (isCommentLine(s)) { ignored += 1; continue; }
    if (!delimiter) delimiter = detectLineDelimiter(s);
    const cells = splitCells(s, delimiter);
    if (typeof skip === 'number' && skip > 0) { skip -= 1; ignored += 1; continue; }
    if (skip === 'auto' && !sawData) {
      // a leading row with no numbers in ANY mapped numeric column is a header
      if (!numeric.some((f) => isNumToken(cells[cols[f]]))) { ignored += 1; continue; }
    }
    const n = i + 1;
    const rec = { line: n, block };
    let bad = false;
    for (const f of numeric) {
      const c = cols[f];
      const cell = cells[c];
      if (cell == null || cell === '') {
        rejects.add(n, `missing ${FIELD_LABELS[f]} value (the row has ${cells.length} columns)`,
          { column: c + 1, field: FIELD_LABELS[f], text: s });
        bad = true;
        break;
      }
      const v = toNum(cell);
      if (!Number.isFinite(v)) {
        rejects.add(n, `"${cell}" is not a number`, { column: c + 1, field: FIELD_LABELS[f], text: s });
        bad = true;
        break;
      }
      rec[f] = v;
    }
    if (bad) continue;
    if (Number.isInteger(cols.name)) {
      const nm = unquote(cells[cols.name] ?? '');
      if (nm) rec.name = nm;
    }
    sawData = true;
    blankRun = false;
    if (isNullValue(rec.z) || (mapping.nullValue != null && rec.z === mapping.nullValue)) {
      nulls += 1;
      continue;
    }
    records.push(rec);
  }
  return { records, rejects, ignored, nulls, delimiter: delimiter || 'whitespace' };
}
