// Normal compaction trend (exponential transit-time form) —
// dt_n(z) = dt_ma + (dt_ml - dt_ma) * exp(-c z). Fitting is EXACT
// least squares on the log-transform (ln(dt - dt_ma) is linear in z):
// deterministic, no iteration. Validated against the porepressure
// oracle goldens. Transit times in us/m, depths in m below mudline.

/** Normal-compaction transit time [us/m] at depth z below mudline. */
export function nctDt(z, dtMl, dtMa, c) {
  if (!(z >= 0)) throw new Error('Depth must be >= 0.');
  if (!(dtMl > dtMa) || !(dtMa > 0)) {
    throw new Error('Need dt_ml > dt_ma > 0.');
  }
  if (!Number.isFinite(c)) throw new Error('Compaction constant must be finite.');
  return dtMa + (dtMl - dtMa) * Math.exp(-c * z);
}

/**
 * Fit (dtMl, c) of the NCT from shale picks by exact least squares on
 * ln(dt - dtMa) vs z. Every pick must exceed the matrix transit time.
 * @returns {{dtMl: number, c: number}}
 */
export function fitNct(zs, dts, dtMa) {
  if (!zs || !dts || zs.length !== dts.length || zs.length < 2) {
    throw new Error('Need at least two picks with matching depths.');
  }
  const ys = new Array(zs.length);
  for (let i = 0; i < dts.length; i++) {
    if (!(dts[i] > dtMa)) {
      throw new Error(`Pick at index ${i} is at or below the matrix transit time.`);
    }
    ys[i] = Math.log(dts[i] - dtMa);
  }
  const n = zs.length;
  let sz = 0; let sy = 0; let szz = 0; let szy = 0;
  for (let i = 0; i < n; i++) {
    sz += zs[i];
    sy += ys[i];
    szz += zs[i] * zs[i];
    szy += zs[i] * ys[i];
  }
  const denom = n * szz - sz * sz;
  if (denom === 0) throw new Error('Degenerate picks (single depth).');
  const slope = (n * szy - sz * sy) / denom;
  const intercept = (sy - slope * sz) / n;
  return { dtMl: dtMa + Math.exp(intercept), c: -slope };
}
