// Surface grid READERS — the import mirror of surfaceExport's writers:
// XYZ points, CPS-3, ZMAP+ and Irap classic ASCII, with format
// sniffing. Every parser returns the writers' grid shape —
// { nx, ny, x0, y0, dx, dy, z: Float32Array } with z row-major,
// row 0 = southernmost Y, nulls normalised to the suite sentinel
// 1.0E+30 — so a parsed surface feeds the writers, the registry and
// the map unchanged.
//
// Errors are plain row-numbered domain Errors (the wellImport house
// style): a malformed file names the first offending line, never
// throws a TypeError from deep inside.

export const SURFACE_NULL = 1.0e30;
const NULL_F32 = Math.fround(SURFACE_NULL);
const IRAP_UNDEF = 9999900.0;

const isNullish = (v) => !Number.isFinite(v) || Math.abs(v) > 1.0e29;

/** Non-empty, non-comment lines with their 1-based source line numbers. */
function contentLines(text, isComment = (s) => s.startsWith('!') || s.startsWith('#')) {
  const out = [];
  const raw = text.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i].trim();
    if (!s || isComment(s)) continue;
    out.push({ s, n: i + 1 });
  }
  return out;
}

const numbersOf = (s) => s.split(/[\s,]+/).filter(Boolean).map(Number);

/**
 * Sniff a surface file's dialect from its first content lines.
 * @returns {'cps3'|'zmap'|'irap'|'xyz'}
 */
export function detectSurfaceFormat(text) {
  const head = text.slice(0, 4096);
  for (const raw of head.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s) continue;
    if (s.startsWith('FSASCI')) return 'cps3';
    if (s.startsWith('!') || (s.startsWith('@') && /GRID/i.test(s))) return 'zmap';
    if (/^-996(\s|$)/.test(s)) return 'irap';
    return 'xyz';
  }
  throw new Error('The file is empty.');
}

/** Fill a south-first row-major grid from column-major north-to-south
 *  body values (the CPS-3 / ZMAP+ writer order, inverted). */
function fillColumnMajorNorthToSouth(vals, nx, ny, isUndef) {
  if (vals.length !== nx * ny) {
    throw new Error(
      `Grid body has ${vals.length} values but the header promises ${nx * ny} (${ny} rows x ${nx} columns).`);
  }
  const z = new Float32Array(nx * ny);
  let k = 0;
  for (let c = 0; c < nx; c++) {
    for (let r = ny - 1; r >= 0; r--) {
      const v = vals[k++];
      z[r * nx + c] = isUndef(v) ? NULL_F32 : v;
    }
  }
  return z;
}

/** CPS-3 ASCII grid (FSASCI/FSLIMI/FSNROW/FSXINC header). */
export function parseCPS3(text) {
  const lines = contentLines(text, () => false);
  const header = {};
  let bodyStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const { s } = lines[i];
    const tag = s.slice(0, 6);
    if (/^FS[A-Z]{4}$/.test(tag)) {
      header[tag] = s.slice(6).trim();
    } else {
      bodyStart = i;
      break;
    }
  }
  if (!('FSLIMI' in header) || !('FSNROW' in header) || !('FSXINC' in header)) {
    throw new Error('Not a CPS-3 grid: missing FSLIMI / FSNROW / FSXINC header lines.');
  }
  const limi = numbersOf(header.FSLIMI);
  const nrow = numbersOf(header.FSNROW);
  const xinc = numbersOf(header.FSXINC);
  if (limi.length < 4 || limi.slice(0, 4).some((v) => !Number.isFinite(v))) {
    throw new Error(`FSLIMI is malformed: "${header.FSLIMI}".`);
  }
  if (nrow.length < 2 || !Number.isInteger(nrow[0]) || !Number.isInteger(nrow[1])
    || nrow[0] < 2 || nrow[1] < 2) {
    throw new Error(`FSNROW is malformed: "${header.FSNROW}" (need rows columns, each >= 2).`);
  }
  if (xinc.length < 2 || xinc.slice(0, 2).some((v) => !(v > 0))) {
    throw new Error(`FSXINC is malformed: "${header.FSXINC}".`);
  }
  const [ny, nx] = nrow;
  // declared null (FSASCI's last token) plus the suite sentinel window
  const fsasci = numbersOf(header.FSASCI || '');
  const declaredNull = fsasci.length ? fsasci[fsasci.length - 1] : SURFACE_NULL;
  const vals = [];
  for (let i = Math.max(bodyStart, 0); i < lines.length && bodyStart >= 0; i++) {
    for (const v of numbersOf(lines[i].s)) {
      if (!Number.isFinite(v)) {
        throw new Error(`Line ${lines[i].n}: non-numeric value in the grid body.`);
      }
      vals.push(v);
    }
  }
  const z = fillColumnMajorNorthToSouth(
    vals, nx, ny, (v) => isNullish(v) || v === declaredNull);
  return { nx, ny, x0: limi[0], y0: limi[2], dx: xinc[0], dy: xinc[1], z };
}

/** ZMAP+ grid ('!' comments, @name HEADER + 3 spec lines, '@' body start). */
export function parseZMAP(text) {
  const lines = contentLines(text);          // '!'/'#' comments dropped
  if (!lines.length || !lines[0].s.startsWith('@')) {
    throw new Error('Not a ZMAP+ grid: expected an "@<name> HEADER, GRID" line.');
  }
  // header record: 3 comma-separated spec lines between @name and the bare @
  let i = 1;
  const spec = [];
  for (; i < lines.length && lines[i].s !== '@'; i++) spec.push(lines[i]);
  if (i >= lines.length) {
    throw new Error('ZMAP+ header never closes: no terminating "@" line before the body.');
  }
  if (spec.length < 2) {
    throw new Error('ZMAP+ header is missing its specification lines.');
  }
  const l1 = numbersOf(spec[0].s);           // width, null, [null-text skipped], dec, start-col
  const l2 = numbersOf(spec[1].s);           // ny, nx, xmin, xmax, ymin, ymax
  const declaredNull = l1.length >= 2 && Number.isFinite(l1[1]) ? l1[1] : SURFACE_NULL;
  if (l2.length < 6 || !Number.isInteger(l2[0]) || !Number.isInteger(l2[1])
    || l2[0] < 2 || l2[1] < 2) {
    throw new Error(`Line ${spec[1].n}: malformed ZMAP+ grid line `
      + '(need rows, columns, xmin, xmax, ymin, ymax).');
  }
  const [ny, nx, xmin, xmax, ymin, ymax] = l2;
  const vals = [];
  for (i += 1; i < lines.length; i++) {
    if (lines[i].s.startsWith('@')) break;   // a second section ends the grid
    for (const v of numbersOf(lines[i].s)) {
      if (!Number.isFinite(v)) {
        throw new Error(`Line ${lines[i].n}: non-numeric value in the grid body.`);
      }
      vals.push(v);
    }
  }
  const z = fillColumnMajorNorthToSouth(
    vals, nx, ny, (v) => isNullish(v) || v === declaredNull);
  return {
    nx,
    ny,
    x0: xmin,
    y0: ymin,
    dx: (xmax - xmin) / (nx - 1),
    dy: (ymax - ymin) / (ny - 1),
    z,
  };
}

/** Irap classic ASCII grid (-996 header; x fastest from the SW corner). */
export function parseIrapClassic(text) {
  const lines = contentLines(text);
  if (lines.length < 5) throw new Error('Not an Irap classic grid: file is too short.');
  const h1 = numbersOf(lines[0].s);
  const h2 = numbersOf(lines[1].s);
  const h3 = numbersOf(lines[2].s);
  if (h1[0] !== -996 || h1.length < 4) {
    throw new Error(`Line ${lines[0].n}: not an Irap classic header (expected "-996 ny dx dy").`);
  }
  const ny = h1[1];
  const dx = h1[2];
  const dy = h1[3];
  if (h2.length < 4) throw new Error(`Line ${lines[1].n}: malformed Irap extent line.`);
  if (h3.length < 4) throw new Error(`Line ${lines[2].n}: malformed Irap nx/rotation line.`);
  const nx = h3[0];
  const rot = h3[1];
  if (!Number.isInteger(nx) || !Number.isInteger(ny) || nx < 2 || ny < 2
    || !(dx > 0) || !(dy > 0)) {
    throw new Error('Irap header has non-positive dimensions or cell sizes.');
  }
  if (rot !== 0) {
    throw new Error(`Rotated Irap grids are not supported (rotation ${rot} deg) — `
      + 'export the surface unrotated.');
  }
  const vals = [];
  for (let i = 4; i < lines.length; i++) {
    for (const v of numbersOf(lines[i].s)) {
      if (!Number.isFinite(v)) {
        throw new Error(`Line ${lines[i].n}: non-numeric value in the grid body.`);
      }
      vals.push(v);
    }
  }
  if (vals.length !== nx * ny) {
    throw new Error(
      `Grid body has ${vals.length} values but the header promises ${nx * ny} (${ny} rows x ${nx} columns).`);
  }
  const z = new Float32Array(nx * ny);
  for (let k = 0; k < vals.length; k++) {
    const v = vals[k];
    z[k] = isNullish(v) || v >= IRAP_UNDEF ? NULL_F32 : v;   // row-major south-first already
  }
  return { nx, ny, x0: h2[0], y0: h2[2], dx, dy, z };
}

/**
 * XYZ points -> regular grid. The points must lie on a regular
 * axis-aligned lattice (our own XYZ exports do; scattered points need
 * gridding, which import deliberately does not do). Missing nodes stay
 * null; rows with a null sentinel z keep their node null.
 */
export function parseXYZGrid(text) {
  const lines = contentLines(text, (s) => s.startsWith('!') || s.startsWith('#') || s.startsWith('//'));
  const pts = [];
  for (const { s, n } of lines) {
    const v = numbersOf(s);
    if (v.length < 3 || v.slice(0, 2).some((x) => !Number.isFinite(x))
      || Number.isNaN(v[2])) {
      throw new Error(`Line ${n}: expected "x y z", got "${s}".`);
    }
    pts.push(v);
  }
  if (pts.length < 4) throw new Error('Too few points to form a grid (need at least 2 x 2).');

  const axis = (idx, name) => {
    const sorted = [...new Set(pts.map((p) => p[idx]))].sort((a, b) => a - b);
    if (sorted.length < 2) throw new Error(`All points share one ${name} — not a grid.`);
    let step = Infinity;
    for (let i = 1; i < sorted.length; i++) step = Math.min(step, sorted[i] - sorted[i - 1]);
    if (!(step > 0)) throw new Error(`Duplicate ${name} values collapse the grid axis.`);
    const span = sorted[sorted.length - 1] - sorted[0];
    const count = Math.round(span / step) + 1;
    // every value must sit on the lattice within 1e-3 of a step
    for (const v of sorted) {
      const k = (v - sorted[0]) / step;
      if (Math.abs(k - Math.round(k)) > 1e-3) {
        throw new Error(`The ${name} values are not regularly spaced — `
          + 'import a gridded format (CPS-3 / ZMAP+ / Irap) or re-grid the points.');
      }
    }
    return { min: sorted[0], step, count };
  };
  const ax = axis(0, 'X');
  const ay = axis(1, 'Y');
  if (ax.count * ay.count > 4_000_000) {
    throw new Error('The inferred grid exceeds the 4M-node ceiling — check the file.');
  }
  const z = new Float32Array(ax.count * ay.count).fill(NULL_F32);
  for (const [x, y, v] of pts) {
    const c = Math.round((x - ax.min) / ax.step);
    const r = Math.round((y - ay.min) / ay.step);
    z[r * ax.count + c] = isNullish(v) ? NULL_F32 : v;
  }
  return {
    nx: ax.count, ny: ay.count, x0: ax.min, y0: ay.min, dx: ax.step, dy: ay.step, z,
  };
}

/**
 * Parse a surface file of any supported dialect.
 * @returns {{format: string, nx, ny, x0, y0, dx, dy, z: Float32Array}}
 */
export function parseSurfaceFile(text, format = null) {
  const fmt = format || detectSurfaceFormat(text);
  const parser = {
    cps3: parseCPS3, zmap: parseZMAP, irap: parseIrapClassic, xyz: parseXYZGrid,
  }[fmt];
  if (!parser) throw new Error(`Unknown surface format: ${fmt}`);
  return { format: fmt, ...parser(text) };
}

/** Live-node stats for an import preview. */
export function surfaceGridStats(g) {
  let live = 0;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const v of g.z) {
    if (v === NULL_F32 || isNullish(v)) continue;
    live += 1;
    if (v < zMin) zMin = v;
    if (v > zMax) zMax = v;
  }
  return { live, nulls: g.z.length - live, zMin: live ? zMin : null, zMax: live ? zMax : null };
}
