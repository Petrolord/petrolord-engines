/**
 * Thermodynamic hydrate inhibition (Production P10).
 *
 * Once you know where the fluid sits against a hydrate boundary, the
 * next question is what to inject to move the boundary out of the way,
 * and how much. That is this module.
 *
 * WHAT IT DOES AND DOES NOT DO. It computes the DEPRESSION an inhibitor
 * gives -- how far it shifts the hydrate temperature -- and the rate
 * needed to hold a concentration in the produced water. It does NOT
 * compute where the hydrate boundary is in the first place: that is a
 * fluid property from a lab or a compositional flash, and it belongs to
 * whoever owns the fluid.
 *
 * TWO RELATIONS, AND WHERE EACH ONE STOPS.
 *
 *   Hammerschmidt:  dT = K W / (M (100 - W))
 *
 * with W the inhibitor weight percent in the AQUEOUS phase, M its
 * molecular weight and K a single constant. It is the equation every
 * hand calculation uses and it is genuinely good to about 20 to 25
 * weight percent. Past that it over-predicts, and past about 30 it
 * over-predicts badly, because it is a dilute-solution result being
 * pushed where the assumption behind it has gone.
 *
 *   Nielsen-Bucklin:  dT = -129.6 ln(x_water)
 *
 * in mole fraction rather than weight percent, which is the right
 * variable for a freezing-point depression, and which is why it holds
 * at the high methanol concentrations Hammerschmidt does not. It was
 * developed for methanol.
 *
 * The two agree closely at moderate concentration and separate as it
 * rises. This module computes BOTH wherever both apply and reports
 * them side by side rather than choosing silently, because which one an
 * engineer trusts at 35 weight percent is a judgement and the
 * disagreement is information.
 *
 * WHAT IS NOT MODELLED. Salt in the produced water inhibits too, and
 * ignoring it over-injects; but the depression from salinity depends on
 * the ions present and is a flash calculation, not a constant. It is
 * left out and said to be left out rather than approximated.
 *
 * Field units: temperature degF, weight percent, rate bbl/d.
 */

/**
 * The inhibitors, with the molecular weights the Hammerschmidt form
 * needs and their liquid densities.
 *
 * K is carried per inhibitor rather than as one global constant.
 * Hammerschmidt's own value of 2335 is used throughout by most
 * references, with the molecular weight doing the work of telling the
 * fluids apart; some texts raise it for the glycols. Keeping it per
 * fluid means a user with a different convention can match their own
 * source instead of arguing with a hard-coded number.
 *
 * `nielsenBucklinDevelopedFor` says which fluid the Nielsen-Bucklin
 * relation was developed on. It USED TO SUPPRESS THE CALCULATION for
 * every other fluid, which threw away the one number that says how far
 * Hammerschmidt is being pushed; Nielsen-Bucklin is a function of the
 * water mole fraction and nothing else, so it returns a perfectly
 * well defined figure for a glycol whether or not it was fitted on
 * one. It is now computed and reported for every fluid, and this field
 * only decides which relation the recommendation is taken FROM.
 */
const show = (v) => (typeof v === 'string' ? `"${v}"` : String(v));

export const INHIBITORS = [
  {
    id: 'methanol',
    label: 'Methanol',
    molecularWeight: 32.04,
    k: 2335,
    densityLbGal: 6.6,
    nielsenBucklinDevelopedFor: true,
    note: 'The most effective per pound, and the cheapest to buy. It is lost to the gas and the condensate, which is what makes recovery hard and is usually the reason a project chooses glycol instead.',
  },
  {
    id: 'meg',
    label: 'Monoethylene glycol (MEG)',
    molecularWeight: 62.07,
    k: 2335,
    densityLbGal: 9.3,
    nielsenBucklinDevelopedFor: false,
    note: 'Stays in the water phase, so it can be recovered and recirculated. Heavier per degree of depression than methanol, which is a bigger line and a bigger pump.',
  },
  {
    id: 'deg',
    label: 'Diethylene glycol (DEG)',
    molecularWeight: 106.12,
    k: 2335,
    densityLbGal: 9.3,
    nielsenBucklinDevelopedFor: false,
    note: 'Less effective per pound than MEG because of its higher molecular weight; chosen for reasons other than hydrate depression.',
  },
  {
    id: 'teg',
    label: 'Triethylene glycol (TEG)',
    molecularWeight: 150.17,
    k: 2335,
    densityLbGal: 9.4,
    nielsenBucklinDevelopedFor: false,
    note: 'A dehydration fluid rather than a hydrate inhibitor. Its molecular weight makes it poor at this job and it is listed for completeness.',
  },
];

export const inhibitor = (id) =>
  INHIBITORS.find((x) => x.id === id) || INHIBITORS[0];

/** Where Hammerschmidt stops being trustworthy. */
export const HAMMERSCHMIDT_RELIABLE_WT_PCT = 25;

/**
 * The practical ceiling on inhibitor in the aqueous phase.
 *
 * The Hammerschmidt inverse is asymptotic to 100 percent, so it will
 * happily return 96 weight percent for a subcooling nothing can
 * actually kill. That is arithmetically fine and physically absurd:
 * past roughly this concentration the aqueous phase is barely water,
 * the viscosity and the hydrate behaviour of the inhibitor itself
 * start to matter, and no field runs there. Deep subcooling is solved
 * with insulation, heating or a dead-oil displacement, not by pushing
 * a concentration further. The ceiling is a constant so a user with a
 * reason can move it.
 */
export const MAX_PRACTICAL_WT_PCT = 70;

/**
 * How far short of the needed depression counts as short (item 53).
 * The concentration is inverted through the binding relation, so the
 * delivered depression lands on the requirement to rounding; this is
 * that rounding and nothing more.
 */
export const DEPRESSION_TOL_F = 1e-9;
export const NIELSEN_BUCKLIN_CONSTANT_F = 129.6;
export const WATER_MOLECULAR_WEIGHT = 18.015;

/**
 * Hammerschmidt depression, degF, for a weight percent in the aqueous
 * phase.
 */
export const hammerschmidtDepression = ({ weightPct, molecularWeight, k = 2335 }) => {
  const w = Number(weightPct);
  if (!(w >= 0) || !(w < 100) || !(molecularWeight > 0)) return NaN;
  return (k * w) / (molecularWeight * (100 - w));
};

/** The inverse: the weight percent that gives a wanted depression. */
export const weightPctForDepression = ({ depressionF, molecularWeight, k = 2335 }) => {
  const d = Number(depressionF);
  if (!(d > 0) || !(molecularWeight > 0)) return NaN;
  // dT = K W / (M (100 - W))  ->  W = 100 dT M / (K + dT M)
  return (100 * d * molecularWeight) / (k + d * molecularWeight);
};

/** Weight percent to mole fraction of inhibitor in the aqueous phase. */
export const weightPctToMoleFraction = ({ weightPct, molecularWeight }) => {
  const w = Number(weightPct);
  if (!(w >= 0) || !(w < 100) || !(molecularWeight > 0)) return NaN;
  const nInhib = w / molecularWeight;
  const nWater = (100 - w) / WATER_MOLECULAR_WEIGHT;
  return nInhib / (nInhib + nWater);
};

/**
 * Nielsen-Bucklin depression, degF. Written in the mole fraction of
 * WATER, which is the variable a freezing-point depression is actually
 * a function of, and is why it survives where Hammerschmidt does not.
 */
export const nielsenBucklinDepression = ({ weightPct, molecularWeight }) => {
  const x = weightPctToMoleFraction({ weightPct, molecularWeight });
  if (!Number.isFinite(x) || x >= 1) return NaN;
  return -NIELSEN_BUCKLIN_CONSTANT_F * Math.log(1 - x);
};

/**
 * The inverse of `nielsenBucklinDepression`: the weight percent that
 * gives a wanted depression.
 *
 *   dT = -C ln(1 - x)  ->  x = 1 - exp(-dT / C)
 *
 * and the mole fraction is turned back into a weight percent by the
 * same aqueous-phase balance `weightPctToMoleFraction` uses. It exists
 * because the concentration a design needs has to be inverted through
 * the relation the design is going to be JUDGED on, and above 25 weight
 * percent that is this one. Item 48.
 */
export const weightPctForDepressionNielsenBucklin = ({ depressionF, molecularWeight }) => {
  const d = Number(depressionF);
  if (!(d > 0) || !(molecularWeight > 0)) return NaN;
  const x = 1 - Math.exp(-d / NIELSEN_BUCKLIN_CONSTANT_F);
  if (!(x > 0) || !(x < 1)) return NaN;
  // x = (w/M) / (w/M + (100-w)/Mw)  ->  w = 100 x M / (x M + (1-x) Mw)
  return (100 * x * molecularWeight)
    / (x * molecularWeight + (1 - x) * WATER_MOLECULAR_WEIGHT);
};

/**
 * Both relations at one concentration, with the disagreement between
 * them reported rather than resolved.
 *
 * BOTH RELATIONS ARE COMPUTED FOR EVERY FLUID. Nielsen-Bucklin used to
 * be suppressed for the glycols, which left `nielsenBucklinF` and
 * `spreadF` null for three of the four inhibitors and removed the only
 * quantity that says how far past its band Hammerschmidt is being
 * pushed. The relation is a function of the water mole fraction, so it
 * returns the same well defined number for a glycol as for methanol,
 * and it is now reported for all of them. Which fluid it was FITTED on
 * still decides which relation the recommendation is taken from.
 *
 * `withinHammerschmidtRange` is a statement about CONCENTRATION and
 * nothing else: it says the weight percent is inside the band where
 * Hammerschmidt is usually trusted. It was called `reliable`, which
 * read as a claim about the accuracy of the answer, and it never
 * measured that. `spreadF`, the gap between the two relations, is the
 * quantity a caller can put a real threshold on, and it comes back
 * beside it for every fluid.
 *
 * returns { hammerschmidtF, nielsenBucklinF, recommendedF, basis,
 *           withinHammerschmidtRange, spreadF, note }
 */
export const depression = ({ weightPct, inhibitorId = 'methanol' }) => {
  const inh = inhibitor(inhibitorId);
  const ham = hammerschmidtDepression({
    weightPct, molecularWeight: inh.molecularWeight, k: inh.k,
  });
  const nb = nielsenBucklinDepression({
    weightPct, molecularWeight: inh.molecularWeight,
  });
  const withinHammerschmidtRange =
    Number(weightPct) <= HAMMERSCHMIDT_RELIABLE_WT_PCT;

  // ITEM 59. THE RECOMMENDATION IS THE LOWER OF THE TWO, AT EVERY
  // CONCENTRATION. It used to be Hammerschmidt below 25 weight percent
  // and Nielsen-Bucklin above it, and only for methanol, which put a
  // step in the recommended depression at 25 percent and made the
  // recommendation depend on which fluid was asked about rather than on
  // what the two relations say. A design is a promise about the
  // depression that will actually be there, so the conservative reading
  // is the one to design on, and where they disagree that is the lower.
  //
  // Below about 20 weight percent the two are within a percent of each
  // other and the choice hardly matters; above it Hammerschmidt runs
  // away and the lower reading is Nielsen-Bucklin every time. `basis`
  // names which relation the number came from and `spreadF` is the gap,
  // so nothing is hidden by the choice.
  let recommendedF = ham;
  let basis = 'hammerschmidt';
  let note = null;
  if (Number.isFinite(ham) && Number.isFinite(nb) && nb < ham) {
    recommendedF = nb;
    basis = 'nielsenBucklin';
  }
  if (!withinHammerschmidtRange) {
    note = `Above ${HAMMERSCHMIDT_RELIABLE_WT_PCT} weight percent Hammerschmidt over-predicts, so the recommended depression here is the lower of the two relations, which is ${basis === 'nielsenBucklin' ? 'Nielsen-Bucklin' : 'Hammerschmidt'}. Nielsen-Bucklin was developed on methanol data and is written in the mole fraction of water, so it carries across fluids better than Hammerschmidt does, but both are correlations: confirm a deep design against a flash.`;
  }
  return {
    ok: Number.isFinite(ham),
    inhibitor: inh,
    weightPct: Number(weightPct),
    hammerschmidtF: ham,
    nielsenBucklinF: nb,
    recommendedF,
    basis,
    withinHammerschmidtRange,
    spreadF: Number.isFinite(ham) && Number.isFinite(nb)
      ? Math.abs(ham - nb)
      : null,
    note,
  };
};

/**
 * The injection rate that holds a concentration in the produced water.
 *
 * A mass balance on the aqueous phase and nothing more: to make the
 * water W percent inhibitor by weight, the inhibitor mass has to be
 * W/(100-W) of the water mass.
 *
 * The LEAN inhibitor is rarely pure -- recovered MEG comes back at 80
 * to 90 percent -- and injecting as if it were is a standard way to
 * under-dose, so the lean concentration is an explicit input.
 *
 * returns { ok, rateBpd, rateGpd, massLbDay, error }
 */
export const injectionRate = ({
  waterRateBpd, weightPct, inhibitorId = 'methanol', leanWtPct = 100,
  waterDensityLbGal = 8.34,
}) => {
  const inh = inhibitor(inhibitorId);
  const w = Number(weightPct);
  const lean = Number(leanWtPct);
  if (!(waterRateBpd >= 0)) {
    return {
      ok: false,
      code: 'waterRateMissing',
      error: `A water rate is needed. It was ${show(waterRateBpd)} bbl/d.`,
    };
  }
  if (!(w > 0) || !(w < 100)) {
    return {
      ok: false,
      code: 'concentrationOutOfRange',
      error: `The target concentration has to be between 0 and 100 weight percent. It was ${show(weightPct)}.`,
    };
  }
  if (!(lean > 0) || !(lean > w)) {
    return {
      ok: false,
      code: 'leanTooWeak',
      error: `The lean inhibitor is ${lean} weight percent, which is not stronger than the ${w} percent it has to produce in the water. It cannot get there however much is injected.`,
    };
  }
  const waterLbDay = waterRateBpd * 42 * waterDensityLbGal;
  // Pure inhibitor mass for the target, then grossed up for the water
  // the lean stream brings with it.
  const pureLbDay = (waterLbDay * w) / (100 - w);
  const streamLbDay = pureLbDay * (100 / lean);
  const streamDensity = (inh.densityLbGal * lean + waterDensityLbGal * (100 - lean)) / 100;
  const rateGpd = streamLbDay / streamDensity;
  return {
    ok: true,
    rateBpd: rateGpd / 42,
    rateGpd,
    massLbDay: streamLbDay,
    pureMassLbDay: pureLbDay,
    streamDensityLbGal: streamDensity,
    inhibitor: inh,
  };
};

/**
 * The whole inhibition question in one call: how much subcooling has
 * to be killed, what concentration does it, and what rate holds that.
 *
 * `subcoolingF` is how far INSIDE the hydrate region the fluid sits:
 * hydrate temperature less fluid temperature. A negative or zero value
 * means the fluid is already outside and nothing is needed, which is a
 * real answer and is returned as one rather than as a rate of zero
 * dressed up as a design.
 *
 * A MISSING SUBCOOLING IS NOT A ZERO SUBCOOLING. The two questions,
 * can the requirement be worked out, and does it come out positive,
 * are asked separately and in that order. They used to be one test,
 * `!(need > 0)`, and `!(NaN > 0)` is true, so a call with no subcooling
 * at all answered "No inhibitor is needed to keep it there" with ok
 * true and printed the literal string "NaN F" to the user inside it.
 * That is the answer a hydrate plug is made of.
 */
export const inhibitionRequirement = ({
  subcoolingF, safetyMarginF = 0, waterRateBpd, inhibitorId = 'methanol',
  leanWtPct = 100, waterDensityLbGal, maxWtPct = MAX_PRACTICAL_WT_PCT,
}) => {
  const inh = inhibitor(inhibitorId);
  if (!Number.isFinite(subcoolingF) || !Number.isFinite(safetyMarginF)) {
    return {
      ok: false,
      code: 'subcoolingNotNumeric',
      error: `How much depression is needed cannot be worked out, so no verdict is given on whether an inhibitor is needed. The subcooling was ${show(subcoolingF)} and the safety margin was ${show(safetyMarginF)}, and both have to be numbers in degF.`,
    };
  }
  const need = subcoolingF + safetyMarginF;
  if (!(need > 0)) {
    return {
      ok: true,
      required: false,
      neededDepressionF: need,
      note: `The fluid sits outside the hydrate region by ${Math.abs(subcoolingF).toFixed(1)} F. No inhibitor is needed to keep it there.`,
    };
  }
  // ITEM 48. THE CONCENTRATION IS INVERTED THROUGH BOTH RELATIONS AND
  // THE BINDING ONE IS TAKEN. Inverting through Hammerschmidt alone
  // returns the concentration that would give this depression IF
  // Hammerschmidt were right, and above 25 weight percent it is not:
  // the design then gets judged, one line later, on the lower of the
  // two relations and comes up short. The larger of the two inverses is
  // the concentration that delivers the depression on the relation the
  // design will be measured by, and the practical ceiling is applied to
  // THAT number, which is what "measured in Nielsen-Bucklin
  // coordinates" means.
  const wtHammerschmidt = weightPctForDepression({
    depressionF: need, molecularWeight: inh.molecularWeight, k: inh.k,
  });
  const wtNielsenBucklin = weightPctForDepressionNielsenBucklin({
    depressionF: need, molecularWeight: inh.molecularWeight,
  });
  const weightPct = Number.isFinite(wtNielsenBucklin)
    ? Math.max(wtHammerschmidt, wtNielsenBucklin)
    : wtHammerschmidt;
  const weightPctBasis = Number.isFinite(wtNielsenBucklin)
    && wtNielsenBucklin > wtHammerschmidt ? 'nielsenBucklin' : 'hammerschmidt';
  if (!(weightPct > 0) || !(weightPct < 100)) {
    return {
      ok: false,
      required: true,
      neededDepressionF: need,
      code: 'depressionUnreachable',
      error: `No concentration of ${inh.label.toLowerCase()} gives ${need.toFixed(1)} F of depression.`,
    };
  }
  // The concentration prints at one decimal because the sentence names
  // `maxWtPct` beside it: at whole percent a required 70.3 weight
  // percent read "70 weight percent ... past the 70 percent anything is
  // actually run at". One decimal narrows that to the 0.05 above the
  // limit rather than closing it.
  if (weightPct > maxWtPct) {
    return {
      ok: false,
      required: true,
      neededDepressionF: need,
      weightPct,
      weightPctBasis,
      weightPctByHammerschmidt: wtHammerschmidt,
      weightPctByNielsenBucklin: wtNielsenBucklin,
      code: 'pastPracticalCeiling',
      error: `Killing ${need.toFixed(1)} F of subcooling would take ${weightPct.toFixed(1)} weight percent ${inh.label.toLowerCase()} in the water, past the ${maxWtPct} percent anything is actually run at. This much subcooling is a thermal or a dosing-strategy problem: insulation, heating, or displacing the line. It is not an inhibitor-concentration one.`,
    };
  }
  const check = depression({ weightPct, inhibitorId });
  // ITEM 53. The ceiling above refuses on CONCENTRATION and never on
  // SHORTFALL: a concentration inside the ceiling whose recommended
  // depression is still below what was asked for came back as a design,
  // with the shortfall sitting inside `depressionCheck` where nothing
  // read it. It is the whole question this function was asked.
  // Whether it CAN fire, stated so nobody reads its silence as a pass:
  // with the concentration inverted through the binding relation above,
  // the delivered depression lands on the requirement exactly, so for
  // the four inhibitors this module carries this branch is unreachable
  // by construction and the invariant is gated as an invariant. It stays
  // because it is the door: it fires the moment a concentration reaches
  // here that was not inverted through the relation the design is judged
  // on, which is exactly how the defect got in.
  if (Number.isFinite(check.recommendedF) && check.recommendedF < need - DEPRESSION_TOL_F) {
    return {
      ok: false,
      required: true,
      neededDepressionF: need,
      weightPct,
      weightPctBasis,
      weightPctByHammerschmidt: wtHammerschmidt,
      weightPctByNielsenBucklin: wtNielsenBucklin,
      depressionCheck: check,
      code: 'insufficientDepression',
      error: `At ${weightPct.toFixed(1)} weight percent ${inh.label.toLowerCase()} the depression this design can be relied on for is ${check.recommendedF.toFixed(1)} F, against the ${need.toFixed(1)} F it needs. The concentration is inside the practical ceiling, so nothing here refuses it on concentration, but it does not deliver the depression and it is refused on that.`,
    };
  }
  const rate = injectionRate({
    waterRateBpd, weightPct, inhibitorId, leanWtPct, waterDensityLbGal,
  });
  return {
    ok: rate.ok,
    required: true,
    neededDepressionF: need,
    weightPct,
    // which relation the concentration was inverted through, and both
    // inverses, so a reader can see the size of the choice
    weightPctBasis,
    weightPctByHammerschmidt: wtHammerschmidt,
    weightPctByNielsenBucklin: wtNielsenBucklin,
    depressionCheck: check,
    rate,
    // A refusal that comes up from the rate keeps the rate's own code,
    // so a caller reading the composed answer sees the same code the
    // inner call refused with rather than a bare message.
    code: rate.ok ? undefined : rate.code,
    error: rate.ok ? null : rate.error,
  };
};
