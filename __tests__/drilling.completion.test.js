// Completion design (D7): API 5CT drift closed forms, stack-up bookkeeping,
// exposed-program logic, clearance/through-bore governing behaviour,
// volumes, space-out, and oracle golden agreement.
import fs from 'fs';
import path from 'path';
import {
  apiDriftM, buildStack, casingProgramProfile, governingDriftTo,
  runInClearance, throughBoreProfile, completionVolumes, sealSpaceOut,
  DRIFT_DEDUCTION_TUBING_M, DRIFT_DEDUCTION_CASING_SMALL_M,
  DRIFT_DEDUCTION_CASING_MID_M, DRIFT_DEDUCTION_CASING_LARGE_M,
} from '../engines/drilling/completionDesign.js';
import {
  EQUIPMENT_CATALOG, NIPPLE_BORES_IN, EUE_COUPLING_OD_IN,
} from '../engines/drilling/data/completionEquipment.js';
import { CASING_CATALOG, TUBING_CATALOG } from '../engines/drilling/data/tubulars.js';

const G = (name) => JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'drilling', 'goldens', name), 'utf8'));

const IN = 0.0254;

function expectClose(a, b, rtol, atol = 0) {
  if (!Number.isFinite(a)) throw new Error(`non-finite value ${a} (expected ~ ${b})`);
  const tol = atol + rtol * Math.abs(b);
  if (Math.abs(a - b) > tol) {
    throw new Error(`expected ${a} ~ ${b} (rtol ${rtol}, atol ${atol})`);
  }
}

const golden = G('completion_cases.json');

const goldenStack = () => buildStack({
  hangerMdM: golden.stack.hangerMdM,
  components: golden.stack.components,
});
const goldenProfile = () => casingProgramProfile(golden.program.strings);

describe('API 5CT drift', () => {
  test('published spot values', () => {
    // Published table values (rounded to 1/1000"): 9-5/8" 47# drift 8.525"
    // (exact 8.681 − 5/32 = 8.52475); 7" 29# 6.059"; 2-7/8" tbg 2.34725".
    expectClose(apiDriftM({ odM: 9.625 * IN, idM: 8.681 * IN, kind: 'casing' }) / IN, 8.525, 0, 5e-4);
    expectClose(apiDriftM({ odM: 7 * IN, idM: 6.184 * IN, kind: 'casing' }) / IN, 6.059, 0, 1e-9);
    expectClose(apiDriftM({ odM: 2.875 * IN, idM: 2.441 * IN, kind: 'tubing' }) / IN, 2.34725, 0, 1e-9);
  });

  test('deduction class boundaries', () => {
    const idM = 8 * IN;
    expect(apiDriftM({ odM: 8.625 * IN, idM, kind: 'casing' }))
      .toBe(idM - DRIFT_DEDUCTION_CASING_SMALL_M);
    expect(apiDriftM({ odM: 8.626 * IN, idM, kind: 'casing' }))
      .toBe(idM - DRIFT_DEDUCTION_CASING_MID_M);
    expect(apiDriftM({ odM: 13.375 * IN, idM: 12.415 * IN, kind: 'casing' }))
      .toBe(12.415 * IN - DRIFT_DEDUCTION_CASING_MID_M);
    expect(apiDriftM({ odM: 16 * IN, idM: 15 * IN, kind: 'casing' }))
      .toBe(15 * IN - DRIFT_DEDUCTION_CASING_LARGE_M);
    expect(apiDriftM({ odM: 3.5 * IN, idM: 2.992 * IN, kind: 'tubing' }))
      .toBe(2.992 * IN - DRIFT_DEDUCTION_TUBING_M);
  });

  test('golden drift table agreement', () => {
    for (const row of golden.driftTable) {
      const d = apiDriftM({ odM: row.odIn * IN, idM: row.idIn * IN, kind: row.kind });
      expectClose(d / IN, row.driftIn, 1e-9);
    }
  });

  test('guards', () => {
    expect(() => apiDriftM({ odM: 0.2, idM: 0.25 })).toThrow();
    expect(() => apiDriftM({ odM: 0.2, idM: 0.18, kind: 'weird' })).toThrow();
  });
});

describe('stack-up', () => {
  test('telescoping sum and golden rows', () => {
    const stack = goldenStack();
    expectClose(stack.bottomMdM, golden.results.bottomMdM, 1e-12);
    golden.results.stackRows.forEach((r, i) => {
      expectClose(stack.components[i].topMdM, r.topMdM, 1e-12);
      expectClose(stack.components[i].bottomMdM, r.bottomMdM, 1e-12);
      expect(stack.components[i].name).toBe(r.name);
    });
  });

  test('guards', () => {
    expect(() => buildStack({ components: [] })).toThrow();
    expect(() => buildStack({
      components: [{ type: 'tubing', lengthM: 0, odM: 0.1, idM: 0.08 }],
    })).toThrow();
    expect(() => buildStack({
      components: [{ type: 'tubing', lengthM: 10, odM: 0.08, idM: 0.1 }],
    })).toThrow();
  });
});

describe('exposed casing program', () => {
  test('liner overlap exposes the smaller bore and golden profile agrees', () => {
    const profile = goldenProfile();
    expect(profile.length).toBe(golden.results.profile.length);
    profile.forEach((seg, i) => {
      const g = golden.results.profile[i];
      expectClose(seg.topMdM, g.topMdM, 1e-12);
      expectClose(seg.bottomMdM, g.bottomMdM, 1e-12);
      expectClose(seg.idM, g.idM, 1e-9);
      expectClose(seg.driftM, g.driftM, 1e-9);
      expect(seg.label).toBe(g.label);
    });
    // Under the liner hanger the exposed bore is the 7" liner, not the 9-5/8.
    const deep = profile.find((s) => s.topMdM <= 2700 && 2700 < s.bottomMdM);
    expectClose(deep.idM / IN, 6.184, 1e-9);
  });

  test('governing drift is non-increasing and gap-aware', () => {
    const profile = goldenProfile();
    const d1 = governingDriftTo(profile, 1000).driftM;
    const d2 = governingDriftTo(profile, 2000).driftM;
    const d3 = governingDriftTo(profile, 3000).driftM;
    expect(d1 > d2 && d2 > d3).toBe(true);
    expectClose(d2 / IN, 8.535 - 5 / 32, 1e-9);
    expectClose(d3 / IN, 6.184 - 1 / 8, 1e-9);
    // A program that starts below surface cannot govern a surface run-in.
    const gapped = casingProgramProfile([{
      name: 'liner only',
      sections: [{ topMdM: 2400, bottomMdM: 3000, odM: 7 * IN, idM: 6.184 * IN }],
    }]);
    expect(governingDriftTo(gapped, 2800)).toBeNull();
  });
});

describe('run-in clearance', () => {
  test('golden agreement including statuses and controlling string', () => {
    const { rows } = runInClearance({
      stack: goldenStack(), profile: goldenProfile(), warnMarginM: golden.warnMarginM,
    });
    expect(rows.length).toBe(golden.results.clearance.length);
    rows.forEach((r, i) => {
      const g = golden.results.clearance[i];
      expectClose(r.clearanceM, g.clearanceM, 1e-9, 1e-12);
      expectClose(r.governingDriftM, g.governingDriftM, 1e-9);
      expect(r.status).toBe(g.status);
      expect(r.controlling).toBe(g.controlling);
    });
  });

  test('the worst row is the TIGHTEST clearance, not the first row of its status', () => {
    // The regression this guards. Ranking by status alone made `worst`
    // degenerate to rows[0] whenever every row shared a status, which is
    // every string that passes. On the golden completion that reported the
    // first tubing joint at 102 mm where the packer has 4.7 mm.
    const { rows, worst } = runInClearance({
      stack: goldenStack(), profile: goldenProfile(), warnMarginM: golden.warnMarginM,
    });
    expect(rows.every((r) => r.status === 'PASS')).toBe(true);
    const tightest = rows.reduce((a, b) => (b.clearanceM < a.clearanceM ? b : a));
    expect(worst.name).toBe(tightest.name);
    expect(worst.name).not.toBe(rows[0].name);
    expect(worst).toMatchObject({ name: golden.results.clearanceWorst.name,
      status: golden.results.clearanceWorst.status });
    expectClose(worst.clearanceM, golden.results.clearanceWorst.clearanceM, 1e-9, 1e-12);
    // and it really is more than twenty times tighter than rows[0]
    expect(rows[0].clearanceM / worst.clearanceM).toBeGreaterThan(20);
  });

  test('within one status class the tighter row wins, and a FAIL still outranks', () => {
    const two = buildStack({
      components: [
        { type: 'tubing', name: 'loose', lengthM: 2500, odM: 0.1143, idM: 0.0759968 },
        { type: 'packer', name: 'warn A', lengthM: 1.5, odM: 0.152, idM: 0.06985 },
        { type: 'spm', name: 'warn B tighter', lengthM: 2.4, odM: 0.1528, idM: 0.0759968 },
      ],
    });
    const w = runInClearance({ stack: two, profile: goldenProfile() }).worst;
    expect(w.name).toBe('warn B tighter');
    // adding a FAIL anywhere takes precedence over any WARN, however tight
    const three = buildStack({
      components: [
        ...two.components.map(({ type, name, lengthM, odM, idM }) => ({ type, name, lengthM, odM, idM })),
        { type: 'sssv', name: 'fails', lengthM: 2.2, odM: 0.17, idM: 0.06985 },
      ],
    });
    const w3 = runInClearance({ stack: three, profile: goldenProfile() }).worst;
    expect(w3.name).toBe('fails');
    expect(w3.status).toBe('FAIL');
  });

  test('an oversized component through the liner FAILs and is the worst row', () => {
    const stack = buildStack({
      components: [
        { type: 'tubing', name: 'tbg', lengthM: 2500, odM: 4.5 * IN, idM: 2.992 * IN },
        { type: 'sssv', name: 'big TRSV', lengthM: 2.2, odM: 6.94 * IN, idM: 3.813 * IN },
      ],
    });
    const { rows, worst } = runInClearance({ stack, profile: goldenProfile() });
    expect(rows[1].status).toBe('FAIL');
    expect(worst.name).toBe('big TRSV');
    // Same string kept above the liner passes: governing is 9-5/8" drift.
    const shallow = buildStack({
      components: [
        { type: 'tubing', name: 'tbg', lengthM: 2000, odM: 4.5 * IN, idM: 2.992 * IN },
        { type: 'sssv', name: 'big TRSV', lengthM: 2.2, odM: 6.94 * IN, idM: 3.813 * IN },
      ],
    });
    expect(runInClearance({ stack: shallow, profile: goldenProfile() }).rows[1].status).toBe('PASS');
  });
});

describe('through-bore', () => {
  test('golden agreement; the XN no-go controls the string', () => {
    const tb = throughBoreProfile(goldenStack());
    expectClose(tb.minIdM, golden.results.throughBore.minIdM, 1e-9);
    expect(tb.controlling).toBe(golden.results.throughBore.controlling);
    expect(tb.controlling).toMatch(/XN/);
    tb.rows.forEach((r, i) => {
      const g = golden.results.throughBore.rows[i];
      expectClose(r.cumMinIdM, g.cumMinIdM, 1e-9);
      expect(r.controlling).toBe(g.controlling);
    });
  });
});

describe('volumes', () => {
  test('golden agreement (breakpoint integration vs the oracle 1 cm slices)', () => {
    const vols = completionVolumes({
      stack: goldenStack(), profile: goldenProfile(),
      packerMdM: golden.packerMdM, tdMdM: golden.tdMdM,
    });
    const g = golden.results.volumes;
    expectClose(vols.stringCapacityM3, g.stringCapacityM3, 1e-9);
    expectClose(vols.stringDisplacementM3, g.stringDisplacementM3, 1e-9);
    expectClose(vols.annulusAbovePackerM3, g.annulusAbovePackerM3, 1e-6);
    expectClose(vols.belowPackerM3, g.belowPackerM3, 1e-6);
    expect(vols.warnings).toEqual([]);
  });

  test('hand integral on a single-interval case', () => {
    // 100 m of 4.5" OD / 2.992" ID pipe inside 8.681" bore casing.
    const stack = buildStack({
      components: [{ type: 'tubing', name: 't', lengthM: 100, odM: 4.5 * IN, idM: 2.992 * IN }],
    });
    const profile = casingProgramProfile([{
      name: 'csg', sections: [{ topMdM: 0, bottomMdM: 200, odM: 9.625 * IN, idM: 8.681 * IN }],
    }]);
    const vols = completionVolumes({ stack, profile, packerMdM: 100, tdMdM: 200 });
    const a = (d) => (Math.PI / 4) * d * d * IN * IN;
    expectClose(vols.stringCapacityM3, a(2.992) * 100, 1e-12);
    expectClose(vols.annulusAbovePackerM3, (a(8.681) - a(4.5)) * 100, 1e-12);
    expectClose(vols.belowPackerM3, a(8.681) * 100, 1e-12);
  });

  test('uncased interval is skipped with a warning, and guards hold', () => {
    const stack = buildStack({
      components: [{ type: 'tubing', name: 't', lengthM: 100, odM: 4.5 * IN, idM: 2.992 * IN }],
    });
    const shortProfile = casingProgramProfile([{
      name: 'csg', sections: [{ topMdM: 0, bottomMdM: 50, odM: 9.625 * IN, idM: 8.681 * IN }],
    }]);
    const vols = completionVolumes({ stack, profile: shortProfile, packerMdM: 100, tdMdM: 150 });
    expect(vols.warnings.length).toBeGreaterThan(0);
    expect(() => completionVolumes({ stack, profile: shortProfile, packerMdM: 120, tdMdM: 150 }))
      .toThrow(); // packer below string bottom
  });
});

describe('seal space-out', () => {
  test('golden cases (elongation uses remaining bore, contraction uses insertion)', () => {
    for (const c of golden.results.spaceOut) {
      const r = sealSpaceOut({
        pbrLengthM: c.pbrLengthM, insertLengthM: c.insertLengthM,
        expectedDLM: c.expectedDLM, marginM: c.marginM,
      });
      expectClose(r.availableM, c.result.availableM, 1e-12);
      expectClose(r.remainingM, c.result.remainingM, 1e-12);
      expect(r.status).toBe(c.result.status);
    }
  });

  test('overtravel FAILs and guards hold', () => {
    expect(sealSpaceOut({ pbrLengthM: 6.1, insertLengthM: 3, expectedDLM: 3.5 }).status).toBe('FAIL');
    expect(() => sealSpaceOut({ pbrLengthM: 6.1, insertLengthM: 7 })).toThrow();
  });
});

describe('equipment catalog', () => {
  test('every row is dimensionally sane and flagged approx', () => {
    for (const r of EQUIPMENT_CATALOG) {
      expect(r.odM).toBeGreaterThan(r.idM);
      expect(r.lengthM).toBeGreaterThan(0);
      expect(r.approx).toBe(true);
    }
  });

  test('nipple seat bores match the published X/XN table and pass their tubing drift', () => {
    for (const [size, bores] of Object.entries(NIPPLE_BORES_IN)) {
      const tbg = TUBING_CATALOG.find((t) => String(t.odIn) === size
        || t.odIn === parseFloat(size));
      if (!tbg) continue;
      const driftIn = apiDriftM({ odM: tbg.odM, idM: tbg.idM, kind: 'tubing' }) / IN;
      // A seat bore must be smaller than the drift of its own tubing.
      expect(bores.x).toBeLessThan(driftIn);
      expect(bores.xn).toBeLessThan(bores.x);
    }
    // Spot: 3-1/2" X profile is the classic 2.750".
    expect(NIPPLE_BORES_IN['3.5'].x).toBe(2.75);
  });

  test('jewelry runs inside its host casing: 3-1/2" kit passes 7" 29# drift', () => {
    const drift7 = apiDriftM({ odM: 7 * IN, idM: 6.184 * IN, kind: 'casing' });
    const kit = EQUIPMENT_CATALOG.filter((r) => r.forTubingOdIn === 3.5);
    expect(kit.length).toBeGreaterThan(8);
    for (const r of kit) expect(r.odM).toBeLessThan(drift7);
    // But the big-body items honestly refuse 5-1/2" 20# casing.
    const drift55 = apiDriftM({ odM: 5.5 * IN, idM: 4.778 * IN, kind: 'casing' });
    const spm = kit.find((r) => r.type === 'spm');
    const sssv = kit.find((r) => r.type === 'sssv');
    expect(spm.odM).toBeGreaterThan(drift55);
    expect(sssv.odM).toBeGreaterThan(drift55);
    expect(spm.eccentric).toBe(true);
  });

  test('coupling ODs are the published EUE values', () => {
    expect(EUE_COUPLING_OD_IN['2.875']).toBe(3.668);
    expect(EUE_COUPLING_OD_IN['3.5']).toBe(4.5);
    // Casing catalog cross-check: 9-5/8 rows exist for the golden program.
    expect(CASING_CATALOG.some((c) => c.odIn === 9.625 && c.weightLbFt === 47)).toBe(true);
  });
});
