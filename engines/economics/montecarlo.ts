// engines/economics/montecarlo.ts
//
// MOVED in the EC0 Economics engine extraction wave (2026-09-08) from the
// Suite's supabase/functions/_shared/epe-mc.ts, VERBATIM. The ONE edit is the
// import below: './epe-engine.ts' is now './cashflow.ts' (explicit .ts
// extension so the file loads under Deno, jest and Vite with no build step).
// The Suite path is now a re-export shim of this file (written by the EC0
// coordinator). The vendored sampling primitives are kept exactly as they
// were; in this package the canonical Monte Carlo module is
// ../../lib/stats/stats.js and __tests__/economics.montecarlo.test.ts ports
// the Suite's anti-drift gate against it (bit-identical samples on shared
// seeds). Independent stdlib oracle: tools/validation/economics/
// oracle_montecarlo.py (mulberry32 replicated in uint32 arithmetic);
// goldens: test-data/economics/goldens/montecarlo_cases.json. Original
// header follows unchanged.
//
// supabase/functions/_shared/epe-mc.ts
//
// PETROLORD EPE MONTE CARLO LAYER (D2, docs/scope/Economics-ROADMAP.md)
//
// Probabilistic economics over the deterministic EPE engine: samples input
// distributions and runs computeCashFlow() once per realization. No fiscal
// math lives here; every iteration goes through the validated engine
// (tools/validation/epe-validation.ts, 60 checks).
//
// SAMPLING PRIMITIVES — vendored port of the Suite's canonical Monte Carlo
// module src/lib/monteCarlo.js (the §5-sanctioned implementation). Edge
// functions cannot import that module (it depends on the npm package
// simple-statistics), so the primitives are ported 1:1 with the SAME names
// and semantics, and a jest anti-drift test
// (supabase/functions/_shared/__tests__/epe-mc.test.ts) asserts this port
// and the canonical module produce IDENTICAL samples for identical seeded
// RNG streams. If you change a primitive here or there, the test forces you
// to change both.
//
// Conventions: petroleum percentiles (P90 = low case), Gaussian-copula
// correlation, injectable RNG (seeded mulberry32 for reproducible runs).

import { computeCashFlow, isVolumeColumn, parsePriceDeck } from './cashflow.ts';

// ============================================================================
// Seeded RNG
// ============================================================================

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// Dependency-free statistics helpers
// ============================================================================

export function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

// Population standard deviation (divide by n), matching simple-statistics'
// standardDeviation used by the canonical module.
export function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length);
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ============================================================================
// Canonical sampling primitives (ported 1:1 from src/lib/monteCarlo.js)
// ============================================================================

export const SPREAD_TYPES = new Set(['triangular', 'normal', 'lognormal', 'uniform']);

export function cholesky(matrix: number[][]): number[][] {
  const n = matrix.length;
  const L: number[][] = Array(n).fill(0).map(() => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += L[i][k] * L[j][k];
      if (i === j) {
        L[i][j] = Math.sqrt(Math.max(matrix[i][i] - sum, 0));
      } else {
        L[i][j] = L[j][j] === 0 ? 0 : (1.0 / L[j][j]) * (matrix[i][j] - sum);
      }
    }
  }
  return L;
}

export function randomNormal(rng: () => number = Math.random): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592)
    * t * Math.exp(-ax * ax);
  return sign * y;
}

export function normalCDF(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export function triInvCDF(u: number, a: number, c: number, b: number): number {
  if (a === b) return a;
  if (u <= (c - a) / (b - a)) return a + Math.sqrt(u * (b - a) * (c - a));
  return b - Math.sqrt((1 - u) * (b - a) * (b - c));
}

export interface Dist {
  type: string;
  value?: number;
  mode?: number;
  mean?: number;
  stdDev?: number;
  min?: number;
  max?: number;
}

export function isVariable(dist: Dist | undefined): boolean {
  if (!dist || !SPREAD_TYPES.has(dist.type)) return false;
  if (dist.type === 'triangular' || dist.type === 'uniform') {
    return Number(dist.max) > Number(dist.min);
  }
  return Number(dist.stdDev) > 0;
}

export function representativeValue(dist: Dist | undefined): number | undefined {
  if (!dist) return undefined;
  switch (dist.type) {
    case 'triangular': return Number(dist.mode);
    case 'uniform': return (Number(dist.min) + Number(dist.max)) / 2;
    case 'normal':
    case 'lognormal': return Number(dist.mean);
    case 'constant': return Number(dist.value);
    default: {
      const v = dist.value ?? dist.mode ?? dist.mean;
      return v == null ? undefined : Number(v);
    }
  }
}

export function marginalValue(dist: Dist, x: number): number | undefined {
  switch (dist.type) {
    case 'normal':
      return Number(dist.mean) + Number(dist.stdDev) * x;
    case 'lognormal': {
      const m = Number(dist.mean);
      const sd = Number(dist.stdDev);
      const m2 = m * m;
      const sd2 = sd * sd;
      const mu = Math.log(m2 / Math.sqrt(m2 + sd2));
      const sigma = Math.sqrt(Math.log(1 + sd2 / m2));
      return Math.exp(mu + sigma * x);
    }
    case 'triangular':
      return triInvCDF(normalCDF(x), Number(dist.min), Number(dist.mode), Number(dist.max));
    case 'uniform':
      return Number(dist.min) + normalCDF(x) * (Number(dist.max) - Number(dist.min));
    default:
      return representativeValue(dist);
  }
}

export function createCorrelatedSampler({ inputs, paramOrder, correlations = [], rng = Math.random }: {
  inputs: Record<string, Dist>;
  paramOrder: string[];
  correlations?: Array<{ a: string; b: string; rho: number }>;
  rng?: () => number;
}) {
  const varKeys = paramOrder.filter((p) => isVariable(inputs[p]));
  const n = varKeys.length;

  const C: number[][] = Array(n).fill(0).map(() => Array(n).fill(0));
  for (let i = 0; i < n; i++) C[i][i] = 1.0;
  const setCorr = (a: string, b: string, rho: number) => {
    const ia = varKeys.indexOf(a);
    const ib = varKeys.indexOf(b);
    if (ia >= 0 && ib >= 0 && ia !== ib) {
      C[ia][ib] = rho;
      C[ib][ia] = rho;
    }
  };
  correlations.forEach(({ a, b, rho }) => {
    if (Number.isFinite(rho) && rho > -1 && rho < 1) setCorr(a, b, rho);
  });
  const L = cholesky(C);

  const sample = () => {
    const Z = Array.from({ length: n }, () => randomNormal(rng));
    const values: Record<string, number> = {};
    const truncated: string[] = [];
    for (let r = 0; r < n; r++) {
      let x = 0;
      for (let c = 0; c <= r; c++) x += L[r][c] * Z[c];
      const key = varKeys[r];
      const dist = inputs[key];
      const val = marginalValue(dist, x) as number;
      if (dist.type === 'normal' || dist.type === 'lognormal') {
        const lo = Number(dist.min);
        const hi = Number(dist.max);
        if ((Number.isFinite(lo) && val < lo) || (Number.isFinite(hi) && val > hi)) {
          truncated.push(key);
        }
      }
      values[key] = val;
    }
    return { values, truncated };
  };

  return { varKeys, sample };
}

// Percentile summary with CDF points. Petroleum convention: P90 = low case.
export function basicStats(data: number[]) {
  if (!data || data.length === 0) return {} as Record<string, never>;
  const validData = [...data].sort((a, b) => a - b);
  const getP = (p: number) => validData[Math.min(Math.floor(p * validData.length), validData.length - 1)];

  const cdfPoints: Array<{ x: number; y: number }> = [];
  const step = Math.max(1, Math.floor(validData.length / 100));
  for (let i = 0; i < validData.length; i += step) {
    cdfPoints.push({ x: validData[i], y: (i / validData.length) * 100 });
  }
  cdfPoints.push({ x: validData[validData.length - 1], y: 100 });

  return {
    p90: getP(0.1),
    p50: getP(0.5),
    p10: getP(0.9),
    mean: mean(validData),
    min: validData[0],
    max: validData[validData.length - 1],
    stdDev: stdDev(validData),
    cdf: cdfPoints,
  };
}

export function tornadoSwings(samples: Array<{ targetVol: number; inputs: Record<string, number> }>, fraction = 0.1) {
  if (!samples || samples.length < 30) return [];
  const outputs = samples.map((s) => s.targetVol);
  const base = median(outputs);
  const parameters = Object.keys(samples[0].inputs || {});
  const n = samples.length;
  const k = Math.max(15, Math.floor(n * fraction));
  const swings: Array<{ parameter: string; base: number; low: number; high: number; lowInputVol: number; highInputVol: number }> = [];

  parameters.forEach((param) => {
    const vals = samples.map((s) => s.inputs[param]);
    if (!vals.every(Number.isFinite) || stdDev(vals) === 0) return;
    const sorted = [...samples].sort((a, b) => a.inputs[param] - b.inputs[param]);
    const lowInputVol = median(sorted.slice(0, k).map((s) => s.targetVol));
    const highInputVol = median(sorted.slice(n - k).map((s) => s.targetVol));
    swings.push({
      parameter: param,
      base,
      low: Math.min(lowInputVol, highInputVol),
      high: Math.max(lowInputVol, highInputVol),
      lowInputVol,
      highInputVol,
    });
  });

  return swings.sort((a, b) => (b.high - b.low) - (a.high - a.low));
}

// ============================================================================
// EPE Monte Carlo run
// ============================================================================

// Supported uncertain inputs. Prices are ABSOLUTE (replace the config base
// values); scales are MULTIPLIERS applied to the uploaded CSV rows, matching
// the tornado engine's convention of scaling CSV-loaded amounts.
export const MC_VARIABLE_KEYS = ['oil_price', 'gas_price', 'capex_scale', 'opex_scale', 'production_scale'] as const;
export type McVariableKey = typeof MC_VARIABLE_KEYS[number];

export interface McConfig {
  iterations?: number;               // default 1000, clamped to [100, 5000]
  seed?: number;                     // omit for a random seed
  variables?: Partial<Record<McVariableKey, Dist>>;
  correlations?: Array<{ a: McVariableKey; b: McVariableKey; rho: number }>;
}

// Column recognition delegates to the engine (isVolumeColumn) so scaled
// columns stay in sync with what computeCashFlow actually reads — including
// bare oil_bbl-style aliases and case-insensitive headers (v3.3).
function scaleProdRows(rows: any[], s: number): any[] {
  if (s === 1) return rows;
  return rows.map((row) => {
    const out: any = { ...row };
    for (const k of Object.keys(row)) {
      if (isVolumeColumn(k)) out[k] = Number(row[k]) * s;
    }
    return out;
  });
}

function scaleUsdRows(rows: any[], s: number): any[] {
  if (s === 1) return rows;
  return rows.map((row) => {
    const out: any = { ...row };
    for (const k of Object.keys(row)) {
      if (k.trim().toLowerCase().endsWith('_usd')) out[k] = Number(row[k]) * s;
    }
    return out;
  });
}

const MAX_TRUNCATION_RETRIES = 10;

export function runEpeMonteCarlo({ cfg, prodRows, capexRows, opexRows, mcConfig }: {
  cfg: any;
  prodRows: any[];
  capexRows: any[];
  opexRows: any[];
  mcConfig: McConfig;
}) {
  const iterations = Math.max(100, Math.min(5000, Math.round(mcConfig.iterations ?? 1000)));
  const seed = Number.isFinite(mcConfig.seed) ? Number(mcConfig.seed) : Math.floor(Math.random() * 2 ** 31);
  const rng = mulberry32(seed);

  const variables = mcConfig.variables ?? {};
  const inputs: Record<string, Dist> = {};
  for (const key of MC_VARIABLE_KEYS) {
    if (variables[key]) inputs[key] = variables[key] as Dist;
  }

  const { varKeys, sample } = createCorrelatedSampler({
    inputs,
    paramOrder: [...MC_VARIABLE_KEYS],
    correlations: (mcConfig.correlations ?? []) as Array<{ a: string; b: string; rho: number }>,
    rng,
  });

  // Deterministic base run (unsampled inputs).
  const baseRun = computeCashFlow({ cfg, prodRows, capexRows, opexRows });
  const years = baseRun.cashFlowData.map((r: any) => r.year);

  const npvs: number[] = [];
  const irrs: number[] = [];
  let irrNullCount = 0;
  // Wave C: payback distribution + convergence trace
  const paybacks: number[] = [];
  let paybackNeverCount = 0;
  const convergence: Array<{ n: number; mean: number }> = [];
  const convergenceStep = Math.max(1, Math.floor(iterations / 20));
  const perYearNcf: number[][] = years.map(() => []);
  const perYearCum: number[][] = years.map(() => []);
  const tornadoSamples: Array<{ targetVol: number; inputs: Record<string, number> }> = [];
  // Economics E5: the per-iteration record, kept so a run can be audited
  // rather than only summarised. Every iteration is one row, INCLUDING the
  // ones where IRR or payback is undefined, which the `irrs` and `paybacks`
  // arrays above deliberately drop for their percentiles. Returned alongside
  // the results and NOT persisted with them: a five thousand row sample does
  // not belong in every saved run.
  const sampleRows: Array<{
    i: number;
    inputs: Record<string, number>;
    npv: number;
    irr: number | null;
    payback: number | null;
  }> = [];
  let truncationRejects = 0;
  const deckStreams = parsePriceDeck(cfg);  // Wave B: deck-aware price sampling

  for (let i = 0; i < iterations; i++) {
    let draw = sample();
    let retries = 0;
    while (draw.truncated.length > 0 && retries < MAX_TRUNCATION_RETRIES) {
      truncationRejects++;
      draw = sample();
      retries++;
    }
    const v = draw.values;

    const iterCfg = { ...cfg };
    // Wave B: with a per-year price deck the flat config price does not price
    // the run, so a sampled absolute price is applied as a SCALE on the
    // resolved deck (sample / reference), where the reference is the flat
    // base price the distribution was centered on. Without a deck the
    // absolute replacement is unchanged.
    if (v.oil_price !== undefined) {
      if (deckStreams.oil.length > 0) {
        const ref = Number(cfg.oil_price_usd_bbl) || deckStreams.oil[0].value || 1;
        iterCfg.oil_price_scale = v.oil_price / ref;
      } else {
        iterCfg.oil_price_usd_bbl = v.oil_price;
      }
    }
    if (v.gas_price !== undefined) {
      if (deckStreams.gas.length > 0) {
        const ref = Number(cfg.gas_price_usd_mscf) || deckStreams.gas[0].value || 1;
        iterCfg.gas_price_scale = v.gas_price / ref;
      } else {
        iterCfg.gas_price_usd_mscf = v.gas_price;
      }
    }

    const iterProd = scaleProdRows(prodRows, v.production_scale ?? 1);
    const iterCapex = scaleUsdRows(capexRows, v.capex_scale ?? 1);
    const iterOpex = scaleUsdRows(opexRows, v.opex_scale ?? 1);

    const { cashFlowData, kpis } = computeCashFlow({
      cfg: iterCfg, prodRows: iterProd, capexRows: iterCapex, opexRows: iterOpex,
    });

    npvs.push(kpis.npv);
    if (kpis.irr === null || kpis.irr === undefined) irrNullCount++;
    else irrs.push(kpis.irr);
    if (kpis.payback_years === null || kpis.payback_years === undefined) paybackNeverCount++;
    else paybacks.push(kpis.payback_years);
    if ((i + 1) % convergenceStep === 0 || i === iterations - 1) {
      convergence.push({ n: i + 1, mean: mean(npvs) });
    }

    for (let y = 0; y < years.length; y++) {
      const row = cashFlowData[y];
      perYearNcf[y].push(row ? row.net_cash_flow : 0);
      perYearCum[y].push(row ? row.cumulative_nominal : 0);
    }

    tornadoSamples.push({ targetVol: kpis.npv, inputs: { ...v } });
    sampleRows.push({
      i: i + 1,
      inputs: { ...v },
      npv: kpis.npv,
      irr: kpis.irr ?? null,
      payback: kpis.payback_years ?? null,
    });
  }

  const yearStats = (series: number[][]) => years.map((year: number, y: number) => {
    const s = [...series[y]].sort((a, b) => a - b);
    const getP = (p: number) => s[Math.min(Math.floor(p * s.length), s.length - 1)];
    return { year, p90: getP(0.1), p50: getP(0.5), p10: getP(0.9), mean: mean(s) };
  });

  return {
    iterations,
    seed,
    varKeys,
    base: { npv: baseRun.kpis.npv, irr: baseRun.kpis.irr, fiscal_framework: baseRun.kpis.fiscal_framework, pv_basis: baseRun.kpis.pv_basis },
    npv: { ...basicStats(npvs), se: stdDev(npvs) / Math.sqrt(npvs.length) },
    probNpvPositive: npvs.filter((x) => x > 0).length / npvs.length,
    irr: { ...basicStats(irrs), nullShare: irrNullCount / iterations },
    // Wave C: payback distribution; neverShare = iterations that never pay back
    payback: { ...basicStats(paybacks), neverShare: paybackNeverCount / iterations },
    convergence,
    // Fan bands are NOMINAL annual and cumulative net cash flow.
    fan: { ncf: yearStats(perYearNcf), cumulative: yearStats(perYearCum) },
    tornado: tornadoSwings(tornadoSamples),
    diagnostics: { truncationRejects },
    // Stripped off before the run is persisted; see the edge function.
    samples: sampleRows,
  };
}
