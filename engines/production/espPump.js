/**
 * Electrical submersible pump stage hydraulics (Production P5).
 *
 * A pump is described by ONE stage: head, efficiency and brake power
 * against rate at a reference frequency. Everything else follows from
 * that stage — the stack of stages that makes the required head, the
 * shaft power, the speed change under a drive.
 *
 * Where the stage curve comes from matters, so this module is explicit
 * about it and offers exactly two honest routes:
 *
 *  1. `fitStageCurve(points)` — least squares through the points off a
 *     vendor's published pump curve. This is the route for a real
 *     design: the numbers are the manufacturer's, and the fit is
 *     reported with its residual so a bad transcription shows up.
 *  2. `referenceStageCurve(spec)` — a transparent MODEL stage built
 *     from four parameters an engineer already knows (rate at best
 *     efficiency, head there, the shutoff-to-BEP head ratio, and peak
 *     efficiency). It is a shape, not a catalog entry, and it is
 *     labelled as such everywhere it surfaces. It exists so sizing
 *     exercises and the studio's default state have something physical
 *     to work with, never so a design can quote a pump it has not been
 *     given the curve for.
 *
 * There are no manufacturer part numbers with invented curves behind
 * them anywhere in this package.
 *
 * Speed. Affinity laws for a fixed impeller: q scales with N, head with
 * N squared, power with N cubed, efficiency unchanged. That is exact
 * for geometrically similar operation and is what every drive sizing
 * uses.
 *
 * Viscosity. Viscous service moves head, rate and efficiency off the
 * water curve, and the industry correction is the Hydraulic Institute
 * chart (ANSI/HI 9.6.7). It is NOT reproduced here from memory: this
 * module reports the in-situ viscosity and flags when a correction is
 * required, and accepts correction factors when the user has them.
 * Applying invented factors would be worse than applying none.
 *
 * Field units: rate bbl/d (in situ, at pump conditions), head ft,
 * power hp, frequency Hz.
 */

/**
 * Hydraulic power constant, from first principles rather than a
 * remembered field formula:
 *
 *   P = rho g Q H;  1 bbl/d = 5.614583/86400 ft3/s;  water 62.4 lbf/ft3;
 *   1 hp = 550 ft lbf/s
 *   => hp = q[bbl/d] * H[ft] * SG / 135629.6...
 *
 * The equivalent pressure form, hp = q * dP[psi] / 58824, falls out of
 * the same constant through dP = 0.433 SG H, and both are gated.
 */
export const FT3_PER_BBL = 5.614583;
export const SEC_PER_DAY = 86400;
export const WATER_LBF_PER_FT3 = 62.4;
export const FT_LBF_PER_S_PER_HP = 550;
export const HP_HEAD_DIVISOR =
  (FT_LBF_PER_S_PER_HP * SEC_PER_DAY) / (WATER_LBF_PER_FT3 * FT3_PER_BBL);

/** Hydraulic power of a stage stack, hp. */
export const hydraulicHp = ({ qBpd, headFt, specificGravity }) =>
  (qBpd * headFt * specificGravity) / HP_HEAD_DIVISOR;

/** Brake power from hydraulic power and efficiency (fraction). */
export const brakeHp = ({ qBpd, headFt, specificGravity, efficiency }) => {
  if (!(efficiency > 0)) return NaN;
  return hydraulicHp({ qBpd, headFt, specificGravity }) / efficiency;
};

// --------------------------------------------------------------- fitting

/** Solve a dense linear system by Gaussian elimination with partial pivoting. */
const solveLinear = (a, b) => {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let piv = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    }
    if (Math.abs(m[piv][col]) < 1e-14) return null;
    if (piv !== col) { const t = m[piv]; m[piv] = m[col]; m[col] = t; }
    for (let r = col + 1; r < n; r += 1) {
      const f = m[r][col] / m[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c += 1) m[r][c] -= f * m[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    let s = m[i][n];
    for (let j = i + 1; j < n; j += 1) s -= m[i][j] * x[j];
    x[i] = s / m[i][i];
  }
  return x;
};

/**
 * Least-squares polynomial fit of y against x, degree reduced when
 * there are too few points to support it. x is normalised by `scale`
 * before fitting, which is what keeps the normal equations conditioned
 * over rates of a few thousand.
 * Returns { coeffs (ascending powers, in x/scale), scale, degree, rmse }.
 */
export const polyFit = (xs, ys, degree, scale) => {
  const n = xs.length;
  const deg = Math.max(1, Math.min(degree, n - 1));
  const s = scale || Math.max(...xs.map(Math.abs)) || 1;
  const z = xs.map((x) => x / s);
  const cols = deg + 1;
  const ata = Array.from({ length: cols }, () => new Array(cols).fill(0));
  const atb = new Array(cols).fill(0);
  for (let i = 0; i < n; i += 1) {
    const pows = new Array(cols);
    pows[0] = 1;
    for (let k = 1; k < cols; k += 1) pows[k] = pows[k - 1] * z[i];
    for (let r = 0; r < cols; r += 1) {
      atb[r] += pows[r] * ys[i];
      for (let c = 0; c < cols; c += 1) ata[r][c] += pows[r] * pows[c];
    }
  }
  const coeffs = solveLinear(ata, atb);
  if (!coeffs) return { coeffs: [ys.reduce((a, b) => a + b, 0) / n], scale: s, degree: 0, rmse: NaN };
  const evalAt = (x) => {
    const t = x / s;
    let acc = 0;
    for (let k = coeffs.length - 1; k >= 0; k -= 1) acc = acc * t + coeffs[k];
    return acc;
  };
  const rmse = Math.sqrt(xs.reduce((acc, x, i) => acc + (evalAt(x) - ys[i]) ** 2, 0) / n);
  return { coeffs, scale: s, degree: deg, rmse };
};

/** Evaluate a polyFit result at x. */
export const polyEval = (fit, x) => {
  const t = x / fit.scale;
  let acc = 0;
  for (let k = fit.coeffs.length - 1; k >= 0; k -= 1) acc = acc * t + fit.coeffs[k];
  return acc;
};

/**
 * Stage curve from vendor points.
 *
 * points: [{ qBpd, headFt, efficiencyPct?, bhpPerStage? }] at
 * `refHz` (the frequency the vendor published the curve at).
 * Efficiency and brake power are fitted when given; brake power is
 * otherwise derived from head and efficiency at the water specific
 * gravity the curve is published at (1.0 unless told otherwise).
 *
 * returns {
 *   source: 'vendor', refHz, qMin, qMax, headFit, effFit, bhpFit,
 *   bep: { qBpd, headFt, efficiency }, points, warnings
 * }
 */
export const fitStageCurve = ({
  points, refHz = 60, curveSpecificGravity = 1, headDegree = 3, effDegree = 3,
}) => {
  const clean = (points || [])
    .filter((p) => Number.isFinite(p.qBpd) && Number.isFinite(p.headFt) && p.qBpd >= 0)
    .sort((a, b) => a.qBpd - b.qBpd);
  const warnings = [];
  if (clean.length < 3) {
    return {
      source: 'vendor', refHz, points: clean, ok: false,
      warnings: ['A stage curve needs at least three points from the vendor curve.'],
    };
  }
  const qs = clean.map((p) => p.qBpd);
  const scale = Math.max(...qs) || 1;
  const headFit = polyFit(qs, clean.map((p) => p.headFt), headDegree, scale);

  const withEff = clean.filter((p) => Number.isFinite(p.efficiencyPct) && p.efficiencyPct > 0);
  let effFit = null;
  if (withEff.length >= 3) {
    effFit = polyFit(
      withEff.map((p) => p.qBpd),
      withEff.map((p) => p.efficiencyPct / 100),
      effDegree,
      scale,
    );
  } else {
    warnings.push('No efficiency points given, so brake power comes from the vendor power points or cannot be computed.');
  }

  const withBhp = clean.filter((p) => Number.isFinite(p.bhpPerStage) && p.bhpPerStage > 0);
  let bhpFit = null;
  if (withBhp.length >= 3) {
    bhpFit = polyFit(withBhp.map((p) => p.qBpd), withBhp.map((p) => p.bhpPerStage), headDegree, scale);
  }

  if (headFit.rmse > 0.02 * Math.max(...clean.map((p) => p.headFt))) {
    warnings.push('The head fit misses the points by more than two percent of the curve height; check the transcription.');
  }

  const curve = {
    source: 'vendor',
    refHz,
    curveSpecificGravity,
    qMin: qs[0],
    qMax: qs[qs.length - 1],
    headFit,
    effFit,
    bhpFit,
    points: clean,
    ok: true,
    warnings,
  };
  curve.bep = bepOf(curve);
  return curve;
};

/**
 * Reference stage MODEL (not a catalog entry, not vendor data).
 *
 * Head follows the standard dimensionless centrifugal shape through
 * shutoff and the best efficiency point,
 *
 *   H(q)/H_bep = r - (r - 1) (q/q_bep)^2,      r = shutoff head ratio
 *
 * which is exact at q = 0 and at q = q_bep by construction, and
 * efficiency the textbook parabola peaking at the BEP,
 *
 *   eta(q)/eta_bep = 2 (q/q_bep) - (q/q_bep)^2.
 *
 * Both are models with named parameters, so a reader can see exactly
 * what they are; neither claims to be any manufacturer's stage.
 */
export const referenceStageCurve = ({
  bepBpd, bepHeadFt, shutoffRatio = 1.35, bepEfficiency = 0.68,
  qMin, qMax, refHz = 60, label,
}) => {
  const lo = qMin ?? 0.5 * bepBpd;
  const hi = qMax ?? 1.4 * bepBpd;
  const n = 9;
  const points = Array.from({ length: n }, (_, i) => {
    const q = lo + ((hi - lo) * i) / (n - 1);
    const x = q / bepBpd;
    return {
      qBpd: q,
      headFt: bepHeadFt * (shutoffRatio - (shutoffRatio - 1) * x * x),
      efficiencyPct: 100 * bepEfficiency * Math.max(0, 2 * x - x * x),
    };
  });
  const curve = fitStageCurve({ points, refHz, headDegree: 2, effDegree: 2 });
  return {
    ...curve,
    source: 'reference-model',
    label: label || `Reference stage, ${Math.round(bepBpd)} bbl/d BEP`,
    spec: { bepBpd, bepHeadFt, shutoffRatio, bepEfficiency },
  };
};

/** Best efficiency point of a curve (max of the efficiency fit). */
export const bepOf = (curve) => {
  if (!curve?.effFit) {
    return { qBpd: NaN, headFt: NaN, efficiency: NaN };
  }
  let best = { qBpd: curve.qMin, efficiency: -Infinity };
  const steps = 400;
  for (let i = 0; i <= steps; i += 1) {
    const q = curve.qMin + ((curve.qMax - curve.qMin) * i) / steps;
    const e = polyEval(curve.effFit, q);
    if (e > best.efficiency) best = { qBpd: q, efficiency: e };
  }
  return { ...best, headFt: polyEval(curve.headFit, best.qBpd) };
};

/**
 * Stage performance at a rate and a drive frequency.
 *
 * The affinity laws map the operating rate back to the reference-speed
 * curve, read it there, and map head and power forward again:
 *   q_ref = q * (refHz/hz),  H = H_ref * (hz/refHz)^2,
 *   P = P_ref * (hz/refHz)^3,  eta unchanged.
 *
 * `region` compares the equivalent reference rate with the vendor's
 * published range: below it the stage is in downthrust, above it in
 * upthrust, and both wear a pump out. Nothing is extrapolated silently
 * — `inRange` says whether the answer is inside the published curve.
 *
 * returns { headFt, efficiency, bhpPerStage, qRefBpd, ratio, inRange,
 *           region }
 */
export const stagePerformance = ({
  curve, qBpd, hz, specificGravity = 1,
}) => {
  const refHz = curve.refHz || 60;
  const ratio = hz / refHz;
  if (!(ratio > 0)) return { headFt: NaN, efficiency: NaN, bhpPerStage: NaN, inRange: false, region: 'invalid' };
  const qRef = qBpd / ratio;
  const inRange = qRef >= curve.qMin && qRef <= curve.qMax;
  const headRef = polyEval(curve.headFit, qRef);
  const eff = curve.effFit ? polyEval(curve.effFit, qRef) : NaN;
  const headFt = headRef * ratio * ratio;

  let bhpPerStage;
  if (curve.bhpFit) {
    bhpPerStage = polyEval(curve.bhpFit, qRef) * ratio * ratio * ratio;
  } else if (eff > 0) {
    bhpPerStage = brakeHp({ qBpd, headFt, specificGravity, efficiency: eff });
  } else {
    bhpPerStage = NaN;
  }

  const bep = curve.bep || bepOf(curve);
  let region = 'recommended';
  if (!inRange) region = qRef < curve.qMin ? 'downthrust' : 'upthrust';
  else if (Number.isFinite(bep.qBpd)) {
    if (qRef < 0.75 * bep.qBpd) region = 'downthrust';
    else if (qRef > 1.25 * bep.qBpd) region = 'upthrust';
  }

  return { headFt, efficiency: eff, bhpPerStage, qRefBpd: qRef, ratio, inRange, region };
};

/**
 * Head and power of a whole stack at a rate, plus where that rate sits
 * on the stage curve.
 */
export const stackPerformance = ({ curve, stages, qBpd, hz, specificGravity = 1 }) => {
  const s = stagePerformance({ curve, qBpd, hz, specificGravity });
  return {
    ...s,
    stages,
    headFt: s.headFt * stages,
    bhpTotal: s.bhpPerStage * stages,
  };
};

/**
 * Viscosity check. The Hydraulic Institute correction is not applied
 * here (see the module header); this reports what the fluid is doing
 * and whether the water curve can still be believed.
 *
 * Returns { viscosityCSt, correctionRequired, note } and, when the
 * caller supplies measured HI factors, the corrected performance.
 */
export const VISCOSITY_CORRECTION_THRESHOLD_CST = 10;

export const viscosityCheck = ({
  viscosityCp, densityLbFt3, factors,
}) => {
  const sg = densityLbFt3 / 62.4;
  const cSt = sg > 0 ? viscosityCp / sg : NaN;
  const correctionRequired = cSt > VISCOSITY_CORRECTION_THRESHOLD_CST;
  return {
    viscosityCSt: cSt,
    correctionRequired,
    factorsApplied: !!factors,
    factors: factors || null,
    note: correctionRequired
      ? (factors
        ? 'Viscous service: the correction factors you supplied are applied to head, rate and efficiency.'
        : 'Viscous service: the water curve overstates head and efficiency. Enter Hydraulic Institute correction factors for this fluid before using these stage counts.')
      : 'Below the viscosity where a pump curve correction is normally needed.',
  };
};

/** Apply user-supplied Hydraulic Institute factors to a stage reading. */
export const applyViscosityFactors = (stage, factors) => {
  if (!factors) return stage;
  const { cq = 1, ch = 1, ceta = 1 } = factors;
  return {
    ...stage,
    headFt: stage.headFt * ch,
    efficiency: stage.efficiency * ceta,
    qCorrectedBpd: (stage.qRefBpd || NaN) * cq,
    factorsApplied: true,
  };
};
