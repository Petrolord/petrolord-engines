/**
 * The Assurance golden runner (AS12). Plain ESM with no Node globals
 * beyond what both jest and a bare `node` child provide, so the jest gate
 * and the time-zone sweep's child processes run exactly the same code.
 *
 * THE CONTRACT a golden file under test-data/assurance/goldens/ meets:
 *
 *   { "module": "<engines/assurance file name without .js>",
 *     "generatedBy": "tools/validation/assurance/oracle_<x>.py",
 *     "cases": [ CASE, ... ] }
 *
 *   CASE is one of
 *     { "id", "fn": "<export>", "args": [...], "expected": <value> }
 *     { "id", "fn": "<export>", "args": [...], "expectedThrows": true }
 *     { "id", "sort": "<export>", "factory": true|false, "factoryArgs": [...],
 *       "rows": [ {id, ...}, ... ], "expectedOrder": ["id", ...] }
 *
 *   Values are JSON with four tagged forms, revived on the way in and
 *   produced on the way out:
 *     {"$date": "YYYY-MM-DD"}  a calendar date at LOCAL midnight (null = Invalid Date)
 *     {"$map": [[k, v], ...]}  a Map
 *     {"$num": "NaN"|"Infinity"|"-Infinity"}
 *     {"$undefined": true}     an explicit undefined argument
 *     {"$localInstant": "YYYY-MM-DDTHH:MM"}  (ASC-0 item 12) the moment at
 *                              that LOCAL wall-clock time, as the ISO
 *                              string PostgREST sends for a timestamptz,
 *                              in UTC: 'YYYY-MM-DDTHH:MM:SS+00:00'. So its
 *                              UTC date differs from its local date by the
 *                              zone, and one expectation (the local date)
 *                              holds in every zone of the sweep. A literal
 *                              '...T23:30:00Z' has a different local date
 *                              per zone and cannot be a golden argument.
 *
 *   A case may carry "knownDefect": "<finding id>" when the engine and the
 *   oracle disagree and tools/validation/assurance/FINDINGS-<x>.md records
 *   the disagreement. "expected" is then the ORACLE's answer and the gate
 *   asserts the engine still differs, so a repair forces the marker out.
 *
 *   After a repair the oracle writes "repaired": "<finding id>" in place of
 *   knownDefect. It is a record, not an instruction: the case is checked
 *   like any other, so the repair cannot silently regress.
 *
 *   PROSE. The keys in PROSE_KEYS carry English for a person to read. An
 *   oracle is not asked to reproduce sentences, so those keys are removed
 *   from both sides before the comparison. What IS checked is that a
 *   refusal ({ ok: false }) carries a non-empty reason. A case may set
 *   "prose": "exact" to compare them verbatim instead.
 *
 *   Numbers compare to 1e-9, absolute or relative, whichever is looser.
 */

export const PROSE_KEYS = Object.freeze(['reason', 'text', 'message']);
const TOL = 1e-9;

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const revive = (v) => {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === 'object') {
    if ('$date' in v) {
      if (v.$date === null) return new Date(NaN);
      const [y, m, d] = v.$date.split('-').map(Number);
      return new Date(y, m - 1, d);
    }
    if ('$map' in v) return new Map(v.$map.map(([k, x]) => [revive(k), revive(x)]));
    if ('$num' in v) return Number(v.$num);
    if ('$undefined' in v) return undefined;
    if ('$localInstant' in v) {
      const [d, t] = v.$localInstant.split('T');
      const [y, m, day] = d.split('-').map(Number);
      const [hh, mm] = t.split(':').map(Number);
      return new Date(y, m - 1, day, hh, mm).toISOString().replace(/\.\d{3}Z$/, '+00:00');
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]));
  }
  return v;
};

export const normalise = (v, { keepProse = false } = {}) => {
  if (v instanceof Date) return { $date: Number.isNaN(v.getTime()) ? null : ymd(v) };
  if (v instanceof Map) return { $map: [...v.entries()].map(([k, x]) => [normalise(k), normalise(x, { keepProse })]) };
  if (v instanceof Set) return [...v].map((x) => normalise(x, { keepProse }));
  if (typeof v === 'number' && !Number.isFinite(v)) return { $num: String(v) };
  if (typeof v === 'function') return '[function]';
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : normalise(x, { keepProse })));
  if (v && typeof v === 'object') {
    const out = {};
    Object.keys(v).sort().forEach((k) => {
      if (v[k] === undefined) return;
      if (!keepProse && PROSE_KEYS.includes(k)) return;
      out[k] = normalise(v[k], { keepProse });
    });
    return out;
  }
  return v;
};

/** Every refusal in a result carries a reason a person can act on. */
export const refusalsExplained = (v) => {
  const bad = [];
  const walk = (x, p) => {
    if (Array.isArray(x)) { x.forEach((y, i) => walk(y, `${p}[${i}]`)); return; }
    if (x && typeof x === 'object' && !(x instanceof Date) && !(x instanceof Map)) {
      if (x.ok === false && !(typeof x.reason === 'string' && x.reason.trim())) bad.push(p || '(root)');
      Object.entries(x).forEach(([k, y]) => walk(y, `${p}.${k}`));
    }
  };
  walk(v, '');
  return bad;
};

export const diff = (actual, expected, p = '') => {
  if (typeof expected === 'number' && typeof actual === 'number') {
    const tol = Math.max(TOL, TOL * Math.abs(expected));
    return Math.abs(actual - expected) <= tol ? [] : [`${p || '(root)'}: ${actual} != ${expected}`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${p || '(root)'}: expected an array, got ${JSON.stringify(actual)}`];
    if (actual.length !== expected.length) {
      return [`${p || '(root)'}: length ${actual.length} != ${expected.length}`];
    }
    return expected.flatMap((e, i) => diff(actual[i], e, `${p}[${i}]`));
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
      return [`${p || '(root)'}: expected an object, got ${JSON.stringify(actual)}`];
    }
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].flatMap((k) => {
      if (!(k in expected)) return [`${p}.${k}: unexpected key (engine returned ${JSON.stringify(actual[k])})`];
      if (!(k in actual)) return [`${p}.${k}: missing (oracle expects ${JSON.stringify(expected[k])})`];
      return diff(actual[k], expected[k], `${p}.${k}`);
    });
  }
  return actual === expected ? [] : [`${p || '(root)'}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`];
};

/** Run one case against a loaded module. Returns { actual, problems }. */
export const runCase = (mod, c) => {
  if (c.sort) {
    const cmp = c.factory ? mod[c.sort](...revive(c.factoryArgs || [])) : mod[c.sort];
    if (typeof cmp !== 'function') return { actual: null, problems: [`${c.sort} is not a comparator`] };
    const order = revive(c.rows).slice().sort(cmp).map((r) => r.id);
    return { actual: order, problems: diff(order, c.expectedOrder) };
  }
  const fn = mod[c.fn];
  if (typeof fn !== 'function') return { actual: null, problems: [`${c.fn} is not an export of ${c.module || 'the module'}`] };
  let raw;
  try {
    raw = fn(...revive(c.args || []));
  } catch (e) {
    if (c.expectedThrows) return { actual: { threw: e.message }, problems: [] };
    return { actual: { threw: e.message }, problems: [`threw: ${e.message}`] };
  }
  if (c.expectedThrows) return { actual: normalise(raw), problems: ['expected a throw, got a value'] };
  const exact = c.prose === 'exact';
  const actual = normalise(raw, { keepProse: exact });
  const expected = exact ? c.expected : normalise(revive(c.expected));
  const problems = diff(actual, expected);
  refusalsExplained(raw).forEach((p) => problems.push(`${p}: a refusal with no reason`));
  return { actual, problems };
};
