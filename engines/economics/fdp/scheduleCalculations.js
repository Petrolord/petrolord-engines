/**
 * FDP schedule: a real critical path method, project duration and milestones.
 *
 * EC6-0. This module was vendored verbatim from the Suite in the EC0
 * extraction wave and carried a `calculateCPM` that ran no critical path
 * method at all: it passed the caller's own `float` back out and called
 * every activity with a zero or absent float critical. On the textbook
 * network (A3 then B4, D5, F2, with C2 and E3 in parallel) it marked all
 * six activities critical at float 0, when the method puts the critical
 * path at A-B-D-F, 14 days, with four days of float on C and E. The UI
 * promised "critical path" on the Schedule header and in the Guided step.
 *
 * It now runs the method: a forward pass for the early dates, a backward
 * pass for the late dates, float = LS - ES, critical at zero float.
 * Dependencies are finish-to-start predecessor ids, which is what the
 * schedule form now collects. The independent oracle
 * (tools/validation/economics/oracle_fdp.py) computes the same table two
 * other ways, by Kahn order and by memoised recursion, and the gate in
 * __tests__/economics.fdp.test.js pins this engine against that reference
 * for every golden schedule.
 *
 * Dates. `calculateProjectDuration` reads the calendar span the user typed,
 * which is a different question from the network's duration: it answers
 * "how long is the window", `calculateCPM` answers "how long must it take".
 * Date-only strings are parsed as LOCAL midnight, because `new Date('2026-03-01')`
 * is UTC midnight and rendered locally that is 2026-02-28 in Los Angeles: the
 * old code shifted a schedule by a day for every user west of Greenwich, and
 * counted one day fewer across a window than the same window counted in UTC.
 */

import { FdpInputError } from './inputError.js';

const MS_PER_DAY = 86400000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A schedule date as a local Date, or null when it is absent or unreadable.
 * A date-only string is local midnight; anything else goes through Date,
 * which reads an offset when the string carries one.
 */
export const parseScheduleDate = (value) => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const s = value.trim();
  if (DATE_ONLY.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    const local = new Date(y, m - 1, d);
    return Number.isNaN(local.getTime()) ? null : local;
  }
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/** A local date as whole calendar days since the epoch, so a span counts days. */
const calendarDay = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / MS_PER_DAY;

/**
 * The calendar span of the activities the user has dated, in days.
 *
 * Counted in whole calendar days, not in milliseconds. The old code
 * subtracted two timestamps and divided: across a daylight-saving change
 * that span is off by an hour, so Oct 30 to Nov 3 counted 4 days in UTC
 * and 3 in Los Angeles, and the same schedule reported a different length
 * to two people looking at it.
 *
 * Returns null, not NaN, when an activity carries no readable start or end
 * date. The old code returned NaN there and the app printed it; the
 * example schedule has no startDate or endDate at all, so the number on
 * that screen was NaN for every example plan.
 *
 * EC6-4. An empty plan returns null too. It used to return 0, which reads
 * as a window of zero days; a plan with no activities has no window at
 * all, the same unknown as a plan whose activities carry no dates.
 *
 * @param {object[]} activities
 * @returns {number|null} whole days from the earliest start to the latest end
 */
export const calculateProjectDuration = (activities) => {
  if (!activities || activities.length === 0) return null;
  const starts = [];
  const ends = [];
  for (const a of activities) {
    const s = parseScheduleDate(a.startDate);
    const e = parseScheduleDate(a.endDate);
    if (!s || !e) return null;
    starts.push(calendarDay(s));
    ends.push(calendarDay(e));
  }
  return Math.max(...ends) - Math.min(...starts);
};

const activityDuration = (a) => {
  if (a.duration === undefined || a.duration === null || a.duration === '') return 0;
  const n = Number(a.duration);
  if (!Number.isFinite(n)) {
    throw new FdpInputError(`activity ${a.id}: duration is not a number: ${String(a.duration)}`);
  }
  if (n < 0) throw new FdpInputError(`activity ${a.id}: duration may not be negative: ${n}`);
  return n;
};

/**
 * The critical path method over a finish-to-start network.
 *
 * Each activity carries an `id`, a `duration` in days and `dependencies`,
 * the ids of the activities that must finish before it starts. An activity
 * with no dependencies starts at day 0 of the network.
 *
 * Refuses, rather than guessing: a duplicate id, a dependency on an id that
 * is not in the list, a cycle, a negative or unreadable duration.
 *
 * @param {object[]} activities
 * @returns {object[]} each activity with es, ef, ls, lf, float and isCritical
 */
export const calculateCPM = (activities) => {
  if (!activities || activities.length === 0) return [];

  const ids = [];
  const duration = new Map();
  const preds = new Map();
  for (const a of activities) {
    if (a.id === undefined || a.id === null || a.id === '') {
      throw new FdpInputError('every activity needs an id');
    }
    if (duration.has(a.id)) throw new FdpInputError(`duplicate activity id: ${a.id}`);
    ids.push(a.id);
    duration.set(a.id, activityDuration(a));
    preds.set(a.id, Array.isArray(a.dependencies) ? [...a.dependencies] : []);
  }
  const succs = new Map(ids.map((id) => [id, []]));
  for (const id of ids) {
    for (const p of preds.get(id)) {
      if (!succs.has(p)) {
        throw new FdpInputError(`activity ${id} depends on ${p}, which is not in the schedule`);
      }
      succs.get(p).push(id);
    }
  }

  // Forward pass in topological order. A short order means a cycle.
  const indegree = new Map(ids.map((id) => [id, preds.get(id).length]));
  const order = ids.filter((id) => indegree.get(id) === 0);
  for (let k = 0; k < order.length; k += 1) {
    for (const s of succs.get(order[k])) {
      indegree.set(s, indegree.get(s) - 1);
      if (indegree.get(s) === 0) order.push(s);
    }
  }
  if (order.length !== ids.length) {
    const inCycle = ids.filter((id) => !order.includes(id));
    throw new FdpInputError(`the schedule has a dependency cycle through: ${inCycle.join(', ')}`);
  }

  const es = new Map();
  const ef = new Map();
  for (const id of order) {
    const start = preds.get(id).reduce((m, p) => Math.max(m, ef.get(p)), 0);
    es.set(id, start);
    ef.set(id, start + duration.get(id));
  }
  const projectDurationDays = ids.reduce((m, id) => Math.max(m, ef.get(id)), 0);

  // Backward pass over the same order, reversed.
  const lf = new Map();
  const ls = new Map();
  for (let k = order.length - 1; k >= 0; k -= 1) {
    const id = order[k];
    const finish = succs.get(id).reduce((m, s) => Math.min(m, ls.get(s)), projectDurationDays);
    lf.set(id, finish);
    ls.set(id, finish - duration.get(id));
  }

  return activities.map((a) => {
    const float = ls.get(a.id) - es.get(a.id);
    return {
      ...a,
      es: es.get(a.id),
      ef: ef.get(a.id),
      ls: ls.get(a.id),
      lf: lf.get(a.id),
      float,
      isCritical: Math.abs(float) < 1e-9,
    };
  });
};

/**
 * The network's own duration in days: the longest path through it.
 * This is the number the Schedule tab should show beside the calendar span.
 *
 * @param {object[]} activities
 * @returns {number}
 */
export const calculateNetworkDuration = (activities) => {
  const table = calculateCPM(activities);
  return table.reduce((m, a) => Math.max(m, a.ef), 0);
};

/**
 * Every start-to-finish chain of zero-float activities, in the order the
 * activities were given. A tie returns more than one path, which is the
 * honest answer: a network can have two critical paths.
 *
 * @param {object[]} activities
 * @returns {Array<Array<string>>}
 */
export const criticalPaths = (activities) => {
  const table = calculateCPM(activities);
  const byId = new Map(table.map((a) => [a.id, a]));
  const critical = table.filter((a) => a.isCritical).map((a) => a.id);
  const isCritical = new Set(critical);
  const succs = new Map(table.map((a) => [a.id, []]));
  for (const a of table) {
    for (const p of (Array.isArray(a.dependencies) ? a.dependencies : [])) succs.get(p).push(a.id);
  }
  const paths = [];
  const walk = (id, path) => {
    const next = succs.get(id)
      .filter((s) => isCritical.has(s) && Math.abs(byId.get(s).es - byId.get(id).ef) < 1e-9);
    if (next.length === 0) {
      paths.push(path);
      return;
    }
    for (const s of next) walk(s, [...path, s]);
  };
  for (const id of critical) {
    const deps = Array.isArray(byId.get(id).dependencies) ? byId.get(id).dependencies : [];
    const startsAPath = !deps.some((p) => isCritical.has(p)
      && Math.abs(byId.get(p).ef - byId.get(id).es) < 1e-9);
    if (startsAPath) walk(id, [id]);
  }
  return paths;
};

export const calculateResourceRequirements = (activities) => {
  // Aggregate resources by time period (e.g. monthly)
  const resourceProfile = {};

  activities.forEach(activity => {
    if (!activity.resources) return;

    // Simplified: just summing total required, not time-distributed
    const { crew, cost } = activity.resources;
    // ... implementation would distribute over activity duration
  });

  return resourceProfile;
};

export const identifyMilestones = (activities) => {
  return activities.filter(a => a.type === 'Milestone' || a.duration === 0);
};
