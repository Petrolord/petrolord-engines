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
    // exactly the coefficient times the pressure drop
    expect(noJt.arrivalTempF - withJt.arrivalTempF).toBeCloseTo(0.02 * 800, 6);
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
    expect(belowAmbient.reason).toMatch(/cannot arrive above ambient/);
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
    expect(pipeMassLbPerFt({ idIn: 7, odIn: 6 })).toBeNaN();
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
    // and the basis switches where Hammerschmidt stops being trusted
    expect(low.basis).toBe('hammerschmidt');
    expect(low.reliable).toBe(true);
    expect(high.basis).toBe('nielsenBucklin');
    expect(high.reliable).toBe(false);
    expect(high.note).toMatch(/over-predicts/);
    expect(HAMMERSCHMIDT_RELIABLE_WT_PCT).toBe(25);
  });

  test('a glycol pushed past the band says so rather than switching to a relation it does not fit', () => {
    // Nielsen-Bucklin was developed for methanol. Using it on MEG
    // because Hammerschmidt ran out would be substituting one wrong
    // answer for another.
    const d = depression({ weightPct: 45, inhibitorId: 'meg' });
    expect(d.nielsenBucklinF).toBeNull();
    expect(d.basis).toBe('hammerschmidt');
    expect(d.note).toMatch(/developed for methanol/);
    expect(d.note).toMatch(/optimistic/);
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
    // The concentration it picked really does give the depression asked for.
    expect(rel(r.depressionCheck.hammerschmidtF, 15)).toBeLessThan(1e-9);
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
    const r = inhibitionRequirement({
      subcoolingF, waterRateBpd: 200, inhibitorId: 'methanol',
    });
    expect(r.ok).toBe(false);
    expect(r.weightPct).toBeGreaterThan(MAX_PRACTICAL_WT_PCT + 0.05);
    expect(r.weightPct).toBeLessThan(MAX_PRACTICAL_WT_PCT + 0.5);
    expect(r.error).toMatch(/70\.3 weight percent/);
    expect(r.error).not.toMatch(/\b70 weight percent\b/);
    expect(r.error).toContain('past the 70 percent');   // the limit is untouched
  });
});
