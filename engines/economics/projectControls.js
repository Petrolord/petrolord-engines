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
 * SCOPE NOTE (owner decision, EC6): planned value here is still the whole
 * budget of every task in scope, not the budget time-phased to a date. So
 * the schedule index is earned value over budget at completion, which is a
 * progress ratio, not a schedule variance: it cannot tell early from late.
 * That is stated in `spiBasis` and on the app's card, and a time-phased
 * rebuild was left out of this wave. EC6 grades earned value on the AFE
 * Cost Control engine, which is time-phased against an as-of date.
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

/**
 * Earned value for a list of tasks.
 *
 * @param {object[]} tasks each with planned_cost, actual_cost and percent_complete
 * @returns {{plannedValue: number, earnedValue: number, actualCost: number,
 *   pv: number, ev: number, ac: number, cpi: number|null, spi: number|null,
 *   cv: number, sv: number, percentComplete: number|null, taskCount: number,
 *   costed: boolean, spiBasis: string}}
 */
export function calculateEVM(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  let plannedValue = 0;
  let earnedValue = 0;
  let actualCost = 0;

  list.forEach((task, i) => {
    const label = taskLabel(task, i);
    const plannedCost = readCost(task.planned_cost, 'planned cost', label);
    const percentComplete = readPercent(task.percent_complete, label);
    const taskActualCost = readCost(task.actual_cost, 'actual cost', label);

    plannedValue += plannedCost;
    earnedValue += plannedCost * (percentComplete / 100);
    actualCost += taskActualCost;
  });

  // An index is a ratio. With no denominator there is no ratio, and saying
  // so is the only honest answer: 1.00 reads as "on plan" and it is not.
  const cpi = actualCost === 0 ? null : earnedValue / actualCost;
  const spi = plannedValue === 0 ? null : earnedValue / plannedValue;

  return {
    plannedValue,
    earnedValue,
    actualCost,
    pv: plannedValue,
    ev: earnedValue,
    ac: actualCost,
    cpi,
    spi,
    cv: earnedValue - actualCost,
    sv: earnedValue - plannedValue,
    percentComplete: plannedValue === 0 ? null : (earnedValue / plannedValue) * 100,
    taskCount: list.length,
    costed: plannedValue > 0,
    spiBasis: 'earned value over budget at completion, not time-phased',
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

/** Schedule performance index on the basis stated in calculateEVM, or null. */
export function calculateSPI(earnedValue, plannedValue) {
  const ev = Number(earnedValue);
  const pv = Number(plannedValue);
  if (!Number.isFinite(ev) || !Number.isFinite(pv) || pv === 0) return null;
  return ev / pv;
}
