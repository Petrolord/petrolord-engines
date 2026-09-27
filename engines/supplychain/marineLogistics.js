/**
 * Offshore and marine logistics (Supply Chain SC4): voyage planning with the
 * binding capacity constraint named, supply vessel (PSV/AHTS) fleet sizing,
 * deck-space planning by a stated packing rule, shore base berth queues from
 * a cited queueing model, and fleet variability through the canonical Monte
 * Carlo. All deterministic.
 *
 * Pure functions, no I/O. Every function returns either a result object
 * carrying a `basis` (the rules applied and where they come from, so a course
 * can print the working) or `{ error, field }`, where `field` names the input
 * refused and the message starts with that name and states the exact
 * condition that failed.
 *
 * No hidden defaults: every speed, distance, time, capacity, fraction, fuel
 * rate, price, weather factor and rounding rule is a required stated input.
 * The only constants are the caps in DEFAULTS and the tie rule.
 *
 * Sources (FINDINGS-marine.md has URLs, editions, licences and the dates read):
 *   Adan & Resing   I. Adan and J. Resing, Queueing Systems (lecture notes,
 *                   Eindhoven University of Technology, 26 March 2015):
 *                   chapter 5 (M/M/c: eq. 5.1 delay probability, 5.2 mean
 *                   queue length, 5.3 mean waiting time; Tables 5.1, 5.2),
 *                   section 3.4 (Little's law), section 7.6 (the
 *                   Pollaczek-Khinchin mean value formula, eqs 7.14 to 7.16),
 *                   section 11.3 (the stable Erlang B recursion 11.3 and
 *                   remark 11.3.2, the delay probability from it).
 *   Iversen         V. B. Iversen, Teletraffic Engineering Handbook (ITU-D
 *                   SG 2/16 and ITC, draft 20 June 2001), section 12.2
 *                   (Erlang's C formula) and Example 12.3.1.
 *   Cosmetatos      G. Cosmetatos (1975), approximate explicit formula for the
 *                   average queueing time in M/D/r, INFOR 13, 328-331, as
 *                   printed in eq. (2) of Liu, Pantelidis, Tam and Chow, An
 *                   electric vehicle charging station access equilibrium model
 *                   with M/D/C queueing (arXiv 2102.05851v2, CC BY 4.0).
 *   Skoko et al.    I. Skoko, Z. Lusic, Z. Sanchez-Varela and Z. Boko (2024),
 *                   Optimization Model for Selection of the Offshore Fleet
 *                   Structure, J. Mar. Sci. Eng. 12(2), 263 (CC BY 4.0):
 *                   Tables 1, 4, 5 and 7 (fuel by activity at t/h x 24 x days x
 *                   price; hire and port fee by the day; daily distance at the
 *                   economic speed).
 *   Aas et al.      B. Aas, O. Halskau and S. W. Wallace (2009), The role of
 *                   supply vessels in offshore logistics, Maritime Economics &
 *                   Logistics 11, 302-325 (accepted manuscript, Lancaster
 *                   EPrints 45409): deck cargo in square metres with no
 *                   stacking of containers or baskets, bulk in segregated
 *                   tanks, economical speed, weather limits on sailing and on
 *                   offshore loading. Taught by concept.
 *   FFD             D. S. Johnson (1973), Near-optimal bin packing algorithms
 *                   (MIT PhD thesis): first-fit decreasing; the capacity 60
 *                   and 61 example of Coffman, Garey and Johnson (1978) and
 *                   Dosa's (2007) tight example, as printed in Wikipedia,
 *                   First-fit-decreasing bin packing (CC BY-SA 4.0).
 *
 * Conventions, stated once:
 *   units       distances in nautical miles, speeds in knots (nautical miles
 *               an hour), times in hours unless a name says days, areas in
 *               m2, weights in tonnes, bulk volumes in m3, fuel in tonnes,
 *               money in one currency whatever unit the caller uses.
 *   ties        two figures TIE when they agree to 12 significant digits
 *               (Number(x.toPrecision(12))). A count rounded up is
 *               Math.ceil of that 12-digit figure, so 3.0000000000000004
 *               voyages is 3; a capacity check passes when the 12-digit
 *               figure of the load is at or below that of the capacity.
 *   binding     the constraint with the highest utilisation; a tie goes to
 *               the first in the stated order: deck area, deck load,
 *               deadweight, then each tank in the order of `products`.
 *   weather     one stated factor (at least 1) multiplies the time of each
 *               stated activity (sailing, port, field); fuel follows time.
 *   Monte Carlo lib/stats mulberry32(seed), one stream; per iteration the
 *               weather factor draw comes first, then the demand factor
 *               draw, each only when it varies; each value is the triangular
 *               inverse CDF of its uniform (lib/stats triInvCDF). Summaries by
 *               lib/stats basicStats: P90 is the 10th percentile of the sorted
 *               values (index floor(0.1 n)), P50 floor(0.5 n), P10
 *               floor(0.9 n), the exceedance labels of
 *               lib/conventions/percentile.js. For a requirement or a cost
 *               P90 is the LOW figure and P10 the HIGH one.
 *   reasons     money prints rounded to the cent and a computed quantity to
 *               6 decimal places (both half away from zero, trailing zeros
 *               dropped); stated inputs print as given. A printed bound is
 *               rounded toward the accepted side.
 *
 * Validation: tools/validation/supplychain/oracle_marine.py (stdlib python)
 * writes test-data/supplychain/goldens/marine_cases.json; FINDINGS text,
 * negcontrol_marine.sh, timing_marine.js. Fixtures (synthetic Ekene offshore
 * cluster): test-data/supplychain/ekene-marine/.
 */

import { mulberry32, triInvCDF, basicStats } from '../../lib/stats/stats.js';
import { EXCEEDANCE_DEFINITION } from '../../lib/conventions/percentile.js';

export const DEFAULTS = Object.freeze({
  TIE_DIGITS: 12,
  MAX_INSTALLATIONS: 50,
  MAX_PRODUCTS: 20,
  MAX_ITEM_LINES: 500,
  MAX_UNITS: 2000,
  MAX_QUANTITY: 1000,
  MAX_DECK_VOYAGES: 500,
  MAX_BERTHS: 100,
  MAX_WEATHER_FACTOR: 10,
  MAX_ITERATIONS: 200000,
  MAX_DRAWS: 2000000,
});

export const ACTIVITIES = Object.freeze(['sailing', 'port', 'field']);

const CITE = Object.freeze({
  voyage: 'sailing hours = distance / speed (Skoko et al. 2024: 10 knots is 240 nautical miles a day); fuel = hours in each activity x the stated tonnes an hour; fuel cost = tonnes x price (Skoko et al. 2024, Tables 1, 4 and 7)',
  capacity: 'Aas, Halskau and Wallace (2009): deck cargo is measured in square metres and is not stacked; bulk travels in segregated tanks (taught by concept)',
  fleet: 'voyages a period = the largest of demand / capacity per constraint and the minimum visits; vessel-days = voyages x voyage days; vessels = vessel-days / available days a vessel, by the stated rounding rule',
  ffd: 'Johnson (1973) first-fit decreasing; Coffman, Garey and Johnson (1978) example as printed in Wikipedia, First-fit-decreasing bin packing (CC BY-SA 4.0)',
  mmc: 'Adan and Resing, Queueing Systems (2015): eq. (5.1) delay probability, computed by the stable recursion (11.3) and remark 11.3.2; eq. (5.2) E(Lq) = PiW rho / (1 - rho); eq. (5.3) E(W) = PiW / ((1 - rho) c mu); Little\'s law (section 3.4)',
  mdc: 'Cosmetatos (1975), INFOR 13, 328-331, as printed in Liu, Pantelidis, Tam and Chow (arXiv 2102.05851v2) eq. (2): Wq(M/D/c) = Wq(M/M/c) / 2 x (1 + (1 - rho)(c - 1)(sqrt(4 + 5c) - 2) / (16 rho c)); an approximation, exact at c = 1 where it is the Pollaczek-Khinchin mean value formula (Adan and Resing 2015, eqs 7.14 to 7.16)',
});

// ---- helpers ---------------------------------------------------------------

const refuse = (field, message) => ({ error: `${field} ${message}`, field });
const fmt = (x) => String(x);
const show = (v) => (v === undefined ? 'nothing' : typeof v === 'number' ? fmt(v) : typeof v === 'string' ? `"${v}"` : JSON.stringify(v));
const must = (field, cond, v) => refuse(field, `must be ${cond}; got ${show(v)}`);
const money = (x) => fmt(Number(x.toFixed(2)));
const dec = (x) => fmt(Number(x.toFixed(6)));
const pct = (x) => `${dec(100 * x)}%`;
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
// a figure printed with its unit in agreement: 1 hour, 0.5 hours, 2 hours
const unitOf = (printed, x, one, many = `${one}s`) => `${printed} ${x === 1 ? one : many}`;
const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const key12 = (x) => Number(x.toPrecision(DEFAULTS.TIE_DIGITS));
const ceil12 = (x) => Math.ceil(key12(x));
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sum = (xs) => xs.reduce((s, v) => s + v, 0);
const first = (...checks) => checks.find((c) => c) || null;

// A printed bound (a maximum a refusal names) is the 6-decimal figure nearest
// the exact bound on the ACCEPTED side, checked with the refusal's own rule
// `ok`, so typing the printed figure back passes. The note says so when the
// printed figure differs from the exact bound.
const boundMax = (x, ok) => {
  let k = Math.floor(x * 1e6);
  while (ok((k + 1) / 1e6)) k += 1;
  while (!ok(k / 1e6)) k -= 1;
  const v = k / 1e6;
  return v === x ? fmt(v) : `${fmt(v)} (rounded down at the sixth decimal so that it is accepted)`;
};

const nonNeg = (field, v) => (fin(v) && v >= 0 ? null : must(field, 'a finite number at or above 0', v));
const positive = (field, v) => (fin(v) && v > 0 ? null : must(field, 'a finite number above 0', v));
const fraction = (field, v) => (fin(v) && v > 0 && v <= 1 ? null : must(field, 'a number above 0 and at most 1', v));
const intIn = (field, v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? null : must(field, `a whole number from ${lo} to ${hi}`, v));
const oneOf = (field, v, opts) => (opts.includes(v) ? null : must(field, `one of ${opts.map((o) => `"${o}"`).join(', ')}`, v));
const text = (field, v) => (typeof v === 'string' && v !== '' ? null : must(field, 'a non-empty string', v));
const optText = (field, v) => (v === undefined ? null : text(field, v));

const checkList = (list, field, max) => {
  if (!Array.isArray(list) || list.length < 1) return must(field, 'an array of at least 1 entry', list);
  if (list.length > max) return refuse(field, `has ${list.length} entries; the cap is ${max}`);
  const seen = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const x = list[i];
    if (!isObj(x)) return must(`${field}[${i}]`, 'an object', x);
    const e = text(`${field}[${i}].id`, x.id);
    if (e) return e;
    if (seen.has(x.id)) return refuse(`${field}[${i}].id`, `repeats the id "${x.id}"`);
    seen.add(x.id);
  }
  return null;
};

// ---- accepted keys ---------------------------------------------------------
//
// Every public function refuses an input key it does not read, at every
// level, so a misspelt optional key is never dropped silently. The walk
// checks an object's own keys in their order, then its children in the order
// listed here; a key whose value is undefined counts as absent. Keys that are
// product ids (vessel.tanks, a cargo's bulk) are checked by the function that
// reads them.
const O = (keys, children = {}) => ({ t: 'obj', keys, children });
const L = (of) => ({ t: 'list', of });
const TRI = O(['min', 'mode', 'max']);
const TRI_OR_NUMBER = { t: 'tri' };
const VESSEL = O(['name', 'speedKnots', 'deckAreaM2', 'deckUsableFraction', 'deckLoadT', 'deadweightT', 'tanks', 'fuelTPerHour'], { fuelTPerHour: O(ACTIVITIES) });
const PRODUCT = O(['id', 'name', 'kind', 'densityTPerM3']);
const CARGO = O(['deckAreaM2', 'deckWeightT', 'bulk']);
const ROUTE = O(['mode', 'stops', 'legsNm']);
const WEATHER = O(['factor', 'appliesTo']);
const FLEET_KEYS = ['vessel', 'products', 'installations', 'route', 'portHours', 'weather', 'fuelPricePerT', 'periodDays', 'vesselAvailableDays', 'voyageRounding', 'vesselRounding'];
const FLEET_INSTALLATION = O(['id', 'name', 'distanceFromBaseNm', 'fieldHours', 'minVisits', 'demand'], { demand: CARGO });
export const ACCEPTED_KEYS = Object.freeze({
  voyagePlan: O(['vessel', 'products', 'installations', 'route', 'portHours', 'weather', 'fuelPricePerT'], {
    vessel: VESSEL, products: L(PRODUCT), installations: L(O(['id', 'name', 'distanceFromBaseNm', 'fieldHours', 'cargo'], { cargo: CARGO })), route: ROUTE, weather: WEATHER,
  }),
  fleetSize: O(FLEET_KEYS, { vessel: VESSEL, products: L(PRODUCT), installations: L(FLEET_INSTALLATION), route: ROUTE, weather: WEATHER }),
  fleetVariability: O(FLEET_KEYS.concat(['demandFactor', 'plannedVessels', 'iterations', 'seed']), {
    vessel: VESSEL, products: L(PRODUCT), installations: L(FLEET_INSTALLATION), route: ROUTE, weather: O(['factor', 'appliesTo'], { factor: TRI_OR_NUMBER }), demandFactor: TRI_OR_NUMBER,
  }),
  deckPlan: O(['deck', 'items', 'voyages', 'rule'], { deck: O(['name', 'areaM2', 'usableFraction', 'loadT']), items: L(O(['id', 'name', 'lengthM', 'widthM', 'weightT', 'quantity'])) }),
  shoreBase: O(['berths', 'arrivalsPerDay', 'workingHoursPerDay', 'service', 'model', 'targetMeanWaitHours'], { service: O(['fixedHours', 'lifts', 'liftsPerHour', 'bulkM3', 'bulkM3PerHour', 'concurrent']) }),
});

const unknownKey = (path, key, keys) => refuse(path ? `${path}.${key}` : key, `is not an accepted key; the accepted keys ${path ? `of ${path}` : 'at the top level'} are ${keys.join(', ')}`);
const walkKeys = (v, spec, path) => {
  if (spec.t === 'tri') return isObj(v) ? walkKeys(v, TRI, path) : null;
  if (spec.t === 'list') {
    if (!Array.isArray(v)) return null;
    for (let i = 0; i < v.length; i += 1) { const e = walkKeys(v[i], spec.of, `${path}[${i}]`); if (e) return e; }
    return null;
  }
  if (!isObj(v)) return null;
  for (const k of Object.keys(v)) if (v[k] !== undefined && !spec.keys.includes(k)) return unknownKey(path, k, spec.keys);
  for (const k of spec.keys) {
    if (own(spec.children, k) && v[k] !== undefined) { const e = walkKeys(v[k], spec.children[k], path ? `${path}.${k}` : k); if (e) return e; }
  }
  return null;
};
// an object keyed by product id: unknown ids are refused by name
const productKeys = (obj, ids, path) => {
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined && !ids.includes(k)) return refuse(`${path}.${k}`, `is not a product id; the accepted keys of ${path} are the product ids ${ids.join(', ')}`);
  }
  return null;
};
const guard = (name, impl) => (args = {}) => {
  if (!isObj(args)) return refuse('options', 'must be an object of named inputs');
  const e = walkKeys(args, ACCEPTED_KEYS[name], '');
  return e || impl(args);
};

// ---- shared validation -----------------------------------------------------

const checkProducts = (products) => {
  const e = checkList(products, 'products', DEFAULTS.MAX_PRODUCTS);
  if (e) return e;
  for (let i = 0; i < products.length; i += 1) {
    const p = products[i];
    const f = `products[${i}]`;
    const e2 = first(optText(`${f}.name`, p.name), oneOf(`${f}.kind`, p.kind, ['liquid', 'dry']), positive(`${f}.densityTPerM3`, p.densityTPerM3));
    if (e2) return e2;
  }
  return null;
};

const checkVessel = (vessel, ids) => {
  if (!isObj(vessel)) return must('vessel', 'an object', vessel);
  const e = first(
    optText('vessel.name', vessel.name),
    positive('vessel.speedKnots', vessel.speedKnots),
    positive('vessel.deckAreaM2', vessel.deckAreaM2),
    fraction('vessel.deckUsableFraction', vessel.deckUsableFraction),
    positive('vessel.deckLoadT', vessel.deckLoadT),
    positive('vessel.deadweightT', vessel.deadweightT),
  );
  if (e) return e;
  if (!isObj(vessel.tanks)) return must('vessel.tanks', 'an object of tank capacities in m3 keyed by product id', vessel.tanks);
  const e2 = productKeys(vessel.tanks, ids, 'vessel.tanks');
  if (e2) return e2;
  for (const id of ids) {
    if (vessel.tanks[id] === undefined) return refuse(`vessel.tanks.${id}`, 'must be stated for every product (0 when the vessel has no tank for it); got nothing');
    const e3 = nonNeg(`vessel.tanks.${id}`, vessel.tanks[id]);
    if (e3) return e3;
  }
  if (!isObj(vessel.fuelTPerHour)) return must('vessel.fuelTPerHour', 'an object { sailing, port, field } of fuel burn in tonnes an hour', vessel.fuelTPerHour);
  for (const a of ACTIVITIES) {
    const e4 = nonNeg(`vessel.fuelTPerHour.${a}`, vessel.fuelTPerHour[a]);
    if (e4) return e4;
  }
  return null;
};

const checkCargo = (cargo, field, ids) => {
  if (!isObj(cargo)) return must(field, 'an object { deckAreaM2, deckWeightT, bulk }', cargo);
  const e = first(nonNeg(`${field}.deckAreaM2`, cargo.deckAreaM2), nonNeg(`${field}.deckWeightT`, cargo.deckWeightT));
  if (e) return e;
  if (cargo.bulk === undefined) return null;
  if (!isObj(cargo.bulk)) return must(`${field}.bulk`, 'an object of m3 keyed by product id when given', cargo.bulk);
  const e2 = productKeys(cargo.bulk, ids, `${field}.bulk`);
  if (e2) return e2;
  for (const id of Object.keys(cargo.bulk)) {
    const e3 = nonNeg(`${field}.bulk.${id}`, cargo.bulk[id]);
    if (e3) return e3;
  }
  return null;
};

const checkWeatherFactor = (field, v) => (fin(v) && v >= 1 && v <= DEFAULTS.MAX_WEATHER_FACTOR ? null : must(field, `a finite number from 1 to ${DEFAULTS.MAX_WEATHER_FACTOR}`, v));
const checkAppliesTo = (a) => {
  if (!Array.isArray(a) || a.length < 1) return must('weather.appliesTo', 'an array naming at least one of "sailing", "port", "field"', a);
  for (let i = 0; i < a.length; i += 1) {
    const e = oneOf(`weather.appliesTo[${i}]`, a[i], ACTIVITIES);
    if (e) return e;
    if (a.indexOf(a[i]) !== i) return refuse(`weather.appliesTo[${i}]`, `repeats "${a[i]}"`);
  }
  return null;
};
const checkWeather = (weather) => {
  if (!isObj(weather)) return must('weather', 'an object { factor, appliesTo }', weather);
  return first(checkWeatherFactor('weather.factor', weather.factor), checkAppliesTo(weather.appliesTo));
};

// The route and installations common to voyagePlan and fleetSize.
const checkRoute = (route, installations) => {
  if (!isObj(route)) return must('route', 'an object { mode, stops, legsNm }', route);
  const e = oneOf('route.mode', route.mode, ['milk-run', 'dedicated']);
  if (e) return e;
  if (route.mode === 'dedicated') {
    if (route.stops !== undefined) return refuse('route.stops', "is read only when route.mode is \"milk-run\"; a dedicated voyage sails from the base to one installation and back");
    if (route.legsNm !== undefined) return refuse('route.legsNm', "is read only when route.mode is \"milk-run\"; a dedicated voyage uses each installation's distanceFromBaseNm out and back");
    for (let i = 0; i < installations.length; i += 1) {
      const e2 = nonNeg(`installations[${i}].distanceFromBaseNm`, installations[i].distanceFromBaseNm);
      if (e2) return e2;
    }
    return null;
  }
  for (let i = 0; i < installations.length; i += 1) {
    if (installations[i].distanceFromBaseNm !== undefined) return refuse(`installations[${i}].distanceFromBaseNm`, 'is read only when route.mode is "dedicated"; a milk run takes its distances from route.legsNm');
  }
  const ids = installations.map((x) => x.id);
  if (!Array.isArray(route.stops) || route.stops.length !== ids.length) return must('route.stops', `an array naming each of the ${plural(ids.length, 'installation')} once, in the order sailed`, route.stops);
  for (let i = 0; i < route.stops.length; i += 1) {
    const s = route.stops[i];
    if (!ids.includes(s)) return must(`route.stops[${i}]`, `an installation id (${ids.join(', ')})`, s);
    if (route.stops.indexOf(s) !== i) return refuse(`route.stops[${i}]`, `repeats "${s}"; a milk run visits each installation once`);
  }
  const n = route.stops.length + 1;
  if (!Array.isArray(route.legsNm) || route.legsNm.length !== n) return must('route.legsNm', `an array of ${n} leg distances in nautical miles (base to the first stop, stop to stop, the last stop back to the base)`, route.legsNm);
  for (let i = 0; i < n; i += 1) {
    const e3 = nonNeg(`route.legsNm[${i}]`, route.legsNm[i]);
    if (e3) return e3;
  }
  return null;
};

// ---- voyages ---------------------------------------------------------------

// The voyages a route sails: a milk run is one voyage through every stop;
// dedicated is one voyage per installation, out and back.
const voyagesOf = (route, installations) => {
  const byId = new Map(installations.map((x) => [x.id, x]));
  if (route.mode === 'milk-run') {
    const names = ['base'].concat(route.stops, ['base']);
    const legs = route.legsNm.map((nm, i) => ({ from: names[i], to: names[i + 1], nm }));
    return [{ id: 'milk-run', stops: route.stops.slice(), legs, members: route.stops.map((s) => byId.get(s)) }];
  }
  return installations.map((x) => ({
    id: x.id, stops: [x.id], legs: [{ from: 'base', to: x.id, nm: x.distanceFromBaseNm }, { from: x.id, to: 'base', nm: x.distanceFromBaseNm }], members: [x],
  }));
};

// Calm-weather hours by activity, then the weather factor on the stated
// activities. Sailing hours = total distance / speed.
const calmHours = (v, vessel, portHours) => {
  const nm = sum(v.legs.map((l) => l.nm));
  return { nm, sailing: nm / vessel.speedKnots, port: portHours, field: sum(v.members.map((m) => m.fieldHours)) };
};
const weathered = (calm, factor, appliesTo) => {
  const h = {};
  for (const a of ACTIVITIES) h[a] = appliesTo.includes(a) ? calm[a] * factor : calm[a];
  h.total = h.sailing + h.port + h.field;
  return h;
};
const fuelOf = (hours, vessel) => {
  const f = {};
  for (const a of ACTIVITIES) f[a] = hours[a] * vessel.fuelTPerHour[a];
  f.total = f.sailing + f.port + f.field;
  return f;
};

// The capacity constraints in the stated order, each with its capacity.
const constraintsOf = (vessel, products) => [
  { constraint: 'deck area', unit: 'm2', capacity: vessel.deckAreaM2 * vessel.deckUsableFraction, of: (l) => l.deckAreaM2 },
  { constraint: 'deck load', unit: 't', capacity: vessel.deckLoadT, of: (l) => l.deckWeightT },
  { constraint: 'deadweight', unit: 't', capacity: vessel.deadweightT, of: (l) => l.deadweightT },
].concat(products.map((p) => ({ constraint: `tank ${p.id}`, unit: 'm3', productId: p.id, capacity: vessel.tanks[p.id], of: (l) => l.bulkM3[p.id] })));

// Sum cargo over installations; deadweight = deck weight + sum of bulk m3 x
// the stated density.
const loadOf = (cargos, products) => {
  const bulkM3 = {};
  for (const p of products) bulkM3[p.id] = sum(cargos.map((c) => (c.bulk && c.bulk[p.id] !== undefined ? c.bulk[p.id] : 0)));
  const deckWeightT = sum(cargos.map((c) => c.deckWeightT));
  return {
    deckAreaM2: sum(cargos.map((c) => c.deckAreaM2)),
    deckWeightT,
    bulkM3,
    deadweightT: deckWeightT + sum(products.map((p) => bulkM3[p.id] * p.densityTPerM3)),
  };
};

// A load that needs a tank the vessel does not have is refused by name (every
// other capacity must be above 0, so only a tank can be 0).
const zeroCapacity = (cons, load, where) => {
  for (const c of cons) {
    if (c.capacity === 0 && c.of(load) > 0) return refuse(`vessel.tanks.${c.productId}`, `must be above 0 to carry ${c.productId}: ${where} for ${dec(c.of(load))} m3 of it; got 0`);
  }
  return null;
};

const utilisationRows = (cons, load) => cons.map((c) => {
  const l = c.of(load);
  return { constraint: c.constraint, unit: c.unit, load: l, capacity: c.capacity, utilisation: c.capacity === 0 ? 0 : l / c.capacity };
});
const bindingOf = (rows) => {
  let best = rows[0];
  for (const r of rows) if (key12(r.utilisation) > key12(best.utilisation)) best = r;
  return best;
};

// ---- voyage planning -------------------------------------------------------

/**
 * Plan the voyages of one vessel on a stated route (milk run through every
 * installation in the stated order, or a dedicated voyage to each). Per
 * voyage: leg and activity hours (weather factor on the stated activities),
 * fuel by activity at the stated burn rates, fuel cost at the stated price,
 * the cargo carried and its utilisation of every capacity constraint (deck
 * area x the usable fraction, deck load, deadweight, each tank), naming the
 * binding constraint and every overloaded one.
 */
const voyagePlanImpl = ({ vessel, products, installations, route, portHours, weather, fuelPricePerT }) => {
  let e = checkProducts(products);
  if (e) return e;
  const ids = products.map((p) => p.id);
  e = checkVessel(vessel, ids);
  if (e) return e;
  e = checkList(installations, 'installations', DEFAULTS.MAX_INSTALLATIONS);
  if (e) return e;
  for (let i = 0; i < installations.length; i += 1) {
    const x = installations[i];
    e = first(optText(`installations[${i}].name`, x.name), nonNeg(`installations[${i}].fieldHours`, x.fieldHours), checkCargo(x.cargo, `installations[${i}].cargo`, ids));
    if (e) return e;
  }
  e = first(checkRoute(route, installations), nonNeg('portHours', portHours), checkWeather(weather), nonNeg('fuelPricePerT', fuelPricePerT));
  if (e) return e;
  const cons = constraintsOf(vessel, products);
  const voyages = [];
  for (const v of voyagesOf(route, installations)) {
    const load = loadOf(v.members.map((m) => m.cargo), products);
    e = zeroCapacity(cons, load, v.id === 'milk-run' ? 'the installations on the milk run ask' : `installation ${v.id} asks`);
    if (e) return e;
    const calm = calmHours(v, vessel, portHours);
    const hours = weathered(calm, weather.factor, weather.appliesTo);
    const fuelT = fuelOf(hours, vessel);
    const rows = utilisationRows(cons, load);
    const binding = bindingOf(rows);
    const over = rows.filter((r) => key12(r.load) > key12(r.capacity));
    const reasons = [`the binding constraint is ${binding.constraint}: ${dec(binding.load)} ${binding.unit} of ${dec(binding.capacity)} ${binding.unit} (${pct(binding.utilisation)})`];
    for (const r of over) reasons.push(`overloaded: ${r.constraint} needs ${dec(r.load)} ${r.unit} against a capacity of ${dec(r.capacity)} ${r.unit}`);
    voyages.push({
      id: v.id,
      stops: v.stops,
      legs: v.legs.map((l) => ({ from: l.from, to: l.to, nm: l.nm, calmHours: l.nm / vessel.speedKnots })),
      nm: calm.nm,
      hours,
      days: hours.total / 24,
      fuelT,
      fuelCost: fuelT.total * fuelPricePerT,
      load,
      constraints: rows.map(({ constraint, unit, load: l, capacity, utilisation }) => ({ constraint, unit, load: l, capacity, utilisation })),
      binding: { constraint: binding.constraint, utilisation: binding.utilisation },
      feasible: over.length === 0,
      overloaded: over.map((r) => r.constraint),
      reasons,
    });
  }
  return {
    voyages,
    totals: {
      hours: sum(voyages.map((v) => v.hours.total)),
      days: sum(voyages.map((v) => v.days)),
      fuelT: sum(voyages.map((v) => v.fuelT.total)),
      fuelCost: sum(voyages.map((v) => v.fuelCost)),
    },
    basis: {
      rule: `${route.mode === 'milk-run' ? 'one milk run through the stops in the stated order' : 'one dedicated voyage to each installation, out and back'}; weather factor ${fmt(weather.factor)} on ${weather.appliesTo.join(', ')} time; deck area capacity = deck area x the usable fraction ${fmt(vessel.deckUsableFraction)}; deadweight load = deck weight + bulk m3 x the stated density; the binding constraint has the highest utilisation (ties to the first in the order deck area, deck load, deadweight, tanks)`,
      source: `${CITE.voyage}; ${CITE.capacity}`,
    },
  };
};

// ---- fleet sizing ----------------------------------------------------------

const ROUNDING_VOYAGES = ['up', 'none'];
const ROUNDING_VESSELS = ['up', 'nearest', 'none'];

const checkFleet = (a, { variable }) => {
  const { vessel, products, installations, route, portHours, weather, fuelPricePerT, periodDays, vesselAvailableDays, voyageRounding, vesselRounding } = a;
  let e = checkProducts(products);
  if (e) return e;
  const ids = products.map((p) => p.id);
  e = checkVessel(vessel, ids);
  if (e) return e;
  e = checkList(installations, 'installations', DEFAULTS.MAX_INSTALLATIONS);
  if (e) return e;
  for (let i = 0; i < installations.length; i += 1) {
    const x = installations[i];
    e = first(
      optText(`installations[${i}].name`, x.name),
      nonNeg(`installations[${i}].fieldHours`, x.fieldHours),
      intIn(`installations[${i}].minVisits`, x.minVisits, 0, 1000),
      checkCargo(x.demand, `installations[${i}].demand`, ids),
    );
    if (e) return e;
  }
  e = first(checkRoute(route, installations), nonNeg('portHours', portHours));
  if (e) return e;
  if (!isObj(weather)) return must('weather', 'an object { factor, appliesTo }', weather);
  e = variable ? checkTriFactor(weather.factor, 'weather.factor', 1, DEFAULTS.MAX_WEATHER_FACTOR) : checkWeatherFactor('weather.factor', weather.factor);
  if (e) return e;
  e = first(checkAppliesTo(weather.appliesTo), nonNeg('fuelPricePerT', fuelPricePerT), positive('periodDays', periodDays), positive('vesselAvailableDays', vesselAvailableDays));
  if (e) return e;
  if (vesselAvailableDays > periodDays) return refuse('vesselAvailableDays', `must be at most periodDays (${fmt(periodDays)}); got ${fmt(vesselAvailableDays)}`);
  return first(oneOf('voyageRounding', voyageRounding, ROUNDING_VOYAGES), oneOf('vesselRounding', vesselRounding, ROUNDING_VESSELS));
};

// Everything about the fleet that does not depend on the weather factor or
// the demand factor, prepared once.
const prepareFleet = (a) => {
  const { vessel, products, installations, route, portHours } = a;
  const cons = constraintsOf(vessel, products);
  const sets = [];
  for (const v of voyagesOf(route, installations)) {
    const demand = loadOf(v.members.map((m) => m.demand), products);
    const e = zeroCapacity(cons, demand, v.id === 'milk-run' ? 'the installations on the milk run ask' : `installation ${v.id} asks`);
    if (e) return { error: e };
    const ratios = cons.map((c) => (c.capacity === 0 ? 0 : c.of(demand) / c.capacity));
    let maxRatio = ratios[0];
    let driver = cons[0].constraint;
    for (let i = 1; i < ratios.length; i += 1) if (key12(ratios[i]) > key12(maxRatio)) { maxRatio = ratios[i]; driver = cons[i].constraint; }
    sets.push({ v, demand, ratios, maxRatio, driver, minVisits: Math.max(...v.members.map((m) => m.minVisits)), calm: calmHours(v, vessel, portHours) });
  }
  return { cons, sets };
};

const roundVoyages = (x, rule) => (rule === 'up' ? ceil12(x) : x);
const roundVessels = (x, rule) => (rule === 'up' ? ceil12(x) : rule === 'nearest' ? Math.floor(key12(x) + 0.5) : x);

// Voyages for one set at a demand factor f: the largest of f x (demand /
// capacity) over the constraints and the minimum visits, by the rule.
const voyagesFor = (s, f, rule) => {
  const r = f * s.maxRatio;
  const byDemand = key12(r) > 0 && key12(r) >= s.minVisits;
  const exact = byDemand ? r : s.minVisits;
  return { exact, voyages: roundVoyages(exact, rule), drivenBy: byDemand ? s.driver : s.minVisits > 0 ? 'minimum visits' : 'no demand' };
};

// Vessel-days at a weather factor w and a demand factor f, with the same
// arithmetic in the same order as fleetResult (weathered, then voyagesFor),
// written without allocation because the Monte Carlo calls it per iteration.
const vesselDaysFor = (prep, w, f, a) => {
  const on = a.weather.appliesTo;
  const ws = on.includes('sailing');
  const wp = on.includes('port');
  const wf = on.includes('field');
  let vd = 0;
  for (const s of prep.sets) {
    const c = s.calm;
    const total = (ws ? c.sailing * w : c.sailing) + (wp ? c.port * w : c.port) + (wf ? c.field * w : c.field);
    const r = f * s.maxRatio;
    const exact = key12(r) > 0 && key12(r) >= s.minVisits ? r : s.minVisits;
    vd += roundVoyages(exact, a.voyageRounding) * (total / 24);
  }
  return vd;
};

/**
 * Size a supply vessel fleet for a period. Per voyage set (the milk run, or
 * each dedicated installation): voyages needed = the largest of demand /
 * capacity over deck area (x the usable fraction), deck load, deadweight and
 * each tank, and the stated minimum visits, rounded by voyageRounding ('up'
 * whole voyages, or 'none' for the fractional average); voyage days from the
 * leg distances, speed, port and field hours and the weather factor;
 * vessel-days = voyages x voyage days. Vessels = total vessel-days / the days
 * a vessel is available in the period, by vesselRounding ('up', 'nearest'
 * with halves up, or 'none'). Reports what drives each voyage count, the
 * average utilisation per constraint, spare or short vessel-days, fleet
 * utilisation, and fuel and fuel cost for the period.
 */
const fleetSizeImpl = (a) => {
  const e = checkFleet(a, { variable: false });
  if (e) return e;
  const prep = prepareFleet(a);
  if (prep.error) return prep.error;
  return fleetResult(a, prep, a.weather.factor, 1);
};

const fleetResult = (a, prep, w, f) => {
  const { vessel, fuelPricePerT, vesselAvailableDays, voyageRounding, vesselRounding } = a;
  const out = [];
  const reasons = [];
  for (const s of prep.sets) {
    const vf = voyagesFor(s, f, voyageRounding);
    const hours = weathered(s.calm, w, a.weather.appliesTo);
    const days = hours.total / 24;
    const fuel = fuelOf(hours, vessel);
    const util = prep.cons.map((c, i) => ({ constraint: c.constraint, demand: f * c.of(s.demand), capacity: c.capacity, averageUtilisation: vf.voyages > 0 ? (f * s.ratios[i]) / vf.voyages : 0 }));
    out.push({
      id: s.v.id,
      stops: s.v.stops,
      nm: s.calm.nm,
      voyagesExact: vf.exact,
      voyages: vf.voyages,
      drivenBy: vf.drivenBy,
      hours,
      voyageDays: days,
      vesselDays: vf.voyages * days,
      fuelT: vf.voyages * fuel.total,
      constraints: util,
    });
    if (days > vesselAvailableDays) reasons.push(`voyage ${s.v.id} takes ${unitOf(dec(days), Number(dec(days)), 'day')}, longer than the ${unitOf(fmt(vesselAvailableDays), vesselAvailableDays, 'day')} a vessel is available in the period`);
  }
  const vesselDays = sum(out.map((x) => x.vesselDays));
  const vesselsExact = vesselDays / vesselAvailableDays;
  const vessels = roundVessels(vesselsExact, vesselRounding);
  const capacityDays = vessels * vesselAvailableDays;
  const shortVesselDays = key12(vesselDays) > key12(capacityDays) ? vesselDays - capacityDays : 0;
  if (shortVesselDays > 0) reasons.push(`${fmt(vessels)} ${vessels === 1 ? 'vessel gives' : 'vessels give'} ${dec(capacityDays)} vessel-days against ${dec(vesselDays)} needed: short by ${dec(shortVesselDays)} vessel-days`);
  const fuelT = sum(out.map((x) => x.fuelT));
  return {
    voyageSets: out,
    vesselDays,
    vesselsExact,
    vessels,
    capacityDays,
    spareVesselDays: shortVesselDays > 0 ? 0 : capacityDays - vesselDays,
    shortVesselDays,
    fleetUtilisation: capacityDays > 0 ? vesselDays / capacityDays : null,
    fuelT,
    fuelCost: fuelT * fuelPricePerT,
    reasons,
    basis: {
      rule: `voyages = the largest of demand / capacity over deck area (x ${fmt(vessel.deckUsableFraction)}), deck load, deadweight and each tank, and the minimum visits, rounded ${voyageRounding === 'up' ? 'up to whole voyages' : 'not at all (the fractional average)'}; vessel-days = voyages x voyage days; vessels = vessel-days / ${fmt(vesselAvailableDays)} available days, rounded ${vesselRounding === 'up' ? 'up' : vesselRounding === 'nearest' ? 'to the nearest whole vessel (halves up)' : 'not at all'}; counts compare at 12 significant digits`,
      source: `${CITE.fleet}; ${CITE.voyage}`,
    },
  };
};

// ---- fleet variability (canonical Monte Carlo) -----------------------------

const checkTriFactor = (d, field, lo, hi) => {
  const range = hi === undefined ? `at or above ${lo}` : `from ${lo} to ${hi}`;
  if (fin(d)) return d >= lo && (hi === undefined || d <= hi) ? null : must(field, `a number ${range} or a triangular distribution { min, mode, max }`, d);
  if (!isObj(d) || !fin(d.min) || !fin(d.mode) || !fin(d.max)) return must(field, `a number ${range} or a triangular distribution { min, mode, max } of finite numbers`, d);
  if (d.min < lo) return must(`${field}.min`, `at or above ${lo}`, d.min);
  if (hi !== undefined && d.max > hi) return must(`${field}.max`, `at most ${hi}`, d.max);
  if (!(d.min <= d.mode && d.mode <= d.max)) return refuse(field, `must have min <= mode <= max; got min ${fmt(d.min)}, mode ${fmt(d.mode)}, max ${fmt(d.max)}`);
  return null;
};
const triOf = (d) => (fin(d) ? { min: d, mode: d, max: d } : d);
const varies = (d) => d.max > d.min;
const draw = (d, rng) => (varies(d) ? triInvCDF(rng(), d.min, d.mode, d.max) : d.mode);
const pick = (s) => ({ mean: s.mean, p90: s.p90, p50: s.p50, p10: s.p10, min: s.min, max: s.max });

/**
 * The fleet under weather and demand variability: the weather factor and a
 * demand factor (multiplying every installation's demand) sampled through
 * lib/stats (mulberry32 + triangular inverse CDF), each a number or a
 * triangular { min, mode, max }. Per iteration the fleet is sized exactly as
 * fleetSize does. Reports vessel-days and vessels required (mean, P90, P50,
 * P10, min, max), the distribution of whole vessels required, and for the
 * stated plannedVessels the probability of being short (vessel-days above
 * planned x available days) and the expected shortfall in vessel-days.
 */
const fleetVariabilityImpl = (a) => {
  const e = checkFleet(a, { variable: true });
  if (e) return e;
  const e2 = first(
    checkTriFactor(a.demandFactor, 'demandFactor', 0),
    intIn('plannedVessels', a.plannedVessels, 0, 1000),
    intIn('iterations', a.iterations, 1, DEFAULTS.MAX_ITERATIONS),
  );
  if (e2) return e2;
  if (!Number.isInteger(a.seed) || a.seed < 0 || a.seed > 4294967295) return must('seed', 'a whole number from 0 to 4294967295 (there is no default, so every run can be reproduced)', a.seed);
  const prep = prepareFleet(a);
  if (prep.error) return prep.error;
  const nSets = prep.sets.length;
  if (a.iterations * nSets > DEFAULTS.MAX_DRAWS) {
    return refuse('iterations', `must be at most ${Math.floor(DEFAULTS.MAX_DRAWS / nSets)} with ${plural(nSets, 'voyage set')} (iterations x voyage sets is capped at ${DEFAULTS.MAX_DRAWS}); got ${fmt(a.iterations)}`);
  }
  const wTri = triOf(a.weather.factor);
  const fTri = triOf(a.demandFactor);
  const rng = mulberry32(a.seed);
  const n = a.iterations;
  const capacityDays = a.plannedVessels * a.vesselAvailableDays;
  const vd = new Array(n);
  const vs = new Array(n);
  const shortfall = new Array(n);
  let shortCount = 0;
  const counts = new Map();
  for (let i = 0; i < n; i += 1) {
    const w = draw(wTri, rng);
    const f = draw(fTri, rng);
    const d = vesselDaysFor(prep, w, f, a);
    const v = roundVessels(d / a.vesselAvailableDays, a.vesselRounding);
    vd[i] = d;
    vs[i] = v;
    const short = key12(d) > key12(capacityDays);
    if (short) shortCount += 1;
    shortfall[i] = short ? d - capacityDays : 0;
    if (a.vesselRounding !== 'none') counts.set(v, (counts.get(v) || 0) + 1);
  }
  const planW = wTri.mode;
  const planF = fTri.mode;
  const planDays = vesselDaysFor(prep, planW, planF, a);
  const sf = basicStats(shortfall);
  return {
    plan: { weatherFactor: planW, demandFactor: planF, vesselDays: planDays, vessels: roundVessels(planDays / a.vesselAvailableDays, a.vesselRounding) },
    vesselDays: pick(basicStats(vd)),
    vesselsRequired: pick(basicStats(vs)),
    vesselsDistribution: a.vesselRounding === 'none' ? null : [...counts.keys()].sort((x, y) => x - y).map((k) => ({ vessels: k, probability: counts.get(k) / n })),
    plannedVessels: a.plannedVessels,
    capacityDays,
    probabilityShort: shortCount / n,
    expectedShortVesselDays: sf.mean,
    percentileDefinition: EXCEEDANCE_DEFINITION,
    basis: {
      rule: `per iteration the weather factor is drawn first, then the demand factor, each only when it varies (lib/stats mulberry32 seed ${fmt(a.seed)}, triangular inverse CDF); the fleet is sized as fleetSize does; short means vessel-days above plannedVessels x available days; for a requirement P90 is the LOW figure (10th percentile) and P10 the HIGH figure (90th percentile)`,
      source: `lib/stats (mulberry32, triInvCDF, basicStats) and lib/conventions/percentile.js; ${CITE.fleet}`,
    },
  };
};

// ---- deck-space planning ---------------------------------------------------

const RULES = ['first-fit-decreasing-area', 'first-fit'];

/**
 * Pack stated deck cargo items onto a stated number of voyages (one deck
 * each) by a stated rule: 'first-fit-decreasing-area' sorts the units by
 * footprint area (length x width) descending, then weight descending, then
 * item id and unit number ascending; 'first-fit' keeps the stated order. Each
 * unit goes to the first voyage where both the area (deck area x the usable
 * fraction) and the deck load still hold it (at 12 significant digits,
 * inclusive). A unit that fits no voyage is overflow, named with its reason:
 * a unit larger than the usable area or heavier than the deck load can never
 * be carried (it is listed in `neverFit` too); any other overflow reason
 * names the limit that stops it, from the room left on the voyages at its
 * turn (after every unit before it in the packing order is placed): the most
 * usable area and the most deck load left on any voyage, each marked short or
 * enough. The lower bound counts only the units that fit an empty voyage.
 * This is an area bound: it assumes no stacking and does not check the
 * footprints' shapes against the deck's dimensions.
 */
const deckPlanImpl = ({ deck, items, voyages, rule }) => {
  if (!isObj(deck)) return must('deck', 'an object { areaM2, usableFraction, loadT }', deck);
  let e = first(optText('deck.name', deck.name), positive('deck.areaM2', deck.areaM2), fraction('deck.usableFraction', deck.usableFraction), positive('deck.loadT', deck.loadT));
  if (e) return e;
  e = checkList(items, 'items', DEFAULTS.MAX_ITEM_LINES);
  if (e) return e;
  let units = 0;
  for (let i = 0; i < items.length; i += 1) {
    const x = items[i];
    const f = `items[${i}]`;
    e = first(optText(`${f}.name`, x.name), positive(`${f}.lengthM`, x.lengthM), positive(`${f}.widthM`, x.widthM), nonNeg(`${f}.weightT`, x.weightT), intIn(`${f}.quantity`, x.quantity, 1, DEFAULTS.MAX_QUANTITY));
    if (e) return e;
    units += x.quantity;
  }
  if (units > DEFAULTS.MAX_UNITS) return refuse('items', `hold ${units} units in all; the cap is ${DEFAULTS.MAX_UNITS}`);
  e = first(intIn('voyages', voyages, 1, DEFAULTS.MAX_DECK_VOYAGES), oneOf('rule', rule, RULES));
  if (e) return e;
  const usable = deck.areaM2 * deck.usableFraction;
  const list = [];
  items.forEach((x, i) => {
    for (let k = 1; k <= x.quantity; k += 1) {
      list.push({ unit: x.quantity === 1 ? x.id : `${x.id}#${k}`, itemId: x.id, k, line: i, areaM2: x.lengthM * x.widthM, weightT: x.weightT });
    }
  });
  if (rule === 'first-fit-decreasing-area') {
    list.sort((p, q) => (key12(q.areaM2) - key12(p.areaM2)) || (key12(q.weightT) - key12(p.weightT)) || cmpStr(p.itemId, q.itemId) || (p.k - q.k));
  }
  const bins = Array.from({ length: voyages }, (_, i) => ({ voyage: i + 1, units: [], areaM2: 0, weightT: 0 }));
  const overflow = [];
  for (const u of list) {
    const areaFits = (b) => key12(b.areaM2 + u.areaM2) <= key12(usable);
    const loadFits = (b) => key12(b.weightT + u.weightT) <= key12(deck.loadT);
    const bin = bins.find((b) => areaFits(b) && loadFits(b));
    if (bin) {
      bin.units.push(u.unit);
      bin.areaM2 += u.areaM2;
      bin.weightT += u.weightT;
    } else {
      let reason;
      if (key12(u.areaM2) > key12(usable)) reason = `its footprint ${dec(u.areaM2)} m2 is larger than the usable deck area ${dec(usable)} m2`;
      else if (key12(u.weightT) > key12(deck.loadT)) reason = `its weight ${fmt(u.weightT)} t is above the deck load ${fmt(deck.loadT)} t`;
      else {
        const areaShort = !bins.some(areaFits);
        const loadShort = !bins.some(loadFits);
        const areaLeft = Math.max(...bins.map((b) => usable - b.areaM2));
        const loadLeft = Math.max(...bins.map((b) => deck.loadT - b.weightT));
        const mark = (short) => (short ? 'short' : 'enough');
        let stops;
        if (areaShort && loadShort) stops = 'usable area and deck load both stop it';
        else if (areaShort) stops = 'usable area stops it';
        else if (loadShort) stops = 'deck load stops it';
        else stops = 'no one voyage had both, so usable area and deck load together stop it';
        reason = `it needs ${dec(u.areaM2)} m2 of usable area and ${fmt(u.weightT)} t of deck load; at its turn the most left on any voyage was ${dec(areaLeft)} m2 (${mark(areaShort)}) and ${dec(loadLeft)} t (${mark(loadShort)}); ${stops}`;
      }
      overflow.push({ unit: u.unit, itemId: u.itemId, areaM2: u.areaM2, weightT: u.weightT, reason: `${u.unit} is overflow: ${reason}` });
    }
  }
  const totalArea = sum(list.map((u) => u.areaM2));
  const totalWeight = sum(list.map((u) => u.weightT));
  const fitsEmpty = (u) => key12(u.areaM2) <= key12(usable) && key12(u.weightT) <= key12(deck.loadT);
  const carriable = list.filter(fitsEmpty);
  return {
    packingOrder: list.map((u) => u.unit),
    usableAreaM2: usable,
    voyages: bins.map((b) => ({ voyage: b.voyage, units: b.units, areaM2: b.areaM2, weightT: b.weightT, areaUtilisation: b.areaM2 / usable, loadUtilisation: b.weightT / deck.loadT })),
    voyagesUsed: bins.filter((b) => b.units.length > 0).length,
    overflow,
    totalAreaM2: totalArea,
    totalWeightT: totalWeight,
    lowerBound: Math.max(ceil12(sum(carriable.map((u) => u.areaM2)) / usable), ceil12(sum(carriable.map((u) => u.weightT)) / deck.loadT)),
    neverFit: list.filter((u) => !fitsEmpty(u)).map((u) => u.unit),
    basis: {
      rule: `${rule === 'first-fit' ? 'first fit in the stated order' : 'first-fit decreasing by footprint area (ties: heavier first, then item id, then unit number)'}; usable area = ${fmt(deck.areaM2)} m2 x ${fmt(deck.usableFraction)}; a unit goes to the first voyage whose area and deck load still hold it; the lower bound counts only the units that fit an empty voyage (a unit larger than the usable area or heavier than the deck load is listed in neverFit and left out): the larger of their area / usable area and their weight / deck load, rounded up, and 0 when no unit fits; an overflow reason gives the most usable area and deck load left on any voyage at the unit's turn and names the limit that stops it; an area bound with no stacking and no check of shapes`,
      source: `${CITE.ffd}; ${CITE.capacity}`,
    },
  };
};

// ---- shore base berths -----------------------------------------------------

const MODELS = ['M/M/c', 'M/D/c'];

// Mean wait in the queue (working hours) with c berths, offered load a and
// service time S, for the stated model. Erlang B by recursion (11.3), then
// PiW by remark 11.3.2, then eq. (5.3); Cosmetatos on top for M/D/c.
const queueAt = (c, a, S, model) => {
  const rho = a / c;
  let b = 1;
  for (let k = 1; k <= c - 1; k += 1) b = (a * b) / (k + a * b);
  const piW = (rho * b) / (1 - rho + rho * b);
  const wqM = (piW * S) / (c * (1 - rho));
  if (model === 'M/M/c') return { rho, piW, wq: wqM };
  const wq = (wqM / 2) * (1 + ((1 - rho) * (c - 1) * (Math.sqrt(4 + 5 * c) - 2)) / (16 * rho * c));
  return { rho, piW: null, wq };
};

/**
 * Shore base berth queue: stated berths, vessel arrivals a day, working hours
 * a day, and the service a call needs (fixed hours plus crane lifts at the
 * stated lift rate and bulk m3 at the stated pump rate, done one after the
 * other or at the same time as stated). The clock is the working hour:
 * arrivals an hour = arrivals a day / working hours; service hours
 * S = fixed + lifts / lift rate and bulk / pump rate (summed, or the larger
 * when concurrent). Offered load a = arrivals an hour x S, berth utilisation
 * rho = a / berths (a steady state needs rho below 1). M/M/c by Erlang C
 * (Adan and Resing 2015); M/D/c by the Cosmetatos approximation. Optional
 * targetMeanWaitHours: the fewest berths (up to the cap) whose mean wait is
 * at or below it.
 */
const shoreBaseImpl = ({ berths, arrivalsPerDay, workingHoursPerDay, service, model, targetMeanWaitHours }) => {
  let e = first(intIn('berths', berths, 1, DEFAULTS.MAX_BERTHS), positive('arrivalsPerDay', arrivalsPerDay));
  if (e) return e;
  if (!fin(workingHoursPerDay) || workingHoursPerDay <= 0 || workingHoursPerDay > 24) return must('workingHoursPerDay', 'a number above 0 and at most 24', workingHoursPerDay);
  if (!isObj(service)) return must('service', 'an object { fixedHours, lifts, liftsPerHour, bulkM3, bulkM3PerHour, concurrent }', service);
  e = first(
    nonNeg('service.fixedHours', service.fixedHours),
    nonNeg('service.lifts', service.lifts),
    positive('service.liftsPerHour', service.liftsPerHour),
    nonNeg('service.bulkM3', service.bulkM3),
    positive('service.bulkM3PerHour', service.bulkM3PerHour),
  );
  if (e) return e;
  if (typeof service.concurrent !== 'boolean') return must('service.concurrent', 'true (lifts and bulk at the same time) or false (one after the other); there is no default', service.concurrent);
  e = oneOf('model', model, MODELS);
  if (e) return e;
  if (targetMeanWaitHours !== undefined) {
    e = nonNeg('targetMeanWaitHours', targetMeanWaitHours);
    if (e) return e;
  }
  const liftHours = service.lifts / service.liftsPerHour;
  const bulkHours = service.bulkM3 / service.bulkM3PerHour;
  const S = service.fixedHours + (service.concurrent ? Math.max(liftHours, bulkHours) : liftHours + bulkHours);
  if (!(S > 0)) return refuse('service', 'must give a service time above 0 hours (fixed hours, lifts or bulk); got 0');
  const rhoAt = (arr) => ((arr / workingHoursPerDay) * S) / berths;
  const lambda = arrivalsPerDay / workingHoursPerDay;
  const a = lambda * S;
  const rho = a / berths;
  if (!(rho < 1)) {
    const limit = (berths * workingHoursPerDay) / S;
    return refuse('arrivalsPerDay', `must be at most ${boundMax(limit, (v) => rhoAt(v) < 1)} for a steady state with ${plural(berths, 'berth')}: the berth utilisation must stay below 1, so arrivals a day must stay below berths x working hours a day / service hours = ${dec(limit)}; got ${fmt(arrivalsPerDay)}, a berth utilisation of ${dec(rho)}`);
  }
  const q = queueAt(berths, a, S, model);
  const lq = lambda * q.wq;
  const out = {
    model,
    serviceHours: S,
    liftHours,
    bulkHours,
    arrivalsPerHour: lambda,
    offeredLoad: a,
    berthUtilisation: rho,
    probabilityWait: q.piW,
    meanQueue: lq,
    meanWaitHours: q.wq,
    meanWaitWorkingDays: q.wq / workingHoursPerDay,
    meanTimeAtBaseHours: q.wq + S,
    meanInSystem: lq + a,
  };
  if (targetMeanWaitHours !== undefined) {
    let found = null;
    for (let c = Math.floor(a) + 1; c <= DEFAULTS.MAX_BERTHS; c += 1) {
      if (a / c < 1) {
        const qc = queueAt(c, a, S, model);
        if (key12(qc.wq) <= key12(targetMeanWaitHours)) { found = { berths: c, meanWaitHours: qc.wq }; break; }
      }
    }
    out.target = {
      targetMeanWaitHours,
      berths: found ? found.berths : null,
      meanWaitHours: found ? found.meanWaitHours : null,
      reason: found
        ? `${plural(found.berths, 'berth')} ${found.berths === 1 ? 'is' : 'are'} the fewest with a mean wait at or below ${unitOf(fmt(targetMeanWaitHours), targetMeanWaitHours, 'hour')} (${unitOf(dec(found.meanWaitHours), Number(dec(found.meanWaitHours)), 'hour')})`
        : `no berth count up to ${DEFAULTS.MAX_BERTHS} gives a mean wait at or below ${unitOf(fmt(targetMeanWaitHours), targetMeanWaitHours, 'hour')}`,
    };
  }
  out.basis = {
    rule: `working-hour clock: ${fmt(arrivalsPerDay)} arrivals a day over ${fmt(workingHoursPerDay)} working hours; service ${unitOf(dec(S), Number(dec(S)), 'hour')} = ${fmt(service.fixedHours)} fixed + ${dec(liftHours)} for lifts ${service.concurrent ? 'alongside' : 'then'} ${dec(bulkHours)} for bulk; ${model === 'M/M/c' ? 'M/M/c (Poisson arrivals, exponential service, first come first served)' : 'M/D/c (Poisson arrivals, constant service) by an approximation; probabilityWait is not given for M/D/c'}`,
    source: model === 'M/M/c' ? CITE.mmc : `${CITE.mdc}; ${CITE.mmc}`,
  };
  return out;
};

export const voyagePlan = guard('voyagePlan', voyagePlanImpl);
export const fleetSize = guard('fleetSize', fleetSizeImpl);
export const fleetVariability = guard('fleetVariability', fleetVariabilityImpl);
export const deckPlan = guard('deckPlan', deckPlanImpl);
export const shoreBase = guard('shoreBase', shoreBaseImpl);
