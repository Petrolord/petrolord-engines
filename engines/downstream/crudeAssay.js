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

/**
 * Interpolate a TBP curve: the volume percent distilled at a temperature.
 *
 * The curve is [{ volumePercent, temperatureF }] in increasing order. Linear
 * between points, clamped at the ends: below the initial boiling point
 * nothing has distilled, above the final point everything has. Clamping
 * rather than extrapolating matters, because extrapolating a distillation
 * curve past its last measured point invents yield.
 */
export const volumePercentAt = (curve, temperatureF) => {
  const pts = [...(curve || [])]
    .map((p) => ({ v: num(p.volumePercent), t: num(p.temperatureF) }))
    .filter((p) => Number.isFinite(p.v) && Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  if (pts.length === 0) return null;
  const t = num(temperatureF);
  if (t <= pts[0].t) return pts[0].v === 0 ? 0 : Math.min(pts[0].v, t < pts[0].t ? 0 : pts[0].v);
  if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].v;
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
    const yieldPct = lower === null || upper === null ? null : Math.max(0, upper - lower);
    return {
      id: cut.id,
      name: cut.name,
      fromF: cut.fromF ?? null,
      toF: cut.toF ?? null,
      yieldVolPercent: yieldPct,
    };
  });
  const total = rows.reduce((s, r) => s + (r.yieldVolPercent ?? 0), 0);
  return {
    cuts: rows,
    totalVolPercent: total,
    // A real assay closes to 100 within rounding. A gap means the cut set
    // does not cover the curve, which is the user's to resolve, not ours.
    closes: Math.abs(total - 100) < 0.5,
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
    const stable = cii < CII_BANDS.STABLE;
    const message = cii < CII_BANDS.STABLE
      ? 'Screens stable on the colloidal instability index. Asphaltenes are held by the aromatics and resins present.'
      : cii < CII_BANDS.UNSTABLE
        ? 'Uncertain. The index sits in the band where blends go either way; spot test to ASTM D7112 or D7157 before commingling.'
        : 'Screens unstable. The saturate and asphaltene load is high against the aromatics and resins holding it. Do not commingle without a lab test.';
    return { basis: 'cii', cii, blendedSara: mix, stable, message };
  }

  // No SARA: the API-contrast screen, which is a heuristic and is labelled one.
  const apis = components.map((c) => num(c.api));
  const heaviest = Math.min(...apis);
  const lightest = Math.max(...apis);
  const contrast = lightest - heaviest;
  const paraffinicDiluent = lightest > 35;
  const stable = !(contrast > 15 && paraffinicDiluent);
  return {
    basis: 'api-contrast',
    contrast,
    stable,
    message: stable
      ? 'No SARA analysis supplied, so this is an API-contrast screen only: the gravity spread is not the classic heavy-plus-light-paraffinic combination that destabilises asphaltenes. Supply SARA for a real index.'
      : `No SARA analysis supplied. On gravity contrast alone (${contrast.toFixed(1)} degrees API, with a light paraffinic component) this is the combination that classically drops asphaltenes. Supply SARA for a colloidal instability index, and spot test before commingling.`,
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
  const withSg = components.map((c) => ({ ...c, sg: c.sg ?? sgFromApi(c.api) }));
  const { volume, mass, sgBlend, apiBlend } = resolveFractions(withSg);

  const massProperty = (key) => {
    const values = withSg.map((c) => c[key]);
    if (values.every((v) => v === undefined || v === null)) return null;
    return blendOnMass(values.map((v) => num(v, 0)), mass);
  };

  const viscosities = withSg.map((c) => c.viscosityCSt);
  const viscosity = viscosities.every((v) => Number.isFinite(num(v)))
    ? blendViscosity(viscosities.map((v) => num(v)), mass)
    : null;

  return {
    fractions: withSg.map((c, i) => ({
      id: c.id, name: c.name, volumeFraction: volume[i], massFraction: mass[i],
    })),
    properties: {
      sg: sgBlend,
      api: apiBlend,
      sulfurWtPct: massProperty('sulfurWtPct'),
      tanMgKohG: massProperty('tanMgKohG'),
      nitrogenWtPct: massProperty('nitrogenWtPct'),
      nickelPpm: massProperty('nickelPpm'),
      vanadiumPpm: massProperty('vanadiumPpm'),
      viscosityCSt: viscosity,
    },
    bases: {
      api: 'computed from the volume-blended specific gravity, never averaged directly',
      sulfurWtPct: 'mass',
      tanMgKohG: 'mass',
      nitrogenWtPct: 'mass',
      nickelPpm: 'mass',
      vanadiumPpm: 'mass',
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
  cuts, prices, processingCostPerBbl = 0, freightPerBbl = 0, lossPercent = 0, marker = null,
}) => {
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
  const afterLosses = grossValue * (1 - Math.max(0, num(lossPercent, 0)) / 100);
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

  coefficients.differences.forEach(({ from, to, a: ca, b: cb }) => {
    const tFrom = byPercent.get(from);
    const tTo = byPercent.get(to);
    if (!Number.isFinite(tFrom) || !Number.isFinite(tTo)) return;
    const observed = Math.abs(tTo - tFrom);
    const converted = ca * (observed ** cb);
    const anchor = result.get(from);
    if (!Number.isFinite(anchor)) return;
    result.set(to, to > from ? anchor + converted : anchor - converted);
  });

  return {
    error: null,
    curve: [...result.entries()]
      .map(([volumePercent, temperatureF]) => ({ volumePercent, temperatureF }))
      .sort((x, y) => x.volumePercent - y.volumePercent),
    note: 'Converted with caller-supplied API 3A1.1 coefficients. The conversion is only as good as that table.',
  };
};
