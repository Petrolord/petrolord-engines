/**
 * Terminals, depots and fuel supply against independent oracles (MD3-0).
 *
 * Goldens: tools/validation/downstream/oracle_terminaldepot.py (strapping from
 * tank geometry, Erlang C by the exact factorial form, a day ledger) and
 * oracle_fuelpricing.py (a cargo invoice over outturn litres, insurance on CIF
 * by fixed-point iteration, a closed-form FX breakeven, an integer fleet
 * search). Every assertion calls the engine.
 */
import fs from 'fs';
import path from 'path';
import {
  volumeAtDip, dipToStandardVolume, volumeCorrectionFactor, reconcileStock, rackQueue,
  tankFarmCover, throughputEconomics,
} from '../engines/downstream/terminalDepot.js';
import {
  landedCost, buildPumpPrice, marginWaterfall, truckingEconomics, fleetSizing, stationSizing,
  priceSensitivity, IMPORT_TEMPLATE, CHARGE_BASIS, PRICE_ELEMENT_BASIS,
} from '../engines/downstream/fuelPricing.js';

const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'downstream', 'goldens', f), 'utf8'));
const TD = load('terminaldepot_cases.json');
const FP = load('fuelpricing_cases.json');
const rel = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

describe('the goldens, and what they honestly are', () => {
  it('were written by the oracles, with no published rate or coefficient', () => {
    expect(TD.provenance.published).toMatch(/no coefficient table/);
    expect(FP.provenance.published).toMatch(/every rate is synthetic/);
  });
});

describe.each(TD.dips.map((d) => [d.name, d]))('dip: %s', (_n, g) => {
  it('gives the gross volume the tank holds, less its free water', () => {
    const r = dipToStandardVolume({ strapping: g.table, heightMm: g.dip, waterMm: g.water, vcf: null });
    expect(rel(r.grossM3, g.gross, 1e-12)).toBe(true);
    if (g.geometry !== undefined && g.table.length > 13) {
      // a vertical cylinder is linear in height: interpolation IS the geometry
      expect(rel(r.grossM3, g.geometry, 1e-9)).toBe(true);
    }
  });
});

describe.each(TD.refusals.map((d) => [d.name, d]))('refuses: %s', (_n, g) => {
  it('returns no stock and says why', () => {
    const r = dipToStandardVolume({ strapping: g.table, heightMm: g.dip, waterMm: g.water, vcf: 1 });
    expect(r.grossM3).toBeNull();
    expect(r.standardM3).toBeNull();
    expect(r.error).toBeTruthy();
  });
});

describe('the volume correction: its FORM is pinned, and no coefficient is shipped', () => {
  const synthetic = { k0: 600, k1: 0.5, k2: 0 };
  it('is exactly 1 at the 15 C base', () => {
    expect(volumeCorrectionFactor({ densityKgM3: 745, temperatureC: 15, coefficients: synthetic }).vcf).toBe(1);
  });
  it('is the ASTM D1250 form exp(-a dT (1 + 0.8 a dT)), a = K0/rho^2 + K1/rho + K2', () => {
    const rho = 745; const dT = 15;
    const a = 600 / rho ** 2 + 0.5 / rho;
    const r = volumeCorrectionFactor({ densityKgM3: rho, temperatureC: 30, coefficients: synthetic });
    expect(r.alpha).toBeCloseTo(a, 15);
    expect(r.vcf).toBeCloseTo(Math.exp(-a * dT * (1 + 0.8 * a * dT)), 15);
    expect(r.vcf).toBeLessThan(1);
  });
  it('refuses without coefficients', () => {
    expect(volumeCorrectionFactor({ densityKgM3: 745, temperatureC: 30 }).vcf).toBeNull();
  });
});

describe.each(TD.queues.map((q) => [q.name, q]))('rack: %s', (_n, g) => {
  const r = rackQueue({ arrivalsPerHour: g.arrivalsPerHour, loadMinutes: g.loadMinutes, bays: g.bays });
  it('waits as the exact Erlang C says', () => {
    expect(rel(r.probabilityOfWaiting, g.probabilityOfWaiting, 1e-10)).toBe(true);
    expect(rel(r.averageWaitMinutes, g.averageWaitMinutes, 1e-10)).toBe(true);
  });
  it('queues as Little\'s law says', () => expect(rel(r.queueLength, g.queueLength, 1e-10)).toBe(true));
});

describe('rack refusals', () => {
  it('refuses a load time of 0 rather than reporting a perfect rack (MD3-1)', () => {
    expect(rackQueue({ arrivalsPerHour: 5, loadMinutes: 0, bays: 2 }).error).toMatch(/needed/);
  });
  it('refuses 0 bays and a fractional bay rather than solving something else', () => {
    expect(rackQueue({ arrivalsPerHour: 5, loadMinutes: 22, bays: 0 }).error).toMatch(/whole number/);
    expect(rackQueue({ arrivalsPerHour: 5, loadMinutes: 22, bays: 2.5 }).error).toMatch(/whole number/);
  });
});

describe.each(TD.days.map((d) => [d.name, d]))('day: %s', (_n, g) => {
  it('closes the day as the ledger does', () => {
    const r = reconcileStock(g);
    expect(rel(r.expectedClosingM3, g.expectedClosingM3)).toBe(true);
    expect(rel(r.unaccountedM3, g.unaccountedM3)).toBe(true);
    expect(r.withinTolerance).toBe(g.withinTolerance);
    expect(r.direction).toBe(g.direction);
  });
});

describe('the reconciliation cannot close without an opening stock', () => {
  it('refuses a missing opening rather than reading it as an empty tank', () => {
    const r = reconcileStock({ receiptsM3: 800, deliveriesM3: 640, closingDippedM3: 3600 });
    expect(r.unaccountedM3).toBeNull();
    expect(r.error).toMatch(/No opening stock/);
  });
});

describe('the tank farm', () => {
  it('counts pumpable stock and ullage tank by tank', () => {
    const r = tankFarmCover({ tanks: TD.farm.tanks, dailyThroughputM3: TD.farm.dailyThroughputM3 });
    expect(rel(r.pumpableStockM3, TD.farm.pumpableStockM3)).toBe(true);
    expect(rel(r.ullageM3, TD.farm.ullageM3)).toBe(true);
    expect(rel(r.daysOfCover, TD.farm.daysOfCover)).toBe(true);
  });
  it('says nothing about turns without a throughput, as it says nothing about cover (MD3-1)', () => {
    const r = tankFarmCover({ tanks: TD.farm.tanks });
    expect(r.daysOfCover).toBeNull();
    expect(r.turnsPerYear).toBeNull();
  });
  it('refuses a blank throughput or fee and names a blank cost as taken to be zero (MD3-1)', () => {
    expect(throughputEconomics({ throughputM3: '', feePerM3: 8 }).error).toMatch(/Throughput and the throughput fee/);
    expect(throughputEconomics({ throughputM3: 1440, feePerM3: null }).error).toMatch(/Throughput and the throughput fee/);
    expect(throughputEconomics({ throughputM3: 1440, feePerM3: 8, fixedCostPerPeriod: '' }).assumedZero).toEqual(['fixed cost']);
  });
  it('does not weigh a loss with no density as nothing', () => {
    const r = throughputEconomics({ throughputM3: 1440, feePerM3: 8, lossM3: 5, lossEmissionFactorKgCo2ePerTonne: 30 });
    expect(r.lossTonnes).toBeNull();
    expect(r.emissionsKgCo2e).toBeNull();
    expect(r.carbonNote).toMatch(/No product density/);
  });
});

const charges = (rates, insuranceBasis = CHARGE_BASIS.PERCENT_OF_CF) => IMPORT_TEMPLATE.map((c) => ({
  ...c, amount: rates[c.id] ?? null, basis: c.id === 'insurance' ? insuranceBasis : c.basis,
}));
const cargo = { quantity: 37000, quantityUnit: 'tonne', densityKgM3: 745, fobPrice: 700, fobBasis: 'per_tonne', oceanLossPercent: 0.5, fxRate: 1550 };

describe('the landed cost', () => {
  it('is a FLOOR at the page defaults, with every rate blank', () => {
    const r = landedCost({ ...cargo, charges: charges({}) });
    const g = FP.landed.floor;
    expect(r.complete).toBe(false);
    expect(r.missingRates).toHaveLength(IMPORT_TEMPLATE.length);
    expect(rel(r.totalUsd, g.totalUsd, 1e-12)).toBe(true);
    expect(Math.abs(r.perLitreLocal - g.perLitreLocal)).toBeLessThan(1e-4);
    expect(r.basisOfTotal).toMatch(/FLOOR/);
  });

  it('is the invoice over the outturn litres, rates supplied', () => {
    const r = landedCost({ ...cargo, charges: charges(FP.rates) });
    const g = FP.landed.full;
    expect(r.complete).toBe(true);
    expect(Math.abs(r.totalUsd - g.totalUsd)).toBeLessThan(0.01);
    expect(Math.abs(r.cif - g.cif)).toBeLessThan(0.01);
    expect(Math.abs(r.perLitreLocal - g.perLitreLocal)).toBeLessThan(1e-4);
    expect(Math.abs(r.outturn.litres - g.outturnLitres)).toBeLessThan(0.01);
  });

  it('solves insurance quoted on CIF as the fixed point does, instead of charging it on FOB', () => {
    const r = landedCost({ ...cargo, charges: charges(FP.rates, CHARGE_BASIS.PERCENT_OF_CIF) });
    const g = FP.landed.insuranceOnCif;
    const ins = r.lines.find((l) => l.key === 'insurance');
    expect(Math.abs(ins.amount - g.lines.insurance)).toBeLessThan(0.01);
    expect(Math.abs(r.cif - g.cif)).toBeLessThan(0.01);
  });

  it('refuses a freight-stage charge on a value formed after freight, and an unknown stage', () => {
    const bad = [{ id: 'x', label: 'Odd freight', basis: CHARGE_BASIS.PERCENT_OF_CF, stage: 'freight', amount: 1 }];
    expect(landedCost({ ...cargo, charges: bad }).error).toMatch(/not formed until after freight/);
    const lost = [{ id: 'y', label: 'Typo', basis: CHARGE_BASIS.PER_TONNE, stage: 'lnded', amount: 1 }];
    expect(landedCost({ ...cargo, charges: lost }).error).toMatch(/unknown stage/);
  });
});

describe('the truck lane and the fleet, at the page defaults', () => {
  const L = FP.lane.inputs;
  const r = truckingEconomics(L);
  it('costs a trip as the ledger does', () => {
    expect(rel(r.cycleHours, FP.lane.cycleHours, 1e-9)).toBe(true);
    expect(Math.abs(r.costPerTrip - FP.lane.costPerTrip)).toBeLessThan(0.01);
    expect(Math.abs(r.costPerLitreDelivered - FP.lane.costPerLitreDelivered)).toBeLessThan(1e-6);
  });
  it('sizes the fleet as the integer search does', () => {
    const f = fleetSizing({ demandLitresPerDay: FP.fleet.demandLitresPerDay, payloadLitres: L.payloadLitres, tripsPerTruckPerDay: r.tripsPerTruckPerDay });
    expect(f.trucksRequired).toBe(FP.fleet.trucksRequired);
    expect(Math.abs(f.utilisation - FP.fleet.utilisation)).toBeLessThan(1e-5);
  });
  it('names a blank cost box instead of reading it as free', () => {
    const blank = truckingEconomics({ ...L, driverCostPerTrip: '' });
    expect(blank.complete).toBe(false);
    expect(blank.missingInputs).toContain('Driver');
    expect(blank.components.find((c) => c.label === 'Driver').amount).toBeNull();
  });
});

describe('the pump price', () => {
  const els = FP.pump.elements.map(([id, recipient, basis, amount]) => ({
    id, label: id, recipient, amount,
    basis: basis === 'percent_of_running' ? PRICE_ELEMENT_BASIS.PERCENT_OF_RUNNING : PRICE_ELEMENT_BASIS.PER_LITRE,
  }));
  const landedLocal = (fx) => landedCost({ ...cargo, fxRate: fx, charges: charges(FP.rates) }).perLitreLocal;
  it('walks the waterfall to the same price, and groups it by who is paid', () => {
    const p = buildPumpPrice({ landedPerLitre: landedLocal(1550), elements: els });
    expect(Math.abs(p.pricePerLitre - FP.pump.price)).toBeLessThan(1e-3);
    const w = marginWaterfall(p);
    Object.entries(FP.pump.byRecipient).forEach(([rec, v]) => {
      expect(Math.abs(w.groups.find((g) => g.recipient === rec).amountPerLitre - v)).toBeLessThan(1e-3);
    });
  });
  it('finds the exchange rate at which the cap stops covering the chain, where the closed form puts it', () => {
    const s = priceSensitivity({
      price: (fx) => buildPumpPrice({ landedPerLitre: landedLocal(fx), elements: els }).pricePerLitre,
      values: [1000, 1400, 1800, 2200, 2600], capPerLitre: FP.pump.cap,
    });
    expect(s.breakeven.found).toBe(true);
    expect(Math.abs(s.breakeven.value - FP.pump.breakevenFx)).toBeLessThan(0.05);
  });
});

describe('the station, at the page defaults', () => {
  const r = stationSizing({
    dailyThroughputLitres: 60000, peakHourShare: 0.12, litresPerTransaction: 30, dispenseRateLitresPerMinute: 40,
    transactionOverheadMinutes: 1.5, nozzles: 6, tankCapacityLitres: 45000, deadStockLitres: 3000,
    reorderAtFraction: 0.25, deliveryPayloadLitres: 45000,
  });
  it('says the peak is beyond the forecourt, as the exact queue does', () => {
    expect(FP.station.stable).toBe(false);
    expect(r.queue.stable).toBe(false);
    expect(rel(r.queue.offered, FP.station.offered)).toBe(true);
  });
  it('catches the full load that cannot discharge at the reorder level', () => {
    expect(rel(r.ullageAtReorderLitres, FP.station.ullageAtReorderLitres)).toBe(true);
    expect(r.payloadFitsUllage).toBe(FP.station.payloadFitsUllage);
  });
});
