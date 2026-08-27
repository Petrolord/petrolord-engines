// Regional well cost planning benchmarks (Drilling D11).
//
// PROVENANCE: salvaged from the retired WellCostIQ app (D0 salvage
// pointer, parent of 2f9fa7717) — the one genuinely useful part of that
// mock. These are INDICATIVE order-of-magnitude planning numbers for
// prefilling a new estimate, not market data: every rate is editable in
// the case and the AFE carries the user's numbers, never these. The
// old app's fake percentile spread (p10 = 0.8·p50) was discarded; real
// spread comes from the Monte Carlo risk model.
//
// daysFactorPerM: dry-hole days per metre of MD (before well-type
// modifier). bestInClassFactor: multiplier on the suggested days for a
// top-quartile technical-limit target.

export const REGION_BENCHMARKS = {
  'Gulf of Mexico': { rigRateUsdPerDay: 450000, spreadRateUsdPerDay: 200000, daysFactorPerM: 0.003, bestInClassFactor: 0.85 },
  'North Sea': { rigRateUsdPerDay: 400000, spreadRateUsdPerDay: 220000, daysFactorPerM: 0.0035, bestInClassFactor: 0.80 },
  'West Africa': { rigRateUsdPerDay: 380000, spreadRateUsdPerDay: 180000, daysFactorPerM: 0.004, bestInClassFactor: 0.90 },
  Brazil: { rigRateUsdPerDay: 420000, spreadRateUsdPerDay: 190000, daysFactorPerM: 0.0038, bestInClassFactor: 0.88 },
  'Permian Basin': { rigRateUsdPerDay: 35000, spreadRateUsdPerDay: 40000, daysFactorPerM: 0.001, bestInClassFactor: 0.90 },
};

export const WELL_TYPE_MODIFIERS = {
  Exploration: { rateMod: 1.2, daysMod: 1.3 },
  'Development vertical': { rateMod: 0.9, daysMod: 0.8 },
  'Development horizontal': { rateMod: 1.0, daysMod: 1.1 },
  Deepwater: { rateMod: 1.5, daysMod: 1.5 },
  'Onshore land': { rateMod: 0.2, daysMod: 0.3 },
  'Offshore shelf': { rateMod: 1.0, daysMod: 1.0 },
};

const round1k = (v) => Math.round(v / 1000) * 1000;

// Deterministic prefill suggestion. Returns null on an unknown region
// or well type (the caller offers the lists; no silent defaulting).
export function benchmarkSuggestion({ region, wellType, mdM }) {
  const base = REGION_BENCHMARKS[region];
  const mod = WELL_TYPE_MODIFIERS[wellType];
  if (!base || !mod || !Number.isFinite(mdM) || mdM <= 0) return null;
  const dryHoleDays = Math.max(1, Math.round(mdM * base.daysFactorPerM * mod.daysMod));
  return {
    rigRateUsdPerDay: round1k(base.rigRateUsdPerDay * mod.rateMod),
    spreadRateUsdPerDay: round1k(base.spreadRateUsdPerDay * mod.rateMod),
    dryHoleDays,
    bestInClassDays: Math.max(1, Math.round(dryHoleDays * base.bestInClassFactor)),
    indicative: true,
  };
}
