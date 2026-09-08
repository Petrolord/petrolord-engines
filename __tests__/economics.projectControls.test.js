/**
 * Gates for engines/economics/projectControls.js (Project Management Pro:
 * calculateEVM, calculateCPI, calculateSPI, formatTasksForGantt).
 *
 * The Suite had NO tests for this module (there is no
 * projectManagementCalculations test under src/utils/__tests__), so layer (c)
 * is empty and the coverage here is new: (a) the earned-value identities
 * and the module's own zero rules, (b) agreement with every golden case in
 * test-data/economics/goldens/afe_cases.json (evm, cpiSpi, gantt sections;
 * independent stdlib oracle tools/validation/economics/oracle_afe.py).
 *
 * calculateEVM returns STRINGS from toFixed(2); the golden carries both the
 * strings (compared exactly, including "NaN" and "Infinity") and the
 * numeric values they were rounded from (compared to 1e-9 after parsing).
 * Dates in the Gantt rows are compared as epoch milliseconds, UTC.
 */
import fs from 'fs';
import path from 'path';
import { calculateEVM, formatTasksForGantt, calculateCPI, calculateSPI } from '../engines/economics/projectControls.js';

const G = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/economics/goldens/afe_cases.json'), 'utf8'));

describe('identities', () => {
  const tasks = [
    { planned_cost: 1000, percent_complete: 50, actual_cost: 600 },
    { planned_cost: 2000, percent_complete: 25, actual_cost: 400 },
  ];

  test('PV, EV and AC are the sums the definitions say; CV and SV follow', () => {
    const r = calculateEVM(tasks, 99999);
    expect(r.plannedValue).toBe('3000.00');
    expect(r.earnedValue).toBe('1000.00');
    expect(r.actualCost).toBe('1000.00');
    expect(Number(r.cv)).toBeCloseTo(1000 - 1000, 9);
    expect(Number(r.sv)).toBeCloseTo(1000 - 3000, 9);
    expect(Number(r.cpi)).toBeCloseTo(1, 9);
    expect(Number(r.spi)).toBeCloseTo(1000 / 3000, 2);
    expect(r.percentCompleteRaw).toBe('33.33');
  });

  test('baselineBudget is accepted and never read', () => {
    expect(calculateEVM(tasks, 1)).toEqual(calculateEVM(tasks, 1e9));
    expect(calculateEVM(tasks)).toEqual(calculateEVM(tasks, undefined));
  });

  test('the zero rules: 1 when the divisor is zero and value was earned, else 0', () => {
    expect(calculateCPI(10, 0)).toBe(1);
    expect(calculateCPI(0, 0)).toBe(0);
    expect(calculateCPI(-1, 0)).toBe(0);
    expect(calculateSPI(10, 0)).toBe(1);
    expect(calculateSPI(0, 0)).toBe(0);
    expect(calculateCPI(120, 100)).toBeCloseTo(1.2, 12);
    expect(calculateSPI(80, 100)).toBeCloseTo(0.8, 12);
  });

  test('calculateEVM uses the same zero rules as the standalone functions', () => {
    const r = calculateEVM([{ planned_cost: 100, percent_complete: 40, actual_cost: 0 }]);
    expect(r.cpi).toBe('1.00');
    const z = calculateEVM([{ planned_cost: 100, percent_complete: 0, actual_cost: 0 }]);
    expect(z.cpi).toBe('0.00');
    expect(calculateEVM([]).spi).toBe('0.00');
    expect(calculateEVM([]).percentCompleteRaw).toBe('NaN');
  });

  test('every EVM figure is a string with two decimals', () => {
    const r = calculateEVM(tasks);
    Object.values(r).forEach((v) => {
      expect(typeof v).toBe('string');
      expect(v).toMatch(/^-?(\d+\.\d\d|NaN|Infinity)$/);
    });
  });

  test('Gantt rows keep ids and order, mark milestones, and carry dependencies only when there are predecessors', () => {
    const project = { name: 'P' };
    const rows = formatTasksForGantt([
      { id: 1, name: 'a', type: 'milestone', predecessors: [] },
      { id: 2, name: 'b', type: 'task', predecessors: [1] },
    ], project);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
    expect(rows[0].type).toBe('milestone');
    expect(rows[1].type).toBe('task');
    expect(rows[0].dependencies).toBeUndefined();
    expect(rows[1].dependencies).toEqual([1]);
    expect(rows.every((r) => r.project === 'P' && r.isDisabled === false)).toBe(true);
  });
});

describe('golden: calculateEVM', () => {
  test.each(G.evm.map((c) => [c.name, c]))('%s', (_n, c) => {
    const r = calculateEVM(c.inputs.tasks, c.inputs.baselineBudget);
    const e = c.expected;
    Object.keys(e.strings).forEach((k) => expect(r[k]).toBe(e.strings[k]));
    const num = e.numeric;
    ['plannedValue', 'earnedValue', 'actualCost', 'cpi', 'spi', 'cv', 'sv'].forEach((k) => {
      const key = { plannedValue: 'pv', earnedValue: 'ev', actualCost: 'ac' }[k] || k;
      if (num[key] === null) expect(Number.isFinite(Number(r[k]))).toBe(false);
      else expect(Math.abs(Number(r[k]) - num[key])).toBeLessThanOrEqual(0.005 + 1e-9);
    });
    if (num.percentCompleteRaw === null) expect(['NaN', 'Infinity', '-Infinity']).toContain(r.percentCompleteRaw);
  });

  test('the ties: 0.125 rounds to 0.13 and -0.125 to -0.13, 2.675 to 2.67', () => {
    const tie = G.evm.find((c) => c.name.startsWith('a tie'));
    expect(calculateEVM(tie.inputs.tasks).plannedValue).toBe('0.13');
    const neg = G.evm.find((c) => c.name.startsWith('negative cost variance'));
    expect(calculateEVM(neg.inputs.tasks).cv).toBe('-0.13');
    const bin = G.evm.find((c) => c.name.startsWith('2.675'));
    expect(calculateEVM(bin.inputs.tasks).plannedValue).toBe('2.67');
  });
});

describe('golden: calculateCPI and calculateSPI', () => {
  test('every pair', () => {
    G.cpiSpi.forEach((c) => {
      const [ev, d] = c.inputs;
      expect(calculateCPI(ev, d)).toBeCloseTo(c.expectedCpi, 12);
      expect(calculateSPI(ev, d)).toBeCloseTo(c.expectedSpi, 12);
    });
    expect(G.cpiSpi.length).toBeGreaterThanOrEqual(9);
  });
});

describe('golden: formatTasksForGantt', () => {
  test.each(G.gantt.map((c) => [c.name, c]))('%s', (_n, c) => {
    const rows = formatTasksForGantt(c.inputs.tasks, c.inputs.project);
    expect(rows).toHaveLength(c.expected.length);
    rows.forEach((r, i) => {
      const e = c.expected[i];
      expect(r.id).toBe(e.id);
      expect(r.name).toBe(e.name);
      expect(r.start).toBeInstanceOf(Date);
      expect(r.end).toBeInstanceOf(Date);
      if (e.startMs === null) expect(Number.isNaN(+r.start)).toBe(true); else expect(+r.start).toBe(e.startMs);
      if (e.endMs === null) expect(Number.isNaN(+r.end)).toBe(true); else expect(+r.end).toBe(e.endMs);
      expect(r.progress).toEqual(e.progress);
      expect(r.type).toBe(e.type);
      expect(r.project).toBe(e.project);
      expect(r.isDisabled).toBe(false);
      expect(r.styles).toEqual(e.styles);
      expect(r.owner ?? null).toEqual(e.owner ?? null);
      expect(r.status ?? null).toEqual(e.status ?? null);
      if (e.dependencies) expect(r.dependencies).toEqual(e.dependencies);
      else expect(r.dependencies).toBeUndefined();
    });
  });
});
