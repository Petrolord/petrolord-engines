/**
 * Fuel pricing and supply chain (DS6).
 *
 * The build-ups are chains of arithmetic where every link is somebody's
 * assumption, so the tests are written as IDENTITIES - the parts sum to the
 * whole, the loss adjustment is a division and not an addition, a missing
 * rate stays missing - rather than as remembered totals. A remembered total
 * only proves the code still does what it did the day it was written.
 */
import {
  cargoQuantities, landedCost, buildPumpPrice, marginWaterfall,
  truckingEconomics, fleetSizing, stationSizing,
  solveCrossing, priceSensitivity,
  CHARGE_BASIS, PRICE_ELEMENT_BASIS, IMPORT_TEMPLATE, PUMP_TEMPLATE,
  RATE_DISCLAIMER, PRODUCT_REFERENCE, LITRES_PER_M3, M3_PER_BBL,
} from '../engines/downstream/fuelPricing.js';

const PMS = 745;

const cargo = {
  quantity: 37000, quantityUnit: 'tonne', densityKgM3: PMS,
  fobPrice: 700, fobBasis: CHARGE_BASIS.PER_TONNE,
};

const ratedCharges = [
  { id: 'freight', label: 'Ocean freight', basis: CHARGE_BASIS.PER_TONNE, stage: 'freight', amount: 40 },
  { id: 'insurance', label: 'Marine insurance', basis: CHARGE_BASIS.PERCENT_OF_CF, stage: 'insurance', amount: 0.1 },
  { id: 'duty', label: 'Import duty', basis: CHARGE_BASIS.PERCENT_OF_CIF, stage: 'landed', amount: 15 },
  { id: 'port', label: 'Port charges', basis: CHARGE_BASIS.PER_TONNE, stage: 'landed', amount: 6 },
  { id: 'finance', label: 'Financing', basis: CHARGE_BASIS.PERCENT_OF_CIF, stage: 'landed', amount: 1.5 },
];

describe('quantities', () => {
  it('converts through density and comes back unchanged', () => {
    const q = cargoQuantities({ quantity: 37000, unit: 'tonne', densityKgM3: PMS });
    expect(q.error).toBeNull();
    // Mass -> volume -> mass is the identity, and it is the conversion that
    // silently costs 20-30% when the density is wrong.
    expect(q.tonnes).toBeCloseTo(37000, 3);
    expect(q.litres).toBeCloseTo(q.m3 * LITRES_PER_M3, 1);
    expect(q.m3).toBeCloseTo((37000 * 1000) / PMS, 3);
  });

  it('agrees across every unit the trade quotes', () => {
    const base = cargoQuantities({ quantity: 1000, unit: 'm3', densityKgM3: PMS });
    const fromLitres = cargoQuantities({ quantity: base.litres, unit: 'litre', densityKgM3: PMS });
    const fromBbl = cargoQuantities({ quantity: base.bbl, unit: 'bbl', densityKgM3: PMS });
    const fromTonnes = cargoQuantities({ quantity: base.tonnes, unit: 'tonne', densityKgM3: PMS });
    [fromLitres, fromBbl, fromTonnes].forEach((q) => expect(q.m3).toBeCloseTo(1000, 3));
  });

  it('uses the defined barrel rather than a rounded one', () => {
    expect(M3_PER_BBL).toBeCloseTo(0.158987294928, 12);
  });

  it('requires a density instead of assuming one', () => {
    expect(cargoQuantities({ quantity: 100, unit: 'tonne' }).error).toMatch(/density/i);
    expect(cargoQuantities({ quantity: 100, unit: 'tonne', densityKgM3: null }).error).toMatch(/density/i);
    expect(cargoQuantities({ quantity: 100, unit: 'tonne', densityKgM3: '' }).error).toMatch(/density/i);
  });

  it('rejects a quantity of nothing and an unknown unit', () => {
    expect(cargoQuantities({ quantity: 0, unit: 'm3', densityKgM3: PMS }).error).toBeTruthy();
    expect(cargoQuantities({ quantity: 10, unit: 'drums', densityKgM3: PMS }).error).toMatch(/unit/i);
  });
});

describe('the landed-cost build-up', () => {
  const run = (over = {}) => landedCost({ ...cargo, charges: ratedCharges, ...over });

  it('walks FOB to C&F to CIF in that order', () => {
    const r = run();
    expect(r.error).toBeNull();
    expect(r.fob).toBeCloseTo(37000 * 700, 2);
    expect(r.cf).toBeCloseTo(r.fob + 37000 * 40, 2);
    expect(r.cif).toBeCloseTo(r.cf * 1.001, 1);
  });

  it('bites percentage charges on the base each one names', () => {
    const r = run();
    const duty = r.lines.find((l) => l.key === 'duty');
    const finance = r.lines.find((l) => l.key === 'finance');
    // Both are percentages of CIF, so their ratio is the ratio of the rates
    // regardless of what CIF turns out to be. That is a check on the base,
    // not on the number.
    expect(duty.amount / finance.amount).toBeCloseTo(15 / 1.5, 6);
    expect(duty.amount).toBeCloseTo(0.15 * r.cif, 2);
  });

  it('does not let one landed-stage charge inflate the base of another', () => {
    // Duty and financing are both % of CIF. Adding a third landed charge
    // must not change either of them.
    const a = run();
    const b = run({ charges: [...ratedCharges, { id: 'x', label: 'Extra', basis: CHARGE_BASIS.PER_CARGO, stage: 'landed', amount: 500000 }] });
    const dutyA = a.lines.find((l) => l.key === 'duty').amount;
    const dutyB = b.lines.find((l) => l.key === 'duty').amount;
    expect(dutyB).toBeCloseTo(dutyA, 2);
    expect(b.totalUsd).toBeCloseTo(a.totalUsd + 500000, 2);
  });

  it('sums its lines to its total', () => {
    const r = run();
    const sum = r.lines.reduce((s, l) => s + l.amount, 0);
    expect(sum).toBeCloseTo(r.totalUsd, 1);
  });

  it('divides by the outturn rather than adding the loss', () => {
    const clean = run({ oceanLossPercent: 0 });
    const lossy = run({ oceanLossPercent: 0.5 });
    // Same money, less product. The cost per sellable litre therefore rises
    // by 1/(1-0.005), not by 1.005 - the mistake this asserts against.
    expect(lossy.totalUsd).toBeCloseTo(clean.totalUsd, 2);
    expect(lossy.perLitreUsd).toBeCloseTo(clean.perLitreUsd / 0.995, 6);
    expect(lossy.perLitreUsd).not.toBeCloseTo(clean.perLitreUsd * 1.005, 6);
    expect(lossy.outturn.litres).toBeCloseTo(clean.outturn.litres * 0.995, 1);
  });

  it('per-litre lines reconcile to the per-litre total', () => {
    const r = run({ oceanLossPercent: 0.5 });
    const sum = r.lines.reduce((s, l) => s + l.perLitre, 0);
    expect(sum).toBeCloseTo(r.perLitreUsd, 6);
  });

  it('converts to local money only when a rate is supplied', () => {
    expect(run().perLitreLocal).toBeNull();
    const r = run({ fxRate: 1550 });
    expect(r.perLitreLocal).toBeCloseTo(r.perLitreUsd * 1550, 3);
  });

  it('reports a missing rate as required and calls the total a floor', () => {
    const r = run({ charges: [...ratedCharges, { id: 'nimasa', label: 'Statutory levy', basis: CHARGE_BASIS.PER_TONNE, stage: 'landed', amount: null }] });
    expect(r.complete).toBe(false);
    expect(r.missingRates).toContain('Statutory levy');
    expect(r.basisOfTotal).toMatch(/floor/i);
    // The line is present and visible, not dropped.
    expect(r.lines.find((l) => l.key === 'nimasa').required).toBe(true);
  });

  it('refuses without an FOB price or a quantity', () => {
    expect(landedCost({ ...cargo, fobPrice: null, charges: [] }).error).toMatch(/FOB/i);
    expect(landedCost({ ...cargo, quantity: null, charges: [] }).error).toMatch(/quantity/i);
  });
});

describe('the pump-price build-up', () => {
  const elements = [
    { id: 'depot', label: 'Depot margin', basis: PRICE_ELEMENT_BASIS.PER_LITRE, amount: 12, recipient: 'Terminal' },
    { id: 'transport', label: 'Transport', basis: PRICE_ELEMENT_BASIS.PER_LITRE, amount: 18, recipient: 'Transporter' },
    { id: 'marketer', label: 'Marketer margin', basis: PRICE_ELEMENT_BASIS.PER_LITRE, amount: 15, recipient: 'Marketer' },
    { id: 'dealer', label: 'Dealer margin', basis: PRICE_ELEMENT_BASIS.PER_LITRE, amount: 20, recipient: 'Dealer' },
    { id: 'levy', label: 'Levy', basis: PRICE_ELEMENT_BASIS.PERCENT_OF_LANDED, amount: 2, recipient: 'Government' },
  ];

  it('reconciles the waterfall to the price exactly', () => {
    const r = buildPumpPrice({ landedPerLitre: 700, elements });
    const sum = r.lines.reduce((s, l) => s + l.amount, 0);
    expect(sum).toBeCloseTo(r.pricePerLitre, 6);
    expect(r.lines.reduce((s, l) => s + l.share, 0)).toBeCloseTo(1, 6);
  });

  it('runs the running subtotal forward, so order matters where it should', () => {
    const vat = { id: 'vat', label: 'VAT', basis: PRICE_ELEMENT_BASIS.PERCENT_OF_RUNNING, amount: 7.5, recipient: 'Government' };
    const first = buildPumpPrice({ landedPerLitre: 700, elements: [vat, ...elements] });
    const last = buildPumpPrice({ landedPerLitre: 700, elements: [...elements, vat] });
    // A percentage of everything below it is not the same number when it
    // sits at the top. The model must reflect that rather than hide it.
    expect(last.pricePerLitre).toBeGreaterThan(first.pricePerLitre);
    const lastVat = last.lines.find((l) => l.key === 'vat');
    expect(lastVat.amount).toBeCloseTo(0.075 * (last.pricePerLitre / 1.075), 4);
  });

  it('percent-of-landed does not move when other elements move', () => {
    const a = buildPumpPrice({ landedPerLitre: 700, elements });
    const b = buildPumpPrice({ landedPerLitre: 700, elements: elements.map((e) => (e.id === 'dealer' ? { ...e, amount: 60 } : e)) });
    expect(b.lines.find((l) => l.key === 'levy').amount)
      .toBeCloseTo(a.lines.find((l) => l.key === 'levy').amount, 6);
  });

  it('names the shortfall when a cap sits below the chain', () => {
    const r = buildPumpPrice({ landedPerLitre: 700, elements, capPerLitre: 750 });
    expect(r.capCoversChain).toBe(false);
    // The cap does not make the cost go away; it moves it onto somebody.
    expect(r.shortfallPerLitre).toBeCloseTo(r.pricePerLitre - 750, 4);
    expect(r.shortfallPerLitre).toBeGreaterThan(0);
  });

  it('reports a cap that does cover the chain', () => {
    const r = buildPumpPrice({ landedPerLitre: 700, elements, capPerLitre: 2000 });
    expect(r.capCoversChain).toBe(true);
    expect(r.shortfallPerLitre).toBeLessThan(0);
  });

  it('calls an incomplete build-up a floor', () => {
    const r = buildPumpPrice({ landedPerLitre: 700, elements: [...elements, { id: 'new', label: 'New levy', basis: PRICE_ELEMENT_BASIS.PER_LITRE, amount: null }] });
    expect(r.complete).toBe(false);
    expect(r.basisOfPrice).toMatch(/floor/i);
    expect(r.missingRates).toContain('New levy');
  });

  it('refuses without a landed cost', () => {
    expect(buildPumpPrice({ landedPerLitre: null, elements }).error).toMatch(/landed/i);
  });
});

describe('the margin waterfall', () => {
  const built = buildPumpPrice({
    landedPerLitre: 700,
    elements: [
      { id: 'a', label: 'Depot', basis: PRICE_ELEMENT_BASIS.PER_LITRE, amount: 12, recipient: 'Terminal' },
      { id: 'b', label: 'Transport', basis: PRICE_ELEMENT_BASIS.PER_LITRE, amount: 18, recipient: 'Transporter' },
      { id: 'c', label: 'Levy', basis: PRICE_ELEMENT_BASIS.PER_LITRE, amount: 10, recipient: 'Government' },
      { id: 'd', label: 'VAT', basis: PRICE_ELEMENT_BASIS.PER_LITRE, amount: 5, recipient: 'Government' },
      { id: 'e', label: 'Unnamed', basis: PRICE_ELEMENT_BASIS.PER_LITRE, amount: 4 },
    ],
  });

  it('groups by recipient and still sums to the price', () => {
    const w = marginWaterfall(built);
    const sum = w.groups.reduce((s, g) => s + g.amountPerLitre, 0);
    expect(sum).toBeCloseTo(built.pricePerLitre, 4);
    expect(w.groups.reduce((s, g) => s + g.share, 0)).toBeCloseTo(1, 5);
  });

  it('adds the two government lines together', () => {
    const gov = marginWaterfall(built).groups.find((g) => g.recipient === 'Government');
    expect(gov.amountPerLitre).toBeCloseTo(15, 6);
    expect(gov.lines).toEqual(['Levy', 'VAT']);
  });

  it('leaves an unlabelled element unattributed rather than guessing', () => {
    const un = marginWaterfall(built).groups.find((g) => g.recipient === 'Unattributed');
    expect(un.amountPerLitre).toBeCloseTo(4, 6);
  });

  it('puts the product itself in its own group', () => {
    const p = marginWaterfall(built).groups.find((g) => g.recipient === 'Product (landed)');
    expect(p.amountPerLitre).toBeCloseTo(700, 6);
  });
});

describe('trucking economics', () => {
  const lane = {
    distanceKm: 400, payloadLitres: 45000, averageSpeedKmh: 40,
    loadHours: 2, dischargeHours: 1.5, queueHours: 1,
    fuelConsumptionLPer100Km: 38, dieselPricePerLitre: 1150,
    driverCostPerTrip: 60000, maintenancePerKm: 45, tyresPerKm: 25,
    overheadPerTrip: 40000, tollsAndLeviesPerTrip: 25000,
    truckCapitalCost: 90000000, truckLifeYears: 8,
    workingHoursPerDay: 12, workingDaysPerYear: 300,
  };

  it('derives the cycle from the round trip, not from an assumption', () => {
    const r = truckingEconomics(lane);
    expect(r.roundTripKm).toBeCloseTo(800, 6);
    expect(r.cycleHours).toBeCloseTo(800 / 40 + 2 + 1.5 + 1, 6);
    expect(r.tripsPerTruckPerDay).toBeCloseTo(12 / r.cycleHours, 6);
  });

  it('burns fuel on the return leg whether or not it is loaded', () => {
    const loaded = truckingEconomics({ ...lane, backhaulLoaded: true });
    const empty = truckingEconomics({ ...lane, backhaulLoaded: false });
    expect(loaded.dieselLitresPerTrip).toBeCloseTo(empty.dieselLitresPerTrip, 6);
    expect(loaded.dieselLitresPerTrip).toBeCloseTo((38 / 100) * 800, 4);
  });

  it('sums its components to the cost per trip', () => {
    const r = truckingEconomics(lane);
    const sum = r.components.reduce((s, c) => s + c.amount, 0);
    expect(sum).toBeCloseTo(r.costPerTrip, 1);
  });

  it('spreads capital over the cycle it derived, so a slow lane carries more', () => {
    const fast = truckingEconomics({ ...lane, averageSpeedKmh: 60 });
    const slow = truckingEconomics({ ...lane, averageSpeedKmh: 25 });
    const dep = (r) => r.components.find((c) => c.label === 'Truck depreciation').amount;
    expect(dep(slow)).toBeGreaterThan(dep(fast));
    // And the identity behind it: capex over life over the trips derived.
    expect(dep(fast)).toBeCloseTo(90000000 / (8 * fast.tripsPerTruckPerYear), 0);
  });

  it('divides cost by what is delivered, not by what was loaded', () => {
    const clean = truckingEconomics(lane);
    const lossy = truckingEconomics({ ...lane, transitLossPercent: 1 });
    expect(lossy.costPerTrip).toBeCloseTo(clean.costPerTrip, 2);
    expect(lossy.costPerLitreDelivered).toBeCloseTo(clean.costPerLitreDelivered / 0.99, 6);
  });

  it('longer lane costs more per litre, which is why bridging exists', () => {
    const near = truckingEconomics({ ...lane, distanceKm: 40 });
    const far = truckingEconomics({ ...lane, distanceKm: 800 });
    expect(far.costPerLitreDelivered).toBeGreaterThan(near.costPerLitreDelivered);
  });

  it('leaves carbon absent when no emission factor is supplied', () => {
    const r = truckingEconomics(lane);
    expect(r.kgCo2ePerTrip).toBeNull();
    expect(r.kgCo2ePerLitreDelivered).toBeNull();
    expect(r.carbonNote).toMatch(/absent rather than zero/i);
    const withEf = truckingEconomics({ ...lane, dieselEmissionFactorKgCo2ePerLitre: 2.68 });
    expect(withEf.kgCo2ePerTrip).toBeCloseTo(withEf.dieselLitresPerTrip * 2.68, 2);
    expect(withEf.carbonNote).toBeNull();
  });

  it('names a missing input rather than costing it at zero', () => {
    const r = truckingEconomics({ ...lane, dieselPricePerLitre: null, truckCapitalCost: null });
    expect(r.complete).toBe(false);
    expect(r.missingInputs).toEqual(expect.arrayContaining(['Diesel', 'Truck depreciation']));
    expect(r.components.find((c) => c.label === 'Diesel').amount).toBeNull();
  });

  it('refuses an impossible lane', () => {
    expect(truckingEconomics({ ...lane, averageSpeedKmh: 0 }).error).toBeTruthy();
    expect(truckingEconomics({ ...lane, payloadLitres: null }).error).toBeTruthy();
  });
});

describe('fleet sizing', () => {
  it('rounds up, because a fraction of a truck does not exist', () => {
    const r = fleetSizing({ demandLitresPerDay: 180000, payloadLitres: 45000, tripsPerTruckPerDay: 0.7 });
    expect(r.tripsNeededPerDay).toBeCloseTo(4, 6);
    expect(r.trucksRequired).toBe(Math.ceil(4 / 0.7));
    expect(Number.isInteger(r.trucksRequired)).toBe(true);
  });

  it('reports the spare the rounding bought', () => {
    const r = fleetSizing({ demandLitresPerDay: 180000, payloadLitres: 45000, tripsPerTruckPerDay: 0.7 });
    expect(r.fleetTripCapacityPerDay).toBeCloseTo(r.trucksRequired * 0.7, 6);
    expect(r.spareTripsPerDay).toBeCloseTo(r.fleetTripCapacityPerDay - r.tripsNeededPerDay, 6);
    expect(r.utilisation).toBeCloseTo(r.tripsNeededPerDay / r.fleetTripCapacityPerDay, 6);
    expect(r.spareLitresPerDay).toBeCloseTo(r.spareTripsPerDay * 45000, 3);
  });

  it('is exactly full when the demand divides evenly', () => {
    const r = fleetSizing({ demandLitresPerDay: 90000, payloadLitres: 45000, tripsPerTruckPerDay: 1 });
    expect(r.trucksRequired).toBe(2);
    expect(r.utilisation).toBeCloseTo(1, 6);
    expect(r.spareTripsPerDay).toBeCloseTo(0, 6);
  });

  it('refuses nonsense', () => {
    expect(fleetSizing({ demandLitresPerDay: 0, payloadLitres: 45000, tripsPerTruckPerDay: 1 }).error).toBeTruthy();
  });
});

describe('station sizing', () => {
  const station = {
    dailyThroughputLitres: 60000, peakHourShare: 0.12,
    litresPerTransaction: 30, dispenseRateLitresPerMinute: 40,
    transactionOverheadMinutes: 1.5, nozzles: 6,
    tankCapacityLitres: 45000, deadStockLitres: 3000, reorderAtFraction: 0.25,
    deliveryPayloadLitres: 33000,
  };

  it('derives peak-hour demand and service time', () => {
    const r = stationSizing(station);
    expect(r.transactionsPerDay).toBeCloseTo(2000, 3);
    expect(r.peakTransactionsPerHour).toBeCloseTo(240, 3);
    expect(r.serviceMinutesPerTransaction).toBeCloseTo(30 / 40 + 1.5, 6);
  });

  it('uses the DS5 rack queue rather than a second one', () => {
    const r = stationSizing(station);
    expect(r.queue).toBeDefined();
    expect(r.queue.utilisation).toBeCloseTo(
      (r.peakTransactionsPerHour * (r.serviceMinutesPerTransaction / 60)) / 6, 4,
    );
  });

  it('says an oversubscribed forecourt has an unbounded queue', () => {
    const r = stationSizing({ ...station, nozzles: 2 });
    expect(r.queue.stable).toBe(false);
    expect(r.queue.averageWaitMinutes).toBeNull();
  });

  it('counts cover on usable stock, not on tank capacity', () => {
    const r = stationSizing(station);
    expect(r.usableTankLitres).toBeCloseTo(42000, 3);
    expect(r.coverDays).toBeCloseTo(42000 / 60000, 6);
  });

  it('catches the load that cannot fit the ullage', () => {
    const r = stationSizing(station);
    // Reorder at 25% of usable leaves 3000 + 10500 in the tank, so ullage is
    // 31500 and a 33000 litre load does not fit. This is an arithmetic check
    // nobody does until the truck is on the forecourt.
    expect(r.ullageAtReorderLitres).toBeCloseTo(31500, 3);
    expect(r.payloadFitsUllage).toBe(false);
    expect(r.ullageWarning).toMatch(/cannot discharge/i);
  });

  it('is quiet when the load does fit', () => {
    const r = stationSizing({ ...station, deliveryPayloadLitres: 20000 });
    expect(r.payloadFitsUllage).toBe(true);
    expect(r.ullageWarning).toBeNull();
  });

  it('leaves tankage absent when no tank is described', () => {
    const r = stationSizing({ ...station, tankCapacityLitres: null, deliveryPayloadLitres: null });
    expect(r.usableTankLitres).toBeNull();
    expect(r.coverDays).toBeNull();
    expect(r.payloadFitsUllage).toBeNull();
    expect(r.queue).toBeDefined();
  });

  it('refuses without the demand it needs', () => {
    expect(stationSizing({ ...station, dailyThroughputLitres: null }).error).toBeTruthy();
  });
});

describe('what breaks the price', () => {
  const chain = (fx) => {
    const l = landedCost({ ...cargo, charges: ratedCharges, oceanLossPercent: 0.5, fxRate: fx });
    return buildPumpPrice({
      landedPerLitre: l.perLitreLocal,
      elements: [
        { id: 'depot', label: 'Depot', basis: PRICE_ELEMENT_BASIS.PER_LITRE, amount: 12 },
        { id: 'dealer', label: 'Dealer', basis: PRICE_ELEMENT_BASIS.PER_LITRE, amount: 20 },
      ],
    }).pricePerLitre;
  };

  it('finds the exchange rate at which a cap stops covering the chain', () => {
    const cap = 900;
    const s = priceSensitivity({ price: chain, values: [800, 1200, 1600, 2000], capPerLitre: cap });
    expect(s.breakeven.found).toBe(true);
    // The breakeven is the definition, so it is checked by evaluating there.
    expect(chain(s.breakeven.value)).toBeCloseTo(cap, 2);
    expect(s.points[0].covered).toBe(true);
    expect(s.points[s.points.length - 1].covered).toBe(false);
  });

  it('says there is no crossing rather than inventing one', () => {
    const s = priceSensitivity({ price: chain, values: [800, 900, 1000], capPerLitre: 100000 });
    expect(s.breakeven.found).toBe(false);
    expect(s.breakeven.reason).toMatch(/no crossing/i);
  });

  it('reports the shortfall at each point', () => {
    const s = priceSensitivity({ price: chain, values: [1600], capPerLitre: 900 });
    expect(s.points[0].shortfallPerLitre).toBeCloseTo(s.points[0].pricePerLitre - 900, 4);
  });

  it('leaves the cap comparison absent when there is no cap', () => {
    const s = priceSensitivity({ price: chain, values: [1600] });
    expect(s.points[0].covered).toBeNull();
    expect(s.breakeven).toBeNull();
  });

  it('bisects a monotone function to its root', () => {
    const r = solveCrossing({ evaluate: (x) => x * x - 2, lo: 0, hi: 5 });
    expect(r.found).toBe(true);
    expect(r.value).toBeCloseTo(Math.SQRT2, 5);
  });

  it('rejects a bracket that is not an interval', () => {
    expect(solveCrossing({ evaluate: (x) => x, lo: 5, hi: 1 }).found).toBe(false);
  });
});

describe('the templates', () => {
  it('ship line items and no rates', () => {
    [...IMPORT_TEMPLATE, ...PUMP_TEMPLATE].forEach((l) => {
      expect(l.label).toBeTruthy();
      expect(l.basis).toBeTruthy();
      // A shipped rate would be read as authority and would go stale in
      // silence. The whole point of the template is the shape.
      expect(l.amount).toBeNull();
    });
  });

  it('carry the disclaimer as data so it travels with a copy', () => {
    expect(RATE_DISCLAIMER).toMatch(/regulation in force/i);
    expect(RATE_DISCLAIMER).toMatch(/required input/i);
  });

  it('produce an incomplete build-up straight out of the box', () => {
    const r = landedCost({ ...cargo, charges: IMPORT_TEMPLATE });
    expect(r.complete).toBe(false);
    expect(r.missingRates.length).toBe(IMPORT_TEMPLATE.length);
    expect(r.basisOfTotal).toMatch(/floor/i);
  });

  it('label reference densities as typical with their range', () => {
    PRODUCT_REFERENCE.forEach((p) => {
      expect(p.typicalDensityKgM3).toBeGreaterThan(0);
      expect(p.range).toMatch(/\d+-\d+/);
    });
  });
});

describe('missing stays missing', () => {
  it('does not read an absent rate as a zero rate', () => {
    const withZero = landedCost({ ...cargo, charges: [{ id: 'd', label: 'Duty', basis: CHARGE_BASIS.PERCENT_OF_CIF, stage: 'landed', amount: 0 }] });
    const withNull = landedCost({ ...cargo, charges: [{ id: 'd', label: 'Duty', basis: CHARGE_BASIS.PERCENT_OF_CIF, stage: 'landed', amount: null }] });
    // The totals coincide - there is nothing else to add - but only one of
    // them is a cost. The other is a floor, and says so.
    expect(withZero.complete).toBe(true);
    expect(withNull.complete).toBe(false);
    expect(withZero.lines[1].amount).toBe(0);
    expect(withNull.lines[1].amount).toBeNull();
  });

  it('treats the empty string as absent, not as zero', () => {
    ['', null, undefined].forEach((v) => {
      const r = buildPumpPrice({ landedPerLitre: 700, elements: [{ id: 'x', label: 'X', basis: PRICE_ELEMENT_BASIS.PER_LITRE, amount: v }] });
      expect(r.complete).toBe(false);
      expect(r.lines[1].amount).toBeNull();
    });
    expect(buildPumpPrice({ landedPerLitre: '', elements: [] }).error).toBeTruthy();
  });
});
