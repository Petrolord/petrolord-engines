/**
 * Flow and shut-in summary of a test: one row per period of the step-rate
 * history with its start, duration and the volume produced (or injected)
 * in it. Times in hours, rates per day (STB/D or Mscf/D), so the volume of
 * a period is q * duration / 24 in the rate's own volume unit (STB, Mscf).
 *
 * The last period of a rate history has no end of its own. It takes
 * `endTime` when the caller knows it (the end of the gauge record on the
 * same clock); otherwise its duration and volume are NaN, never zero.
 */

import { rateStepsFromHistory, detectFlowPeriods } from './superposition.js';

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

export const HOURS_PER_DAY = 24;

/**
 * @param {{history: Array<{t: number, q: number}>, endTime?: ?number}} a
 *   history: rate q applies from time t (hours) to the next entry;
 *   endTime: end of the last period (hours), when known
 * @returns {{periods: Array<{index: number, type: string, start: number,
 *   end: ?number, duration: number, rate: number, volume: number,
 *   cumulative: number}>, totalVolume: number, flowingHours: number,
 *   shutInHours: number}}
 *   volume is |q| * duration / 24 (zero for a shut-in); cumulative is the
 *   running total of the periods so far, NaN from the first period whose
 *   duration is unknown.
 */
export const summarizeFlowPeriods = ({ history = [], endTime = null } = {}) => {
  const steps = rateStepsFromHistory(history);
  const last = steps[steps.length - 1];
  const end = fin(endTime) && last && endTime > last.start ? endTime : null;
  const raw = detectFlowPeriods(history, { endTime: end });
  let cumulative = 0;
  let flowingHours = 0;
  let shutInHours = 0;
  const periods = raw.map((p, i) => {
    const duration = fin(p.end) ? p.end - p.start : NaN;
    const volume = fin(duration) ? (Math.abs(p.q) * duration) / HOURS_PER_DAY : NaN;
    cumulative = fin(volume) && fin(cumulative) ? cumulative + volume : NaN;
    if (fin(duration)) {
      if (p.type === 'shut-in') shutInHours += duration; else flowingHours += duration;
    }
    return {
      index: i + 1, type: p.type, start: p.start, end: fin(p.end) ? p.end : null,
      duration, rate: p.q, volume, cumulative,
    };
  });
  return { periods, totalVolume: cumulative, flowingHours, shutInHours };
};
