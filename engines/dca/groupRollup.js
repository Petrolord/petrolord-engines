// Group roll-up (R1) — multi-well forecast aggregation from SAVED
// SCENARIOS. The DCA data model fits one stream of one well at a time
// (streamState is per stream, not per well); the durable per-well
// artifact is the scenario a user saves after a fit+forecast. A group
// roll-up therefore sums each member well's most recent scenario for
// the chosen stream: total EUR and a combined rate series aligned on
// calendar month. Wells without a matching scenario are reported, not
// silently dropped.

/** Own-property access. `obj[key]` walks the prototype chain, so a caller
 *  name of 'constructor', 'toString', 'valueOf', 'hasOwnProperty' or
 *  '__proto__' reads an inherited member, and writing '__proto__' replaces
 *  the prototype instead of storing a row. */
const hasOwn = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(obj, key);
const ownValue = (obj, key) => (hasOwn(obj, key) ? obj[key] : undefined);
const setOwn = (obj, key, value) => Object.defineProperty(obj, key, {
  value, writable: true, enumerable: true, configurable: true,
});

/** Most recent scenario per well for a stream, from the scenario list. */
export function latestScenarioByWell(scenarios, stream) {
  const byWell = {};
  for (const sc of scenarios || []) {
    if (sc.stream !== stream || !sc.wellId) continue;
    const prev = ownValue(byWell, sc.wellId);
    if (!prev || new Date(sc.createdAt) > new Date(prev.createdAt)) {
      setOwn(byWell, sc.wellId, sc);
    }
  }
  return byWell;
}

const monthKey = (dateStr) => {
  const d = new Date(dateStr);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/**
 * Roll up one well group.
 *
 * Volumes (DCA-U1, 2026-10-03). A scenario keeps three volumes apart since
 * the Suite's H3 fix: produced to date, remaining after the last data, and
 * EUR, their sum (`eurTotal`). Its `eur` key is the REMAINING volume (the
 * key older panels read). The roll-up summed `eur` and called it the group
 * EUR, short by everything the wells had already produced. It now sums
 * `eurTotal`; a scenario saved before H3 has none, so its remaining volume
 * stands in, the row says so (`eurBasis: 'remaining'`) and `partial` is set.
 *
 * Rates. A DCA forecast holds one point a DAY. The roll-up added every point
 * of a month into that month's "rate", so a group of daily forecasts showed
 * about 30 times its rate (the month's volume, labelled a rate), and `wells`
 * counted days. Each well's month is now the MEAN of its points in that
 * month (a daily rate), and the group's month is the sum of those means over
 * the wells that have points in it.
 *
 * @param {{id,name,wellIds:string[]}} group
 * @param {Object<string,{id,name}>} wells - the project wells map
 * @param {Array} scenarios - saved scenarios (context shape)
 * @param {'oil'|'gas'|'water'} stream
 * @returns {{
 *   perWell: Array<{wellId,wellName,scenarioName,eur,createdAt}>,
 *   missingWells: Array<{wellId,wellName}>,
 *   totalEur: number,
 *   combinedRates: Array<{month:string, rate:number, wells:number}>,
 * }|null} null when the group is empty
 */
export function rollupGroup(group, wells, scenarios, stream) {
  if (!group || !Array.isArray(group.wellIds) || group.wellIds.length === 0) return null;
  const latest = latestScenarioByWell(scenarios, stream);

  const perWell = [];
  const missingWells = [];
  const monthly = new Map(); // month -> {rate, wells}
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);

  for (const wellId of group.wellIds) {
    const wellName = wells?.[wellId]?.name || wellId;
    const sc = latest[wellId];
    if (!sc || !sc.forecastResults) {
      missingWells.push({ wellId, wellName });
      continue;
    }
    const fr = sc.forecastResults;
    const remaining = finite(fr.remaining) ? fr.remaining : (finite(fr.eur) ? fr.eur : 0);
    const hasTotal = finite(fr.eurTotal);
    perWell.push({
      wellId,
      wellName,
      scenarioName: sc.name,
      eur: hasTotal ? fr.eurTotal : remaining,
      eurBasis: hasTotal ? 'eur' : 'remaining',
      remaining,
      produced: finite(fr.produced) ? fr.produced : null,
      createdAt: sc.createdAt,
    });
    // this well's mean daily rate in each month
    const own = new Map(); // month -> {sum, n}
    for (const pt of fr.rates || []) {
      if (pt?.date == null || pt?.rate == null || !finite(Number(pt.rate))) continue;
      const key = monthKey(pt.date);
      const cur = own.get(key) || { sum: 0, n: 0 };
      cur.sum += Number(pt.rate);
      cur.n += 1;
      own.set(key, cur);
    }
    for (const [key, v] of own) {
      const cur = monthly.get(key) || { rate: 0, wells: 0 };
      cur.rate += v.sum / v.n;
      cur.wells += 1;
      monthly.set(key, cur);
    }
  }

  const combinedRates = [...monthly.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, v]) => ({ month, rate: v.rate, wells: v.wells }));

  return {
    perWell,
    missingWells,
    totalEur: perWell.reduce((s, w) => s + w.eur, 0),
    totalRemaining: perWell.reduce((s, w) => s + w.remaining, 0),
    partial: perWell.some((w) => w.eurBasis !== 'eur'),
    combinedRates,
  };
}
