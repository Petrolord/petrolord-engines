// Production P4 gas-lift engine gates: closed forms the physics must
// satisfy exactly, plus agreement with the independent stdlib oracle
// (tools/validation/production/oracle_gaslift.py) through its committed
// goldens. The oracle integrates the gas column with RK4 at 20x the
// engine's step count and brackets every root by bisection where the
// engine iterates a fixed point, so agreement here is two
// discretizations of the same physics meeting, not code echoing itself.
//
// The unloading verdict is gated as a verdict, per stage and per valve,
// together with the closing margin it turns on, including a design whose
// stage-5 answer sits on 0.15 psi. Asserting only that 10 psi per valve
// multipoints and 90 psi per valve does not tests the direction of the
// rule and leaves the whole band a real design sits in untested.

import fs from 'fs';
import path from 'path';
import {
  dakZ, naturalGasZ, nitrogenZ, gasGradient, gasColumnPressure,
  gasColumnSurfacePressure, suttonPseudoCriticals, wichertAziz,
  AIR_MW, R_UNIVERSAL, toRankine,
} from '../engines/production/gasProperties';
import {
  portArea, portToBellowsRatio, domePressureAtTemp, domePressureAt60,
  temperatureCorrectionFactor, ipoOpeningPressure, ipoDomeFromOpening,
  ppoOpeningPressure, ppoDomeFromOpening, testRackOpening, domeFromTestRack,
  valveSpread, thornhillCraver, criticalPressureRatio, selectPort,
} from '../engines/production/gasLiftValves';
import {
  linearTemperature, injectionPressureCurve, topValveDepth, spaceValves,
  valveSetting, designGasLift, deepestInjectionPoint, unloadingSequence,
} from '../engines/production/gasLiftDesign';
import { VALVE_FAMILIES, valveFamily } from '../engines/production/data/gasLiftValveCatalog';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'production', 'goldens', 'gaslift_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
const tempFn = (whtF, bhtF, refDepthFt) => linearTemperature({ whtF, bhtF, refDepthFt });

describe('gas properties', () => {
  test('DAK root satisfies the DAK equation it was solved from', () => {
    for (const [ppr, tpr] of [[1.5, 1.6], [3, 2.2], [6, 1.4], [0.5, 3]]) {
      const { z, rhoR, converged } = dakZ({ ppr, tpr });
      expect(converged).toBe(true);
      // rhoR = 0.27 ppr / (z tpr) is the closure the solve enforces
      expect(rel(rhoR, (0.27 * ppr) / (z * tpr))).toBeLessThan(1e-9);
    }
  });

  test('z goes to the ideal-gas limit as pressure vanishes', () => {
    expect(naturalGasZ({ pPsia: 1e-6, tF: 150, gasSg: 0.65 })).toBeCloseTo(1, 8);
    expect(nitrogenZ({ pPsia: 1e-6, tF: 60 })).toBeCloseTo(1, 8);
  });

  test('Wichert-Aziz lowers the pseudo-critical temperature and does nothing without acid gas', () => {
    const base = suttonPseudoCriticals(0.75);
    const sour = wichertAziz({ ...base, yCo2: 0.08, yH2s: 0.04 });
    expect(sour.tpcR).toBeLessThan(base.tpcR);
    expect(sour.epsilon).toBeGreaterThan(0);
    const sweet = wichertAziz({ ...base });
    expect(sweet.tpcR).toBe(base.tpcR);
    expect(sweet.ppcPsia).toBe(base.ppcPsia);
  });

  test('z and gradient match the oracle', () => {
    for (const c of G.gasProperties) {
      expect(rel(naturalGasZ({ pPsia: c.pPsia, tF: c.tF, gasSg: c.gasSg }), c.z)).toBeLessThan(1e-8);
      expect(rel(gasGradient({ pPsia: c.pPsia, tF: c.tF, gasSg: c.gasSg }), c.gradPsiPerFt)).toBeLessThan(1e-9);
    }
    for (const c of G.gasPropertiesAcid) {
      const z = naturalGasZ({ pPsia: c.pPsia, tF: c.tF, gasSg: c.gasSg, yCo2: c.yCo2, yH2s: c.yH2s });
      expect(rel(z, c.z)).toBeLessThan(1e-8);
    }
  });
});

describe('static injection-gas column', () => {
  test('isothermal ideal-gas column reproduces the exponential closed form', () => {
    const tF = 140;
    const sg = 0.65;
    const depth = 8000;
    const march = gasColumnPressure({
      pSurfPsia: 1000, tvdFt: depth, gasSg: sg, tempAtDepthF: () => tF,
      steps: 400, zOverride: 1,
    }).pBottomPsia;
    const exact = 1000 * Math.exp((AIR_MW * sg * depth) / (144 * R_UNIVERSAL * toRankine(tF)));
    expect(rel(march, exact)).toBeLessThan(1e-8);
  });

  test('column and its inverse round-trip', () => {
    const temp = tempFn(100, 190, 8000);
    const bottom = gasColumnPressure({
      pSurfPsia: 1014.7, tvdFt: 6000, gasSg: 0.65, tempAtDepthF: temp,
    }).pBottomPsia;
    const back = gasColumnSurfacePressure({
      pAtDepthPsia: bottom, tvdFt: 6000, gasSg: 0.65, tempAtDepthF: temp,
    });
    expect(rel(back, 1014.7)).toBeLessThan(1e-9);
  });

  test('column pressures match the oracle RK4 integration', () => {
    for (const c of G.columns) {
      const temp = tempFn(c.whtF, c.bhtF, c.tvdFt);
      const p = gasColumnPressure({
        pSurfPsia: c.pSurfPsia, tvdFt: c.tvdFt, gasSg: c.gasSg, tempAtDepthF: temp,
      }).pBottomPsia;
      expect(rel(p, c.pBottomPsia)).toBeLessThan(1e-6);
    }
  });
});

describe('nitrogen dome charge', () => {
  test('dome pressure round-trips between 60 degF and valve temperature', () => {
    for (const [pd60, tF] of [[600, 120], [900, 200], [1400, 260]]) {
      const pdT = domePressureAtTemp({ pd60Psia: pd60, tF });
      expect(pdT).toBeGreaterThan(pd60);
      expect(rel(domePressureAt60({ pdTPsia: pdT, tF }), pd60)).toBeLessThan(1e-9);
    }
  });

  test('dome pressures and Ct match the oracle', () => {
    for (const c of G.nitrogen) {
      const pdT = domePressureAtTemp({ pd60Psia: c.pd60Psia, tF: c.tF });
      expect(rel(pdT, c.domeAtTempPsia)).toBeLessThan(1e-8);
      expect(rel(temperatureCorrectionFactor({ pdTPsia: pdT, tF: c.tF }), c.ct)).toBeLessThan(1e-8);
    }
  });

  test('Ct falls as the valve gets hotter and is 1 at the test rack', () => {
    const cts = [80, 140, 200, 260].map((tF) => {
      const pdT = domePressureAtTemp({ pd60Psia: 800, tF });
      return temperatureCorrectionFactor({ pdTPsia: pdT, tF });
    });
    for (let i = 1; i < cts.length; i += 1) expect(cts[i]).toBeLessThan(cts[i - 1]);
    const at60 = domePressureAtTemp({ pd60Psia: 800, tF: 60 });
    expect(rel(at60, 800)).toBeLessThan(1e-9);
  });
});

describe('valve force balance', () => {
  const r = portToBellowsRatio({ portIdIn: 0.25, bellowsAreaIn2: 0.77 });

  test('published R geometry: 1/8 in port in a 1 in valve, 1/4 in in a 1.5 in valve', () => {
    expect(portToBellowsRatio({ portIdIn: 0.125, bellowsAreaIn2: 0.31 })).toBeCloseTo(0.0396, 4);
    expect(r).toBeCloseTo(0.0637, 4);
    expect(portArea(0.5)).toBeCloseTo(0.19635, 5);
  });

  test('IPO opening pressure and its dome inverse round-trip', () => {
    const pdT = 1000;
    const pt = 400;
    const pco = ipoOpeningPressure({ pdTPsia: pdT, ptPsia: pt, r });
    expect(rel(ipoDomeFromOpening({ pcoPsia: pco, ptPsia: pt, r }), pdT)).toBeLessThan(1e-12);
    // the port area works against the dome, so the valve opens above the
    // dome pressure by exactly its spread
    expect(pco - pdT).toBeCloseTo(valveSpread({ pOpenPsia: pco, pOtherSidePsia: pt, r }), 9);
  });

  test('PPO is the IPO balance with casing and tubing swapped', () => {
    const pdT = 1000;
    const ipo = ipoOpeningPressure({ pdTPsia: pdT, ptPsia: 400, r });
    const ppo = ppoOpeningPressure({ pdTPsia: pdT, pcPsia: 400, r });
    expect(rel(ppo, ipo)).toBeLessThan(1e-12);
    expect(rel(ppoDomeFromOpening({ ptoPsia: ppo, pcPsia: 400, r }), pdT)).toBeLessThan(1e-12);
  });

  test('test-rack opening and its dome inverse round-trip, and TRO exceeds the charge', () => {
    const tro = testRackOpening({ pd60Psia: 800, r });
    expect(tro).toBeGreaterThan(800);
    expect(rel(domeFromTestRack({ troPsia: tro, r }), 800)).toBeLessThan(1e-12);
  });

  test('spread is the opening-to-closing difference of the same balance', () => {
    const pdT = 1000;
    const pt = 400;
    const pco = ipoOpeningPressure({ pdTPsia: pdT, ptPsia: pt, r });
    expect(rel(valveSpread({ pOpenPsia: pco, pOtherSidePsia: pt, r }), pco - pdT)).toBeLessThan(1e-12);
    // and the dome form of the same identity
    expect(rel((r / (1 - r)) * (pdT - pt), pco - pdT)).toBeLessThan(1e-12);
  });

  test('a bigger port means a bigger R and a wider spread', () => {
    const small = portToBellowsRatio({ portIdIn: 0.25, bellowsAreaIn2: 0.77 });
    const big = portToBellowsRatio({ portIdIn: 0.5, bellowsAreaIn2: 0.77 });
    expect(big).toBeGreaterThan(small);
    const spSmall = valveSpread({ pOpenPsia: 1000, pOtherSidePsia: 400, r: small });
    const spBig = valveSpread({ pOpenPsia: 1000, pOtherSidePsia: 400, r: big });
    expect(spBig).toBeGreaterThan(spSmall);
  });
});

describe('Thornhill-Craver throughput', () => {
  test('the subcritical branch joins the clamped branch continuously', () => {
    const k = 1.27;
    const rc = criticalPressureRatio(k);
    const base = { pUpPsia: 1000, portIdIn: 0.25, gasSg: 0.65, tF: 140, k };
    const just = thornhillCraver({ ...base, pDnPsia: 1000 * (rc + 1e-9) });
    const at = thornhillCraver({ ...base, pDnPsia: 1000 * rc });
    const below = thornhillCraver({ ...base, pDnPsia: 1000 * (rc - 0.1) });
    expect(rel(just.qMscfd, at.qMscfd)).toBeLessThan(1e-6);
    expect(rel(below.qMscfd, at.qMscfd)).toBeLessThan(1e-12);
    expect(below.regime).toBe('critical');
    expect(just.regime).toBe('subcritical');
  });

  test('throughput scales with port area and dies at zero differential', () => {
    const base = { pUpPsia: 1000, pDnPsia: 400, gasSg: 0.65, tF: 140 };
    const q1 = thornhillCraver({ ...base, portIdIn: 0.25 }).qMscfd;
    const q2 = thornhillCraver({ ...base, portIdIn: 0.5 }).qMscfd;
    expect(rel(q2 / q1, 4)).toBeLessThan(1e-12);
    expect(thornhillCraver({ ...base, pDnPsia: 1000, portIdIn: 0.25 }).qMscfd).toBe(0);
  });

  test('throughput matches the oracle', () => {
    for (const c of G.thornhillCraver) {
      const q = thornhillCraver({
        pUpPsia: c.pUpPsia, pDnPsia: c.pDnPsia, portIdIn: c.portIdIn,
        gasSg: c.gasSg, tF: c.tF,
      });
      expect(rel(q.qMscfd, c.qMscfd)).toBeLessThan(1e-10);
      expect(rel(q.criticalRatio, c.criticalRatio)).toBeLessThan(1e-11);
    }
  });

  test('selectPort takes the smallest port that carries the target', () => {
    const fam = valveFamily('r15');
    const pick = selectPort({
      ports: fam.ports, targetMscfd: 500, pUpPsia: 1000, pDnPsia: 400,
      gasSg: 0.65, tF: 140,
    });
    expect(pick.port).not.toBeNull();
    expect(pick.qMscfd).toBeGreaterThanOrEqual(500);
    const smaller = pick.candidates.filter((c) => c.port.idIn < pick.port.idIn);
    smaller.forEach((c) => expect(c.qMscfd).toBeLessThan(500));
  });

  test('an unreachable target returns no port rather than pretending', () => {
    const fam = valveFamily('r1');
    const pick = selectPort({
      ports: fam.ports, targetMscfd: 50000, pUpPsia: 800, pDnPsia: 700,
      gasSg: 0.65, tF: 140,
    });
    expect(pick.port).toBeNull();
  });
});

const caseCfg = (g) => {
  const i = g.inputs;
  return {
    ...i,
    tempAtDepthF: tempFn(i.wht, i.bht, i.refDepth),
    ports: i.ports.map((idIn) => ({ idIn, label: `${idIn}` })),
  };
};

describe('valve spacing and settings', () => {
  test('the top valve balances a full kill-fluid column against the injection line', () => {
    const temp = tempFn(100, 190, 8000);
    const d = topValveDepth({
      pKickoffPsia: 1014.7, pWhUnloadPsia: 114.7, killGradPsiPerFt: 0.45,
      gasSg: 0.65, tempAtDepthF: temp, maxDepthFt: 7500,
    });
    const pInj = gasColumnPressure({
      pSurfPsia: 1014.7, tvdFt: d, gasSg: 0.65, tempAtDepthF: temp, steps: 20,
    }).pBottomPsia;
    expect(Math.abs(pInj - 114.7 - 0.45 * d)).toBeLessThan(0.05);
  });

  test.each(G.designs.map((d) => [d.id, d]))('design %s matches the oracle', (_id, g) => {
    const cfg = caseCfg(g);
    const spacing = spaceValves(cfg);
    expect(spacing.stopReason).toBe(g.stopReason);
    expect(spacing.depths).toHaveLength(g.depths.length);
    spacing.depths.forEach((d, i) => expect(Math.abs(d - g.depths[i])).toBeLessThan(0.05));

    const design = designGasLift(cfg);
    design.valves.forEach((v, i) => {
      const e = g.valves[i];
      expect(v.valveType).toBe(e.valveType);
      expect(rel(v.portIdIn, e.portIdIn)).toBeLessThan(1e-12);
      expect(rel(v.pInjAtDepthPsia, e.pInjAtDepthPsia)).toBeLessThan(1e-5);
      expect(rel(v.pProdAtDepthPsia, e.pProdAtDepthPsia)).toBeLessThan(1e-5);
      expect(rel(v.throughputMscfd, e.throughputMscfd)).toBeLessThan(1e-5);
      if (e.domeAtTempPsia !== null) {
        expect(rel(v.domeAtTempPsia, e.domeAtTempPsia)).toBeLessThan(1e-5);
        expect(rel(v.dome60Psia, e.dome60Psia)).toBeLessThan(1e-5);
        expect(rel(v.testRackOpeningPsia, e.testRackOpeningPsia)).toBeLessThan(1e-5);
        expect(rel(v.spreadPsi, e.spreadPsi)).toBeLessThan(1e-5);
        expect(rel(v.closingSurfacePressurePsia, e.closingSurfacePressurePsia)).toBeLessThan(1e-5);
      }
    });
  });

  test('valves are spaced strictly downward with shrinking increments', () => {
    const g = G.designs[0];
    const { depths } = spaceValves(caseCfg(g));
    for (let i = 1; i < depths.length; i += 1) expect(depths[i]).toBeGreaterThan(depths[i - 1]);
    const inc = depths.slice(1).map((d, i) => d - depths[i]);
    for (let i = 1; i < inc.length - 1; i += 1) expect(inc[i]).toBeLessThan(inc[i - 1] + 1e-6);
  });

  test('a decreasing-surface-pressure design gives decreasing test-rack settings', () => {
    const design = designGasLift(caseCfg(G.designs[0]));
    const tros = design.valves.filter((v) => v.testRackOpeningPsia !== null)
      .map((v) => v.testRackOpeningPsia);
    for (let i = 1; i < tros.length; i += 1) expect(tros[i]).toBeLessThan(tros[i - 1]);
  });

  test('a decrement smaller than the valve spread is reported as multipointing', () => {
    const cfg = caseCfg(G.designs[0]);
    const tight = designGasLift({ ...cfg, dpPerValvePsi: 10 });
    const wide = designGasLift({ ...cfg, dpPerValvePsi: 90 });
    expect(tight.unloading.some((s) => s.multipointing)).toBe(true);
    expect(tight.warnings.some((w) => w.code === 'multipointing')).toBe(true);
    expect(wide.unloading.some((s) => s.multipointing)).toBe(false);
    // and the price of closing cleanly is a shallower point of injection
    expect(wide.depths[wide.depths.length - 1]).toBeLessThan(tight.depths[tight.depths.length - 1]);
  });

  test('unloading reports the fluid level and gas rate stage by stage', () => {
    const design = designGasLift(caseCfg(G.designs[0]));
    expect(design.unloading).toHaveLength(design.valves.length);
    design.unloading.forEach((s, i) => {
      expect(s.depthFt).toBe(design.valves[i].depthFt);
      expect(s.fluidLevelFt).toBe(design.valves[i].depthFt);
      expect(s.gasRateMscfd).toBeGreaterThan(0);
    });
    expect(unloadingSequence({ valves: [], gasSg: 0.65, tempAtDepthF: () => 100 })).toEqual([]);
  });

  test('one valve setting reproduces its own force balance', () => {
    const temp = tempFn(100, 190, 8000);
    const v = valveSetting({
      depthFt: 5000, pSurfOpenPsia: 1014.7, pProdPsia: 600, valveType: 'IPO',
      bellowsAreaIn2: 0.77, portIdIn: 0.25, gasSg: 0.65, tempAtDepthF: temp,
      qgiTargetMscfd: 400, pOperatingSurfPsia: 914.7,
    });
    const reopened = ipoOpeningPressure({
      pdTPsia: v.domeAtTempPsia, ptPsia: v.pProdAtDepthPsia, r: v.r,
    });
    expect(rel(reopened, v.pInjAtDepthPsia)).toBeLessThan(1e-9);
    expect(rel(testRackOpening({ pd60Psia: v.dome60Psia, r: v.r }), v.testRackOpeningPsia))
      .toBeLessThan(1e-12);
  });

  test('an injection pressure that cannot reach depth is reported, not padded', () => {
    const temp = tempFn(100, 190, 8000);
    const design = designGasLift({
      pKickoffPsia: 414.7, pOperatingPsia: 364.7, dpPerValvePsi: 25, dpTransferPsi: 50,
      killGradPsiPerFt: 0.45, unloadGradPsiPerFt: 0.1, pWhUnloadPsia: 114.7,
      gasSg: 0.65, tempAtDepthF: temp, maxDepthFt: 8000, minSpacingFt: 250,
      maxValves: 12, valveType: 'IPO', bellowsAreaIn2: 0.77,
      ports: valveFamily('r15').ports, qgiTargetMscfd: 300, bottomOrifice: false,
    });
    expect(design.depths[design.depths.length - 1]).toBeLessThan(8000);
    expect(['injectionPressure', 'minSpacing', 'maxValves']).toContain(design.stopReason);
    expect(design.warnings.length).toBeGreaterThan(0);
  });
});

describe('unloading and the multipointing verdict', () => {
  // The verdict is what designGasLift exists to tell a user: at the stage
  // the point of injection reaches valve i, is every valve above it shut?
  // The oracle answers it from the published closing rule (a bellows valve
  // closes when the pressure acting on the FULL bellows area falls back to
  // the dome charge at valve temperature), evaluated AT VALVE DEPTH off its
  // forward RK4 column. The engine answers it at SURFACE, by inverting a
  // 20-step column to turn each dome pressure into the casing surface
  // pressure that would produce it. For a casing-operated valve those are
  // the same test read from opposite ends of the same monotone column, so
  // the goldens gate the boolean AND the margin it turns on.
  const ipoDesigns = G.designs.filter((g) => g.inputs.valveType !== 'PPO');

  test.each(ipoDesigns.map((g) => [g.id, g]))(
    'design %s: every stage verdict matches the oracle',
    (_id, g) => {
      const design = designGasLift(caseCfg(g));
      expect(design.unloading).toHaveLength(g.unloading.length);
      design.unloading.forEach((s, i) => {
        const e = g.unloading[i];
        expect(s.stage).toBe(e.stage);
        expect(s.upperValvesOpen).toEqual(e.upperValvesOpen);
        expect(s.multipointing).toBe(e.multipointing);
      });
      // and the warning list is the verdict, not a separate opinion
      const flagged = g.unloading.filter((s) => s.multipointing).length;
      expect(design.warnings.filter((w) => w.code === 'multipointing')).toHaveLength(flagged);
    },
  );

  test.each(ipoDesigns.map((g) => [g.id, g]))(
    'design %s: the closing margin behind each verdict matches the oracle',
    (_id, g) => {
      const i = g.inputs;
      const temp = tempFn(i.wht, i.bht, i.refDepth);
      const design = designGasLift(caseCfg(g));
      let checked = 0;
      g.unloading.forEach((e, si) => {
        e.closingMargins.forEach((m) => {
          if (m.marginPsi === null) return;
          const u = design.valves[m.valve - 1];
          // casing pressure at the upper valve's own depth, at this stage
          const pCas = gasColumnPressure({
            pSurfPsia: design.unloading[si].surfaceInjectionPsia, tvdFt: u.depthFt,
            gasSg: i.gasSg, tempAtDepthF: temp, steps: 20,
          }).pBottomPsia;
          expect(Math.abs((pCas - u.domeAtTempPsia) - m.marginPsi)).toBeLessThan(5e-3);
          // and the sign of that margin is the verdict the engine published
          expect(pCas - u.domeAtTempPsia > 0).toBe(m.open);
          checked += 1;
        });
      });
      expect(checked).toBeGreaterThan(0);
    },
  );

  test('the closing margin is the valve spread less the casing drop at its depth', () => {
    // margin_j(i) = Pc(d_j; p_surf_i) - Pd_j
    //             = S_j - [Pc(d_j; p_surf_j) - Pc(d_j; p_surf_i)]
    // an identity of the force balance, so it holds exactly or the dome
    // charge and the spread disagree about the same valve.
    const i = G.designs[0].inputs;
    const temp = tempFn(i.wht, i.bht, i.refDepth);
    const design = designGasLift(caseCfg(G.designs[0]));
    design.unloading.forEach((s) => {
      for (let j = 0; j < s.stage - 1; j += 1) {
        const u = design.valves[j];
        const pCas = gasColumnPressure({
          pSurfPsia: s.surfaceInjectionPsia, tvdFt: u.depthFt, gasSg: i.gasSg,
          tempAtDepthF: temp, steps: 20,
        }).pBottomPsia;
        const margin = pCas - u.domeAtTempPsia;
        const drop = u.pInjAtDepthPsia - pCas;
        expect(Math.abs(margin - (u.spreadPsi - drop))).toBeLessThan(1e-9);
      }
    });
  });

  test('the mid-decrement design multipoints in the middle and is clean at both ends', () => {
    // 26.75 psi per valve sits in the middle of the usual 20-50 psi band,
    // which is where every real design sits and where a rule that is only
    // gated at 10 and 90 psi per valve is not gated at all. Valves 1 to 3
    // hang open for one stage each, valve 4 hangs open at stage 5, and the
    // string is clean from stage 6 down. A verdict that is monotone in the
    // stage number, in either direction, is wrong here.
    const g = G.designs.find((d) => d.id === 'midDecrementKnifeEdge');
    expect(g).toBeDefined();
    const design = designGasLift(caseCfg(g));
    expect(design.unloading.map((s) => s.upperValvesOpen))
      .toEqual([[], [1], [2], [3], [4], [], []]);
  });

  test('the stage-5 verdict of that design turns on a fraction of a psi', () => {
    const g = G.designs.find((d) => d.id === 'midDecrementKnifeEdge');
    const i = g.inputs;
    const temp = tempFn(i.wht, i.bht, i.refDepth);
    const cfg = caseCfg(g);
    const design = designGasLift(cfg);
    const v4 = design.valves[3];
    const pCas = gasColumnPressure({
      pSurfPsia: design.unloading[4].surfaceInjectionPsia, tvdFt: v4.depthFt,
      gasSg: i.gasSg, tempAtDepthF: temp, steps: 20,
    }).pBottomPsia;
    const margin = pCas - v4.domeAtTempPsia;
    // the oracle's margin, gated to the fifth decimal of a psi
    const golden = g.unloading[4].closingMargins.find((m) => m.valve === 4).marginPsi;
    expect(Math.abs(margin - golden)).toBeLessThan(5e-3);
    expect(margin).toBeGreaterThan(0);
    expect(margin).toBeLessThan(0.25);
    // and it flips on a quarter of a psi of decrement, both ways
    const looser = designGasLift({ ...cfg, dpPerValvePsi: 26.5 });
    const tighter = designGasLift({ ...cfg, dpPerValvePsi: 27.0 });
    expect(looser.unloading[4].upperValvesOpen).toEqual([4]);
    expect(tighter.unloading[4].upperValvesOpen).toEqual([]);
    expect(tighter.unloading[3].upperValvesOpen).toEqual([3]);
  });

  test('KNOWN DIVERGENCE: a production-operated string is closed on the wrong pressure', () => {
    // gasLiftValves.js states the closing rule as "the pressure acting on
    // the full bellows area falls back to the dome pressure". For a PPO
    // valve that pressure is the TUBING pressure: shut, the tubing acts on
    // Ab - Ap and the casing on Ap; open, the port discharges into the
    // tubing and the tubing acts on all of Ab. gasLiftDesign.js instead
    // converts every dome charge into a CASING surface pressure through the
    // injection gas column and compares it with the casing, for every
    // family, so a PPO string is judged on the wrong fluid.
    //
    // The oracle applies the tubing-side rule and the goldens carry its
    // answer: no upper valve open at any stage. The engine answers every
    // upper valve open at every stage. This gate pins both, so that fixing
    // the engine trips it and the fix is not merged silently.
    const g = G.designs.find((d) => d.id === 'constantPressurePPO');
    const design = designGasLift(caseCfg(g));

    // what the published rule says, straight off the engine's own numbers:
    // for a PPO valve Pt - Pd is exactly the (negative) spread, so no valve
    // is open and the oracle's goldens say so
    design.valves.forEach((v) => {
      expect(rel(v.pProdAtDepthPsia - v.domeAtTempPsia, v.spreadPsi)).toBeLessThan(1e-9);
      expect(v.spreadPsi).toBeLessThan(0);
    });
    g.unloading.forEach((e) => expect(e.upperValvesOpen).toEqual([]));

    // what the engine currently answers instead
    design.unloading.forEach((s, i) => {
      expect(s.upperValvesOpen).toEqual(Array.from({ length: i }, (_, j) => j + 1));
    });
    // and it is not close: the casing-side test clears the wrong threshold
    // by hundreds of psi where the tubing-side test misses by tens
    design.valves.forEach((v) => {
      expect(g.inputs.pKickoffPsia - v.closingSurfacePressurePsia).toBeGreaterThan(300);
      expect(v.pProdAtDepthPsia - v.domeAtTempPsia).toBeLessThan(-30);
    });
  });
});

describe('deepest point of injection', () => {
  const gi = G.injectionPoint;
  const temp = tempFn(gi.whtF, gi.bhtF, gi.refDepthFt);

  test('matches the oracle crossing', () => {
    const hit = deepestInjectionPoint({
      prodTraverse: gi.traverse, pSurfPsia: gi.pSurfPsia, gasSg: gi.gasSg,
      tempAtDepthF: temp, dpTransferPsi: gi.dpTransferPsi, maxDepthFt: gi.maxDepthFt,
    });
    expect(hit.limitedBy).toBe(gi.expected.limitedBy);
    expect(Math.abs(hit.depthFt - gi.expected.depthFt)).toBeLessThan(0.05);
    expect(rel(hit.pInjPsia, gi.expected.pInjPsia)).toBeLessThan(1e-5);
  });

  test('at the crossing the injection line less the transfer drop equals the tubing pressure', () => {
    const hit = deepestInjectionPoint({
      prodTraverse: gi.traverse, pSurfPsia: gi.pSurfPsia, gasSg: gi.gasSg,
      tempAtDepthF: temp, dpTransferPsi: gi.dpTransferPsi, maxDepthFt: gi.maxDepthFt,
    });
    expect(Math.abs(hit.pInjPsia - gi.dpTransferPsi - hit.pProdPsia)).toBeLessThan(0.5);
  });

  test('more injection pressure buys a deeper injection point', () => {
    const shallow = deepestInjectionPoint({
      prodTraverse: gi.traverse, pSurfPsia: 814.7, gasSg: gi.gasSg, tempAtDepthF: temp,
      dpTransferPsi: gi.dpTransferPsi, maxDepthFt: gi.maxDepthFt,
    });
    const deep = deepestInjectionPoint({
      prodTraverse: gi.traverse, pSurfPsia: 1214.7, gasSg: gi.gasSg, tempAtDepthF: temp,
      dpTransferPsi: gi.dpTransferPsi, maxDepthFt: gi.maxDepthFt,
    });
    expect(deep.depthFt).toBeGreaterThan(shallow.depthFt);
  });

  test('a traverse the gas always beats is depth limited, not pressure limited', () => {
    const hit = deepestInjectionPoint({
      prodTraverse: [{ tvdFt: 0, pPsia: 100 }, { tvdFt: 4000, pPsia: 200 }],
      pSurfPsia: 1414.7, gasSg: 0.65, tempAtDepthF: temp, dpTransferPsi: 50,
      maxDepthFt: 4000,
    });
    expect(hit.limitedBy).toBe('depth');
    expect(hit.depthFt).toBe(4000);
  });

  test('too few traverse points returns nothing rather than a guess', () => {
    expect(deepestInjectionPoint({
      prodTraverse: [{ tvdFt: 0, pPsia: 100 }], pSurfPsia: 1014.7, gasSg: 0.65,
      tempAtDepthF: temp, maxDepthFt: 8000,
    })).toBeNull();
  });
});

describe('valve catalog', () => {
  test('both families expose ascending ports and the published bellows areas', () => {
    expect(VALVE_FAMILIES.map((f) => f.bellowsAreaIn2)).toEqual([0.31, 0.77]);
    VALVE_FAMILIES.forEach((f) => {
      f.ports.forEach((p, i) => {
        if (i > 0) expect(p.idIn).toBeGreaterThan(f.ports[i - 1].idIn);
        expect(portToBellowsRatio({ portIdIn: p.idIn, bellowsAreaIn2: f.bellowsAreaIn2 }))
          .toBeLessThan(1);
      });
    });
  });

  test('an unknown family id falls back rather than throwing', () => {
    expect(valveFamily('nope')).toBe(VALVE_FAMILIES[0]);
  });
});

describe('injection pressure curve', () => {
  test('interpolates its own samples and is monotone with depth', () => {
    const curve = injectionPressureCurve({
      pSurfPsia: 1014.7, gasSg: 0.65, tempAtDepthF: tempFn(100, 190, 8000),
      maxDepthFt: 8000, steps: 40,
    });
    expect(curve.at(0)).toBeCloseTo(1014.7, 9);
    expect(curve.at(-100)).toBeCloseTo(1014.7, 9);
    expect(curve.at(99999)).toBeCloseTo(curve.pressures[curve.pressures.length - 1], 9);
    for (let i = 1; i < curve.pressures.length; i += 1) {
      expect(curve.pressures[i]).toBeGreaterThan(curve.pressures[i - 1]);
    }
    const mid = curve.at(4000);
    expect(mid).toBeGreaterThan(curve.at(3800));
    expect(mid).toBeLessThan(curve.at(4200));
  });
});

// Second spelling of the defect fixed in PR #113, which was grepped on
// toFixed(0) and so could not see Math.round in a message string.
// `selectPort` returns no port only when every candidate passes STRICTLY
// less than the target, and the target is printed in the same sentence, so
// rounding the port rate whole let the two render as one number with the
// first said to fall short of the second. One decimal narrows that by ten
// rather than closing it.
describe('the port warning prints a rate that is not the target', () => {
  test('a largest port a fraction short does not print as the target', () => {
    const cfg = caseCfg(G.designs[0]);
    // What the largest port in the catalog actually passes at each valve,
    // read from the design rather than from the message, by asking for a
    // rate nothing can meet.
    const capacity = designGasLift({ ...cfg, qgiTargetMscfd: 1e6 })
      .valves.map((v) => v.throughputMscfd);
    // the fifth valve's capacity sits about four tenths under a whole
    // number, so a target at that whole number is short by a fraction
    const qgiTargetMscfd = Math.round(capacity[4]);
    expect(qgiTargetMscfd).toBeGreaterThan(capacity[4]);
    expect(qgiTargetMscfd - capacity[4]).toBeGreaterThan(0.05);

    const design = designGasLift({ ...cfg, qgiTargetMscfd });
    const w = design.warnings.find((x) => x.code === 'portTooSmall');
    expect(w).toBeDefined();
    const passes = Number(/passes ([\d.]+) Mscf/.exec(w.message)[1]);
    expect(passes).toBeLessThan(qgiTargetMscfd);
    expect(w.message).not.toMatch(new RegExp(`passes ${qgiTargetMscfd} Mscf`));
    expect(w.message).toContain(`short of the ${qgiTargetMscfd} Mscf/d target`);
  });
});
