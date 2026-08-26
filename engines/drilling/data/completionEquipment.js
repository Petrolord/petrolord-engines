// Completion equipment planning catalog (Drilling D7 — Completion Design).
//
// Provenance: these are PLANNING-LEVEL nominal dimensions. Landing-nipple
// seat bores are the standard X/XN profile bores by tubing size as
// republished across completion handbooks; tubing coupling ODs are the
// published API 5CT EUE coupling dimensions. Jewelry body ODs, lengths and
// packer/PBR dimensions are customary planning values (every row is marked
// approx: true) — real designs verify against the manufacturer data sheet
// for the exact model run. The suite's ARMED L14 validation gate
// spot-checks this table against an owner-supplied vendor data book.
//
// Storage is SI (metres); `*In` fields keep the familiar field-unit
// designations for display. Conversions happen here, once.

const IN = 0.0254; // m

// Published API 5CT EUE coupling ODs by tubing size (the customary
// max-OD of a plain tubing joint, used as the default jewelry body OD).
export const EUE_COUPLING_OD_IN = {
  '2.375': 3.063,
  '2.875': 3.668,
  '3.5': 4.5,
  '4.5': 5.563,
};

// Standard X (selective) / XN (no-go) landing-nipple seat bores by tubing
// size — the classic published profile bores.
export const NIPPLE_BORES_IN = {
  '2.375': { x: 1.875, xn: 1.791 },
  '2.875': { x: 2.313, xn: 2.205 },
  '3.5': { x: 2.75, xn: 2.635 },
  '4.5': { x: 3.813, xn: 3.725 },
};

const row = ({
  type, name, forTubingOdIn = null, odIn, idIn, lengthM,
  eccentric = false, approx = true, notes = '',
}) => ({
  type, name, forTubingOdIn,
  odM: odIn * IN, idM: idIn * IN, lengthM,
  odIn, idIn, eccentric, approx, notes,
});

// Jewelry per tubing size. IDs: the through-bore that governs wireline
// access (seat bore for nipples, tubing ID otherwise).
function jewelryFor(odIn, idIn) {
  const key = String(odIn);
  const cpl = EUE_COUPLING_OD_IN[key];
  const bores = NIPPLE_BORES_IN[key];
  const t = (p) => ({ ...p, forTubingOdIn: odIn });
  return [
    row(t({ type: 'tubing', name: `Tubing ${odIn}" EUE`, odIn: cpl, idIn, lengthM: 100, notes: 'run length is set in the string builder; OD is the coupling OD' })),
    row(t({ type: 'flow-coupling', name: `Flow coupling ${odIn}"`, odIn: cpl, idIn, lengthM: 0.9 })),
    row(t({ type: 'blast-joint', name: `Blast joint ${odIn}"`, odIn: cpl, idIn, lengthM: 6.1 })),
    row(t({ type: 'nipple-x', name: `X landing nipple ${odIn}"`, odIn: cpl, idIn: bores.x, lengthM: 0.4, notes: 'selective; seat bore is the through-bore restriction' })),
    row(t({ type: 'nipple-xn', name: `XN no-go nipple ${odIn}"`, odIn: cpl, idIn: bores.xn, lengthM: 0.45, notes: 'no-go; smallest bore in the string by design' })),
    row(t({ type: 'sliding-sleeve', name: `Sliding sleeve ${odIn}"`, odIn: { '2.375': 3.25, '2.875': 3.81, '3.5': 4.56, '4.5': 5.6 }[key], idIn: bores.x, lengthM: 1.5 })),
    row(t({ type: 'spm', name: `Side pocket mandrel ${odIn}"`, odIn: { '2.375': 4.44, '2.875': 5.0, '3.5': 5.75, '4.5': 6.5 }[key], idIn, lengthM: 2.4, eccentric: true, notes: 'eccentric body; OD governs run-in clearance' })),
    row(t({ type: 'sssv', name: `TRSV safety valve ${odIn}"`, odIn: { '2.375': 4.9, '2.875': 5.25, '3.5': 5.75, '4.5': 6.94 }[key], idIn: bores.x, lengthM: 2.2, notes: 'tubing-retrievable, flapper' })),
    row(t({ type: 'expansion-joint', name: `Expansion joint ${odIn}"`, odIn: cpl + 1.0, idIn, lengthM: 3.0, notes: 'mid-stroke length' })),
    row(t({ type: 'perforated-joint', name: `Perforated joint ${odIn}"`, odIn, idIn, lengthM: 3.0 })),
    row(t({ type: 'weg', name: `Wireline entry guide ${odIn}"`, odIn: cpl, idIn, lengthM: 0.3 })),
  ];
}

// Production packers / seal systems by casing size (planning values).
export const PACKERS = [
  row({ type: 'packer', name: 'Production packer 5-1/2" casing', odIn: 4.5, idIn: 2.0, lengthM: 1.4, notes: 'for 5-1/2" 17-23# (drift 4.653-4.767")' }),
  row({ type: 'packer', name: 'Production packer 7" casing', odIn: 5.875, idIn: 2.75, lengthM: 1.5, notes: 'for 7" 26-32# (drift 5.969-6.151")' }),
  row({ type: 'packer', name: 'Production packer 9-5/8" casing', odIn: 8.25, idIn: 4.0, lengthM: 1.8, notes: 'for 9-5/8" 40-53.5# (drift 8.379-8.679")' }),
  row({ type: 'pbr', name: 'PBR 4.75" bore', odIn: 5.75, idIn: 4.75, lengthM: 6.1, notes: 'polished bore receptacle; length is the honed bore' }),
  row({ type: 'seal-assembly', name: 'Seal assembly 4.75"', odIn: 4.75, idIn: 3.0, lengthM: 3.0, notes: 'locator seal stack for the 4.75" PBR' }),
];

export const EQUIPMENT_CATALOG = [
  ...jewelryFor(2.375, 1.995),
  ...jewelryFor(2.875, 2.441),
  ...jewelryFor(3.5, 2.992),
  ...jewelryFor(4.5, 3.958),
  ...PACKERS,
];

export const EQUIPMENT_TYPES = [...new Set(EQUIPMENT_CATALOG.map((r) => r.type))];

export const CD_CATALOG = {
  EQUIPMENT_CATALOG, PACKERS, NIPPLE_BORES_IN, EUE_COUPLING_OD_IN, EQUIPMENT_TYPES,
};
