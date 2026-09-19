# FINDINGS: exposure (oracle_exposure.py, HSE H2)

Engine `engines/hse/exposure.js`; golden `test-data/hse/goldens/exposure_cases.json`
written by `tools/validation/hse/oracle_exposure.py` (stdlib only, never runs the
JS); gate `__tests__/hse.exposure.test.js`, which calls the engine for every case.

- 441 cases, all checked against the oracle to 1e-9; 372 also against the value
  the source PRINTS at its printed precision (`basis: "published"`), 69
  oracle-only.
- 5 published errata (printed values the source's own formula refutes), pinned:
  the engine must stay OUTSIDE their tolerance.
- 57 refusals, each checked for `error` and the named `field`.

## 1. Sources, verified (read 2026-09-19)

| topic | source read | fixes |
|---|---|---|
| noise dose/TWA | 29 CFR 1910.95 App. A (eCFR) | D = 100 sum(C/T); TWA = 16.61 log10(D/100) + 90; Table G-16a (80 to 130 dB); Table A-1 (10 to 999 %); text: 91 % is 89.3 dB, 50 % is 85 dB |
| action level | 1910.95(c)(1)-(2), (d)(2)(i) | TWA 85 "or, equivalently, a dose of fifty percent" via App. A/Table G-16a; 80 to 130 dB integrated |
| PEL threshold, OTM | OSHA Technical Manual III-5 (Oregon OSHA reprint; osha.gov returned 403) | PEL threshold 90 dBA ("any noise below 90 dBA is not integrated"); AL dosimetry 90 PEL / 80 threshold / 5 dB; 92 dBA = 132 %; 87 dBA = 66 %; extended-shift AL = 16.61 log10[50/(12.5 h)] + 90 and Table IV-3 (8/85, 9/84.2, 10/83.4, 12/82.1, 16/80) |
| protectors | 1910.95 App. B; OTM App. E; NIOSH 98-126 Appendix | App. B: A-weighted minus (NRR - 7), C-weighted minus NRR. OTM: 98 dBA, NRR 25 gives 98 - (25-7)x50% = 89 (engineering-controls decision), 98 - (25-7) = 80 (hearing conservation); dual: higher NRR, -7 if A-weighted, +5. NIOSH: NRR derated to 75/50/30 % (muff/formable plug/other plug), then dBA - (NRR' - 7) or dBC - NRR' |
| NIOSH noise | NIOSH 98-126 s.1.1, Tables 1-1, 1-2 (nonoise.org transcription) | T = 480/2^((L-85)/3) min; TWA = 10.0 log(D/100) + 85; ceiling 115 dBA |
| LEX,8h | HSE L108 Schedule 1 (UK transposition of 2003/10/EC, cites ISO 1999 cl. 3.6) | LEP,d = 10 log10[(1/T0) sum Ti 10^(0.1 L)], T0 = 8 h; LEP,w with divisor 5; action values 80/85, limit 87 |
| exposure points | L108 App. 3, Figure 26 | EP = 100 (T/8) 10^((L-85)/10); LEP,d = 85 + 10 log10(EP/100); example 80 dB 5 h, 86 dB 2 h, 95 dB 45 min gives 78/80/85 dB, 20/31/94 points, total 87 dB(A), 145 points |
| chemical | 29 CFR 1910.1000(d)(1),(d)(2) | E = sum(C T)/8, example 81.25 ppm; Em = sum C/L <= 1, example 0.925 |
| Brief & Scala | 1975 paper not reachable; ESTA note, checked against BC OHS Reg 5.50 (0.7/0.5/0.25/0.1 = B&S at 10/12/16/20 h) | RF = (8/h)(24-h)/16; weekly (40/h)(168-h)/128 |
| heat | NIOSH 2016-106 | RAL = 59.9 - 14.1 log10 M, REL = 56.7 - 11.5 log10 M (W, C WBGT) s.8.1; WBGT indoor 0.7 tnwb + 0.3 tg, outdoor 0.7 tnwb + 0.2 tg + 0.1 ta s.9.3.2; 1-hour TWAs; 70 kg standard man |

## 2. Corrections to the brief

- Reference durations are Table G-16a; Table A-1 is dose to TWA. Both gated (51
  rows, and 150 of 151).
- The OSHA action level is 50 % dose on the 90 dB / 5 dB scale, per
  1910.95(c)(1), rather than an 85 dB criterion. The preset is criterion 90,
  threshold 80, limit 50 %. The Oregon OTM lists an 85 dBA hearing-conservation
  criterion in one place; that gives the same TWA with a doubled dose number. The
  federal wording is implemented.
- App. B has no 50 % factor; (NRR-7)/2 is the OTM App. E field derating for the
  engineering-controls decision. Both are named methods.
- NIOSH derating is by protector type and applies to NRR before the -7 (OSHA
  derates NRR-7). Spectral methods need octave bands and were dropped.
- 16.61 and 10.0 are the printed roundings of 5/log10 2 = 16.6096 and
  3/log10 2 = 9.9658 (see J1).

## 3. Published errata

| id | printed | formula |
|---|---|---|
| a1-115 (Table A-1) | 91.1 | 91.008 (neighbours 114 at 90.9 and 116 at 91.1 agree) |
| niosh-t12-50000 (Table 1-2) | 102.0 | 111.99, a digit slip for 112.0 (possibly the reprint's) |
| niosh-t11-99 (Table 1-1) | 18 min 59 s | 18 min 53.9 s |
| niosh-heat-example-rel (2016-106 s.1.1.3) | 27.8 C at 348.9 W, read off Fig. 8-2 | 27.459 C by the s.8.1 equation |
| niosh-heat-example-ral | 25 C off Fig. 8-1 | 24.052 C |

Tolerance notes: NIOSH Table 1-1 rows 124 and 127 are truncated where the others
round, so the table is gated at one printed unit. G-16a 125 dB is exactly
0.0625, printed 0.063 (round half up). HSE Fig. 26 hh:mm prints 6:21 for 6:20.97
but 2:00 for 2:00.57, so it is gated at 1 minute. NIOSH 2016 Table 5-1 band
values (30/28/26/25) are band summaries (the equation gives 29.47/27.46/26.02/
24.92 at 233/349/465/580 W); not gated.

## 4. Judgement calls

- **J1:** each preset uses its printed constant (16.61 OSHA, 10.0 NIOSH). The
  exact q/log10 2 fails 50 of NIOSH Table 1-2's 84 rows. The cost is that NIOSH
  reads 8 h at 100 dBA as 100.05 dBA. Custom criteria default to the exact
  constant, so a constant level returns itself.
- **J2:** the threshold is inclusive.
- **J3:** above 130 dB, above 115 dB and above the NIOSH ceiling the result warns
  instead of refusing. Levels are still integrated, per the OTM ("should be
  incorporated").
- **J4:** noise, LEX and chemical periods totalling over 24 h are refused.
- **J5:** protector credit is floored at 0, with a warning. OSHA_FIELD_50 is
  refused for C-weighted data because the OTM publishes it for A-weighted only.
- **J6:** the 8-h TWA always divides by 8, with warnings under or over 8 h. The
  STEL divides by 15 and refuses more than 15 minutes.
- **J7:** a mixture index of exactly 1 passes.
- **J8:** the B&S factor is capped at 1 (rawRf kept); the smaller of the daily
  and weekly factors governs; 24 h a day gives 0.
- **J9:** the NIOSH assessment requires 60 minutes of periods and warns outside
  116 to 580 W. Inputs are W only (the document says 1.16 but its example uses
  1.163).
- **J10:** weekly LEX always divides by 5 and accepts at most 7 days.

## 5. Dropped

- ISO 9612 and ISO 7243 texts: paywalled. LEX comes from the UK Schedule 1, and
  the WBGT weights from NIOSH 2016 s.9.3.2.
- ISO 7243 body-height weighting and clothing adjustments: no public primary
  source found. ISO 7243:2017 reportedly uses the same RAL/REL equations; not
  verified.
- ISO 9612 uncertainty budgets: in the paywalled standard.
- Spectral protector methods: need octave-band data.
- ACGIH TLVs: licensed.
- Chemical ceiling ("C") limits: a comparison, left to the caller.
- NIOSH heat ceilings: withdrawn in 2016.

## 6. Negative controls (negcontrol_exposure.sh, 518 tests)

Engine plants, all RED (tests failed): PEL exchange rate 5 to 3: 11; action-level
exchange rate 5 to 3: 55; 16.61 to 10: 155; NIOSH 10.0 to 3/log10 2: 85; NIOSH
exchange rate 3 to 5: 52; PEL threshold 90 to 80: 5; threshold inclusive to
exclusive: 6; T 8 to 8.5 h: 102; action limit 50 to 100 %: 4; AL 12.5 to 12: 6;
field derating 50 to 60 %: 1; earmuff 0.75 to 0.7: 2; dual +5 to +3: 2;
protector floor removed: 3; LEX 8 to 8.5 h: 6; points pivot 85 to 80: 3; weekly
divisor 5 to days: 1; TWA divides by sampled time: 1; STEL divides by sampled
minutes: 1; mixture C/L to L/C: 3; mixture unity inclusive: 1; B&S 16 to 15: 7;
B&S cap removed: 1; B&S weekly 128 to 120: 5; larger factor governs: 2; WBGT
outdoor weights swapped: 1; WBGT indoor 0.3 to 0.2: 2; REL 11.5 to 11: 8; RAL
59.9 to 59: 8; refusal field names dropped: 58; negative duration accepted: 2.

Oracle-only plants, all RED: 16.61 to 16.6096: 159; 28800 to 28000 s: 5; B&S 16
to 15: 4; REL 11.5 to 11: 8.

Same defect planted in both files: 16.61 to 10: RED, 155 (Table A-1 catches it);
NIOSH 10.0 to 3/log10 2: RED, 51 (Table 1-2 catches it); WBGT outdoor weights
swapped: GREEN, expected; REL 11.5 to 11: GREEN, expected.

The heat equations and WBGT weights are checked for transcription only: no
public printed value reproduces them. A course must not present them as
independently verified.
