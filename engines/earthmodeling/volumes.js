// Zone volumes (Earth Modeling G8.1): cell-centred sums per zone per
// fault block — bulk (thickness × cell area), net (× NTG), pore
// (× φ), hydrocarbon pore volume (× (1 − Sw)). The grid IS the
// integration mesh (the grvAcreFt convention). Fluids, contacts and
// recovery stay in ReservoirCalc Pro (plan: division of labour).
// Pure functions, no I/O; oracle-validated.

import { isNull } from '../../lib/gridding/gridmath';

/**
 * @param {{dx,dy,nx,ny}} spec model frame
 * @param {ArrayLike<number>} thickness zone thickness grid (m)
 * @param {Int32Array|null} labels block labels (null ⇒ one block "0")
 * @param {{ntg?, phi?, sw?}} props property grids (each optional; a
 *   node contributes only where thickness AND all provided grids are
 *   live)
 * @returns {Object<string, {bulk_m3,net_m3,pore_m3,hcpv_m3,cells}>}
 *   keyed by block label plus "total"
 */
export function zoneVolumes(spec, thickness, labels, props = {}) {
  const cell = spec.dx * spec.dy;
  const { ntg: ntgG = null, phi: phiG = null, sw: swG = null } = props;
  for (const g of [ntgG, phiG, swG]) {
    if (g && g.length !== thickness.length) {
      throw new Error('Property grids must share the zone thickness frame.');
    }
  }
  const blocks = {};
  const add = (lab, t, ntg, phi, sw) => {
    const b = blocks[lab] || (blocks[lab] = { bulk_m3: 0, net_m3: 0, pore_m3: 0, hcpv_m3: 0, cells: 0 });
    const bv = t * cell;
    b.bulk_m3 += bv;
    b.cells += 1;
    if (ntg !== null) {
      b.net_m3 += bv * ntg;
      if (phi !== null) {
        b.pore_m3 += bv * ntg * phi;
        if (sw !== null) b.hcpv_m3 += bv * ntg * phi * (1 - sw);
      }
    }
  };
  for (let j = 0; j < thickness.length; j++) {
    const t = thickness[j];
    if (isNull(t)) continue;
    const ntg = ntgG ? ntgG[j] : null;
    const phi = phiG ? phiG[j] : null;
    const sw = swG ? swG[j] : null;
    if ([ntg, phi, sw].some((v) => v !== null && isNull(v))) continue;
    add(String(labels ? labels[j] : 0), t, ntg, phi, sw);
    add('total', t, ntg, phi, sw);
  }
  return blocks;
}

/**
 * Zone volumes split by fluid contacts (Earth Modeling T1 finding
 * EM-T1-001, 2026-09-26). zoneVolumes counts the whole zone as
 * hydrocarbon (pore x (1 - Sw) everywhere), so a zone that crosses a
 * water contact reports its water leg as oil. Here each node's interval
 * [top, base] (metres, positive down) is cut by the gas-oil and oil-water
 * contacts:
 *
 *   gas column  = overlap([top, base], [-inf, GOC])
 *   oil column  = overlap([top, base], [GOC, OWC])      (GOC absent: -inf)
 *   water       = the rest below OWC                     (OWC absent: none)
 *
 * and the hydrocarbon pore volume is summed over the gas and oil columns
 * only. With no contact at all the result equals zoneVolumes. A contact
 * may be one depth for the whole zone or one per block ({[block]: depth}).
 * With formation volume factors, in-place volumes at surface conditions
 * follow: STOIIP = oil HCPV / Bo (stock-tank m3), GIIP = gas HCPV / Bg
 * (standard m3; Bg in reservoir m3 per standard m3). Pure, no I/O;
 * validated against tools/validation/earthmodel/oracle_contacts.py.
 *
 * @param {{dx,dy,nx,ny}} spec
 * @param {ArrayLike<number>} top zone top depth grid (m, positive down)
 * @param {ArrayLike<number>} base zone base depth grid (m, positive down)
 * @param {Int32Array|null} labels block labels (null = one block 0)
 * @param {{ntg?, phi?, sw?}} props property grids (as zoneVolumes)
 * @param {{goc?: number|Object<string, number>, owc?: number|Object<string, number>,
 *   bo?: number, bg?: number}} [fluids]
 * @returns {Object<string, {bulk_m3, net_m3, pore_m3, hcpv_m3, gas_hcpv_m3, oil_hcpv_m3,
 *   gas_bulk_m3, oil_bulk_m3, stoiip_m3: number|null, giip_m3: number|null, cells}>}
 */
export function zoneVolumesWithContacts(spec, top, base, labels, props = {}, fluids = {}) {
  if (top.length !== base.length) throw new Error('The zone top and base grids must share a frame.');
  const cell = spec.dx * spec.dy;
  const { ntg: ntgG = null, phi: phiG = null, sw: swG = null } = props;
  for (const g of [ntgG, phiG, swG]) {
    if (g && g.length !== top.length) throw new Error('Property grids must share the zone thickness frame.');
  }
  const { goc = null, owc = null, bo = null, bg = null } = fluids;
  if (bo !== null && !(bo > 0)) throw new Error('Bo must be greater than zero.');
  if (bg !== null && !(bg > 0)) throw new Error('Bg must be greater than zero.');
  const contactFor = (c, lab) => {
    if (c === null || c === undefined) return null;
    if (typeof c === 'number') return Number.isFinite(c) ? c : null;
    const v = Object.prototype.hasOwnProperty.call(c, lab) ? c[lab] : null;
    return Number.isFinite(v) ? v : null;
  };
  const blocks = {};
  const add = (lab, t, gasT, oilT, ntg, phi, sw) => {
    const b = blocks[lab] || (blocks[lab] = {
      bulk_m3: 0, net_m3: 0, pore_m3: 0, hcpv_m3: 0, gas_hcpv_m3: 0, oil_hcpv_m3: 0, gas_bulk_m3: 0, oil_bulk_m3: 0, cells: 0,
    });
    b.cells += 1;
    b.bulk_m3 += t * cell;
    b.gas_bulk_m3 += gasT * cell;
    b.oil_bulk_m3 += oilT * cell;
    if (ntg === null) return;
    b.net_m3 += t * cell * ntg;
    if (phi === null) return;
    b.pore_m3 += t * cell * ntg * phi;
    if (sw === null) return;
    b.gas_hcpv_m3 += gasT * cell * ntg * phi * (1 - sw);
    b.oil_hcpv_m3 += oilT * cell * ntg * phi * (1 - sw);
    b.hcpv_m3 += (gasT + oilT) * cell * ntg * phi * (1 - sw);
  };
  for (let j = 0; j < top.length; j++) {
    const zt = top[j]; const zb = base[j];
    if (isNull(zt) || isNull(zb)) continue;
    const ntg = ntgG ? ntgG[j] : null;
    const phi = phiG ? phiG[j] : null;
    const sw = swG ? swG[j] : null;
    if ([ntg, phi, sw].some((v) => v !== null && isNull(v))) continue;
    const lab = String(labels ? labels[j] : 0);
    const t = Math.max(0, zb - zt);
    const g = contactFor(goc, lab);
    const w = contactFor(owc, lab);
    const hcBottom = w === null ? zb : Math.min(zb, w);
    const gasT = g === null ? 0 : Math.max(0, Math.min(hcBottom, g) - zt);
    const oilTop = g === null ? zt : Math.max(zt, g);
    const oilT = Math.max(0, hcBottom - oilTop);
    add(lab, t, gasT, oilT, ntg, phi, sw);
    add('total', t, gasT, oilT, ntg, phi, sw);
  }
  for (const b of Object.values(blocks)) {
    b.stoiip_m3 = bo !== null ? b.oil_hcpv_m3 / bo : null;
    b.giip_m3 = bg !== null ? b.gas_hcpv_m3 / bg : null;
  }
  return blocks;
}
