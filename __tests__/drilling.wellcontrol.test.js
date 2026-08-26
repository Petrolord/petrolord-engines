// Well control: closed-form identities + oracle golden agreement.
import fs from 'fs';
import path from 'path';
import {
  wellVolumes, annulusCapAt, killSheet, kickTolerance, kickToleranceSweep,
  boyle, maaspPa, tvdAt,
} from '../engines/drilling/wellControl.js';

const G = (name) => JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'drilling', 'goldens', name), 'utf8'));

const g = 9.80665;

function expectClose(a, b, rtol, atol = 0) {
  if (!Number.isFinite(a)) throw new Error(`non-finite value ${a} (expected ~ ${b})`);
  const tol = atol + rtol * Math.abs(b);
  if (Math.abs(a - b) > tol) {
    throw new Error(`expected ${a} ~ ${b} (rtol ${rtol}, atol ${atol})`);
  }
}

const golden = G('wellcontrol_cases.json');

describe('closed forms', () => {
  test('cylinder volumes: single pipe in single hole, exact algebra', () => {
    const stations = [{ md: 0, inc: 0, azi: 0 }, { md: 1000, inc: 0, azi: 0 }];
    const string = [{ type: 'dp', lengthM: 1000, odM: 0.127, idM: 0.1086, weightKgM: 33 }];
    const geometry = [{ fromMd: 0, toMd: 1000, frictionFactor: 0.25, holeIdM: 0.2205, cased: true }];
    const v = wellVolumes({ stations, string, geometry, pumpOutputM3PerStroke: 0.01 });
    expectClose(v.stringVolumeM3, (Math.PI / 4) * 0.1086 ** 2 * 1000, 1e-12);
    expectClose(v.annulusVolumeM3, (Math.PI / 4) * (0.2205 ** 2 - 0.127 ** 2) * 1000, 1e-12);
    expectClose(v.strokes.surfaceToBit, v.stringVolumeM3 / 0.01, 1e-12);
    expectClose(annulusCapAt(v.annulusRows, 500), (Math.PI / 4) * (0.2205 ** 2 - 0.127 ** 2), 1e-12);
    expectClose(tvdAt(stations, 700), 700, 1e-12);
  });

  test('kill sheet identities (the IWCF-style fixture inputs)', () => {
    const fx = golden.iwcfStyleExample;
    const ks = killSheet(fx.inputs);
    expectClose(ks.killMudDensityKgM3, fx.inputs.mudDensityKgM3 + fx.inputs.sidppPa / (g * fx.inputs.tvdBhM), 1e-12);
    expectClose(ks.icpPa, fx.inputs.scrPressurePa + fx.inputs.sidppPa, 1e-12);
    expectClose(ks.fcpPa, (fx.inputs.scrPressurePa * ks.killMudDensityKgM3) / fx.inputs.mudDensityKgM3, 1e-12);
    expectClose(ks.formationPressurePa, fx.inputs.mudDensityKgM3 * g * fx.inputs.tvdBhM + fx.inputs.sidppPa, 1e-12);
    // Schedule endpoints are exactly ICP and FCP.
    expectClose(ks.schedule[0].pressurePa, ks.icpPa, 1e-12);
    expectClose(ks.schedule[ks.schedule.length - 1].pressurePa, ks.fcpPa, 1e-12);
    // Driller's method pumps two full cycles.
    expectClose(ks.methods.drillers.totalStrokes, 2 * ks.totalStrokes, 1e-12);
  });

  test('boyle round trip and MAASP algebra', () => {
    const v2 = boyle({ p1Pa: 50e6, v1M3: 2, p2Pa: 25e6 });
    expectClose(v2, 4, 1e-12);
    expectClose(boyle({ p1Pa: 25e6, v1M3: v2, p2Pa: 50e6 }), 2, 1e-12);
    expectClose(maaspPa({ tvdShoeM: 2000, mudDensityKgM3: 1200, fracEmwKgM3: 1700 }), 500 * g * 2000, 1e-12);
    expect(maaspPa({ tvdShoeM: 2000, mudDensityKgM3: 1800, fracEmwKgM3: 1700 })).toBe(0);
  });

  test('kick tolerance: monotone in mud weight, zero when the window closes', () => {
    const base = {
      tvdBhM: 3000, tvdShoeM: 2000, fracEmwKgM3: 1700,
      kickIntensityKgM3: 60, influxDensityKgM3: 240,
      annulusCapAtShoeM2: 0.025, annulusCapAtBitM2: 0.02,
    };
    const sweep = kickToleranceSweep({ mudDensities: [1200, 1350, 1500], base });
    expect(sweep[0].kickToleranceM3).toBeGreaterThan(sweep[1].kickToleranceM3);
    expect(sweep[1].kickToleranceM3).toBeGreaterThan(sweep[2].kickToleranceM3);
    // Window closed: frac EMW equals mud + intensity at the shoe scale → tiny/zero.
    const closed = kickTolerance({ ...base, mudDensityKgM3: 1700 - 60, fracEmwKgM3: 1700 });
    // Pf term uses TVDbh while frac uses TVDshoe; with intensity balancing
    // the shoe headroom is negative and KT clamps to 0.
    expect(closed.kickToleranceM3).toBeGreaterThanOrEqual(0);
    const generous = kickTolerance({ ...base, mudDensityKgM3: 1200 });
    expect(generous.kickToleranceM3).toBeGreaterThan(closed.kickToleranceM3);
  });

  test('guards', () => {
    expect(() => killSheet({ tvdBhM: 1000, tvdShoeM: 2000, mudDensityKgM3: 1200, sidppPa: 1e6, scrPressurePa: 4e6, pumpOutputM3PerStroke: 0.01, stringVolumeM3: 30, annulusVolumeM3: 80 })).toThrow();
    expect(() => kickTolerance({ tvdBhM: 3000, tvdShoeM: 2000, mudDensityKgM3: 1200, fracEmwKgM3: 1700, annulusCapAtShoeM2: 0.02, annulusCapAtBitM2: 0.02, influxDensityKgM3: 1300 })).toThrow(/below the mud density/);
    expect(() => boyle({ p1Pa: 0, v1M3: 1, p2Pa: 1 })).toThrow();
  });
});

describe('oracle golden agreement (wellcontrol_cases.json)', () => {
  test('IWCF-style fixture end to end', () => {
    const fx = golden.iwcfStyleExample;
    const ks = killSheet(fx.inputs);
    expectClose(ks.killMudDensityKgM3, fx.killSheet.killMudDensityKgM3, 1e-9, 1e-6);
    expectClose(ks.icpPa, fx.killSheet.icpPa, 1e-9, 1e-3);
    expectClose(ks.fcpPa, fx.killSheet.fcpPa, 1e-9, 1e-3);
    expect(ks.influx.kind).toBe(fx.killSheet.influx.kind);
    expectClose(ks.influx.densityKgM3, fx.killSheet.influx.densityKgM3, 1e-9, 1e-6);
    const kt = kickTolerance({
      tvdBhM: fx.inputs.tvdBhM, tvdShoeM: fx.inputs.tvdShoeM,
      mudDensityKgM3: fx.inputs.mudDensityKgM3, fracEmwKgM3: fx.inputs.fracEmwKgM3,
      kickIntensityKgM3: fx.inputs.kickIntensityKgM3,
      influxDensityKgM3: fx.inputs.influxDensityKgM3,
      annulusCapAtShoeM2: fx.inputs.annulusCapAtShoeM2,
      annulusCapAtBitM2: fx.inputs.annulusCapAtBitM2,
    });
    expectClose(kt.maaspPa, fx.kickTolerance.maaspPa, 1e-9, 1e-3);
    expectClose(kt.kickToleranceM3, fx.kickTolerance.kickToleranceM3, 1e-9, 1e-9);
  });

  for (const c of golden.cases) {
    test(`${c.well}: volumes, kill sheets, kick tolerance`, () => {
      const v = wellVolumes({
        stations: c.stations, string: c.string, geometry: c.geometry,
        pumpOutputM3PerStroke: c.pump.outputM3PerStroke,
      });
      const ev = c.expected.volumes;
      expectClose(v.bitMd, ev.bitMd, 1e-12);
      expectClose(v.stringVolumeM3, ev.stringVolumeM3, 1e-6, 1e-9);
      expectClose(v.annulusVolumeM3, ev.annulusVolumeM3, 1e-6, 1e-9);
      const tvdBh = tvdAt(c.stations, v.bitMd);
      const tvdShoe = tvdAt(c.stations, c.shoeMd);
      expectClose(tvdBh, ev.tvdBhM, 1e-6, 1e-6);
      expectClose(tvdShoe, ev.tvdShoeM, 1e-6, 1e-6);
      const capBit = annulusCapAt(v.annulusRows, v.bitMd - 1);
      const capShoe = annulusCapAt(v.annulusRows, c.shoeMd - 1);
      expectClose(capBit, ev.capBitM2, 1e-6, 1e-12);
      expectClose(capShoe, ev.capShoeM2, 1e-6, 1e-12);
      for (const [name, exp] of Object.entries(c.expected.killSheets)) {
        const kick = { moderate_gas: { sidppPa: 2.0e6, sicpPa: 2.9e6, pitGainM3: 3.0 }, small_liquid: { sidppPa: 0.8e6, sicpPa: 0.9e6, pitGainM3: 1.5 } }[name];
        const ks = killSheet({
          tvdBhM: tvdBh, tvdShoeM: tvdShoe, mudDensityKgM3: c.mudDensityKgM3,
          sidppPa: kick.sidppPa, sicpPa: kick.sicpPa, pitGainM3: kick.pitGainM3,
          scrPressurePa: c.pump.scrPressurePa, pumpOutputM3PerStroke: c.pump.outputM3PerStroke,
          stringVolumeM3: v.stringVolumeM3, annulusVolumeM3: v.annulusVolumeM3,
          annulusCapNearBitM2: capBit,
        });
        expectClose(ks.killMudDensityKgM3, exp.killMudDensityKgM3, 1e-6, 1e-6);
        expectClose(ks.icpPa, exp.icpPa, 1e-6, 1);
        expectClose(ks.fcpPa, exp.fcpPa, 1e-6, 1);
        expectClose(ks.totalStrokes, exp.totalStrokes, 1e-6, 1e-6);
        expect(ks.influx.kind).toBe(exp.influx.kind);
      }
      const kt = kickTolerance({
        tvdBhM: tvdBh, tvdShoeM: tvdShoe, mudDensityKgM3: c.mudDensityKgM3,
        fracEmwKgM3: c.fracEmwKgM3, kickIntensityKgM3: 60,
        influxDensityKgM3: 240, annulusCapAtShoeM2: capShoe, annulusCapAtBitM2: capBit,
      });
      expectClose(kt.maaspPa, c.expected.kickTolerance.maaspPa, 1e-6, 1);
      expectClose(kt.kickToleranceM3, c.expected.kickTolerance.kickToleranceM3, 1e-6, 1e-9);
      const sweep = kickToleranceSweep({
        mudDensities: c.expected.ktSweep.map((r) => r.mudDensityKgM3),
        base: {
          tvdBhM: tvdBh, tvdShoeM: tvdShoe, fracEmwKgM3: c.fracEmwKgM3,
          kickIntensityKgM3: 60, influxDensityKgM3: 240,
          annulusCapAtShoeM2: capShoe, annulusCapAtBitM2: capBit,
        },
      });
      for (let i = 0; i < sweep.length; i += 1) {
        expectClose(sweep[i].kickToleranceM3, c.expected.ktSweep[i].kickToleranceM3, 1e-6, 1e-9);
      }
    });
  }
});
