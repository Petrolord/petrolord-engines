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
 * Function bodies are byte for byte the Suite's. Two of them read the clock
 * (`new Date()`): calculateMetrics through calculateTimeProgress for the
 * schedule index, and generateSCurveData for the actual-to-date cut. The
 * goldens therefore use AFE windows wholly in the past or wholly in the
 * future, where those reads are deterministic, and the tests say so.
 *
 * Money is whatever unit the caller supplies (the AFE app uses its own
 * currency field); percentages are 0 to 100.
 */
import { differenceInDays, isValid, parseISO } from '../../lib/dates/dates.js';

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

  let note = null;
  if (operatorShare < 0) {
    note = `Partner working interests total ${partnerTotal.toFixed(2)} percent, which is more than the whole. The operator share below is negative; correct the interests before billing.`;
  }

  return {
    partnerAllocations: result,
    operatorShare,
    operatorAmount,
    partnerTotal,
    valid: operatorShare >= 0,
    note
  };
};


export const calculateMetrics = (afe, costItems, invoices) => {
  const totalBudget = costItems.reduce((sum, item) => sum + (Number(item.budget) || 0), 0);
  const totalCommitments = costItems.reduce((sum, item) => sum + (Number(item.commitment) || 0), 0);
  
  // Actuals can come from invoices or the cached 'actual' field on cost items. 
  // Using costItems.actual allows for manual accruals or non-invoice costs.
  const totalActuals = costItems.reduce((sum, item) => sum + (Number(item.actual) || 0), 0);
  
  // Calculate Forecast (EAC - Estimate At Completion)
  // Strategy: Use user-defined forecast if available and > 0, otherwise standard formula
  const totalForecast = costItems.reduce((sum, item) => {
    const itemBudget = Number(item.budget) || 0;
    const itemActual = Number(item.actual) || 0;
    const itemCommitment = Number(item.commitment) || 0;
    const itemForecast = Number(item.forecast) || 0;

    if (itemForecast > 0) return sum + itemForecast;
    
    // Default Logic: If we've spent more than budget, forecast is at least actuals.
    // Otherwise, assume budget is still the target unless explicitly changed.
    // A conservative approach: Max(Budget, Actuals + Commitments)
    return sum + Math.max(itemBudget, itemActual + itemCommitment);
  }, 0);

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

  const cpi = totalActuals > 0 ? earnedValue / totalActuals : 1.0;
  const spi = totalBudget > 0 ? earnedValue / (totalBudget * calculateTimeProgress(afe)) : 1.0; // Simplified planned value based on time

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
    cpi,
    spi,
    percentSpent,
    percentComplete
  };
};

const calculateTimeProgress = (afe) => {
  if (!afe?.start_date || !afe?.end_date) return 1.0;
  const start = parseISO(afe.start_date);
  const end = parseISO(afe.end_date);
  const now = new Date();

  if (!isValid(start) || !isValid(end)) return 1.0;
  if (now < start) return 0;
  if (now > end) return 1.0;

  const totalDuration = differenceInDays(end, start);
  const elapsed = differenceInDays(now, start);
  
  return totalDuration > 0 ? elapsed / totalDuration : 1.0;
};

export const generateSCurveData = (afe, costItems, invoices) => {
  if (!afe?.start_date || !afe?.end_date) return [];

  const start = new Date(afe.start_date);
  const end = new Date(afe.end_date);
  const totalBudget = costItems.reduce((sum, i) => sum + (Number(i.budget)||0), 0);
  const totalForecast = costItems.reduce((sum, i) => sum + (Number(i.forecast) || Math.max(Number(i.budget)||0, (Number(i.actual)||0) + (Number(i.commitment)||0))), 0);

  // Sort invoices
  const sortedInvoices = [...invoices].sort((a, b) => new Date(a.invoice_date) - new Date(b.invoice_date));

  const dataPoints = [];
  let currentDate = new Date(start);
  const now = new Date();

  let cumActual = 0;
  let cumPlanned = 0;
  let cumForecast = 0;

  const totalDays = differenceInDays(end, start);
  const dailyBudget = totalBudget / Math.max(totalDays, 1);
  const dailyForecast = totalForecast / Math.max(totalDays, 1);

  // Create monthly buckets roughly
  while (currentDate <= end || currentDate <= now) {
    const dateStr = currentDate.toISOString().split('T')[0];
    const displayDate = currentDate.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    
    // Actuals (up to now)
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
            // Project remaining forecast linearly from now to end
            // Simple approach: Linear projection to Total Forecast
            const totalForecastDays = differenceInDays(end, start);
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