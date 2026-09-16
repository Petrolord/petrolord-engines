# FINDINGS: separation and layout spacing (FC1-0, 2026-09-15)

Recorded for engines PR #188 (branch fix/fc1-0-separator-spacing), the repair-first wave before the NextGen Separation & Slug Catching course. Committed from the PR body because the authoring agent could not create markdown files.


The harness blocked this agent from creating `tools/validation/facilities/FINDINGS-separation.md`, so the record is kept here. Recorded FIXED 2026-09-15: D1, D2, D3, D4, D5, D6 (partial), D7, D8, D9, S2, S3 and S4, as described in the table.

Decisions taken while implementing:
- A three-phase row that fails a droplet verdict is infeasible, because a vessel that carries water over does not separate.
- Ppr below 0.2 is accepted with a note rather than refused. The DAK surface runs to the ideal-gas limit there, and refusing it would refuse every low-pressure separator (100 psia is Ppr 0.15). `engines/fluid/blackOil.ts`, the repo's statement of the DAK range, does not enforce the lower Ppr bound either.
- `checkLayout.complete` is also false when a type pair is unknown.
- `worst` is removed rather than aliased, so no caller reads an unnamed ranking.

Held for literature verification (unchanged):
- The K pressure derating: 0.01 per 100 psi over 100 psig, with a 0.12 floor.
- Horizontal vessels use Souders-Brown vT at the horizontal K as the droplet settling velocity.
- A consequence found here and pinned by a FINDING gate: Lgas = (vGas / vT) x gas height. Under the gas capacity rule that is at most the gas height, so gas can control a horizontal vessel only when the vessel is gas-overloaded or shorter than its diameter. If the literature method sizes gas length from a droplet diameter, this gate must be revisited.


---

# FC1 finding 7: a near-floor flag beside `floored` (2026-09-16)

Recorded for the follow-on engines PR, branch `fix/fc1-near-floor-k`.

**The finding.** `floored` is a cliff, and there was no flag beside it for the approach to the cliff. The published case `verticalNoneAt650psig` returned K 0.125000 with `derated` true and `floored` false, which reads exactly like a robust derated value, while sitting 0.005000 above the 0.12 floor. That is half a step of a rule that deducts 0.01 per 100 psi, so 50 psig more of operating pressure floors that vessel, and nothing in the return said the answer was sitting on the edge of the range where the rule of thumb stops meaning anything.

**What was implemented.** `kValue` returns `nearFloor` beside `floored`.

- `nearFloor` is true when the floor did NOT catch this K and one more 100 psi step of the same published rule WOULD put it under the floor. It is derived from the rule rather than from a chosen threshold, so it moves if the literature ever moves the slope. `K_DERATE_PER_100PSI` is now exported for that reason.
- `floored` and `nearFloor` are mutually exclusive: a floored K is on the cliff, not walking towards it.
- A typed K (`kOverride`) reports `nearFloor` false alongside `derated` and `floored` false. The derating rule did not touch it, so none of the rule's flags can be raised, and the return shape does not change between branches.
- The flag is NOT a warning. Nothing reconciles a vendor K against the table either (finding 6), and that remains open.

**A boundary defect found while building the oracle sweep, and repaired.** The floor comparison was `kDerated < K_FLOOR` in binary floating point. A derating that lands exactly on the floor, such as `verticalMesh` at 2400 psig where the published rule gives `0.35 - 0.01 * 23 = 0.12` exactly, evaluates to 0.11999999999999997 and was floored by the engine while the exact-rational oracle did not floor it. Both comparisons against the floor now carry `K_FLOOR_EPS` of 1e-9, which is fifteen orders below the six decimals a K is ever reported at. ~~Five pressures in 0 to 4000 psig are affected, one per base row~~ **EXACTLY ONE input in the whole space is affected, and it is `verticalMesh` at 2400 psig; see the correction below.** None of them is a published golden, so **no golden value moved**.

### Correction (2026-09-16): one input, not five

Recorded while vendoring this commit into the Petrolord Suite, where the claim was re-derived independently rather than carried on trust.

The sentence above said five pressures were affected, one per base row. That does not reproduce. The crossing pressure of a row is where the published rule lands the derating exactly on the floor, `p = 100 + 10000 * (kBase - 0.12)`, and there is exactly one such pressure per row. But whether the old bare `<` and the new `< 0.12 - 1e-9` disagree there depends on which side of 0.12 the binary double falls on, and **five of the six rows land ON 0.12 or just above it**, where both comparisons already agreed.

Swept at 0.01 psi from 0 to 6000 psig across all six `K_BASE` rows, 3600006 inputs, the `floored` verdict changes at **one** of them:

```
row             kBase  p psig  kDerated read as        verdict
verticalMesh    0.35    2400   0.11999999999999996780  MOVES
verticalVane    0.42    3100   0.11999999999999999556  no
verticalNone    0.18     700   0.11999999999999999556  no
horizontalMesh  0.45    3400   0.11999999999999999556  no
horizontalVane  0.55    4400   0.12000000000000005107  no
horizontalNone  0.25    1400   0.11999999999999999556  no
```

The range in the original sentence is also short: `horizontalVane` crosses at 4400 psig, outside the stated 0 to 4000 psig, which is why the sweep above runs to 6000.

The repair itself and everything else in this finding stand. `K_FLOOR_EPS` is load-bearing in one further place in the same function, which is worth stating because it is easy to read the epsilon as affecting only `floored`: `nearFloor` re-applies the rule at `pPsig + 100` and compares against the same floor, so at `verticalMesh` 2300 psig the bare comparison would read `nearFloor` true and the epsilon reads it false. `nearFloor` is new in this PR, so nothing moved there; it is a statement about which comparison the shipped flag is built on.

**Validation.** The oracle derives `nearFloor` from the published rule in exact rational arithmetic, by re-applying the rule at `pPsig + 100` and asking whether the floor binds there, with no reference to the JS. Engine against oracle over all six mist-extractor rows at every half psi from 0 to 4000 psig, 48006 points: **0 mismatches**, 1000 points flagged `nearFloor`, 18000 floored, and the two flags never true together. The goldens gained `nearFloor` on all six `kValue` cases and `verticalNoneAt650psig` is the one that carries true; no `k`, `kDerated`, `floored` or `derated` value changed.

**Graded capstone values.** None moved, and none could: every FC1 capstone tier states its own vendor K and the capstone generator calls `kValue({ kOverride })` only, so no graded field reads the table, the derating or the floor. Verified against all eighteen graded fields across the three tiers rather than assumed.
