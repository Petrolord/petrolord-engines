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
 */
export const INHIBITORS = [
  {
    id: 'methanol',
    label: 'Methanol',
    molecularWeight: 32.04,
    k: 2335,
    densityLbGal: 6.6,
    nielsenBucklin: true,
    note: 'The most effective per pound, and the cheapest to buy. It is lost to the gas and the condensate, which is what makes recovery hard and is usually the reason a project chooses glycol instead.',
  },
  {
    id: 'meg',
    label: 'Monoethylene glycol (MEG)',
    molecularWeight: 62.07,
    k: 2335,
    densityLbGal: 9.3,
    nielsenBucklin: false,
    note: 'Stays in the water phase, so it can be recovered and recirculated. Heavier per degree of depression than methanol, which is a bigger line and a bigger pump.',
  },
  {
    id: 'deg',
    label: 'Diethylene glycol (DEG)',
    molecularWeight: 106.12,
    k: 2335,
    densityLbGal: 9.3,
    nielsenBucklin: false,
    note: 'Less effective per pound than MEG because of its higher molecular weight; chosen for reasons other than hydrate depression.',
  },
  {
    id: 'teg',
    label: 'Triethylene glycol (TEG)',
    molecularWeight: 150.17,
    k: 2335,
    densityLbGal: 9.4,
    nielsenBucklin: false,
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
 * Both relations at one concentration, with the disagreement between
 * them reported rather than resolved.
 *
 * returns { hammerschmidtF, nielsenBucklinF, recommendedF, basis,
 *           reliable, spreadF, note }
 */
export const depression = ({ weightPct, inhibitorId = 'methanol' }) => {
  const inh = inhibitor(inhibitorId);
  const ham = hammerschmidtDepression({
    weightPct, molecularWeight: inh.molecularWeight, k: inh.k,
  });
  const nb = inh.nielsenBucklin
    ? nielsenBucklinDepression({ weightPct, molecularWeight: inh.molecularWeight })
    : null;
  const reliable = Number(weightPct) <= HAMMERSCHMIDT_RELIABLE_WT_PCT;

  // Past the Hammerschmidt band, prefer Nielsen-Bucklin where it
  // applies. Where it does not -- the glycols -- say so rather than
  // quietly returning a number outside its own validity.
  let recommendedF = ham;
  let basis = 'hammerschmidt';
  let note = null;
  if (!reliable) {
    if (nb != null && Number.isFinite(nb)) {
      recommendedF = nb;
      basis = 'nielsenBucklin';
      note = `Above ${HAMMERSCHMIDT_RELIABLE_WT_PCT} weight percent Hammerschmidt over-predicts, so Nielsen-Bucklin is used here. The two are shown together because the gap between them is the honest measure of how far this is being pushed.`;
    } else {
      note = `Above ${HAMMERSCHMIDT_RELIABLE_WT_PCT} weight percent Hammerschmidt over-predicts and Nielsen-Bucklin was developed for methanol, not for ${inh.label.toLowerCase()}. Treat this depression as optimistic and confirm it against a flash.`;
    }
  }
  return {
    ok: Number.isFinite(ham),
    inhibitor: inh,
    weightPct: Number(weightPct),
    hammerschmidtF: ham,
    nielsenBucklinF: nb,
    recommendedF,
    basis,
    reliable,
    spreadF: nb != null && Number.isFinite(nb) ? Math.abs(ham - nb) : null,
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
  if (!(waterRateBpd >= 0)) return { ok: false, error: 'A water rate is needed.' };
  if (!(w > 0) || !(w < 100)) return { ok: false, error: 'The target concentration has to be between 0 and 100 weight percent.' };
  if (!(lean > 0) || !(lean > w)) {
    return {
      ok: false,
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
 * `subcoolingF` is how far INSIDE the hydrate region the fluid sits --
 * hydrate temperature less fluid temperature. A negative or zero value
 * means the fluid is already outside and nothing is needed, which is a
 * real answer and is returned as one rather than as a rate of zero
 * dressed up as a design.
 */
export const inhibitionRequirement = ({
  subcoolingF, safetyMarginF = 0, waterRateBpd, inhibitorId = 'methanol',
  leanWtPct = 100, waterDensityLbGal, maxWtPct = MAX_PRACTICAL_WT_PCT,
}) => {
  const need = Number(subcoolingF) + Number(safetyMarginF);
  const inh = inhibitor(inhibitorId);
  if (!(need > 0)) {
    return {
      ok: true,
      required: false,
      neededDepressionF: need,
      note: `The fluid sits outside the hydrate region by ${Math.abs(Number(subcoolingF)).toFixed(1)} F. No inhibitor is needed to keep it there.`,
    };
  }
  const weightPct = weightPctForDepression({
    depressionF: need, molecularWeight: inh.molecularWeight, k: inh.k,
  });
  if (!(weightPct > 0) || !(weightPct < 100)) {
    return {
      ok: false,
      required: true,
      neededDepressionF: need,
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
      error: `Killing ${need.toFixed(1)} F of subcooling would take ${weightPct.toFixed(1)} weight percent ${inh.label.toLowerCase()} in the water, past the ${maxWtPct} percent anything is actually run at. This much subcooling is a thermal or a dosing-strategy problem -- insulation, heating, or displacing the line -- not an inhibitor-concentration one.`,
    };
  }
  const check = depression({ weightPct, inhibitorId });
  const rate = injectionRate({
    waterRateBpd, weightPct, inhibitorId, leanWtPct, waterDensityLbGal,
  });
  return {
    ok: rate.ok,
    required: true,
    neededDepressionF: need,
    weightPct,
    depressionCheck: check,
    rate,
    error: rate.ok ? null : rate.error,
  };
};
