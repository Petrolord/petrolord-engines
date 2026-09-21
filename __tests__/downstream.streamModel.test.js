/**
 * Shared stream/fuel data model (Midstream & Downstream DS0).
 *
 * This model exists to make two doctrines structural rather than aspirational:
 * one shape for plan, schedule and actuals, and a carbon ledger that runs
 * beside the money one. Both claims are only worth making if the identities
 * hold, so they are asserted here.
 */
import {
  LEDGER, EVENT_TYPE, UNITS,
  makeMaterial, makeTank, makeEvent,
  signedQuantity, materialBalance, dualLedgerTotals, attributeVariance,
} from '../engines/downstream/streamModel.js';

const ev = (over) => makeEvent({
  id: over.id ?? Math.random().toString(36).slice(2),
  ledger: LEDGER.ACTUAL,
  type: EVENT_TYPE.RECEIPT,
  materialId: 'crude_a',
  quantity: 100,
  ...over,
});

describe('the shapes', () => {
  it('keeps a material identifiable and dense, and its own properties loose', () => {
    const m = makeMaterial({ id: 'pms', name: 'Premium Motor Spirit', kind: 'product', densityKgPerM3: 745, properties: { ron: 91, rvpKpa: 60 } });
    expect(m.id).toBe('pms');
    expect(m.densityKgPerM3).toBe(745);
    expect(m.properties.ron).toBe(91);
  });

  it('carries a tank heel, because working capacity is not capacity', () => {
    const t = makeTank({ id: 'T1', capacityM3: 5000, heelM3: 120 });
    expect(t.capacityM3 - t.heelM3).toBe(4880);
  });

  it('refuses an unknown ledger or event type rather than storing a typo', () => {
    expect(() => makeEvent({ id: 'e', ledger: 'guess', type: EVENT_TYPE.RECEIPT, materialId: 'x', quantity: 1 })).toThrow(/ledger/);
    expect(() => makeEvent({ id: 'e', ledger: LEDGER.PLAN, type: 'teleport', materialId: 'x', quantity: 1 })).toThrow(/event type/);
  });

  it('refuses a negative quantity, since direction comes from the type', () => {
    expect(() => ev({ quantity: -5 })).toThrow(/unsigned/);
  });

  it('keeps an uncosted event null rather than zero', () => {
    // Zero cost and unknown cost are different facts and stay different.
    const e = ev({});
    expect(e.cost).toBeNull();
    expect(ev({ cost: 0 }).cost).toBe(0);
  });
});

describe('material balance', () => {
  it('signs each event by what it does, not by how it was typed', () => {
    expect(signedQuantity(ev({ type: EVENT_TYPE.RECEIPT }))).toBe(100);
    expect(signedQuantity(ev({ type: EVENT_TYPE.DELIVERY }))).toBe(-100);
    expect(signedQuantity(ev({ type: EVENT_TYPE.FLARE }))).toBe(-100);
    // A transfer moves material without creating or destroying it.
    expect(signedQuantity(ev({ type: EVENT_TYPE.TRANSFER }))).toBe(0);
  });

  it('closes opening plus in less out', () => {
    const events = [
      ev({ type: EVENT_TYPE.RECEIPT, quantity: 500 }),
      ev({ type: EVENT_TYPE.DELIVERY, quantity: 300 }),
      ev({ type: EVENT_TYPE.LOSS, quantity: 5 }),
    ];
    const [row] = materialBalance({ events, openingByMaterial: { crude_a: 1000 } });
    expect(row.opening).toBe(1000);
    expect(row.in).toBe(500);
    expect(row.out).toBe(305);
    expect(row.closing).toBe(1195);
  });

  it('names the unaccounted gap rather than absorbing it', () => {
    // A terminal's gain or loss is the whole point of the reconciliation, so
    // a balance that silently agrees with the dips would be useless.
    const events = [ev({ type: EVENT_TYPE.RECEIPT, quantity: 500 })];
    const [row] = materialBalance({
      events,
      openingByMaterial: { crude_a: 100 },
      closingByMaterial: { crude_a: 595 },
    });
    expect(row.closing).toBe(600);
    expect(row.unaccounted).toBe(-5);
  });

  it('reports null rather than zero when no closing stock was measured', () => {
    const [row] = materialBalance({ events: [ev({})], openingByMaterial: {} });
    expect(row.unaccounted).toBeNull();
  });

  it('only counts the ledger it was asked for', () => {
    const events = [
      ev({ ledger: LEDGER.PLAN, quantity: 900 }),
      ev({ ledger: LEDGER.ACTUAL, quantity: 100 }),
    ];
    const [actual] = materialBalance({ events, ledger: LEDGER.ACTUAL });
    expect(actual.in).toBe(100);
    const [plan] = materialBalance({ events, ledger: LEDGER.PLAN });
    expect(plan.in).toBe(900);
  });
});

describe('the dual ledger', () => {
  it('totals money and carbon from the same events', () => {
    const events = [
      ev({ type: EVENT_TYPE.RECEIPT, cost: 5000, emissionsKgCo2e: 0 }),
      ev({ type: EVENT_TYPE.BURN, quantity: 10, cost: 400, emissionsKgCo2e: 3100 }),
      ev({ type: EVENT_TYPE.FLARE, quantity: 2, cost: 0, emissionsKgCo2e: 620 }),
    ];
    const t = dualLedgerTotals(events);
    expect(t.cost).toBe(5400);
    expect(t.emissionsKgCo2e).toBe(3720);
    expect(t.complete).toBe(true);
  });

  it('counts what is missing instead of treating it as free or clean', () => {
    // A total that silently counts an uncosted event as zero is how a plan
    // comes in under budget on paper.
    const events = [
      ev({ type: EVENT_TYPE.RECEIPT, cost: null, emissionsKgCo2e: 0 }),
      ev({ type: EVENT_TYPE.FLARE, quantity: 5, cost: 0, emissionsKgCo2e: null }),
    ];
    const t = dualLedgerTotals(events);
    expect(t.uncostedEvents).toBe(1);
    expect(t.unattributedEmissionEvents).toBe(1);
    expect(t.complete).toBe(false);
  });

  it('does not treat a receipt without emissions as an emissions gap', () => {
    // Only events that emit by their nature count as unattributed.
    const t = dualLedgerTotals([ev({ type: EVENT_TYPE.RECEIPT, cost: 1, emissionsKgCo2e: null })]);
    expect(t.unattributedEmissionEvents).toBe(0);
  });
});

describe('variance attribution', () => {
  // A plan of 1000 bbl at $80, against an actual of 1100 bbl at $85.
  const events = [
    ev({ ledger: LEDGER.PLAN, type: EVENT_TYPE.RECEIPT, quantity: 1000, cost: 80000 }),
    ev({ ledger: LEDGER.ACTUAL, type: EVENT_TYPE.RECEIPT, quantity: 1100, cost: 93500 }),
  ];

  it('splits the gap into volume and price', () => {
    const { lines } = attributeVariance({ events });
    expect(lines).toHaveLength(1);
    const [l] = lines;
    expect(l.totalVariance).toBeCloseTo(13500, 9);
    // 100 extra barrels at the planned $80.
    expect(l.volumeVariance).toBeCloseTo(8000, 9);
    // $5 more per barrel on all 1100 actually taken.
    expect(l.priceVariance).toBeCloseTo(5500, 9);
  });

  it('splits it EXACTLY, which is what makes the split worth reporting', () => {
    // The identity: volume + price = total, with nothing left over. A
    // decomposition with a residual is a reconciliation, not an attribution.
    const { lines } = attributeVariance({ events });
    lines.forEach((l) => {
      expect(l.volumeVariance + l.priceVariance).toBeCloseTo(l.totalVariance, 9);
    });
  });

  it('holds the identity on the totals too', () => {
    const many = [
      ...events,
      ev({ ledger: LEDGER.PLAN, type: EVENT_TYPE.DELIVERY, materialId: 'pms', quantity: 800, cost: 96000 }),
      ev({ ledger: LEDGER.ACTUAL, type: EVENT_TYPE.DELIVERY, materialId: 'pms', quantity: 770, cost: 94500 }),
    ];
    const { total } = attributeVariance({ events: many });
    expect(total.volumeVariance + total.priceVariance).toBeCloseTo(total.totalVariance, 9);
  });

  it('reports an unplanned movement as unmatched rather than as a price effect', () => {
    // An unplanned cargo is not the price of anything.
    const withSurprise = [
      ...events,
      ev({ ledger: LEDGER.ACTUAL, type: EVENT_TYPE.DELIVERY, materialId: 'ago', quantity: 50, cost: 6000 }),
    ];
    const { unmatched } = attributeVariance({ events: withSurprise });
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0].materialId).toBe('ago');
    expect(unmatched[0].presentIn).toBe(LEDGER.ACTUAL);
  });

  it('flags a line whose costs are incomplete rather than pricing it anyway', () => {
    const partial = [
      ev({ ledger: LEDGER.PLAN, type: EVENT_TYPE.RECEIPT, quantity: 100, cost: 8000 }),
      ev({ ledger: LEDGER.ACTUAL, type: EVENT_TYPE.RECEIPT, quantity: 100, cost: null }),
    ];
    const { lines } = attributeVariance({ events: partial });
    expect(lines[0].costed).toBe(false);
  });

  it('does not divide by zero when a plan had no volume', () => {
    const zeroPlan = [
      ev({ ledger: LEDGER.PLAN, type: EVENT_TYPE.RECEIPT, quantity: 0, cost: 0 }),
      ev({ ledger: LEDGER.ACTUAL, type: EVENT_TYPE.RECEIPT, quantity: 100, cost: 8000 }),
    ];
    const { lines } = attributeVariance({ events: zeroPlan });
    expect(Number.isFinite(lines[0].volumeVariance)).toBe(true);
    expect(Number.isFinite(lines[0].priceVariance)).toBe(true);
    expect(lines[0].volumeVariance + lines[0].priceVariance).toBeCloseTo(lines[0].totalVariance, 9);
  });
});

describe('units', () => {
  it('offers the ones the module actually measures in', () => {
    expect(Object.values(UNITS)).toEqual(expect.arrayContaining(['bbl', 'm3', 't', 'MMscf', 'MWh', 'GJ']));
  });
});
