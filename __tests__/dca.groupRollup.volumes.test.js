/**
 * DCA group roll-up, the volumes and the rates (Suite DCA-U1-006, 2026-10-03).
 *
 * 1. A scenario's `eur` is the REMAINING volume (the Suite's T1 and H3
 *    fixes); EUR is `eurTotal` = produced + remaining. The roll-up summed
 *    `eur` and called it the group EUR.
 * 2. A DCA forecast holds one point a day. The roll-up added every point of
 *    a month into the month's "rate", about 30 times the daily rate, and
 *    counted days as wells.
 *
 * The gates call rollupGroup; the old arithmetic is kept below as the
 * negative control, and it fails both.
 */
import { rollupGroup } from '../engines/dca/groupRollup';

const daily = (from, days, q) => Array.from({ length: days }, (_, i) => ({
  date: new Date(Date.parse(from) + i * 86400000).toISOString(), rate: q(i),
}));

// two wells with a daily forecast through March 2026, 100 and 40 bbl/d flat
const scenarios = [
  { wellId: 'w1', stream: 'oil', name: 'a', createdAt: '2026-01-01', forecastResults: { eur: 9000, remaining: 9000, produced: 41000, eurTotal: 50000, rates: daily('2026-03-01', 31, () => 100) } },
  { wellId: 'w2', stream: 'oil', name: 'b', createdAt: '2026-01-01', forecastResults: { eur: 1240, remaining: 1240, produced: 8760, eurTotal: 10000, rates: daily('2026-03-01', 31, () => 40) } },
];
const group = { id: 'g', name: 'Pad', wellIds: ['w1', 'w2'] };
const wells = { w1: { name: 'W-1' }, w2: { name: 'W-2' } };

// what the roll-up did before (the negative control)
function oldRollup(sc) {
  let total = 0;
  const monthly = new Map();
  for (const s of sc) {
    total += s.forecastResults.eur || 0;
    for (const pt of s.forecastResults.rates) {
      const d = new Date(pt.date);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const cur = monthly.get(key) || { rate: 0, wells: 0 };
      cur.rate += pt.rate; cur.wells += 1; monthly.set(key, cur);
    }
  }
  return { totalEur: total, march: monthly.get('2026-03') };
}

test('the group EUR is produced plus remaining, summed over the wells', () => {
  const r = rollupGroup(group, wells, scenarios, 'oil');
  expect(r.totalEur).toBe(60000);
  expect(r.totalRemaining).toBe(10240);
  expect(r.partial).toBe(false);
  expect(r.perWell.map((w) => w.eurBasis)).toEqual(['eur', 'eur']);
  // negative control: the remaining volume under the EUR name
  expect(oldRollup(scenarios).totalEur).toBe(10240);
  expect(oldRollup(scenarios).totalEur).not.toBe(r.totalEur);
});

test('a month of daily points is a daily rate, and wells count wells', () => {
  const r = rollupGroup(group, wells, scenarios, 'oil');
  const march = r.combinedRates.find((x) => x.month === '2026-03');
  expect(march.rate).toBeCloseTo(140, 10);
  expect(march.wells).toBe(2);
  // negative control: the month's volume labelled a rate, days counted as wells
  expect(oldRollup(scenarios).march.rate).toBeCloseTo(4340, 10);
  expect(oldRollup(scenarios).march.wells).toBe(62);
});

test('a scenario saved before EUR was kept stands in with its remaining volume and says so', () => {
  const legacy = [{ wellId: 'w1', stream: 'oil', name: 'old', createdAt: '2025-01-01', forecastResults: { eur: 9000, rates: [] } }];
  const r = rollupGroup({ id: 'g', wellIds: ['w1'] }, wells, legacy, 'oil');
  expect(r.totalEur).toBe(9000);
  expect(r.perWell[0].eurBasis).toBe('remaining');
  expect(r.partial).toBe(true);
});

test('a declining month is the mean of its days', () => {
  const sc = [{ wellId: 'w1', stream: 'oil', name: 'a', createdAt: '2026-01-01', forecastResults: { eurTotal: 1, rates: daily('2026-04-01', 30, (i) => 100 - i) } }];
  const r = rollupGroup({ id: 'g', wellIds: ['w1'] }, wells, sc, 'oil');
  expect(r.combinedRates[0].rate).toBeCloseTo((100 + 71) / 2, 10);
});
