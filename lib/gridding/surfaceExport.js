// Surface export writers (Phase 4): XYZ, CPS-3 and ZMAP+ in exactly the
// dialect of the committed Phase 0 reference files (byte-identity is
// asserted in jest). Domain rules: null = 1.0E+30 everywhere; CPS-3 and
// ZMAP+ bodies are column-major, north-to-south; depth surfaces carry
// NEGATIVE Z in feet.
//
// Grids here follow gridding.js: z[row * nx + col], row 0 = southernmost
// Y. Writers must NOT coerce values to float32 — formatting applies to
// the full float64 value (the oracle formatted numpy float64).

export const EXPORT_NULL_STRING = '1.0000000E+30';

const isNull = (v) => !Number.isFinite(v) || Math.abs(v) > 1.0e29;

/** Python f'{v:.{d}f}' equivalent. */
export const pyFixed = (v, d) => v.toFixed(d);

/** Python f'{v:>{width}.7E}' equivalent (2-digit exponent, uppercase). */
export function pyExp(v, decimals = 7, width = 19) {
  const [mant, exp] = v.toExponential(decimals).split('e');
  const sign = exp[0] === '-' ? '-' : '+';
  const digits = exp.replace(/[+-]/, '').padStart(2, '0');
  return `${mant}E${sign}${digits}`.padStart(width);
}

const fmtZ4 = (v) => (isNull(v) ? EXPORT_NULL_STRING : pyFixed(v, 4));

/** Column-major, north-to-south value order (rows stored south-first). */
function* columnMajorNorthToSouth(z, nx, ny) {
  for (let c = 0; c < nx; c++) {
    for (let r = ny - 1; r >= 0; r--) yield z[r * nx + c];
  }
}

const liveMinMax = (z) => {
  let min = Infinity;
  let max = -Infinity;
  for (const v of z) {
    if (isNull(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
};

/**
 * XYZ points: one node per row (south-first row order), nulls written as
 * 1.0E+30 so downstream null handling is exercised.
 * @param {{x: ArrayLike<number>, y: ArrayLike<number>,
 *          z: ArrayLike<number>, nx: number, ny: number}} g
 */
export function writeXYZ(g) {
  const lines = [];
  for (let r = 0; r < g.ny; r++) {
    for (let c = 0; c < g.nx; c++) {
      lines.push(`${pyFixed(g.x[c], 2)} ${pyFixed(g.y[r], 2)} ${fmtZ4(g.z[r * g.nx + c])}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * CPS-3 ASCII grid.
 * @param {{x, y, z, nx, ny, dx: number, dy: number}} g
 */
export function writeCPS3(g) {
  const { min, max } = liveMinMax(g.z);
  if (min > max) {
    // all-null grid: FSLIMI would print Infinity/-Infinity — an invalid
    // file no consumer could parse. Fail with a domain message instead.
    throw new Error('Surface grid has no live nodes — nothing to export as CPS-3.');
  }
  const header = [
    `FSASCI 0 1 "Computed" 0 ${EXPORT_NULL_STRING}`,
    'FSATTR 0 0',
    `FSLIMI ${pyFixed(g.x[0], 6)} ${pyFixed(g.x[g.nx - 1], 6)} `
      + `${pyFixed(g.y[0], 6)} ${pyFixed(g.y[g.ny - 1], 6)} `
      + `${pyFixed(min, 6)} ${pyFixed(max, 6)}`,
    `FSNROW ${g.ny} ${g.nx}`,
    `FSXINC ${pyFixed(g.dx, 6)} ${pyFixed(g.dy, 6)}`,
  ];
  const vals = [...columnMajorNorthToSouth(g.z, g.nx, g.ny)].map(fmtZ4);
  const body = [];
  for (let i = 0; i < vals.length; i += 5) body.push(vals.slice(i, i + 5).join(' '));
  return `${header.concat(body).join('\n')}\n`;
}

/**
 * ZMAP+ grid.
 * @param {{x, y, z, nx, ny, name: string, commentSuffix?: string}} g
 */
export function writeZMAP(g) {
  const header = [
    `!  ZMAP+ GRID: ${g.name}${g.commentSuffix ?? ''}`,
    `@${g.name} HEADER, GRID, 5`,
    `  20, ${EXPORT_NULL_STRING}, , 7, 1`,
    `  ${g.ny}, ${g.nx}, ${pyFixed(g.x[0], 6)}, ${pyFixed(g.x[g.nx - 1], 6)}, `
      + `${pyFixed(g.y[0], 6)}, ${pyFixed(g.y[g.ny - 1], 6)}`,
    '  0.0, 0.0, 0.0',
    '@',
  ];
  const vals = [...columnMajorNorthToSouth(g.z, g.nx, g.ny)].map((v) => pyExp(v, 7, 19));
  const body = [];
  for (let i = 0; i < vals.length; i += 5) body.push(vals.slice(i, i + 5).join(' '));
  return `${header.concat(body).join('\n')}\n`;
}

const M2_TO_ACRE = 1 / 4046.8564224;

/**
 * Gross rock volume between a depth surface (feet, negative down) and a
 * flat contact, in acre-feet. Null cells contribute nothing.
 * @param {{z: ArrayLike<number>, nx: number, ny: number}} g
 * @param {number} dxM cell size X in metres
 * @param {number} dyM cell size Y in metres
 * @param {number} contactFt e.g. -6200
 */
export function grvAcreFt(g, dxM, dyM, contactFt) {
  let sumFt = 0;
  for (const v of g.z) {
    if (isNull(v)) continue;
    const h = v - contactFt;              // both negative-down => +ve above contact
    if (h > 0) sumFt += h;
  }
  return sumFt * dxM * dyM * M2_TO_ACRE;
}
