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
 * EC5-3, EC5-5, EC5-8 and the CPI item (owner decisions 2026-09-15): CPI and
 * SPI are null whenever the ratio is undefined, with `cpiStatus` and
 * `spiStatus` naming why ('no-spend', 'no-budget', 'no-planned-value'; 'ok'
 * when the ratio is reported); progress above 100 percent is refused like
 * negative progress; and the S-curve parses, steps and labels in UTC, so the
 * same AFE draws the same curve in every time zone. FINDINGS-fdp.md, section
 * "EC5-3, EC5-5, EC5-8 and CPI", has the before and after.
 *
 * Money is whatever unit the caller supplies (the AFE app uses its own
 * currency field); percentages are 0 to 100.
 */
import { differenceInDays, isValid, parseISO } from '../../lib/dates/dates.js';

// --- Input errors ---

/**
 * Thrown for an input the AFE engine refuses rather than computes on: an
 * invalid `asOf` date, or a cost item with progress below 0 or above 100
 * percent.
 */
export class AfeInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AfeInputError';
  }
}

/**
 * The date on an invoice, or null when it has none the engine can read.
 *
 * EC6-1 (FINDINGS-fdp.md section 8). The S-curve placed invoices with
 * `new Date(inv.invoice_date) <= currentDate`. A missing or unreadable date
 * is an Invalid Date and never counts, but a NULL date is `new Date(null)`,
 * the first of January 1970, so an undated invoice counted in EVERY bucket
 * from the first: an unpaid invoice with no date inflated the actual spend
 * from day one of the AFE.
 */
export const invoiceDate = (invoice) => {
  const raw = invoice?.invoice_date;
  if (raw === null || raw === undefined || raw === '') return null;
  // EC5-5: read in UTC like the S-curve window (parseWindowDateUtc below),
  // so an invoice lands in the same bucket in every time zone.
  const d = raw instanceof Date ? raw : parseWindowDateUtc(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** How many invoices carry no date the engine can place on a curve. */
export const countUndatedInvoices = (invoices = []) => invoices
  .filter((inv) => invoiceDate(inv) === null).length;

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
 * window at asOf; planned value is the budget times that fraction.
 *
 * ONE null rule for an undefined ratio (EC5-3 and the CPI item, owner
 * decisions 2026-09-15). CPI is EV / AC; with nothing spent (AC not above
 * 0) it is null and `cpiStatus` is 'no-spend'. It used to be 1 whatever had
 * been earned. SPI is EV / PV; with no budget (BAC not above 0, the empty
 * AFE included) it is null and `spiStatus` is 'no-budget', where it used to
 * be 1; with a budget but no planned value yet (before or on the start day)
 * it is null and `spiStatus` is 'no-planned-value'. A reported ratio carries
 * the status 'ok'.
 *
 * @throws {AfeInputError} asOf is not a valid date, or a cost item has
 *   progress below 0 or above 100 percent (EC5-8: above 100 used to earn
 *   more than the budget).
 */
export const calculateMetrics = (afe, costItems, invoices, asOf = new Date()) => {
  const asOfDate = resolveAsOf(asOf);

  costItems.forEach((item, index) => {
    const progress = Number(item.progress);
    if (Number.isNaN(progress)) return;
    const label = item.code ?? item.description ?? index;
    if (progress < 0) {
      throw new AfeInputError(`Cost item "${label}" has negative progress (${progress} percent). Progress runs from 0 to 100 percent.`);
    }
    if (progress > 100) {
      throw new AfeInputError(`Cost item "${label}" has progress above 100 percent (${progress} percent). Progress runs from 0 to 100 percent.`);
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

  const cpi = totalActuals > 0 ? earnedValue / totalActuals : null;
  const cpiStatus = totalActuals > 0 ? 'ok' : 'no-spend';
  let spi = null;
  let spiStatus = 'no-budget';
  if (totalBudget > 0) {
    spi = plannedValue > 0 ? earnedValue / plannedValue : null;
    spiStatus = plannedValue > 0 ? 'ok' : 'no-planned-value';
  }

  const percentSpent = totalBudget > 0 ? (totalActuals / totalBudget) * 100 : 0;
  
  // Overall Physical Percent Complete (Weighted)
  const percentComplete = totalBudget > 0 ? (earnedValue / totalBudget) * 100 : 0;

  return {
    // EC6-1: invoices with no readable date are excluded from the curve
    // and counted here (FINDINGS-fdp.md section 8).
    undatedInvoices: countUndatedInvoices(invoices),
    totalBudget,
    totalCommitments,
    totalActuals,
    totalForecast,
    variance,
    earnedValue,
    plannedValue,
    timeProgress,
    cpi,
    cpiStatus,
    spi,
    spiStatus,
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

// --- UTC calendar for the S-curve (EC5-5) ---

const DAY_MS = 86400000;
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A date-only ISO string (no time part), which ECMAScript parses as UTC. */
const isDateOnly = (s) => /^[+-]?\d{4,6}(-\d{2}(-\d{2})?)?$/.test(s);

/** A string carrying a time AND a zone designator names one instant. */
const hasTimeAndZone = (s) => /[T ]\d/.test(s) && /(Z|[+-]\d{2}(:?\d{2})?)$/i.test(s);

/** A Date's wall-clock fields in the running zone, read as UTC fields. */
const localFieldsAsUtc = (d) => new Date(Date.UTC(
  d.getFullYear(), d.getMonth(), d.getDate(),
  d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds(),
));

/**
 * An AFE window date as a UTC instant. A Date is used as is. A date-only ISO
 * string and a string with an explicit zone parse the way `new Date` always
 * parsed them (UTC midnight, or the stated instant). Any other string `new
 * Date` reads in the running zone, so its wall-clock fields are taken as UTC:
 * '2027-02-01T00:00:00' is 1 February 2027 in Lagos and Los Angeles alike.
 * An unreadable value is an Invalid Date, and the walk emits nothing.
 */
const parseWindowDateUtc = (raw) => {
  if (raw instanceof Date) return new Date(raw.getTime());
  const d = new Date(raw);
  if (typeof raw !== 'string' || Number.isNaN(d.getTime())) return d;
  const s = raw.trim();
  return isDateOnly(s) || hasTimeAndZone(s) ? d : localFieldsAsUtc(d);
};

/**
 * `asOf` as a UTC instant for the S-curve. It is validated exactly as the
 * metrics validate it (same refusal). A Date is used as is. A string with no
 * time part is that calendar day at UTC midnight (parseISO reads it at LOCAL
 * midnight, which in Tokyo is the previous UTC day and dropped a bucket dated
 * on asOf). A string with a time and a zone is that instant; a time with no
 * zone is read as UTC wall-clock time.
 */
const resolveAsOfUtc = (asOf) => {
  const d = resolveAsOf(asOf);
  if (typeof asOf !== 'string') return d;
  const s = asOf.trim();
  if (!/[T ]\d/.test(s)) return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  return hasTimeAndZone(s) ? d : localFieldsAsUtc(d);
};

/**
 * Whole days from `earlier` to `later`: the full-day difference truncated
 * toward zero. UTC has no daylight saving, so this is date-fns
 * differenceInDays as run in UTC; run in Los Angeles that function lost a day
 * across the autumn clock change.
 */
const utcWholeDays = (later, earlier) => {
  const days = Math.trunc((later.getTime() - earlier.getTime()) / DAY_MS);
  return days === 0 ? 0 : days;
};

/** 'Feb 27': the short English month and two-digit year of the UTC date. */
const utcMonthLabel = (d) => `${MONTH_LABELS[d.getUTCMonth()]} ${String(((d.getUTCFullYear() % 100) + 100) % 100).padStart(2, '0')}`;

/**
 * Monthly S-curve points over the AFE window, with actuals up to `asOf` (a
 * Date or an ISO date string; defaults to the clock) and the forecast
 * projected after it. The walk stops at the window's end.
 *
 * EC5-5 (owner decision 2026-09-15). The window was parsed in UTC but the
 * months were stepped with local `setMonth`, labelled with local
 * `toLocaleDateString`, counted with local `differenceInDays` and cut at a
 * local-midnight asOf. A window starting 1 February 2027 drawn in Los Angeles
 * was labelled from "Jan 27" and every Planned value moved. Now the window,
 * asOf, the monthly step (`setUTCMonth`), the day count and the label are all
 * UTC, so every zone draws the curve a UTC machine draws, and the UTC output
 * is unchanged.
 *
 * @throws {AfeInputError} asOf is not a valid date.
 */
export const generateSCurveData = (afe, costItems, invoices, asOf = new Date()) => {
  const asOfDate = resolveAsOfUtc(asOf);
  if (!afe?.start_date || !afe?.end_date) return [];

  const start = parseWindowDateUtc(afe.start_date);
  const end = parseWindowDateUtc(afe.end_date);
  const totalBudget = costItems.reduce((sum, i) => sum + (Number(i.budget)||0), 0);
  const totalForecast = costItems.reduce((sum, i) => sum + itemForecast(i), 0);

  // EC6-1 (FINDINGS-fdp.md section 8). An invoice was placed on the curve
  // with `new Date(inv.invoice_date) <= currentDate`. A missing or
  // unreadable date is an Invalid Date and never counts, but a NULL date is
  // `new Date(null)`, the first of January 1970, so an undated invoice
  // counted in EVERY bucket from the first one: an unpaid invoice with no
  // date inflated the actual spend from day one of the AFE. An invoice the
  // engine cannot date is not on the curve at all; `countUndatedInvoices`
  // and the `undatedInvoices` field on calculateMetrics say how many were
  // set aside, so the app can ask for the dates.
  const sortedInvoices = invoices
    .filter((inv) => invoiceDate(inv) !== null)
    .sort((a, b) => invoiceDate(a) - invoiceDate(b));

  const dataPoints = [];
  let currentDate = new Date(start);
  const now = asOfDate;

  let cumActual = 0;
  let cumPlanned = 0;
  let cumForecast = 0;

  const totalDays = utcWholeDays(end, start);
  const dailyBudget = totalBudget / Math.max(totalDays, 1);
  const dailyForecast = totalForecast / Math.max(totalDays, 1);

  // Create monthly buckets roughly, inside the window only
  while (currentDate <= end) {
    const displayDate = utcMonthLabel(currentDate);
    
    // Actuals (up to asOf)
    if (currentDate <= now) {
       // Sum invoices up to this date
       const invoicesUntilNow = sortedInvoices.filter(inv => invoiceDate(inv) <= currentDate);
       cumActual = invoicesUntilNow.reduce((sum, inv) => sum + Number(inv.amount), 0);
    }

    // Planned (Linear distribution for simplicity, could be S-curve bell shaped in advanced version)
    const daysElapsed = utcWholeDays(currentDate, start);
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

    // Advance 1 calendar month in UTC (the day of month is kept and
    // overflows forward, as setMonth did on a UTC machine)
    currentDate.setUTCMonth(currentDate.getUTCMonth() + 1);
  }
  return dataPoints;
};
