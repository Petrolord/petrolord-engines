/**
 * Fuel pricing and supply chain (Midstream & Downstream DS6).
 *
 * A litre of petrol at a forecourt in Lagos began as a cargo priced off a
 * marker in dollars per tonne. Between the two sit a freight rate, an ocean
 * loss, a duty, a fistful of statutory charges, an exchange rate, a truck,
 * and four margins set by regulation. Every one of them is somebody's
 * assumption, and the whole trade turns on whether the sum of them clears
 * the price the market or the regulator allows.
 *
 * That build-up is done today in a spreadsheet per importer, rebuilt from
 * scratch whenever a rate changes, with no audit trail and no way to ask
 * what happens at a different exchange rate. This module makes it a model.
 *
 * WHAT IT REFUSES TO SHIP
 *
 * Rates. Duties, levies, statutory charges and regulated margins are set by
 * regulation, they differ by market, and they change - the 15% import duty
 * on PMS and AGO is the current example and it will not be the last. A
 * number baked into this file would be read as authority and would go stale
 * silently, which is worse than no number at all.
 *
 * So the templates ship the LINE ITEMS, which are stable, with the rates
 * absent and required. A build-up missing a rate is reported as INCOMPLETE
 * and its total is labelled a floor rather than a cost. An understated
 * landed cost is not a small error in this business; it is the error that
 * loses the cargo.
 *
 * THE ORDER OF THE BUILD-UP IS PART OF THE ANSWER
 *
 * A charge levied as a percentage of CIF depends on what CIF already is, so
 * the stages are walked in sequence and each charge declares the base it
 * bites on. Reordering them changes the number, which is exactly why the
 * order is data here rather than an accident of how the spreadsheet grew.
 */

import { rackQueue } from './terminalDepot.js';

/**
 * Numeric coercion that treats ABSENCE as absent.
 *
 * Number(null) is 0 and Number('') is 0, so the obvious implementation turns
 * a missing value into a real zero. Here that would turn an unsupplied duty
 * rate into a duty-free cargo. Missing stays missing.
 */
const num = (v, fallback = NaN) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Rounding policy: money and physical quantities are rounded to the
 * resolution they are reported at, but RATIOS AND PER-UNIT RATES ARE NOT,
 * because a caller multiplies them back up. A utilisation rounded to four
 * places and then multiplied by a fleet's annual trips is off by more than
 * the figure it was rounded to.
 */
const round = (v, dp = 6) => (Number.isFinite(v)
  ? Math.round(v * 10 ** dp) / 10 ** dp
  : null);

// ---------------------------------------------------------------------------
// Quantities
// ---------------------------------------------------------------------------

/** Exact, by definition. */
export const LITRES_PER_M3 = 1000;
/** The API barrel, exact by definition of the US gallon. */
export const M3_PER_BBL = 0.158987294928;

/**
 * One cargo expressed every way the trade quotes it.
 *
 * Cargoes are contracted in tonnes, freighted in tonnes, discharged in cubic
 * metres, sold in litres and hedged in barrels, and the bridge between mass
 * and volume is density. Getting that conversion wrong is a silent error of
 * twenty to thirty percent, because it looks like a plausible number either
 * way. Density is therefore required, not defaulted.
 */
export const cargoQuantities = ({ quantity, unit, densityKgM3 }) => {
  const q = num(quantity);
  const rho = num(densityKgM3);
  if (!Number.isFinite(q) || q <= 0) {
    return { error: 'Cargo quantity is required.' };
  }
  if (!Number.isFinite(rho) || rho <= 0) {
    return { error: 'Density is required to convert between mass and volume; it is not assumed.' };
  }
  let m3;
  switch (unit) {
    case 'tonne': m3 = (q * 1000) / rho; break;
    case 'm3': m3 = q; break;
    case 'litre': m3 = q / LITRES_PER_M3; break;
    case 'bbl': m3 = q * M3_PER_BBL; break;
    default: return { error: `Unknown quantity unit "${unit}".` };
  }
  return {
    m3: round(m3, 4),
    litres: round(m3 * LITRES_PER_M3, 2),
    tonnes: round((m3 * rho) / 1000, 4),
    bbl: round(m3 / M3_PER_BBL, 4),
    densityKgM3: rho,
    error: null,
  };
};

// ---------------------------------------------------------------------------
// The landed-cost build-up
// ---------------------------------------------------------------------------

/**
 * What a charge is levied on. The base is the modelling decision, so it is
 * declared per line rather than implied by where the line sits.
 */
export const CHARGE_BASIS = {
  PER_TONNE: 'per_tonne',
  PER_M3: 'per_m3',
  PER_LITRE: 'per_litre',
  PER_BBL: 'per_bbl',
  PER_CARGO: 'per_cargo',
  PERCENT_OF_FOB: 'percent_of_fob',
  PERCENT_OF_CF: 'percent_of_cf',
  PERCENT_OF_CIF: 'percent_of_cif',
};

const BASIS_LABEL = {
  per_tonne: 'per tonne', per_m3: 'per m3', per_litre: 'per litre',
  per_bbl: 'per bbl', per_cargo: 'per cargo',
  percent_of_fob: '% of FOB', percent_of_cf: '% of C&F', percent_of_cif: '% of CIF',
};

/** A charge in cargo money, given the quantities and the running bases. */
const chargeAmount = (charge, q, bases) => {
  const a = num(charge.amount);
  if (!Number.isFinite(a)) return { amount: null, missing: true };
  switch (charge.basis) {
    case CHARGE_BASIS.PER_TONNE: return { amount: a * q.tonnes, missing: false };
    case CHARGE_BASIS.PER_M3: return { amount: a * q.m3, missing: false };
    case CHARGE_BASIS.PER_LITRE: return { amount: a * q.litres, missing: false };
    case CHARGE_BASIS.PER_BBL: return { amount: a * q.bbl, missing: false };
    case CHARGE_BASIS.PER_CARGO: return { amount: a, missing: false };
    case CHARGE_BASIS.PERCENT_OF_FOB: return { amount: (a / 100) * bases.fob, missing: false };
    case CHARGE_BASIS.PERCENT_OF_CF: return { amount: (a / 100) * bases.cf, missing: false };
    case CHARGE_BASIS.PERCENT_OF_CIF: return { amount: (a / 100) * bases.cif, missing: false };
    default: return { amount: null, missing: true, unknownBasis: true };
  }
};

/**
 * Landed cost of a cargo, stage by stage.
 *
 * FOB -> freight -> C&F -> insurance -> CIF -> duty and statutory charges
 * -> landed. Percentage charges bite on the base they name, and the bases
 * are frozen as the walk reaches them, so a charge cannot inflate the base
 * of another charge levied at the same stage.
 *
 * OCEAN LOSS IS DIVIDED, NOT ADDED. You pay for the bill-of-lading quantity
 * and you sell the outturn quantity. If half a percent evaporates in
 * transit, the cost of what you can actually sell rises by 1/(1 - 0.005),
 * not by 1.005. The two differ by only a few thousandths of a cent per
 * litre on one cargo, and by real money over a year, and the wrong one is
 * the one people write down.
 *
 * A missing rate is NOT treated as zero. The line is reported as required,
 * the build-up is marked incomplete, and the total is a FLOOR.
 */
export const landedCost = ({
  quantity, quantityUnit, densityKgM3,
  fobPrice, fobBasis,
  charges = [],
  oceanLossPercent = 0,
  fxRate = null,
}) => {
  const q = cargoQuantities({ quantity, unit: quantityUnit, densityKgM3 });
  if (q.error) return { error: q.error, complete: false, lines: [] };

  const fob = chargeAmount({ amount: fobPrice, basis: fobBasis }, q, { fob: 0, cf: 0, cif: 0 });
  if (fob.missing) {
    return { error: 'An FOB price and its basis are required.', complete: false, lines: [] };
  }

  const missing = [];
  const lines = [{
    key: 'fob', label: 'FOB cargo value', basis: BASIS_LABEL[fobBasis] || fobBasis,
    rate: num(fobPrice, null), amount: fob.amount, stage: 'fob',
  }];

  // Freight and insurance are ordinary charges; they are singled out only
  // because C&F and CIF are named after them and other charges bite on those.
  const at = (stage) => charges.filter((c) => (c.stage || 'landed') === stage);
  const bases = { fob: fob.amount, cf: fob.amount, cif: fob.amount };
  let running = fob.amount;

  const walk = (stage, freezeAs) => {
    at(stage).forEach((c) => {
      const r = chargeAmount(c, q, bases);
      if (r.missing) missing.push(c.label || c.id || 'unnamed charge');
      lines.push({
        key: c.id || c.label, label: c.label, basis: BASIS_LABEL[c.basis] || c.basis,
        rate: num(c.amount, null), amount: r.amount, stage,
        required: r.missing, note: c.note || null,
      });
      if (Number.isFinite(r.amount)) running += r.amount;
    });
    if (freezeAs) bases[freezeAs] = running;
  };

  walk('freight', 'cf');
  const cf = running;
  walk('insurance', 'cif');
  const cif = running;
  walk('landed');

  const loss = num(oceanLossPercent, 0);
  const outturn = {
    litres: q.litres * (1 - loss / 100),
    m3: q.m3 * (1 - loss / 100),
    tonnes: q.tonnes * (1 - loss / 100),
  };
  const complete = missing.length === 0;

  const perLitre = outturn.litres > 0 ? running / outturn.litres : null;
  const rate = num(fxRate, null);

  return {
    error: null,
    complete,
    missingRates: missing,
    quantities: q,
    outturn: {
      litres: round(outturn.litres, 2), m3: round(outturn.m3, 4), tonnes: round(outturn.tonnes, 4),
    },
    lines: lines.map((l) => ({
      ...l,
      amount: round(l.amount, 2),
      perLitre: Number.isFinite(l.amount) && outturn.litres > 0
        ? round(l.amount / outturn.litres, 6) : null,
    })),
    fob: round(fob.amount, 2),
    cf: round(cf, 2),
    cif: round(cif, 2),
    totalUsd: round(running, 2),
    perLitreUsd: round(perLitre, 6),
    perLitreLocal: rate !== null && perLitre !== null ? round(perLitre * rate, 4) : null,
    fxRate: rate,
    oceanLossPercent: loss,
    // Said plainly, because a floor read as a cost is how a cargo loses money.
    basisOfTotal: complete
      ? 'All supplied rates applied.'
      : `A FLOOR, not a cost: ${missing.length} rate(s) not supplied.`,
  };
};

// ---------------------------------------------------------------------------
// The pump-price build-up
// ---------------------------------------------------------------------------

/**
 * What each element of the pump price is levied on.
 *
 * PERCENT_OF_RUNNING is deliberately available: some elements really are a
 * percentage of everything below them, and modelling one as a fixed amount
 * silently freezes it when the landed cost moves.
 */
export const PRICE_ELEMENT_BASIS = {
  PER_LITRE: 'per_litre',
  PERCENT_OF_LANDED: 'percent_of_landed',
  PERCENT_OF_RUNNING: 'percent_of_running',
};

/**
 * Landed cost at the depot gate to price at the nozzle.
 *
 * Every element is applied in order onto a running subtotal, so the result
 * is a waterfall rather than a sum: it says who gets what, in sequence, and
 * the pieces reconcile to the price exactly. That identity is asserted in
 * the tests rather than assumed, because a build-up whose parts do not sum
 * to its total is the standard failure of the spreadsheets this replaces.
 *
 * A regulated cap, where one exists, is compared against the built price.
 * A cap below the build-up does not make the cost go away; it makes a
 * shortfall that somebody in the chain is absorbing, and naming that number
 * is the whole point of the exercise.
 */
export const buildPumpPrice = ({ landedPerLitre, elements = [], capPerLitre = null }) => {
  const landed = num(landedPerLitre);
  if (!Number.isFinite(landed)) {
    return { error: 'A landed cost per litre is required.', lines: [], complete: false };
  }
  const missing = [];
  let running = landed;
  const lines = [{
    key: 'landed', label: 'Landed cost (depot gate)', amount: round(landed, 4),
    running: round(landed, 4), basis: 'per litre', required: false,
  }];

  elements.forEach((el) => {
    const a = num(el.amount);
    let amount = null;
    if (!Number.isFinite(a)) {
      missing.push(el.label || el.id || 'unnamed element');
    } else if (el.basis === PRICE_ELEMENT_BASIS.PERCENT_OF_LANDED) {
      amount = (a / 100) * landed;
    } else if (el.basis === PRICE_ELEMENT_BASIS.PERCENT_OF_RUNNING) {
      amount = (a / 100) * running;
    } else {
      amount = a;
    }
    if (Number.isFinite(amount)) running += amount;
    lines.push({
      key: el.id || el.label, label: el.label,
      basis: BASIS_LABEL[el.basis] || el.basis || 'per litre',
      rate: Number.isFinite(a) ? a : null,
      amount: round(amount, 4), running: round(running, 4),
      required: !Number.isFinite(a), recipient: el.recipient || null, note: el.note || null,
    });
  });

  const price = running;
  const cap = num(capPerLitre, null);
  const complete = missing.length === 0;

  return {
    error: null,
    complete,
    missingRates: missing,
    lines: lines.map((l) => ({
      ...l,
      share: price > 0 && Number.isFinite(l.amount) ? round(l.amount / price, 6) : null,
    })),
    landedPerLitre: round(landed, 4),
    pricePerLitre: round(price, 4),
    capPerLitre: cap,
    // Positive means the cap is BELOW what the chain costs. Somebody eats it.
    shortfallPerLitre: cap !== null ? round(price - cap, 4) : null,
    capCoversChain: cap !== null ? cap >= price : null,
    basisOfPrice: complete
      ? 'All supplied rates applied.'
      : `A FLOOR, not a price: ${missing.length} rate(s) not supplied.`,
  };
};

/**
 * Where the money in a litre goes.
 *
 * The waterfall groups the build-up by recipient, which is the question
 * actually being asked when a pump price is argued about in public: how much
 * of this is the product, how much is government, how much is the chain.
 * Unlabelled elements are grouped as unattributed rather than assigned to
 * anyone, because guessing a recipient is how these arguments go wrong.
 */
export const marginWaterfall = (built) => {
  if (!built || built.error) return { groups: [], error: built ? built.error : 'No build-up.' };
  const groups = new Map();
  built.lines.forEach((l) => {
    const key = l.key === 'landed' ? 'Product (landed)' : (l.recipient || 'Unattributed');
    const prev = groups.get(key) || { recipient: key, amountPerLitre: 0, lines: [] };
    prev.amountPerLitre += Number.isFinite(l.amount) ? l.amount : 0;
    prev.lines.push(l.label);
    groups.set(key, prev);
  });
  const price = built.pricePerLitre;
  return {
    error: null,
    pricePerLitre: price,
    groups: [...groups.values()].map((g) => ({
      ...g,
      amountPerLitre: round(g.amountPerLitre, 4),
      share: price > 0 ? round(g.amountPerLitre / price, 6) : null,
    })).sort((a, b) => b.amountPerLitre - a.amountPerLitre),
  };
};

// ---------------------------------------------------------------------------
// Depot to station
// ---------------------------------------------------------------------------

/**
 * Trucking economics for one depot-to-station lane.
 *
 * The cost of a trip is easy; the cost per litre delivered is what decides
 * whether a station 400 km inland can be served at the same price as one
 * across the road, and it is what bridging allowances exist to cover.
 *
 * TRIPS PER TRUCK ARE DERIVED FROM THE CYCLE, not assumed. Cycle time is
 * the round trip plus loading plus discharge plus queueing, and it is the
 * cycle - not the distance - that sets how many trips a truck makes and
 * therefore how the fixed costs spread. A model that takes trips per year
 * as an input can be tuned to produce any answer wanted.
 */
export const truckingEconomics = ({
  distanceKm, payloadLitres,
  averageSpeedKmh, loadHours = 0, dischargeHours = 0, queueHours = 0,
  fuelConsumptionLPer100Km, dieselPricePerLitre,
  driverCostPerTrip = 0, maintenancePerKm = 0, tyresPerKm = 0, overheadPerTrip = 0,
  tollsAndLeviesPerTrip = 0,
  truckCapitalCost = null, truckLifeYears = null,
  workingHoursPerDay = 12, workingDaysPerYear = 300,
  backhaulLoaded = false,
  transitLossPercent = 0,
  dieselEmissionFactorKgCo2ePerLitre = null,
}) => {
  const d = num(distanceKm);
  const payload = num(payloadLitres);
  const speed = num(averageSpeedKmh);
  if (![d, payload, speed].every((v) => Number.isFinite(v) && v > 0)) {
    return { error: 'Distance, payload and average speed are required and must be positive.' };
  }

  // The truck comes back whether or not it carries anything. Only the
  // revenue side of the return leg changes with a backhaul, never the fuel.
  const roundTripKm = d * 2;
  const drivingHours = roundTripKm / speed;
  const cycleHours = drivingHours + num(loadHours, 0) + num(dischargeHours, 0) + num(queueHours, 0);

  const dayHours = num(workingHoursPerDay, 12);
  const tripsPerDay = dayHours > 0 ? dayHours / cycleHours : 0;
  const tripsPerYear = tripsPerDay * num(workingDaysPerYear, 300);

  const fuelPer100 = num(fuelConsumptionLPer100Km);
  const dieselPrice = num(dieselPricePerLitre);
  const dieselLitres = Number.isFinite(fuelPer100) ? (fuelPer100 / 100) * roundTripKm : null;
  const fuelCost = dieselLitres !== null && Number.isFinite(dieselPrice)
    ? dieselLitres * dieselPrice : null;

  // Depreciation is spread over the cycle the model itself derived, so a
  // slower lane carries more capital cost per trip - which is true, and is
  // the effect a per-trip input would hide.
  const capex = num(truckCapitalCost, null);
  const life = num(truckLifeYears, null);
  const depreciationPerTrip = capex !== null && life !== null && life > 0 && tripsPerYear > 0
    ? capex / (life * tripsPerYear) : null;

  const variableCost = num(maintenancePerKm, 0) * roundTripKm + num(tyresPerKm, 0) * roundTripKm;
  const components = [
    { label: 'Diesel', amount: fuelCost, required: fuelCost === null },
    { label: 'Driver', amount: num(driverCostPerTrip, 0), required: false },
    { label: 'Maintenance and tyres', amount: variableCost, required: false },
    { label: 'Tolls and levies', amount: num(tollsAndLeviesPerTrip, 0), required: false },
    { label: 'Overhead', amount: num(overheadPerTrip, 0), required: false },
    { label: 'Truck depreciation', amount: depreciationPerTrip, required: depreciationPerTrip === null },
  ];
  const missing = components.filter((c) => c.required).map((c) => c.label);
  const costPerTrip = components.reduce((s, c) => s + (Number.isFinite(c.amount) ? c.amount : 0), 0);

  // You load the payload and you deliver less than the payload.
  const lossPct = num(transitLossPercent, 0);
  const deliveredLitres = payload * (1 - lossPct / 100);

  const ef = num(dieselEmissionFactorKgCo2ePerLitre, null);

  return {
    error: null,
    complete: missing.length === 0,
    missingInputs: missing,
    roundTripKm: round(roundTripKm, 2),
    cycleHours: round(cycleHours, 3),
    tripsPerTruckPerDay: round(tripsPerDay, 6),
    tripsPerTruckPerYear: round(tripsPerYear, 4),
    components: components.map((c) => ({ ...c, amount: round(c.amount, 2) })),
    costPerTrip: round(costPerTrip, 2),
    deliveredLitresPerTrip: round(deliveredLitres, 1),
    costPerLitreDelivered: deliveredLitres > 0 ? round(costPerTrip / deliveredLitres, 6) : null,
    dieselLitresPerTrip: dieselLitres === null ? null : round(dieselLitres, 2),
    // Missing factor means missing carbon, not zero carbon.
    kgCo2ePerTrip: ef !== null && dieselLitres !== null ? round(dieselLitres * ef, 2) : null,
    kgCo2ePerLitreDelivered: ef !== null && dieselLitres !== null && deliveredLitres > 0
      ? round((dieselLitres * ef) / deliveredLitres, 6) : null,
    carbonNote: ef === null
      ? 'No diesel emission factor supplied, so the carbon figure is absent rather than zero.'
      : null,
    backhaulLoaded: !!backhaulLoaded,
  };
};

/**
 * How many trucks the lane needs.
 *
 * Fleet size is a ceiling, because a fleet of 4.3 trucks does not exist.
 * The rounding is where the money is: the spare capacity bought by that
 * ceiling is reported rather than buried, since it is the argument for
 * whether the last truck should be owned or hired.
 */
export const fleetSizing = ({ demandLitresPerDay, payloadLitres, tripsPerTruckPerDay }) => {
  const demand = num(demandLitresPerDay);
  const payload = num(payloadLitres);
  const trips = num(tripsPerTruckPerDay);
  if (![demand, payload, trips].every((v) => Number.isFinite(v) && v > 0)) {
    return { error: 'Demand, payload and trips per truck per day are required and must be positive.' };
  }
  const tripsNeeded = demand / payload;
  const trucks = Math.ceil(tripsNeeded / trips);
  const capacityTrips = trucks * trips;
  return {
    error: null,
    tripsNeededPerDay: round(tripsNeeded, 6),
    trucksRequired: trucks,
    fleetTripCapacityPerDay: round(capacityTrips, 6),
    utilisation: round(tripsNeeded / capacityTrips, 6),
    spareTripsPerDay: round(capacityTrips - tripsNeeded, 6),
    spareLitresPerDay: round((capacityTrips - tripsNeeded) * payload, 3),
  };
};

// ---------------------------------------------------------------------------
// The station
// ---------------------------------------------------------------------------

/**
 * Station sizing: nozzles for the peak hour, tankage for the delivery cycle.
 *
 * THE QUEUE MATH IS NOT REIMPLEMENTED. A forecourt and a loading rack are
 * the same queueing system with different units, so this calls the rack
 * model built at DS5 rather than writing a second Erlang C that could
 * disagree with the first.
 *
 * The trap this checks for is ullage. A station orders a full truckload
 * because that is the cheapest way to buy, then cannot discharge it because
 * the tank has less room than the truck has product, and the balance rides
 * back to the depot at the station's expense. It is an arithmetic check
 * nobody does until it has happened twice.
 */
export const stationSizing = ({
  dailyThroughputLitres, peakHourShare = 0.12,
  litresPerTransaction, dispenseRateLitresPerMinute, transactionOverheadMinutes = 1.5,
  nozzles,
  tankCapacityLitres = null, deadStockLitres = 0, reorderAtFraction = 0.25,
  deliveryPayloadLitres = null,
}) => {
  const daily = num(dailyThroughputLitres);
  const perTxn = num(litresPerTransaction);
  const rate = num(dispenseRateLitresPerMinute);
  const bays = num(nozzles);
  if (![daily, perTxn, rate, bays].every((v) => Number.isFinite(v) && v > 0)) {
    return { error: 'Throughput, litres per transaction, dispense rate and nozzle count are required.' };
  }
  const share = num(peakHourShare, 0.12);
  const txnPerDay = daily / perTxn;
  const peakTxnPerHour = txnPerDay * share;
  const serviceMinutes = perTxn / rate + num(transactionOverheadMinutes, 0);

  const queue = rackQueue({
    arrivalsPerHour: peakTxnPerHour, loadMinutes: serviceMinutes, bays,
  });

  const cap = num(tankCapacityLitres, null);
  const dead = num(deadStockLitres, 0);
  const usable = cap === null ? null : cap - dead;
  const coverDays = usable !== null && daily > 0 ? usable / daily : null;
  const reorderLevel = usable === null ? null : dead + usable * num(reorderAtFraction, 0.25);
  const ullageAtReorder = cap !== null && reorderLevel !== null ? cap - reorderLevel : null;
  const payload = num(deliveryPayloadLitres, null);

  return {
    error: null,
    transactionsPerDay: round(txnPerDay, 1),
    peakTransactionsPerHour: round(peakTxnPerHour, 2),
    serviceMinutesPerTransaction: round(serviceMinutes, 3),
    queue,
    usableTankLitres: usable === null ? null : round(usable, 1),
    coverDays: coverDays === null ? null : round(coverDays, 2),
    reorderLevelLitres: reorderLevel === null ? null : round(reorderLevel, 1),
    ullageAtReorderLitres: ullageAtReorder === null ? null : round(ullageAtReorder, 1),
    deliveryPayloadLitres: payload,
    payloadFitsUllage: ullageAtReorder === null || payload === null
      ? null : payload <= ullageAtReorder,
    ullageWarning: ullageAtReorder !== null && payload !== null && payload > ullageAtReorder
      ? `A ${payload} litre load cannot discharge into ${round(ullageAtReorder, 0)} litres of ullage at the reorder level. Order earlier or order a part load.`
      : null,
  };
};

// ---------------------------------------------------------------------------
// What breaks the price
// ---------------------------------------------------------------------------

/**
 * Bisection for the value of one input at which a monotone outcome crosses
 * zero.
 *
 * Used for the question the whole model exists to answer: at what exchange
 * rate, or what FOB, does the regulated price stop covering the chain. If
 * the outcome does not change sign across the bracket, that is REPORTED -
 * no crossing in the range searched - rather than returned as a root at an
 * endpoint. A fabricated breakeven is worse than none, because it will be
 * put in a board pack.
 */
export const solveCrossing = ({ evaluate, lo, hi, tolerance = 1e-6, maxIterations = 200 }) => {
  const a = num(lo); const b = num(hi);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b) {
    return { found: false, reason: 'The search bracket is not a valid interval.' };
  }
  let fa = evaluate(a);
  let fb = evaluate(b);
  if (!Number.isFinite(fa) || !Number.isFinite(fb)) {
    return { found: false, reason: 'The function could not be evaluated across the bracket.' };
  }
  if (fa === 0) return { found: true, value: a, iterations: 0 };
  if (fb === 0) return { found: true, value: b, iterations: 0 };
  if (fa > 0 === fb > 0) {
    return {
      found: false,
      reason: 'No crossing in the range searched. The outcome has the same sign at both ends.',
      atLo: fa,
      atHi: fb,
    };
  }
  let x = a; let y = b; let i = 0;
  while (i < maxIterations && (y - x) > tolerance) {
    const mid = (x + y) / 2;
    const fm = evaluate(mid);
    if (!Number.isFinite(fm)) return { found: false, reason: 'The function failed inside the bracket.' };
    if (fm === 0) return { found: true, value: mid, iterations: i };
    if ((fm > 0) === (fa > 0)) { x = mid; fa = fm; } else { y = mid; fb = fm; }
    i += 1;
  }
  return { found: true, value: round((x + y) / 2, 8), iterations: i };
};

/**
 * The price at a range of values of one driver, and the value at which the
 * cap stops being met.
 *
 * `price(x)` is supplied by the caller so the sensitivity is over whatever
 * the caller actually varies, rather than over a fixed list of drivers this
 * module guessed at.
 */
export const priceSensitivity = ({ price, values = [], capPerLitre = null }) => {
  const cap = num(capPerLitre, null);
  const points = values.map((v) => {
    const p = num(price(v), null);
    return {
      value: v,
      pricePerLitre: p === null ? null : round(p, 4),
      shortfallPerLitre: p === null || cap === null ? null : round(p - cap, 4),
      covered: p === null || cap === null ? null : cap >= p,
    };
  });
  let breakeven = null;
  if (cap !== null && values.length >= 2) {
    const lo = Math.min(...values.map(Number));
    const hi = Math.max(...values.map(Number));
    breakeven = solveCrossing({ evaluate: (x) => num(price(x)) - cap, lo, hi });
  }
  return { points, breakeven, capPerLitre: cap };
};

// ---------------------------------------------------------------------------
// Templates: the shape, never the rates
// ---------------------------------------------------------------------------

/**
 * The disclaimer is part of the data, so it travels with any template that
 * is copied, exported or screenshotted.
 */
export const RATE_DISCLAIMER = 'Line items only. Every rate is a required input: duties, levies and regulated margins are set by regulation, differ by market and change. Confirm each against the regulation in force.';

/**
 * The line items of an import build-up. These are stable; the rates are not,
 * so they are absent and required. A template that shipped rates would be
 * read as authority and would go stale in silence.
 */
export const IMPORT_TEMPLATE = [
  { id: 'freight', label: 'Ocean freight', basis: CHARGE_BASIS.PER_TONNE, stage: 'freight', amount: null },
  { id: 'insurance', label: 'Marine insurance', basis: CHARGE_BASIS.PERCENT_OF_CF, stage: 'insurance', amount: null },
  { id: 'duty', label: 'Import duty', basis: CHARGE_BASIS.PERCENT_OF_CIF, stage: 'landed', amount: null, note: 'Rate set by regulation and subject to change.' },
  { id: 'port', label: 'Port and harbour charges', basis: CHARGE_BASIS.PER_TONNE, stage: 'landed', amount: null },
  { id: 'regulator', label: 'Regulatory and inspection charges', basis: CHARGE_BASIS.PER_LITRE, stage: 'landed', amount: null },
  { id: 'jetty', label: 'Jetty throughput and discharge', basis: CHARGE_BASIS.PER_M3, stage: 'landed', amount: null },
  { id: 'storage', label: 'Storage and handling', basis: CHARGE_BASIS.PER_M3, stage: 'landed', amount: null },
  { id: 'finance', label: 'Financing and letter of credit', basis: CHARGE_BASIS.PERCENT_OF_CIF, stage: 'landed', amount: null },
  { id: 'demurrage', label: 'Demurrage provision', basis: CHARGE_BASIS.PER_CARGO, stage: 'landed', amount: null },
];

/** The line items between the depot gate and the nozzle. Rates required. */
export const PUMP_TEMPLATE = [
  { id: 'depot', label: 'Depot and terminal margin', basis: PRICE_ELEMENT_BASIS.PER_LITRE, amount: null, recipient: 'Terminal' },
  { id: 'bridging', label: 'Bridging or equalisation', basis: PRICE_ELEMENT_BASIS.PER_LITRE, amount: null, recipient: 'Chain' },
  { id: 'transport', label: 'Transport to station', basis: PRICE_ELEMENT_BASIS.PER_LITRE, amount: null, recipient: 'Transporter' },
  { id: 'marketer', label: 'Marketer margin', basis: PRICE_ELEMENT_BASIS.PER_LITRE, amount: null, recipient: 'Marketer' },
  { id: 'dealer', label: 'Dealer margin', basis: PRICE_ELEMENT_BASIS.PER_LITRE, amount: null, recipient: 'Dealer' },
  { id: 'levies', label: 'Statutory levies at the pump', basis: PRICE_ELEMENT_BASIS.PER_LITRE, amount: null, recipient: 'Government' },
  { id: 'vat', label: 'Value added tax', basis: PRICE_ELEMENT_BASIS.PERCENT_OF_RUNNING, amount: null, recipient: 'Government', note: 'Applies to some products and not others in some markets. Set to zero where the product is exempt, rather than deleting the line, so the exemption is visible.' },
];

/**
 * Typical densities are supplied as a STARTING POINT with the range stated,
 * because density varies by cargo and the certificate of quality is the
 * authority. They are labelled, not silently defaulted: nothing in this
 * module reads these unless a caller passes one in.
 */
export const PRODUCT_REFERENCE = [
  { code: 'PMS', label: 'Petrol / gasoline', typicalDensityKgM3: 745, range: '720-775' },
  { code: 'AGO', label: 'Automotive gas oil / diesel', typicalDensityKgM3: 840, range: '820-860' },
  { code: 'DPK', label: 'Kerosene / jet', typicalDensityKgM3: 800, range: '775-840' },
  { code: 'LPG', label: 'Liquefied petroleum gas', typicalDensityKgM3: 545, range: '500-580' },
  { code: 'HFO', label: 'Heavy fuel oil', typicalDensityKgM3: 960, range: '920-1010' },
];
