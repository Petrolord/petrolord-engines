// Group roll-up (R1) — multi-well forecast aggregation from SAVED
// SCENARIOS. The DCA data model fits one stream of one well at a time
// (streamState is per stream, not per well); the durable per-well
// artifact is the scenario a user saves after a fit+forecast. A group
// roll-up therefore sums each member well's most recent scenario for
// the chosen stream: total EUR and a combined rate series aligned on
// calendar month. Wells without a matching scenario are reported, not
// silently dropped.

/** Most recent scenario per well for a stream, from the scenario list. */
export function latestScenarioByWell(scenarios, stream) {
  const byWell = {};
  for (const sc of scenarios || []) {
    if (sc.stream !== stream || !sc.wellId) continue;
    const prev = byWell[sc.wellId];
    if (!prev || new Date(sc.createdAt) > new Date(prev.createdAt)) {
      byWell[sc.wellId] = sc;
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

  for (const wellId of group.wellIds) {
    const wellName = wells?.[wellId]?.name || wellId;
    const sc = latest[wellId];
    if (!sc || !sc.forecastResults) {
      missingWells.push({ wellId, wellName });
      continue;
    }
    perWell.push({
      wellId,
      wellName,
      scenarioName: sc.name,
      eur: sc.forecastResults.eur || 0,
      createdAt: sc.createdAt,
    });
    for (const pt of sc.forecastResults.rates || []) {
      if (pt?.date == null || pt?.rate == null) continue;
      const key = monthKey(pt.date);
      const cur = monthly.get(key) || { rate: 0, wells: 0 };
      cur.rate += pt.rate;
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
    combinedRates,
  };
}
