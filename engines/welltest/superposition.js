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
