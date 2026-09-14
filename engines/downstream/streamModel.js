/**
 * The Midstream & Downstream shared data model (DS0).
 *
 * This is the piece that makes two of the module's four doctrines
 * structurally possible rather than a reconciliation exercise afterwards.
 *
 * DOCTRINE 2 — one model for plan, schedule and actuals. Incumbents sell
 * planning and scheduling as separate products with separate data models, so
 * the monthly plan and what actually happened live in different systems and
 * are reconciled by hand in a spreadsheet, badly, a month late. Here a plan
 * event, a scheduled event and a recorded actual are THE SAME SHAPE, marked
 * by their `ledger`. Variance is then a subtraction rather than a project.
 *
 * DOCTRINE 3 — the carbon ledger runs beside the money one. Every event
 * carries what it cost and what it emitted, because emissions come from the
 * same movements and burns the economics already describe. Bolting an
 * emissions inventory on afterwards means maintaining a second copy of the
 * truth; deriving both from one event stream means they cannot disagree.
 *
 * This module defines the shapes and the invariants. It deliberately holds no
 * emission factors and no prices: those are versioned data that belong with
 * the apps that own them (API Compendium and IPCC factors in the carbon
 * studio, price decks in the pricing studio), so that updating a factor never
 * means editing the data model.
 */

/** What a quantity is measured in. Volumes are ambient unless stated. */
export const UNITS = {
  BBL: 'bbl',
  M3: 'm3',
  TONNE: 't',
  MMSCF: 'MMscf',
  MWH: 'MWh',
  GJ: 'GJ',
};

/** Which of the three parallel records an event belongs to. */
export const LEDGER = {
  PLAN: 'plan',
  SCHEDULE: 'schedule',
  ACTUAL: 'actual',
};

/** What happened. The set is deliberately small; a refinery month is made of these. */
export const EVENT_TYPE = {
  RECEIPT: 'receipt',       // crude or product into a tank
  DELIVERY: 'delivery',     // product out, sold or transferred
  TRANSFER: 'transfer',     // tank to tank, or tank to unit
  UNIT_RUN: 'unit_run',     // feed processed by a process unit
  BLEND: 'blend',           // components combined into a finished grade
  BURN: 'burn',             // fuel consumed for energy
  FLARE: 'flare',           // gas flared
  VENT: 'vent',             // gas vented or lost to evaporation
  LOSS: 'loss',             // unaccounted or handling loss
};

/** Events that put hydrocarbon into the system, as opposed to taking it out. */
const INFLOWS = new Set([EVENT_TYPE.RECEIPT]);
const OUTFLOWS = new Set([
  EVENT_TYPE.DELIVERY, EVENT_TYPE.BURN, EVENT_TYPE.FLARE,
  EVENT_TYPE.VENT, EVENT_TYPE.LOSS,
]);
/** Events that emit by their nature, whatever else they do. */
export const EMITTING_TYPES = new Set([EVENT_TYPE.BURN, EVENT_TYPE.FLARE, EVENT_TYPE.VENT]);

/**
 * Numeric coercion that treats ABSENCE as absent.
 *
 * Number(null) is 0 and Number('') is 0, so the obvious implementation turns
 * a missing value into a real zero. That is the exact failure this module
 * family exists to avoid: a sulfur content nobody supplied is not zero
 * sulfur, an emission factor nobody supplied is not zero carbon, and a dip
 * nobody read is not an empty tank. Missing stays missing.
 */
const num = (v, fallback = 0) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * A material: crude, intermediate, finished product or fuel gas.
 *
 * Properties are held as a loose bag on purpose. A crude carries an assay, a
 * gasoline carries octane and RVP, a fuel gas carries a heating value, and
 * forcing one union type on all three would make every app carry fields it
 * does not use. What IS fixed is identity and density, because those are what
 * the mass balance and the emissions both need.
 */
export const makeMaterial = ({
  id, name, kind = 'product', densityKgPerM3 = null, properties = {},
}) => ({
  id: String(id),
  name: String(name ?? id),
  kind,                         // 'crude' | 'intermediate' | 'product' | 'fuel'
  densityKgPerM3: densityKgPerM3 === null ? null : num(densityKgPerM3),
  properties: { ...properties },
});

/** A tank, with the strapping-table link the terminal app needs. */
export const makeTank = ({
  id, name, materialId = null, capacityM3 = 0, heelM3 = 0, strappingTableId = null,
}) => ({
  id: String(id),
  name: String(name ?? id),
  materialId: materialId === null ? null : String(materialId),
  capacityM3: num(capacityM3),
  // The unpumpable bottom. Working capacity is capacity less heel, and a
  // terminal that ignores it plans movements it cannot make.
  heelM3: num(heelM3),
  strappingTableId,
});

/**
 * One thing that happened, or is planned, or is scheduled to happen.
 *
 * The same shape in all three ledgers. `quantity` is signed by convention:
 * always positive here, with direction carried by the event type, so a reader
 * never has to guess whether a negative receipt is a return or a typo.
 */
export const makeEvent = ({
  id, ledger, type, materialId, quantity, unit = UNITS.BBL, date = null,
  fromId = null, toId = null, unitId = null, cost = null, emissionsKgCo2e = null,
  meta = {},
}) => {
  if (!Object.values(LEDGER).includes(ledger)) {
    throw new Error(`Unknown ledger "${ledger}"`);
  }
  if (!Object.values(EVENT_TYPE).includes(type)) {
    throw new Error(`Unknown event type "${type}"`);
  }
  const q = num(quantity);
  if (q < 0) throw new Error('Event quantity is unsigned; direction comes from the event type');
  return {
    id: String(id),
    ledger,
    type,
    materialId: String(materialId),
    quantity: q,
    unit,
    date,
    fromId, toId, unitId,
    // Both ledgers, on the same row. Null means not costed or not yet
    // attributed, which is different from zero and is kept different.
    cost: cost === null ? null : num(cost),
    emissionsKgCo2e: emissionsKgCo2e === null ? null : num(emissionsKgCo2e),
    meta: { ...meta },
  };
};

/** Signed contribution of an event to a material balance. */
export const signedQuantity = (event) => {
  if (INFLOWS.has(event.type)) return event.quantity;
  if (OUTFLOWS.has(event.type)) return -event.quantity;
  return 0; // transfers, unit runs and blends move material without creating it
};

/**
 * Close the material balance on one ledger.
 *
 * Opening plus everything in, less everything out, should equal closing. The
 * gap is what a terminal calls gain or loss, and naming it is the point: a
 * reconciliation that silently balances is a reconciliation nobody can audit.
 */
export const materialBalance = ({ events, openingByMaterial = {}, ledger = LEDGER.ACTUAL, closingByMaterial = null }) => {
  const byMaterial = {};
  events.filter((e) => e.ledger === ledger).forEach((e) => {
    if (!byMaterial[e.materialId]) {
      byMaterial[e.materialId] = {
        materialId: e.materialId,
        opening: num(openingByMaterial[e.materialId]),
        in: 0, out: 0,
      };
    }
    const q = signedQuantity(e);
    if (q > 0) byMaterial[e.materialId].in += q;
    else byMaterial[e.materialId].out += -q;
  });

  return Object.values(byMaterial).map((row) => {
    const computedClosing = row.opening + row.in - row.out;
    const reported = closingByMaterial && closingByMaterial[row.materialId] !== undefined
      ? num(closingByMaterial[row.materialId])
      : null;
    return {
      ...row,
      closing: computedClosing,
      reportedClosing: reported,
      // Positive means more was found than the movements explain.
      unaccounted: reported === null ? null : reported - computedClosing,
    };
  });
};

/**
 * Sum the two ledgers over a set of events.
 *
 * Returns money and carbon side by side, and says how much of each is
 * unattributed rather than treating a null as a zero. A total that quietly
 * counts missing costs as free is how a plan comes in under budget on paper.
 */
export const dualLedgerTotals = (events, ledger = LEDGER.ACTUAL) => {
  const rows = events.filter((e) => e.ledger === ledger);
  let cost = 0;
  let emissions = 0;
  let uncosted = 0;
  let unattributedEmissions = 0;
  rows.forEach((e) => {
    if (e.cost === null) uncosted += 1; else cost += e.cost;
    if (e.emissionsKgCo2e === null) {
      // Only count it as a gap where the event emits by its nature.
      if (EMITTING_TYPES.has(e.type)) unattributedEmissions += 1;
    } else {
      emissions += e.emissionsKgCo2e;
    }
  });
  return {
    ledger,
    events: rows.length,
    cost,
    emissionsKgCo2e: emissions,
    uncostedEvents: uncosted,
    unattributedEmissionEvents: unattributedEmissions,
    complete: uncosted === 0 && unattributedEmissions === 0,
  };
};

/**
 * Attribute the gap between two ledgers.
 *
 * This is doctrine 2's payoff. Because plan and actual are the same shape, the
 * difference decomposes without a reconciliation exercise:
 *
 *   volume variance = (actual quantity - plan quantity) x plan unit cost
 *   price variance  = (actual unit cost - plan unit cost) x actual quantity
 *
 * which sum exactly to the total cost difference. That identity is what makes
 * the split trustworthy, and it is asserted in the tests.
 *
 * Events are matched on material and type, which is the grain a monthly plan
 * is written at. Anything present in one ledger and not the other is reported
 * as unmatched rather than folded into a variance, because an unplanned cargo
 * is not a price effect.
 */
export const attributeVariance = ({ events, planLedger = LEDGER.PLAN, actualLedger = LEDGER.ACTUAL }) => {
  const key = (e) => `${e.materialId}::${e.type}`;
  const gather = (ledger) => {
    const map = new Map();
    events.filter((e) => e.ledger === ledger).forEach((e) => {
      const k = key(e);
      const row = map.get(k) || { materialId: e.materialId, type: e.type, quantity: 0, cost: 0, costed: true };
      row.quantity += e.quantity;
      if (e.cost === null) row.costed = false; else row.cost += e.cost;
      map.set(k, row);
    });
    return map;
  };

  const plan = gather(planLedger);
  const actual = gather(actualLedger);
  const lines = [];
  const unmatched = [];

  const keys = new Set([...plan.keys(), ...actual.keys()]);
  keys.forEach((k) => {
    const p = plan.get(k);
    const a = actual.get(k);
    if (!p || !a) {
      unmatched.push({
        materialId: (p || a).materialId,
        type: (p || a).type,
        presentIn: p ? planLedger : actualLedger,
        quantity: (p || a).quantity,
        cost: (p || a).cost,
      });
      return;
    }
    const planUnitCost = p.quantity > 0 ? p.cost / p.quantity : 0;
    const actualUnitCost = a.quantity > 0 ? a.cost / a.quantity : 0;
    const volumeVariance = (a.quantity - p.quantity) * planUnitCost;
    const priceVariance = (actualUnitCost - planUnitCost) * a.quantity;
    lines.push({
      materialId: p.materialId,
      type: p.type,
      planQuantity: p.quantity,
      actualQuantity: a.quantity,
      planCost: p.cost,
      actualCost: a.cost,
      totalVariance: a.cost - p.cost,
      volumeVariance,
      priceVariance,
      costed: p.costed && a.costed,
    });
  });

  const total = lines.reduce((acc, l) => ({
    totalVariance: acc.totalVariance + l.totalVariance,
    volumeVariance: acc.volumeVariance + l.volumeVariance,
    priceVariance: acc.priceVariance + l.priceVariance,
  }), { totalVariance: 0, volumeVariance: 0, priceVariance: 0 });

  return { lines, unmatched, total };
};
