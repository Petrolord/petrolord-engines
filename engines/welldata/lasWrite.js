// LAS 2.0 writer (Petrophysics Studio PS2) — the export twin of
// lasParse.js, and gated by it: the contract is that
// parseLas(writeLas(x)) reproduces every curve BIT-FOR-BIT after the
// float32 cast, and the header semantically. Wherever the parser has a
// quirk rule, the writer stays inside the safe subset instead of
// exercising the quirk:
//
//   - mnemonics are sanitised to A-Z0-9_- (no '.', ':' or spaces —
//     dots would truncate the parsed name, colons would trip the
//     name:value header form)
//   - units lose spaces and colons; values and descriptions lose
//     colons (the parser reads values greedily to the LAST colon, so a
//     colon anywhere would shift the value/description split)
//   - numeric tokens print with 9 significant digits, enough that
//     float64(decimal) casts back to the identical float32
//   - the null value is chosen to collide with NO finite sample (a
//     real -999.25 in the data would otherwise read back as NaN)
//
// Always VERS 2.0, WRAP NO, one flat ~A section. Pure functions, no
// I/O; callers hand the returned string to a Blob or a file.

const NULL_CANDIDATES = [-999.25, -9999.25, -99999.99];

const sanitizeMnemonic = (s) => String(s || 'CURVE')
  .toUpperCase().replace(/[^A-Z0-9_-]/g, '_');
const sanitizeUnit = (s) => String(s || '').replace(/[\s:]/g, '_').replace(/\.+$/, '');
const sanitizeText = (s) => String(s ?? '').replace(/[:\r\n]/g, ' ').trim();

/** 9 significant digits: float64 -> decimal -> float64 -> float32
 *  lands on the identical float32 for every finite input. */
const numToken = (v) => String(Number(v.toPrecision(9)));

/** One header line in the canonical LAS 2.0 shape. */
function headerLine(name, unit, value, descr) {
  const left = `${name.padEnd(8)}.${unit.padEnd(6)} ${value}`;
  return `${left.padEnd(34)}: ${descr}`;
}

/**
 * Serialise curves + metadata to LAS 2.0 text.
 *
 * @param {Object} spec
 * @param {string} [spec.wellName] @param {string} [spec.company]
 * @param {string} [spec.field] @param {string} [spec.uwi]
 * @param {string} [spec.serviceCompany] @param {string} [spec.date] defaults to today (ISO)
 * @param {string} [spec.depthUnit] unit of the first (depth) curve, default 'M'
 * @param {?number} [spec.nullValue] fixed null; must not collide with data
 * @param {Array<{mnemonic: string, unit?: string, descr?: string,
 *   data: ArrayLike<number>}>} spec.curves first curve MUST be depth
 * @param {Array<{name: string, unit?: string, value: (number|string),
 *   descr?: string}>} [spec.params] written to ~Parameter
 * @param {string} [spec.other] free text for ~Other
 * @returns {string} LAS 2.0 file text
 */
export function writeLas({
  wellName = '', company = '', field = '', uwi = '',
  serviceCompany = '', date = null, depthUnit = 'M', nullValue = null,
  curves, params = [], other = '',
}) {
  if (!curves || !curves.length) throw new Error('writeLas: no curves to write.');
  const n = curves[0].data.length;
  if (!n) throw new Error('writeLas: the depth curve has no samples.');
  for (const c of curves) {
    if (c.data.length !== n) {
      throw new Error(`writeLas: curve ${c.mnemonic} has ${c.data.length} samples, depth has ${n}.`);
    }
  }

  // choose (or verify) a null that no finite sample equals
  const collides = (cand) => curves.some((c) => {
    for (let i = 0; i < n; i++) if (c.data[i] === cand) return true;
    return false;
  });
  let nullVal = nullValue;
  if (nullVal != null) {
    if (collides(nullVal)) {
      throw new Error(`writeLas: null value ${nullVal} equals a data sample — pick another.`);
    }
  } else {
    nullVal = NULL_CANDIDATES.find((cand) => !collides(cand));
    if (nullVal == null) throw new Error('writeLas: every null candidate collides with the data.');
  }

  const depth = curves[0].data;
  let step = 0;
  if (n > 1) {
    const step0 = depth[1] - depth[0];
    let uniform = true;
    for (let i = 1; i < n - 1; i++) {
      if (Math.abs((depth[i + 1] - depth[i]) - step0) > 1e-3 * Math.max(1, Math.abs(step0))) {
        uniform = false;
        break;
      }
    }
    if (uniform) step = step0;
  }

  const du = sanitizeUnit(depthUnit) || 'M';
  const lines = [];
  lines.push('~Version');
  lines.push(headerLine('VERS', '', '2.0', 'CWLS LAS 2.0'));
  lines.push(headerLine('WRAP', '', 'NO', 'One line per depth step'));

  lines.push('~Well');
  lines.push(headerLine('STRT', du, numToken(depth[0]), 'First depth'));
  lines.push(headerLine('STOP', du, numToken(depth[n - 1]), 'Last depth'));
  lines.push(headerLine('STEP', du, numToken(step), step === 0 ? 'Irregular sampling' : 'Depth step'));
  lines.push(headerLine('NULL', '', numToken(nullVal), 'Null value'));
  lines.push(headerLine('WELL', '', sanitizeText(wellName), 'Well name'));
  if (company) lines.push(headerLine('COMP', '', sanitizeText(company), 'Company'));
  if (field) lines.push(headerLine('FLD', '', sanitizeText(field), 'Field'));
  if (uwi) lines.push(headerLine('UWI', '', sanitizeText(uwi), 'Unique well id'));
  if (serviceCompany) lines.push(headerLine('SRVC', '', sanitizeText(serviceCompany), 'Service company'));
  lines.push(headerLine('DATE', '', sanitizeText(date || new Date().toISOString().slice(0, 10)), 'Export date'));

  lines.push('~Curve');
  const mnems = [];
  for (const c of curves) {
    let m = sanitizeMnemonic(c.mnemonic);
    while (mnems.includes(m)) m = `${m}_`; // parser suffixes duplicates; never emit them
    mnems.push(m);
    lines.push(headerLine(m, sanitizeUnit(c.unit), '', sanitizeText(c.descr)));
  }

  if (params.length) {
    lines.push('~Parameter');
    for (const prm of params) {
      const value = typeof prm.value === 'number' ? numToken(prm.value) : sanitizeText(prm.value);
      lines.push(headerLine(sanitizeMnemonic(prm.name), sanitizeUnit(prm.unit), value, sanitizeText(prm.descr)));
    }
  }

  if (other) {
    lines.push('~Other');
    // a leading tilde would open a new section on re-parse
    for (const l of String(other).split(/\r\n|\r|\n/)) lines.push(l.trim().replace(/^~+/, ''));
  }

  lines.push('~A');
  const nullTok = numToken(nullVal);
  // fixed-width right-aligned columns per curve
  const tokens = curves.map((c) => {
    const col = new Array(n);
    for (let i = 0; i < n; i++) {
      const v = c.data[i];
      col[i] = Number.isFinite(v) ? numToken(v) : nullTok;
    }
    return col;
  });
  const widths = tokens.map((col) => {
    let w = 0;
    for (const t of col) if (t.length > w) w = t.length;
    return w + 2;
  });
  for (let i = 0; i < n; i++) {
    let row = '';
    for (let c = 0; c < tokens.length; c++) row += tokens[c][i].padStart(widths[c]);
    lines.push(row);
  }

  return `${lines.join('\n')}\n`;
}
