// LAS import layer (Well Data Manager G1.2): parsed file -> registry
// payloads. Internal units are SI (metres; sonic in US/M) — the
// WellDataManager-PLAN.md day-one rule. Conversions happen HERE, never
// in the parser (the goldens pin raw parse fidelity) and never
// silently: every converted curve records {sourceUnit, factor} in its
// provenance, and unrecognised units pass through unchanged with
// converted=false so the import UI can ask instead of guessing.
//
// Pure functions, worker-safe, no I/O.

export const FT_PER_M = 0.3048;           // exact by definition

/** Depth-type units (per-foot flavours) -> metres. */
const DEPTH_FACTORS = {
  M: 1, METRE: 1, METRES: 1, METER: 1, METERS: 1,
  F: FT_PER_M, FT: FT_PER_M, FEET: FT_PER_M,
};

/** Value-curve conversions to the SI-internal unit. Sonic slowness is
 *  per-length, so ft-referenced slowness DIVIDES by 0.3048. */
const CURVE_CONVERSIONS = {
  'US/F': { unit: 'US/M', factor: 1 / FT_PER_M },
  'US/FT': { unit: 'US/M', factor: 1 / FT_PER_M },
  'USEC/F': { unit: 'US/M', factor: 1 / FT_PER_M },
  'USEC/FT': { unit: 'US/M', factor: 1 / FT_PER_M },
  F: { unit: 'M', factor: FT_PER_M },
  FT: { unit: 'M', factor: FT_PER_M },
  FEET: { unit: 'M', factor: FT_PER_M },
};

/** Curve-kind guesses for the import mapping preview (the wellImport
 *  GUESSES philosophy: suggest, let the user confirm). */
const KIND_GUESSES = {
  depth: ['DEPT', 'DEPTH', 'MD'],
  gr: ['GR', 'SGR', 'CGR', 'GRC'],
  density: ['RHOB', 'DEN', 'ZDEN'],
  neutron: ['NPHI', 'NPHIS', 'CNC', 'TNPH'],
  sonic: ['DT', 'DTC', 'AC', 'DTCO'],
  resistivity: ['RT', 'RES', 'ILD', 'LLD', 'RDEP'],
  caliper: ['CALI', 'CAL', 'HCAL'],
  sp: ['SP'],
  pef: ['PEF', 'PE'],
};

/** @returns {?string} curve kind for a mnemonic (base name, ':n' run
 *  suffixes ignored), or null when unknown. */
export function guessCurveKind(mnemonic) {
  const base = String(mnemonic || '').toUpperCase().split(':')[0];
  for (const [kind, names] of Object.entries(KIND_GUESSES)) {
    if (names.includes(base)) return kind;
  }
  return null;
}

/** Metres-per-unit for a depth unit string, or null when unknown. */
export function depthUnitToMetres(unit) {
  const factor = DEPTH_FACTORS[String(unit || '').trim().toUpperCase()];
  return factor === undefined ? null : factor;
}

/** Convert one curve's samples to SI in float64, casting back to f32
 *  per sample (matches converting the golden bits by hand). NaNs pass
 *  through. factor 1 returns the input array unchanged. */
function convertSamples(data, factor) {
  if (factor === 1) return data;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] * factor;
  return out;
}

const F32_EPS = 2 ** -23;

/** Uniform step of a depth vector (metres), or null when irregular —
 *  the depth vector is data, not arithmetic (irregular_20 fixture).
 *  Tolerance: 1% of the step, floored at a few float32 ULPs of the
 *  deepest sample — unit-converted f32 depths jitter by an ULP per
 *  increment (feet_20), while genuinely irregular files are off by
 *  whole fractions of a step. */
export function uniformStepM(depthM) {
  if (depthM.length < 2) return null;
  const first = depthM[1] - depthM[0];
  if (!Number.isFinite(first) || first <= 0) return null;
  const maxAbs = Math.max(Math.abs(depthM[0]), Math.abs(depthM[depthM.length - 1]));
  const tol = Math.max(0.01 * first, 16 * F32_EPS * maxAbs);
  for (let i = 2; i < depthM.length; i++) {
    const d = depthM[i] - depthM[i - 1];
    if (!Number.isFinite(d) || Math.abs(d - first) > tol) return null;
  }
  return first;
}

/**
 * Parsed LAS -> per-curve registry log payloads (geo_wells_logs row +
 * f32 samples), everything in SI. The index (depth) curve is stored as
 * a log row too — for step_m null (irregular) files it IS the depth
 * vector the plan says children resolve against.
 *
 * @param {ReturnType<import('./lasParse').parseLas>} parsed
 * @param {{sourceFile?: string}} [opts]
 * @returns {{
 *   depthUnit: string, depthFactor: number, stepM: ?number,
 *   startMdM: ?number, stopMdM: ?number,
 *   logs: Array<{
 *     mnemonic: string, description: string, unit: string,
 *     sourceUnit: string, converted: boolean, kind: ?string,
 *     data: Float32Array, nSamples: number, nullCount: number,
 *     startMdM: ?number, stopMdM: ?number, stepM: ?number,
 *     provenance: Object,
 *   }>,
 * }}
 */
export function prepareLogs(parsed, opts = {}) {
  if (!parsed.curves.length) throw new Error('The parsed LAS file has no curves.');
  const depthCurve = parsed.curves[0];
  const depthFactor = depthUnitToMetres(depthCurve.unit);
  if (depthFactor === null) {
    throw new Error(`Depth unit "${depthCurve.unit}" is not recognised — expected metres or feet. `
      + 'Check the ~Curve section before importing.');
  }
  const depthM = convertSamples(depthCurve.data, depthFactor);
  const stepM = uniformStepM(depthM);
  const startMdM = Number.isFinite(depthM[0]) ? depthM[0] : null;
  const stopMdM = Number.isFinite(depthM[depthM.length - 1]) ? depthM[depthM.length - 1] : null;

  const baseProvenance = {
    las_version: parsed.version,
    wrap: parsed.wrap,
    null_value: parsed.nullValue,
    source_file: opts.sourceFile || null,
  };

  const logs = parsed.curves.map((curve, i) => {
    const isDepth = i === 0;
    const conv = isDepth
      ? (depthFactor === 1 ? null : { unit: 'M', factor: depthFactor })
      : (CURVE_CONVERSIONS[String(curve.unit || '').trim().toUpperCase()] || null);
    const data = conv ? convertSamples(curve.data, conv.factor) : curve.data;
    return {
      mnemonic: curve.mnemonic,
      description: curve.descr,
      unit: conv ? conv.unit : curve.unit,
      sourceUnit: curve.unit,
      converted: !!conv,
      kind: isDepth ? 'depth' : guessCurveKind(curve.mnemonic),
      data,
      nSamples: curve.nSamples,
      nullCount: curve.nullCount,
      startMdM,
      stopMdM,
      stepM,
      provenance: conv
        ? { ...baseProvenance, unit_from: curve.unit, unit_to: conv.unit, factor: conv.factor }
        : { ...baseProvenance },
    };
  });

  return { depthUnit: depthCurve.unit, depthFactor, stepM, startMdM, stopMdM, logs };
}

/**
 * Well-header suggestion from the LAS ~Well/~Parameter sections for the
 * import dialog (user confirms; surface X/Y are NOT in most LAS files
 * and stay manual). KB and TD convert to metres when their units say
 * feet; unknown units pass through with a note instead of a guess.
 */
export function suggestWellHeader(parsed) {
  const wellStr = (mnem) => {
    const item = parsed.well[mnem];
    if (!item) return null;
    const s = String(item.value).trim();
    return s === '' ? null : s;
  };
  const metres = (item) => {
    if (!item || typeof item.value !== 'number') return null;
    const f = depthUnitToMetres(item.unit || 'M');
    return f === null ? null : item.value * f;
  };
  const kb = parsed.params.KB || parsed.params.EKB || parsed.well.EKB || null;
  const stop = metres(parsed.well.STOP);
  return {
    name: wellStr('WELL'),
    uwi: wellStr('UWI') || wellStr('API'),
    kbM: metres(kb),
    tdMdM: stop,
    unitsNote: `LAS depth unit ${parsed.depthUnit || '?'} -> m (SI internal)`,
  };
}
