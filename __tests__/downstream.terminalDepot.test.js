/**
 * Terminal and depot operations (DS5).
 *
 * The app's premise is that a terminal with a dip tape and a strapping table
 * is the real case rather than a lesser one, so the tests start from a dip
 * and check that everything downstream of it is honest: the strapping table
 * is not extrapolated, the reconciliation names its gap rather than balancing
 * itself, and the queue says when a rack simply cannot cope.
 */
import {
  volumeAtDip, volumeCorrectionFactor, dipToStandardVolume,
  reconcileStock, trendUnaccounted, rackQueue, tankFarmCover, throughputEconomics,
} from '../engines/downstream/terminalDepot.js';

// A simple linear strapping table: 10 m3 per 100 mm.
const STRAPPING = Array.from({ length: 11 }, (_, i) => ({ heightMm: i * 1000, volumeM3: i * 100 }));

describe('dips and strapping', () => {
  it('interpolates between strapping entries', () => {
    expect(volumeAtDip({ strapping: STRAPPING, heightMm: 2500 }).volumeM3).toBeCloseTo(250, 8);
  });

  it('returns the table value at an entry', () => {
    expect(volumeAtDip({ strapping: STRAPPING, heightMm: 3000 }).volumeM3).toBeCloseTo(300, 8);
  });

  it('refuses to extrapolate above the table', () => {
    // Extrapolating a strapping table invents capacity the tank does not have.
    const out = volumeAtDip({ strapping: STRAPPING, heightMm: 12000 });
    expect(out.volumeM3).toBeNull();
    expect(out.error).toMatch(/invents capacity/);
  });

  it('says when a dip is under the heel rather than returning a negative', () => {
    const out = volumeAtDip({ strapping: STRAPPING, heightMm: -50 });
    expect(out.volumeM3).toBe(0);
    expect(out.note).toMatch(/heel/);
  });

  it('needs a table and a reading', () => {
    expect(volumeAtDip({ strapping: [], heightMm: 100 }).error).toMatch(/No strapping table/);
    expect(volumeAtDip({ strapping: STRAPPING, heightMm: null }).error).toMatch(/No dip reading/);
  });
});

describe('the volume correction factor', () => {
  it('refuses without the published coefficients rather than inventing them', () => {
    const out = volumeCorrectionFactor({ densityKgM3: 840, temperatureC: 30 });
    expect(out.vcf).toBeNull();
    expect(out.error).toMatch(/API MPMS Chapter 11\.1/);
    expect(out.error).toMatch(/does not ship/);
  });

  it('computes the correction when the caller supplies its table row', () => {
    const out = volumeCorrectionFactor({
      densityKgM3: 840, temperatureC: 30, coefficients: { k0: 594.5418, k1: 0, k2: 0 },
    });
    expect(out.error).toBeNull();
    // Warmer than 15 C means the product has expanded, so correcting back to
    // standard must SHRINK it: VCF below one.
    expect(out.vcf).toBeLessThan(1);
    expect(out.vcf).toBeGreaterThan(0.97);
  });

  it('corrects upward below the reference temperature', () => {
    const cold = volumeCorrectionFactor({
      densityKgM3: 840, temperatureC: 5, coefficients: { k0: 594.5418, k1: 0, k2: 0 },
    });
    expect(cold.vcf).toBeGreaterThan(1);
  });

  it('is exactly one at the reference temperature', () => {
    const out = volumeCorrectionFactor({
      densityKgM3: 840, temperatureC: 15, coefficients: { k0: 594.5418, k1: 0, k2: 0 },
    });
    expect(out.vcf).toBeCloseTo(1, 12);
  });

  it('expands a light product more than a heavy one for the same warming', () => {
    const coefficients = { k0: 594.5418, k1: 0, k2: 0 };
    const light = volumeCorrectionFactor({ densityKgM3: 700, temperatureC: 30, coefficients });
    const heavy = volumeCorrectionFactor({ densityKgM3: 950, temperatureC: 30, coefficients });
    expect(light.vcf).toBeLessThan(heavy.vcf);
  });
});

describe('a dip to a standard volume', () => {
  it('subtracts free water, which is not product', () => {
    const out = dipToStandardVolume({ strapping: STRAPPING, heightMm: 5000, waterMm: 200, vcf: 1 });
    expect(out.grossM3).toBeCloseTo(500 - 20, 8);
    expect(out.waterM3).toBeCloseTo(20, 8);
  });

  it('applies the correction to give a standard volume', () => {
    const out = dipToStandardVolume({ strapping: STRAPPING, heightMm: 5000, vcf: 0.99 });
    expect(out.standardM3).toBeCloseTo(500 * 0.99, 8);
  });

  it('still reports gross stock when no correction is available', () => {
    // A terminal that cannot correct to standard still needs its gross stock.
    const out = dipToStandardVolume({ strapping: STRAPPING, heightMm: 5000 });
    expect(out.grossM3).toBeCloseTo(500, 8);
    expect(out.standardM3).toBeNull();
    expect(out.note).toMatch(/only the gross observed volume/);
  });
});

describe('the reconciliation', () => {
  it('closes the day from opening, receipts and deliveries', () => {
    const out = reconcileStock({
      openingM3: 1000, receiptsM3: 500, deliveriesM3: 300, closingDippedM3: 1200,
    });
    expect(out.expectedClosingM3).toBeCloseTo(1200, 8);
    expect(out.unaccountedM3).toBeCloseTo(0, 8);
    expect(out.direction).toBe('balanced');
  });

  it('names the gap rather than balancing itself', () => {
    // Gain and loss is what the operator is judged on. A tool that silently
    // balanced would be worse than useless.
    const out = reconcileStock({
      openingM3: 1000, receiptsM3: 500, deliveriesM3: 300, closingDippedM3: 1196,
    });
    expect(out.unaccountedM3).toBeCloseTo(-4, 8);
    expect(out.direction).toBe('loss');
  });

  it('measures tolerance against throughput, not against stock', () => {
    // Measurement error scales with what moved, not with what is sitting in
    // the tank: 0.5 percent of 800 moved is 4.
    const out = reconcileStock({
      openingM3: 100000, receiptsM3: 500, deliveriesM3: 300, closingDippedM3: 100196,
      tolerancePercentOfThroughput: 0.5,
    });
    expect(out.toleranceM3).toBeCloseTo(4, 8);
    expect(out.withinTolerance).toBe(true);
  });

  it('flags a gap outside tolerance', () => {
    const out = reconcileStock({
      openingM3: 1000, receiptsM3: 500, deliveriesM3: 300, closingDippedM3: 1180,
      tolerancePercentOfThroughput: 0.5,
    });
    expect(out.withinTolerance).toBe(false);
    expect(out.unaccountedPercentOfThroughput).toBeCloseTo(-2.5, 6);
  });

  it('subtracts known losses before calling the rest unaccounted', () => {
    const out = reconcileStock({
      openingM3: 1000, receiptsM3: 500, deliveriesM3: 300, knownLossM3: 5, closingDippedM3: 1195,
    });
    expect(out.unaccountedM3).toBeCloseTo(0, 8);
  });

  it('will not close a day with no closing dip', () => {
    const out = reconcileStock({ openingM3: 1000, receiptsM3: 100, closingDippedM3: null });
    expect(out.unaccountedM3).toBeNull();
    expect(out.note).toMatch(/cannot be closed/);
  });
});

describe('trending the gaps', () => {
  const day = (date, unaccountedM3) => ({ date, unaccountedM3, throughputM3: 800 });

  it('accumulates the gaps', () => {
    const out = trendUnaccounted([day('1', -2), day('2', -3), day('3', 1)]);
    expect(out.cumulativeM3).toBeCloseTo(-4, 8);
    expect(out.rows[2].cumulativeM3).toBeCloseTo(-4, 8);
  });

  it('separates noise from a run, which is the reason to trend at all', () => {
    const noisy = trendUnaccounted([day('1', -2), day('2', 3), day('3', -1), day('4', 2)]);
    expect(noisy.runLength).toBeLessThan(4);
    expect(noisy.prompt).toBeNull();

    const persistent = trendUnaccounted([day('1', -2), day('2', -3), day('3', -1), day('4', -2)]);
    expect(persistent.runLength).toBe(4);
    expect(persistent.runDirection).toBe('loss');
    expect(persistent.prompt).toMatch(/worth investigating/);
  });

  it('reports the mean as a percentage of what moved', () => {
    const out = trendUnaccounted([day('1', -4), day('2', -4)]);
    expect(out.meanPercent).toBeCloseTo((-8 / 1600) * 100, 8);
  });

  it('handles an empty history', () => {
    const out = trendUnaccounted([]);
    expect(out.rows).toEqual([]);
    expect(out.runLength).toBe(0);
  });
});

describe('the loading rack', () => {
  it('gives a waiting time below capacity', () => {
    const out = rackQueue({ arrivalsPerHour: 4, loadMinutes: 20, bays: 2 });
    expect(out.stable).toBe(true);
    expect(out.utilisation).toBeCloseTo((4 / 3) / 2, 8);
    expect(out.averageWaitMinutes).toBeGreaterThan(0);
  });

  it('shows that a busy rack has a queue, not spare capacity', () => {
    // The thing simple capacity arithmetic gets wrong. At 90 percent
    // utilisation a rack does not have 10 percent slack; it has a queue, and
    // the wait is many times what it is at 60 percent.
    const busy = rackQueue({ arrivalsPerHour: 5.4, loadMinutes: 20, bays: 2 });
    const easy = rackQueue({ arrivalsPerHour: 3.6, loadMinutes: 20, bays: 2 });
    expect(busy.utilisation).toBeCloseTo(0.9, 6);
    expect(easy.utilisation).toBeCloseTo(0.6, 6);
    expect(busy.averageWaitMinutes).toBeGreaterThan(easy.averageWaitMinutes * 3);
  });

  it('says plainly when the rack cannot keep up', () => {
    const out = rackQueue({ arrivalsPerHour: 10, loadMinutes: 20, bays: 2 });
    expect(out.stable).toBe(false);
    expect(out.averageWaitMinutes).toBeNull();
    expect(out.error).toMatch(/grows without limit/);
  });

  it('an extra bay cuts the wait sharply near capacity', () => {
    const two = rackQueue({ arrivalsPerHour: 5.4, loadMinutes: 20, bays: 2 });
    const three = rackQueue({ arrivalsPerHour: 5.4, loadMinutes: 20, bays: 3 });
    expect(three.averageWaitMinutes).toBeLessThan(two.averageWaitMinutes / 3);
  });

  it('reports time on site as wait plus load', () => {
    const out = rackQueue({ arrivalsPerHour: 4, loadMinutes: 20, bays: 2 });
    expect(out.averageTimeOnSiteMinutes).toBeCloseTo(out.averageWaitMinutes + 20, 8);
  });

  it('needs an arrival rate and a load time', () => {
    expect(rackQueue({ arrivalsPerHour: 0, loadMinutes: 20, bays: 2 }).error).toBeTruthy();
  });
});

describe('the tank farm', () => {
  const tanks = [
    { capacityM3: 5000, heelM3: 100, stockM3: 3000 },
    { capacityM3: 3000, heelM3: 80, stockM3: 1000 },
  ];

  it('counts working capacity net of the heel', () => {
    // A plan that counts the heel is planning on volume that cannot be pumped.
    const out = tankFarmCover({ tanks, dailyThroughputM3: 400 });
    expect(out.capacityM3).toBe(8000);
    expect(out.workingCapacityM3).toBe(7820);
  });

  it('gives days of cover on pumpable stock', () => {
    const out = tankFarmCover({ tanks, dailyThroughputM3: 400 });
    expect(out.daysOfCover).toBeCloseTo((4000 - 180) / 400, 8);
  });

  it('reports ullage and turns', () => {
    const out = tankFarmCover({ tanks, dailyThroughputM3: 400 });
    expect(out.ullageM3).toBe(4000);
    expect(out.turnsPerYear).toBeCloseTo((400 * 365) / 7820, 8);
  });

  it('returns null rather than infinity with no throughput', () => {
    const out = tankFarmCover({ tanks, dailyThroughputM3: 0 });
    expect(out.daysOfCover).toBeNull();
  });
});

describe('throughput economics and the carbon beside it', () => {
  const base = {
    throughputM3: 10000, feePerM3: 8, variableCostPerM3: 2, fixedCostPerPeriod: 30000,
    lossM3: 15, productDensityKgM3: 840,
  };

  it('reports the margin the fees and costs imply', () => {
    const out = throughputEconomics(base);
    expect(out.revenue).toBeCloseTo(80000, 6);
    expect(out.margin).toBeCloseTo(80000 - 20000 - 30000, 6);
    expect(out.marginPerM3).toBeCloseTo(out.margin / 10000, 8);
  });

  it('computes carbon from the same volumes, when given a factor', () => {
    const out = throughputEconomics({ ...base, lossEmissionFactorKgCo2ePerTonne: 3100 });
    expect(out.lossTonnes).toBeCloseTo(15 * 840 / 1000, 8);
    expect(out.emissionsKgCo2e).toBeCloseTo(out.lossTonnes * 3100, 6);
    expect(out.kgCo2ePerTonneThroughput).toBeGreaterThan(0);
  });

  it('says so rather than inventing a factor', () => {
    // Emission factors are published, versioned data. An invented one would
    // be worse than none.
    const out = throughputEconomics(base);
    expect(out.emissionsKgCo2e).toBeNull();
    expect(out.carbonNote).toMatch(/invented one would be worse than none/);
    // And the money answer still comes out.
    expect(out.margin).toBeGreaterThan(0);
  });
});

describe('missing stays missing', () => {
  // Number(null) is 0 and Number('') is 0, so the obvious numeric coercion
  // turns an absent value into a real zero. A dip nobody read is not an empty
  // tank, and an emission factor nobody supplied is not zero carbon. This
  // class of bug is the reason the whole downstream family uses a strict
  // coercion, and these pin it.

  it('a dip of null is no reading, not a dip of zero', () => {
    expect(volumeAtDip({ strapping: STRAPPING, heightMm: null }).error).toMatch(/No dip reading/);
    expect(volumeAtDip({ strapping: STRAPPING, heightMm: '' }).error).toMatch(/No dip reading/);
    expect(volumeAtDip({ strapping: STRAPPING, heightMm: undefined }).error).toMatch(/No dip reading/);
    // And an actual zero is still a reading.
    expect(volumeAtDip({ strapping: STRAPPING, heightMm: 0 }).volumeM3).toBe(0);
  });

  it('a closing dip of null cannot close the day', () => {
    expect(reconcileStock({ openingM3: 1000, receiptsM3: 100, closingDippedM3: null }).unaccountedM3).toBeNull();
    expect(reconcileStock({ openingM3: 1000, receiptsM3: 100, closingDippedM3: '' }).unaccountedM3).toBeNull();
  });

  it('an emission factor of null is not zero carbon', () => {
    const out = throughputEconomics({
      throughputM3: 100, feePerM3: 5, productDensityKgM3: 840, lossM3: 1,
      lossEmissionFactorKgCo2ePerTonne: null,
    });
    expect(out.emissionsKgCo2e).toBeNull();
    // A real zero factor, on the other hand, means zero.
    const zeroed = throughputEconomics({
      throughputM3: 100, feePerM3: 5, productDensityKgM3: 840, lossM3: 1,
      lossEmissionFactorKgCo2ePerTonne: 0,
    });
    expect(zeroed.emissionsKgCo2e).toBe(0);
  });
});
