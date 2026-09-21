/**
 * Gate for lib/dates/dates.js, the vendored date-fns subset.
 *
 * The pins in test-data/dates/date_fns_pins.json were emitted by the REAL
 * date-fns 4.1.0 (the Suite's node_modules copy) on a UTC machine, for a
 * spread of inputs: the ISO grammar's every form, invalid strings, month
 * ends, leap days, negative differences, sub-day remainders, fractional and
 * NaN amounts, and the format tokens the subset carries. Every vendored
 * helper must reproduce every pin exactly.
 *
 * TIMEZONE. The helpers are local-time by design, so the gate first checks
 * it is running under the timezone the pins were taken in (UTC). Under any
 * other zone the pins are not comparable and the gate says so.
 */
import fs from 'fs';
import path from 'path';
import {
  parseISO, isValid, differenceInDays, addDays, format, differenceInCalendarDays,
} from '../lib/dates/dates.js';

const PINS = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/dates/date_fns_pins.json'), 'utf8'));

const decode = (v) => {
  if (v === '__undefined__') return undefined;
  if (v === '__NaN__') return NaN;
  if (v === '__Infinity__') return Infinity;
  return v;
};

describe('timezone assumption', () => {
  test('the pins were taken in UTC and this run is UTC too', () => {
    expect(PINS.timezone).toBe('UTC');
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC');
    expect(new Date(2020, 0, 1).getTimezoneOffset()).toBe(0);
  });

  test('the pins came from date-fns 4.1.0', () => {
    expect(PINS.date_fns_version).toBe('4.1.0');
  });
});

describe('parseISO against the real date-fns', () => {
  test.each(PINS.parseISO.map((p) => [String(p.input), p]))('parseISO(%s)', (_label, p) => {
    const input = decode(p.input);
    if (p.ms && typeof p.ms === 'object' && p.ms.throws) {
      expect(() => parseISO(input)).toThrow(globalThis[p.ms.throws]);
      return;
    }
    const d = parseISO(input);
    expect(d).toBeInstanceOf(Date);
    if (p.ms === null) expect(Number.isNaN(+d)).toBe(true);
    else expect(+d).toBe(p.ms);
  });

  test('the pin set covers the grammar it claims to', () => {
    expect(PINS.parseISO.length).toBeGreaterThanOrEqual(60);
    const invalid = PINS.parseISO.filter((p) => p.ms === null).length;
    expect(invalid).toBeGreaterThanOrEqual(20);
  });
});

describe('isValid against the real date-fns', () => {
  test.each(PINS.isValid.map((p) => [`${p.kind}:${JSON.stringify(p.input)}`, p]))('isValid(%s)', (_label, p) => {
    const raw = decode(p.input);
    let arg;
    if (p.kind === 'date') arg = parseISO(raw);
    else if (p.kind === 'invalidDate') arg = new Date(NaN);
    else arg = raw;
    expect(isValid(arg)).toBe(p.valid);
  });

  test('a string is never valid, even an ISO one', () => {
    expect(isValid('2020-01-01')).toBe(false);
    expect(isValid(parseISO('2020-01-01'))).toBe(true);
  });
});

describe('differenceInDays against the real date-fns', () => {
  test.each(PINS.differenceInDays.map((p) => [`${p.later} minus ${p.earlier}`, p]))('%s', (_label, p) => {
    const r = differenceInDays(parseISO(p.later), parseISO(p.earlier));
    if (p.days === null) expect(Number.isNaN(r)).toBe(true);
    else {
      expect(r).toBe(p.days);
      expect(Object.is(r, -0)).toBe(false);
    }
  });

  test.each(PINS.differenceInDays_ms.map((p) => [`${p.laterMs} ms minus ${p.earlierMs} ms`, p]))('%s', (_label, p) => {
    expect(differenceInDays(new Date(p.laterMs), new Date(p.earlierMs))).toBe(p.days);
  });

  test('identities: antisymmetric, truncates toward zero, zero on the same instant', () => {
    const a = parseISO('2020-01-03T12:00:00');
    const b = parseISO('2020-01-01T13:00:00');
    expect(differenceInDays(a, b)).toBe(-differenceInDays(b, a));
    expect(differenceInDays(a, b)).toBe(Math.trunc((+a - +b) / 86400000));
    expect(differenceInDays(a, a)).toBe(0);
    expect(differenceInCalendarDays(a, b)).toBe(2);
  });

  test('a year and a leap year, by calendar', () => {
    expect(differenceInDays(parseISO('2021-01-01'), parseISO('2020-01-01'))).toBe(366);
    expect(differenceInDays(parseISO('2022-01-01'), parseISO('2021-01-01'))).toBe(365);
  });
});

describe('addDays against the real date-fns', () => {
  test.each(PINS.addDays.map((p) => [`${p.date} + ${p.amount}`, p]))('%s', (_label, p) => {
    const r = addDays(parseISO(p.date), decode(p.amount));
    expect(r).toBeInstanceOf(Date);
    if (p.ms === null) expect(Number.isNaN(+r)).toBe(true);
    else expect(+r).toBe(p.ms);
  });

  test('does not mutate its argument and returns a copy for zero', () => {
    const d = parseISO('2020-01-31');
    const before = +d;
    const r = addDays(d, 5);
    expect(+d).toBe(before);
    expect(r).not.toBe(d);
    const z = addDays(d, 0);
    expect(z).not.toBe(d);
    expect(+z).toBe(before);
  });

  test('round trips with differenceInDays', () => {
    const d = parseISO('2020-02-29');
    for (const n of [-400, -1, 0, 1, 28, 365, 366, 1000]) {
      expect(differenceInDays(addDays(d, n), d)).toBe(n);
    }
  });
});

describe('format against the real date-fns', () => {
  test.each(PINS.format.map((p) => [`format(${p.date}, ${JSON.stringify(p.formatStr)})`, p]))('%s', (_label, p) => {
    const d = parseISO(p.date);
    if (p.throws) {
      expect(() => format(d, p.formatStr)).toThrow(globalThis[p.throws]);
      if (p.throws === 'RangeError') expect(() => format(d, p.formatStr)).toThrow(p.message);
      return;
    }
    expect(format(d, p.formatStr)).toBe(p.text);
  });

  test('a date-fns token outside the vendored subset is refused by name, not misformatted', () => {
    const d = parseISO('2020-01-05');
    expect(() => format(d, 'MMM')).toThrow(/not vendored/);
    expect(() => format(d, 'EEE')).toThrow(/not vendored/);
    expect(() => format(d, 'do')).toThrow(/not vendored/);
    expect(() => format(d, 'PP')).toThrow(/not vendored/);
    expect(() => format(d, 'yyyy-MM-dd')).not.toThrow();
  });
});
