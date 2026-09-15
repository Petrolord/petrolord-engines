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

