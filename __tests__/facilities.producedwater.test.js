// Facilities F7 produced-water gates against
// tools/validation/facilities/oracle_producedwater.py.
//
// WHAT THIS GATE IS FOR. Before FC7-0, sixteen of twenty-seven defects
// planted in this engine alone left this suite 20 of 20 green, and six
// of eight planted in the engine and the oracle together did too,
// because five of the six golden groups were transcriptions of the
// engine's own arithmetic. Three of the six devices, the whole train,
// both droplet medians and the oil density had no route in the oracle
// at all, and no golden row carried a single warning, a single stage
// field or a single train summary field.
//
// Three things run here, and they are not the same thing:
//
//  1. VALIDATION. A route in the oracle that shares no expression with
//     the engine: the creeping-flow force balance solved numerically
//     instead of a typed 18, a droplet trajectory marched through the
//     basin instead of the Hazen inversion, a radial march through the
//     liner, the attachment ODE, the bed marched layer by layer, the
//     whole train by particle tracking, and the C library's erf.
//  2. IDENTITIES. Things that are true by definition and can be
//     asserted without any source: half the volume is removed at the
//     cut size, the volume median of a log-normal is its own d50, the
//     truncated tail is 2 Phi(-span), and at equal total gas and equal
//     total volume the number of flotation cells cannot matter.
//  3. PINS. DECLARED_CONSTANTS, checked against literals typed here.
//     A PIN IS NOT A VALIDATION. None of those numbers has a
//     publication in this repository, the oracle holds its own second
//     copy of each so that moving one in both files still fails here,
//     and nothing downstream may present a pinned number as published.
//
// Every gate below says what it examined, refuses when the golden
// group it needs is missing rather than passing vacuously, and names
// the case it failed on. Every family also carries a NEGATIVE CONTROL
// that proves the gate fires at the tolerance it claims.

import fs from 'fs';
import path from 'path';
import {
  DECLARED_CONSTANTS, API_421, CONCENTRATION_BASIS, DISSOLVED_OIL_NOTE,
  waterViscosityPaS, waterDensityKgM3, oilDensityKgM3,
  logNormalCdf, dropletBins, gradeEfficiency, applyDevice, medianOfBins,
  stokesRiseMS, terminalRiseMS, apiSeparator, plateInterceptor, hydrocyclone,
  flotation, mediaFilter, treatmentTrain,
} from '../engines/facilities/producedWater';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'facilities', 'goldens', 'producedwater_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-30);

/**
 * Run one comparison over a golden group.
 *
 * Refuses if the group is missing or has shrunk, so a gate can never
 * pass because the cases it was meant to examine went away, and names
 * every case it failed on.
 */
const gate = (name, rows, minRows, fn) => {
  if (!Array.isArray(rows)) throw new Error(`${name}: the golden group is missing entirely, so this gate cannot do its job`);
  if (rows.length < minRows) throw new Error(`${name}: the golden carries ${rows.length} cases and this gate needs at least ${minRows}`);
  const failures = [];
  rows.forEach((row, i) => {
    const msg = fn(row, i);
    if (msg) failures.push(`  ${name}[${i}] ${msg}`);
  });
  if (failures.length) {
    throw new Error(`${name}: ${failures.length} of ${rows.length} cases failed\n${failures.join('\n')}`);
  }
  return rows.length;
};

/** One field comparison, returning the sentence that names the case. */
const near = (label, got, want, tol, kind = 'rel') => {
  const d = kind === 'rel' ? rel(got, want) : Math.abs(got - want);
  if (!(d <= tol)) return `${label}: engine ${got} against oracle ${want}, ${kind} gap ${d.toExponential(3)} over ${tol}`;
  return null;
};

const first = (...msgs) => msgs.find(Boolean) || null;

/** A negative control must FIRE, and must name the case when it does. */
const controlFires = (fn) => {
  let message = null;
  try {
    fn();
  } catch (e) {
    message = e.message;
  }
  return message;
};

/* ================================================================== *
 * 1. The pins
 * ================================================================== */

describe('the declared constants: a pin, and not a validation', () => {
  // Typed here, by hand, on purpose. The oracle holds its own second
  // copy, so bending one of these in BOTH files still fails this test.
  // None of these numbers is published in this repository and nothing
  // downstream may present one as though it were.
  const PINNED = {
    vogelA: 2.414e-5, vogelB: 247.8, vogelC: 140,
    salinityViscosityMultiplier: 1.8,
    brineDensitySlopeKgM3: 700,
    crudeThermalExpansionPerC: 0.0007,
    crudeReferenceWaterKgM3: 999.0,
    defaultNBins: 60, defaultSpanSigma: 4,
    defaultSharpness: 3, interceptionSharpness: 2,
    interceptionCoefficient: 1.5,
    shortCircuitFDefault: 1.5, plateEfficiencyFactor: 0.7,
    linerDiameterM: 0.035, linerLengthM: 0.7,
    designFlowPerLinerM3S: 0.0006, gFieldAtDesign: 1000,
    coreRadiusFraction: 0.5,
    starvedTurndown: 0.5, overloadTurndown: 1.3, maxTurndown: 2.0,
    flotationCellDepthM: 3, flotationGasDensityKgM3: 1.2,
    bubbleMicronDefault: 300, gasRatioDefault: 0.2, gasRatioMax: 3,
    bubbleMicronMin: 20, bubbleMicronMax: 2000,
    attachmentEfficiency: 0.01,
    gasHoldupWarn: 0.2, coarseCutWarnMicron: 100,
    flotationResidenceWarnS: 60,
    filterCoefficientPerM: 3.5, filterReferenceLoadingMHr: 10,
    filterLoadingExponent: 0.5, filterReferenceDropletMicron: 20,
    filterReferenceMediaMicron: 800, filterBreakthroughLoadingMHr: 25,
    filterBedDepthDefaultM: 0.9, filterMinLoadingMHr: 1,
    stokesReynoldsLimit: 1,
    waterViscosityMinC: -10, waterViscosityMaxC: 200,
    waterDensityMinC: 0, waterDensityMaxC: 100,
    tdsMaxPpm: 300000,
    apiGravityMin: 5, apiGravityMax: 100,
    sigmaMax: 2, sigmaCustomaryMin: 0.5, sigmaCustomaryMax: 1.0,
    minNBins: 10, minSpanSigma: 3,
    trainSigmaDefault: 0.7,
  };

  test('every declared constant holds its pinned value, and the set is closed', () => {
    expect(Object.keys(DECLARED_CONSTANTS).sort()).toEqual(Object.keys(PINNED).sort());
    const wrong = Object.keys(PINNED)
      .filter((k) => DECLARED_CONSTANTS[k] !== PINNED[k])
      .map((k) => `${k}: engine ${DECLARED_CONSTANTS[k]} against the pin ${PINNED[k]}`);
    expect(wrong.join('\n')).toBe('');
    expect(Object.isFrozen(DECLARED_CONSTANTS)).toBe(true);
  });

  test('the API 421 half-rule is pinned too, limit and all', () => {
    expect(API_421.horizontalVelocityLimitMS).toBe(0.015);
    expect(API_421.shortCircuitCustomaryMin).toBe(1.3);
    expect(API_421.shortCircuitCustomaryMax).toBe(1.8);
    expect(API_421.shortCircuitMax).toBe(5);
    expect(Object.isFrozen(API_421)).toBe(true);
  });

  test('the oracle holds its own copy, and it agrees with the engine', () => {
    // If this ever fails, the two files have drifted apart and the
    // golden was regenerated from arithmetic the engine does not run.
    expect(G.declaredConstants).toBeTruthy();
    const drift = Object.keys(G.declaredConstants)
      .filter((k) => DECLARED_CONSTANTS[k] !== G.declaredConstants[k])
      .map((k) => `${k}: engine ${DECLARED_CONSTANTS[k]} against oracle ${G.declaredConstants[k]}`);
    expect(drift.join('\n')).toBe('');
  });

  test('NEGATIVE CONTROL: the pin fires on a moved constant, and names it', () => {
    const msg = controlFires(() => {
      const wrong = Object.keys({ salinityViscosityMultiplier: 1.8 })
        .filter(() => DECLARED_CONSTANTS.salinityViscosityMultiplier !== 2.5)
        .map((k) => `${k}: engine ${DECLARED_CONSTANTS[k]} against the pin 2.5`);
      if (wrong.length) throw new Error(wrong.join('\n'));
    });
    expect(msg).toMatch(/salinityViscosityMultiplier: engine 1\.8 against the pin 2\.5/);
  });

  test('FC7-1: every threshold a device decides on is IN here, and the source carries none', () => {
    // FC7-0 declared forty-nine constants and then decided the
    // flotation residence warning on a BARE 60 inlined in the warning
    // sentence, which was the one device threshold in the module that
    // was not declared, against the module's own stated doctrine. The
    // grid's own two floors were bare in the same way. A threshold
    // nobody can find is a threshold nobody reviews.
    expect(DECLARED_CONSTANTS.flotationResidenceWarnS).toBe(60);
    expect(DECLARED_CONSTANTS.filterMinLoadingMHr).toBe(1);
    expect(DECLARED_CONSTANTS.minNBins).toBe(10);
    expect(DECLARED_CONSTANTS.minSpanSigma).toBe(3);
    // the exact expressions that used to decide these four, scanned out
    // of the EXECUTABLE source with the comments stripped, because the
    // prose quotes every one of them on purpose: that is where the
    // record of the defect lives
    const code = fs.readFileSync(
      path.join(__dirname, '..', 'engines', 'facilities', 'producedWater.js'), 'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).toMatch(/flotationResidenceWarnS/);
    expect(code).not.toMatch(/residenceS\s*<\s*60/);
    expect(code).toMatch(/filterMinLoadingMHr/);
    expect(code).not.toMatch(/Math\.max\(loadingMHr/);
    expect(code).not.toMatch(/nBins\s*<\s*10\b/);
    expect(code).not.toMatch(/spanSigma\s*<\s*3\b/);
  });

  test('the module states what it does NOT know, in words a caller can read', () => {
    expect(API_421.velocityRuleComplete).toBe(false);
    expect(API_421.velocityRuleNote).toMatch(/not in this module because the standard is not in this repository/);
    expect(CONCENTRATION_BASIS).toMatch(/dimensionless/);
    expect(DISSOLVED_OIL_NOTE).toMatch(/dissolved and soluble oil/);
    // no discharge limit is stated anywhere in this module
    expect(JSON.stringify(DECLARED_CONSTANTS)).not.toMatch(/"[a-zA-Z]*[Ss]pec/);
  });
});

/* ================================================================== *
 * 2. Water and oil properties
 * ================================================================== */

describe('water and oil properties: the inputs the predecessor ignored', () => {
  test('viscosity and density reproduce the oracle over its whole band', () => {
    const n = gate('properties', G.properties, 6, (row) => {
      const mu = waterViscosityPaS(row);
      const rho = waterDensityKgM3(row);
      if (mu.error) return `refused a case the oracle answered: ${mu.error}`;
      if (rho.error) return `refused a case the oracle answered: ${rho.error}`;
      return first(
        near(`mu at ${row.tC} C, ${row.tdsPpm} ppm`, mu.muPaS, row.muPaS, 1e-9),
        near(`rho at ${row.tC} C, ${row.tdsPpm} ppm`, rho.rhoKgM3, row.rhoWater, 1e-9),
      );
    });
    expect(n).toBeGreaterThanOrEqual(6);
  });

  test('reproduces the textbook viscosity of water at 25 C', () => {
    // 0.890 cP is the published value and this is the one number in the
    // property fits that comes from outside this module
    expect(waterViscosityPaS({ tC: 25, tdsPpm: 0 }).muPaS * 1000).toBeCloseTo(0.890, 2);
  });

  test('hot water is thinner and brine is thicker, both by a lot', () => {
    const cold = waterViscosityPaS({ tC: 25, tdsPpm: 0 }).muPaS;
    const hot = waterViscosityPaS({ tC: 90, tdsPpm: 0 }).muPaS;
    expect(hot).toBeLessThan(cold / 2);
    const fresh = waterViscosityPaS({ tC: 50, tdsPpm: 0 }).muPaS;
    const brine = waterViscosityPaS({ tC: 50, tdsPpm: 200000 }).muPaS;
    expect(brine / fresh).toBeGreaterThan(1.3);
    expect(waterDensityKgM3({ tC: 50, tdsPpm: 200000 }).rhoKgM3)
      .toBeGreaterThan(waterDensityKgM3({ tC: 50, tdsPpm: 0 }).rhoKgM3);
  });

  test('oil density is CALLED, not fed back in as data', () => {
    // it used to appear in the golden and never be called: bending its
    // thermal expansion left the whole suite green
    const n = gate('oilDensity', G.oilDensity, 5, (row) => {
      const r = oilDensityKgM3(row);
      if (r.error) return `refused a case the oracle answered: ${r.error}`;
      return first(
        near(`rho at ${row.apiGravity} API, ${row.tC} C`, r.rhoKgM3, row.rhoOil, 1e-9),
        near(`sg60 at ${row.apiGravity} API`, r.sg60, row.sg60, 1e-12),
      );
    });
    expect(n).toBeGreaterThanOrEqual(5);
  });

  test('all three property functions refuse, by name, what they cannot answer', () => {
    // two of the three had no guard at all: water density answered at
    // 201 C where its neighbour refused, and an API gravity of -131.5
    // returned Infinity while -200 returned a NEGATIVE density
    expect(waterViscosityPaS({ tC: 300 }).error).toMatch(/-10 to 200 C and this is 300/);
    expect(waterDensityKgM3({ tC: 201 }).error).toMatch(/0 to 100 C and this is 201/);
    expect(waterDensityKgM3({ tC: -5 }).error).toBeTruthy();
    expect(oilDensityKgM3({ apiGravity: -131.5, tC: 50 }).error).toMatch(/API gravity/);
    expect(oilDensityKgM3({ apiGravity: -200, tC: 50 }).error).toMatch(/API gravity/);
    expect(oilDensityKgM3({ apiGravity: 32, tC: 500 }).error).toBeTruthy();
    // the TDS clamp is a refusal now, not a silent rewrite: 300000,
    // 400000 and 1000000 used to return the same number to twelve digits
    expect(waterViscosityPaS({ tC: 50, tdsPpm: 400000 }).error).toMatch(/300000 ppm TDS and this is 400000/);
    expect(waterViscosityPaS({ tC: 50, tdsPpm: -1 }).error).toMatch(/cannot be negative/);
    expect(waterDensityKgM3({ tC: 50, tdsPpm: 1e6 }).error).toBeTruthy();
    expect(waterViscosityPaS({ tC: 50, tdsPpm: 300000 }).error).toBeUndefined();
  });

  test('NEGATIVE CONTROL: the property gate fires on a one part in a million error', () => {
    const msg = controlFires(() => gate('properties', G.properties, 6, (row) => near(
      `mu at ${row.tC} C`, waterViscosityPaS(row).muPaS * (1 + 1e-6), row.muPaS, 1e-9,
    )));
    expect(msg).toMatch(/properties\[0\] mu at 25 C: engine .* rel gap .* over 1e-9/);
  });
});

/* ================================================================== *
 * 3. The droplet distribution
 * ================================================================== */

describe('the droplet distribution', () => {
  test('the series CDF matches the C library erf to the series own accuracy', () => {
    // A&S 7.1.26 is published to 1.5e-7 ABSOLUTE, so a relative check
    // on a tail probability of 2e-6 is checking the wrong thing
    const n = gate('cdf', G.cdf, 6, (row) => first(
      near(`cdf(${row.d} um, d50 ${row.d50}, sigma ${row.sigma})`, logNormalCdf(row), row.cdf, 1.5e-7, 'abs'),
      row.cdf > 1e-3
        ? near(`cdf(${row.d} um) relative`, logNormalCdf(row), row.cdf, 1e-6)
        : null,
    ));
    expect(n).toBeGreaterThanOrEqual(6);
  });

  test('the bin grid: the truncated tail is 2 Phi(-span) and the median is the d50', () => {
    // both are identities, so neither needs a source. The tail is what
    // makes spanSigma visible to this gate at all: it used to be able
    // to move from 4 to 3 with the suite fully green
    const n = gate('binGrid', G.binGrid, 4, (row) => {
      const b = dropletBins({
        d50: row.d50, sigma: row.sigma, nBins: row.nBins, spanSigma: row.spanSigma,
      });
      if (b.error) return `refused a case the oracle answered: ${b.error}`;
      const total = b.bins.reduce((s, x) => s + x.volumeFraction, 0);
      // and the median must be the INTERPOLATED route and not the
      // quantised one. The oracle carries the midpoint answer for the
      // same grid, built from its own erf cdf, because both routes are
      // "close to the d50" and only the gap tells them apart: 3e-9
      // interpolated against 1.7 to 8.9 percent quantised
      const got = medianOfBins(b.bins);
      const midpointGap = Math.abs(got - row.midpointMedianMicron) / row.midpointMedianMicron;
      return first(
        near(`truncated tail at span ${row.spanSigma}`, b.truncatedTailFraction, row.truncatedTailFraction, 1e-6, 'abs'),
        near(`the bin median at ${row.nBins} bins`, got, row.medianMicron, 1e-6),
        near(`normalisation at ${row.nBins} bins`, total, 1, 1e-12),
        midpointGap > 1e-2 ? null
          : `the bin median at ${row.nBins} bins is ${got}, within ${(midpointGap * 100).toFixed(4)} percent of the QUANTISED midpoint answer ${row.midpointMedianMicron}: this gate needs the two routes to be distinguishable and on this row they are not`,
        b.nBins === row.nBins ? null : `the grid it used (${b.nBins}) is not the grid it was asked for`,
      );
    });
    expect(n).toBeGreaterThanOrEqual(4);
  });

  test('FC7-1: the midpoint route is CLOSED, and bins with no edges get NaN', () => {
    // FC7-0 interpolated when the bin carried edges and fell back to
    // `b.dMicron` when it did not, which is a silent path back to the
    // quantised median it had just removed: the same 60-bin untreated
    // inlet answers 30.000000 um with edges and 28.632164 um without,
    // and nothing on the return said which route had run.
    const b = dropletBins({ d50: 30, sigma: 0.7 });
    expect(rel(medianOfBins(b.bins), 30)).toBeLessThan(1e-6);
    const midpointsOnly = b.bins.map(
      ({ dMicron, volumeFraction }) => ({ dMicron, volumeFraction }),
    );
    expect(Number.isNaN(medianOfBins(midpointsOnly))).toBe(true);
    // and specifically NOT the quantised number the fallback returned
    expect(medianOfBins(midpointsOnly)).not.toBeCloseTo(28.632164392009408, 6);
    // half a grid is no better than none: the check is UP FRONT, so the
    // answer cannot depend on where in a bad grid the median landed
    const oneBadBin = b.bins.map((x, i) => (i === 40 ? { ...x, dHiMicron: undefined } : x));
    expect(Number.isNaN(medianOfBins(oneBadBin))).toBe(true);
    const badBinBelowTheMedian = b.bins.map((x, i) => (i === 2 ? { ...x, dLoMicron: 0 } : x));
    expect(Number.isNaN(medianOfBins(badBinBelowTheMedian))).toBe(true);
    // every bin set this module makes carries edges, which is why no
    // in-module caller can reach the refusal
    b.bins.forEach((x) => {
      expect(x.dLoMicron).toBeGreaterThan(0);
      expect(x.dHiMicron).toBeGreaterThan(x.dLoMicron);
    });
    const applied = applyDevice({ bins: b.bins, d50cMicron: 12, sharpness: 3 });
    applied.outletBins.forEach((x) => expect(x.dHiMicron).toBeGreaterThan(x.dLoMicron));
  });

  test('NEGATIVE CONTROL: the median gate fires when the midpoint fallback comes back', () => {
    // the fallback, re-expressed here: the midpoint of the bin the
    // accumulated volume crosses one half in
    const midpointMedian = (bins) => {
      let acc = 0;
      for (const b of bins) {
        if (acc + b.volumeFraction >= 0.5) return b.dMicron;
        acc += b.volumeFraction;
      }
      return NaN;
    };
    const msg = controlFires(() => gate('binGrid', G.binGrid, 4, (row) => {
      const b = dropletBins({
        d50: row.d50, sigma: row.sigma, nBins: row.nBins, spanSigma: row.spanSigma,
      });
      return near(`the bin median at ${row.nBins} bins`, midpointMedian(b.bins), row.medianMicron, 1e-6);
    }));
    expect(msg).toMatch(/^binGrid: 5 of 5 cases failed$/m);
    expect(msg).toMatch(/binGrid\[0\] the bin median at 60 bins: engine 28\.63216\d+ against oracle 30, rel gap 4\.5\d+e-2 over 0?\.000001/);
  });

  test('the median no longer depends on the grid it is measured on', () => {
    // it used to: 28.632 um on 60 bins and 27.34 um on 30, against a
    // typed d50 of 30, so the studio showed the median falling for a
    // train that had removed nothing
    [30, 60, 120, 600].forEach((nBins) => {
      const b = dropletBins({ d50: 30, sigma: 0.7, nBins });
      expect(rel(medianOfBins(b.bins), 30)).toBeLessThan(1e-6);
    });
  });

  test('grade efficiency is one half at the cut size, and refuses rather than reading zero', () => {
    expect(gradeEfficiency({ dMicron: 25, d50cMicron: 25 })).toBeCloseTo(0.5, 12);
    expect(gradeEfficiency({ dMicron: 25, d50cMicron: 25, sharpness: 2 })).toBeCloseTo(0.5, 12);
    expect(gradeEfficiency({ dMicron: 100, d50cMicron: 25 })).toBeGreaterThan(0.9);
    expect(gradeEfficiency({ dMicron: 5, d50cMicron: 25 })).toBeLessThan(0.05);
    // a device that is not there used to be indistinguishable from a
    // device that caught nothing
    expect(Number.isNaN(gradeEfficiency({ dMicron: 10, d50cMicron: NaN }))).toBe(true);
    expect(Number.isNaN(gradeEfficiency({ dMicron: 10, d50cMicron: -5 }))).toBe(true);
    expect(applyDevice({ bins: dropletBins({ d50: 30, sigma: 0.7 }).bins }).error)
      .toMatch(/positive cut size/);
  });

  test('FC7-1: the grid floors are the DECLARED ones, straddled either side', () => {
    // FC7-0 decided both on bare numbers inlined in their own refusals,
    // and nothing exercised a grid between the floor and the coarsest
    // the goldens use: the floor could be moved from 10 bins to 25, or
    // the span from 3 sigma to 3.5, with this suite fully green. Both
    // cases below are BUILT from the declared value, so an engine that
    // compares against any other number fails here.
    const { minNBins, minSpanSigma } = DECLARED_CONSTANTS;
    expect(dropletBins({ d50: 30, sigma: 0.7, nBins: minNBins }).error).toBeUndefined();
    expect(dropletBins({ d50: 30, sigma: 0.7, nBins: minNBins - 1 }).error)
      .toMatch(new RegExp(`at least ${minNBins}`));
    expect(dropletBins({ d50: 30, sigma: 0.7, spanSigma: minSpanSigma }).error).toBeUndefined();
    expect(dropletBins({ d50: 30, sigma: 0.7, spanSigma: minSpanSigma - 0.001 }).error)
      .toMatch(new RegExp(`at least ${minSpanSigma} sigma`));
    // and the refusal must quote the floor it was judged against rather
    // than a number of its own: a message that says 10 beside a
    // comparison that uses 25 is the defect, not the repair
    expect(dropletBins({ d50: 30, sigma: 0.7, nBins: 4 }).error).toMatch(new RegExp(`at least ${minNBins}, and this is 4`));
    expect(dropletBins({ d50: 30, sigma: 0.7, spanSigma: 1 }).error).toMatch(new RegExp(`at least ${minSpanSigma} sigma either side of the median and this spans 1`));
  });

  test('the distribution refuses the parameters it cannot describe', () => {
    expect(dropletBins({ d50: 0, sigma: 0.7 }).error).toMatch(/positive median diameter/);
    expect(dropletBins({ d50: 30, sigma: 0 }).error).toMatch(/positive log-standard-deviation/);
    expect(dropletBins({ d50: 30, sigma: 3 }).error).toMatch(/holds sigma to 2/);
    expect(dropletBins({ d50: 30, sigma: 0.7, nBins: 5 }).error).toMatch(/at least 10/);
    expect(dropletBins({ d50: 30, sigma: 0.7, spanSigma: 2 }).error).toMatch(/at least 3 sigma/);
    // in band but outside what produced water is customarily described
    // with: a warning, not a refusal
    expect(dropletBins({ d50: 30, sigma: 1.5 }).warning).toMatch(/outside the 0.5 to 1/);
    expect(dropletBins({ d50: 30, sigma: 0.7 }).warning).toBeNull();
  });

  test('NEGATIVE CONTROL: the tail gate fires when the bin span moves', () => {
    const msg = controlFires(() => gate('binGrid', G.binGrid, 4, (row) => near(
      `truncated tail at span ${row.spanSigma}`,
      dropletBins({
        d50: row.d50, sigma: row.sigma, nBins: row.nBins, spanSigma: row.spanSigma - 1,
      }).truncatedTailFraction,
      row.truncatedTailFraction, 1e-6, 'abs',
    )));
    expect(msg).toMatch(/^binGrid: [1-9] of 5 cases failed$/m);
    expect(msg).toMatch(/binGrid\[\d\] truncated tail at span \d: engine [\d.e-]+ against oracle [\d.e-]+, abs gap [\d.e-]+ over [\d.e-]+/);
  });
});

/* ================================================================== *
 * 4. The removal integral: quadrature against sampling
 * ================================================================== */

describe('the removal integral: binned quadrature against Monte Carlo', () => {
  test('binned removal matches the sampled removal', () => {
    const n = gate('removal', G.removal, 5, (row) => {
      const { bins } = dropletBins({ d50: row.d50, sigma: row.sigma, spanSigma: row.spanSigma });
      const r = applyDevice({ bins, d50cMicron: row.d50cMicron, sharpness: row.sharpness });
      if (r.error) return `refused a case the oracle answered: ${r.error}`;
      return near(
        `removal of d50 ${row.d50} sigma ${row.sigma} at a ${row.d50cMicron} um cut, m ${row.sharpness}`,
        r.removalFraction, row.removalFraction, 2e-3, 'abs',
      );
    });
    expect(n).toBeGreaterThanOrEqual(5);
  });

  test('a device cutting at the median removes about half the volume', () => {
    const { bins } = dropletBins({ d50: 30, sigma: 0.7 });
    expect(applyDevice({ bins, d50cMicron: 30 }).removalFraction).toBeCloseTo(0.5, 2);
  });

  test('THE POINT: the water leaving a device is finer than the water entering', () => {
    const { bins } = dropletBins({ d50: 30, sigma: 0.7 });
    const r = applyDevice({ bins, d50cMicron: 25 });
    expect(medianOfBins(r.outletBins)).toBeLessThan(medianOfBins(bins));
  });

  test('a device that removes nearly everything does not report COARSER water', () => {
    // it used to: the outlet bins were left un-normalised below a
    // survival of 1e-12, medianOfBins walked off the end of them, and a
    // 0.001 um cut on 30 um water reported a median of 470.85 um,
    // fifteen times coarser than the inlet
    const { bins } = dropletBins({ d50: 30, sigma: 0.7 });
    const inletMedian = medianOfBins(bins);
    [1, 0.1, 0.01, 0.001].forEach((cut) => {
      const r = applyDevice({ bins, d50cMicron: cut });
      const med = r.outletNormalised ? medianOfBins(r.outletBins) : NaN;
      if (r.outletNormalised) {
        expect(med).toBeLessThan(inletMedian);
      } else {
        expect(r.warning).toMatch(/numerical dust/);
      }
    });
  });

  test('the outlet median still carries information as the water gets cleaner', () => {
    // six orders of magnitude of outlet concentration used to report
    // the same 7.061 um, because the median was quantised to the grid
    const { bins } = dropletBins({ d50: 30, sigma: 0.7 });
    const medians = [20, 15, 12, 10, 8, 6].map((cut) => {
      const r = applyDevice({ bins, d50cMicron: cut });
      return medianOfBins(r.outletBins);
    });
    for (let i = 1; i < medians.length; i += 1) {
      expect(medians[i]).toBeLessThan(medians[i - 1]);
    }
  });

  test('NEGATIVE CONTROL: the removal gate fires on a quarter of a percent', () => {
    const msg = controlFires(() => gate('removal', G.removal, 5, (row) => {
      const { bins } = dropletBins({ d50: row.d50, sigma: row.sigma, spanSigma: row.spanSigma });
      const r = applyDevice({ bins, d50cMicron: row.d50cMicron, sharpness: row.sharpness });
      return near('removal', r.removalFraction + 0.0025, row.removalFraction, 2e-3, 'abs');
    }));
    expect(msg).toMatch(/removal\[0\] removal: engine .* abs gap 2\.\d+e-3 over 0\.002/);
  });
});

/* ================================================================== *
 * 5. Rise velocities, and the Reynolds number nothing used to check
 * ================================================================== */

describe('rise velocities: the force balance, and where Stokes stops being the law', () => {
  test('the closed Stokes form matches the force balance solved numerically', () => {
    // the oracle never types an 18: it types Cd = 24/Re and the two
    // force expressions and solves. That is what lets this gate see the
    // 18 move, which it could not before in either file
    const n = gate('rise', G.rise, 4, (row) => {
      const v = stokesRiseMS(row);
      if (v.error) return `refused a case the oracle answered: ${v.error}`;
      return first(
        near(`Stokes rise of a ${row.dMicron} um droplet`, v.vMS, row.vCreepingMS, 1e-9),
        near(`the Reynolds number it reports at ${row.dMicron} um`, v.reynolds, row.creepingReynolds, 1e-9),
      );
    });
    expect(n).toBeGreaterThanOrEqual(4);
  });

  test('the drag-balance terminal velocity matches a bisection on the residual', () => {
    const n = gate('bubbleRise', G.bubbleRise, 3, (row) => {
      const t = terminalRiseMS({
        dMicron: row.dMicron, rhoHeavy: row.rhoWater, rhoLight: row.rhoGasKgM3, muPaS: row.muPaS,
      });
      if (t.error) return `refused a case the oracle answered: ${t.error}`;
      return first(
        near(`a ${row.dMicron} um bubble`, t.vMS, row.vTerminalMS, 1e-9),
        near(`its Reynolds number`, t.reynolds, row.reynolds, 1e-9),
        near(`its drag coefficient`, t.dragCoefficient, row.dragCoefficient, 1e-9),
      );
    });
    expect(n).toBeGreaterThanOrEqual(3);
  });

  test('THE GAP IS REAL: Stokes and the drag balance still disagree where they should', () => {
    // identical to twelve decimals would be the weaker result, because
    // it is what two copies of one calculation produce. If anyone ever
    // tidies one of these routes onto the other, this fails.
    const inBand = G.rise.filter((r) => r.creepingReynolds < 0.01);
    const outOfBand = G.rise.filter((r) => r.creepingReynolds > 1);
    expect(inBand.length).toBeGreaterThanOrEqual(2);
    expect(outOfBand.length).toBeGreaterThanOrEqual(1);
    inBand.forEach((r) => {
      expect(r.stokesOverTerminal).toBeGreaterThan(1);
      expect(r.stokesOverTerminal).toBeLessThan(1.01);
    });
    outOfBand.forEach((r) => {
      expect(r.stokesOverTerminal).toBeGreaterThan(1.1);
    });
  });

  test('Stokes says so when it is outside its own band', () => {
    // the golden used to carry three rows at Re 1.85, 1.37 and 1.08
    // and say nothing about any of them
    G.rise.forEach((row) => {
      const v = stokesRiseMS(row);
      if (row.creepingReynolds > DECLARED_CONSTANTS.stokesReynoldsLimit) {
        expect(v.warning).toMatch(/Stokes law is creeping flow/);
      } else {
        expect(v.warning).toBeNull();
      }
    });
    // hot water: thinner, so the same droplet rises faster
    const args = { dMicron: 30, rhoOil: 850 };
    const cold = stokesRiseMS({
      ...args,
      rhoWater: waterDensityKgM3({ tC: 20 }).rhoKgM3,
      muPaS: waterViscosityPaS({ tC: 20 }).muPaS,
    });
    const hot = stokesRiseMS({
      ...args,
      rhoWater: waterDensityKgM3({ tC: 80 }).rhoKgM3,
      muPaS: waterViscosityPaS({ tC: 80 }).muPaS,
    });
    expect(hot.vMS).toBeGreaterThan(cold.vMS * 2);
  });

  test('both rise routes refuse, by name, an oil that cannot rise', () => {
    expect(stokesRiseMS({ dMicron: 30, rhoWater: 800, rhoOil: 900, muPaS: 1e-3 }).error)
      .toMatch(/the oil must be lighter than the water/);
    expect(stokesRiseMS({ dMicron: 30, rhoWater: 1000, rhoOil: 900 }).error)
      .toMatch(/positive water viscosity/);
    expect(terminalRiseMS({ dMicron: 300, rhoHeavy: 1.2, rhoLight: 1000, muPaS: 1e-3 }).error)
      .toMatch(/denser one/);
  });

  test('NEGATIVE CONTROL: the rise gate fires on a one part in a hundred million error', () => {
    const msg = controlFires(() => gate('rise', G.rise, 4, (row) => near(
      `Stokes rise of a ${row.dMicron} um droplet`,
      stokesRiseMS(row).vMS * (1 + 1e-8), row.vCreepingMS, 1e-9,
    )));
    expect(msg).toMatch(/rise\[0\] Stokes rise of a 5 um droplet: engine .* over 1e-9/);
  });
});

/* ================================================================== *
 * 6. The gravity devices, against a marched trajectory
 * ================================================================== */

describe('API 421 basins and plate packs, against a marched droplet', () => {
  test('the basin cut matches a droplet marched through the basin', () => {
    const n = gate('apiSeparator', G.apiSeparator, 4, (row) => {
      const r = apiSeparator(row);
      if (r.error) return `refused a case the oracle answered: ${r.error}`;
      return first(
        near(`the cut of a ${row.lengthM} by ${row.widthM} m basin at ${row.flowM3S} m3/s`, r.d50cMicron, row.d50cMicron, 1e-9),
        near('its overflow rate', r.overflowRateMS, row.overflowRateMS, 1e-12),
        near('its design rise', r.designRiseMS, row.designRiseMS, 1e-12),
        near('its horizontal velocity', r.horizontalVelocityMS, row.horizontalVelocityMS, 1e-12),
        near('its residence', r.residenceS, row.residenceS, 1e-12),
        near('the Reynolds number of its cut droplet', r.cutReynolds, row.cutReynolds, 1e-9),
      );
    });
    expect(n).toBeGreaterThanOrEqual(4);
  });

  test('the velocity rule fires exactly where the golden says, and says it is half a rule', () => {
    // no golden row used to carry a warning at all, so doubling the
    // 15 mm/s limit left the suite green
    gate('apiSeparator warnings', G.apiSeparator, 4, (row) => {
      const r = apiSeparator(row);
      const warned = /re-entrains/.test(r.warning || '');
      if (warned !== row.expectVelocityWarning) {
        return `at ${(row.horizontalVelocityMS * 1000).toFixed(2)} mm/s the engine ${warned ? 'warned' : 'did not warn'} and the golden expects ${row.expectVelocityWarning}`;
      }
      if (r.velocityRuleComplete !== false) return 'it claims the whole API 421 velocity rule';
      return null;
    });
    // and the boundary is read from BOTH sides
    const straddle = G.apiSeparator.filter((r) => r.expectVelocityWarning);
    expect(straddle.length).toBeGreaterThanOrEqual(1);
    expect(G.apiSeparator.length - straddle.length).toBeGreaterThanOrEqual(1);
  });

  test('the plate cut matches the same march through one plate channel', () => {
    const n = gate('plateInterceptor', G.plateInterceptor, 3, (row) => {
      const r = plateInterceptor(row);
      if (r.error) return `refused a case the oracle answered: ${r.error}`;
      return first(
        near(`the cut of ${row.nPlates} plates of ${row.plateAreaM2} m2 at ${row.flowM3S} m3/s`, r.d50cMicron, row.d50cMicron, 1e-9),
        near('its effective area', r.effectiveAreaM2, row.effectiveAreaM2, 1e-12),
        near('its design rise', r.designRiseMS, row.designRiseMS, 1e-12),
        row.channelHeightIndependence < 1e-9 ? null
          : `the oracle's own march depends on the channel height it chose (${row.channelHeightIndependence}), so it is not checking the criterion it claims`,
      );
    });
    expect(n).toBeGreaterThanOrEqual(3);
  });

  test('a plate pack cuts finer than a bare basin of the same footprint', () => {
    const common = { flowM3S: 0.09, rhoWater: 1012, rhoOil: 850, muPaS: 5.8e-4 };
    const basin = apiSeparator({ ...common, lengthM: 12, widthM: 2, depthM: 1.2 });
    const cpi = plateInterceptor({ ...common, plateAreaM2: 2, nPlates: 40 });
    expect(cpi.d50cMicron).toBeLessThan(basin.d50cMicron);
  });

  test('both refuse every input they cannot size a cut from, each by its own name', () => {
    const common = { rhoWater: 1012, rhoOil: 850, muPaS: 5.8e-4 };
    const basin = { ...common, flowM3S: 0.09, lengthM: 12, widthM: 2, depthM: 1.2 };
    expect(apiSeparator({ ...basin, lengthM: NaN }).error).toMatch(/basin length/);
    expect(apiSeparator({ ...basin, widthM: 0 }).error).toMatch(/basin width/);
    expect(apiSeparator({ ...basin, depthM: -1 }).error).toMatch(/water depth/);
    expect(apiSeparator({ ...basin, flowM3S: 0 }).error).toMatch(/positive flow/);
    // F of zero used to give a cut of EXACTLY zero, which the train
    // then read as a broken device and silently deleted from the train
    expect(apiSeparator({ ...basin, shortCircuitF: 0 }).error).toMatch(/at an F of zero or less the separator is undefined/);
    expect(apiSeparator({ ...basin, shortCircuitF: -2 }).error).toMatch(/must be positive/);
    // and 1e9 used to give a five metre droplet with no refusal
    expect(apiSeparator({ ...basin, shortCircuitF: 1e9 }).error).toMatch(/holds it to 5/);
    expect(apiSeparator({ ...basin, shortCircuitF: 1.1 }).warning).toMatch(/outside the 1.3 to 1.8/);
    const plate = { ...common, flowM3S: 0.09, plateAreaM2: 2, nPlates: 40 };
    expect(plateInterceptor({ ...plate, plateAreaM2: NaN }).error).toMatch(/plate area/);
    expect(plateInterceptor({ ...plate, nPlates: 0 }).error).toMatch(/at least one plate/);
    expect(plateInterceptor({ ...plate, efficiencyFactor: 1.5 }).error).toMatch(/between 0 and 1/);
  });

  test('NEGATIVE CONTROL: the basin gate fires on a tenth of a percent on the cut', () => {
    const msg = controlFires(() => gate('apiSeparator', G.apiSeparator, 4, (row) => near(
      `the cut of a ${row.lengthM} by ${row.widthM} m basin`,
      apiSeparator(row).d50cMicron * 1.001, row.d50cMicron, 1e-9,
    )));
    expect(msg).toMatch(/apiSeparator\[0\] the cut of a 12 by 2 m basin: engine .* over 1e-9/);
  });
});

/* ================================================================== *
 * 7. The hydrocyclone
 * ================================================================== */

describe('the hydrocyclone: bounded, and marched rather than asserted', () => {
  test('the cut matches a droplet marched radially through the liner', () => {
    const n = gate('hydrocyclone', G.hydrocyclone, 4, (row) => {
      const r = hydrocyclone(row);
      if (r.error) return `refused a case the oracle answered: ${r.error}`;
      return first(
        near(`the cut of ${row.nLiners} liners at ${row.flowM3S} m3/s`, r.d50cMicron, row.d50cMicron, 1e-9),
        near('its ideal cut before the shear penalty', r.idealD50cMicron, row.idealD50cMicron, 1e-9),
        near('its centrifugal field', r.gField, row.gField, 1e-9),
        near('its residence', r.residenceS, row.residenceS, 1e-12),
        near('its turndown', r.turndownRatio, row.turndownRatio, 1e-12),
        near('its shear penalty', r.shearPenalty, row.shearPenalty, 1e-12),
      );
    });
    expect(n).toBeGreaterThanOrEqual(4);
  });

  test('the cut size really is the size the liner captures half of', () => {
    // a Monte Carlo over starting radii uniform BY AREA, which is what
    // makes the half-area radius a derived criterion and not a constant
    gate('hydrocyclone capture', G.hydrocyclone, 4, (row) => near(
      `the captured fraction at the reported cut for ${row.nLiners} liners`,
      row.mcCaptureFractionAtCut, 0.5, 3e-3, 'abs',
    ));
  });

  test('the warnings fire exactly where the golden says', () => {
    gate('hydrocyclone warnings', G.hydrocyclone, 4, (row) => {
      const r = hydrocyclone(row);
      const starved = /shut liners in/.test(r.warning || '');
      const over = /gets WORSE from here/.test(r.warning || '');
      if (starved !== row.expectStarvedWarning) return `at turndown ${row.turndownRatio.toFixed(3)} the starved warning was ${starved}, the golden expects ${row.expectStarvedWarning}`;
      if (over !== row.expectOverloadWarning) return `at turndown ${row.turndownRatio.toFixed(3)} the overload warning was ${over}, the golden expects ${row.expectOverloadWarning}`;
      return null;
    });
  });

  test('THE FC7 DEFECT: removing liners can no longer improve the answer without limit', () => {
    // g = gAtDesign * turndown^2 was unbounded above, so every liner
    // REMOVED from the bank made the reported water cleaner. The Suite
    // shipped 20 liners on 50,000 bwpd: 7.667 times design flow at
    // 58,786 g, and clearing the box gave ONE liner at 23,514,452 g.
    const common = { rhoWater: 1013.06, rhoOil: 844.41, muPaS: 5.895e-4 };
    const flowM3S = 0.09201;
    const counts = [300, 250, 200, 160, 120, 100, 80];
    const runs = counts.map((nLiners) => hydrocyclone({ ...common, flowM3S, nLiners }));
    runs.forEach((r, i) => {
      expect(r.error).toBeUndefined();
      expect(r.gField).toBeLessThanOrEqual(
        DECLARED_CONSTANTS.gFieldAtDesign * DECLARED_CONSTANTS.overloadTurndown ** 2 + 1e-9,
      );
      if (i > 0 && runs[i - 1].turndownRatio > DECLARED_CONSTANTS.overloadTurndown) {
        // past the envelope, fewer liners must be WORSE
        expect(r.d50cMicron).toBeGreaterThan(runs[i - 1].d50cMicron);
      }
    });
    // the shipped default and the empty box are both refused now, and
    // the refusal says how many liners the flow actually needs
    const shipped = hydrocyclone({ ...common, flowM3S, nLiners: 20 });
    expect(shipped.error).toMatch(/7\.67 times their 0\.0006 m3\/s design flow/);
    expect(shipped.error).toMatch(/154 liners would run this flow at its design point/);
    expect(shipped.d50cMicron).toBeUndefined();
    const one = hydrocyclone({ ...common, flowM3S, nLiners: 1 });
    expect(one.error).toMatch(/holds a liner bank to 2 times design/);
    expect(one.gField).toBeUndefined();
  });

  test('a starved bank still loses its field and its cut', () => {
    const common = { rhoWater: 1012, rhoOil: 850, muPaS: 5.8e-4, nLiners: 20 };
    const design = hydrocyclone({ ...common, flowM3S: 0.012 });
    const starved = hydrocyclone({ ...common, flowM3S: 0.004 });
    expect(starved.turndownRatio).toBeLessThan(design.turndownRatio);
    expect(starved.gField).toBeLessThan(design.gField);
    expect(starved.d50cMicron).toBeGreaterThan(design.d50cMicron);
    expect(starved.warning).toMatch(/shut liners in/);
  });

  test('every refusal names its own cause, and the field refusal is reachable', () => {
    // the g-field refusal used to sit behind guards that made it
    // unreachable, and when it did fire it blamed the flow
    const common = { rhoWater: 1012, rhoOil: 850, muPaS: 5.8e-4, flowM3S: 0.012, nLiners: 20 };
    expect(hydrocyclone({ ...common, gFieldAtDesign: 0 }).error).toMatch(/declared to develop 0 g at its design flow/);
    expect(hydrocyclone({ ...common, gFieldAtDesign: 0 }).error).not.toMatch(/no flow/);
    expect(hydrocyclone({ ...common, flowM3S: 0 }).error).toMatch(/positive flow/);
    expect(hydrocyclone({ ...common, nLiners: NaN }).error).toMatch(/at least one liner/);
    expect(hydrocyclone({ ...common, linerLengthM: 0 }).error).toMatch(/liner length/);
    expect(hydrocyclone({ ...common, designFlowPerLinerM3S: 0 }).error).toMatch(/design flow per liner/);
    expect(hydrocyclone({ ...common, coreRadiusFraction: 0.9 }).error).toMatch(/oil core must sit inside/);
    expect(hydrocyclone({ ...common, muPaS: undefined }).error).toMatch(/hydrocyclone needs the water viscosity/);
    expect(hydrocyclone({ ...common, rhoOil: 1050 }).error).toMatch(/oil must be lighter/);
  });

  test('NEGATIVE CONTROL: the cyclone gate fires on a wrong field exponent', () => {
    const msg = controlFires(() => gate('hydrocyclone', G.hydrocyclone, 4, (row) => {
      const r = hydrocyclone(row);
      const bent = DECLARED_CONSTANTS.gFieldAtDesign
        * Math.min(r.turndownRatio, DECLARED_CONSTANTS.overloadTurndown) ** 1.5;
      return near(`its centrifugal field at turndown ${r.turndownRatio.toFixed(3)}`, bent, row.gField, 1e-9);
    }));
    // turndown 1.000 is the one case a wrong exponent cannot move, so
    // the control has to name one of the others, and it does
    expect(msg).toMatch(/^hydrocyclone: 4 of 5 cases failed$/m);
    expect(msg).toMatch(/hydrocyclone\[1\] its centrifugal field at turndown 0\.958: engine [\d.]+ against oracle [\d.]+, rel gap [\d.e-]+ over 1e-9/);
  });
});

/* ================================================================== *
 * 8. Flotation
 * ================================================================== */

describe('flotation: a model that bites, assembled from its parts', () => {
  test('the cut matches the attachment ODE marched and bisected', () => {
    const n = gate('flotation', G.flotation, 7, (row) => {
      const r = flotation(row);
      if (r.error) return `refused a case the oracle answered: ${r.error}`;
      return first(
        near(`the cut of ${row.nCells} x ${row.cellVolumeM3} m3 at ${row.flowM3S} m3/s`, r.d50cMicron, row.d50cMicron, 5e-5),
        near('its residence', r.residenceS, row.residenceS, 1e-12),
        near('its plan area', r.planAreaM2, row.planAreaM2, 1e-12),
        near('its superficial gas velocity', r.superficialGasMS, row.superficialGasMS, 1e-12),
        near('its bubble rise', r.bubbleRiseMS, row.bubbleRiseMS, 1e-9),
        near('its bubble Reynolds', r.bubbleReynolds, row.bubbleReynolds, 1e-9),
        near('its gas holdup', r.gasHoldup, row.gasHoldup, 1e-9),
      );
    });
    expect(n).toBeGreaterThanOrEqual(7);
  });

  test('THE FC7 DEFECT: the bubble size moves the answer, so IGF and DAF differ', () => {
    // the attachment fraction used to be exactly 1.000000000000 across
    // gas ratios 0.001 to 3 and bubbles 20 to 1500 um, so the cut size
    // was 67.909728 um at every bubble size tried and the two menu
    // entries the Suite sells were the same device
    const base = {
      flowM3S: 0.09201, cellVolumeM3: 8, nCells: 4,
      rhoWater: 1013.06, rhoOil: 844.41, muPaS: 5.895e-4,
    };
    const cuts = [20, 50, 80, 150, 300, 600, 1500].map(
      (bubbleMicron) => flotation({ ...base, bubbleMicron }).d50cMicron,
    );
    for (let i = 1; i < cuts.length; i += 1) expect(cuts[i]).toBeGreaterThan(cuts[i - 1]);
    // finer bubbles cut finer, and a de-rated dissolved gas cell still
    // beats an induced one
    const igf = flotation({ ...base, bubbleMicron: 300, gasRatio: 0.2 });
    const daf = flotation({ ...base, bubbleMicron: 80, gasRatio: 0.03 });
    expect(daf.d50cMicron).toBeLessThan(igf.d50cMicron * 0.6);
    // and the gas ratio moves it too: it used to be decorative
    const lean = flotation({ ...base, gasRatio: 0.05 });
    const rich = flotation({ ...base, gasRatio: 0.5 });
    expect(rich.d50cMicron).toBeLessThan(lean.d50cMicron);
    expect(rel(rich.d50cMicron, lean.d50cMicron)).toBeGreaterThan(0.5);
  });

  test('IDENTITY: at equal total gas and volume, how you count the cells cannot matter', () => {
    // it used to matter fourfold, because the "effective rise" was
    // identically 1/(nCells * residence) with a hidden metre in it:
    // 135.82 um for 1 x 32 m3, 67.91 for 4 x 8 and 33.95 for 16 x 2, at
    // the same flow, the same total volume and the same residence time
    const base = { flowM3S: 0.09201, rhoWater: 1013.06, rhoOil: 844.41, muPaS: 5.895e-4 };
    const arrangements = [[1, 32, 0.8], [2, 16, 0.4], [4, 8, 0.2], [16, 2, 0.05]];
    const cuts = arrangements.map(([nCells, cellVolumeM3, gasRatio]) => {
      const r = flotation({ ...base, nCells, cellVolumeM3, gasRatio });
      expect(r.residenceS).toBeCloseTo(32 / base.flowM3S, 9);
      expect(r.totalGasFlowM3S).toBeCloseTo(0.8 * base.flowM3S, 9);
      return r.d50cMicron;
    });
    cuts.forEach((c) => expect(rel(c, cuts[0])).toBeLessThan(1e-12));
  });

  test('the bubble rises by the drag law, not by Stokes at Reynolds 43', () => {
    const r = flotation({
      flowM3S: 0.09201, cellVolumeM3: 8, nCells: 4,
      rhoWater: 1013.06, rhoOil: 844.41, muPaS: 5.895e-4,
    });
    const stokes = stokesRiseMS({
      dMicron: 300, rhoWater: 1013.06, rhoOil: DECLARED_CONSTANTS.flotationGasDensityKgM3, muPaS: 5.895e-4,
    });
    expect(r.bubbleReynolds).toBeGreaterThan(10);
    expect(stokes.warning).toMatch(/creeping flow/);
    // and the two must differ by more than rounding, or the drag law is
    // not being used
    expect(stokes.vMS / r.bubbleRiseMS).toBeGreaterThan(1.5);
  });

  test('the warnings fire exactly where the golden says', () => {
    gate('flotation warnings', G.flotation, 7, (row) => {
      const r = flotation(row);
      const rushed = /too small for the flow/.test(r.warning || '');
      const churn = /gas holdup/.test(r.warning || '');
      if (rushed !== row.expectResidenceWarning) return `at ${row.residenceS.toFixed(1)} s the residence warning was ${rushed}, the golden expects ${row.expectResidenceWarning}`;
      if (churn !== row.expectHoldupWarning) return `at a holdup of ${row.gasHoldup.toFixed(3)} the churn warning was ${churn}, the golden expects ${row.expectHoldupWarning}`;
      if (r.residenceWarnS !== row.residenceWarnS) return `the engine judges the residence against ${r.residenceWarnS} s and the oracle decided this golden on ${row.residenceWarnS} s`;
      return null;
    });
  });

  test('FC7-1: the residence warning fires at the DECLARED threshold, not at a number typed in the sentence', () => {
    // FC7-0 decided it on a bare `residenceS < 60` inlined in the
    // warning, the one device threshold in the module that was not
    // declared. Both cases below are BUILT from the declared value, so
    // an engine that inlines any other number fails here whatever the
    // pin says, and the pin fails if the declared value itself moves.
    const warnAt = DECLARED_CONSTANTS.flotationResidenceWarnS;
    const base = {
      flowM3S: 0.1, nCells: 1, gasRatio: 0.05,
      rhoWater: 1013.06, rhoOil: 844.41, muPaS: 5.895e-4,
    };
    const at = (residenceS) => flotation({ ...base, cellVolumeM3: residenceS * base.flowM3S });
    const under = at(warnAt * 0.999);
    const over = at(warnAt * 1.001);
    expect(under.residenceS).toBeLessThan(warnAt);
    expect(over.residenceS).toBeGreaterThan(warnAt);
    expect(under.warning).toMatch(/too small for the flow/);
    expect(over.warning).toBeNull();
    // the sentence quotes the threshold it was judged against, and the
    // return carries it, so a reader is never told about a band they
    // cannot see
    expect(under.warning).toMatch(new RegExp(`under the ${warnAt} s this module warns below`));
    expect(under.residenceWarnS).toBe(warnAt);
    expect(over.residenceWarnS).toBe(warnAt);
  });

  test('NEGATIVE CONTROL: the residence straddle fires if the threshold is read as anything else', () => {
    const warnAt = DECLARED_CONSTANTS.flotationResidenceWarnS;
    const base = {
      flowM3S: 0.1, nCells: 1, gasRatio: 0.05,
      rhoWater: 1013.06, rhoOil: 844.41, muPaS: 5.895e-4,
    };
    const msg = controlFires(() => {
      // the threshold bent to twice the declared one, which is what an
      // engine that had inlined its own number would look like
      const bent = warnAt * 2;
      const r = flotation({ ...base, cellVolumeM3: bent * 0.999 * base.flowM3S });
      const warned = /too small for the flow/.test(r.warning || '');
      if (!warned) throw new Error(`at ${r.residenceS.toFixed(1)} s, just under a threshold of ${bent} s, the residence warning was ${warned}`);
    });
    expect(msg).toMatch(/^at 119\.9 s, just under a threshold of 120 s, the residence warning was false$/);
  });

  test('every refusal names its own cause', () => {
    const base = {
      flowM3S: 0.09201, cellVolumeM3: 8, nCells: 4,
      rhoWater: 1013.06, rhoOil: 844.41, muPaS: 5.895e-4,
    };
    expect(flotation({ ...base, cellVolumeM3: NaN }).error).toMatch(/cell volume/);
    expect(flotation({ ...base, cellDepthM: 0 }).error).toMatch(/cell depth/);
    expect(flotation({ ...base, gasRatio: 0 }).error).toMatch(/nothing for the droplets to attach to/);
    expect(flotation({ ...base, gasRatio: 5 }).error).toMatch(/holds the ratio to 3/);
    expect(flotation({ ...base, bubbleMicron: 5 }).error).toMatch(/between 20 and 2000 micron/);
    expect(flotation({ ...base, bubbleMicron: 5000 }).error).toMatch(/between 20 and 2000 micron/);
    expect(flotation({ ...base, attachmentEfficiency: 2 }).error).toMatch(/between 0 and 1/);
    expect(flotation({ ...base, muPaS: undefined }).error).toMatch(/flotation needs the water viscosity/);
    expect(flotation({ ...base, rhoOil: 1050 }).error).toMatch(/oil must be lighter/);
  });

  test('NEGATIVE CONTROL: the flotation gate fires when the attachment term is dropped', () => {
    const msg = controlFires(() => gate('flotation', G.flotation, 7, (row) => {
      const r = flotation(row);
      // the cut with the attachment efficiency deleted from the rate
      const bent = r.d50cMicron * Math.sqrt(DECLARED_CONSTANTS.attachmentEfficiency);
      return near(`the cut of ${row.nCells} x ${row.cellVolumeM3} m3`, bent, row.d50cMicron, 5e-5);
    }));
    expect(msg).toMatch(/^flotation: 7 of 7 cases failed$/m);
    expect(msg).toMatch(/flotation\[0\] the cut of 4 x 8 m3: engine [\d.]+ against oracle [\d.]+, rel gap [\d.e-]+ over [\d.e-]+/);
  });
});

/* ================================================================== *
 * 9. The media filter
 * ================================================================== */

describe('the media filter: ONE route, marched', () => {
  test('the cut is the droplet the marched bed removes exactly half of', () => {
    const n = gate('mediaFilter', G.mediaFilter, 8, (row) => {
      const r = mediaFilter(row);
      if (r.error) return `refused a case the oracle answered: ${r.error}`;
      return first(
        near(`the cut of a ${row.bedDepthM ?? DECLARED_CONSTANTS.filterBedDepthDefaultM} m bed at ${row.loadingMHr.toFixed(1)} m/hr`, r.d50cMicron, row.d50cMicron, 1e-4),
        near('its loading', r.loadingMHr, row.loadingMHr, 1e-12),
        near('its filter coefficient at the reference droplet', r.filterCoefficientPerM, row.lambdaAtRefPerM, 1e-12),
        near('the removal of a reference droplet', r.removalAtRefDroplet, row.removalAtRefDroplet, 1e-4, 'abs'),
        r.loadingFloorMHr === row.loadingFloorMHr ? null
          : `the engine answers at and above ${r.loadingFloorMHr} m/hr and the oracle built this golden against a floor of ${row.loadingFloorMHr} m/hr`,
      );
    });
    expect(n).toBeGreaterThanOrEqual(8);
  });

  test('THE FC7 DEFECT: there is no second removal number to disagree with the first', () => {
    // it used to compute its removal twice by two routes that
    // disagreed - 73.83 percent by depth filtration against 84.82 by
    // the cut size on the same water - and the train read the one the
    // golden did not check
    const r = mediaFilter({ flowM3S: 0.09201, areaM2: 16, bedDepthM: 0.9 });
    expect(r.removalFraction).toBeUndefined();
    expect(r.cutBasis).toMatch(/the cut size and the train come from one model/);
  });

  test('THE FC7 DEFECT: the bed depth and the grain size move the answer', () => {
    // the bed depth moved the train's stage removal by 0.000000000
    // percent between 0.1 m and 10 m
    const base = { flowM3S: 0.09201, areaM2: 16 };
    const cuts = [0.1, 0.3, 0.9, 1.8, 3.0, 10].map((bedDepthM) => mediaFilter({ ...base, bedDepthM }).d50cMicron);
    for (let i = 1; i < cuts.length; i += 1) expect(cuts[i]).toBeLessThan(cuts[i - 1]);
    expect(cuts[0] / cuts[cuts.length - 1]).toBeGreaterThan(5);
    // and the grain size, which used to be declared in the signature
    // and read nowhere at all
    const coarse = mediaFilter({ ...base, mediaMicron: 1600 }).d50cMicron;
    const fine = mediaFilter({ ...base, mediaMicron: 400 }).d50cMicron;
    expect(fine).toBeLessThan(coarse);
    expect(coarse / fine).toBeGreaterThan(5);
  });

  test('the breakthrough warning fires exactly where the golden says', () => {
    gate('mediaFilter warnings', G.mediaFilter, 8, (row) => {
      const r = mediaFilter(row);
      const warned = /break through/.test(r.warning || '');
      return warned === row.expectBreakthroughWarning ? null
        : `at ${row.loadingMHr.toFixed(1)} m/hr the warning was ${warned} and the golden expects ${row.expectBreakthroughWarning}`;
    });
  });

  test('FC7-1 THE DEFECT: the bed area bites all the way down to the floor', () => {
    // FC7-0 kept a silent Math.max(loadingMHr, 1) in the loading
    // factor, so below 1 m/hr the area moved the answer by EXACTLY
    // nothing: at 0.001 m3/s through 20, 200, 600 and 2000 m2 the
    // loading read 0.18, 0.018, 0.006 and 0.0018 m/hr while the filter
    // coefficient stayed 11.067972 per m and the cut stayed 5.275789
    // micron on all four, to every digit.
    const base = { flowM3S: 0.001, bedDepthM: 0.9 };
    const band = [1.2, 1.5, 2.0, 2.5, 3.0, 3.5, 3.6].map((areaM2) => mediaFilter({ ...base, areaM2 }));
    band.forEach((r, i) => {
      expect(r.error).toBeUndefined();
      // and every one of them is INSIDE the band the clamp used to flatten
      expect(r.loadingMHr).toBeLessThan(DECLARED_CONSTANTS.filterReferenceLoadingMHr);
      if (i > 0) {
        expect(r.loadingMHr).toBeLessThan(band[i - 1].loadingMHr);
        expect(r.filterCoefficientPerM).toBeGreaterThan(band[i - 1].filterCoefficientPerM);
        expect(r.d50cMicron).toBeLessThan(band[i - 1].d50cMicron);
      }
    });
    // measured, so "it moves" is not an assertion about a rounding digit
    expect(band[0].d50cMicron / band[band.length - 1].d50cMicron).toBeGreaterThan(1.25);
    // and the cut goes as one over the fourth root of the loading rate,
    // which is the declared exponent 0.5 carried through the ln 2
    // inversion's own square root. An identity of the model, on a band
    // the model could not previously express at all
    band.forEach((r) => {
      expect(r.d50cMicron * r.loadingMHr ** -0.25).toBeCloseTo(
        band[0].d50cMicron * band[0].loadingMHr ** -0.25, 9,
      );
    });
  });

  test('FC7-1: below the floor it REFUSES, and the refusal names the loading, the reference and the bed the flow wants', () => {
    // A POLICY GATE and not a validation: the whole point of the floor
    // is that this module states no physics below it, so there is
    // nothing for the oracle to march. What the golden group carries is
    // the four conditions the clamp answered identically, so removing
    // the floor and restoring the clamp fails here.
    const n = gate('mediaFilterFloor', G.mediaFilterFloor, 6, (row) => {
      const r = mediaFilter({ flowM3S: row.flowM3S, areaM2: row.areaM2 });
      const refused = Boolean(r.error);
      if (refused !== row.expectRefusal) {
        return `at ${row.loadingMHr.toPrecision(3)} m/hr the module ${refused ? 'refused' : `answered ${r.d50cMicron} micron`} and the golden expects ${row.expectRefusal ? 'a refusal' : 'an answer'}`;
      }
      if (!refused) return null;
      return first(
        near('the loading it names', r.loadingMHr, row.loadingMHr, 1e-12),
        near('the floor it names', r.loadingFloorMHr, row.loadingFloorMHr, 1e-12),
        near('the bed it says would run this flow at the floor', r.areaAtFloorM2, row.areaAtFloorM2, 1e-12),
        new RegExp(`below the ${row.loadingFloorMHr} m/hr floor`).test(r.error) ? null
          : `the refusal does not name the floor: ${r.error}`,
        new RegExp(`DECLARED at ${row.referenceLoadingMHr} m/hr`).test(r.error) ? null
          : `the refusal does not name the loading its coefficient is declared at: ${r.error}`,
        new RegExp(`${row.areaAtFloorM2.toPrecision(4)} m2 of bed`).test(r.error) ? null
          : `the refusal does not say what bed would run this flow at the floor: ${r.error}`,
        // and it must not blame the flow, which is not what is wrong
        /positive flow/.test(r.error) ? 'the refusal blames the flow, which is fine' : null,
      );
    });
    expect(n).toBeGreaterThanOrEqual(6);
    // the floor makes the old clamp unreachable by construction: they
    // sit at the same loading rate, so there is no band left in which a
    // clamp at the declared floor could flatten an answer
    expect(DECLARED_CONSTANTS.filterMinLoadingMHr).toBe(1);
  });

  test('the bed answers AT the floor and refuses only below it, which is what its refusal says', () => {
    // flow in m3/s that loads 1 m2 of bed at exactly `mHr` m/hr
    const at = (mHr) => mediaFilter({ flowM3S: mHr / 3600, areaM2: 1 });
    const floor = DECLARED_CONSTANTS.filterMinLoadingMHr;
    const onFloor = at(floor);
    expect(onFloor.error).toBeUndefined();
    expect(onFloor.loadingMHr).toBe(floor);
    expect(Number.isFinite(onFloor.d50cMicron)).toBe(true);
    const below = at(floor * (1 - 1e-9));
    expect(below.error).toMatch(/this module answers at the floor and above it/);
  });

  test('NEGATIVE CONTROL: the filter gate fires when a low-rate clamp comes back', () => {
    // The clamp re-expressed: the loading factor evaluated at
    // max(loading, FLATTEN_BELOW) instead of at the loading itself.
    //
    // The clamp FC7-0 had, at 1 m/hr, is now unreachable: the floor
    // sits at the same loading, so there is no band left in which it
    // could flatten anything, and a control at 1 fires on nothing at
    // all. The control has to bend it ABOVE the floor, which is what
    // any clamp that could still flatten an answer looks like, and
    // then it must fire on exactly the three rows FC7-1 added between
    // the floor and the reference loading and on none of the five
    // FC7-0 carried, all of which sat at 11.25 m/hr or above. That is
    // the measurement: those five rows could not see a clamp anywhere
    // below 11 m/hr and there was one there.
    const FLATTEN_BELOW = 4;
    const clamped = (row) => {
      const c = DECLARED_CONSTANTS;
      const lam = (row.filterCoefficientPerM ?? c.filterCoefficientPerM)
        * ((c.filterReferenceMediaMicron / (row.mediaMicron ?? c.filterReferenceMediaMicron)) ** 3)
        * (c.filterReferenceLoadingMHr / Math.max(row.loadingMHr, FLATTEN_BELOW)) ** c.filterLoadingExponent;
      return (row.referenceDropletMicron ?? c.filterReferenceDropletMicron)
        * Math.sqrt(Math.LN2 / (lam * (row.bedDepthM ?? c.filterBedDepthDefaultM)));
    };
    const msg = controlFires(() => gate('mediaFilter', G.mediaFilter, 8, (row) => near(
      `the cut of a ${row.bedDepthM ?? DECLARED_CONSTANTS.filterBedDepthDefaultM} m bed at ${row.loadingMHr.toFixed(2)} m/hr`,
      clamped(row), row.d50cMicron, 1e-4,
    )));
    // exactly the three low-rate rows, and not one of the five above
    // the clamp: a control that fired on all eight would be telling us
    // the rows we added were not the ones doing the work
    expect(msg).toMatch(/^mediaFilter: 3 of 8 cases failed$/m);
    expect(msg).toMatch(/mediaFilter\[5\] the cut of a 0\.9 m bed at 3\.00 m\/hr: engine [\d.]+ against oracle [\d.]+, rel gap [\d.e-]+ over 0?\.0001/);
    expect(msg).toMatch(/mediaFilter\[7\] the cut of a 1\.1 m bed at 1\.08 m\/hr/);
  });

  test('NEGATIVE CONTROL: the floor gate fires if the module answers below the floor', () => {
    const msg = controlFires(() => gate('mediaFilterFloor', G.mediaFilterFloor, 6, (row) => {
      // the floor deleted: the module answers everywhere, which is what
      // it did before FC7-1 and what the clamp made look sensible
      const refused = false;
      return refused === row.expectRefusal ? null
        : `at ${row.loadingMHr.toPrecision(3)} m/hr the module ${refused ? 'refused' : 'answered 5.275789 micron'} and the golden expects ${row.expectRefusal ? 'a refusal' : 'an answer'}`;
    }));
    expect(msg).toMatch(/^mediaFilterFloor: 5 of 7 cases failed$/m);
    expect(msg).toMatch(/mediaFilterFloor\[0\] at 0\.180 m\/hr the module answered 5\.275789 micron and the golden expects a refusal/);
  });

  test('every refusal names its own cause', () => {
    const base = { flowM3S: 0.09201, areaM2: 16 };
    expect(mediaFilter({ ...base, areaM2: NaN }).error).toMatch(/bed area/);
    expect(mediaFilter({ ...base, bedDepthM: 0 }).error).toMatch(/bed depth/);
    expect(mediaFilter({ ...base, mediaMicron: -1 }).error).toMatch(/media grain size/);
    expect(mediaFilter({ ...base, filterCoefficientPerM: 0 }).error).toMatch(/filter coefficient/);
    expect(mediaFilter({ flowM3S: 0, areaM2: 16 }).error).toMatch(/positive flow/);
  });

  test('NEGATIVE CONTROL: the filter gate fires on a one percent error on the cut', () => {
    const msg = controlFires(() => gate('mediaFilter', G.mediaFilter, 8, (row) => near(
      `the cut of a ${row.bedDepthM ?? DECLARED_CONSTANTS.filterBedDepthDefaultM} m bed`,
      mediaFilter(row).d50cMicron * 1.01, row.d50cMicron, 1e-4,
    )));
    expect(msg).toMatch(/^mediaFilter: 8 of 8 cases failed$/m);
    expect(msg).toMatch(/mediaFilter\[1\] the cut of a 0\.9 m bed: engine [\d.]+ against oracle [\d.]+, rel gap 1\.\d+e-2 over 0\.0001/);
  });
});

/* ================================================================== *
 * 10. The train
 * ================================================================== */

describe('the treatment train, against particle tracking', () => {
  test('the whole train matches a Monte Carlo that bins nothing', () => {
    const n = gate('train', G.train, 3, (row) => {
      const t = treatmentTrain({
        inletOiwPpm: row.inletOiwPpm,
        inletD50Micron: row.inletD50Micron,
        sigma: row.sigma,
        spanSigma: row.spanSigma,
        devices: row.devices,
      });
      if (t.error) return `refused a case the oracle answered: ${t.error}`;
      if (t.stages.length !== row.stages.length) return `it ran ${t.stages.length} stages and the oracle ran ${row.stages.length}`;
      const perStage = row.stages.map((s, i) => first(
        near(`${row.label}: the oil after ${s.name}`, t.stages[i].outletOiwPpm, s.outletOiwPpm, 5e-3),
        near(`${row.label}: the median after ${s.name}`, t.stages[i].outletMedianMicron, s.outletMedianMicron, 4e-3),
      )).find(Boolean);
      return first(
        perStage,
        near(`${row.label}: the outlet`, t.outletOiwPpm, row.outletOiwPpm, 5e-3),
        near(`${row.label}: the outlet median`, t.outletMedianMicron, row.outletMedianMicron, 4e-3),
        near(`${row.label}: the inlet median`, t.inletMedianMicron, row.inletMedianMicron, 4e-3),
      );
    });
    expect(n).toBeGreaterThanOrEqual(3);
  });

  test('THE POINT: three "90 percent" devices do not give 99.9 percent', () => {
    const devices = [
      { name: 'A', d50cMicron: 12 }, { name: 'B', d50cMicron: 12 }, { name: 'C', d50cMicron: 12 },
    ];
    const t = treatmentTrain({ inletOiwPpm: 500, inletD50Micron: 30, devices });
    const naive = 1 - (1 - t.stages[0].removalPct / 100) ** 3;
    expect(t.overallRemovalPct / 100).toBeLessThan(naive);
  });

  test('finer inlet water is harder to treat with the same equipment', () => {
    const devices = [{ name: 'CPI', d50cMicron: 60 }, { name: 'HC', d50cMicron: 6 }];
    const coarse = treatmentTrain({ inletOiwPpm: 500, inletD50Micron: 60, devices });
    const fine = treatmentTrain({ inletOiwPpm: 500, inletD50Micron: 12, devices });
    expect(fine.outletOiwPpm).toBeGreaterThan(coarse.outletOiwPpm);
  });

  test('THE OTHER POINT: hot brine treats differently from cool fresh water', () => {
    const mk = (tC, tdsPpm) => {
      const rhoWater = waterDensityKgM3({ tC, tdsPpm }).rhoKgM3;
      const rhoOil = oilDensityKgM3({ apiGravity: 32, tC }).rhoKgM3;
      const muPaS = waterViscosityPaS({ tC, tdsPpm }).muPaS;
      return treatmentTrain({
        inletOiwPpm: 500,
        inletD50Micron: 30,
        devices: [{
          name: 'CPI',
          ...plateInterceptor({
            flowM3S: 0.09, plateAreaM2: 2, nPlates: 40, rhoWater, rhoOil, muPaS,
          }),
        }],
      });
    };
    expect(mk(90, 0).outletOiwPpm).toBeLessThan(mk(20, 0).outletOiwPpm);
  });

  test('THE FC7 DEFECT: a train with a stage that did not run gives NO verdict', () => {
    // it used to print MEETS with a 27.78 ppm margin over a train that
    // was missing a stage, with no count, no flag and no top-level
    // error. This is the FC1 separation defect in a second engine.
    const good = { name: 'CPI', d50cMicron: 60 };
    const broken = {
      name: 'CPI',
      ...plateInterceptor({
        flowM3S: 0.09, plateAreaM2: NaN, nPlates: 40, rhoWater: 1012, rhoOil: 850, muPaS: 5.8e-4,
      }),
    };
    const t = treatmentTrain({
      inletOiwPpm: 500,
      inletD50Micron: 30,
      devices: [broken, { name: 'HC', d50cMicron: 5 }, good],
      specPpm: 29,
    });
    expect(t.meetsSpec).toBeNull();
    expect(t.marginPpm).toBeNull();
    expect(t.complete).toBe(false);
    expect(t.stagesSkipped).toBe(1);
    expect(t.stagesRun).toBe(2);
    expect(t.skippedStages).toEqual(['CPI']);
    expect(t.verdictWithheldReason).toMatch(/1 of 3 stages did not run \(CPI\)/);
    expect(t.warning).toMatch(/1 of 3 stages did not run/);
    expect(t.overallRemovalBasis).toMatch(/over the 2 of 3 stages that ran/);
    // and the failed stage carries nothing but its name and its cause:
    // it used to spread the raw device, so a stage that did not run
    // could still show a confident process warning
    const failed = t.stages[0];
    expect(failed.ran).toBe(false);
    expect(failed.error).toMatch(/this device did not run: a plate pack needs a positive projected plate area/);
    expect(failed.warning).toBeUndefined();
    expect(failed.removalPct).toBeUndefined();
    expect(failed.d50cMicron).toBeUndefined();
    // a complete train does give one
    const whole = treatmentTrain({
      inletOiwPpm: 500, inletD50Micron: 30, devices: [good, { name: 'HC', d50cMicron: 5 }], specPpm: 29,
    });
    expect(typeof whole.meetsSpec).toBe('boolean');
    expect(whole.verdictWithheldReason).toBeNull();
  });

  test('a spec it cannot use withholds the verdict WITH A REASON, not a bare null', () => {
    // typing 0 in the spec box made the verdict vanish to a dash, which
    // the studio then painted red
    const devices = [{ name: 'CPI', d50cMicron: 20 }];
    const args = { inletOiwPpm: 500, inletD50Micron: 30, devices };
    expect(treatmentTrain({ ...args, specPpm: 0 }).verdictWithheldReason).toMatch(/must be a positive concentration and this is 0/);
    expect(treatmentTrain({ ...args, specPpm: -5 }).verdictWithheldReason).toMatch(/positive concentration/);
    expect(treatmentTrain({ ...args }).verdictWithheldReason).toMatch(/no discharge specification/);
    expect(treatmentTrain({ ...args, specPpm: 29 }).verdictWithheldReason).toBeNull();
  });

  test('the train says what it is reporting and what no device in it removes', () => {
    const t = treatmentTrain({
      inletOiwPpm: 500, inletD50Micron: 30, devices: [{ name: 'CPI', d50cMicron: 3 }], specPpm: 29,
    });
    expect(t.concentrationBasis).toBe(CONCENTRATION_BASIS);
    expect(t.dissolvedOilNote).toBe(DISSOLVED_OIL_NOTE);
    expect(t.dissolvedOilFloorPpm).toBeNull();
    expect(t.floorApplied).toBe(false);
    // and applies a floor when the caller states one, rather than
    // reporting 2e-5 ppm and a MEETS
    const floored = treatmentTrain({
      inletOiwPpm: 500, inletD50Micron: 30, devices: [{ name: 'CPI', d50cMicron: 0.5 }],
      specPpm: 29, dissolvedOilFloorPpm: 5,
    });
    expect(floored.floorApplied).toBe(true);
    expect(floored.outletOiwPpm).toBe(5);
    expect(floored.dispersedOutletOiwPpm).toBeLessThan(5);
    expect(floored.warning).toMatch(/below the 5 ppm floor the caller gave/);
  });

  test('a device coarser than the water it sees says so', () => {
    const t = treatmentTrain({
      inletOiwPpm: 500, inletD50Micron: 30, devices: [{ name: 'huge', d50cMicron: 1e6 }],
    });
    expect(t.stages[0].warning).toMatch(/there is nothing here for it to catch/);
  });

  test('refuses what it cannot run, by name', () => {
    expect(treatmentTrain({ inletOiwPpm: 0, inletD50Micron: 30, devices: [] }).error).toMatch(/positive inlet oil-in-water/);
    expect(treatmentTrain({ inletOiwPpm: 500, inletD50Micron: 30, devices: [] }).error).toMatch(/no devices/);
    // it used to throw "devices is not iterable" and white-screen the tab
    expect(treatmentTrain({ inletOiwPpm: 500, inletD50Micron: 30 }).error).toMatch(/array of devices/);
    expect(treatmentTrain({ inletOiwPpm: 500, inletD50Micron: 30, devices: {} }).error).toMatch(/array of devices/);
    expect(treatmentTrain({ inletOiwPpm: 500, inletD50Micron: 0, devices: [{ d50cMicron: 10 }] }).error).toMatch(/positive median diameter/);
    expect(treatmentTrain({
      inletOiwPpm: 500, inletD50Micron: 30, devices: [{ d50cMicron: 10 }], dissolvedOilFloorPpm: -2,
    }).error).toMatch(/dissolved oil floor/);
    const named = treatmentTrain({
      inletOiwPpm: 500, inletD50Micron: 30, devices: [{ name: 'broken' }],
    });
    expect(named.stages[0].error).toMatch(/no cut size/);
  });

  test('NEGATIVE CONTROL: the train gate fires on one percent on the outlet', () => {
    const msg = controlFires(() => gate('train', G.train, 3, (row) => {
      const t = treatmentTrain({
        inletOiwPpm: row.inletOiwPpm,
        inletD50Micron: row.inletD50Micron,
        sigma: row.sigma,
        spanSigma: row.spanSigma,
        devices: row.devices,
      });
      return near(`${row.label}: the outlet`, t.outletOiwPpm * 1.01, row.outletOiwPpm, 5e-3);
    }));
    expect(msg).toMatch(/train\[0\] the Suite's own shipped default train: the outlet: engine/);
  });
});

/* ================================================================== *
 * 11. The fails-open sweep, across every device at once
 * ================================================================== */

describe('the fails-open sweep: four devices used to trust what one refused', () => {
  const fluid = { rhoWater: 1000, rhoOil: 1050, muPaS: 6e-4 };
  const devices = [
    ['apiSeparator', (extra) => apiSeparator({ flowM3S: 0.09, lengthM: 12, widthM: 2, depthM: 1.2, ...extra })],
    ['plateInterceptor', (extra) => plateInterceptor({ flowM3S: 0.09, plateAreaM2: 2, nPlates: 40, ...extra })],
    ['hydrocyclone', (extra) => hydrocyclone({ flowM3S: 0.012, nLiners: 20, ...extra })],
    ['flotation', (extra) => flotation({ flowM3S: 0.05, cellVolumeM3: 8, nCells: 4, ...extra })],
    ['stokesRiseMS', (extra) => stokesRiseMS({ dMicron: 30, ...extra })],
  ];

  test('an oil heavier than the water is refused by every one of them', () => {
    // all four used to return d50cMicron: NaN with no error key, taking
    // the square root of a negative number, while stokesRiseMS refused
    // the identical input by name
    const failures = devices.map(([name, run]) => {
      const r = run(fluid);
      if (!r.error) return `${name} answered ${JSON.stringify(r.d50cMicron ?? r.vMS)} where it should have refused`;
      if (!/oil must be lighter/.test(r.error)) return `${name} refused with the wrong sentence: ${r.error}`;
      return null;
    }).filter(Boolean);
    expect(failures.join('\n')).toBe('');
  });

  test('a missing viscosity is refused by every one of them, by its own name', () => {
    const failures = devices.map(([name, run]) => {
      const r = run({ rhoWater: 1012, rhoOil: 850 });
      if (!r.error) return `${name} answered ${JSON.stringify(r.d50cMicron ?? r.vMS)} with no viscosity at all`;
      if (!/viscosity/.test(r.error)) return `${name} refused with a sentence that does not name the viscosity: ${r.error}`;
      return null;
    }).filter(Boolean);
    expect(failures.join('\n')).toBe('');
  });

  test('every device that reports a cut also reports the sharpness the train will use', () => {
    const common = { rhoWater: 1013.06, rhoOil: 844.41, muPaS: 5.895e-4 };
    const built = [
      apiSeparator({ ...common, flowM3S: 0.005, lengthM: 12, widthM: 2, depthM: 1.2 }),
      plateInterceptor({ ...common, flowM3S: 0.09, plateAreaM2: 2, nPlates: 40 }),
      hydrocyclone({ ...common, flowM3S: 0.09201, nLiners: 160 }),
      flotation({ ...common, flowM3S: 0.09201, cellVolumeM3: 8, nCells: 4 }),
      mediaFilter({ flowM3S: 0.09201, areaM2: 16 }),
    ];
    built.forEach((r) => {
      expect(r.error).toBeUndefined();
      expect(r.sharpness).toBeGreaterThan(0);
    });
    // the two interception devices carry the sharpness their own
    // capture law implies, and the gravity ones carry the declared
    // default: every device used to run at 3
    expect(built[3].sharpness).toBe(DECLARED_CONSTANTS.interceptionSharpness);
    expect(built[4].sharpness).toBe(DECLARED_CONSTANTS.interceptionSharpness);
    expect(built[0].sharpness).toBe(DECLARED_CONSTANTS.defaultSharpness);
  });
});
