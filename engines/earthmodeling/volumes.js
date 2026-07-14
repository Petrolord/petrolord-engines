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
