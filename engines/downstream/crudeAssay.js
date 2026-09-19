/**
 * Crude assay, blending and valuation (Midstream & Downstream DS1).
 *
 * WHAT IS HERE, AND WHY THIS SET
 *
 * A crude assay studio answers four questions: what does this barrel turn
 * into, what happens to the properties when I mix two crudes, will the mixture
 * drop asphaltenes in my tank, and what is it worth against the crude I
 * already buy. Everything below serves one of those.
 *
 * THE BLENDING RULES ARE NOT INTERCHANGEABLE
 *
 * The single most common error in blend arithmetic is averaging the wrong
 * quantity on the wrong basis, and it is silent: the answer looks plausible
 * and is wrong by a few percent, which on a cargo is real money. So each
 * property here states its basis and the code enforces it.
 *
 *   - DENSITY blends on VOLUME. Mass is conserved and volume is assumed
 *     conserved, so rho_blend = sum(v_i * rho_i) / sum(v_i).
 *   - API GRAVITY DOES NOT BLEND AT ALL. It is a hyperbola in density, so the
 *     volume-weighted average of two API numbers is not the API of the blend.
 *     Every API here is computed by converting to specific gravity, blending
 *     that, and converting back. A 50/50 blend of 20 and 40 API is 29.38, not
 *     30: six tenths of a degree, which sounds small and is the difference
 *     between two grades on a price sheet.
 *   - SULFUR, TAN, NITROGEN and METALS are per unit MASS, so they blend on
 *     MASS. Given volumes, the mass fractions come from the densities.
 *   - VISCOSITY blends on neither. It needs an index (below).
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * D86 to TBP interconversion. The API Technical Data Book procedure is a
 * published COEFFICIENT TABLE, and reproducing a published table from memory
 * is what this package refuses (the same rule that keeps the relief-valve
 * chart factors as typed inputs). The gate is ARMED: the structure is here,
 * the coefficients are a required argument, and no default is shipped. It
 * matters less than it sounds, because a crude assay is reported as a TBP
 * distillation (D2892/D5236) in the first place; D86 is a product test.
 *
 * Pour point blending is also absent, for the same reason: its index is a
 * published correlation and this package does not guess at constants.
 */

/**
 * Numeric coercion that treats ABSENCE as absent.
 *
 * Number(null) is 0 and Number('') is 0, so the obvious implementation turns
 * a missing value into a real zero. That is the exact failure this module
 * family exists to avoid: a sulfur content nobody supplied is not zero
 * sulfur, an emission factor nobody supplied is not zero carbon, and a dip
 * nobody read is not an empty tank. Missing stays missing.
 */
const num = (v, fallback = NaN) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// ---------------------------------------------------------------------------
// Gravity
// ---------------------------------------------------------------------------

/** Specific gravity (60/60F) from API gravity. Exact definition, not a fit. */
export const sgFromApi = (api) => 141.5 / (num(api) + 131.5);

/** API gravity from specific gravity (60/60F). */
export const apiFromSg = (sg) => 141.5 / num(sg) - 131.5;

/**
 * Watson characterization factor, K = Tb^(1/3) / SG with Tb in degrees Rankine.
 *
 * Same form the fluid package already uses in characterizePlusFraction, kept
 * identical on purpose so a K quoted in one studio means the same thing in
 * the other. Roughly: 12.5 and above is paraffinic, near 11.5 naphthenic,
 * 10.5 and below aromatic.
 */
export const watsonK = ({ meanBoilingPointF, sg }) => {
  const tbR = num(meanBoilingPointF) + 459.67;
  const s = num(sg);
  if (!(tbR > 0) || !(s > 0)) return null;
  return Math.cbrt(tbR) / s;
};

// ---------------------------------------------------------------------------
// Fraction bookkeeping
// ---------------------------------------------------------------------------

/**
 * Normalise component fractions and produce BOTH bases.
 *
 * Callers think in volumes (a cargo is barrels) while half the properties
 * blend on mass, so the conversion happens once here rather than being
 * re-derived, differently, at each call site.
 *
 * @param {{sg:number, volumeFraction?:number, massFraction?:number}[]} components
 * @returns {{volume:number[], mass:number[], sgBlend:number, apiBlend:number}}
 */
export const resolveFractions = (components) => {
  if (!Array.isArray(components) || components.length === 0) {
    return { volume: [], mass: [], sgBlend: NaN, apiBlend: NaN };
  }
  const sgs = components.map((c) => num(c.sg));
  const hasVolume = components.some((c) => c.volumeFraction !== undefined && c.volumeFraction !== null);

  let volume;
  if (hasVolume) {
    const raw = components.map((c) => Math.max(0, num(c.volumeFraction, 0)));
    const total = raw.reduce((s, v) => s + v, 0);
    volume = total > 0 ? raw.map((v) => v / total) : raw.map(() => 0);
  } else {
    // Given masses instead, volumes follow from the densities.
    const rawMass = components.map((c) => Math.max(0, num(c.massFraction, 0)));
    const vols = rawMass.map((m, i) => (sgs[i] > 0 ? m / sgs[i] : 0));
    const total = vols.reduce((s, v) => s + v, 0);
    volume = total > 0 ? vols.map((v) => v / total) : vols.map(() => 0);
  }

  // Density blends on volume; this IS the blend's specific gravity.
  const sgBlend = volume.reduce((s, v, i) => s + v * sgs[i], 0);

  const massRaw = volume.map((v, i) => v * sgs[i]);
  const massTotal = massRaw.reduce((s, m) => s + m, 0);
  const mass = massTotal > 0 ? massRaw.map((m) => m / massTotal) : massRaw.map(() => 0);

  return { volume, mass, sgBlend, apiBlend: apiFromSg(sgBlend) };
};

/** Mass-weighted mean of a per-unit-mass property (sulfur wt%, TAN, ppm metals). */
export const blendOnMass = (values, massFractions) =>
  values.reduce((s, v, i) => s + num(v, 0) * (massFractions[i] ?? 0), 0);

/** Volume-weighted mean, for properties that genuinely are per unit volume. */
export const blendOnVolume = (values, volumeFractions) =>
  values.reduce((s, v, i) => s + num(v, 0) * (volumeFractions[i] ?? 0), 0);

// ---------------------------------------------------------------------------
// Viscosity
// ---------------------------------------------------------------------------

/**
 * Refutas viscosity blending index.
 *
 *   VBI = 14.534 * ln(ln(nu + 0.8)) + 10.975      (nu in cSt)
 *
 * Viscosity is wildly non-linear in composition: a 50/50 blend of a 10 cSt
 * and a 1000 cSt oil is nowhere near 505 cSt. The index linearises it so the
 * blend can be taken as a weighted mean and inverted.
 *
 * The index is blended on MASS fraction, which is the classic Refutas
 * formulation. (ASTM D7152 uses the same double-log family on a volume basis;
 * the two disagree slightly and mixing them up is a real error, so the basis
 * is named in the return value rather than assumed.)
 */
export const viscosityBlendIndex = (viscosityCSt) => {
  const nu = num(viscosityCSt);
  if (!(nu > 0)) return null;
  const inner = Math.log(nu + 0.8);
  // ln(ln(nu+0.8)) is undefined at or below nu = 0.2, where ln(nu+0.8) <= 0.
  if (!(inner > 0)) return null;
  return 14.534 * Math.log(inner) + 10.975;
};

/** Invert the Refutas index back to a kinematic viscosity in cSt. */
export const viscosityFromBlendIndex = (vbi) => {
  const i = num(vbi);
  if (!Number.isFinite(i)) return null;
  return Math.exp(Math.exp((i - 10.975) / 14.534)) - 0.8;
};

/**
 * Blend kinematic viscosities through the Refutas index.
 *
 * Returns null when any component viscosity is outside the index's domain,
 * rather than dropping it and quietly reporting the blend of the rest.
 */
export const blendViscosity = (viscositiesCSt, massFractions) => {
  const indices = viscositiesCSt.map(viscosityBlendIndex);
  if (indices.some((i) => i === null)) return null;
  const vbi = indices.reduce((s, i, k) => s + i * (massFractions[k] ?? 0), 0);
  return viscosityFromBlendIndex(vbi);
};

// ---------------------------------------------------------------------------
// Distillation and cut yields
// ---------------------------------------------------------------------------

/** A curve's usable points, sorted by temperature. */
const curvePoints = (curve) => [...(curve || [])]
  .map((p) => ({ v: num(p.volumePercent), t: num(p.temperatureF) }))
  .filter((p) => Number.isFinite(p.v) && Number.isFinite(p.t))
  .sort((a, b) => a.t - b.t);

/**
 * Interpolate a TBP curve: the volume percent distilled at a temperature.
 *
 * The curve is [{ volumePercent, temperatureF }]. Linear between measured
 * points. OUTSIDE the measured range the answer is known only where the curve
 * itself says so: below a first point at 0 percent nothing has distilled, and
 * above a last point at 100 percent everything has. Anywhere else outside the
 * range the value is NOT KNOWN and this returns null.
 *
 * It used to clamp flat instead, which is extrapolation by another name: a
 * curve whose last point is 85 percent at 900 F reported 85 percent at 1000 F,
 * so a 900 to 1000 F slice came out empty and its barrels were handed to the
 * residue. Below the first point it returned 0 for a curve starting at, say,
 * 5 percent, while the Suite's own blended curve returned 5 for the same
 * question: two answers to one question, both invented.
 */
export const volumePercentAt = (curve, temperatureF) => {
  const pts = curvePoints(curve);
  if (pts.length === 0) return null;
  const t = num(temperatureF);
  if (!Number.isFinite(t)) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (t < first.t) return first.v === 0 ? 0 : null;
  if (t > last.t) return last.v === 100 ? 100 : null;
  if (t === first.t) return first.v;
  if (t === last.t) return last.v;
  for (let i = 1; i < pts.length; i += 1) {
    if (t <= pts[i].t) {
      const span = pts[i].t - pts[i - 1].t;
      if (span <= 0) return pts[i].v;
      const f = (t - pts[i - 1].t) / span;
      return pts[i - 1].v + f * (pts[i].v - pts[i - 1].v);
    }
  }
  return pts[pts.length - 1].v;
};

/**
 * Temperature at which a curve reaches a volume percent: the inverse of
 * volumePercentAt, linear between measured points, null outside them.
 *
 * Where the curve is flat across the requested percent (two points at the same
 * volume) the lowest temperature reaching it is returned.
 */
export const temperatureAtVolumePercent = (curve, volumePercent) => {
  const pts = curvePoints(curve);
  const target = num(volumePercent);
  if (pts.length === 0 || !Number.isFinite(target)) return null;
  for (let i = 0; i < pts.length; i += 1) {
    if (pts[i].v === target) return pts[i].t;
    if (i > 0 && pts[i - 1].v < target && pts[i].v > target) {
      const f = (target - pts[i - 1].v) / (pts[i].v - pts[i - 1].v);
      return pts[i - 1].t + f * (pts[i].t - pts[i - 1].t);
    }
  }
  return null;
};

/**
 * The distillation curve of a blend.
 *
 * Yields are additive on VOLUME: at any temperature the blend has distilled
 * sum(f_i * V_i(T)), where f_i is each crude's volume fraction. So the blended
 * curve is formed at every temperature any component measured, never by
 * averaging temperatures. A temperature at which some component's curve says
 * nothing (volumePercentAt is null) is left out, because the blend's value
 * there is not known either.
 *
 * This used to live in the Suite's CrudeAssayContext as a second copy of the
 * interpolation, which disagreed with volumePercentAt below a curve's first
 * point. It lives here now and the app calls it.
 *
 * @param {{curve: {volumePercent:number, temperatureF:number}[]}[]} components
 * @param {number[]} volumeFractions  summing to one
 */
export const blendDistillationCurves = (components, volumeFractions) => {
  const temps = new Set();
  (components || []).forEach((c) => curvePoints(c.curve).forEach((p) => temps.add(p.t)));
  return [...temps].sort((a, b) => a - b).flatMap((temperatureF) => {
    let volumePercent = 0;
    for (let i = 0; i < components.length; i += 1) {
      const f = volumeFractions[i] ?? 0;
      if (!(f > 0)) continue;
      const v = volumePercentAt(components[i].curve, temperatureF);
      if (v === null) return [];
      volumePercent += f * v;
    }
    return [{ temperatureF, volumePercent }];
  });
};

/**
 * Yield of each cut, in volume percent of the whole crude.
 *
 * A cut runs from its lower to its upper boiling bound; the last cut may be
 * open-ended (no upper bound), which is the residue. Yields are reported as
 * they compute, and the total is returned so a curve that does not close to
 * 100 is visible rather than silently normalised away.
 *
 * @param {{volumePercent:number, temperatureF:number}[]} curve
 * @param {{id:string, name:string, fromF:number, toF:number|null}[]} cuts
 */
export const cutYields = ({ curve, cuts }) => {
  const rows = (cuts || []).map((cut) => {
    const lower = cut.fromF === null || cut.fromF === undefined
      ? 0
      : volumePercentAt(curve, cut.fromF);
    const upper = cut.toF === null || cut.toF === undefined
      ? 100
      : volumePercentAt(curve, cut.toF);
    const inverted = cut.fromF !== null && cut.fromF !== undefined && cut.toF !== null && cut.toF !== undefined
      && num(cut.toF) < num(cut.fromF);
    const yieldPct = lower === null || upper === null || inverted ? null : upper - lower;
    return {
      id: cut.id,
      name: cut.name,
      fromF: cut.fromF ?? null,
      toF: cut.toF ?? null,
      yieldVolPercent: yieldPct,
    };
  });
  const total = rows.reduce((s, r) => s + (r.yieldVolPercent ?? 0), 0);
  // A cut whose bound lies outside the measured curve, or whose bounds are
  // inverted, has no yield to report. It is named rather than zeroed, and the
  // set cannot close while any cut is unknown.
  const unknownCuts = rows.filter((r) => r.yieldVolPercent === null).map((r) => r.name || r.id);
  return {
    cuts: rows,
    totalVolPercent: total,
    unknownCuts,
    // A real assay closes to 100 within rounding. A gap means the cut set
    // does not cover the curve, which is the user's to resolve, not ours.
    closes: unknownCuts.length === 0 && Math.abs(total - 100) < 0.5,
  };
};

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

/**
 * Colloidal Instability Index from a SARA analysis.
 *
 *   CII = (saturates + asphaltenes) / (aromatics + resins)
 *
 * The physical argument: saturates precipitate asphaltenes, aromatics and
 * resins keep them in solution. So the ratio of the two groups screens
 * whether the asphaltenes are held.
 *
 * The bands below are the conventional screening ones and they are exactly
 * that, screening bands, not a phase boundary. A blend near the line should
 * be spot-tested (ASTM D7112/D7157) rather than argued about.
 */
export const CII_BANDS = { STABLE: 0.7, UNSTABLE: 0.9 };

export const colloidalInstabilityIndex = ({ saturates, aromatics, resins, asphaltenes }) => {
  const s = num(saturates, 0);
  const a = num(aromatics, 0);
  const r = num(resins, 0);
  const asph = num(asphaltenes, 0);
  const denominator = a + r;
  if (!(denominator > 0)) return null;
  return (s + asph) / denominator;
};

/**
 * Screen a blend for asphaltene stability.
 *
 * Uses the CII when a SARA analysis is available for every component, because
 * that is the measurement the question is actually about. Falls back to an
 * API-contrast heuristic when it is not, and SAYS WHICH IT USED: a screening
 * result whose basis is unstated invites more confidence than it has earned.
 *
 * SARA fractions blend on mass, like every other per-mass property here.
 */
export const screenBlendStability = ({ components, massFractions }) => {
  const haveSara = components.every((c) => c.sara
    && ['saturates', 'aromatics', 'resins', 'asphaltenes'].every((k) => Number.isFinite(num(c.sara[k]))));

  if (haveSara) {
    const mix = ['saturates', 'aromatics', 'resins', 'asphaltenes'].reduce((acc, k) => {
      acc[k] = blendOnMass(components.map((c) => c.sara[k]), massFractions);
      return acc;
    }, {});
    const cii = colloidalInstabilityIndex(mix);
    if (cii === null) {
      return { basis: 'none', message: 'The blended SARA has no aromatics or resins, so the index cannot be formed.', stable: null };
    }
    // Three bands, three answers. The middle band is neither: it used to come
    // back stable: false beside a message saying "Uncertain".
    const stable = cii < CII_BANDS.STABLE ? true : cii < CII_BANDS.UNSTABLE ? null : false;
    const band = cii < CII_BANDS.STABLE ? 'stable' : cii < CII_BANDS.UNSTABLE ? 'uncertain' : 'unstable';
    const message = cii < CII_BANDS.STABLE
      ? 'Screens stable on the colloidal instability index. Asphaltenes are held by the aromatics and resins present.'
      : cii < CII_BANDS.UNSTABLE
        ? 'Uncertain. The index sits in the band where blends go either way; spot test to ASTM D7112 or D7157 before commingling.'
        : 'Screens unstable. The saturate and asphaltene load is high against the aromatics and resins holding it. Do not commingle without a lab test.';
    return { basis: 'cii', cii, blendedSara: mix, stable, band, message };
  }

  // No SARA: the API-contrast screen, which is a heuristic and is labelled one.
  //
  // It can RAISE a flag and it cannot clear one. Its two thresholds (a 15
  // degree spread, a lightest crude above 35 API) are a rule of thumb, not a
  // measurement of the asphaltenes, so not seeing the classic combination is
  // no evidence of stability and the result is stable: null, not true. It used
  // to return true, which the app drew as a green tick. A missing API used to
  // pass as well: NaN failed both comparisons and the blend came back stable.
  const apis = components.map((c) => (Number.isFinite(num(c.api)) ? num(c.api) : apiFromSg(num(c.sg))));
  if (apis.some((a) => !Number.isFinite(a))) {
    return {
      basis: 'none',
      stable: null,
      message: 'No SARA analysis and not every crude has a gravity, so no stability screen was made. Supply SARA for a colloidal instability index.',
    };
  }
  const heaviest = Math.min(...apis);
  const lightest = Math.max(...apis);
  const contrast = lightest - heaviest;
  const paraffinicDiluent = lightest > 35;
  const flagged = contrast > 15 && paraffinicDiluent;
  return {
    basis: 'api-contrast',
    contrast,
    stable: flagged ? false : null,
    message: flagged
      ? `No SARA analysis supplied. On gravity contrast alone (${contrast.toFixed(1)} degrees API, with a light paraffinic component) this is the combination that classically drops asphaltenes. Supply SARA for a colloidal instability index, and spot test before commingling.`
      : 'No SARA analysis supplied, so this is an API-contrast screen only. The gravity spread is not the classic heavy-plus-light-paraffinic combination, which is not evidence that the blend is stable. Supply SARA for a real index.',
  };
};

// ---------------------------------------------------------------------------
// The blend
// ---------------------------------------------------------------------------

/**
 * Blend a set of crudes and report the resulting properties.
 *
 * Each property is computed on its own correct basis and the basis is
 * reported alongside the value, so a number can be checked rather than
 * trusted.
 *
 * @param {{id, name, api, sulfurWtPct?, tanMgKohG?, nitrogenWtPct?,
 *          nickelPpm?, vanadiumPpm?, viscosityCSt?, sara?,
 *          volumeFraction?, massFraction?}[]} components
 */
export const blendCrudes = (components) => {
  if (!Array.isArray(components) || components.length === 0) {
    return { error: 'No components to blend.' };
  }
  const label = (c, i) => c.name || c.id || `crude ${i + 1}`;
  const withSg = components.map((c) => {
    const sg = Number.isFinite(num(c.sg)) ? num(c.sg) : sgFromApi(c.api);
    return { ...c, sg: Number.isFinite(sg) && sg > 0 ? sg : null };
  });

  // Every refusal below used to be a silent number. A crude with no gravity
  // dropped out of a mass-basis blend and made the volume-basis one NaN; a
  // crude given by mass beside crudes given by volume was blended as zero; a
  // negative share was clamped to zero.
  const noGravity = withSg.filter((c) => c.sg === null).map(label);
  if (noGravity.length > 0) {
    return { error: `No API or specific gravity for ${noGravity.join(', ')}. Every property here is weighted by density.` };
  }
  const given = (v) => v !== undefined && v !== null && v !== '';
  const byVolume = withSg.filter((c) => given(c.volumeFraction));
  const byMass = withSg.filter((c) => given(c.massFraction));
  if (byVolume.length > 0 && byVolume.length < withSg.length) {
    return { error: 'Give every crude a volume share, or give every crude a mass share. The two cannot be mixed.' };
  }
  if (byVolume.length === 0 && byMass.length < withSg.length) {
    return { error: 'Give every crude a volume share or a mass share.' };
  }
  const shares = withSg.map((c) => num(byVolume.length > 0 ? c.volumeFraction : c.massFraction));
  if (shares.some((v) => !(v >= 0))) {
    return { error: 'A blend share must be a number of zero or more.' };
  }
  if (!(shares.reduce((s, v) => s + v, 0) > 0)) {
    return { error: 'The blend shares add up to zero.' };
  }

  const { volume, mass, sgBlend, apiBlend } = resolveFractions(withSg);

  // A property blends only when EVERY crude in the blend carries it. A crude
  // with a blank sulfur is not a sulfur-free crude; it used to be read as one,
  // which lowered the blend's sulfur by that crude's whole mass share, the
  // exact failure this file's num() was written to prevent.
  const missing = {};
  const massProperty = (key) => {
    const values = withSg.map((c) => c[key]);
    if (values.every((v) => !given(v))) return null;
    const without = withSg.filter((c, i) => mass[i] > 0 && !Number.isFinite(num(c[key]))).map(label);
    if (without.length > 0) { missing[key] = without; return null; }
    return blendOnMass(values.map((v) => num(v, 0)), mass);
  };

  const viscosities = withSg.map((c) => c.viscosityCSt);
  const viscosity = viscosities.every((v) => Number.isFinite(num(v)))
    ? blendViscosity(viscosities.map((v) => num(v)), mass)
    : null;
  const properties = {
    sg: sgBlend,
    api: apiBlend,
    sulfurWtPct: massProperty('sulfurWtPct'),
    tanMgKohG: massProperty('tanMgKohG'),
    nitrogenWtPct: massProperty('nitrogenWtPct'),
    nickelPpm: massProperty('nickelPpm'),
    vanadiumPpm: massProperty('vanadiumPpm'),
    viscosityCSt: viscosity,
  };
  const massBasis = (key) => (missing[key]
    ? `not blended: no value for ${missing[key].join(', ')}`
    : 'mass');

  return {
    fractions: withSg.map((c, i) => ({
      id: c.id, name: c.name, volumeFraction: volume[i], massFraction: mass[i],
    })),
    properties,
    missing,
    bases: {
      api: 'computed from the volume-blended specific gravity, never averaged directly',
      sulfurWtPct: massBasis('sulfurWtPct'),
      tanMgKohG: massBasis('tanMgKohG'),
      nitrogenWtPct: massBasis('nitrogenWtPct'),
      nickelPpm: massBasis('nickelPpm'),
      vanadiumPpm: massBasis('vanadiumPpm'),
      viscosityCSt: viscosity === null ? 'not blended: a component viscosity is missing or outside the index domain' : 'Refutas index on mass fraction',
    },
    stability: screenBlendStability({ components: withSg, massFractions: mass }),
  };
};

// ---------------------------------------------------------------------------
// Valuation
// ---------------------------------------------------------------------------

/**
 * Netback value of a barrel of crude, and the premium or discount against a
 * marker.
 *
 * netback = sum(cut yield fraction x cut product price) - processing - freight
 *
 * The yields are the crude's own, so the valuation follows the assay rather
 * than a rule of thumb about gravity and sulfur. Every term is reported, not
 * just the total, because the argument with a seller is always about one of
 * them.
 *
 * Losses are taken as a volume shrinkage on the product side, which is where
 * they show up commercially.
 */
export const netbackValue = ({
  cuts, prices, processingCostPerBbl, freightPerBbl, lossPercent, marker = null,
}) => {
  // A cost left blank is taken as zero, because a netback with no freight is
  // a legitimate question, but it is NAMED so a zero nobody typed is visible.
  const assumedZero = [
    ['processing cost', processingCostPerBbl], ['freight', freightPerBbl], ['losses', lossPercent],
  ].filter(([, v]) => !Number.isFinite(num(v))).map(([k]) => k);
  const loss = num(lossPercent, 0);
  if (!(loss >= 0 && loss <= 100)) {
    return { error: 'Losses must be between 0 and 100 percent.', netback: null };
  }
  const rows = (cuts || []).map((cut) => {
    const yieldFraction = num(cut.yieldVolPercent, 0) / 100;
    const price = num(prices?.[cut.id], NaN);
    return {
      id: cut.id,
      name: cut.name,
      yieldVolPercent: num(cut.yieldVolPercent, 0),
      pricePerBbl: Number.isFinite(price) ? price : null,
      valuePerBblCrude: Number.isFinite(price) ? yieldFraction * price : null,
    };
  });

  const priced = rows.filter((r) => r.valuePerBblCrude !== null);
  const unpriced = rows.filter((r) => r.valuePerBblCrude === null);
  const grossValue = priced.reduce((s, r) => s + r.valuePerBblCrude, 0);
  const afterLosses = grossValue * (1 - loss / 100);
  const netback = afterLosses - num(processingCostPerBbl, 0) - num(freightPerBbl, 0);

  return {
    rows,
    grossValue,
    lossValue: grossValue - afterLosses,
    processingCostPerBbl: num(processingCostPerBbl, 0),
    freightPerBbl: num(freightPerBbl, 0),
    netback,
    // Named, not silently excluded: a cut with no price is a gap in the
    // valuation and the total is only as complete as this list is empty.
    unpricedCuts: unpriced.map((r) => r.name || r.id),
    assumedZero,
    complete: unpriced.length === 0,
    marker: marker === null || marker === undefined ? null : {
      netback: num(marker),
      differential: netback - num(marker),
    },
  };
};

// ---------------------------------------------------------------------------
// D86 to TBP: structure only, gate ARMED
// ---------------------------------------------------------------------------

/**
 * Convert a D86 distillation to TBP by the cut-point-difference method.
 *
 * The method is: convert the 50 percent point, then convert each successive
 * temperature DIFFERENCE with its own pair of coefficients, and rebuild the
 * curve from the converted differences.
 *
 * `coefficients` is REQUIRED and has no default. The published table lives in
 * the API Technical Data Book (Procedure 3A1.1) and this package does not
 * reproduce published tables from memory: the same rule that keeps the
 * relief-valve chart factors as typed inputs. Supply the table and the
 * conversion works; until then it refuses, which is the honest behaviour.
 *
 * @param {{volumePercent:number, temperatureF:number}[]} d86
 * @param {{fifty:{a:number,b:number}, differences:{from:number,to:number,a:number,b:number}[]}} coefficients
 */
export const d86ToTbp = (d86, coefficients) => {
  if (!coefficients || !coefficients.fifty || !Array.isArray(coefficients.differences)) {
    return {
      error: 'D86 to TBP conversion needs the API Technical Data Book Procedure 3A1.1 coefficient table, which is not shipped with this package. Supply it, or enter the assay as a TBP distillation, which is how crude assays are reported.',
      curve: null,
    };
  }
  const byPercent = new Map(
    (d86 || []).map((p) => [num(p.volumePercent), num(p.temperatureF)]),
  );
  const t50 = byPercent.get(50);
  if (!Number.isFinite(t50)) {
    return { error: 'The D86 curve needs a 50 percent point to anchor the conversion.', curve: null };
  }

  const { a, b } = coefficients.fifty;
  const tbp50 = a * (t50 ** b);
  const result = new Map([[50, tbp50]]);
  // A difference that cannot be converted (a D86 point missing, or its anchor
  // not yet converted because the table is out of order) is named, not dropped.
  const skipped = [];

  coefficients.differences.forEach(({ from, to, a: ca, b: cb }) => {
    const tFrom = byPercent.get(from);
    const tTo = byPercent.get(to);
    const anchor = result.get(from);
    if (!Number.isFinite(tFrom) || !Number.isFinite(tTo) || !Number.isFinite(anchor)) {
      skipped.push({ from, to });
      return;
    }
    const observed = Math.abs(tTo - tFrom);
    const converted = ca * (observed ** cb);
    result.set(to, to > from ? anchor + converted : anchor - converted);
  });

  return {
    error: null,
    curve: [...result.entries()]
      .map(([volumePercent, temperatureF]) => ({ volumePercent, temperatureF }))
      .sort((x, y) => x.volumePercent - y.volumePercent),
    skipped,
    note: 'Converted with caller-supplied API 3A1.1 coefficients, applied to temperatures in degrees F. The conversion is only as good as that table.',
  };
};
