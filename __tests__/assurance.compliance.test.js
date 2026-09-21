/**
 * Ported from the Suite at AS12 (src/lib/__tests__/complianceStatus.test.js), the rule
 * tests only. The Suite keeps its whole-tree single-authority guards, its
 * migration vocabulary checks and its colour token tests, which are about
 * the Suite, not the engine.
 */
/**
 * AS3 — the compliance status authority.
 *
 * Same shape as riskScoring.test.js: unit tests, then a guard that
 * fails if a second copy of the derivation appears anywhere in the app
 * again. The risk register had four copies of its thresholds before AS2
 * took them away; Regulatory Compliance started from zero copies
 * because it had no derivation at all, and the guard is what keeps it
 * at one.
 *
 * Every test pins a date. A status test that calls `new Date()` passes
 * today and fails on a Tuesday in March.
 */
import {
  ATTENTION_STATUSES,
  DEFAULT_LEAD_TIME_DAYS,
  STATUS,
  STATUS_SEVERITY,
  byUrgency,
  countBy,
  daysUntil,
  deriveStatus,
  explainStatus,
  periodStart,
  nextActionDate,
  parseDateOnly,
  rollForward,
  summarise,
  toDateOnlyString,
} from '../engines/assurance/complianceStatus.js';

const TODAY = new Date(2026, 8, 17); // 17 September 2026, local midnight

const obligation = (over = {}) => ({
  lifecycle: 'Active',
  due_date: '2026-12-31',
  ...over,
});

describe('date handling', () => {
  it('parses a date-only string at LOCAL midnight, not UTC', () => {
    // new Date('2026-09-17') is UTC midnight, which is 16 September in
    // every negative offset. An obligation due today would then read
    // overdue for every user west of Greenwich.
    const d = parseDateOnly('2026-09-17');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(8);
    expect(d.getDate()).toBe(17);
    expect(d.getHours()).toBe(0);
  });

  it('counts whole calendar days, signed', () => {
    expect(daysUntil('2026-09-17', TODAY)).toBe(0);
    expect(daysUntil('2026-09-18', TODAY)).toBe(1);
    expect(daysUntil('2026-09-10', TODAY)).toBe(-7);
  });

  it('returns null rather than NaN for a missing or unparseable date', () => {
    expect(parseDateOnly(null)).toBeNull();
    expect(parseDateOnly('not a date')).toBeNull();
    expect(daysUntil(undefined, TODAY)).toBeNull();
  });

  it('writes a Date back as a date-only string in local terms', () => {
    expect(toDateOnlyString(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(toDateOnlyString('2026-01-05')).toBe('2026-01-05');
    expect(toDateOnlyString(null)).toBeNull();
  });
});

describe('the date an obligation counts down to', () => {
  it('is the earlier of the next submission and the permit expiry', () => {
    const o = obligation({ due_date: '2026-11-30', expiry_date: '2026-10-01' });
    expect(toDateOnlyString(nextActionDate(o))).toBe('2026-10-01');
  });

  it('is whichever one exists when only one does', () => {
    expect(toDateOnlyString(nextActionDate(obligation({ due_date: '2026-11-30', expiry_date: null }))))
      .toBe('2026-11-30');
    expect(toDateOnlyString(nextActionDate(obligation({ due_date: null, expiry_date: '2026-11-30' }))))
      .toBe('2026-11-30');
  });

  it('is null when the obligation carries no dates at all', () => {
    expect(nextActionDate(obligation({ due_date: null }))).toBeNull();
  });
});

describe('status derivation', () => {
  it('lets a non-Active lifecycle answer for itself', () => {
    // A superseded obligation with a due date last year is superseded,
    // not overdue. Reporting it as overdue is how a register fills with
    // noise nobody can close.
    const stale = { due_date: '2025-01-01', expiry_date: '2025-01-01' };
    expect(deriveStatus({ ...stale, lifecycle: 'Superseded' }, TODAY)).toBe(STATUS.SUPERSEDED);
    expect(deriveStatus({ ...stale, lifecycle: 'Draft' }, TODAY)).toBe(STATUS.DRAFT);
    expect(deriveStatus({ ...stale, lifecycle: 'Not applicable' }, TODAY)).toBe(STATUS.NOT_APPLICABLE);
  });

  it('treats a missing lifecycle as Active', () => {
    expect(deriveStatus({ due_date: '2025-01-01' }, TODAY)).toBe(STATUS.OVERDUE);
  });

  it('ranks an expired permit above an overdue return', () => {
    // Both are late. If the licence itself has lapsed, when the next
    // report was due is no longer the headline.
    const o = obligation({ due_date: '2026-09-01', expiry_date: '2026-08-01' });
    expect(deriveStatus(o, TODAY)).toBe(STATUS.EXPIRED);
  });

  it('is Overdue the day after the due date and not before', () => {
    expect(deriveStatus(obligation({ due_date: '2026-09-17' }), TODAY)).not.toBe(STATUS.OVERDUE);
    expect(deriveStatus(obligation({ due_date: '2026-09-16' }), TODAY)).toBe(STATUS.OVERDUE);
  });

  it('does not let an old filing clear a currently overdue obligation', () => {
    // The filing that is late is this period's. Evidence from March
    // does not make a September return on time.
    const o = obligation({ due_date: '2026-09-01', last_submitted_date: '2026-03-01' });
    expect(deriveStatus(o, TODAY)).toBe(STATUS.OVERDUE);
  });

  it('is Due soon inside the obligation\'s own lead time', () => {
    const o = obligation({ due_date: '2026-10-01', lead_time_days: 30 });
    expect(deriveStatus(o, TODAY)).toBe(STATUS.DUE_SOON);
  });

  it('honours a per-obligation lead time in both directions', () => {
    // A 7-day incident notification and a 90-day permit renewal are
    // not the same warning, which is why the column exists.
    const due = '2026-10-01'; // 14 days out
    expect(deriveStatus(obligation({ due_date: due, lead_time_days: 7 }), TODAY))
      .not.toBe(STATUS.DUE_SOON);
    expect(deriveStatus(obligation({ due_date: due, lead_time_days: 90 }), TODAY))
      .toBe(STATUS.DUE_SOON);
  });

  it('falls back to the default lead time when the column is absent or junk', () => {
    const due = '2026-10-10'; // 23 days out, inside the 30 day default
    expect(DEFAULT_LEAD_TIME_DAYS).toBe(30);
    expect(deriveStatus(obligation({ due_date: due }), TODAY)).toBe(STATUS.DUE_SOON);
    expect(deriveStatus(obligation({ due_date: due, lead_time_days: null }), TODAY)).toBe(STATUS.DUE_SOON);
    expect(deriveStatus(obligation({ due_date: due, lead_time_days: 'soon' }), TODAY)).toBe(STATUS.DUE_SOON);
  });

  it('warns on an approaching EXPIRY even when the next return is far off', () => {
    // The whole point of carrying two dates. A permit lapsing in three
    // weeks must not hide behind an annual return due in December.
    const o = obligation({ due_date: '2026-12-31', expiry_date: '2026-10-05' });
    expect(deriveStatus(o, TODAY)).toBe(STATUS.DUE_SOON);
  });

  it('never claims Compliant for an obligation with no evidence', () => {
    // "On track" means we are on schedule. "Compliant" means we have
    // actually filed. Collapsing the two is how a register reports a
    // clean bill of health for work nobody has done.
    const o = obligation({ due_date: '2026-12-31' });
    expect(deriveStatus(o, TODAY)).toBe(STATUS.ON_TRACK);
    expect(deriveStatus({ ...o, last_submitted_date: '2026-01-31' }, TODAY)).toBe(STATUS.COMPLIANT);
  });

  it('says so when nothing can fall due', () => {
    expect(deriveStatus(obligation({ due_date: null, expiry_date: null }), TODAY))
      .toBe(STATUS.NO_DATE);
  });

  it('gives every status a reason a user can check', () => {
    const cases = [
      obligation({ due_date: '2026-09-16' }),
      obligation({ expiry_date: '2026-08-01' }),
      obligation({ due_date: '2026-10-01' }),
      obligation({ due_date: '2026-12-31' }),
      obligation({ due_date: '2026-12-31', last_submitted_date: '2026-01-31' }),
      obligation({ due_date: null }),
      obligation({ lifecycle: 'Draft' }),
    ];
    cases.forEach((o) => {
      const { status, reason } = explainStatus(o, TODAY);
      expect(STATUS_SEVERITY).toContain(status);
      expect(reason).toMatch(/\S/);
      expect(reason).not.toMatch(/NaN|undefined|null/);
    });
  });
});

describe('ordering and rollup', () => {
  const register = [
    obligation({ id: 'on-track', due_date: '2027-01-01' }),
    obligation({ id: 'expired', expiry_date: '2026-01-01' }),
    obligation({ id: 'due-soon', due_date: '2026-09-20' }),
    obligation({ id: 'overdue', due_date: '2026-09-01' }),
    obligation({ id: 'draft', lifecycle: 'Draft' }),
  ];

  it('sorts worst first', () => {
    const order = [...register].sort(byUrgency(TODAY)).map((o) => o.id);
    expect(order).toEqual(['expired', 'overdue', 'due-soon', 'on-track', 'draft']);
  });

  it('breaks a tie on the nearer date', () => {
    const a = obligation({ id: 'later', due_date: '2026-09-25' });
    const b = obligation({ id: 'sooner', due_date: '2026-09-19' });
    expect([a, b].sort(byUrgency(TODAY)).map((o) => o.id)).toEqual(['sooner', 'later']);
  });

  it('counts every obligation exactly once', () => {
    const s = summarise(register, TODAY);
    expect(s.total).toBe(register.length);
    expect(Object.values(s.byStatus).reduce((a, b) => a + b, 0)).toBe(register.length);
  });

  it('counts attention as exactly the three statuses that need action', () => {
    expect(summarise(register, TODAY).attention).toBe(3);
    expect(ATTENTION_STATUSES).toEqual([STATUS.EXPIRED, STATUS.OVERDUE, STATUS.DUE_SOON]);
  });

  it('groups by a field and labels the rows that do not say', () => {
    const rows = countBy(
      [{ regime: 'Environmental' }, { regime: 'Environmental' }, { regime: null }],
      'regime',
    );
    expect(rows).toEqual([
      { name: 'Environmental', count: 2 },
      { name: 'Unspecified', count: 1 },
    ]);
  });

});

describe('rolling the next due date forward after a submission', () => {
  it('rolls from the date that WAS due, never from the filing date', () => {
    // An annual return filed three weeks late is still due on the same
    // day next year. Rolling from the filing date walks the schedule
    // later every single year.
    expect(toDateOnlyString(rollForward('2026-03-31', 'Annual'))).toBe('2027-03-31');
  });

  it('handles every periodic frequency', () => {
    expect(toDateOnlyString(rollForward('2026-01-15', 'Monthly'))).toBe('2026-02-15');
    expect(toDateOnlyString(rollForward('2026-01-15', 'Quarterly'))).toBe('2026-04-15');
    expect(toDateOnlyString(rollForward('2026-01-15', 'Semi-annual'))).toBe('2026-07-15');
    expect(toDateOnlyString(rollForward('2026-01-15', 'Biennial'))).toBe('2028-01-15');
  });

  it('pulls a month-end back instead of overflowing into the next month', () => {
    // Naively, 31 January plus one month is 3 March in a non-leap year.
    expect(toDateOnlyString(rollForward('2026-01-31', 'Monthly'))).toBe('2026-02-28');
    expect(toDateOnlyString(rollForward('2026-05-31', 'Monthly'))).toBe('2026-06-30');
  });

  it('returns null where there is no next occurrence to compute', () => {
    expect(rollForward('2026-01-15', 'One-off')).toBeNull();
    expect(rollForward('2026-01-15', 'Other')).toBeNull();
    expect(rollForward(null, 'Annual')).toBeNull();
  });
});

describe('AS15 owner decisions', () => {
  it('Q1: refuses an unreadable today instead of failing open', () => {
    const o = { due_date: '2020-01-01' };
    expect(() => deriveStatus(o, new Date('garbage'))).toThrow(RangeError);
    expect(() => deriveStatus(o, null)).toThrow(RangeError);
    expect(() => deriveStatus({ lifecycle: 'Draft' }, new Date(NaN))).toThrow(RangeError);
    expect(() => summarise([o], new Date(NaN))).toThrow(RangeError);
    expect(summarise([], new Date(NaN)).total).toBe(0);
  });

  it('Q2: a filing from an earlier period does not make an obligation Compliant', () => {
    const annual = { frequency: 'Annual', due_date: '2027-06-30' };
    expect(deriveStatus({ ...annual, last_submitted_date: '2026-06-29' }, TODAY)).toBe(STATUS.ON_TRACK);
    expect(deriveStatus({ ...annual, last_submitted_date: '2026-06-30' }, TODAY)).toBe(STATUS.COMPLIANT);
    expect(explainStatus({ ...annual, last_submitted_date: '2026-06-29' }, TODAY).reason)
      .toMatch(/earlier period/);
  });

  it('Q2: periods without a length accept a filing of any age', () => {
    expect(deriveStatus({ frequency: 'Other', due_date: '2027-06-30', last_submitted_date: '2019-01-01' }, TODAY))
      .toBe(STATUS.COMPLIANT);
    expect(deriveStatus({ due_date: '2027-06-30', last_submitted_date: '2019-01-01' }, TODAY))
      .toBe(STATUS.COMPLIANT);
  });

  it('Q2: periodStart rolls back a frequency, clamped to month end', () => {
    const ymd = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate()];
    expect(ymd(periodStart('2026-03-31', 'Monthly'))).toEqual([2026, 2, 28]);
    expect(ymd(periodStart('2028-03-31', 'Monthly'))).toEqual([2028, 2, 29]);
    expect(ymd(periodStart('2026-12-31', 'Quarterly'))).toEqual([2026, 9, 30]);
    expect(periodStart('2026-09-17', 'One-off')).toBeNull();
    expect(periodStart(null, 'Annual')).toBeNull();
  });
});


describe('ASC-0 R4: explainStatus says what is true', () => {
  it('a filed One-off past its due date is discharged, never "next due in -62 days"', () => {
    const r = explainStatus({
      frequency: 'One-off', due_date: '2026-08-14', last_submitted_date: '2026-08-10',
    }, new Date(2026, 9, 15));
    expect(r.status).toBe('Compliant');
    expect(r.reason).toBe('Filed 2026-08-10. A one-off obligation, nothing further is due.');
    expect(r.daysUntil).toBe(-62);
  });

  it('names a permit expiry that is still ahead', () => {
    expect(explainStatus({
      frequency: 'One-off', expiry_date: '2026-09-17', last_submitted_date: '2026-08-10',
    }, TODAY).reason).toBe('Filed 2026-08-10. A one-off obligation, nothing further is due. The permit expires today.');
  });

  it('no reason prints a negative count or "1 days"', () => {
    const cases = [
      { frequency: 'One-off', due_date: '2026-01-01', last_submitted_date: '2025-12-01' },
      { frequency: 'Annual', due_date: '2026-09-18', lead_time_days: 0, last_submitted_date: '2026-01-10' },
      { frequency: 'Monthly', due_date: '2026-09-18', lead_time_days: 0 },
      { frequency: 'Monthly', due_date: '2026-09-18' },
      { frequency: 'Monthly', due_date: '2026-09-16' },
      { expiry_date: '2026-09-16' },
    ];
    cases.forEach((o) => {
      const { reason } = explainStatus(o, TODAY);
      expect(reason).not.toMatch(/(^|\s)-\d/);
      expect(reason).not.toMatch(/\b1 days\b/);
      expect(reason).not.toMatch(/\bin 0 days\b/);
    });
    expect(explainStatus(cases[1], TODAY).reason).toBe('Last filed 2026-01-10, next due in 1 day.');
    expect(explainStatus(cases[2], TODAY).reason).toBe('Due in 1 day. Nothing has been filed against it yet.');
  });
});
