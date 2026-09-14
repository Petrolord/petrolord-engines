/**
 * Carbon footprint and abatement (Midstream & Downstream DS9).
 *
 * The roll-up of a ledger the rest of the module already produces. Every
 * other app in Midstream & Downstream computes carbon beside money from the
 * same volumes; this one assembles those figures into an inventory, an
 * intensity, and a ranking of what to do about it.
 *
 * WHAT THIS IS NOT
 *
 * It is not a compliance register. A regulatory register tracks obligations,
 * evidence and deadlines, and Assurance owns that. This is the quantitative
 * engine that feeds one. Building a second register here would create two
 * records of the same obligation that could disagree, which is worse than
 * having one.
 *
 * EMISSION FACTORS ARE NOT SHIPPED, THEY ARE REGISTERED
 *
 * The API Compendium and the IPCC guidelines are published documents that
 * are revised, and a factor without its source and version is not an
 * auditable number. So a factor is a RECORD - value, unit, source, version,
 * vintage - and an inventory built from factors that lack provenance is
 * computed, clearly marked NOT REPORTABLE, and told which lines are the
 * problem. Refusing outright would make the app useless during a first pass;
 * reporting silently would be worse.
 *
 * WHERE THE ATOM BALANCE BEATS THE FACTOR
 *
 * Combustion CO2 is not an empirical factor at all: every carbon atom that
 * goes into a burner comes out as CO2. A published fuel-based factor is a
 * proxy for exactly that arithmetic. So where the fuel analysis is known,
 * this computes CO2 from the carbon and SAYS it did, and reserves factors
 * for the things that really are empirical.
 *
 * AND THE GWP SET IS DECLARED
 *
 * Global warming potentials differ between IPCC assessment reports, by
 * enough to move a methane-heavy inventory by a fifth. An inventory on one
 * report is not comparable with one on another, and they are compared
 * constantly. The set is a required input carrying its own label, no values
 * are shipped, and every result states which set produced it.
 */

/** Missing stays missing. */
const num = (v, fallback = NaN) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const round = (v, dp = 6) => (Number.isFinite(v)
  ? Math.round(v * 10 ** dp) / 10 ** dp
  : null);

export const SCOPE = { ONE: 1, TWO: 2 };

/** Relative molecular masses. Definitional, from the atomic masses. */
export const MW_CO2 = 44.009;
export const MW_C = 12.011;
export const MW_CH4 = 16.043;

// ---------------------------------------------------------------------------
// The factor registry
// ---------------------------------------------------------------------------

/**
 * An emission factor as a RECORD rather than a number.
 *
 * A factor without a source and a version cannot be audited, and an
 * inventory is an auditable document or it is nothing. This does not refuse
 * an unsourced factor - a first pass would be impossible - it records that
 * it is unsourced and lets the inventory mark itself unreportable.
 */
export const makeFactor = ({
  id, label, value, unit, gas = 'CO2', source = null, version = null, vintage = null,
}) => {
  const v = num(value, null);
  const missing = [];
  if (!source) missing.push('source');
  if (!version) missing.push('version');
  return {
    id: id || label,
    label,
    value: v,
    unit,
    gas,
    source,
    version,
    vintage,
    hasValue: v !== null,
    provenanceComplete: missing.length === 0,
    missingProvenance: missing,
  };
};

/**
 * A global warming potential set, carrying the assessment report it came
 * from. NO VALUES ARE SHIPPED: they differ between reports by enough to move
 * a methane-heavy inventory by a fifth, and an inventory on one report is
 * not comparable with one on another.
 */
export const makeGwpSet = ({ label, values = {} }) => {
  const entries = Object.entries(values)
    .map(([gas, v]) => [gas, num(v, null)])
    .filter(([, v]) => v !== null);
  return {
    label: label || null,
    values: Object.fromEntries(entries),
    declared: !!label && entries.length > 0,
    gases: entries.map(([g]) => g),
    note: 'Global warming potentials differ between IPCC assessment reports. An inventory on one report is not comparable with one on another, so the set is stated on every result.',
  };
};

const gwpFor = (gwpSet, gas) => {
  if (!gwpSet || !gwpSet.values) return null;
  if (gas === 'CO2') return 1;
  const v = gwpSet.values[gas];
  return Number.isFinite(v) ? v : null;
};

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * Combustion CO2 from the carbon in the fuel.
 *
 * Every carbon atom into the burner leaves as CO2, so this is conservation
 * of mass and not an empirical factor at all. A published fuel-based
 * emission factor is a proxy for this same arithmetic, carrying whatever
 * assumptions its author made about the fuel; where the analysis is known,
 * the atom balance is both exact and auditable.
 *
 * Incomplete combustion is handled explicitly rather than ignored: carbon
 * that leaves as methane instead of CO2 is a much worse greenhouse gas per
 * atom, so the split matters and the destruction efficiency is an input.
 */
export const combustionCo2FromCarbon = ({
  fuelKmolPerYear, carbonPerKmolFuel, destructionEfficiencyFraction = 1,
}) => {
  const kmol = num(fuelKmolPerYear);
  const c = num(carbonPerKmolFuel);
  const eta = num(destructionEfficiencyFraction, 1);
  if (!Number.isFinite(kmol) || !Number.isFinite(c)) {
    return { error: 'A fuel quantity and the carbon per kilomole of fuel are required.' };
  }
  if (!(eta > 0) || eta > 1) {
    return { error: 'The destruction efficiency must lie in (0, 1].' };
  }
  const carbonKmol = kmol * c;
  const co2Tonnes = (carbonKmol * eta * MW_CO2) / 1000;
  // Carbon that escaped combustion. Treated as methane, which is the
  // conservative and usual assumption for a flare or a burner, and it is
  // labelled so a user who knows better can override.
  const unburnedCarbonKmol = carbonKmol * (1 - eta);
  const ch4Tonnes = (unburnedCarbonKmol * MW_CH4) / 1000;

  return {
    error: null,
    carbonKmolPerYear: round(carbonKmol, 6),
    co2Tonnes: round(co2Tonnes, 6),
    ch4Tonnes: round(ch4Tonnes, 6),
    destructionEfficiencyFraction: eta,
    method: 'Atom balance: carbon in equals CO2 out. This is conservation of mass, not an empirical factor, so it needs no source document.',
    unburnedNote: eta === 1 ? null
      : 'Carbon that escaped combustion is counted as methane, which is the usual and conservative assumption. Override it if you have measured otherwise.',
  };
};

/**
 * An emission line from an activity and a registered factor.
 *
 * The line carries its factor's provenance forward, so an inventory can say
 * exactly which of its numbers are auditable.
 */
export const emissionLine = ({
  label, scope = SCOPE.ONE, activity, activityUnit, factor, gwpSet,
}) => {
  const a = num(activity, null);
  if (!factor) return { error: 'A registered emission factor is required.' };
  const gwp = gwpFor(gwpSet, factor.gas);
  const tonnesGas = a === null || !factor.hasValue ? null : a * factor.value;
  const tCo2e = tonnesGas === null || gwp === null ? null : tonnesGas * gwp;

  return {
    error: null,
    label,
    scope,
    activity: a,
    activityUnit,
    gas: factor.gas,
    factor: factor.value,
    factorUnit: factor.unit,
    source: factor.source,
    version: factor.version,
    vintage: factor.vintage,
    provenanceComplete: factor.provenanceComplete,
    missingProvenance: factor.missingProvenance,
    gwp,
    tonnesGas: round(tonnesGas, 6),
    tCo2e: round(tCo2e, 6),
    // Each of these is a different kind of gap and they are not merged.
    blockedBy: a === null ? 'no activity data'
      : !factor.hasValue ? 'no factor value'
        : gwp === null ? `no global warming potential for ${factor.gas} in the declared set`
          : null,
  };
};

/**
 * The inventory: every line, totalled by scope, with its own audit status.
 *
 * REPORTABLE IS A SEPARATE QUESTION FROM COMPUTED. An inventory can be
 * complete arithmetic and still not be something to file, because a factor
 * has no source or the GWP set was never declared. Merging the two is how
 * a working number ends up in a regulatory return.
 */
export const buildInventory = ({ lines = [], gwpSet }) => {
  const rows = lines.filter((l) => l && !l.error);
  const scopeTotal = (s) => rows
    .filter((l) => l.scope === s && Number.isFinite(l.tCo2e))
    .reduce((a, l) => a + l.tCo2e, 0);

  const scope1 = scopeTotal(SCOPE.ONE);
  const scope2 = scopeTotal(SCOPE.TWO);
  const blocked = rows.filter((l) => l.blockedBy);
  const unsourced = rows.filter((l) => !l.provenanceComplete && !l.blockedBy);
  const gwpDeclared = !!(gwpSet && gwpSet.declared);

  const reasons = [];
  if (!gwpDeclared) reasons.push('the global warming potential set is not declared');
  if (unsourced.length) reasons.push(`${unsourced.length} factor(s) have no source or version`);
  if (blocked.length) reasons.push(`${blocked.length} line(s) could not be computed`);

  return {
    error: null,
    lines: rows,
    scope1Tonnes: round(scope1, 6),
    scope2Tonnes: round(scope2, 6),
    totalTonnes: round(scope1 + scope2, 6),
    byScope: [
      { scope: SCOPE.ONE, label: 'Scope 1 (direct)', tCo2e: round(scope1, 6) },
      { scope: SCOPE.TWO, label: 'Scope 2 (purchased energy)', tCo2e: round(scope2, 6) },
    ],
    gwpSetLabel: gwpDeclared ? gwpSet.label : null,
    blockedLines: blocked.map((l) => ({ label: l.label, reason: l.blockedBy })),
    unsourcedLines: unsourced.map((l) => ({ label: l.label, missing: l.missingProvenance })),
    // The distinction that matters.
    computed: true,
    reportable: reasons.length === 0,
    notReportableBecause: reasons.length ? reasons : null,
    disclaimer: 'This is a quantitative inventory, not a regulatory compliance register. Obligations, evidence and deadlines belong in the compliance register, and keeping a second copy of them here would create two records that could disagree.',
  };
};

/**
 * Carbon intensity, with the boundary declared.
 *
 * An intensity is meaningless without saying what is on the bottom. Tonnes
 * of CO2e per tonne of crude charged and per tonne of saleable product are
 * different numbers for the same plant, and quoting one against another
 * plant's other is how benchmarks get made up. The basis is required.
 */
export const carbonIntensity = ({
  inventory, denominatorValue, denominatorUnit, boundaryLabel,
}) => {
  if (!inventory || inventory.error) return { error: 'A valid inventory is required.' };
  const d = num(denominatorValue);
  if (!Number.isFinite(d) || d <= 0) return { error: 'A positive denominator is required.' };
  if (!boundaryLabel) {
    return {
      error: 'A boundary must be named. Tonnes per tonne charged and tonnes per tonne of saleable product are different numbers for the same plant, and an intensity without its boundary cannot be compared with anything.',
    };
  }
  return {
    error: null,
    boundaryLabel,
    denominatorValue: d,
    denominatorUnit,
    scope1Intensity: round(inventory.scope1Tonnes / d, 8),
    scope2Intensity: round(inventory.scope2Tonnes / d, 8),
    totalIntensity: round(inventory.totalTonnes / d, 8),
    unit: `tCO2e per ${denominatorUnit}`,
    gwpSetLabel: inventory.gwpSetLabel,
    comparabilityNote: `Comparable only with an intensity on the same boundary (${boundaryLabel}) and the same global warming potential set${inventory.gwpSetLabel ? ` (${inventory.gwpSetLabel})` : ''}.`,
  };
};

// ---------------------------------------------------------------------------
// The marginal abatement cost curve
// ---------------------------------------------------------------------------

/**
 * Cost of abatement for one measure, on an annualised basis.
 *
 * The convention that matters: a NEGATIVE cost per tonne means the measure
 * pays for itself and abates carbon as a side effect. Those sit on the left
 * of the curve and are the ones nobody has done, which is the single most
 * useful thing a marginal abatement cost curve says.
 *
 * Capital is annualised over the measure's life with a capital recovery
 * factor, because comparing a one-off capital cost against a recurring
 * saving is the error that makes every measure look expensive.
 */
export const abatementCost = ({
  label, capitalCost = 0, annualSavings = 0, annualCost = 0,
  tonnesAbatedPerYear, lifeYears, discountRate = 0, actsOn = [],
}) => {
  const t = num(tonnesAbatedPerYear);
  if (!Number.isFinite(t)) return { error: `Measure "${label}" needs an annual abatement.` };
  const capex = num(capitalCost, 0);
  const life = num(lifeYears, null);
  const r = num(discountRate, 0);
  if (capex !== 0 && (life === null || life <= 0)) {
    return { error: `Measure "${label}" has a capital cost, so it needs a life to annualise it over. Comparing a one-off capital cost against a recurring saving makes every measure look expensive.` };
  }
  // Capital recovery factor. At a zero rate this is simple straight-line.
  const crf = life === null ? 0
    : (r === 0 ? 1 / life : (r * (1 + r) ** life) / ((1 + r) ** life - 1));
  const annualisedCapital = capex * crf;
  const netAnnualCost = annualisedCapital + num(annualCost, 0) - num(annualSavings, 0);

  return {
    error: null,
    label,
    tonnesAbatedPerYear: round(t, 6),
    annualisedCapital: round(annualisedCapital, 4),
    netAnnualCost: round(netAnnualCost, 4),
    capitalRecoveryFactor: round(crf, 8),
    costPerTonne: t === 0 ? null : round(netAnnualCost / t, 6),
    paysForItself: t !== 0 && netAnnualCost < 0,
    actsOn,
  };
};

/**
 * The curve: measures sorted cheapest first, as a step chart.
 *
 * WHAT MOST MARGINAL ABATEMENT COST CURVES GET WRONG. Two measures that act
 * on the same emissions cannot both claim the full abatement - insulating a
 * line and then shutting it down do not abate twice - and the usual
 * spreadsheet adds them anyway. This does not silently merge them: it
 * reports which measures INTERACT, and where the claims against one source
 * exceed what that source actually emits it says so.
 *
 * The overlap is not resolved automatically, because resolving it needs an
 * engineering judgement about sequencing that a solver would only guess at.
 * It is surfaced so somebody makes that judgement.
 */
export const abatementCurve = ({ measures = [], sourceEmissions = {}, targetTonnes = null }) => {
  const valid = measures.filter((m) => m && !m.error);
  const sorted = [...valid].sort((a, b) => {
    if (a.costPerTonne === null) return 1;
    if (b.costPerTonne === null) return -1;
    return a.costPerTonne - b.costPerTonne;
  });

  let cumulative = 0;
  const steps = sorted.map((m) => {
    const start = cumulative;
    cumulative += m.tonnesAbatedPerYear;
    return {
      label: m.label,
      costPerTonne: m.costPerTonne,
      tonnesAbatedPerYear: m.tonnesAbatedPerYear,
      cumulativeStartTonnes: round(start, 6),
      cumulativeEndTonnes: round(cumulative, 6),
      paysForItself: m.paysForItself,
      netAnnualCost: m.netAnnualCost,
      actsOn: m.actsOn,
    };
  });

  // Measures touching the same source interact; their abatements are not
  // additive and the curve above is therefore an upper bound.
  const bySource = new Map();
  valid.forEach((m) => (m.actsOn || []).forEach((sid) => {
    bySource.set(sid, [...(bySource.get(sid) || []), m]);
  }));
  const interactions = [];
  const overClaims = [];
  bySource.forEach((ms, sid) => {
    if (ms.length > 1) {
      interactions.push({ sourceId: sid, measures: ms.map((m) => m.label) });
    }
    const claimed = ms.reduce((a, m) => a + m.tonnesAbatedPerYear, 0);
    const emitted = num(sourceEmissions[sid], null);
    if (emitted !== null && claimed > emitted + 1e-9) {
      overClaims.push({
        sourceId: sid, claimedTonnes: round(claimed, 6), emittedTonnes: round(emitted, 6),
        measures: ms.map((m) => m.label),
      });
    }
  });

  const negative = sorted.filter((m) => m.paysForItself);
  const target = num(targetTonnes, null);

  return {
    error: null,
    steps,
    totalAbatementTonnes: round(cumulative, 6),
    // The left-hand side of the curve: measures that save money and abate
    // carbon as a side effect, and are usually still undone.
    paysForItselfTonnes: round(negative.reduce((a, m) => a + m.tonnesAbatedPerYear, 0), 6),
    paysForItselfMeasures: negative.map((m) => m.label),
    netAnnualCostOfAll: round(valid.reduce((a, m) => a + m.netAnnualCost, 0), 4),
    weightedAverageCostPerTonne: cumulative === 0 ? null
      : round(valid.reduce((a, m) => a + m.netAnnualCost, 0) / cumulative, 6),
    interactions,
    overClaims,
    additive: interactions.length === 0,
    interactionNote: interactions.length
      ? 'Measures listed here act on the same source, so their abatements are NOT additive and the cumulative curve is an upper bound. Resolving the overlap needs an engineering judgement about sequencing, which is why it is surfaced rather than solved.'
      : null,
    targetTonnes: target,
    meetsTarget: target === null ? null : cumulative >= target,
    // Naming the residual is the point. A wedge labelled "further measures"
    // is not a plan.
    residualToTargetTonnes: target === null ? null : round(Math.max(0, target - cumulative), 6),
  };
};

/**
 * A year-by-year trajectory from measures that start in different years.
 *
 * The residual gap against the target is NAMED as unabated with no measure
 * identified, rather than drawn as a wedge labelled "further measures". A
 * wedge with no measure behind it is not a plan, and treating it as one is
 * how decarbonisation roadmaps stop meaning anything.
 */
export const decarbonisationPath = ({
  baselineTonnes, measures = [], startYear, endYear, targetByYear = {},
}) => {
  const base = num(baselineTonnes);
  const y0 = num(startYear);
  const y1 = num(endYear);
  if (!Number.isFinite(base) || !Number.isFinite(y0) || !Number.isFinite(y1) || y1 < y0) {
    return { error: 'A baseline and a valid year range are required.' };
  }
  const rows = [];
  for (let y = y0; y <= y1; y += 1) {
    const live = measures.filter((m) => !m.error && num(m.startYear, y1 + 1) <= y);
    const abated = live.reduce((a, m) => a + num(m.tonnesAbatedPerYear, 0), 0);
    const target = num(targetByYear[y], null);
    const emissions = base - abated;
    rows.push({
      year: y,
      baselineTonnes: round(base, 4),
      abatedTonnes: round(abated, 4),
      emissionsTonnes: round(emissions, 4),
      targetTonnes: target,
      // Positive means the plan does not reach the target that year, and
      // there is no identified measure for the difference.
      unabatedGapTonnes: target === null ? null : round(Math.max(0, emissions - target), 4),
      measuresLive: live.map((m) => m.label),
    });
  }
  const gaps = rows.filter((r) => r.unabatedGapTonnes !== null && r.unabatedGapTonnes > 1e-9);
  return {
    error: null,
    rows,
    firstShortfallYear: gaps.length ? gaps[0].year : null,
    finalGapTonnes: rows.length ? rows[rows.length - 1].unabatedGapTonnes : null,
    gapNote: gaps.length
      ? 'The gap is reported as unabated with no measure identified. It is deliberately not drawn as a wedge of future measures, because a wedge with nothing behind it is not a plan.'
      : null,
  };
};
