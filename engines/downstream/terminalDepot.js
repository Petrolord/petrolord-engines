/**
 * Terminal and depot operations (Midstream & Downstream DS5).
 *
 * DOCTRINE 4, MADE CONCRETE: UNINSTRUMENTED FIRST
 *
 * Terminal automation systems assume a terminal that is instrumented: mass
 * flow meters on every arm, automatic tank gauging, a historian. Most
 * terminals in the markets this Suite serves have a dip tape, a strapping
 * table and a spreadsheet. They are not a lesser case to be upgraded into
 * the real product later; they are the case this app is built for, and
 * instrumented data is the upgrade path rather than the entry ticket.
 *
 * So everything here starts from a dip: a number a person read off a tape at
 * a time they wrote down. From that alone this computes standard volumes,
 * closes a stock reconciliation, trends gain and loss, and prices throughput.
 *
 * WHAT IT REFUSES TO GUESS
 *
 * The volume correction factor. ASTM D1250 (API MPMS Chapter 11.1) is a
 * published set of coefficients per commodity group, and reproducing
 * published tables from memory is what this package refuses. The FORM of the
 * correction is here and the coefficients are a required input with no
 * default, so the calculation works the moment a user supplies their table
 * and refuses clearly until then. A terminal can also enter a VCF read
 * straight off its own tables, which is what most of them do anyway.
 */

/**
 * Numeric coercion that treats ABSENCE as absent.
 *
 * Number(null) is 0 and Number('') is 0, so the obvious implementation turns
 * a missing value into a real zero. That is the exact failure this module
 * family exists to avoid: a sulfur content nobody supplied is not zero
 * sulfur, an emission factor nobody supplied is not zero carbon, and a dip
 * nobody read is not an empty tank. Missing stays missing.
 */
const num = (v, fallback = NaN) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// ---------------------------------------------------------------------------
// Dips and strapping
// ---------------------------------------------------------------------------

/**
 * Volume at a dip height, from the tank's strapping table.
 *
 * The table is [{ heightMm, volumeM3 }] in increasing order. Linear between
 * entries, which is what every terminal does by hand. Below the first entry
 * the tank is at or under its heel; above the last, the table has run out and
 * the app says so rather than extrapolating, because extrapolating a
 * strapping table invents capacity that the tank does not have.
 */
export const volumeAtDip = ({ strapping, heightMm }) => {
  const pts = [...(strapping || [])]
    .map((p) => ({ h: num(p.heightMm), v: num(p.volumeM3) }))
    .filter((p) => Number.isFinite(p.h) && Number.isFinite(p.v))
    .sort((a, b) => a.h - b.h);
  if (pts.length === 0) return { volumeM3: null, error: 'No strapping table for this tank.' };

  const h = num(heightMm);
  if (!Number.isFinite(h)) return { volumeM3: null, error: 'No dip reading.' };
  if (h <= pts[0].h) return { volumeM3: pts[0].v, note: h < pts[0].h ? 'Dip is below the first strapping entry; the tank is at or under its heel.' : null };
  if (h > pts[pts.length - 1].h) {
    return {
      volumeM3: null,
      error: 'The dip is above the last strapping entry. The table does not cover this height, and extrapolating one invents capacity the tank does not have.',
    };
  }
  for (let i = 1; i < pts.length; i += 1) {
    if (h <= pts[i].h) {
      const span = pts[i].h - pts[i - 1].h;
      const f = span > 0 ? (h - pts[i - 1].h) / span : 0;
      return { volumeM3: pts[i - 1].v + f * (pts[i].v - pts[i - 1].v), note: null };
    }
  }
  return { volumeM3: pts[pts.length - 1].v, note: null };
};

/**
 * Volume correction factor, ASTM D1250 form.
 *
 *   alpha = K0 / rho^2 + K1 / rho + K2
 *   VCF   = exp( -alpha * dT * (1 + 0.8 * alpha * dT) )
 *
 * where rho is density at 15 C in kg/m3 and dT is (T - 15) in Celsius.
 *
 * `coefficients` is REQUIRED and has no default. K0, K1 and K2 are published
 * per commodity group in API MPMS Chapter 11.1, and this package does not
 * reproduce published tables from memory: the same rule that keeps the
 * relief-valve chart factors and the D86 conversion as typed inputs. Supply
 * the row for your commodity group, or enter a VCF straight off your own
 * tables, which is what most terminals do.
 */
export const volumeCorrectionFactor = ({ densityKgM3, temperatureC, coefficients }) => {
  if (!coefficients || !Number.isFinite(num(coefficients.k0))) {
    return {
      vcf: null,
      error: 'The volume correction factor needs the API MPMS Chapter 11.1 coefficients for your commodity group, which are a published table this package does not ship. Supply K0, K1 and K2, or enter a VCF read from your own tables.',
    };
  }
  const rho = num(densityKgM3);
  const t = num(temperatureC);
  if (!(rho > 0) || !Number.isFinite(t)) return { vcf: null, error: 'Density at 15 C and observed temperature are both needed.' };
  const k0 = num(coefficients.k0, 0);
  const k1 = num(coefficients.k1, 0);
  const k2 = num(coefficients.k2, 0);
  const alpha = k0 / (rho * rho) + k1 / rho + k2;
  const dT = t - 15;
  const vcf = Math.exp(-alpha * dT * (1 + 0.8 * alpha * dT));
  return { vcf, alpha, error: null };
};

/**
 * A dip, converted to a standard volume.
 *
 * Gross observed volume comes from the strapping table; the standard volume
 * is that times the VCF. Where no VCF can be formed the gross volume is still
 * reported, with the standard one null and the reason stated, because a
 * terminal that cannot correct to standard still needs its gross stock.
 */
export const dipToStandardVolume = ({ strapping, heightMm, vcf, waterMm = 0 }) => {
  const total = volumeAtDip({ strapping, heightMm });
  if (total.volumeM3 === null) return { ...total, grossM3: null, standardM3: null };

  // Free water sits under the product and is not product. Subtracting it is
  // the difference between a stock figure and a stock figure that is right.
  const water = volumeAtDip({ strapping, heightMm: num(waterMm, 0) });
  const waterM3 = num(waterMm, 0) > 0 && water.volumeM3 !== null ? water.volumeM3 : 0;
  const grossM3 = Math.max(0, total.volumeM3 - waterM3);
  const f = num(vcf, NaN);
  return {
    grossM3,
    waterM3,
    vcf: Number.isFinite(f) ? f : null,
    standardM3: Number.isFinite(f) ? grossM3 * f : null,
    note: Number.isFinite(f) ? total.note : 'No volume correction factor supplied, so only the gross observed volume is reported.',
    error: null,
  };
};

// ---------------------------------------------------------------------------
// Stock reconciliation
// ---------------------------------------------------------------------------

/**
 * Close the day, and name the gap.
 *
 *   closing (expected) = opening + receipts - deliveries - known losses
 *   unaccounted        = closing (dipped) - closing (expected)
 *
 * The unaccounted figure is the entire point of a terminal reconciliation.
 * A tool that silently balanced would be worse than useless: gain and loss is
 * what the operator is judged on, what the customer disputes, and what tells
 * you a meter is drifting or a valve is passing.
 *
 * The tolerance is a stated fraction of throughput, not of stock, because
 * measurement error scales with what moved rather than with what is sitting
 * in the tank.
 */
export const reconcileStock = ({
  openingM3, receiptsM3 = 0, deliveriesM3 = 0, knownLossM3 = 0, closingDippedM3,
  tolerancePercentOfThroughput = 0.5,
}) => {
  const opening = num(openingM3, 0);
  const receipts = num(receiptsM3, 0);
  const deliveries = num(deliveriesM3, 0);
  const known = num(knownLossM3, 0);
  const expected = opening + receipts - deliveries - known;
  const dipped = num(closingDippedM3, NaN);

  if (!Number.isFinite(dipped)) {
    return { expectedClosingM3: expected, dippedClosingM3: null, unaccountedM3: null, withinTolerance: null, note: 'No closing dip, so the day cannot be closed.' };
  }

  const throughput = receipts + deliveries;
  const unaccounted = dipped - expected;
  const tolerance = throughput * (Math.abs(num(tolerancePercentOfThroughput, 0)) / 100);

  return {
    expectedClosingM3: expected,
    dippedClosingM3: dipped,
    unaccountedM3: unaccounted,
    unaccountedPercentOfThroughput: throughput > 0 ? (unaccounted / throughput) * 100 : null,
    toleranceM3: tolerance,
    withinTolerance: Math.abs(unaccounted) <= tolerance,
    // Direction matters operationally: a persistent gain usually means a
    // meter under-reading on receipt, a persistent loss the opposite or a
    // real leak.
    direction: Math.abs(unaccounted) <= 1e-9 ? 'balanced' : unaccounted > 0 ? 'gain' : 'loss',
  };
};

/**
 * Trend the daily gaps.
 *
 * One day's gain is noise. A run of them in the same direction is a finding,
 * and separating the two is the reason to trend rather than to look at
 * today's number.
 */
export const trendUnaccounted = (days = []) => {
  const rows = days
    .map((d) => ({ date: d.date, unaccountedM3: num(d.unaccountedM3, NaN), throughputM3: num(d.throughputM3, 0) }))
    .filter((d) => Number.isFinite(d.unaccountedM3));
  if (rows.length === 0) return { rows: [], cumulativeM3: 0, meanPercent: null, runLength: 0, runDirection: null };

  let cumulative = 0;
  const withCumulative = rows.map((r) => {
    cumulative += r.unaccountedM3;
    return { ...r, cumulativeM3: cumulative };
  });

  const throughput = rows.reduce((s, r) => s + r.throughputM3, 0);
  const meanPercent = throughput > 0 ? (cumulative / throughput) * 100 : null;

  // Longest run ending today, in one direction.
  let runLength = 0;
  let runDirection = null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const dir = rows[i].unaccountedM3 > 0 ? 'gain' : rows[i].unaccountedM3 < 0 ? 'loss' : null;
    if (dir === null) break;
    if (runDirection === null) runDirection = dir;
    if (dir !== runDirection) break;
    runLength += 1;
  }

  return {
    rows: withCumulative,
    cumulativeM3: cumulative,
    meanPercent,
    runLength,
    runDirection,
    // Four days the same way is the point at which most terminals would go
    // looking. Stated as a prompt, not as a threshold anyone has to accept.
    prompt: runLength >= 4
      ? `${runLength} days of ${runDirection} in a row. One day is noise; a run in one direction is worth investigating: a drifting meter, a passing valve, or a temperature effect not being corrected.`
      : null,
  };
};

// ---------------------------------------------------------------------------
// Rack throughput and queueing
// ---------------------------------------------------------------------------

/**
 * Loading rack capacity and waiting time, as an M/M/c queue.
 *
 * Trucks arrive irregularly and take varying times to load, which is exactly
 * the case simple capacity arithmetic gets wrong: a rack at 85 percent
 * utilisation does not have 15 percent spare, it has a queue. The Erlang C
 * formula is derived here from first principles rather than read from a
 * table, so there is nothing to reproduce and nothing to get wrong.
 *
 * @param {number} arrivalsPerHour  trucks arriving
 * @param {number} loadMinutes      mean time on the bay
 * @param {number} bays             loading positions
 */
export const rackQueue = ({ arrivalsPerHour, loadMinutes, bays }) => {
  const lambda = num(arrivalsPerHour);
  const serviceRate = 60 / num(loadMinutes, NaN); // trucks per hour per bay
  const c = Math.max(1, Math.round(num(bays, 1)));
  if (!(lambda > 0) || !(serviceRate > 0)) {
    return { error: 'Arrival rate and load time are both needed.', utilisation: null };
  }

  const offered = lambda / serviceRate;          // erlangs
  const utilisation = offered / c;

  if (utilisation >= 1) {
    return {
      offered, utilisation, bays: c,
      stable: false,
      // Not a number problem: the rack genuinely cannot keep up, and the
      // queue grows without limit until arrivals stop.
      error: 'The rack cannot keep up with arrivals. The queue grows without limit, so no average waiting time exists. Add a bay, load faster, or spread the arrivals.',
      probabilityOfWaiting: 1,
      averageWaitMinutes: null,
      trucksPerDay: null,
    };
  }

  // Erlang C, built up from the Erlang B recursion, which is numerically
  // stable where the factorial form overflows.
  let erlangB = 1;
  for (let i = 1; i <= c; i += 1) {
    erlangB = (offered * erlangB) / (i + offered * erlangB);
  }
  const erlangC = erlangB / (1 - utilisation * (1 - erlangB));

  const averageWaitHours = erlangC / (c * serviceRate - lambda);
  const averageWaitMinutes = averageWaitHours * 60;

  return {
    offered,
    utilisation,
    bays: c,
    stable: true,
    probabilityOfWaiting: erlangC,
    averageWaitMinutes,
    averageTimeOnSiteMinutes: averageWaitMinutes + num(loadMinutes),
    queueLength: erlangC * (utilisation / (1 - utilisation)),
    trucksPerDay: lambda * 24,
    error: null,
  };
};

// ---------------------------------------------------------------------------
// Tank farm and economics
// ---------------------------------------------------------------------------

/**
 * Days of cover and turnover for a tank farm.
 *
 * Working capacity is capacity less the heel, because the heel cannot be
 * pumped out and a plan that counts it is planning on volume that does not
 * exist.
 */
export const tankFarmCover = ({ tanks = [], dailyThroughputM3 }) => {
  const capacity = tanks.reduce((s, t) => s + num(t.capacityM3, 0), 0);
  const heel = tanks.reduce((s, t) => s + num(t.heelM3, 0), 0);
  const working = Math.max(0, capacity - heel);
  const stock = tanks.reduce((s, t) => s + num(t.stockM3, 0), 0);
  const daily = num(dailyThroughputM3, 0);
  return {
    capacityM3: capacity,
    heelM3: heel,
    workingCapacityM3: working,
    stockM3: stock,
    ullageM3: Math.max(0, capacity - stock),
    daysOfCover: daily > 0 ? Math.max(0, stock - heel) / daily : null,
    turnsPerYear: working > 0 ? (daily * 365) / working : null,
  };
};

/**
 * Throughput economics, with the carbon ledger beside the money one.
 *
 * Doctrine 3: a terminal's emissions come from the same movements its
 * economics already describe, so both are computed from one set of volumes
 * rather than assembled separately and reconciled.
 *
 * The emission factor is a REQUIRED input rather than a shipped constant.
 * Factors are published, versioned data that belong with the app that owns
 * them; a terminal that has not supplied one gets its money answer and a
 * stated null for carbon rather than an invented number.
 */
export const throughputEconomics = ({
  throughputM3, feePerM3, variableCostPerM3 = 0, fixedCostPerPeriod = 0,
  lossM3 = 0, productDensityKgM3, lossEmissionFactorKgCo2ePerTonne = null,
}) => {
  const volume = num(throughputM3, 0);
  const revenue = volume * num(feePerM3, 0);
  const variable = volume * num(variableCostPerM3, 0);
  const fixed = num(fixedCostPerPeriod, 0);
  const margin = revenue - variable - fixed;

  const lossTonnes = num(lossM3, 0) * num(productDensityKgM3, 0) / 1000;
  const factor = num(lossEmissionFactorKgCo2ePerTonne, NaN);
  const emissionsKgCo2e = Number.isFinite(factor) ? lossTonnes * factor : null;
  const throughputTonnes = volume * num(productDensityKgM3, 0) / 1000;

  return {
    revenue,
    variableCost: variable,
    fixedCost: fixed,
    margin,
    marginPerM3: volume > 0 ? margin / volume : null,
    lossTonnes,
    emissionsKgCo2e,
    // The dual-ledger number: carbon per tonne of throughput, beside the
    // margin per cubic metre.
    kgCo2ePerTonneThroughput: emissionsKgCo2e !== null && throughputTonnes > 0
      ? emissionsKgCo2e / throughputTonnes
      : null,
    carbonNote: Number.isFinite(factor)
      ? null
      : 'No emission factor supplied, so the carbon side is not computed. Factors are published, versioned data; an invented one would be worse than none.',
  };
};
