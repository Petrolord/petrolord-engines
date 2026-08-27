// Well integrity & P&A (D10): barrier categorization truth table,
// element-governed MAASP / RP 90 MAWOP closed forms, balanced plug
// closed forms, D-010 rule checks, program compliance and oracle golden
// agreement.
import fs from 'fs';
import path from 'path';
import {
  ELEMENT_STATUSES, envelopeStatus, wellCategory, verifyBarriers,
  maaspRows, mawop, RP90_MAWOP_FACTORS,
} from '../engines/drilling/wellIntegrity.js';
import {
  D010_DEFAULT_RULES, balancedPlug, plugRuleCheck, annularBarrierCheck,
  abandonmentProgram,
} from '../engines/drilling/plugAbandonment.js';

const G = (name) => JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'drilling', 'goldens', name), 'utf8'));

const GRAV = 9.80665;

function expectClose(a, b, rtol, atol = 0) {
  if (!Number.isFinite(a)) throw new Error(`non-finite value ${a} (expected ~ ${b})`);
  const tol = atol + rtol * Math.abs(b);
  if (Math.abs(a - b) > tol) {
    throw new Error(`expected ${a} ~ ${b} (rtol ${rtol}, atol ${atol})`);
  }
}

const golden = G('wellintegrity_cases.json');
const P = golden.params;

describe('barrier envelopes', () => {
  test('envelope roll-up: failed dominates, not-verified degrades', () => {
    expect(envelopeStatus([])).toBe('empty');
    expect(envelopeStatus([{ status: 'verified' }, { status: 'verified' }])).toBe('intact');
    expect(envelopeStatus([{ status: 'verified' }, { status: 'not-verified' }])).toBe('degraded');
    expect(envelopeStatus([{ status: 'degraded' }, { status: 'failed' }])).toBe('failed');
    expect(() => envelopeStatus([{ status: 'ok' }])).toThrow(/status/);
    expect(ELEMENT_STATUSES).toContain('not-verified');
  });

  test('categorization matches the oracle truth table, all 16 rows', () => {
    for (const row of golden.categoryTable) {
      const got = wellCategory({ primary: row.primary, secondary: row.secondary });
      expect(`${row.primary}/${row.secondary}:${got.category}`)
        .toBe(`${row.primary}/${row.secondary}:${row.category}`);
    }
  });

  test('no flow potential: single qualified envelope is green', () => {
    expect(wellCategory({ primary: 'intact', secondary: 'empty', flowPotential: false }).category).toBe('green');
    expect(wellCategory({ primary: 'degraded', secondary: 'empty', flowPotential: false }).category).toBe('yellow');
    expect(wellCategory({ primary: 'failed', secondary: 'empty', flowPotential: false }).category).toBe('orange');
  });

  test('verifyBarriers on the golden element set', () => {
    const out = verifyBarriers({ elements: golden.barrier.elements });
    expect(out.primary.status).toBe(golden.barrier.primaryStatus);
    expect(out.secondary.status).toBe(golden.barrier.secondaryStatus);
    expect(out.category).toBe(golden.barrier.category);
    expect(out.shared).toEqual([]);
    expect(out.checks.find((c) => c.id === 'two-envelopes').pass).toBe(true);
    expect(out.checks.find((c) => c.id === 'no-failed-elements').pass).toBe(true);
  });

  test('common WBE flags and a failed DHSV turns the well orange', () => {
    const els = golden.barrier.elements.map((e) => ({ ...e }));
    els.find((e) => e.name === 'DHSV').status = 'failed';
    const out = verifyBarriers({ elements: els });
    expect(out.category).toBe('orange');
    const shared = verifyBarriers({
      elements: [
        { name: 'Wellhead', kind: 'wellhead', envelope: 'both', status: 'verified' },
        { name: 'Packer', kind: 'production-packer', envelope: 'primary', status: 'verified' },
        { name: 'Tree', kind: 'xmas-tree', envelope: 'secondary', status: 'verified' },
      ],
    });
    expect(shared.shared).toEqual(['Wellhead']);
    expect(shared.checks.find((c) => c.id === 'no-common-elements').pass).toBe(false);
  });
});

describe('annulus pressure limits', () => {
  test('single-element MAASP closed form at the trajectory TVD', () => {
    const f = P.maaspFixture;
    const out = maaspRows({
      annulusFluidDensityKgM3: P.annulusFluidDensityKgM3,
      elements: [{
        name: 'burst', limitPa: f.limitPa, factor: f.factor,
        tvdM: f.tvdM, backupDensityKgM3: f.backupDensityKgM3,
      }],
    });
    const hand = f.factor * f.limitPa
      - (P.annulusFluidDensityKgM3 - f.backupDensityKgM3) * GRAV * f.tvdM;
    expectClose(out.rows[0].allowSurfacePa, hand, 1e-12);
    expectClose(out.rows[0].allowSurfacePa, golden.annulus.maaspFixtureAllowPa, 1e-9);
  });

  test('RP 90 MAWOP rows + governing element vs the oracle', () => {
    const cands = P.mawopCandidates.map((c, i) => ({
      name: c.name, role: c.role, limitPa: c.limitPa,
      tvdM: golden.annulus.mawop.rows[i].tvdM,
      backupDensityKgM3: c.backupDensityKgM3,
    }));
    const out = mawop({ annulusFluidDensityKgM3: P.annulusFluidDensityKgM3, candidates: cands });
    expect(out.governing).toBe(golden.annulus.mawop.governing);
    expectClose(out.mawopPa, golden.annulus.mawop.mawopPa, 1e-9);
    out.rows.forEach((r, i) => {
      expectClose(r.allowSurfacePa, golden.annulus.mawop.rows[i].allowSurfacePa, 1e-9);
    });
    expect(RP90_MAWOP_FACTORS['outer-casing-burst']).toBe(0.5);
  });

  test('negative governing clamps to zero and flags', () => {
    const out = maaspRows({
      annulusFluidDensityKgM3: 2000,
      elements: [{ name: 'weak', limitPa: 1e5, tvdM: 3000, backupDensityKgM3: 0 }],
    });
    expect(out.maaspPa).toBe(0);
    expect(out.negative).toBe(true);
    expect(() => mawop({
      annulusFluidDensityKgM3: 1200,
      candidates: [{ name: 'x', role: 'nope', limitPa: 1e6, tvdM: 100 }],
    })).toThrow(/role/);
  });
});

describe('balanced plug', () => {
  test('hand fixture: volumes, balance, displacement, plugged top', () => {
    const f = P.plugFixture;
    const out = balancedPlug(f);
    expectClose(out.slurryM3, golden.plug.slurryM3, 1e-9);
    expectClose(out.balancedHeightM, golden.plug.balancedHeightM, 1e-9);
    expectClose(out.spacerBehindM3, golden.plug.spacerBehindM3, 1e-9, 1e-9);
    expectClose(out.displacementM3, golden.plug.displacementM3, 1e-9);
    expectClose(out.pluggedTopMdM, 1820, 1e-12); // hand: 2000 - 150*1.2
    // Spacer balance: equal column heights.
    expectClose(out.spacerBehindM3 / out.cInM2, f.spacerAheadM3 / out.cAnnM2, 1e-12);
    // Volume conservation at balance.
    expectClose(out.balancedHeightM * (out.cAnnM2 + out.cInM2), out.slurryM3, 1e-12);
  });

  test('zero-excess identity: plugged top equals the design top', () => {
    const out = balancedPlug({
      holeIdM: 0.216, stingerOdM: 0.127, stingerIdM: 0.1086,
      plugBaseMdM: 2000, plugTopMdM: 1850,
    });
    expectClose(out.pluggedTopMdM, 1850, 1e-12);
    expect(out.warnings).toEqual([]);
  });

  test('input guards', () => {
    expect(() => balancedPlug({
      holeIdM: 0.216, stingerOdM: 0.25, stingerIdM: 0.1,
      plugBaseMdM: 2000, plugTopMdM: 1850,
    })).toThrow(/clear/);
    expect(() => balancedPlug({
      holeIdM: 0.216, stingerOdM: 0.127, stingerIdM: 0.1086,
      plugBaseMdM: 1800, plugTopMdM: 1850,
    })).toThrow(/top/);
  });
});

describe('rule checks + program', () => {
  test('D-010 length and coverage rules', () => {
    expect(D010_DEFAULT_RULES.plugMinLengthM).toBe(100);
    const ok = plugRuleCheck({
      plug: { topMdM: 2380, bottomMdM: 2520, foundation: 'mechanical' },
      sourceTopMdM: 2500,
    });
    expect(ok.pass).toBe(true);
    // 30 m above the source only.
    const close30 = plugRuleCheck({
      plug: { topMdM: 2470, bottomMdM: 2580, foundation: 'none' },
      sourceTopMdM: 2500,
    });
    expect(close30.pass).toBe(false);
    expect(close30.checks.find((c) => c.id === 'above-source').pass).toBe(false);
    // Surface plug rule.
    expect(plugRuleCheck({ plug: { topMdM: 0, bottomMdM: 60, isSurfacePlug: true } }).pass).toBe(true);
    expect(plugRuleCheck({ plug: { topMdM: 0, bottomMdM: 40, isSurfacePlug: true } }).pass).toBe(false);
    // Annular cement: 30 m verified / 100 m unverified.
    expect(annularBarrierCheck({ topMdM: 2400, bottomMdM: 2440, verifiedByLog: true }).pass).toBe(true);
    expect(annularBarrierCheck({ topMdM: 2400, bottomMdM: 2440, verifiedByLog: false }).pass).toBe(false);
  });

  test('program compliance + takeoff vs the oracle fixture', () => {
    const out = abandonmentProgram({ zones: golden.program.zones, plugs: golden.program.plugs });
    expect(out.zoneCompliance.map((z) => z.pass))
      .toEqual(golden.program.zoneCompliance.map((z) => z.passZone));
    expect(out.zoneCompliance.map((z) => z.primaryQualifying))
      .toEqual(golden.program.zoneCompliance.map((z) => z.primaryQualifying));
    expect(out.zoneCompliance.map((z) => z.secondaryQualifying))
      .toEqual(golden.program.zoneCompliance.map((z) => z.secondaryQualifying));
    expect(out.surfacePlug.pass).toBe(golden.program.surfacePlugPass);
    expect(out.pass).toBe(golden.program.programPass);
    const p1 = out.designs.find((d) => d.name === 'P1 reservoir primary');
    expectClose(p1.placement.slurryM3, golden.program.p1Placement.slurryM3, 1e-9);
    expectClose(out.takeoff.slurryM3, golden.program.p1Placement.slurryM3, 1e-9);
    expect(out.takeoff.undesignedPlugs).toHaveLength(3);
    // Steps: deepest barrier plug first, surface phase last.
    expect(out.steps[0].plugName).toBe('P1 reservoir primary');
    expect(out.steps[out.steps.length - 1].phase).toBe(3);
  });
});
