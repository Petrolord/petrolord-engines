// Production P10 flow-assurance engine gates: the thermal derivations,
// the limits they must reduce to, the refusals, and agreement with the
// independent stdlib oracle
// (tools/validation/production/oracle_flowassurance.py).
//
// The oracle works entirely in SI -- watts, seconds, metres, kelvin --
// and converts only at the boundary, while this module works in field
// units throughout. For the inhibitor relations it goes further and
// computes them in CELSIUS with the METRIC constants (1297 and 72),
// which is the sharpest available check on the field constants this
// module carries: they have to fall out of the metric ones.

import fs from 'fs';
import path from 'path';
import {
  CONDUCTIVITIES, conductivity, FILM_COEFFICIENTS, filmCoefficient,
  layerResistance, burialResistance, overallU, relaxationLengthFt,
  steadyStateProfile, uForArrivalTemp, cooldownTime, pipeMassLbPerFt,
  contentsMassLbPerFt, STEEL_DENSITY_LB_FT3,
} from '../engines/production/flowlineThermal';
import {
  INHIBITORS, inhibitor, HAMMERSCHMIDT_RELIABLE_WT_PCT,
  NIELSEN_BUCKLIN_CONSTANT_F, WATER_MOLECULAR_WEIGHT,
  hammerschmidtDepression, weightPctForDepression, weightPctToMoleFraction,
  nielsenBucklinDepression, depression, injectionRate, inhibitionRequirement,
  MAX_PRACTICAL_WT_PCT,
} from '../engines/production/hydrateInhibition';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'production', 'goldens', 'flowassurance_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
const LAYERS = G.overallU.layers;

describe('thermal resistances', () => {
  test('an annular layer is the log form, and it matches the SI oracle', () => {
    const r = layerResistance({ idIn: 6.625, odIn: 8.625, k: 0.09 });
    expect(r).toBeCloseTo(Math.log(8.625 / 6.625) / (2 * Math.PI * 0.09), 12);
    // Doubling the conductivity halves the resistance.
    expect(rel(layerResistance({ idIn: 6.625, odIn: 8.625, k: 0.18 }), r / 2))
      .toBeLessThan(1e-12);
  });

  test('a pipe lying on the bottom gets nothing from the ground', () => {
    // H = D/2 makes acosh(1) = 0. It is the right answer, and it is the
    // check that this is the shape factor rather than something that
    // merely looks like one.
    expect(burialResistance({ odIn: 8.625, burialFt: 8.625 / 24, kSoil: 1.2 }))
      .toBeCloseTo(0, 8);
    expect(G.burialAtHalfDiameter).toBeLessThan(1e-6);
    // and burying it deeper insulates it more
    const shallow = burialResistance({ odIn: 8.625, burialFt: 2, kSoil: 1.2 });
    const deep = burialResistance({ odIn: 8.625, burialFt: 8, kSoil: 1.2 });
    expect(deep).toBeGreaterThan(shallow);
    // a pipe above the ground is not a buried pipe
    expect(burialResistance({ odIn: 8.625, burialFt: 0.1, kSoil: 1.2 })).toBeNaN();
  });

  test('U is series resistances, and matches the SI oracle', () => {
    const u = overallU({
      layers: LAYERS, insideFilmH: 250, outsideFilmH: 200, referenceIdIn: 6.065,
    });
    expect(u.ok).toBe(true);
    expect(rel(u.uBtuHrFt2F, G.overallU.insulated)).toBeLessThan(1e-6);
    // The shares sum to the whole, which is what makes them shares.
    expect(u.resistances.reduce((a, x) => a + x.sharePct, 0)).toBeCloseTo(100, 9);
    // and on an insulated line the insulation is nearly all of it
    const insulation = u.resistances.find((x) => x.label === undefined && x.id === 'layer1')
      || u.resistances[2];
    expect(insulation.sharePct).toBeGreaterThan(90);
  });

  test('insulation is what changes U, by about two orders of magnitude', () => {
    const bare = overallU({ layers: [LAYERS[0]], insideFilmH: 250, outsideFilmH: 200 });
    const insulated = overallU({ layers: LAYERS, insideFilmH: 250, outsideFilmH: 200 });
    expect(rel(bare.uBtuHrFt2F, G.overallU.bare)).toBeLessThan(1e-6);
    expect(bare.uBtuHrFt2F / insulated.uBtuHrFt2F).toBeGreaterThan(50);
  });

  test('burying an insulated line helps, and the oracle agrees how much', () => {
    const buried = overallU({
      layers: LAYERS, insideFilmH: 250, outsideFilmH: 200,
      burialFt: 4, kSoil: 1.2, referenceIdIn: 6.065,
    });
    expect(rel(buried.uBtuHrFt2F, G.overallU.buried4ft)).toBeLessThan(1e-6);
    expect(buried.uBtuHrFt2F).toBeLessThan(G.overallU.insulated);
  });

  test('U says which area it is referred to, because it is meaningless otherwise', () => {
    const toBore = overallU({ layers: LAYERS, insideFilmH: 250, outsideFilmH: 200, referenceIdIn: 6.065 });
    const toOuter = overallU({ layers: LAYERS, insideFilmH: 250, outsideFilmH: 200, referenceIdIn: 8.625 });
    expect(toBore.referenceIdIn).toBe(6.065);
    expect(toOuter.referenceIdIn).toBe(8.625);
    // Same physics, different reference: the product U x A is invariant.
    expect(rel(toBore.uBtuHrFt2F * 6.065, toOuter.uBtuHrFt2F * 8.625)).toBeLessThan(1e-12);
  });

  test('an unresolvable layer is refused rather than skipped', () => {
    expect(overallU({ layers: [] }).ok).toBe(false);
    expect(overallU({ layers: [{ idIn: 6, odIn: 5, k: 26 }] }).ok).toBe(false);
    expect(overallU({ layers: [{ idIn: 6, odIn: 7, k: 0 }] }).ok).toBe(false);
  });

  test('the material and film tables are properties, not products', () => {
    expect(conductivity('steel')).toBe(26);
    expect(conductivity('aerogel')).toBeLessThan(conductivity('polyurethane'));
    expect(filmCoefficient('seawaterCurrent'))
      .toBeGreaterThan(filmCoefficient('airStill'));
    // The inside catalog is separate but the same lookup reaches it.
    expect(filmCoefficient('liquidFlowing'))
      .toBeGreaterThan(filmCoefficient('gasFlowing'));
    // No silent fallback. An unknown id used to return the FIRST entry,
    // carbon steel, so a typo turned aerogel into steel and made a line
    // look two thousand times better insulated than it is. NaN
    // propagates into a refusal; a plausible wrong number does not.
    expect(conductivity('nonsense')).toBeNaN();
    expect(filmCoefficient('nonsense')).toBeNaN();
    expect(overallU({
      layers: [{ idIn: 6, odIn: 7, k: conductivity('nonsense') }],
      insideFilmH: 300, outsideFilmH: 200,
    }).ok).toBe(false);
    expect(CONDUCTIVITIES.every((c) => c.k > 0)).toBe(true);
    expect(FILM_COEFFICIENTS.every((f) => f.h > 0)).toBe(true);
  });
});

describe('the steady-state profile', () => {
  test('the relaxation length matches the SI oracle and scales as it should', () => {
    G.relaxation.forEach((row) => {
      expect(rel(relaxationLengthFt(row), row.lengthFt)).toBeLessThan(1e-6);
    });
    // Lc is linear in mass rate and in heat capacity, inverse in U.
    const base = { massRateLbHr: 100000, cpBtuLbF: 0.5, uBtuHrFt2F: 1.3, idIn: 6 };
    expect(rel(relaxationLengthFt({ ...base, massRateLbHr: 200000 }),
      2 * relaxationLengthFt(base))).toBeLessThan(1e-12);
    expect(rel(relaxationLengthFt({ ...base, uBtuHrFt2F: 2.6 }),
      relaxationLengthFt(base) / 2)).toBeLessThan(1e-12);
  });

  test('temperature approaches ambient exponentially, against the oracle', () => {
    const p = G.profile;
    p.points.forEach((pt) => {
      const out = steadyStateProfile({
        lengthFt: pt.lengthFt, inletTempF: p.inletTempF, ambientTempF: p.ambientTempF,
        massRateLbHr: p.massRateLbHr, cpBtuLbF: p.cpBtuLbF,
        uBtuHrFt2F: p.uBtuHrFt2F, idIn: p.idIn,
      });
      expect(out.ok).toBe(true);
      expect(rel(out.arrivalTempF, pt.arrivalTempF)).toBeLessThan(1e-6);
      expect(rel(out.ntu, pt.ntu)).toBeLessThan(1e-6);
    });
  });

  test('one relaxation length loses 63 percent of the excess, by construction', () => {
    const p = G.profile;
    const out = steadyStateProfile({
      lengthFt: p.relaxationLengthFt, inletTempF: 200, ambientTempF: 40,
      massRateLbHr: p.massRateLbHr, cpBtuLbF: p.cpBtuLbF,
      uBtuHrFt2F: p.uBtuHrFt2F, idIn: p.idIn,
    });
    const excessLeft = (out.arrivalTempF - 40) / (200 - 40);
    expect(excessLeft).toBeCloseTo(Math.exp(-1), 6);
  });

  test('Joule-Thomson cooling is an input and it cools the line further', () => {
    const common = {
      lengthFt: 26400, inletTempF: 180, ambientTempF: 40, massRateLbHr: 120000,
      cpBtuLbF: 0.5, uBtuHrFt2F: 1.33, idIn: 6.065, inletPsia: 1200, outletPsia: 400,
    };
    const noJt = steadyStateProfile({ ...common, jtCoeffFPerPsi: 0 });
    const withJt = steadyStateProfile({ ...common, jtCoeffFPerPsi: 0.02 });
    expect(withJt.arrivalTempF).toBeLessThan(noJt.arrivalTempF);
    // ITEM 48. Not the coefficient times the pressure drop: that is the
    // cooling GENERATED, and the line trades heat with ambient the whole
    // way, so what survives to the arrival end is damped by the same
    // exponential the inlet temperature is.
    const { ntu } = noJt;
    const damping = (1 - Math.exp(-ntu)) / ntu;
    expect(withJt.jtDampingFactor).toBeCloseTo(damping, 12);
    expect(noJt.arrivalTempF - withJt.arrivalTempF).toBeCloseTo(0.02 * 800 * damping, 9);
    // the undamped figure is the one that used to be reported: 16.0 F of
    // arrival cooling on this line against the 10.4 F that survives it,
    // half again too much
    const dampedF = noJt.arrivalTempF - withJt.arrivalTempF;
    expect(0.02 * 800).toBeCloseTo(16, 9);
    expect(dampedF).toBeGreaterThan(10);
    expect(dampedF).toBeLessThan(11);
    expect(16 / dampedF).toBeGreaterThan(1.5);
    expect(damping).toBeLessThan(1);
  });

  test('a short line keeps its Joule-Thomson cooling and a long one loses it', () => {
    const common = {
      inletTempF: 180, ambientTempF: 40, massRateLbHr: 120000,
      cpBtuLbF: 0.5, uBtuHrFt2F: 1.33, idIn: 6.065, inletPsia: 1200, outletPsia: 400,
      jtCoeffFPerPsi: 0.02,
    };
    const short = steadyStateProfile({ ...common, lengthFt: 500 });
    const long = steadyStateProfile({ ...common, lengthFt: 200000 });
    // a line much shorter than its relaxation length has no time to
    // trade the cooling back, so the damping goes to 1
    expect(short.ntu).toBeLessThan(0.05);
    expect(short.jtDampingFactor).toBeGreaterThan(0.97);
    // and a long one arrives at ambient less almost none of it
    expect(long.ntu).toBeGreaterThan(5);
    expect(long.jtDampingFactor).toBeLessThan(0.2);
    // the damped drop is never larger than the generated one
    const generated = 0.02 * 800;
    const noJtLong = steadyStateProfile({ ...common, lengthFt: 200000, jtCoeffFPerPsi: 0 });
    expect(noJtLong.arrivalTempF - long.arrivalTempF).toBeLessThan(generated);
  });

  test('a profile with nothing to go on is refused', () => {
    expect(steadyStateProfile({ lengthFt: 0 }).ok).toBe(false);
    expect(steadyStateProfile({
      lengthFt: 1000, massRateLbHr: 0, cpBtuLbF: 0.5, uBtuHrFt2F: 1, idIn: 6,
    }).ok).toBe(false);
  });
});

describe('designing for an arrival temperature', () => {
  test('the U it returns really does land the fluid on the target', () => {
    const args = {
      lengthFt: 26400, inletTempF: 180, ambientTempF: 40, targetTempF: 120,
      massRateLbHr: 120000, cpBtuLbF: 0.5, idIn: 6.065,
    };
    const need = uForArrivalTemp(args);
    expect(need.ok).toBe(true);
    const check = steadyStateProfile({ ...args, uBtuHrFt2F: need.uBtuHrFt2F });
    expect(rel(check.arrivalTempF, 120)).toBeLessThan(1e-9);
  });

  test('the two ways of being impossible are told apart', () => {
    // Below ambient is unreachable at any insulation; above the inlet
    // is not a cooling problem at all. Collapsing them into one message
    // would send an engineer looking in the wrong place.
    const belowAmbient = uForArrivalTemp({
      lengthFt: 26400, inletTempF: 180, ambientTempF: 40, targetTempF: 35,
      massRateLbHr: 120000, cpBtuLbF: 0.5, idIn: 6.065,
    });
    expect(belowAmbient.ok).toBe(false);
    expect(belowAmbient.reason).toMatch(/cannot arrive below ambient/);
    const aboveInlet = uForArrivalTemp({
      lengthFt: 26400, inletTempF: 100, ambientTempF: 40, targetTempF: 150,
      massRateLbHr: 120000, cpBtuLbF: 0.5, idIn: 6.065,
    });
    expect(aboveInlet.ok).toBe(false);
    expect(aboveInlet.reason).toMatch(/already enters below the target/);
  });
});

describe('cooldown, the no-touch time', () => {
  const contentsMass = contentsMassLbPerFt({ idIn: 6.065, densityLbFt3: 55 });
  const shellMass = pipeMassLbPerFt({ idIn: 6.065, odIn: 6.625 });

  test('it matches the SI oracle', () => {
    const cd = cooldownTime({
      contents: { massLbPerFt: contentsMass, cpBtuLbF: 0.5 },
      shell: { massLbPerFt: shellMass, cpBtuLbF: 0.11 },
      uBtuHrFt2F: G.cooldown.uBtuHrFt2F, idIn: 6.065,
      startTempF: 150, ambientTempF: 40, targetTempF: 70,
    });
    expect(cd.ok).toBe(true);
    expect(rel(cd.hours, G.cooldown.hours)).toBeLessThan(1e-6);
    expect(rel(cd.timeConstantHr, G.cooldown.timeConstantHr)).toBeLessThan(1e-6);
  });

  test('the steel is not negligible, which is why it is carried', () => {
    // Leaving the pipe's own heat capacity out is a common and
    // optimistic error: on a small-bore line the steel holds a real
    // share of the heat.
    const withShell = cooldownTime({
      contents: { massLbPerFt: contentsMass, cpBtuLbF: 0.5 },
      shell: { massLbPerFt: shellMass, cpBtuLbF: 0.11 },
      uBtuHrFt2F: 1.33, idIn: 6.065, startTempF: 150, ambientTempF: 40, targetTempF: 70,
    });
    const contentsOnly = cooldownTime({
      contents: { massLbPerFt: contentsMass, cpBtuLbF: 0.5 },
      shell: { massLbPerFt: 0, cpBtuLbF: 0 },
      uBtuHrFt2F: 1.33, idIn: 6.065, startTempF: 150, ambientTempF: 40, targetTempF: 70,
    });
    expect(withShell.hours).toBeGreaterThan(contentsOnly.hours * 1.05);
  });

  test('better insulation buys time, in proportion', () => {
    const at = (u) => cooldownTime({
      contents: { massLbPerFt: contentsMass, cpBtuLbF: 0.5 },
      shell: { massLbPerFt: shellMass, cpBtuLbF: 0.11 },
      uBtuHrFt2F: u, idIn: 6.065, startTempF: 150, ambientTempF: 40, targetTempF: 70,
    }).hours;
    expect(rel(at(0.665), 2 * at(1.33))).toBeLessThan(1e-9);
  });

  test('a target at or below ambient never arrives, and says so', () => {
    const cd = cooldownTime({
      contents: { massLbPerFt: contentsMass, cpBtuLbF: 0.5 },
      shell: { massLbPerFt: shellMass, cpBtuLbF: 0.11 },
      uBtuHrFt2F: 1.33, idIn: 6.065, startTempF: 150, ambientTempF: 60, targetTempF: 55,
    });
    expect(cd.ok).toBe(true);
    expect(cd.hours).toBe(Infinity);
    expect(cd.note).toMatch(/never reaches it/);
  });

  test('nothing to cool, and nothing to cool it with, are both refused', () => {
    expect(cooldownTime({
      contents: { massLbPerFt: 0, cpBtuLbF: 0 }, shell: { massLbPerFt: 0, cpBtuLbF: 0 },
      uBtuHrFt2F: 1.33, idIn: 6, startTempF: 150, ambientTempF: 40, targetTempF: 70,
    }).ok).toBe(false);
    expect(cooldownTime({
      contents: { massLbPerFt: 10, cpBtuLbF: 0.5 }, shell: { massLbPerFt: 0, cpBtuLbF: 0 },
      uBtuHrFt2F: 1.33, idIn: 6, startTempF: 30, ambientTempF: 40, targetTempF: 20,
    }).ok).toBe(false);
  });

  test('pipe and contents masses come from the geometry', () => {
    expect(pipeMassLbPerFt({ idIn: 6.065, odIn: 6.625 }))
      .toBeCloseTo((Math.PI / 4) * ((6.625 / 12) ** 2 - (6.065 / 12) ** 2) * STEEL_DENSITY_LB_FT3, 9);
    expect(pipeMassLbPerFt({ idIn: 7, odIn: 6 }).ok).toBe(false);
    expect(contentsMassLbPerFt({ idIn: 6.065, densityLbFt3: 62.4 }))
      .toBeGreaterThan(contentsMassLbPerFt({ idIn: 6.065, densityLbFt3: 55 }));
  });
});

describe('hydrate inhibition', () => {
  test('THE FIELD CONSTANTS FALL OUT OF THE METRIC ONES', () => {
    // The sharpest check available on two remembered numbers.
    // Hammerschmidt is 1297 in degC and Nielsen-Bucklin is 72; the
    // degF forms have to be those times 1.8 or one of them is wrong.
    expect(rel(2335, G.constants.hammerschmidtKfromMetric)).toBeLessThan(2e-4);
    expect(NIELSEN_BUCKLIN_CONSTANT_F).toBeCloseTo(G.constants.nielsenBucklinFfromMetric, 9);
    INHIBITORS.forEach((x) => expect(x.k).toBe(2335));
    expect(WATER_MOLECULAR_WEIGHT).toBeCloseTo(18.015, 3);
  });

  test('both relations match the oracle across every inhibitor and concentration', () => {
    G.inhibition.forEach((row) => {
      expect(rel(hammerschmidtDepression({
        weightPct: row.weightPct, molecularWeight: row.molecularWeight,
      }), row.hammerschmidtF)).toBeLessThan(5e-4);
      expect(rel(nielsenBucklinDepression({
        weightPct: row.weightPct, molecularWeight: row.molecularWeight,
      }), row.nielsenBucklinF)).toBeLessThan(1e-9);
    });
  });

  test('the depression is inverted exactly', () => {
    [5, 15, 25, 40].forEach((w) => {
      const d = hammerschmidtDepression({ weightPct: w, molecularWeight: 32.04 });
      expect(rel(weightPctForDepression({ depressionF: d, molecularWeight: 32.04 }), w))
        .toBeLessThan(1e-9);
    });
  });

  test('methanol beats the glycols per pound, and heavier glycols do worse', () => {
    // The molecular weight is doing the work, which is the whole shape
    // of the Hammerschmidt form.
    const at20 = (id) => depression({ weightPct: 20, inhibitorId: id }).hammerschmidtF;
    expect(at20('methanol')).toBeGreaterThan(at20('meg'));
    expect(at20('meg')).toBeGreaterThan(at20('deg'));
    expect(at20('deg')).toBeGreaterThan(at20('teg'));
    expect(inhibitor('nonsense').id).toBe('methanol');
    INHIBITORS.forEach((x) => expect(x.note.length).toBeGreaterThan(40));
  });

  test('the two relations agree when dilute and separate when not, and the gap is reported', () => {
    const low = depression({ weightPct: 10, inhibitorId: 'methanol' });
    const high = depression({ weightPct: 50, inhibitorId: 'methanol' });
    expect(low.spreadF).toBeLessThan(1);
    expect(high.spreadF).toBeGreaterThan(10);
    // ITEM 59. The recommendation is the LOWER of the two at every
    // concentration, so there is no step at 25 weight percent any more.
    // `withinHammerschmidtRange` still says where the band ends, which
    // is a statement about concentration and always was.
    expect(low.basis).toBe('nielsenBucklin');
    expect(low.recommendedF).toBe(Math.min(low.hammerschmidtF, low.nielsenBucklinF));
    expect(low.withinHammerschmidtRange).toBe(true);
    expect(high.basis).toBe('nielsenBucklin');
    expect(high.recommendedF).toBe(high.nielsenBucklinF);
    expect(high.withinHammerschmidtRange).toBe(false);
    expect(high.note).toMatch(/over-predicts/);
    expect(HAMMERSCHMIDT_RELIABLE_WT_PCT).toBe(25);
    // and the recommendation is continuous across the band edge, which
    // is what the step used to break: a hundredth of a weight percent
    // either side of 25 moves it by a hundredth of a degree
    const justUnder = depression({ weightPct: 24.99, inhibitorId: 'methanol' });
    const justOver = depression({ weightPct: 25.01, inhibitorId: 'methanol' });
    expect(justOver.recommendedF - justUnder.recommendedF).toBeLessThan(0.05);
    expect(justOver.recommendedF).toBeGreaterThan(justUnder.recommendedF);
  });

  test('a glycol pushed past the band is recommended on the lower relation, and told why', () => {
    // ITEM 59. The recommendation is the conservative reading of the two
    // for every fluid: a design is a promise about the depression that
    // will be there, and where the two relations disagree the promise
    // has to be the smaller one. The note says which relation it came
    // from and where Nielsen-Bucklin was developed, so nothing about the
    // provenance is hidden by the choice.
    const d = depression({ weightPct: 45, inhibitorId: 'meg' });
    expect(Number.isFinite(d.nielsenBucklinF)).toBe(true);
    expect(d.basis).toBe('nielsenBucklin');
    expect(d.recommendedF).toBe(d.nielsenBucklinF);
    expect(d.recommendedF).toBeLessThan(d.hammerschmidtF);
    expect(d.note).toMatch(/developed on methanol data/);
    expect(d.note).toMatch(/lower of the two relations/);
    // the size of what was being promised before, on this fluid
    expect(d.hammerschmidtF - d.nielsenBucklinF).toBeGreaterThan(3);
  });

  test('mole fraction conversion is the ordinary one', () => {
    const x = weightPctToMoleFraction({ weightPct: 20, molecularWeight: 32.04 });
    const expected = (20 / 32.04) / ((20 / 32.04) + (80 / 18.015));
    expect(x).toBeCloseTo(expected, 12);
    expect(weightPctToMoleFraction({ weightPct: 0, molecularWeight: 32.04 })).toBe(0);
  });

  test('the injection rate is a mass balance, and lean strength matters', () => {
    const pure = injectionRate({ waterRateBpd: 200, weightPct: 20, inhibitorId: 'meg', leanWtPct: 100 });
    expect(pure.ok).toBe(true);
    // pure inhibitor mass = water mass x W/(100-W)
    const waterLb = 200 * 42 * 8.34;
    expect(rel(pure.pureMassLbDay, (waterLb * 20) / 80)).toBeLessThan(1e-9);
    // A weaker lean stream means more of it.
    const lean = injectionRate({ waterRateBpd: 200, weightPct: 20, inhibitorId: 'meg', leanWtPct: 80 });
    expect(lean.rateBpd).toBeGreaterThan(pure.rateBpd);
  });

  test('a lean stream weaker than the target is refused, because it cannot get there', () => {
    const r = injectionRate({ waterRateBpd: 100, weightPct: 30, inhibitorId: 'meg', leanWtPct: 25 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not stronger than/);
  });

  test('a fluid already outside the hydrate region needs nothing, and is told so', () => {
    const r = inhibitionRequirement({ subcoolingF: -5, waterRateBpd: 200 });
    expect(r.ok).toBe(true);
    expect(r.required).toBe(false);
    expect(r.note).toMatch(/outside the hydrate region/);
    expect(r.rate).toBeUndefined();
  });

  test('the whole requirement chain closes on itself', () => {
    const r = inhibitionRequirement({
      subcoolingF: 12, safetyMarginF: 3, waterRateBpd: 200,
      inhibitorId: 'meg', leanWtPct: 85,
    });
    expect(r.ok).toBe(true);
    expect(r.required).toBe(true);
    expect(r.neededDepressionF).toBe(15);
    // ITEM 48. The concentration it picked really does give the
    // depression asked for ON THE RELATION THE DESIGN IS JUDGED BY,
    // which is what closing on itself means. It used to be inverted
    // through Hammerschmidt and judged on the lower of the two, so it
    // closed on a relation nobody was going to use.
    expect(rel(r.depressionCheck.recommendedF, 15)).toBeLessThan(1e-9);
    expect(r.weightPctBasis).toBe('nielsenBucklin');
    expect(r.weightPct).toBeGreaterThan(r.weightPctByHammerschmidt);
    // and the old concentration would have come up short
    const short = depression({ weightPct: r.weightPctByHammerschmidt, inhibitorId: 'meg' });
    expect(short.recommendedF).toBeLessThan(15);
    expect(r.rate.rateBpd).toBeGreaterThan(0);
  });

  test('subcooling past what anything is actually run at is refused, and named as the wrong problem', () => {
    // The Hammerschmidt inverse is asymptotic to 100 percent, so it
    // will cheerfully ask for 96 weight percent. That is arithmetically
    // fine and physically absurd, and the refusal has to come from a
    // practical ceiling rather than from the maths running out.
    const r = inhibitionRequirement({ subcoolingF: 400, waterRateBpd: 200, inhibitorId: 'teg' });
    expect(r.ok).toBe(false);
    expect(r.weightPct).toBeGreaterThan(MAX_PRACTICAL_WT_PCT);
    expect(r.weightPct).toBeLessThan(100);
    expect(r.error).toMatch(/thermal or a dosing-strategy problem/);
    expect(r.error).toMatch(/insulation, heating, or displacing/);
    expect(MAX_PRACTICAL_WT_PCT).toBe(70);
    // and a subcooling inside the band still designs
    expect(inhibitionRequirement({
      subcoolingF: 25, waterRateBpd: 200, inhibitorId: 'methanol',
    }).ok).toBe(true);
  });
});

// The refusal names `maxWtPct` beside the concentration it computed, and at
// whole percent a required 70.25 weight percent rendered as "70 weight
// percent ... past the 70 percent anything is actually run at": a refusal
// whose own numbers say nothing was exceeded. One decimal narrows that
// collision by ten rather than closing it (the 0.05 above the limit still
// prints as the limit), and the fixture sits clear of the residue.
describe('the inhibitor refusal prints a concentration off its own limit', () => {
  test('a concentration past the practical maximum does not print as the maximum', () => {
    const inh = inhibitor('methanol');
    // Hammerschmidt is invertible, so the subcooling that needs exactly
    // 70.25 weight percent is a closed form rather than a fitted number.
    const subcoolingF = hammerschmidtDepression({
      weightPct: MAX_PRACTICAL_WT_PCT + 0.25,
      molecularWeight: inh.molecularWeight,
      k: inh.k,
    });
    // ITEM 48. The ceiling is applied to the concentration in the
    // coordinates the design is judged in, so the subcooling that lands
    // a quarter of a percent past it is the one the BINDING relation
    // puts there, not the one Hammerschmidt does.
    const subcoolingNb = nielsenBucklinDepression({
      weightPct: MAX_PRACTICAL_WT_PCT + 0.25,
      molecularWeight: inh.molecularWeight,
    });
    const r = inhibitionRequirement({
      subcoolingF: subcoolingNb, waterRateBpd: 200, inhibitorId: 'methanol',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('pastPracticalCeiling');
    expect(r.weightPct).toBeGreaterThan(MAX_PRACTICAL_WT_PCT + 0.05);
    expect(r.weightPct).toBeLessThan(MAX_PRACTICAL_WT_PCT + 0.5);
    expect(r.error).toMatch(/70\.3 weight percent/);
    expect(r.error).not.toMatch(/\b70 weight percent\b/);
    expect(r.error).toContain('past the 70 percent');   // the limit is untouched
    // and the same subcooling read in Hammerschmidt coordinates sits
    // well inside the ceiling, which is how it used to pass
    expect(weightPctForDepression({
      depressionF: subcoolingNb, molecularWeight: inh.molecularWeight, k: inh.k,
    })).toBeLessThan(MAX_PRACTICAL_WT_PCT);
  });
});

// ---------------------------------------------------------------------------
// Wave 1 gates. Refusals, renames and wording. Every test below fails against
// the code as it stood before the wave, and NONE of them moves a number: the
// golden assertions above are the proof of that and they are untouched.
// ---------------------------------------------------------------------------

describe('item 51: a mass that cannot be read is refused, not counted as zero', () => {
  const contentsMass = contentsMassLbPerFt({ idIn: 6.065, densityLbFt3: 55 });
  const shellMass = pipeMassLbPerFt({ idIn: 6.065, odIn: 6.625 });
  const base = {
    uBtuHrFt2F: 1.33, idIn: 6.065, startTempF: 150, ambientTempF: 40, targetTempF: 70,
  };

  test('a NaN mass in one slot refuses instead of quietly dropping that slot', () => {
    // The slots were read as `(x?.massLbPerFt || 0)` and NaN is falsy, so a
    // NaN mass became a zero mass: ok true, a full station table, and a
    // cooldown short by exactly that slot's share of M Cp. Nothing in the
    // return was countable, so the loss could not be found at any effort.
    const bad = cooldownTime({
      ...base,
      contents: { massLbPerFt: contentsMass, cpBtuLbF: 0.5 },
      shell: { massLbPerFt: NaN, cpBtuLbF: 0.11 },
    });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('massNotNumeric');
    expect(bad.error).toMatch(/shell/);
    expect(bad.hours).toBeUndefined();
    expect(bad.stations).toBeUndefined();
    // and this is the answer it used to give instead: a real number, 14
    // percent short, indistinguishable from a correct one.
    const asZero = cooldownTime({
      ...base,
      contents: { massLbPerFt: contentsMass, cpBtuLbF: 0.5 },
      shell: { massLbPerFt: 0, cpBtuLbF: 0.11 },
    });
    expect(asZero.ok).toBe(true);
    expect(asZero.hours).toBeLessThan(cooldownTime({
      ...base,
      contents: { massLbPerFt: contentsMass, cpBtuLbF: 0.5 },
      shell: { massLbPerFt: shellMass, cpBtuLbF: 0.11 },
    }).hours);
  });

  test('a slot left out altogether is the same defect and is refused too', () => {
    const noShell = cooldownTime({
      ...base, contents: { massLbPerFt: contentsMass, cpBtuLbF: 0.5 },
    });
    expect(noShell.ok).toBe(false);
    expect(noShell.code).toBe('massNotNumeric');
    const noCp = cooldownTime({
      ...base,
      contents: { massLbPerFt: contentsMass },
      shell: { massLbPerFt: shellMass, cpBtuLbF: 0.11 },
    });
    expect(noCp.ok).toBe(false);
    expect(noCp.code).toBe('massNotNumeric');
    expect(noCp.error).toMatch(/contents/);
  });

  test('the mass helpers hand back a refusal rather than a NaN', () => {
    const pipe = pipeMassLbPerFt({ idIn: 7, odIn: 6 });
    expect(pipe.ok).toBe(false);
    expect(pipe.code).toBe('pipeGeometryInvalid');
    expect(pipe.error).toMatch(/inside diameter was 7/);
    expect(pipeMassLbPerFt({ idIn: 6.065, odIn: undefined }).code)
      .toBe('pipeGeometryInvalid');
    expect(pipeMassLbPerFt({ idIn: 6.065, odIn: 6.625, densityLbFt3: NaN }).code)
      .toBe('densityInvalid');
    const contents = contentsMassLbPerFt({ idIn: 6.065, densityLbFt3: NaN });
    expect(contents.ok).toBe(false);
    expect(contents.code).toBe('contentsGeometryInvalid');
    // and a readable geometry still returns the plain number it always did
    expect(typeof shellMass).toBe('number');
    expect(typeof contentsMass).toBe('number');
    // a refusal passed straight into a mass slot is named as a refusal
    // rather than printed as "[object Object]"
    const passedThrough = cooldownTime({
      ...base,
      contents: { massLbPerFt: contentsMass, cpBtuLbF: 0.5 },
      shell: { massLbPerFt: pipeMassLbPerFt({ idIn: 7, odIn: 6 }), cpBtuLbF: 0.11 },
    });
    expect(passedThrough.code).toBe('massNotNumeric');
    expect(passedThrough.error).toContain('a refusal (pipeGeometryInvalid)');
    expect(passedThrough.error).not.toContain('[object Object]');
  });
});

describe('item 52: the cooldown header no longer claims what its own case denies', () => {
  test('the header says a significant share, which is what the numbers show', () => {
    // the header is prose wrapped across lines, so compare it unwrapped
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'engines', 'production', 'flowlineThermal.js'),
      'utf8',
    ).replace(/\n\s*\*\s?/g, ' ');
    expect(src).toContain('the steel can carry a significant share of the heat');
    expect(src).not.toContain('as much heat as the oil in it');
  });

  test('the share the module actually computes is significant and is not all of it', () => {
    // The old header said the steel could hold AS MUCH heat as the oil. On
    // the module's own 6 inch case it holds about a seventh of it, which is
    // worth carrying and is not parity, and the header now says so.
    const contentsMcp = contentsMassLbPerFt({ idIn: 6.065, densityLbFt3: 55 }) * 0.5;
    const shellMcp = pipeMassLbPerFt({ idIn: 6.065, odIn: 6.625 }) * 0.11;
    expect(shellMcp / contentsMcp).toBeGreaterThan(0.05);
    expect(shellMcp / contentsMcp).toBeLessThan(0.5);
  });
});

describe('item 54: a missing subcooling is not a zero subcooling', () => {
  test('no subcooling at all is refused, not answered "no inhibitor is needed"', () => {
    // `!(need > 0)` and `!(NaN > 0)` are both true, so the call fell into the
    // nothing-to-do branch: ok true, required false, and a note reading
    // "The fluid sits outside the hydrate region by NaN F."
    const r = inhibitionRequirement({ waterRateBpd: 200 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('subcoolingNotNumeric');
    expect(r.required).toBeUndefined();
    expect(r.note).toBeUndefined();
    expect(r.error).not.toMatch(/No inhibitor is needed/);
    expect(r.error).not.toMatch(/outside the hydrate region/);
    expect(r.error).not.toMatch(/NaN/);
    expect(r.error).toMatch(/subcooling was undefined/);
  });

  test('null, a string and a non-finite margin are refused at the door too', () => {
    expect(inhibitionRequirement({ subcoolingF: null, waterRateBpd: 200 }).code)
      .toBe('subcoolingNotNumeric');
    expect(inhibitionRequirement({ subcoolingF: '12', waterRateBpd: 200 }).code)
      .toBe('subcoolingNotNumeric');
    const badMargin = inhibitionRequirement({
      subcoolingF: 12, safetyMarginF: undefined, waterRateBpd: 200,
    });
    // an omitted margin still defaults to zero and designs
    expect(badMargin.ok).toBe(true);
    expect(inhibitionRequirement({
      subcoolingF: 12, safetyMarginF: NaN, waterRateBpd: 200,
    }).code).toBe('subcoolingNotNumeric');
  });

  test('a real subcooling of zero or below still answers, because that is an answer', () => {
    const r = inhibitionRequirement({ subcoolingF: -5, waterRateBpd: 200 });
    expect(r.ok).toBe(true);
    expect(r.required).toBe(false);
    expect(r.note).toMatch(/outside the hydrate region by 5\.0 F/);
  });
});

describe('items 55, 57 and 61: both relations for every fluid, and an honest field name', () => {
  test('Nielsen-Bucklin is computed for the glycols and matches the golden', () => {
    // It was suppressed for every fluid but methanol, which threw away the
    // one number that says how far Hammerschmidt is being pushed. The
    // relation is a function of the water mole fraction, so it is the same
    // number for a glycol, and the golden has carried it all along.
    const glycolRows = G.inhibition.filter((row) => row.inhibitor !== 'methanol');
    expect(glycolRows.length).toBeGreaterThan(0);
    glycolRows.forEach((row) => {
      const d = depression({ weightPct: row.weightPct, inhibitorId: row.inhibitor });
      expect(d.nielsenBucklinF).not.toBeNull();
      expect(rel(d.nielsenBucklinF, row.nielsenBucklinF)).toBeLessThan(1e-9);
      expect(rel(d.hammerschmidtF, row.hammerschmidtF)).toBeLessThan(5e-4);
    });
  });

  test('`reliable` is gone and `withinHammerschmidtRange` says what it measures', () => {
    // The old name read as a claim about the accuracy of the answer. It only
    // ever tested the concentration against a fixed weight percent.
    INHIBITORS.forEach((inh) => {
      const d = depression({ weightPct: 40, inhibitorId: inh.id });
      expect(d.reliable).toBeUndefined();
      expect(d.withinHammerschmidtRange).toBe(false);
      expect(depression({ weightPct: 20, inhibitorId: inh.id }).withinHammerschmidtRange)
        .toBe(true);
    });
  });

  test('spreadF comes back for every fluid, so a caller can set a real threshold', () => {
    // spreadF was null for three of the four inhibitors, so the only
    // quantity a caller could put a threshold on did not exist for them.
    INHIBITORS.forEach((inh) => {
      const d = depression({ weightPct: 40, inhibitorId: inh.id });
      expect(Number.isFinite(d.spreadF)).toBe(true);
      expect(d.spreadF).toBeCloseTo(Math.abs(d.hammerschmidtF - d.nielsenBucklinF), 12);
      expect(d.spreadF).toBeGreaterThan(0);
    });
    // and the gap widens with concentration, which is what makes it a
    // measure of how far the relation is being pushed
    expect(depression({ weightPct: 50, inhibitorId: 'meg' }).spreadF)
      .toBeGreaterThan(depression({ weightPct: 10, inhibitorId: 'meg' }).spreadF);
  });

  test('item 59 moved which relation the answer is taken from, for every fluid', () => {
    // Wave 1 reported both relations for every fluid and left the
    // recommendation where it was. Item 59 takes the lower of the two
    // everywhere, which on these four inhibitors is Nielsen-Bucklin at
    // every concentration, because it sits below Hammerschmidt from the
    // first weight percent up.
    ['methanol', 'meg', 'deg', 'teg'].forEach((id) => {
      const d = depression({ weightPct: 40, inhibitorId: id });
      expect(d.basis).toBe('nielsenBucklin');
      expect(d.recommendedF).toBe(d.nielsenBucklinF);
      expect(d.nielsenBucklinF).toBeLessThan(d.hammerschmidtF);
      // dilute too, where the two are within a percent of each other
      const dilute = depression({ weightPct: 5, inhibitorId: id });
      expect(dilute.basis).toBe('nielsenBucklin');
      expect(dilute.spreadF / dilute.hammerschmidtF).toBeLessThan(0.03);
    });
  });
});

describe('item 56: a half specified pressure does not fake a pressure column', () => {
  const common = {
    lengthFt: 26400, inletTempF: 180, ambientTempF: 40, massRateLbHr: 120000,
    cpBtuLbF: 0.5, uBtuHrFt2F: 1.33, idIn: 6.065, jtCoeffFPerPsi: 0.02,
  };

  test('an inlet with no outlet gives a NaN column and says the JT term was dropped', () => {
    // It used to return a column FLAT at the inlet with the JT term silently
    // zero, which destroyed the only tell there was. The asymmetry made it
    // worse: an inlet with no outlet is the likelier half to be given, and
    // it was the half that looked like an answer.
    const half = steadyStateProfile({ ...common, inletPsia: 1200 });
    expect(half.ok).toBe(true);
    expect(half.stations.every((st) => Number.isNaN(st.pPsia))).toBe(true);
    expect(half.note).toMatch(/Joule-Thomson term was not applied/);
    expect(half.note).toMatch(/inlet was 1200/);
    expect(half.note).toMatch(/outlet was undefined/);
    // no flat column at the inlet any more
    expect(half.stations.some((st) => st.pPsia === 1200)).toBe(false);
    // the temperatures are the no-pressure temperatures, which is what the
    // dropped JT term means and is now stated instead of implied
    const none = steadyStateProfile(common);
    expect(half.arrivalTempF).toBe(none.arrivalTempF);
    expect(none.note).toMatch(/Joule-Thomson term was not applied/);
  });

  test('an outlet with no inlet is refused the same way, and both pressures work', () => {
    const other = steadyStateProfile({ ...common, outletPsia: 400 });
    expect(other.stations.every((st) => Number.isNaN(st.pPsia))).toBe(true);
    expect(other.note).toMatch(/Joule-Thomson term was not applied/);
    const both = steadyStateProfile({ ...common, inletPsia: 1200, outletPsia: 400 });
    expect(both.note).toBeNull();
    expect(both.stations[0].pPsia).toBeCloseTo(1200, 9);
    expect(both.stations[both.stations.length - 1].pPsia).toBeCloseTo(400, 9);
    expect(both.arrivalTempF).toBeLessThan(other.arrivalTempF);
  });
});

describe('item 58: the layer stack is checked before it is summed', () => {
  test('a gap between two layers is refused rather than summed through', () => {
    const gap = overallU({
      layers: [{ idIn: 6.065, odIn: 6.625, k: 26 }, { idIn: 7.0, odIn: 8.625, k: 0.09 }],
      insideFilmH: 250, outsideFilmH: 200, referenceIdIn: 6.065,
    });
    expect(gap.ok).toBe(false);
    expect(gap.code).toBe('layersNotContiguous');
    expect(gap.error).toMatch(/gap/);
    expect(gap.error).toMatch(/6\.625/);
  });

  test('an overlap and a reversed stack are refused too', () => {
    const overlap = overallU({
      layers: [{ idIn: 6.065, odIn: 6.625, k: 26 }, { idIn: 6.4, odIn: 8.625, k: 0.09 }],
      insideFilmH: 250, outsideFilmH: 200,
    });
    expect(overlap.code).toBe('layersNotContiguous');
    expect(overlap.error).toMatch(/overlap/);
    // the same two layers listed inward instead of outward
    const reversed = overallU({
      layers: [LAYERS[1], LAYERS[0]], insideFilmH: 250, outsideFilmH: 200,
    });
    expect(reversed.ok).toBe(false);
    expect(reversed.code).toBe('layersNotContiguous');
  });

  test('a layer that does not grow outward, or is not numeric, names itself', () => {
    const inward = overallU({
      layers: [{ idIn: 6, odIn: 5, k: 26 }], insideFilmH: 250, outsideFilmH: 200,
    });
    expect(inward.code).toBe('layerNotOrdered');
    expect(inward.error).toMatch(/Layer 0/);
    const text = overallU({
      layers: [{ idIn: 6.065, odIn: '6.625', k: 26 }],
      insideFilmH: 250, outsideFilmH: 200,
    });
    expect(text.code).toBe('layerNotNumeric');
    expect(text.error).toMatch(/"6\.625"/);
    expect(overallU({ layers: [] }).code).toBe('noLayers');
    expect(overallU({
      layers: LAYERS, insideFilmH: 250, outsideFilmH: 200, referenceIdIn: NaN,
    }).code).toBe('referenceNotNumeric');
  });

  test('a contiguous stack still gives exactly the golden U', () => {
    // The check has to let the real stack through unchanged. This is the
    // wave 1 promise on this item.
    const u = overallU({
      layers: LAYERS, insideFilmH: 250, outsideFilmH: 200, referenceIdIn: 6.065,
    });
    expect(u.ok).toBe(true);
    // the same bar the golden gate above holds this number to
    expect(rel(u.uBtuHrFt2F, G.overallU.insulated)).toBeLessThan(1e-6);
  });
});

describe('item 60: the refusal names the direction a line cannot arrive in', () => {
  test('a target below ambient is refused with the physics the right way round', () => {
    // A cooling line approaches ambient from above, so it cannot arrive
    // BELOW it. The string said "above", which is the one direction it can
    // always arrive in, and three Expert lessons quote the sentence.
    const r = uForArrivalTemp({
      lengthFt: 26400, inletTempF: 180, ambientTempF: 40, targetTempF: 35,
      massRateLbHr: 120000, cpBtuLbF: 0.5, idIn: 6.065,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('targetBelowAmbient');
    expect(r.reason).toContain('A line cannot arrive below ambient (40 F)');
    expect(r.reason).not.toMatch(/arrive above ambient/);
    expect(r.reason).toContain('The target has to be above it.');
  });

  test('the ambient it quotes is the ambient it tested, not a rounded one', () => {
    // Rounding it printed "40 F" for an ambient of 40.4 beside a target of
    // 40.2, so the refusal's own numbers said nothing was wrong.
    const r = uForArrivalTemp({
      lengthFt: 26400, inletTempF: 180, ambientTempF: 40.4, targetTempF: 40.2,
      massRateLbHr: 120000, cpBtuLbF: 0.5, idIn: 6.065,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('40.4 F');
    expect(r.reason).not.toContain('(40 F)');
  });

  test('the cooldown note quotes its ambient unrounded for the same reason', () => {
    const cd = cooldownTime({
      contents: { massLbPerFt: contentsMassLbPerFt({ idIn: 6.065, densityLbFt3: 55 }), cpBtuLbF: 0.5 },
      shell: { massLbPerFt: pipeMassLbPerFt({ idIn: 6.065, odIn: 6.625 }), cpBtuLbF: 0.11 },
      uBtuHrFt2F: 1.33, idIn: 6.065, startTempF: 150, ambientTempF: 60.4, targetTempF: 60.2,
    });
    expect(cd.ok).toBe(true);
    expect(cd.hours).toBe(Infinity);
    expect(cd.note).toContain('60.4 F');
    expect(cd.note).not.toContain('(60 F)');
  });
});

describe('no engine copy in this module carries a double hyphen or a dash', () => {
  test('every error, reason, note and warning string is clean', () => {
    // Item 62. Only the string FIELDS are swept here; the prose in the
    // headers is not user-facing copy.
    const files = ['flowlineThermal.js', 'hydrateInhibition.js'];
    files.forEach((name) => {
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'engines', 'production', name), 'utf8',
      );
      src.split('\n').forEach((line) => {
        if (!/^\s*(error|reason|note|warning):/.test(line)) return;
        expect(line).not.toMatch(/--/);
        expect(line).not.toMatch(/[–—]/);
      });
    });
  });

  test('the practical-ceiling refusal reads as a sentence without the dashes', () => {
    const r = inhibitionRequirement({
      subcoolingF: 400, waterRateBpd: 200, inhibitorId: 'teg',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('pastPracticalCeiling');
    expect(r.error).not.toMatch(/--/);
    expect(r.error).toContain('a thermal or a dosing-strategy problem: insulation, heating, or displacing the line.');
    expect(r.error).toContain('It is not an inhibitor-concentration one.');
  });
});

// Item 48, the Joule-Thomson term against the oracle's integration, and
// items 48/53/59 on the concentration a depression actually needs.
describe('items 48, 53 and 59 against the oracle', () => {
  const g = G.profileWithJt;

  test('every Joule-Thomson case matches the RK4 march', () => {
    g.points.forEach((p) => {
      const prof = steadyStateProfile({
        lengthFt: p.lengthFt,
        inletTempF: g.inletTempF,
        ambientTempF: g.ambientTempF,
        massRateLbHr: g.massRateLbHr,
        cpBtuLbF: g.cpBtuLbF,
        uBtuHrFt2F: g.uBtuHrFt2F,
        idIn: g.idIn,
        inletPsia: 1200,
        outletPsia: 1200 - p.dpPsi,
        jtCoeffFPerPsi: p.jtCoeffFPerPsi,
        nStations: 3,
      });
      // the two Us are computed in different unit systems, so they meet
      // to about eight figures and the NTU with them
      expect(rel(prof.ntu, p.ntu)).toBeLessThan(1e-7);
      expect(rel(prof.jtDampingFactor, p.dampingFactor)).toBeLessThan(1e-7);
      // the closed form the engine ships against the oracle's march of
      // the same differential equation
      expect(Math.abs(prof.arrivalTempF - p.arrivalTempF)).toBeLessThan(1e-4);
    });
  });

  test('the undamped term cooled the arrival far below ambient, and the damped one barely does', () => {
    // Joule-Thomson cooling is a source term, so a line CAN arrive below
    // ambient: the fluid is being cooled as it goes. The question is by
    // how much. On the longest case, 105,600 ft at NTU 3.7, the damped
    // arrival sits 0.8 F under the 40 F seabed and the old linear term
    // put it 12.6 F under, which is most of the way to the hydrate
    // verdict on a line like this.
    const longest = g.points.reduce((a, b) => (b.lengthFt > a.lengthFt ? b : a), g.points[0]);
    expect(g.ambientTempF - longest.arrivalTempF).toBeLessThan(1);
    expect(g.ambientTempF - longest.undampedArrivalTempF).toBeGreaterThan(12);
    expect(longest.arrivalTempF - longest.undampedArrivalTempF).toBeGreaterThan(11);
  });

  test('the concentration a depression needs is inverted through the binding relation', () => {
    G.requiredConcentration.forEach((c) => {
      const r = inhibitionRequirement({
        subcoolingF: c.neededDepressionF, waterRateBpd: 200, inhibitorId: c.inhibitor,
      });
      expect(rel(r.weightPctByHammerschmidt, c.weightPctByHammerschmidt)).toBeLessThan(1e-9);
      expect(rel(r.weightPctByNielsenBucklin, c.weightPctByNielsenBucklin)).toBeLessThan(1e-9);
      expect(rel(r.weightPct, c.weightPct)).toBeLessThan(1e-9);
      expect(r.weightPctBasis).toBe(c.weightPctBasis);
      if (c.weightPct > MAX_PRACTICAL_WT_PCT) {
        // ITEM 48. The ceiling is applied in the coordinates the design
        // is judged in, so DEG and TEG at 45 F now refuse: 70.98 and
        // 77.58 weight percent. Through Hammerschmidt alone they were
        // 67.16 and 74.32, so the DEG case USED TO PASS, at a
        // concentration that would have delivered 38.6 F of the 45 F it
        // was asked for.
        expect(r.ok).toBe(false);
        expect(r.code).toBe('pastPracticalCeiling');
        return;
      }
      expect(r.ok).toBe(true);
      // item 53's invariant: what the design will be judged on is never
      // short of what it was asked for
      expect(rel(r.depressionCheck.recommendedF, c.recommendedFAtThatConcentration))
        .toBeLessThan(1e-9);
      expect(r.depressionCheck.recommendedF).toBeGreaterThanOrEqual(
        c.neededDepressionF - 1e-9,
      );
    });
  });

  test('the old Hammerschmidt-only concentration came up short, and the golden says by how much', () => {
    // MEG asked for 45 F: 54.5 weight percent through Hammerschmidt,
    // which delivers 38.6 F on the relation the design is judged by. A
    // 6.4 F shortfall on a hydrate design, inside the practical ceiling,
    // and nothing refused it.
    const meg45 = G.requiredConcentration.find(
      (c) => c.inhibitor === 'meg' && c.neededDepressionF === 45,
    );
    expect(meg45.recommendedFAtHammerschmidtConcentration).toBeLessThan(39);
    expect(meg45.recommendedFAtThatConcentration).toBeCloseTo(45, 9);
    expect(meg45.weightPct - meg45.weightPctByHammerschmidt).toBeGreaterThan(4);
    // every case in the table is short the old way and exact the new way
    G.requiredConcentration.forEach((c) => {
      expect(c.recommendedFAtHammerschmidtConcentration).toBeLessThanOrEqual(
        c.neededDepressionF + 1e-9,
      );
      expect(c.recommendedFAtThatConcentration).toBeCloseTo(c.neededDepressionF, 9);
    });
  });

  test('a shortfall that reaches the check is refused, and the door says so', () => {
    // The branch cannot fire for the four shipped inhibitors, because
    // the concentration is inverted through the binding relation. What
    // is gated here is the invariant it exists to protect, over a grid.
    ['methanol', 'meg', 'deg', 'teg'].forEach((id) => {
      [2, 8, 15, 25, 35].forEach((subcoolingF) => {
        const r = inhibitionRequirement({ subcoolingF, waterRateBpd: 100, inhibitorId: id });
        if (!r.ok) return;
        expect(r.depressionCheck.recommendedF).toBeGreaterThanOrEqual(subcoolingF - 1e-9);
      });
    });
    // and the code exists on the shape a caller can test
    expect(inhibitionRequirement({ subcoolingF: NaN, waterRateBpd: 100 }).code)
      .toBe('subcoolingNotNumeric');
  });
});

// Item 48, the two thermal refusals.
describe('item 48: a resistance that cannot be formed is not an omitted one', () => {
  const layers = [
    { idIn: 6.065, odIn: 6.625, k: 26 },
    { idIn: 6.625, odIn: 8.625, k: 0.09 },
  ];

  test('an unreadable film refuses instead of being dropped', () => {
    const bad = overallU({ layers, insideFilmH: NaN, outsideFilmH: 200, referenceIdIn: 6.065 });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('filmNotNumeric');
    expect(bad.error).toMatch(/inside film coefficient/);
    // an ABSENT film still omits the term, which is the convention
    const omitted = overallU({ layers, outsideFilmH: 200, referenceIdIn: 6.065 });
    expect(omitted.ok).toBe(true);
    expect(omitted.resistances.some((r) => r.id === 'insideFilm')).toBe(false);
    // and a zero one omits it too
    expect(overallU({ layers, insideFilmH: 0, outsideFilmH: 200, referenceIdIn: 6.065 }).ok)
      .toBe(true);
  });

  test('a half specified burial refuses rather than surfacing the line', () => {
    const bad = overallU({
      layers, insideFilmH: 250, outsideFilmH: 200, burialFt: 4, referenceIdIn: 6.065,
    });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('burialNotNumeric');
    expect(bad.error).toMatch(/soil conductivity/);
    // both given and readable is the buried line, and it is a real
    // resistance: burying this line drops U by a fifth
    const buried = overallU({
      layers, insideFilmH: 250, outsideFilmH: 200, burialFt: 4, kSoil: 1.2, referenceIdIn: 6.065,
    });
    const bare = overallU({
      layers, insideFilmH: 250, outsideFilmH: 200, referenceIdIn: 6.065,
    });
    expect(buried.ok).toBe(true);
    expect(buried.uBtuHrFt2F).toBeLessThan(bare.uBtuHrFt2F);
  });

  test('a cooldown that starts below its own target is refused, not answered with no time', () => {
    const args = {
      contents: { massLbPerFt: 10, cpBtuLbF: 0.5 },
      shell: { massLbPerFt: 30, cpBtuLbF: 0.11 },
      uBtuHrFt2F: 1.33, idIn: 6.065, ambientTempF: 40,
    };
    const bad = cooldownTime({ ...args, startTempF: 60, targetTempF: 70 });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('startBelowTarget');
    expect(bad.error).toMatch(/already at or below/);
    // exactly at the target is the same statement
    expect(cooldownTime({ ...args, startTempF: 70, targetTempF: 70 }).code)
      .toBe('startBelowTarget');
    // and a real cooldown still answers
    expect(cooldownTime({ ...args, startTempF: 150, targetTempF: 70 }).ok).toBe(true);
  });
});
