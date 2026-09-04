/**
 * Wellhead choke and flowline limits (Production P8).
 *
 * The choke physics itself already exists and is validated: the
 * Gilbert-family critical-flow correlations and the single-phase gas
 * choke, with its exact thermodynamic critical ratio, live in the
 * Suite's nodal layer (`utils/nodal/chokes.js`, NA3). Rebuilding them
 * here would be duplication of exactly the kind this program has spent
 * two phases removing.
 *
 * What is NOT there, and is what a wellhead studio actually needs, is
 * the rest of the wellhead:
 *
 *   - the erosional velocity limit, which is what really caps a bean
 *     size once the pressure works
 *   - fitting the Gilbert-family coefficients to a well's OWN test
 *     data, because the published sets disagree enormously
 *   - a hydrate screening on the Joule-Thomson cooling across the bean
 *
 * ON THE PUBLISHED COEFFICIENT SETS. Gilbert, Ros, Baxendell, Achong
 * and Pilehvari span a factor of twelve in their leading constant
 * (3.82 to 46.67). They are not interchangeable and picking one by
 * habit is how a choke calculation goes quietly wrong. A well with a
 * few tests can have its own coefficients fitted, and that is worth far
 * more than any of the five.
 *
 * Field units: velocity ft/s, density lb/ft3, pressure psia,
 * temperature degF, diameter in, rate stb/d and Mscf/d.
 */

/**
 * API RP 14E erosional velocity:
 *
 *     Ve = C / sqrt(rho_m)
 *
 * C is an empirical constant and RP 14E is explicit that its own values
 * are conservative: 100 for continuous service and 125 for intermittent
 * are the figures the practice quotes, and the recommended practice
 * itself allows higher values where the fluid is free of sand and
 * corrosion is controlled. Operators routinely run 150 to 200 on clean,
 * inhibited service. So C is an INPUT here with the published values
 * offered and labelled, not a constant baked into an equation.
 */
export const EROSIONAL_C = [
  { id: 'continuous', label: 'RP 14E continuous service', c: 100 },
  { id: 'intermittent', label: 'RP 14E intermittent service', c: 125 },
  { id: 'cleanInhibited', label: 'Clean, inhibited service (operator practice)', c: 175 },
];

export const erosionalC = (id) =>
  EROSIONAL_C.find((x) => x.id === id) || EROSIONAL_C[0];

/** Erosional velocity, ft/s, for a mixture of a given density. */
export const erosionalVelocityFtS = ({ mixtureDensityLbFt3, cFactor = 100 }) => {
  if (!(mixtureDensityLbFt3 > 0) || !(cFactor > 0)) return NaN;
  return cFactor / Math.sqrt(mixtureDensityLbFt3);
};

/** Flow area of a round pipe, ft2, from its inside diameter in inches. */
export const pipeAreaFt2 = (idIn) => (Math.PI * idIn * idIn) / (4 * 144);

/**
 * Actual mixture velocity in a pipe, ft/s, from the IN-SITU volumetric
 * rate. The caller supplies that rate because turning surface rates
 * into in-situ ones is PVT work and belongs with the consumer's
 * validated fluid model, not in a wellhead limit check.
 */
export const mixtureVelocityFtS = ({ inSituBpd, idIn }) => {
  const areaFt2 = pipeAreaFt2(idIn);
  if (!(areaFt2 > 0)) return NaN;
  // bbl/d -> ft3/s
  return (inSituBpd * 5.614583) / 86400 / areaFt2;
};

/**
 * The erosional check at a point in the flowline or wellhead.
 *
 * returns { ok, velocityFtS, erosionalFtS, ratio, exceeded, marginPct }
 * `ratio` above one means the line is running faster than RP 14E
 * allows for the C factor given.
 */
export const erosionalCheck = ({
  inSituBpd, idIn, mixtureDensityLbFt3, cFactor = 100,
}) => {
  const velocityFtS = mixtureVelocityFtS({ inSituBpd, idIn });
  const erosionalFtS = erosionalVelocityFtS({ mixtureDensityLbFt3, cFactor });
  if (!Number.isFinite(velocityFtS) || !Number.isFinite(erosionalFtS)) {
    return { ok: false, error: 'The erosional check needs a positive rate, diameter and mixture density.' };
  }
  const ratio = velocityFtS / erosionalFtS;
  return {
    ok: true,
    velocityFtS,
    erosionalFtS,
    ratio,
    exceeded: ratio > 1,
    marginPct: (1 - ratio) * 100,
    cFactor,
  };
};

/** The largest rate a line can carry inside its erosional limit, in situ bbl/d. */
export const erosionalRateBpd = ({ idIn, mixtureDensityLbFt3, cFactor = 100 }) => {
  const ve = erosionalVelocityFtS({ mixtureDensityLbFt3, cFactor });
  if (!Number.isFinite(ve)) return NaN;
  return (ve * pipeAreaFt2(idIn) * 86400) / 5.614583;
};

// ---------------------------------------------------------------- fitting

/**
 * Solve a small symmetric linear system by Gaussian elimination with
 * partial pivoting. Three unknowns is not worth a library.
 */
const solve3 = (a, b) => {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let k = 0; k < n; k += 1) {
    let p = k;
    for (let i = k + 1; i < n; i += 1) if (Math.abs(m[i][k]) > Math.abs(m[p][k])) p = i;
    if (Math.abs(m[p][k]) < 1e-14) return null;
    [m[k], m[p]] = [m[p], m[k]];
    for (let i = k + 1; i < n; i += 1) {
      const f = m[i][k] / m[k][k];
      for (let j = k; j <= n; j += 1) m[i][j] -= f * m[k][j];
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
 * Fit the Gilbert-family coefficients to a well's own test data.
 *
 * The correlation is
 *
 *     pwh = c R^m q / S^n
 *
 * which is a power law in every variable, so taking logs makes it
 * LINEAR:
 *
 *     ln(pwh / q) = ln(c) + m ln(R) - n ln(S)
 *
 * and the three coefficients come out of an ordinary least squares on
 * that. This matters because the five published sets span a factor of
 * twelve in c and are not interchangeable; a well with a handful of
 * tests can have its own.
 *
 * `mode`:
 *   'all'    fit c, m and n. Needs at least three tests, and they must
 *            vary in both gas-liquid ratio and bean size or the system
 *            is singular -- which is reported rather than solved to
 *            nonsense.
 *   'cOnly'  hold m and n at a published set and fit only the leading
 *            constant. This is the common field practice and needs a
 *            single test.
 *
 * returns { ok, error, c, m, n, points, residuals, rmsePct, r2, mode }
 */
export const fitGilbertCoefficients = ({ points, mode = 'all', fixed }) => {
  const clean = (points || []).filter((p) => (
    Number.isFinite(p.pwh) && p.pwh > 0
    && Number.isFinite(p.q) && p.q > 0
    && Number.isFinite(p.glr) && p.glr > 0
    && Number.isFinite(p.s64) && p.s64 > 0
  ));

  if (mode === 'cOnly') {
    const m = fixed?.m;
    const n = fixed?.n;
    if (!Number.isFinite(m) || !Number.isFinite(n)) {
      return { ok: false, error: 'Holding the exponents needs values for both of them.' };
    }
    if (!clean.length) {
      return { ok: false, error: 'Fitting the leading constant needs at least one usable test.' };
    }
    const lnC = clean.reduce((acc, p) => acc
      + (Math.log(p.pwh / p.q) - m * Math.log(p.glr) + n * Math.log(p.s64)), 0) / clean.length;
    return finish({ c: Math.exp(lnC), m, n, clean, mode });
  }

  if (clean.length < 3) {
    return {
      ok: false,
      error: `Fitting all three coefficients needs at least three usable tests; ${clean.length} were given. Hold the exponents at a published set to fit the leading constant alone.`,
    };
  }

  // Normal equations for  y = b0 + b1 x1 + b2 x2,
  //   y = ln(pwh/q), x1 = ln(R), x2 = ln(S), b2 = -n
  const X = clean.map((p) => [1, Math.log(p.glr), Math.log(p.s64)]);
  const y = clean.map((p) => Math.log(p.pwh / p.q));
  const a = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const rhs = [0, 0, 0];
  for (let i = 0; i < X.length; i += 1) {
    for (let r = 0; r < 3; r += 1) {
      rhs[r] += X[i][r] * y[i];
      for (let cIdx = 0; cIdx < 3; cIdx += 1) a[r][cIdx] += X[i][r] * X[i][cIdx];
    }
  }
  const b = solve3(a, rhs);
  if (!b || !b.every(Number.isFinite)) {
    return {
      ok: false,
      error: 'These tests do not pin the coefficients down: they need to vary in both gas-liquid ratio and bean size. Hold the exponents at a published set instead.',
    };
  }
  return finish({ c: Math.exp(b[0]), m: b[1], n: -b[2], clean, mode: 'all' });
};

/** Residuals and fit quality, in the units a user reads: percent of pwh. */
const finish = ({ c, m, n, clean, mode }) => {
  const residuals = clean.map((p) => {
    const predicted = (c * Math.pow(p.glr, m) * p.q) / Math.pow(p.s64, n);
    return {
      ...p,
      predictedPwh: predicted,
      errorPsi: predicted - p.pwh,
      errorPct: ((predicted - p.pwh) / p.pwh) * 100,
    };
  });
  const rmsePct = Math.sqrt(
    residuals.reduce((acc, r) => acc + r.errorPct * r.errorPct, 0) / residuals.length,
  );
  const meanObs = clean.reduce((acc, p) => acc + p.pwh, 0) / clean.length;
  const ssTot = clean.reduce((acc, p) => acc + (p.pwh - meanObs) ** 2, 0);
  const ssRes = residuals.reduce((acc, r) => acc + r.errorPsi ** 2, 0);
  const warnings = [];
  if (mode === 'all' && (n < 1 || n > 3)) {
    warnings.push({
      code: 'exponentOutOfFamily',
      message: `The fitted bean exponent is ${n.toFixed(2)}. Every published set sits between 1.88 and 2.11, so a value this far outside usually means the tests do not span enough bean sizes rather than that this well is unusual.`,
    });
  }
  if (mode === 'all' && (m < 0 || m > 1.2)) {
    warnings.push({
      code: 'ratioExponentOutOfFamily',
      message: `The fitted gas-liquid ratio exponent is ${m.toFixed(2)}, against 0.31 to 0.65 across the published sets. Check that the tests really differ in gas-liquid ratio.`,
    });
  }
  // Prints the RMS it fired on, at one decimal: at whole percent a
  // 15.3 percent miss read "15 percent" under a flag that only fires
  // above 15. The residual collision is the 0.05 either side, not zero.
  if (rmsePct > 15) {
    warnings.push({
      code: 'poorFit',
      message: `The fit misses the tests by ${rmsePct.toFixed(1)} percent on average. Either these tests were not all in critical flow, or something other than the choke was controlling.`,
    });
  }
  return {
    ok: true,
    c,
    m,
    n,
    mode,
    points: clean,
    residuals,
    rmsePct,
    r2: ssTot > 0 ? 1 - ssRes / ssTot : NaN,
    warnings,
  };
};

// -------------------------------------------------------------- hydrates

/**
 * Hydrate screening on the Joule-Thomson cooling across a bean.
 *
 * Gas cools as it expands through a choke, and the wellhead downstream
 * of the bean is the commonest place in a gas system to make hydrate.
 * The downstream temperature is already computed exactly, by the
 * isentropic ideal-gas relation in the nodal gas choke.
 *
 * WHAT THIS IS AND IS NOT. The Hammerschmidt correlation
 *
 *     T_hydrate [degF] = A P^B      (P psia, A = 8.9, B = 0.285)
 *
 * is a SCREENING approximation and is treated as one: it takes no
 * account of gas composition, and hydrate formation depends strongly on
 * it. A real hydrate curve comes from a flash against a hydrate model
 * with the actual composition, which is Fluid Studio work and is armed
 * as a literature gate rather than approximated here. Both constants
 * are inputs so a user with a curve for their own gas can match it.
 *
 * The verdict is deliberately phrased as a risk, not a fact.
 */
export const HAMMERSCHMIDT = { a: 8.9, b: 0.285 };

export const hydrateFormationTempF = ({ pPsia, a = HAMMERSCHMIDT.a, b = HAMMERSCHMIDT.b }) => {
  if (!(pPsia > 0)) return NaN;
  return a * Math.pow(pPsia, b);
};

export const hydrateScreening = ({
  pDownstreamPsia, tDownstreamF, a, b, marginF = 0,
}) => {
  const formationF = hydrateFormationTempF({ pPsia: pDownstreamPsia, a, b });
  if (!Number.isFinite(formationF) || !Number.isFinite(tDownstreamF)) {
    return { ok: false, error: 'The hydrate screening needs a downstream pressure and temperature.' };
  }
  const marginActualF = tDownstreamF - formationF;
  return {
    ok: true,
    formationF,
    downstreamF: tDownstreamF,
    marginF: marginActualF,
    atRisk: marginActualF <= marginF,
    screening: true,
  };
};
