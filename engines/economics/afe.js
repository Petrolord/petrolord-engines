/**
 * AFE cost control: the joint-venture partner split, the earned-value
 * metrics and the S-curve (Economics E4), extracted VERBATIM from the Suite
 * in the EC0 Economics extraction wave (2026-09-08).
 *
 * WHAT MOVED AND FROM WHERE.
 *   calculatePartnerCosts          src/utils/afeServices.js, the one pure
 *                                  function in that file. Its siblings
 *                                  generateAFESummaryPDF, generateBillingStatement
 *                                  and exportToExcel STAY IN THE SUITE: they
 *                                  depend on jspdf, jspdf-autotable and xlsx,
 *                                  which are browser dependencies.
 *   calculateMetrics               src/utils/costControlCalculations.js, whole
 *   calculateTimeProgress (private) file. The only edit is the import:
 *   generateSCurveData             'date-fns' became '../../lib/dates/dates.js',
 *                                  the vendored subset with the same semantics.
 *
 * Function bodies were byte for byte the Suite's until the EC5-0 repair
 * (owner decision 2026-09-14). calculateMetrics and generateSCurveData now
 * take an `asOf` date (a Date or an ISO date string) as their last argument
 * and read the clock ONLY as that argument's default (`asOf = new Date()`).
 * Pass asOf and the output is reproducible: the schedule index and the
 * actual-to-date cut no longer move with the calendar. The same repair
 * bounds the S-curve to the AFE window (it used to walk on to the current
 * month), reports SPI as null where planned value is zero (it was Infinity
 * or NaN before the start date), gives both functions ONE estimate-at-
 * completion rule (itemForecast), refuses negative progress (AfeInputError)
 * and flags a negative working interest as invalid. FINDINGS-fdp.md, section
 * "EC5-0 repair", has the before and after.
 *
 * Money is whatever unit the caller supplies (the AFE app uses its own
 * currency field); percentages are 0 to 100.
 */
import { differenceInDays, isValid, parseISO } from '../../lib/dates/dates.js';

// --- Input errors ---

/**
 * Thrown for an input the AFE engine refuses rather than computes on: an
 * invalid `asOf` date, or a cost item with negative progress.
 */
export class AfeInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AfeInputError';
  }
}

/** `asOf` as a Date: a Date is used as is, an ISO string goes through parseISO. */
const resolveAsOf = (asOf) => {
  let d = null;
  if (asOf instanceof Date) d = asOf;
  else if (typeof asOf === 'string') d = parseISO(asOf);
  if (!d || !isValid(d)) throw new AfeInputError('asOf is not a valid date');
  return d;
};

// --- Partner Management Services ---

/**
 * Split a cost across joint-venture partners by working interest.
 *
 * The operator carries whatever the partners do not, so the operator share is
 * 100 percent less the sum of the partner interests.
 *
 * Economics E4 added `valid` and `note`. Partner interests are typed in one
 * at a time and nothing in the data model forces them to add up: a set
 * summing to more than 100 gives the operator a NEGATIVE share, and one
 * summing to less leaves the operator carrying a balance that may simply be a
 * partner nobody entered. Either way the allocation is still returned, so the
 * numbers are visible, but it is flagged rather than billed out quietly.
 *
 * EC5-0 added the same treatment for a NEGATIVE working interest: it would
 * bill the partner a credit and load the operator with more than its share
 * while the total still looked valid. The allocation is returned unchanged;
 * `valid` is false and the note names the partner and the value, ahead of
 * the over-100 sentence when both apply.
 *
 * @param {number} totalCost cost to allocate
 * @param {{working_interest: number}[]} partners
 */
export const calculatePartnerCosts = (totalCost, partners = []) => {
  const result = partners.map(p => ({
    ...p,
    shareAmount: totalCost * (Number(p.working_interest) || 0) / 100,
    billingStatus: 'Pending'
  }));

  const partnerTotal = partners.reduce((sum, p) => sum + (Number(p.working_interest) || 0), 0);
  const operatorShare = 100 - partnerTotal;
  const operatorAmount = totalCost * (operatorShare / 100);

  const negatives = [];
  partners.forEach((p, index) => {
    const wi = Number(p.working_interest);
    if (Number.isFinite(wi) && wi < 0) {
      const who = p.name != null ? `Partner "${p.name}"` : `Partner at index ${index}`;
      negatives.push(`${who} has a negative working interest (${wi.toFixed(2)} percent).`);
    }
  });

  const sentences = [];
  if (negatives.length > 0) {
    sentences.push(...negatives, 'Correct the interests before billing.');
  }
  if (operatorShare < 0) {
    sentences.push(`Partner working interests total ${partnerTotal.toFixed(2)} percent, which is more than the whole. The operator share below is negative; correct the interests before billing.`);
  }

  return {
    partnerAllocations: result,
    operatorShare,
    operatorAmount,
    partnerTotal,
    valid: operatorShare >= 0 && negatives.length === 0,
    note: sentences.length > 0 ? sentences.join(' ') : null
  };
};

/**
 * Estimate at completion for one cost item, the ONE rule both the metric
 * tiles and the S-curve use: the entered forecast when it is positive,
 * otherwise max(budget, actual + commitment). A zero, blank, negative or
 * non-numeric entered forecast falls through to the standard formula.
 */
export const itemForecast = (item) => {
  const entered = Number(item.forecast) || 0;
  if (entered > 0) return entered;
  const budget = Number(item.budget) || 0;
  const actual = Number(item.actual) || 0;
  const commitment = Number(item.commitment) || 0;
  return Math.max(budget, actual + commitment);
};

/**
 * AFE earned-value metrics as of `asOf` (a Date or an ISO date string;
 * defaults to the clock). Time progress is the elapsed fraction of the AFE
 * window at asOf; planned value is the budget times that fraction; SPI is
 * EV / PV and null where PV is zero (before or on the start day), with the
 * empty-budget guard (SPI 1) unchanged.
 *
 * @throws {AfeInputError} asOf is not a valid date, or a cost item has
 *   negative progress.
 */
export const calculateMetrics = (afe, costItems, invoices, asOf = new Date()) => {
  const asOfDate = resolveAsOf(asOf);

  costItems.forEach((item, index) => {
    const progress = Number(item.progress);
    if (Number.isFinite(progress) && progress < 0) {
      const label = item.code ?? item.description ?? index;
      throw new AfeInputError(`Cost item "${label}" has negative progress (${progress} percent). Progress runs from 0 to 100 percent.`);
    }
  });

  const totalBudget = costItems.reduce((sum, item) => sum + (Number(item.budget) || 0), 0);
  const totalCommitments = costItems.reduce((sum, item) => sum + (Number(item.commitment) || 0), 0);
  
  // Actuals can come from invoices or the cached 'actual' field on cost items. 
  // Using costItems.actual allows for manual accruals or non-invoice costs.
  const totalActuals = costItems.reduce((sum, item) => sum + (Number(item.actual) || 0), 0);
  
  // Forecast (EAC - Estimate At Completion), the shared rule.
  const totalForecast = costItems.reduce((sum, item) => sum + itemForecast(item), 0);

  const variance = totalBudget - totalForecast;
  
  // EVM Metrics
  // Weighted progress based on budget
  let earnedValue = 0;
  if (totalBudget > 0) {
    earnedValue = costItems.reduce((sum, item) => {
      const weight = (Number(item.budget) || 0);
      const progress = (Number(item.progress) || 0) / 100;
      return sum + (weight * progress);
    }, 0);
  }

  const timeProgress = calculateTimeProgress(afe, asOfDate);
  // Simplified planned value: the budget spread linearly over the AFE window.
  const plannedValue = totalBudget * timeProgress;

  const cpi = totalActuals > 0 ? earnedValue / totalActuals : 1.0;
  let spi = 1.0;
  if (totalBudget > 0) {
    spi = plannedValue > 0 ? earnedValue / plannedValue : null;
  }

  const percentSpent = totalBudget > 0 ? (totalActuals / totalBudget) * 100 : 0;
  
  // Overall Physical Percent Complete (Weighted)
  const percentComplete = totalBudget > 0 ? (earnedValue / totalBudget) * 100 : 0;

  return {
    totalBudget,
    totalCommitments,
    totalActuals,
    totalForecast,
    variance,
    earnedValue,
    plannedValue,
    timeProgress,
    cpi,
    spi,
    percentSpent,
    percentComplete
  };
};

const calculateTimeProgress = (afe, asOfDate) => {
  if (!afe?.start_date || !afe?.end_date) return 1.0;
  const start = parseISO(afe.start_date);
  const end = parseISO(afe.end_date);
  const now = asOfDate;

  if (!isValid(start) || !isValid(end)) return 1.0;
  if (now < start) return 0;
  if (now > end) return 1.0;

  const totalDuration = differenceInDays(end, start);
  const elapsed = differenceInDays(now, start);
  
  return totalDuration > 0 ? elapsed / totalDuration : 1.0;
};

/**
 * Monthly S-curve points over the AFE window, with actuals up to `asOf` (a
 * Date or an ISO date string; defaults to the clock) and the forecast
 * projected after it. The walk stops at the window's end.
 *
 * @throws {AfeInputError} asOf is not a valid date.
 */
export const generateSCurveData = (afe, costItems, invoices, asOf = new Date()) => {
  const asOfDate = resolveAsOf(asOf);
  if (!afe?.start_date || !afe?.end_date) return [];

  const start = new Date(afe.start_date);
  const end = new Date(afe.end_date);
  const totalBudget = costItems.reduce((sum, i) => sum + (Number(i.budget)||0), 0);
  const totalForecast = costItems.reduce((sum, i) => sum + itemForecast(i), 0);

  // Sort invoices
  const sortedInvoices = [...invoices].sort((a, b) => new Date(a.invoice_date) - new Date(b.invoice_date));

  const dataPoints = [];
  let currentDate = new Date(start);
  const now = asOfDate;

  let cumActual = 0;
  let cumPlanned = 0;
  let cumForecast = 0;

  const totalDays = differenceInDays(end, start);
  const dailyBudget = totalBudget / Math.max(totalDays, 1);
  const dailyForecast = totalForecast / Math.max(totalDays, 1);

  // Create monthly buckets roughly, inside the window only
  while (currentDate <= end) {
    const displayDate = currentDate.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    
    // Actuals (up to asOf)
    if (currentDate <= now) {
       // Sum invoices up to this date
       const invoicesUntilNow = sortedInvoices.filter(inv => new Date(inv.invoice_date) <= currentDate);
       cumActual = invoicesUntilNow.reduce((sum, inv) => sum + Number(inv.amount), 0);
    }

    // Planned (Linear distribution for simplicity, could be S-curve bell shaped in advanced version)
    const daysElapsed = differenceInDays(currentDate, start);
    if (daysElapsed >= 0) {
        cumPlanned = Math.min(totalBudget, daysElapsed * dailyBudget);
        
        // Forecast merges actuals + remaining projection
        if (currentDate <= now) {
            cumForecast = cumActual; 
        } else {
            // Project linearly to Total Forecast after asOf
            cumForecast = Math.min(totalForecast, daysElapsed * dailyForecast); 
        }
    }

    dataPoints.push({
      date: displayDate,
      Planned: Math.round(cumPlanned),
      Actual: currentDate <= now ? Math.round(cumActual) : null,
      Forecast: Math.round(cumForecast)
    });

    // Advance 1 month
    currentDate.setMonth(currentDate.getMonth() + 1);
  }
  return dataPoints;
};
