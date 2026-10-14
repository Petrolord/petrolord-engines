/**
 * Rate-history superposition utilities.
 *
 * Constant-C wellbore storage keeps the whole well/reservoir system linear,
 * so variable-rate responses are exact superpositions of the constant-rate
 * solution: dp(t) = (dpPerPd / qRef) * sum_j (q_j - q_{j-1}) pwD(t - t_{j-1}).
 *
 * Also home to the buildup time transforms (Horner time, Agarwal equivalent
 * time) and flow-period detection from a step-rate history.
 */

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** Horner time ratio (tp + dt) / dt. */
export const hornerTime = (tp, dt) => {
  if (!(dt > 0)) return NaN;
  return (num(tp) + dt) / dt;
};

/** Agarwal equivalent time tp dt / (tp + dt); collapses buildup onto drawdown. */
export const agarwalEquivalentTime = (tp, dt) => {
  const tpv = num(tp);
  if (!(dt > 0) || !(tpv > 0)) return NaN;
  return (tpv * dt) / (tpv + dt);
};

/**
 * Normalize a rate history into clean steps.
 * Input: [{ t, q }] where q applies from time t (hours) until the next entry.
 * Output: sorted steps [{ start, q }] with zero-duration and repeated-rate
 * entries collapsed.
 */
export const rateStepsFromHistory = (history = []) => {
  const cleaned = history
    .map((r) => ({ start: num(r.t, NaN), q: num(r.q, NaN) }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.q) && r.start >= 0)
    .sort((a, b) => a.start - b.start);
  const steps = [];
  for (const row of cleaned) {
    const last = steps[steps.length - 1];
    if (last && row.start === last.start) {
      last.q = row.q; // later entry at the same time wins
    } else if (!last || row.q !== last.q) {
      steps.push({ ...row });
    }
  }
  return steps;
};

/**
 * Identify flow periods from a step-rate history.
 * @returns [{ start, end, q, type: 'flow' | 'shut-in' | 'injection' }],
 *   end = null for the open-ended final period.
 */
export const detectFlowPeriods = (history = [], { endTime = null } = {}) => {
  const steps = rateStepsFromHistory(history);
  return steps.map((step, i) => {
    const next = steps[i + 1];
    let type = 'flow';
    if (step.q === 0) type = 'shut-in';
    else if (step.q < 0) type = 'injection';
    return {
      start: step.start,
      end: next ? next.start : endTime,
      q: step.q,
      type,
    };
  });
};

/**
 * Producing time tp for buildup analysis of a variable-rate drawdown:
 * the Horner approximation tp = cumulative production / final flowing rate.
 * @param {Array<{start:number, q:number}>} steps from rateStepsFromHistory
 * @param {number} shutInTime hours at which the well was shut in
 */
export const equivalentProducingTime = (steps, shutInTime) => {
  const tEnd = num(shutInTime, NaN);
  if (!Number.isFinite(tEnd) || !steps.length) return NaN;
  let cumulative = 0; // rate-hours
  let lastRate = 0;
  for (let i = 0; i < steps.length; i += 1) {
    const start = steps[i].start;
    if (start >= tEnd) break;
    const end = Math.min(steps[i + 1]?.start ?? tEnd, tEnd);
    cumulative += steps[i].q * Math.max(end - start, 0);
    if (steps[i].q !== 0) lastRate = steps[i].q;
  }
  if (!(lastRate !== 0)) return NaN;
  return cumulative / lastRate;
};

/**
 * Superpose a constant-rate dimensionless response over a step-rate history.
 *
 * @param {(tHours: number) => number} pwdOfHours dimensionless pwD evaluated
 *   at elapsed hours (the caller bakes in tdPerHour)
 * @param {Array<{start:number, q:number}>} steps rate steps (absolute rates)
 * @param {number} t evaluation time in hours (absolute)
 * @param {number} dpPerPdPerUnitRate pressure drop per unit pD per unit rate,
 *   i.e. 141.2 B mu / (k h)
 * @returns total pressure drop pi - p(t) in psi
 */
export const superposeDeltaP = ({ pwdOfHours, steps, t, dpPerPdPerUnitRate }) => {
  let dp = 0;
  let prevQ = 0;
  for (const step of steps) {
    if (step.start >= t) break;
    const dq = step.q - prevQ;
    if (dq !== 0) dp += dq * pwdOfHours(t - step.start);
    prevQ = step.q;
  }
  return dpPerPdPerUnitRate * dp;
};

// ---------------------------------------------------------------------------
// Buildup after a rate history (2026-10-14, Well Test video round).
//
// A buildup that follows a clean-up or a multi-rate test is not a buildup
// after one rate for tp hours. With the rate history the shut-in response is
// the exact superposition of every rate change, and its straight line and
// its diagnostic time come from the same weights:
//
//   superposition time   X(dt)  = sum_j w_j log10(ts + dt - t_(j-1)) - log10(dt)
//   equivalent time      ln te  = ln dt - sum_j w_j ln((ts + dt - t_(j-1)) / (ts - t_(j-1)))
//   weights              w_j    = (q_j - q_(j-1)) / q_n
//
// over the steps j that start before the shut-in ts, q_n the rate flowing
// just before it (sum_j w_j = 1). One rate step gives Horner's ratio and
// Agarwal's equivalent time exactly (Agarwal 1980, SPE 9289; Earlougher
// 1977, SPE Monograph 5, ch. 5). pws plots as a straight line in X with
// slope -m and p* at X = 0, and log-log plots on te, as for one rate.

/**
 * The flowing steps that precede a shut-in, with their superposition weights.
 * @param {Array<{start:number, q:number}>} steps from rateStepsFromHistory
 * @param {number} shutInTime hours on the same clock as the steps
 * @returns {{ ok: true, qn: number, terms: Array<{start:number, w:number}> } | { ok: false, reason: string }}
 */
export const buildupSuperpositionTerms = (steps, shutInTime) => {
  const ts = num(shutInTime, NaN);
  if (!Number.isFinite(ts) || !Array.isArray(steps) || !steps.length) {
    return { ok: false, reason: 'A rate history and a shut-in time are needed.' };
  }
  const before = steps.filter((s) => s.start < ts);
  if (!before.length) return { ok: false, reason: 'No rate step starts before the shut-in.' };
  const qn = before[before.length - 1].q;
  if (!(qn !== 0) || !Number.isFinite(qn)) {
    return { ok: false, reason: 'The well is not flowing just before the shut-in, so there is no buildup to analyse.' };
  }
  const terms = [];
  let prevQ = 0;
  for (const s of before) {
    const dq = s.q - prevQ;
    prevQ = s.q;
    if (dq !== 0) terms.push({ start: s.start, w: dq / qn });
  }
  return { ok: true, qn, terms };
};

/** Buildup superposition time X(dt), log10 units; one rate gives log10 of Horner's ratio. */
export const buildupSuperpositionTime = (steps, shutInTime, dt) => {
  if (!(dt > 0)) return NaN;
  const sup = buildupSuperpositionTerms(steps, shutInTime);
  if (!sup.ok) return NaN;
  const ts = num(shutInTime);
  let x = -Math.log10(dt);
  for (const { start, w } of sup.terms) x += w * Math.log10(ts + dt - start);
  return x;
};

/** Equivalent time of a buildup after a rate history; one rate gives Agarwal's tp dt / (tp + dt). */
export const superpositionEquivalentTime = (steps, shutInTime, dt) => {
  if (!(dt > 0)) return NaN;
  const sup = buildupSuperpositionTerms(steps, shutInTime);
  if (!sup.ok) return NaN;
  const ts = num(shutInTime);
  let lnTe = Math.log(dt);
  for (const { start, w } of sup.terms) {
    const before = ts - start;
    if (!(before > 0)) return NaN;
    lnTe -= w * Math.log((before + dt) / before);
  }
  return Math.exp(lnTe);
};

/**
 * The shut-in time dt at which the superposition time equals X (bisection;
 * X falls monotonically from +inf at dt -> 0 towards 0 at dt -> inf).
 */
export const shutInTimeAtSuperpositionTime = (steps, shutInTime, x) => {
  if (!Number.isFinite(x) || !(x > 0)) return NaN;
  const f = (dt) => buildupSuperpositionTime(steps, shutInTime, dt) - x;
  let lo = 1e-9;
  let hi = 1e9;
  if (!(f(lo) > 0) || !(f(hi) < 0)) return NaN;
  for (let i = 0; i < 200; i += 1) {
    const mid = Math.sqrt(lo * hi);
    if (f(mid) > 0) lo = mid; else hi = mid;
    if (hi / lo < 1 + 1e-13) break;
  }
  return Math.sqrt(lo * hi);
};
