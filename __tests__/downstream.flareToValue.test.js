/**
 * Flare gas to value (DS10).
 *
 * The centre of gravity here is the abatement: the tests that matter most
 * are the ones proving the module will NOT hand back a number until the
 * counterfactual is declared, because claiming a flare's gross emission as
 * abatement is what nearly every business case in this field does.
 *
 * Everything else is identities and conservation: carbon in the gas, moles
 * in a thousand cubic feet, screening states that distinguish "unset limit"
 * from "satisfied limit".
 */
import {
  characteriseGas, screenRoute, routeEconomics, abatement, creditSensitivity,
  compareRoutes, GAS_COMPONENT_REFERENCE, GAS_REFERENCE_NOTE,
  ROUTE_TEMPLATES, ROUTE_TEMPLATE_NOTE, SCF_PER_LBMOL, LB_PER_KG,
} from '../engines/downstream/flareToValue.js';

const ref = (code) => GAS_COMPONENT_REFERENCE.find((c) => c.code === code);
const comp = (code, moleFraction) => {
  const r = ref(code);
  return { ...r, moleFraction, ghvBtuScf: r.typicalGhvBtuScf };
};

const richGas = () => characteriseGas({
  components: [
    comp('C1', 0.78), comp('C2', 0.09), comp('C3', 0.05), comp('IC4', 0.01),
    comp('NC4', 0.02), comp('C5', 0.01), comp('N2', 0.02), comp('CO2', 0.02),
  ],
});
const leanGas = () => characteriseGas({
  components: [comp('C1', 0.94), comp('C2', 0.02), comp('C3', 0.01), comp('N2', 0.02), comp('CO2', 0.01)],
});

describe('characterising the gas', () => {
  it('mixes heating value on moles and normalises the composition', () => {
    const g = richGas();
    expect(g.error).toBeNull();
    expect(g.normalised.reduce((s, r) => s + r.moleFraction, 0)).toBeCloseTo(1, 9);
    expect(g.ghvBtuScf).toBeCloseTo(
      0.78 * 1010 + 0.09 * 1770 + 0.05 * 2516 + 0.01 * 3252 + 0.02 * 3263 + 0.01 * 4010, 4,
    );
  });

  it('counts carbon atom by atom, inerts included', () => {
    const g = richGas();
    // CO2 has a carbon and it is still a carbon: it leaves the flare as CO2
    // whether it was burned or not.
    expect(g.carbonPerMol).toBeCloseTo(
      0.78 * 1 + 0.09 * 2 + 0.05 * 3 + 0.01 * 4 + 0.02 * 4 + 0.01 * 5 + 0.02 * 0 + 0.02 * 1, 8,
    );
  });

  it('tracks inerts separately, because they are what kills several routes', () => {
    const g = richGas();
    expect(g.inertMoleFraction).toBeCloseTo(0.04, 9);
    expect(g.co2MoleFraction).toBeCloseTo(0.02, 9);
    // CO2 is an inert AND is separately reported, because a liquefaction
    // train cares about CO2 specifically rather than about inerts.
    expect(g.co2MoleFraction).toBeLessThan(g.inertMoleFraction);
  });

  it('derives the liquids content from the composition, not from a table', () => {
    const g = richGas();
    // gal/Mscf = (1000/379.49) lbmol x y x MW / (lb per gallon). Nothing else.
    const lbmol = 1000 / SCF_PER_LBMOL;
    const expected = [['C3', 0.05], ['IC4', 0.01], ['NC4', 0.02], ['C5', 0.01]]
      .reduce((s, [c, y]) => s + (lbmol * y * ref(c).molarMassLbLbmol) / ref(c).liquidDensityLbGal, 0);
    expect(g.gpmC3Plus).toBeCloseTo(expected, 6);
    expect(g.gpmBasis).toMatch(/Derived from the composition/i);
  });

  it('C2+ liquids exceed C3+ by exactly the ethane', () => {
    const g = richGas();
    const lbmol = 1000 / SCF_PER_LBMOL;
    const ethane = (lbmol * 0.09 * ref('C2').molarMassLbLbmol) / ref('C2').liquidDensityLbGal;
    expect(g.gpmC2Plus - g.gpmC3Plus).toBeCloseTo(ethane, 6);
  });

  it('calls a lean gas lean and a rich gas rich', () => {
    expect(richGas().gpmC3Plus).toBeGreaterThan(leanGas().gpmC3Plus);
    expect(leanGas().richness).toBe('lean');
    expect(richGas().richness).toBe('rich');
  });

  it('makes a heating value missing if any component lacks one', () => {
    const g = characteriseGas({
      components: [comp('C1', 0.9), { ...ref('C2'), moleFraction: 0.1, ghvBtuScf: null }],
    });
    expect(g.ghvBtuScf).toBeNull();
    expect(g.ghvNote).toMatch(/missing, not partial/i);
  });

  it('names a component whose liquid density it does not have', () => {
    const g = characteriseGas({
      components: [comp('C1', 0.9), { ...ref('C3'), moleFraction: 0.1, liquidDensityLbGal: null }],
    });
    expect(g.missingLiquidDensity).toContain('C3');
  });

  it('refuses a composition it cannot use', () => {
    expect(characteriseGas({ components: [] }).error).toBeTruthy();
    expect(characteriseGas({ components: [{ ...ref('C1'), moleFraction: null }] }).error)
      .toMatch(/mole fraction/i);
  });
});

describe('screening', () => {
  const lng = () => ROUTE_TEMPLATES.find((r) => r.id === 'mini_lng');
  const withLimits = (limits) => ({
    ...lng(),
    requirements: lng().requirements.map((r) => ({ ...r, limit: limits[r.key] ?? null })),
  });

  it('distinguishes an unset limit from a satisfied one', () => {
    // An unset limit is not a passed check, and treating it as one is how a
    // route gets through screening nobody actually did.
    const s = screenRoute({ route: lng(), gas: richGas(), volumeMMscfd: 10 });
    expect(s.verdict).toBe('not fully screened');
    expect(s.uncheckedRequirements.length).toBe(lng().requirements.length);
    expect(s.checks.every((c) => c.status === 'unchecked')).toBe(true);
  });

  it('passes a gas that meets every limit', () => {
    const s = screenRoute({
      route: withLimits({ minVolumeMMscfd: 5, maxCo2Fraction: 0.05, maxInertFraction: 0.1 }),
      gas: richGas(), volumeMMscfd: 10,
    });
    expect(s.verdict).toBe('passes');
    expect(s.failures).toHaveLength(0);
  });

  it('names WHICH requirement failed and by how much', () => {
    // "Not feasible" is not an answer anybody can act on.
    const s = screenRoute({
      route: withLimits({ minVolumeMMscfd: 25, maxCo2Fraction: 0.005, maxInertFraction: 0.1 }),
      gas: richGas(), volumeMMscfd: 10,
    });
    expect(s.verdict).toBe('fails');
    expect(s.failures.map((f) => f.requirement)).toEqual(
      expect.arrayContaining(['Minimum volume', 'Maximum CO2 before treatment']),
    );
    const vol = s.failures.find((f) => f.requirement === 'Minimum volume');
    expect(vol.actual).toBeCloseTo(10, 6);
    expect(vol.limit).toBe(25);
    expect(vol.shortfall).toBeCloseTo(15, 6);
  });

  it('applies min and max limits in the right directions', () => {
    const route = withLimits({ minVolumeMMscfd: 5, maxInertFraction: 0.01, maxCo2Fraction: 0.5 });
    const s = screenRoute({ route, gas: richGas(), volumeMMscfd: 10 });
    // 4 percent inerts against a 1 percent maximum fails; 10 MMscfd against
    // a 5 MMscfd minimum passes.
    expect(s.checks.find((c) => c.key === 'maxInertFraction').status).toBe('fail');
    expect(s.checks.find((c) => c.key === 'minVolumeMMscfd').status).toBe('pass');
  });

  it('reports no data rather than a pass when the gas cannot answer', () => {
    const noGhv = characteriseGas({
      components: [comp('C1', 0.9), { ...ref('C2'), moleFraction: 0.1, ghvBtuScf: null }],
    });
    const cng = ROUTE_TEMPLATES.find((r) => r.id === 'cng');
    const s = screenRoute({
      route: { ...cng, requirements: cng.requirements.map((r) => ({ ...r, limit: r.key === 'minGhvBtuScf' ? 900 : 0 })) },
      gas: noGhv, volumeMMscfd: 10,
    });
    expect(s.checks.find((c) => c.key === 'minGhvBtuScf').status).toBe('no data');
    expect(s.verdict).toBe('not fully screened');
  });

  it('screens the liquids route on the liquids content', () => {
    const lpg = ROUTE_TEMPLATES.find((r) => r.id === 'lpg_extraction');
    const route = (limit) => ({
      ...lpg,
      requirements: lpg.requirements.map((r) => ({
        ...r, limit: r.key === 'minGpmC3Plus' ? limit : 1,
      })),
    });
    expect(screenRoute({ route: route(2), gas: richGas(), volumeMMscfd: 10 }).verdict).toBe('passes');
    expect(screenRoute({ route: route(2), gas: leanGas(), volumeMMscfd: 10 }).verdict).toBe('fails');
  });
});

describe('route economics', () => {
  const route = ROUTE_TEMPLATES.find((r) => r.id === 'cng');
  const base = {
    route, gas: richGas(), volumeMMscfd: 10, onstreamDays: 350,
    productUnitPerMscf: 20, recoveryFraction: 0.9, pricePerProductUnit: 0.6,
    productUnitLabel: 'kg CNG',
    referenceCapitalCost: 30000000, referenceCapacityMMscfd: 8,
    fixedOpexPerYear: 2500000, variableOpexPerMscf: 0.4,
  };

  it('applies the recovery to the yield rather than assuming it away', () => {
    const r = routeEconomics(base);
    expect(r.mscfPerYear).toBeCloseTo(10 * 1000 * 350, 3);
    expect(r.productPerYear).toBeCloseTo(r.mscfPerYear * 20 * 0.9, 3);
  });

  it('refuses a recovery outside its range, and says why', () => {
    const r = routeEconomics({ ...base, recoveryFraction: 1.2 });
    expect(r.error).toMatch(/recovery fraction/i);
    expect(routeEconomics({ ...base, recoveryFraction: null }).error).toMatch(/quiet optimism/i);
  });

  it('scales capital by the same power law the refinery studio uses', () => {
    const r = routeEconomics(base);
    // Not a second implementation: the exponent comes back with the answer.
    expect(r.capitalCost).toBeCloseTo(30000000 * (10 / 8) ** r.scalingExponent, 2);
    const bigger = routeEconomics({ ...base, volumeMMscfd: 20 });
    expect(bigger.capitalCost).toBeGreaterThan(r.capitalCost);
    // And per unit of capacity it gets cheaper, which is the whole point of
    // a scaling exponent below one.
    expect(bigger.capitalCost / 20).toBeLessThan(r.capitalCost / 10);
  });

  it('reconciles margin to revenue less operating cost', () => {
    const r = routeEconomics(base);
    expect(r.operatingCostPerYear).toBeCloseTo(2500000 + r.mscfPerYear * 0.4, 2);
    expect(r.grossMarginPerYear).toBeCloseTo(r.revenuePerYear - r.operatingCostPerYear, 2);
    expect(r.valuePerMscf).toBeCloseTo(r.grossMarginPerYear / r.mscfPerYear, 6);
  });

  it('hands the cash flow over rather than discounting it here', () => {
    const r = routeEconomics(base);
    expect(r.cashFlow.year0).toBeCloseTo(-r.capitalCost, 2);
    expect(r.cashFlow.recurring).toBeCloseTo(r.grossMarginPerYear, 2);
    expect(r.valuationNote).toMatch(/second answer/i);
  });

  it('leaves revenue absent without a price, and capital absent without a reference', () => {
    const noPrice = routeEconomics({ ...base, pricePerProductUnit: null });
    expect(noPrice.revenuePerYear).toBeNull();
    expect(noPrice.grossMarginPerYear).toBeNull();
    const noRef = routeEconomics({ ...base, referenceCapitalCost: null });
    expect(noRef.capitalCost).toBeNull();
    expect(noRef.capexNote).toMatch(/reference plant/i);
  });
});

describe('the abatement, and the claim this app exists to stop', () => {
  const gas = richGas();
  const base = { gas, volumeMMscfd: 10, onstreamDays: 350, flareDestructionEfficiency: 0.92 };

  it('refuses to report an abatement until the counterfactual is declared', () => {
    const a = abatement({ ...base, gwpMethane: 28 });
    // Claiming the flare's gross emission is only correct if the gas is
    // never burned. Recover it and sell it and the customer burns it.
    expect(a.netAbatementTonnesCo2ePerYear).toBeNull();
    expect(a.counterfactualDeclared).toBe(false);
    expect(a.blockedBy).toMatch(/counterfactual is not declared/i);
    expect(a.warning).toMatch(/gross emission is not the abatement/i);
  });

  it('still shows the flare its own footprint, which is a different question', () => {
    const a = abatement({ ...base, gwpMethane: 28 });
    expect(a.flareCo2Tonnes).toBeGreaterThan(0);
    expect(a.grossClaimIfNoCounterfactual).toBeCloseTo(a.flareCo2eTonnes, 3);
  });

  it('computes the flare CO2 from the carbon, atom by atom', () => {
    const a = abatement({ ...base, gwpMethane: 28 });
    const lbmol = (10 * 1e6 * 350) / SCF_PER_LBMOL;
    const carbon = lbmol * gas.carbonPerMol;
    expect(a.flareCo2Tonnes).toBeCloseTo((carbon * 0.92 * 44.009) / LB_PER_KG / 1000, 2);
  });

  it('conserves carbon between the CO2 and the methane slip', () => {
    const a = abatement({ ...base, gwpMethane: 28 });
    const carbonInCo2 = (a.flareCo2Tonnes * 1000 * LB_PER_KG) / 44.009;
    const carbonInCh4 = (a.flareCh4Tonnes * 1000 * LB_PER_KG) / 16.043;
    const lbmol = (10 * 1e6 * 350) / SCF_PER_LBMOL;
    expect(carbonInCo2 + carbonInCh4).toBeCloseTo(lbmol * gas.carbonPerMol, 0);
  });

  it('shows how much of a flare is the methane it fails to burn', () => {
    const a = abatement({ ...base, gwpMethane: 28 });
    // Eight percent of the carbon escaping unburned carries close to half
    // the flare's CO2e. That is why the destruction efficiency is required.
    expect(a.methaneShareOfFlareCo2e).toBeGreaterThan(0.4);
    const better = abatement({ ...base, flareDestructionEfficiency: 0.99, gwpMethane: 28 });
    expect(better.methaneShareOfFlareCo2e).toBeLessThan(a.methaneShareOfFlareCo2e);
    expect(better.flareCo2eTonnes).toBeLessThan(a.flareCo2eTonnes);
  });

  it('requires the destruction efficiency and the methane potential', () => {
    expect(abatement({ ...base, flareDestructionEfficiency: null }).error)
      .toMatch(/destruction efficiency/i);
    expect(abatement({ ...base, gwpMethane: null }).blockedBy)
      .toMatch(/global warming potential/i);
  });

  it('nets the product combustion off and the displaced fuel back on', () => {
    const a = abatement({
      ...base, gwpMethane: 28,
      counterfactualLabel: 'CNG displacing diesel in haulage',
      productCombustionTonnesCo2ePerYear: 190000,
      displacedFuelTonnesCo2ePerYear: 240000,
    });
    expect(a.counterfactualDeclared).toBe(true);
    expect(a.netAbatementTonnesCo2ePerYear)
      .toBeCloseTo(a.flareCo2eTonnes - 190000 + 240000, 3);
    expect(a.blockedBy).toBeNull();
  });

  it('gives three different answers for one flare, depending on the counterfactual', () => {
    const net = (label, product, displaced) => abatement({
      ...base, gwpMethane: 28, counterfactualLabel: label,
      productCombustionTonnesCo2ePerYear: product, displacedFuelTonnesCo2ePerYear: displaced,
    }).netAbatementTonnesCo2ePerYear;
    const gross = abatement({ ...base, gwpMethane: 28 }).flareCo2eTonnes;

    const displacesDiesel = net('CNG displacing diesel', 190000, 240000);
    const displacesSameGas = net('displacing pipeline gas', 190000, 190000);
    const displacesNothing = net('a market that burned nothing', 190000, 0);

    // Displacing a dirtier fuel abates MORE than the flare emitted, because
    // the diesel is abated as well. Displacing the same gas abates only the
    // flare. Displacing nothing abates less than the flare emitted. The
    // gross figure is not a conservative shortcut; it is a different number
    // from the right one, in a direction you cannot know in advance.
    expect(displacesDiesel).toBeGreaterThan(gross);
    expect(displacesSameGas).toBeCloseTo(gross, 6);
    expect(displacesNothing).toBeLessThan(gross);
    expect(displacesDiesel).toBeGreaterThan(displacesSameGas);
    expect(displacesSameGas).toBeGreaterThan(displacesNothing);
  });

  it('can even report a net increase, and does not hide it', () => {
    const a = abatement({
      ...base, gwpMethane: 28, counterfactualLabel: 'displacing nothing at all',
      productCombustionTonnesCo2ePerYear: 900000, displacedFuelTonnesCo2ePerYear: 0,
    });
    expect(a.netAbatementTonnesCo2ePerYear).toBeLessThan(0);
  });
});

describe('carbon credit sensitivity', () => {
  const t = 120000;

  it('refuses to price credits off a gross flare figure', () => {
    const r = creditSensitivity({ netAbatementTonnesCo2ePerYear: null, creditPrices: [10] });
    expect(r.error).toMatch(/credit that cannot be issued/i);
  });

  it('values credits at each price', () => {
    const r = creditSensitivity({
      netAbatementTonnesCo2ePerYear: t, creditPrices: [5, 15, 40],
      grossMarginPerYear: 1000000, hurdleMarginPerYear: 2000000,
    });
    expect(r.points[1].creditRevenuePerYear).toBeCloseTo(t * 15, 2);
    expect(r.points[1].totalMarginPerYear).toBeCloseTo(1000000 + t * 15, 2);
  });

  it('separates a project that stands alone from one that is a bet', () => {
    const standsAlone = creditSensitivity({
      netAbatementTonnesCo2ePerYear: t, creditPrices: [0, 10],
      grossMarginPerYear: 5000000, hurdleMarginPerYear: 2000000,
    });
    expect(standsAlone.standsAloneWithoutCredits).toBe(true);
    expect(standsAlone.creditPriceNeeded).toBe(0);
    expect(standsAlone.verdict).toMatch(/upside, not the case/i);

    const bet = creditSensitivity({
      netAbatementTonnesCo2ePerYear: t, creditPrices: [2, 10, 25],
      grossMarginPerYear: 500000, hurdleMarginPerYear: 2000000,
    });
    expect(bet.standsAloneWithoutCredits).toBe(false);
    // The first price tested that clears, which is the honest answer to
    // "what do we need carbon to be worth".
    expect(bet.creditPriceNeeded).toBe(25);
    expect(bet.verdict).toMatch(/bet on the credit price/i);
  });

  it('says so when no tested price clears the hurdle', () => {
    const r = creditSensitivity({
      netAbatementTonnesCo2ePerYear: t, creditPrices: [1, 2],
      grossMarginPerYear: 0, hurdleMarginPerYear: 10000000,
    });
    expect(r.creditPriceNeeded).toBeNull();
    expect(r.verdict).toMatch(/does not clear the hurdle at any/i);
  });
});

describe('the bid comparison', () => {
  const gas = richGas();
  const route = (id) => ROUTE_TEMPLATES.find((r) => r.id === id);
  const limited = (id, limits) => ({
    ...route(id),
    requirements: route(id).requirements.map((r) => ({ ...r, limit: limits[r.key] ?? 0 })),
  });

  const screenings = [
    screenRoute({ route: limited('cng', { minVolumeMMscfd: 5, maxInertFraction: 0.1, minGhvBtuScf: 900 }), gas, volumeMMscfd: 10 }),
    screenRoute({ route: limited('mini_lng', { minVolumeMMscfd: 40, maxCo2Fraction: 0.5, maxInertFraction: 0.5 }), gas, volumeMMscfd: 10 }),
    screenRoute({ route: limited('lpg_extraction', { minVolumeMMscfd: 5, minGpmC3Plus: 2 }), gas, volumeMMscfd: 10 }),
  ];
  const economics = [
    routeEconomics({ route: route('cng'), gas, volumeMMscfd: 10, productUnitPerMscf: 20, recoveryFraction: 0.9, pricePerProductUnit: 0.6, referenceCapitalCost: 30000000, referenceCapacityMMscfd: 8, fixedOpexPerYear: 2500000, variableOpexPerMscf: 0.4 }),
    routeEconomics({ route: route('lpg_extraction'), gas, volumeMMscfd: 10, productUnitPerMscf: 0.02, recoveryFraction: 0.85, pricePerProductUnit: 500, referenceCapitalCost: 45000000, referenceCapacityMMscfd: 12, fixedOpexPerYear: 3000000, variableOpexPerMscf: 0.3 }),
  ];

  it('keeps a route that failed screening in the table', () => {
    const c = compareRoutes({ screenings, economics });
    // A route missing from a comparison reads as one nobody considered, and
    // in a bid that is the difference between thorough and careless.
    expect(c.rows).toHaveLength(3);
    expect(c.screenedOut).toContain('Mini LNG');
    expect(c.rows.find((r) => r.routeId === 'mini_lng').failures[0].requirement)
      .toBe('Minimum volume');
  });

  it('ranks only routes that pass and have a value', () => {
    const c = compareRoutes({ screenings, economics });
    expect(['cng', 'lpg_extraction']).toContain(c.bestByValuePerMscf);
    expect(c.bestByValuePerMscf).not.toBe('mini_lng');
  });

  it('warns that the ranking ignores the capital', () => {
    const c = compareRoutes({ screenings, economics });
    expect(c.rankingNote).toMatch(/ignores the capital/i);
    expect(c.rankingNote).toMatch(/sanctioned economics engine/i);
  });

  it('carries the abatement across when there is one', () => {
    const a = abatement({
      gas, volumeMMscfd: 10, flareDestructionEfficiency: 0.92, gwpMethane: 28,
      counterfactualLabel: 'displacing diesel',
      productCombustionTonnesCo2ePerYear: 190000, displacedFuelTonnesCo2ePerYear: 240000,
    });
    const c = compareRoutes({ screenings, economics, abatements: { cng: a } });
    expect(c.rows.find((r) => r.routeId === 'cng').netAbatementTonnesCo2ePerYear)
      .toBeCloseTo(a.netAbatementTonnesCo2ePerYear, 3);
    expect(c.rows.find((r) => r.routeId === 'lpg_extraction').netAbatementTonnesCo2ePerYear)
      .toBeNull();
  });

  it('says when nothing can be ranked', () => {
    const c = compareRoutes({ screenings: [], economics: [] });
    expect(c.bestByValuePerMscf).toBeNull();
    expect(c.rankingNote).toMatch(/supply the missing prices/i);
  });
});

describe('the reference data and templates', () => {
  it('separates definitional atom counts from typical properties', () => {
    GAS_COMPONENT_REFERENCE.forEach((c) => {
      expect(Number.isInteger(c.c)).toBe(true);
      expect(c.molarMassLbLbmol).toBeGreaterThan(0);
    });
    expect(GAS_REFERENCE_NOTE).toMatch(/definitional/i);
    expect(GAS_REFERENCE_NOTE).toMatch(/gas analysis and the certificate govern/i);
  });

  it('ships route requirements with no limits set', () => {
    ROUTE_TEMPLATES.forEach((r) => {
      expect(r.requirements.length).toBeGreaterThan(0);
      r.requirements.forEach((q) => {
        // Shipping a limit would be shipping somebody else's project as if
        // it were a rule.
        expect(q.limit).toBeNull();
        expect(['min', 'max']).toContain(q.direction);
      });
    });
    expect(ROUTE_TEMPLATE_NOTE).toMatch(/yours to set/i);
  });

  it('covers the four routes the module set out to screen', () => {
    expect(ROUTE_TEMPLATES.map((r) => r.id).sort())
      .toEqual(['cng', 'gas_to_power', 'lpg_extraction', 'mini_lng']);
  });
});

describe('missing stays missing', () => {
  it('does not read an empty string as a zero', () => {
    expect(characteriseGas({ components: [{ ...ref('C1'), moleFraction: '' }] }).error).toBeTruthy();
    expect(abatement({
      gas: richGas(), volumeMMscfd: 10, flareDestructionEfficiency: '',
    }).error).toMatch(/destruction efficiency/i);
    expect(routeEconomics({
      route: ROUTE_TEMPLATES[0], gas: richGas(), volumeMMscfd: 10,
      productUnitPerMscf: 1, recoveryFraction: '',
    }).error).toMatch(/recovery fraction/i);
  });
});
