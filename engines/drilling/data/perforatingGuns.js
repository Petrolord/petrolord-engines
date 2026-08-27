// Perforating gun catalog (Drilling D8 — Perforation & Sand Control
// Designer).
//
// PLANNING-LEVEL nominal data, API RP 19B Section-1 style: every row is
// published-typical for its gun class (carrier OD, shot density, phasing,
// entrance hole and penetration in the API concrete target), marked
// approx. Real designs verify against the manufacturer's charge data
// sheet for the actual gun/charge/casing combination — API targets are
// not downhole rock. The L15 literature gate spot-checks these rows.
//
// Phasing values are restricted to the SPE 18247 table angles so the
// Karakas-Tariq skin needs no phasing interpolation.

const IN = 0.0254;
const FT_PER_M = 3.280839895;

const gun = ({ name, conveyance, odIn, spfPerFt, phasingDeg, entranceHoleIn, penetrationIn, notes = '' }) => ({
  name,
  conveyance, // 'through-tubing' | 'casing'
  odIn,
  odM: odIn * IN,
  spfPerFt,
  spfPerM: spfPerFt * FT_PER_M,
  phasingDeg,
  entranceHoleIn,
  entranceHoleM: entranceHoleIn * IN,
  penetrationIn,
  penetrationM: penetrationIn * IN,
  approx: true,
  notes,
});

export const GUN_CATALOG = [
  gun({
    name: '1-11/16" through-tubing gun', conveyance: 'through-tubing', odIn: 1.6875,
    spfPerFt: 4, phasingDeg: 0, entranceHoleIn: 0.24, penetrationIn: 12,
    notes: 'wireline through-tubing; in-line shots',
  }),
  gun({
    name: '2-1/8" through-tubing gun', conveyance: 'through-tubing', odIn: 2.125,
    spfPerFt: 4, phasingDeg: 0, entranceHoleIn: 0.30, penetrationIn: 15,
    notes: 'wireline through-tubing; in-line shots',
  }),
  gun({
    name: '2-7/8" through-tubing gun', conveyance: 'through-tubing', odIn: 2.875,
    spfPerFt: 6, phasingDeg: 60, entranceHoleIn: 0.32, penetrationIn: 18,
  }),
  gun({
    name: '3-1/8" casing gun', conveyance: 'casing', odIn: 3.125,
    spfPerFt: 6, phasingDeg: 60, entranceHoleIn: 0.36, penetrationIn: 24,
  }),
  gun({
    name: '3-3/8" casing gun', conveyance: 'casing', odIn: 3.375,
    spfPerFt: 6, phasingDeg: 60, entranceHoleIn: 0.36, penetrationIn: 26,
  }),
  gun({
    name: '4" casing gun', conveyance: 'casing', odIn: 4,
    spfPerFt: 6, phasingDeg: 60, entranceHoleIn: 0.40, penetrationIn: 30,
  }),
  gun({
    name: '4-5/8" high-shot-density gun', conveyance: 'casing', odIn: 4.625,
    spfPerFt: 12, phasingDeg: 45, entranceHoleIn: 0.43, penetrationIn: 32,
    notes: '135/45 phasing family; TCP or wireline',
  }),
  gun({
    name: '5" high-shot-density gun', conveyance: 'casing', odIn: 5,
    spfPerFt: 12, phasingDeg: 60, entranceHoleIn: 0.44, penetrationIn: 36,
  }),
  gun({
    name: '7" big-hole casing gun', conveyance: 'casing', odIn: 7,
    spfPerFt: 12, phasingDeg: 60, entranceHoleIn: 0.70, penetrationIn: 40,
    notes: 'big-hole charge family for gravel-pack perforating',
  }),
];

export const GUN_CONVEYANCES = ['through-tubing', 'casing'];
