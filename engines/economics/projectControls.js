/**
 * Project controls for Project Management Pro: earned value, Gantt rows,
 * the cost and schedule indices.
 *
 * EC6-0. Vendored from the Suite's src/utils/projectManagementCalculations.js
 * in the EC0 extraction wave and repaired here. What it used to do:
 *
 *   - every figure came back as a string from toFixed(2), so the callers
 *     compared them as strings ("10.00" > "9.00" is false) and one card
 *     read `parseFloat(kpis.percentComplete || 1)`, which turns the string
 *     "0.00" into 0 and printed "Behind Schedule" on a project with no
 *     costs at all;
 *   - percent complete was the string "NaN" whenever planned value was
 *     zero, which is every project in the app, because no screen has ever
 *     written a task cost;
 *   - a cost index of 1.00 was invented whenever actual cost was zero and
 *     earned value was not, and printed as "Under Budget";
 *   - `baselineBudget` was accepted and never read;
 *   - anything that was not already a number was read as zero, so a cost
 *     pasted as "$1,200" counted as nothing, and a negative planned cost
 *     or a percent complete of 150 was taken as typed.
 *
 * Figures are now numbers. An index that is not defined comes back null,
 * for the caller to label, rather than as an invented 1. Inputs that cannot
 * be read are refused by task name.
 *
 * EC6-1: planned value is now TIME-PHASED. It used to be the whole budget
 * of every task in scope, so "SPI" was earned value over budget at
 * completion: a project half finished on schedule and a project half
 * finished a year late reported the same 0.50, and the index could never
 * read above 1. Planned value is now each task's own budget spread evenly
 * across its planned window and cut off at the as-of date, which is the
 * definition the AFE engine already follows, so the two apps mean the same
 * thing by SPI. The completion ratio the old number really was is still
 * reported, under its own name.
 *
 * `asOf` is a parameter, not the clock: a figure that changes overnight
 * without anyone touching the project is not a measurement (the same rule
 * EC5-0 applied to afe.js).
 */

import { parseScheduleDate } from './fdp/scheduleCalculations.js';

export class ProjectControlsInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProjectControlsInputError';
  }
}

const taskLabel = (task, i) => task?.name || task?.id || `task ${i + 1}`;

/** A money field: absent is zero, unreadable or negative is refused. */
const readCost = (value, field, label) => {
  if (value === undefined || value === null || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) {
    throw new ProjectControlsInputError(`${label}: ${field} is not a number: ${String(value)}`);
  }
  if (n < 0) throw new ProjectControlsInputError(`${label}: ${field} may not be negative: ${n}`);
  return n;
};

const readPercent = (value, label) => {
  if (value === undefined || value === null || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) {
    throw new ProjectControlsInputError(`${label}: percent complete is not a number: ${String(value)}`);
  }
  if (n < 0 || n > 100) {
    throw new ProjectControlsInputError(`${label}: percent complete must be between 0 and 100, not ${n}`);
  }
  return n;
};

/** A local date as whole calendar days since the epoch. */
const calendarDay = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000;

/** The fraction of a task's planned window that has elapsed by `asOf`. */
const elapsedFraction = (task, asOfDay, label) => {
  const start = parseScheduleDate(task.planned_start_date);
  const end = parseScheduleDate(task.planned_end_date);
  if (!start || !end) return null;
  const startDay = calendarDay(start);
  const endDay = calendarDay(end);
  if (endDay < startDay) {
    throw new ProjectControlsInputError(
      `${label}: the planned end date is before the planned start date`,
    );
  }
  if (asOfDay <= startDay) return 0;
  if (asOfDay >= endDay) return 1;
  // A same-day task is either not started or finished; the branches above
  // have already covered both, so the divisor here is never zero.
  return (asOfDay - startDay) / (endDay - startDay);
};

/**
 * Earned value for a list of tasks, as of a stated date.
 *
 * @param {object[]} tasks planned_cost, actual_cost, percent_complete and
 *   the planned start and end dates
 * @param {object} [options]
 * @param {Date|string} [options.asOf] the date planned value is measured to.
 *   Defaults to today, which is the only thing a dashboard can mean, but
 *   pass it to get a figure that does not move overnight.
 * @returns {object} see the keys below
 */
export function calculateEVM(tasks, { asOf = new Date() } = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const asOfDate = parseScheduleDate(asOf);
  if (!asOfDate) throw new ProjectControlsInputError(`asOf is not a valid date: ${String(asOf)}`);
  const asOfDay = calendarDay(asOfDate);

  let budgetAtCompletion = 0;
  let earnedValue = 0;
  let actualCost = 0;
  let plannedValue = 0;
  let undatedCostedTasks = 0;

  list.forEach((task, i) => {
    const label = taskLabel(task, i);
    const plannedCost = readCost(task.planned_cost, 'planned cost', label);
    const percentComplete = readPercent(task.percent_complete, label);
    const taskActualCost = readCost(task.actual_cost, 'actual cost', label);

    budgetAtCompletion += plannedCost;
    earnedValue += plannedCost * (percentComplete / 100);
    actualCost += taskActualCost;

    if (plannedCost > 0) {
      const fraction = elapsedFraction(task, asOfDay, label);
      if (fraction === null) undatedCostedTasks += 1;
      else plannedValue += plannedCost * fraction;
    }
  });

  // An index is a ratio. With no denominator there is no ratio, and saying
  // so is the only honest answer: 1.00 reads as "on plan" and it is not.
  const cpi = actualCost === 0 ? null : earnedValue / actualCost;
  // A schedule index needs a planned value every costed task contributed to.
  // With a costed task nobody has dated there is no such number, and the
  // completion ratio below is what the app should show instead.
  const timePhased = budgetAtCompletion > 0 && undatedCostedTasks === 0;
  const spi = timePhased && plannedValue > 0 ? earnedValue / plannedValue : null;

  return {
    plannedValue: timePhased ? plannedValue : null,
    budgetAtCompletion,
    earnedValue,
    actualCost,
    pv: timePhased ? plannedValue : null,
    ev: earnedValue,
    ac: actualCost,
    bac: budgetAtCompletion,
    cpi,
    spi,
    cv: earnedValue - actualCost,
    sv: timePhased ? earnedValue - plannedValue : null,
    completionRatio: budgetAtCompletion === 0 ? null : earnedValue / budgetAtCompletion,
    percentComplete: budgetAtCompletion === 0 ? null : (earnedValue / budgetAtCompletion) * 100,
    taskCount: list.length,
    costed: budgetAtCompletion > 0,
    undatedCostedTasks,
    asOf: asOfDate.toISOString().slice(0, 10),
    spiBasis: timePhased
      ? 'planned value time-phased to the as-of date'
      : (budgetAtCompletion === 0
        ? 'no costed task, so there is no planned value'
        : `${undatedCostedTasks} costed task${undatedCostedTasks === 1 ? ' carries' : 's carry'} no planned dates, so planned value cannot be time-phased`),
  };
}

/**
 * Gantt rows.
 *
 * Date-only strings are parsed as LOCAL midnight. `new Date('2026-03-01')`
 * is UTC midnight, and a chart that renders it locally drew it as
 * 2026-02-28 for every user west of Greenwich: a task moved a day by being
 * looked at from Lagos or Los Angeles. An unreadable or absent date comes
 * back null rather than as an Invalid Date.
 */
export function formatTasksForGantt(tasks, project) {
  const ganttTasks = (tasks || []).map(task => ({
    id: task.id,
    name: task.name,
    start: parseScheduleDate(task.planned_start_date),
    end: parseScheduleDate(task.planned_end_date),
    progress: task.percent_complete || 0,
    type: task.type === 'milestone' ? 'milestone' : 'task',
    project: project?.name,
    isDisabled: false,
    styles: { progressColor: '#84cc16', progressSelectedColor: '#65a30d' },
    owner: task.owner,
    status: task.status,
    task_category: task.task_category,
  }));

  ganttTasks.forEach(gTask => {
    const originalTask = (tasks || []).find(t => t.id === gTask.id);
    if (originalTask?.predecessors?.length > 0) {
      gTask.dependencies = originalTask.predecessors;
    }
  });

  return ganttTasks;
}

/** Cost performance index, or null when there is no actual cost to divide by. */
export function calculateCPI(earnedValue, actualCost) {
  const ev = Number(earnedValue);
  const ac = Number(actualCost);
  if (!Number.isFinite(ev) || !Number.isFinite(ac) || ac === 0) return null;
  return ev / ac;
}

/** Schedule performance index: earned value over TIME-PHASED planned value. */
export function calculateSPI(earnedValue, plannedValue) {
  const ev = Number(earnedValue);
  const pv = Number(plannedValue);
  if (!Number.isFinite(ev) || !Number.isFinite(pv) || pv === 0) return null;
  return ev / pv;
}
