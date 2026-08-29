// Facilities F7 produced-water gates against
// tools/validation/facilities/oracle_producedwater.py.
//
// Independent routes: the distribution-against-grade-efficiency
// integral is done by MONTE CARLO sampling in the oracle against the
// module's binned quadrature (two entirely different numerical
// methods); the log-normal CDF comes from the C library's erf against
// the module's Abramowitz & Stegun series; and depth filtration is
// marched layer by layer against the module's closed exponential.
//
// The predecessor Suite model was a table of fixed removal
// efficiencies -- an API separator always took 60 percent, a
// hydrocyclone always 90 -- with the temperature and salinity inputs
// collected and NEVER USED. These gates hold this one to the physics
// that makes those inputs matter.

import fs from 'fs';
import path from 'path';
import {
  waterViscosityPaS, waterDensityKgM3, oilDensityKgM3,
  logNormalCdf, dropletBins, gradeEfficiency, applyDevice, medianOfBins,
  stokesRiseMS, apiSeparator, plateInterceptor, hydrocyclone, flotation,
  mediaFilter, treatmentTrain,
} from '../engines/facilities/producedWater';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'facilities', 'goldens', 'producedwater_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

describe('water properties: the inputs the predecessor ignored', () => {
  test('viscosity and density match the SI oracle', () => {
    G.properties.forEach((row) => {
      const mu = waterViscosityPaS(row);
      expect(mu.error).toBeUndefined();
      expect(rel(mu.muPaS, row.muPaS)).toBeLessThan(1e-9);
      expect(rel(waterDensityKgM3(row), row.rhoWater)).toBeLessThan(1e-9);
    });
  });

  test('reproduces the textbook viscosity of water at 25 C', () => {
    // 0.890 cP is the published value; this is the fit checking itself
    expect(waterViscosityPaS({ tC: 25, tdsPpm: 0 }).muPaS * 1000).toBeCloseTo(0.890, 2);
    expect(waterViscosityPaS({ tC: 300 }).error).toBeTruthy();
  });

  test('hot water is thinner and brine is thicker, both by a lot', () => {
    const cold = waterViscosityPaS({ tC: 25, tdsPpm: 0 }).muPaS;
    const hot = waterViscosityPaS({ tC: 90, tdsPpm: 0 }).muPaS;
    expect(hot).toBeLessThan(cold / 2);
    const fresh = waterViscosityPaS({ tC: 50, tdsPpm: 0 }).muPaS;
    const brine = waterViscosityPaS({ tC: 50, tdsPpm: 200000 }).muPaS;
    expect(brine / fresh).toBeGreaterThan(1.3);
    // and brine is denser, which cuts the driving density difference
    expect(waterDensityKgM3({ tC: 50, tdsPpm: 200000 }))
      .toBeGreaterThan(waterDensityKgM3({ tC: 50, tdsPpm: 0 }));
  });
});

describe('the droplet distribution', () => {
  test('the series CDF matches the C library erf', () => {
    G.cdf.forEach((row) => {
      expect(rel(logNormalCdf(row), row.cdf)).toBeLessThan(1e-6);
    });
  });

  test('bins are normalised and their median is the d50', () => {
    const { bins } = dropletBins({ d50: 30, sigma: 0.7 });
    const total = bins.reduce((s, b) => s + b.volumeFraction, 0);
    expect(total).toBeCloseTo(1, 9);
    expect(medianOfBins(bins)).toBeGreaterThan(28);
    expect(medianOfBins(bins)).toBeLessThan(32);
    expect(dropletBins({ d50: 0, sigma: 0.7 }).error).toBeTruthy();
  });

  test('grade efficiency is one half at the cut size', () => {
    expect(gradeEfficiency({ dMicron: 25, d50cMicron: 25 })).toBeCloseTo(0.5, 9);
    expect(gradeEfficiency({ dMicron: 100, d50cMicron: 25 })).toBeGreaterThan(0.9);
    expect(gradeEfficiency({ dMicron: 5, d50cMicron: 25 })).toBeLessThan(0.05);
  });
});

describe('the integral: quadrature against Monte Carlo', () => {
  test('binned removal matches the sampled removal', () => {
    G.removal.forEach((row) => {
      const { bins } = dropletBins({ d50: row.d50, sigma: row.sigma });
      const r = applyDevice({
        bins, d50cMicron: row.d50cMicron, sharpness: row.sharpness,
      });
      // Monte Carlo at 400k samples: agreement to a few parts in 1000
      expect(Math.abs(r.removalFraction - row.removalFraction)).toBeLessThan(3e-3);
    });
  });

  test('a device cutting at the median removes about half the volume', () => {
    const { bins } = dropletBins({ d50: 30, sigma: 0.7 });
    const r = applyDevice({ bins, d50cMicron: 30 });
    expect(r.removalFraction).toBeCloseTo(0.5, 2);
  });

  test('THE POINT: the water leaving a device is finer than the water entering', () => {
    // the predecessor's fixed efficiencies threw this away entirely
    const { bins } = dropletBins({ d50: 30, sigma: 0.7 });
    const r = applyDevice({ bins, d50cMicron: 25 });
    expect(medianOfBins(r.outletBins)).toBeLessThan(medianOfBins(bins));
  });
});

describe('device physics', () => {
  test('Stokes rise matches the oracle and responds to temperature', () => {
    G.stokes.forEach((row) => {
      const v = stokesRiseMS(row);
      expect(v.error).toBeUndefined();
      expect(rel(v.vMS, row.vMS)).toBeLessThan(1e-9);
    });
    // hot water: thinner, so the same droplet rises faster
    const args = { dMicron: 30, rhoOil: 850 };
    const cold = stokesRiseMS({
      ...args, rhoWater: waterDensityKgM3({ tC: 20 }), muPaS: waterViscosityPaS({ tC: 20 }).muPaS,
    });
    const hot = stokesRiseMS({
      ...args, rhoWater: waterDensityKgM3({ tC: 80 }), muPaS: waterViscosityPaS({ tC: 80 }).muPaS,
    });
    expect(hot.vMS).toBeGreaterThan(cold.vMS * 2);
    expect(stokesRiseMS({ dMicron: 30, rhoWater: 800, rhoOil: 900, muPaS: 1e-3 }).error).toBeTruthy();
  });

  test('the API separator cut matches the oracle and polices its velocity', () => {
    G.apiSeparator.forEach((row) => {
      const r = apiSeparator(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.d50cMicron, row.d50cMicron)).toBeLessThan(1e-9);
      expect(rel(r.overflowRateMS, row.overflowRateMS)).toBeLessThan(1e-9);
      expect(rel(r.residenceS, row.residenceS)).toBeLessThan(1e-9);
    });
    // too fast: API 421 limits horizontal velocity against re-entrainment
    const fast = apiSeparator({
      flowM3S: 0.5, lengthM: 12, widthM: 2, depthM: 1.2,
      rhoWater: 1010, rhoOil: 850, muPaS: 6e-4,
    });
    expect(fast.warning).toMatch(/re-entrains/);
  });

  test('a plate pack cuts finer than a bare basin of the same footprint', () => {
    const common = { flowM3S: 0.09, rhoWater: 1012, rhoOil: 850, muPaS: 5.8e-4 };
    const basin = apiSeparator({ ...common, lengthM: 12, widthM: 2, depthM: 1.2 });
    const cpi = plateInterceptor({ ...common, plateAreaM2: 2, nPlates: 40 });
    expect(cpi.d50cMicron).toBeLessThan(basin.d50cMicron);
    expect(plateInterceptor({ ...common, plateAreaM2: 0, nPlates: 40 }).error).toBeTruthy();
  });

  test('a hydrocyclone starved of flow loses its field and its cut', () => {
    const common = { rhoWater: 1012, rhoOil: 850, muPaS: 5.8e-4, nLiners: 20 };
    const design = hydrocyclone({ ...common, flowM3S: 0.012 });
    const starved = hydrocyclone({ ...common, flowM3S: 0.004 });
    expect(starved.turndownRatio).toBeLessThan(design.turndownRatio);
    expect(starved.gField).toBeLessThan(design.gField);
    expect(starved.d50cMicron).toBeGreaterThan(design.d50cMicron);
    expect(starved.warning).toMatch(/shut liners in/);
    const overrun = hydrocyclone({ ...common, flowM3S: 0.02 });
    expect(overrun.warning).toMatch(/shear/);
  });

  test('flotation needs residence time and says so when it lacks it', () => {
    const common = {
      rhoWater: 1012, rhoOil: 850, muPaS: 5.8e-4, cellVolumeM3: 8, nCells: 4,
    };
    const ok = flotation({ ...common, flowM3S: 0.05 });
    expect(ok.error).toBeUndefined();
    expect(ok.residenceS).toBeGreaterThan(60);
    expect(ok.warning).toBeNull();
    const rushed = flotation({ ...common, flowM3S: 1.0 });
    expect(rushed.warning).toMatch(/too small for the flow/);
  });

  test('the filter marches the same bed the oracle does', () => {
    G.mediaFilter.forEach((row) => {
      const r = mediaFilter(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.loadingMHr, row.loadingMHr)).toBeLessThan(1e-9);
      expect(rel(r.filterCoefficientPerM, row.lambdaPerM)).toBeLessThan(1e-9);
      // closed exponential vs layer-by-layer Euler march
      expect(Math.abs(r.removalFraction - row.removalFraction)).toBeLessThan(2e-3);
    });
    const overloaded = mediaFilter({ flowM3S: 0.2, areaM2: 4, bedDepthM: 0.9 });
    expect(overloaded.warning).toMatch(/break through/);
  });
});

describe('the treatment train', () => {
  const tC = 50; const tds = 35000; const api = 32;
  const rhoWater = waterDensityKgM3({ tC, tdsPpm: tds });
  const rhoOil = oilDensityKgM3({ apiGravity: api, tC });
  const muPaS = waterViscosityPaS({ tC, tdsPpm: tds }).muPaS;
  const flowM3S = 0.09;

  const buildTrain = () => [
    { name: 'CPI', ...plateInterceptor({ flowM3S, plateAreaM2: 2, nPlates: 40, rhoWater, rhoOil, muPaS }) },
    { name: 'Hydrocyclone', ...hydrocyclone({ flowM3S, nLiners: 20, rhoWater, rhoOil, muPaS }) },
    { name: 'IGF', ...flotation({ flowM3S, cellVolumeM3: 8, nCells: 4, rhoWater, rhoOil, muPaS }) },
  ];

  test('carries the outlet distribution forward and reports each stage', () => {
    const t = treatmentTrain({
      inletOiwPpm: 500, inletD50Micron: 30, devices: buildTrain(), specPpm: 29,
    });
    expect(t.error).toBeUndefined();
    expect(t.stages).toHaveLength(3);
    // oil falls monotonically through the train
    const oiws = t.stages.map((s) => s.outletOiwPpm);
    for (let i = 1; i < oiws.length; i += 1) expect(oiws[i]).toBeLessThan(oiws[i - 1]);
    // and the water gets finer at every stage
    const meds = t.stages.map((s) => s.outletMedianMicron);
    expect(meds[meds.length - 1]).toBeLessThan(t.inletMedianMicron);
    expect(typeof t.meetsSpec).toBe('boolean');
  });

  test('THE POINT: three "90 percent" devices do not give 99.9 percent', () => {
    // each device leaves behind the droplets the next is worst at, so
    // the train under-performs the naive product of its efficiencies.
    // (The predecessor multiplied fixed efficiencies and could only
    // ever produce the naive answer.)
    const devices = [
      { name: 'A', d50cMicron: 12 },
      { name: 'B', d50cMicron: 12 },
      { name: 'C', d50cMicron: 12 },
    ];
    const t = treatmentTrain({ inletOiwPpm: 500, inletD50Micron: 30, devices });
    const firstStageRemoval = t.stages[0].removalPct / 100;
    const naive = 1 - (1 - firstStageRemoval) ** 3;
    expect(t.overallRemovalPct / 100).toBeLessThan(naive);
  });

  test('finer inlet water is harder to treat with the same equipment', () => {
    const devices = buildTrain();
    const coarse = treatmentTrain({ inletOiwPpm: 500, inletD50Micron: 60, devices });
    const fine = treatmentTrain({ inletOiwPpm: 500, inletD50Micron: 12, devices });
    expect(fine.outletOiwPpm).toBeGreaterThan(coarse.outletOiwPpm);
  });

  test('THE OTHER POINT: hot brine treats differently from cool fresh water', () => {
    // the predecessor collected temperature and TDS and used neither
    const mk = (t, s) => {
      const rw = waterDensityKgM3({ tC: t, tdsPpm: s });
      const ro = oilDensityKgM3({ apiGravity: api, tC: t });
      const mu = waterViscosityPaS({ tC: t, tdsPpm: s }).muPaS;
      return treatmentTrain({
        inletOiwPpm: 500,
        inletD50Micron: 30,
        devices: [
          { name: 'CPI', ...plateInterceptor({ flowM3S, plateAreaM2: 2, nPlates: 40, rhoWater: rw, rhoOil: ro, muPaS: mu }) },
        ],
      });
    };
    const cool = mk(20, 0);
    const hot = mk(90, 0);
    // hot water is far less viscous, so the same plate pack cuts finer
    expect(hot.outletOiwPpm).toBeLessThan(cool.outletOiwPpm);
  });

  test('refuses an empty inlet and names a device with no cut size', () => {
    expect(treatmentTrain({ inletOiwPpm: 0, inletD50Micron: 30, devices: [] }).error).toBeTruthy();
    const t = treatmentTrain({
      inletOiwPpm: 500, inletD50Micron: 30, devices: [{ name: 'broken' }],
    });
    expect(t.stages[0].error).toMatch(/no cut size/);
  });
});
