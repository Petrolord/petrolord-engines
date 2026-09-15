/**
 * Gates for engines/economics/projectControls.js (Project Management Pro:
 * calculateEVM, calculateCPI, calculateSPI, formatTasksForGantt).
 *
 * The Suite had NO tests for this module (there is no
 * projectManagementCalculations test under src/utils/__tests__), so layer (c)
 * is empty and the coverage here is new: (a) the earned-value identities
 * and the module's refusals, (b) agreement with every golden case in
 * test-data/economics/goldens/afe_cases.json (evm, evmRefusals, cpiSpi,
 * gantt sections; independent stdlib oracle
 * tools/validation/economics/oracle_afe.py).
 *
 * EC6-0 changed the contract: the figures are numbers, an index whose
 * denominator is zero is null rather than an invented 1, percent complete
 * is null rather than the string "NaN", and an unreadable or out-of-range
 * input is refused by task name. EC6-1 made planned value TIME-PHASED to a
 * stated as-of date, so the schedule index measures schedule; the ratio it
 * used to be is reported as `completionRatio`. Money to 1e-9, ratios to
 * 1e-12.
 *
 * Dates. Gantt rows carry LOCAL dates, so the golden holds the calendar
 * date and the gate reads the Date's local fields: the assertions hold in
 * any time zone, and the zone sweep below proves it.
 */
import fs from 'fs';
import path from 'path';
import {
  calculateEVM, formatTasksForGantt, calculateCPI, calculateSPI, ProjectControlsInputError,
} from '../engines/economics/projectControls.js';

const G = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/economics/goldens/afe_cases.json'), 'utf8'));

const localDate = (d) => (d === null ? null : [
  d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'),
].join('-'));

describe('identities', () => {
  const WINDOW = { planned_start_date: '2026-01-01', planned_end_date: '2026-12-31' };
  const tasks = [
    { name: 'a', ...WINDOW, planned_cost: 1000, percent_complete: 50, actual_cost: 600 },
    { name: 'b', ...WINDOW, planned_cost: 2000, percent_complete: 25, actual_cost: 400 },
  ];
  const AS_OF = { asOf: '2026-12-31' }; // the window has closed: PV is the whole budget

  test('EV and AC are the sums the definitions say; CV follows', () => {
    const r = calculateEVM(tasks, AS_OF);
    expect(r.budgetAtCompletion).toBe(3000);
    expect(r.earnedValue).toBe(1000);
    expect(r.actualCost).toBe(1000);
    expect(r.cv).toBeCloseTo(1000 - 1000, 9);
    expect(r.cpi).toBeCloseTo(1, 12);
    expect(r.percentComplete).toBeCloseTo(100 / 3, 12);
  });

  test('EC6-1: planned value is time-phased, so the same tasks read differently on two dates', () => {
    const closed = calculateEVM(tasks, { asOf: '2026-12-31' });
    expect(closed.plannedValue).toBe(3000);
    expect(closed.spi).toBeCloseTo(1000 / 3000, 12);

    const midway = calculateEVM(tasks, { asOf: '2026-07-02' });
    expect(midway.plannedValue).toBeGreaterThan(1400);
    expect(midway.plannedValue).toBeLessThan(1600);
    // Half the budget was due by now and a third of it is done: behind, but
    // nothing like the 0.33 the old budget-at-completion ratio reported.
    expect(midway.spi).toBeGreaterThan(closed.spi);
    expect(midway.completionRatio).toBeCloseTo(closed.completionRatio, 12);

    const notStarted = calculateEVM(tasks, { asOf: '2025-06-01' });
    expect(notStarted.plannedValue).toBe(0);
    expect(notStarted.spi).toBeNull();
  });

  test('the schedule index can read above 1, which the old one never could', () => {
    const ahead = calculateEVM(
      [{ name: 'a', ...WINDOW, planned_cost: 1000, percent_complete: 90 }],
      { asOf: '2026-07-02' },
    );
    expect(ahead.spi).toBeGreaterThan(1);
    expect(ahead.completionRatio).toBeCloseTo(0.9, 12);
  });

  test('a costed task with no dates: no schedule index, and the basis says why', () => {
    const r = calculateEVM([
      { name: 'dated', ...WINDOW, planned_cost: 500, percent_complete: 50 },
      { name: 'undated', planned_cost: 500, percent_complete: 50 },
    ], AS_OF);
    expect(r.spi).toBeNull();
    expect(r.plannedValue).toBeNull();
    expect(r.undatedCostedTasks).toBe(1);
    expect(r.spiBasis).toMatch(/1 costed task carries no planned dates/);
    expect(r.completionRatio).toBeCloseTo(0.5, 12);
  });

  test('asOf is a parameter, not the clock', () => {
    const a = calculateEVM(tasks, { asOf: '2026-07-02' });
    const b = calculateEVM(tasks, { asOf: '2026-07-02' });
    expect(a.pv).toBe(b.pv);
    expect(a.asOf).toBe('2026-07-02');
    expect(() => calculateEVM(tasks, { asOf: 'sometime' })).toThrow(ProjectControlsInputError);
  });

  test('every figure is a number, and pv/ev/ac alias the long names', () => {
    const r = calculateEVM(tasks, AS_OF);
    ['plannedValue', 'earnedValue', 'actualCost', 'pv', 'ev', 'ac', 'bac', 'cpi', 'spi', 'cv', 'sv', 'percentComplete']
      .forEach((k) => expect(typeof r[k]).toBe('number'));
    expect(r.pv).toBe(r.plannedValue);
    expect(r.ev).toBe(r.earnedValue);
    expect(r.ac).toBe(r.actualCost);
    expect(r.bac).toBe(r.budgetAtCompletion);
  });

  test('EC6-0: an index with no denominator is null, not an invented 1', () => {
    expect(calculateCPI(10, 0)).toBeNull();
    expect(calculateCPI(0, 0)).toBeNull();
    expect(calculateSPI(10, 0)).toBeNull();
    expect(calculateCPI(120, 100)).toBeCloseTo(1.2, 12);
    expect(calculateSPI(80, 100)).toBeCloseTo(0.8, 12);

    const r = calculateEVM([{ name: 'x', ...WINDOW, planned_cost: 100, percent_complete: 40, actual_cost: 0 }], AS_OF);
    expect(r.cpi).toBeNull();
    expect(r.spi).toBeCloseTo(0.4, 12);
  });

  test('EC6-0: a project with no costs reports no percent complete, not "NaN"', () => {
    const r = calculateEVM([{ name: 'x' }, { name: 'y' }], AS_OF);
    expect(r.percentComplete).toBeNull();
    expect(r.spi).toBeNull();
    expect(r.cpi).toBeNull();
    expect(r.costed).toBe(false);
    expect(r.taskCount).toBe(2);
    // The card that printed "Behind Schedule" read parseFloat(x || 1). There
    // is now nothing to misread: null is not a number that looks like zero.
    expect(Number.isFinite(r.percentComplete)).toBe(false);
  });

  test('the schedule index says on its face what it is measured against', () => {
    expect(calculateEVM(tasks, AS_OF).spiBasis).toBe('planned value time-phased to the as-of date');
  });

  test('an empty or absent task list is a zero, not a crash', () => {
    expect(calculateEVM([], AS_OF).budgetAtCompletion).toBe(0);
    expect(calculateEVM(undefined, AS_OF).taskCount).toBe(0);
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

  test('EC6-0: the Gantt row keeps task_category, which the stage managers filter on', () => {
    const rows = formatTasksForGantt([{ id: 1, name: 'a', task_category: 'Drilling' }], { name: 'P' });
    expect(rows[0].task_category).toBe('Drilling');
  });
});

describe('golden: calculateEVM', () => {
  test.each(G.evm.map((c) => [c.name, c]))('%s', (_n, c) => {
    const r = calculateEVM(c.inputs.tasks, { asOf: c.inputs.asOf });
    const e = c.expected;
    ['budgetAtCompletion', 'earnedValue', 'actualCost', 'ev', 'ac', 'bac', 'cv'].forEach((k) => {
      expect(Math.abs(r[k] - e[k])).toBeLessThanOrEqual(1e-9);
    });
    ['plannedValue', 'pv', 'sv'].forEach((k) => {
      if (e[k] === null) expect(r[k]).toBeNull();
      else expect(Math.abs(r[k] - e[k])).toBeLessThanOrEqual(1e-9);
    });
    ['cpi', 'spi', 'percentComplete', 'completionRatio'].forEach((k) => {
      if (e[k] === null) expect(r[k]).toBeNull();
      else expect(Math.abs(r[k] - e[k])).toBeLessThanOrEqual(1e-12 + Math.abs(e[k]) * 1e-12);
    });
    expect(r.taskCount).toBe(e.taskCount);
    expect(r.costed).toBe(e.costed);
    expect(r.undatedCostedTasks).toBe(e.undatedCostedTasks);
    expect(r.asOf).toBe(e.asOf);
    expect(r.spiBasis).toBe(e.spiBasis);
  });

  test('no figure is a string any more (the callers used to compare them as text)', () => {
    G.evm.forEach((c) => {
      const r = calculateEVM(c.inputs.tasks, { asOf: c.inputs.asOf });
      Object.entries(r).forEach(([k, v]) => {
        if (k === 'spiBasis' || k === 'asOf') return;
        expect(typeof v === 'number' || v === null || typeof v === 'boolean').toBe(true);
      });
    });
  });
});

describe('golden: calculateEVM refusals', () => {
  test.each(G.evmRefusals.map((c) => [c.name, c]))('%s', (_n, c) => {
    expect(() => calculateEVM(c.inputs.tasks, { asOf: c.inputs.asOf })).toThrow(ProjectControlsInputError);
    try {
      calculateEVM(c.inputs.tasks, { asOf: c.inputs.asOf });
    } catch (err) {
      expect(err.message).toBe(c.expected.message);
    }
  });

  test('negative control: the retired rules would have accepted every one of them', () => {
    // parseFloat('$1,200') is NaN, `|| 0` made it zero; a negative planned
    // cost and a 150 percent complete were taken as typed.
    G.evmRefusals.forEach((c) => {
      const asBefore = c.inputs.tasks.reduce((s, t) => s + (parseFloat(t.planned_cost) || 0), 0);
      expect(Number.isFinite(asBefore)).toBe(true);
    });
  });
});

describe('golden: calculateCPI and calculateSPI', () => {
  test('every pair', () => {
    G.cpiSpi.forEach((c) => {
      const [ev, d] = c.inputs;
      if (c.expectedCpi === null) expect(calculateCPI(ev, d)).toBeNull();
      else expect(calculateCPI(ev, d)).toBeCloseTo(c.expectedCpi, 12);
      if (c.expectedSpi === null) expect(calculateSPI(ev, d)).toBeNull();
      else expect(calculateSPI(ev, d)).toBeCloseTo(c.expectedSpi, 12);
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
      expect(localDate(r.start)).toBe(e.startDate);
      expect(localDate(r.end)).toBe(e.endDate);
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

  test('EC6-0: a date-only string is the same calendar day in this zone as in the golden', () => {
    // The retired code handed the chart UTC midnight, which renders as the
    // day before anywhere west of Greenwich.
    const rows = formatTasksForGantt([{ id: 1, planned_start_date: '2026-03-01' }], { name: 'P' });
    expect(localDate(rows[0].start)).toBe('2026-03-01');
    expect(rows[0].start.getHours()).toBe(0);
  });

  test('an absent or unreadable date is null, not an Invalid Date', () => {
    const rows = formatTasksForGantt([
      { id: 1 }, { id: 2, planned_start_date: null, planned_end_date: 'yesterday' },
    ], { name: 'P' });
    expect(rows[0].start).toBeNull();
    expect(rows[1].start).toBeNull();
    expect(rows[1].end).toBeNull();
  });
});
