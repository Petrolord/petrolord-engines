// Proppant catalog (Drilling D9 — Stimulation Designer).
//
// PLANNING-LEVEL nominal data: pack permeability vs closure stress per
// proppant family, published-typical long-term values, every row marked
// approx. Vendor conductivity cells (API RP 19D) govern a real design;
// the L18 literature gate spot-checks these rows against the
// owner-supplied vendor data. Gel damage is applied separately via the
// engine's damageFactor.

const DARCY_M2 = 9.869233e-13;
const KPSI_PA = 6.894757293168e6; // 1000 psi

const proppant = ({ name, mesh, rhoKgM3, kAtClosureDarcy }) => ({
  name,
  mesh,
  rhoKgM3,
  packPorosity: 0.35,
  // closure (kpsi) -> nominal pack permeability (darcies)
  kAtClosureDarcy,
  approx: true,
});

export const PROPPANT_CATALOG = [
  proppant({
    name: '20/40 frac sand', mesh: '20/40', rhoKgM3: 2650,
    kAtClosureDarcy: { 2: 120, 4: 60, 6: 20, 8: 5 },
  }),
  proppant({
    name: '16/30 frac sand', mesh: '16/30', rhoKgM3: 2650,
    kAtClosureDarcy: { 2: 200, 4: 90, 6: 25, 8: 6 },
  }),
  proppant({
    name: '30/50 frac sand', mesh: '30/50', rhoKgM3: 2650,
    kAtClosureDarcy: { 2: 60, 4: 35, 6: 15, 8: 4 },
  }),
  proppant({
    name: '20/40 resin-coated sand', mesh: '20/40', rhoKgM3: 2550,
    kAtClosureDarcy: { 2: 130, 4: 80, 6: 40, 8: 15 },
  }),
  proppant({
    name: '20/40 ISP ceramic', mesh: '20/40', rhoKgM3: 3270,
    kAtClosureDarcy: { 2: 250, 4: 180, 6: 120, 8: 70 },
  }),
];

/**
 * Nominal pack permeability at closure stress: log-linear interpolation
 * between the tabulated closure points, CLAMPED at the table edges with
 * a flag (never extrapolated).
 */
export function packPermeabilityM2(row, closurePa) {
  const pts = Object.entries(row.kAtClosureDarcy)
    .map(([kpsi, d]) => ({ closurePa: Number(kpsi) * KPSI_PA, kM2: d * DARCY_M2 }))
    .sort((a, b) => a.closurePa - b.closurePa);
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (closurePa <= first.closurePa) return { kM2: first.kM2, clamped: closurePa < first.closurePa };
  if (closurePa >= last.closurePa) return { kM2: last.kM2, clamped: closurePa > last.closurePa };
  let i = 1;
  while (pts[i].closurePa < closurePa) i += 1;
  const a = pts[i - 1];
  const b = pts[i];
  const f = (closurePa - a.closurePa) / (b.closurePa - a.closurePa);
  return {
    kM2: Math.exp(Math.log(a.kM2) + f * (Math.log(b.kM2) - Math.log(a.kM2))),
    clamped: false,
  };
}
