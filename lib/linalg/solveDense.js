// Dense linear solve for tiny systems (@petrolord/engines lib/linalg,
// PT11d 2026-09-10). Promoted verbatim from engines/earthmodeling/
// properties.js so the petrophysics mineral solver reuses it instead of
// adding a fourth private elimination (seismolord/line2dIntegration.js and
// lib/gridding/gridding.js still carry their own; consolidating those is a
// separate chore). Gaussian elimination with partial pivoting; throws
// 'Singular system.' when a pivot falls below 1e-14. n is tiny (wells,
// minerals), so no factorisation caching.

/**
 * @param {number[][]} a square matrix as an array of rows
 * @param {number[]} b right-hand side
 * @returns {number[]} x with a·x = b
 */
export function solveDense(a, b) {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    }
    if (Math.abs(m[piv][col]) < 1e-14) throw new Error('Singular system.');
    [m[col], m[piv]] = [m[piv], m[col]];
    for (let r = col + 1; r < n; r++) {
      const f = m[r][col] / m[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r][n];
    for (let c = r + 1; c < n; c++) s -= m[r][c] * x[c];
    x[r] = s / m[r][r];
  }
  return x;
}
