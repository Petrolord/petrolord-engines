# Log editing goldens (QI A3, 2026-10-06)

`goldens.logEdit.json` is written by `tools/validation/petrophysics/oracle_log_edit.py`
(stdlib only; regeneration is byte-identical).

## Drift
- **Synthetic well:** a linear true sonic, which the trapezoid rule integrates exactly, and checkshot times in closed form.
- **Recorded sonic:** the true sonic plus bias blocks of +6 us/m over 1100 to 1400 m and -4 us/m over 1600 to 1900 m.
- **Anchors:**
  - D1: the true sonic shows zero drift.
  - D2: the drift is minus the trapezoid integral of the bias.
  - D3: the +6 us/m block integrates to exactly 1.8 ms.
  - D4: the corrected sonic closes on every level within half the spread of the corrections times the step.
  - D5: an interval's correction is minus its mean bias.

## Splice and edits
- **Splice:** two runs 2.5 apart in the overlap, with a 3 m level-match window (offset -2.5 from 6 samples).
- **Edits:** worked by hand in the jest gate.
