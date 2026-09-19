#!/usr/bin/env python3
"""
Independent oracle for engines/hse/exposure.js (HSE H2: occupational
hygiene exposure, noise, chemical and heat).

Stdlib only. It never imports or runs the JavaScript. It writes
test-data/hse/goldens/exposure_cases.json, which
__tests__/hse.exposure.test.js replays AGAINST THE ENGINE.

Every case carries:
  expect     the ORACLE's value for each named output (engine must agree
             to 1e-9, relative or absolute, whichever is looser);
  published  (where a source prints a number) the PRINTED value and the
             tolerance its printed precision allows: half a unit in the
             last printed place unless the case says otherwise;
  source     the document the inputs and any printed value come from;
  basis      'published' when a printed value gates the case,
             'oracle' when the only truth is this file's arithmetic.

`errata` lists printed values the source's own formula does NOT
reproduce. They are pinned the other way round: the engine must stay
OUTSIDE the printed tolerance, so a change that "fixes" the engine to
match a typo turns the gate red.

WHAT EACH ROUTE CHECKS AND WHAT IT CANNOT.

  route            route taken here                      discriminating truth
  --------------   -----------------------------------   --------------------
  reference        8 exp(-ln2 (L-Lc)/q) hours; the       Table G-16a (51 rows),
   duration        NIOSH route starts from the printed   NIOSH Table 1-1
                   480-minute form and converts          (49 rows + 1 erratum)
  dose             math.fsum of fractions C/T            App A I(1)(ii) form,
                                                         Table G-16a entries
  TWA from dose    the PRINTED constant (16.61, 10.0)    Table A-1 (150 rows
   (presets)       applied to log10(D/100). The engine   + 1 erratum), NIOSH
                   takes the same printed constant, so   Table 1-2 (83 rows +
                   the agreement here is shared; the     1 erratum): the tables
                   TABLES are what check it              discriminate 16.61
                                                         from 10, and 10.0
                                                         from 9.966
  TWA from dose    BISECTION: the constant level whose   the definition
   (custom)        8-hour dose equals D                  (constant level ->
                                                         TWA = level)
  LEX,8h           through SOUND PRESSURE: p^2 = p0^2    HSE L108 Figure 26
                   10^(L/10), p0 = 20 uPa, exposure      (87 dB, 145 points,
                   E = sum p^2 t in Pa^2 s, LEX =        task rows)
                   10 log10(E / (p0^2 x 28800 s))
  points           L108 App. 3 formula                   Figure 26 points
  chemical         exact rational (fractions)            1910.1000(d)(1)(ii)
                                                         81.25 ppm;
                                                         (d)(2)(ii) 0.925
  Brief & Scala    exact rational                        BC OHS Reg 5.50
                                                         factors at 10/12/16/
                                                         20 h; ESTA 12 h
                                                         example
  protectors       the source text's arithmetic          OTM App. E: 98 dBA,
                                                         NRR 25 -> 89 / 80
  WBGT             exact rational from decimal strings   NONE printed: oracle
  heat RAL/REL     the published equations. SHARED:     NONE that reproduces:
                   nothing here derives 59.9, 14.1,      the only worked
                   56.7, 11.5                            example reads the
                                                         FIGURE (see errata)

Usage: python3 tools/validation/hse/oracle_exposure.py
"""
import json
import math
import os
from fractions import Fraction as F

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
DEST = os.path.join(ROOT, 'test-data', 'hse', 'goldens', 'exposure_cases.json')

SRC_APPA = '29 CFR 1910.95 Appendix A (eCFR, retrieved 2026-09-19)'
SRC_APPB = '29 CFR 1910.95 Appendix B (eCFR, retrieved 2026-09-19)'
SRC_OTM = 'OSHA Technical Manual Sec. III Ch. 5 (Oregon OSHA reprint, retrieved 2026-09-19)'
SRC_NIOSH_N = 'NIOSH 98-126 (1998), section 1.1 and Tables 1-1, 1-2, Appendix'
SRC_L108 = 'HSE L108 (current ed.), Schedule 1 and Appendix 3 Figure 26'
SRC_1000 = '29 CFR 1910.1000(d) (eCFR, retrieved 2026-09-19)'
SRC_BS = 'Brief and Scala (1975); BC OHS Regulation 5.50 factors; ESTA TSP note'
SRC_HEAT = 'NIOSH 2016-106, sections 8.1 and 9.3.2'

# 29 CFR 1910.95 Appendix A, Table G-16a: (A-weighted level dB, reference duration h AS PRINTED)
TABLE_G16A = [
    (80, "32"), (81, "27.9"), (82, "24.3"), (83, "21.1"), (84, "18.4"), (85, "16"),
    (86, "13.9"), (87, "12.1"), (88, "10.6"), (89, "9.2"), (90, "8"), (91, "7.0"),
    (92, "6.1"), (93, "5.3"), (94, "4.6"), (95, "4"), (96, "3.5"), (97, "3.0"),
    (98, "2.6"), (99, "2.3"), (100, "2"), (101, "1.7"), (102, "1.5"), (103, "1.3"),
    (104, "1.1"), (105, "1"), (106, "0.87"), (107, "0.76"), (108, "0.66"), (109, "0.57"),
    (110, "0.5"), (111, "0.44"), (112, "0.38"), (113, "0.33"), (114, "0.29"), (115, "0.25"),
    (116, "0.22"), (117, "0.19"), (118, "0.16"), (119, "0.14"), (120, "0.125"), (121, "0.11"),
    (122, "0.095"), (123, "0.082"), (124, "0.072"), (125, "0.063"), (126, "0.054"), (127, "0.047"),
    (128, "0.041"), (129, "0.036"), (130, "0.031"),
]
# 29 CFR 1910.95 Appendix A, Table A-1: (dose percent, TWA dB AS PRINTED)
TABLE_A1 = [
    (10, "73.4"), (15, "76.3"), (20, "78.4"), (25, "80.0"), (30, "81.3"), (35, "82.4"),
    (40, "83.4"), (45, "84.2"), (50, "85.0"), (55, "85.7"), (60, "86.3"), (65, "86.9"),
    (70, "87.4"), (75, "87.9"), (80, "88.4"), (81, "88.5"), (82, "88.6"), (83, "88.7"),
    (84, "88.7"), (85, "88.8"), (86, "88.9"), (87, "89.0"), (88, "89.1"), (89, "89.2"),
    (90, "89.2"), (91, "89.3"), (92, "89.4"), (93, "89.5"), (94, "89.6"), (95, "89.6"),
    (96, "89.7"), (97, "89.8"), (98, "89.9"), (99, "89.9"), (100, "90.0"), (101, "90.1"),
    (102, "90.1"), (103, "90.2"), (104, "90.3"), (105, "90.4"), (106, "90.4"), (107, "90.5"),
    (108, "90.6"), (109, "90.6"), (110, "90.7"), (111, "90.8"), (112, "90.8"), (113, "90.9"),
    (114, "90.9"), (115, "91.1"), (116, "91.1"), (117, "91.1"), (118, "91.2"), (119, "91.3"),
    (120, "91.3"), (125, "91.6"), (130, "91.9"), (135, "92.2"), (140, "92.4"), (145, "92.7"),
    (150, "92.9"), (155, "93.2"), (160, "93.4"), (165, "93.6"), (170, "93.8"), (175, "94.0"),
    (180, "94.2"), (185, "94.4"), (190, "94.6"), (195, "94.8"), (200, "95.0"), (210, "95.4"),
    (220, "95.7"), (230, "96.0"), (240, "96.3"), (250, "96.6"), (260, "96.9"), (270, "97.2"),
    (280, "97.4"), (290, "97.7"), (300, "97.9"), (310, "98.2"), (320, "98.4"), (330, "98.6"),
    (340, "98.8"), (350, "99.0"), (360, "99.2"), (370, "99.4"), (380, "99.6"), (390, "99.8"),
    (400, "100.0"), (410, "100.2"), (420, "100.4"), (430, "100.5"), (440, "100.7"), (450, "100.8"),
    (460, "101.0"), (470, "101.2"), (480, "101.3"), (490, "101.5"), (500, "101.6"), (510, "101.8"),
    (520, "101.9"), (530, "102.0"), (540, "102.2"), (550, "102.3"), (560, "102.4"), (570, "102.6"),
    (580, "102.7"), (590, "102.8"), (600, "102.9"), (610, "103.0"), (620, "103.2"), (630, "103.3"),
    (640, "103.4"), (650, "103.5"), (660, "103.6"), (670, "103.7"), (680, "103.8"), (690, "103.9"),
    (700, "104.0"), (710, "104.1"), (720, "104.2"), (730, "104.3"), (740, "104.4"), (750, "104.5"),
    (760, "104.6"), (770, "104.7"), (780, "104.8"), (790, "104.9"), (800, "105.0"), (810, "105.1"),
    (820, "105.2"), (830, "105.3"), (840, "105.4"), (850, "105.4"), (860, "105.5"), (870, "105.6"),
    (880, "105.7"), (890, "105.8"), (900, "105.8"), (910, "105.9"), (920, "106.0"), (930, "106.1"),
    (940, "106.2"), (950, "106.2"), (960, "106.3"), (970, "106.4"), (980, "106.5"), (990, "106.5"),
    (999, "106.6"),
]
# NIOSH 98-126 Table 1-2: (dose percent, 8-hr TWA dBA AS PRINTED), read across the three columns
NIOSH_TABLE_1_2 = [
    (20, "78.0"), (2000, "98.0"), (450000, "121.5"), (30, "79.8"), (2500, "99.0"), (500000, "122.0"),
    (40, "81.0"), (3000, "99.8"), (600000, "122.8"), (50, "82.0"), (3500, "100.4"), (700000, "123.5"),
    (60, "82.8"), (4000, "101.0"), (800000, "124.0"), (70, "83.5"), (4500, "101.5"), (900000, "124.5"),
    (80, "84.0"), (5000, "102.0"), (1000000, "125.0"), (90, "84.5"), (6000, "102.8"), (1100000, "125.4"),
    (100, "85.0"), (7000, "103.5"), (1200000, "125.8"), (110, "85.4"), (8000, "104.0"), (1300000, "126.1"),
    (120, "85.8"), (9000, "104.5"), (1400000, "126.5"), (130, "86.1"), (10000, "105.0"), (1600000, "127.0"),
    (140, "86.5"), (12000, "105.8"), (1800000, "127.6"), (150, "86.8"), (14000, "106.5"), (2000000, "128.0"),
    (170, "87.3"), (16000, "107.0"), (2200000, "128.4"), (200, "88.0"), (18000, "107.6"), (2400000, "128.8"),
    (250, "89.0"), (20000, "108.0"), (2600000, "129.1"), (300, "89.8"), (25000, "109.0"), (2800000, "129.5"),
    (350, "90.4"), (30000, "109.8"), (3000000, "129.8"), (400, "91.0"), (35000, "110.4"), (3500000, "130.4"),
    (450, "91.5"), (40000, "111.0"), (4000000, "131.0"), (500, "92.0"), (45000, "111.5"), (4500000, "131.5"),
    (550, "92.4"), (50000, "102.0"), (5000000, "132.0"), (600, "92.8"), (60000, "112.8"), (6000000, "132.8"),
    (650, "93.1"), (70000, "113.5"), (7000000, "133.5"), (700, "93.5"), (80000, "114.0"), (8000000, "134.0"),
    (750, "93.8"), (90000, "114.5"), (9000000, "134.5"), (800, "94.0"), (100000, "115.0"), (10000000, "135.0"),
]
# NIOSH 98-126 Table 1-1: level dBA -> (hours, minutes, seconds) AS PRINTED.
# Hour-scale rows print whole minutes; sub-hour rows print seconds.
NIOSH_TABLE_1_1 = {
    80: (25, 24, 0), 81: (20, 10, 0), 82: (16, 0, 0), 83: (12, 42, 0), 84: (10, 5, 0),
    85: (8, 0, 0), 86: (6, 21, 0), 87: (5, 2, 0), 88: (4, 0, 0), 89: (3, 10, 0),
    90: (2, 31, 0), 91: (2, 0, 0), 92: (1, 35, 0), 93: (1, 16, 0), 94: (1, 0, 0),
    95: (0, 47, 37), 96: (0, 37, 48), 97: (0, 30, 0), 98: (0, 23, 49), 99: (0, 18, 59),
    100: (0, 15, 0), 101: (0, 11, 54), 102: (0, 9, 27), 103: (0, 7, 30), 104: (0, 5, 57),
    105: (0, 4, 43), 106: (0, 3, 45), 107: (0, 2, 59), 108: (0, 2, 22), 109: (0, 1, 53),
    110: (0, 1, 29), 111: (0, 1, 11), 112: (0, 0, 56), 113: (0, 0, 45), 114: (0, 0, 35),
    115: (0, 0, 28), 116: (0, 0, 22), 117: (0, 0, 18), 118: (0, 0, 14), 119: (0, 0, 11),
    120: (0, 0, 9), 121: (0, 0, 7), 122: (0, 0, 6), 123: (0, 0, 4), 124: (0, 0, 3),
    125: (0, 0, 3), 126: (0, 0, 2), 127: (0, 0, 1), 128: (0, 0, 1), 129: (0, 0, 1),
}

# Printed values the source's own formula does not reproduce (see FINDINGS).
A1_ERRATA = {115: 'formula gives 91.008, printed 91.1 (neighbours 114 -> 90.9 and 116 -> 91.1 agree)'}
NIOSH_1_2_ERRATA = {50000: 'formula gives 111.99, printed 102.0 (a transposed digit for 112.0)'}
NIOSH_1_1_ERRATA = {99: 'formula gives 18 min 53.9 s, printed 18 min 59 s'}

PRESETS = {
    'OSHA_PEL': dict(lc=90, q=5, thr=90, k=16.61, limit=100),
    'OSHA_ACTION_LEVEL': dict(lc=90, q=5, thr=80, k=16.61, limit=50),
    'NIOSH_REL': dict(lc=85, q=3, thr=80, k=10.0, limit=100),
}


def crit(c):
    if isinstance(c, str):
        return PRESETS[c]
    return dict(lc=c['criterionLevelDbA'], q=c['exchangeRateDb'], thr=c.get('thresholdDbA', -math.inf),
                k=c.get('twaCoefficientDb'), limit=c.get('limitDosePct', 100))


def ref_duration_h(level, c):
    """8 exp(-ln 2 (L - Lc)/q); NIOSH from its printed 480-minute form."""
    if level < c['thr']:
        return None
    if c is PRESETS['NIOSH_REL']:
        return 480.0 * math.exp(-math.log(2) * (level - 85) / 3.0) / 60.0
    return 8.0 * math.exp(-math.log(2) * (level - c['lc']) / c['q'])


def dose_pct(periods, c):
    return 100.0 * math.fsum(p['durationH'] / ref_duration_h(p['levelDbA'], c)
                             for p in periods if p['levelDbA'] >= c['thr'])


def twa_bisect(dose, c):
    """The constant level whose 8-hour dose is `dose` (no threshold)."""
    lo, hi = c['lc'] - 200.0, c['lc'] + 200.0
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        d = 100.0 * 8.0 / (8.0 * math.exp(-math.log(2) * (mid - c['lc']) / c['q']))
        if d < dose:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def twa_from_dose(dose, c):
    if c['k'] is None:
        return twa_bisect(dose, c)
    return c['k'] * math.log10(dose / 100.0) + c['lc']


def dose_from_twa(twa, c):
    if c['k'] is None:
        return 100.0 * 2.0 ** ((twa - c['lc']) / c['q'])
    return 100.0 * 10.0 ** ((twa - c['lc']) / c['k'])


P0 = 20e-6  # Pa, the reference sound pressure


def lex(periods):
    """Through sound pressure: E = sum p^2 t (Pa^2 s); LEX = 10 log10(E/(p0^2 T0))."""
    e = math.fsum((P0 ** 2) * 10.0 ** (p['laeqDbA'] / 10.0) * p['durationH'] * 3600.0 for p in periods)
    return 10.0 * math.log10(e / (P0 ** 2 * 28800.0))


def task_lex(p):
    if p['durationH'] == 0:
        return None
    return lex([p])


def points(laeq, hours):
    return 100.0 * (hours / 8.0) * 10.0 ** ((laeq - 85.0) / 10.0)


def dec(x):
    """Half a unit in the last printed place of a printed number string."""
    if '.' in x:
        return 0.5 * 10.0 ** (-len(x.split('.')[1]))
    return 0.5


EPS = 1e-9


class Golden:
    def __init__(self):
        self.cases = []
        self.errata = []
        self.refusals = []

    def add(self, cid, fn, args, expect, source, published=None):
        c = {'id': cid, 'fn': fn, 'args': args, 'expect': expect, 'source': source,
             'basis': 'published' if published else 'oracle'}
        if published:
            c['published'] = published
        self.cases.append(c)

    def erratum(self, cid, fn, args, key, printed, tol, why, source):
        self.errata.append({'id': cid, 'fn': fn, 'args': args, 'key': key, 'printed': printed,
                            'tolerance': tol, 'why': why, 'source': source})

    def refuse(self, cid, fn, args, field):
        self.refusals.append({'id': cid, 'fn': fn, 'args': args, 'field': field})


def pub(key, value, tol):
    return {key: {'value': value, 'tolerance': tol + EPS}}


def noise_cases(g):
    ca = PRESETS['OSHA_ACTION_LEVEL']
    cp = PRESETS['OSHA_PEL']
    cn = PRESETS['NIOSH_REL']

    # Table G-16a is the hearing conservation table (80 to 130 dB), so it is
    # replayed under the action-level criterion, whose threshold is 80.
    for level, printed in TABLE_G16A:
        g.add(f'g16a-{level}', 'noiseReferenceDurationH', [level, 'OSHA_ACTION_LEVEL'],
              {'referenceDurationH': ref_duration_h(level, ca), 'belowThreshold': False},
              SRC_APPA + ', Table G-16a', pub('referenceDurationH', float(printed), dec(printed)))
    for level, (h, m, s) in NIOSH_TABLE_1_1.items():
        printed_h = h + m / 60.0 + s / 3600.0
        unit_h = (1.0 / 60.0) if level <= 94 else (1.0 / 3600.0)
        if level in NIOSH_1_1_ERRATA:
            g.erratum(f'niosh-t11-{level}', 'noiseReferenceDurationH', [level, 'NIOSH_REL'],
                      'referenceDurationH', printed_h, unit_h, NIOSH_1_1_ERRATA[level],
                      SRC_NIOSH_N + ', Table 1-1')
            continue
        # One printed unit: rows 124 and 127 are truncated where the rest round.
        g.add(f'niosh-t11-{level}', 'noiseReferenceDurationH', [level, 'NIOSH_REL'],
              {'referenceDurationH': ref_duration_h(level, cn), 'belowThreshold': False},
              SRC_NIOSH_N + ', Table 1-1', pub('referenceDurationH', printed_h, unit_h))
    g.add('ref-below-pel-threshold', 'noiseReferenceDurationH', [89.9, 'OSHA_PEL'],
          {'referenceDurationH': None, 'belowThreshold': True}, SRC_OTM + ' (PEL threshold 90 dBA)')
    g.add('ref-at-pel-threshold', 'noiseReferenceDurationH', [90, 'OSHA_PEL'],
          {'referenceDurationH': 8.0, 'belowThreshold': False}, SRC_APPA, pub('referenceDurationH', 8.0, 0))
    g.add('ref-below-hc-threshold', 'noiseReferenceDurationH', [79.99, 'OSHA_ACTION_LEVEL'],
          {'referenceDurationH': None, 'belowThreshold': True},
          '29 CFR 1910.95(d)(2)(i): levels from 80 to 130 dB are integrated')
    custom = {'criterionLevelDbA': 85, 'exchangeRateDb': 3, 'thresholdDbA': 80}
    g.add('ref-custom-85-3', 'noiseReferenceDurationH', [94, custom],
          {'referenceDurationH': ref_duration_h(94, crit(custom)), 'belowThreshold': False}, 'definition')

    for hours in (32, 16, 8, 4, 2, 1, 0.5, 0.25, 0.125):
        g.add(f'level-for-T-{hours}', 'noiseLevelForReferenceDurationDbA', [hours, 'OSHA_PEL'],
              {'levelDbA': 90 + 5 * math.log(8 / hours) / math.log(2)}, SRC_APPA + ', Table G-16a read backwards')
    g.add('level-for-T-niosh-15min', 'noiseLevelForReferenceDurationDbA', [0.25, 'NIOSH_REL'],
          {'levelDbA': 85 + 3 * math.log(8 / 0.25) / math.log(2)},
          SRC_NIOSH_N + ', Table 1-1 (100 dBA, 15 min)', pub('levelDbA', 100.0, 0.0))

    for d, printed in TABLE_A1:
        if d in A1_ERRATA:
            g.erratum(f'a1-{d}', 'noiseTwaFromDoseDbA', [d, 'OSHA_PEL'], 'twaDbA', float(printed),
                      dec(printed), A1_ERRATA[d], SRC_APPA + ', Table A-1')
            continue
        g.add(f'a1-{d}', 'noiseTwaFromDoseDbA', [d, 'OSHA_PEL'], {'twaDbA': twa_from_dose(d, cp)},
              SRC_APPA + ', Table A-1', pub('twaDbA', float(printed), dec(printed)))
    for d, printed in NIOSH_TABLE_1_2:
        if d in NIOSH_1_2_ERRATA:
            g.erratum(f'niosh-t12-{d}', 'noiseTwaFromDoseDbA', [d, 'NIOSH_REL'], 'twaDbA', float(printed),
                      dec(printed), NIOSH_1_2_ERRATA[d], SRC_NIOSH_N + ', Table 1-2')
            continue
        g.add(f'niosh-t12-{d}', 'noiseTwaFromDoseDbA', [d, 'NIOSH_REL'], {'twaDbA': twa_from_dose(d, cn)},
              SRC_NIOSH_N + ', Table 1-2', pub('twaDbA', float(printed), dec(printed)))
    g.add('appA-text-91pct', 'noiseTwaFromDoseDbA', [91, 'OSHA_PEL'], {'twaDbA': twa_from_dose(91, cp)},
          SRC_APPA + ', section II text ("91 percent ... 89.3 dB")', pub('twaDbA', 89.3, 0.05))
    g.add('otm-132pct', 'noiseTwaFromDoseDbA', [132, 'OSHA_PEL'], {'twaDbA': twa_from_dose(132, cp)},
          SRC_OTM + ' (a TWA of 92 dBA is a dose of 132 percent)', pub('twaDbA', 92.0, 0.5))
    g.add('otm-87dBA-66pct', 'noiseDoseFromTwaPct', [87, 'OSHA_ACTION_LEVEL'],
          {'dosePct': dose_from_twa(87, ca)}, SRC_OTM + ' (87 dBA TWA is a dose of 66 percent)',
          pub('dosePct', 66.0, 0.5))
    g.add('inverse-85-is-50pct', 'noiseDoseFromTwaPct', [85, 'OSHA_ACTION_LEVEL'],
          {'dosePct': dose_from_twa(85, ca)},
          '29 CFR 1910.95(c)(1): 85 dB "or, equivalently, a dose of fifty percent"', pub('dosePct', 50.0, 0.05))
    g.add('inverse-90-is-100pct', 'noiseDoseFromTwaPct', [90, 'OSHA_PEL'], {'dosePct': 100.0}, SRC_APPA,
          pub('dosePct', 100.0, 0))
    g.add('twa-custom-exact-coefficient', 'noiseTwaFromDoseDbA', [800, custom],
          {'twaDbA': twa_from_dose(800, crit(custom))}, 'definition, by bisection')
    g.add('dose-custom-exact-coefficient', 'noiseDoseFromTwaPct', [94, custom],
          {'dosePct': dose_from_twa(94, crit(custom))}, 'definition')

    def dose_case(cid, periods, cname, source, published=None):
        c = crit(cname)
        d = dose_pct(periods, c)
        exp = {'dosePct': d, 'twaDbA': twa_from_dose(d, c) if d > 0 else None,
               'totalDurationH': math.fsum(p['durationH'] for p in periods),
               'exceedsLimit': d > c['limit'], 'limitDosePct': c['limit']}
        for i, p in enumerate(periods):
            t = ref_duration_h(p['levelDbA'], c)
            exp[f'contributions.{i}.integrated'] = t is not None
            exp[f'contributions.{i}.dosePct'] = 0.0 if t is None else 100.0 * p['durationH'] / t
        g.add(cid, 'noiseDose', [periods, cname], exp, source, published)

    dose_case('dose-at-criterion', [{'levelDbA': 90, 'durationH': 8}], 'OSHA_PEL',
              SRC_APPA + ' I(2): a constant 8-hour level has a TWA equal to it',
              {'dosePct': {'value': 100.0, 'tolerance': EPS}, 'twaDbA': {'value': 90.0, 'tolerance': EPS}})
    dose_case('dose-mixed-pel', [{'levelDbA': 95, 'durationH': 2}, {'levelDbA': 90, 'durationH': 4},
                                 {'levelDbA': 100, 'durationH': 1}], 'OSHA_PEL',
              SRC_APPA + ' I(1)(ii) with Table G-16a T: 2/4 + 4/8 + 1/2 = 1.5', pub('dosePct', 150.0, 0))
    dose_case('dose-below-pel-threshold-ignored', [{'levelDbA': 88, 'durationH': 8}], 'OSHA_PEL',
              SRC_OTM + ': noise below 90 dBA is not integrated for the PEL', pub('dosePct', 0.0, 0))
    dose_case('dose-88-counted-for-hc', [{'levelDbA': 88, 'durationH': 8}], 'OSHA_ACTION_LEVEL',
              SRC_APPA + ', Table G-16a (88 dB, T = 10.6 h)', pub('dosePct', 100 * 8 / 10.6, 100 * 8 / 10.6 * 0.005))
    dose_case('dose-hc-mixed-thresholds', [{'levelDbA': 79, 'durationH': 2}, {'levelDbA': 85, 'durationH': 4},
                                           {'levelDbA': 92, 'durationH': 2}], 'OSHA_ACTION_LEVEL',
              'oracle; 79 dB is below the 80 dB threshold')
    dose_case('dose-same-shift-pel', [{'levelDbA': 79, 'durationH': 2}, {'levelDbA': 85, 'durationH': 4},
                                      {'levelDbA': 92, 'durationH': 2}], 'OSHA_PEL', 'oracle; only 92 dB counts')
    dose_case('dose-niosh-mixed', [{'levelDbA': 88, 'durationH': 4}, {'levelDbA': 91, 'durationH': 2},
                                   {'levelDbA': 70, 'durationH': 2}], 'NIOSH_REL',
              SRC_NIOSH_N + ' Table 1-1 (88 dBA 4 h, 91 dBA 2 h): 4/4 + 2/2 = 2', pub('dosePct', 200.0, 1e-9))
    dose_case('dose-10h-shift', [{'levelDbA': 90, 'durationH': 10}], 'OSHA_PEL',
              'oracle; the PEL is not reduced for a long shift, the dose grows')
    dose_case('dose-zero-duration', [{'levelDbA': 100, 'durationH': 0}, {'levelDbA': 90, 'durationH': 8}],
              'OSHA_PEL', 'oracle')

    g.add('otm-al-extended', 'oshaActionLevelForShiftDbA', [10],
          {'actionLevelDbA': 16.61 * math.log10(50 / (12.5 * 10)) + 90}, SRC_OTM + ', worked AL10',
          pub('actionLevelDbA', 83.4, 0.05))
    for hours, printed in ((8, '85'), (9, '84.2'), (10, '83.4'), (12, '82.1'), (16, '80')):
        # route: the TWA of a dose of 50 x 8/h percent
        g.add(f'otm-al-table-{hours}h', 'oshaActionLevelForShiftDbA', [hours],
              {'actionLevelDbA': twa_from_dose(50 * 8 / hours, cp)}, SRC_OTM + ', Table IV-3',
              pub('actionLevelDbA', float(printed), dec(printed) if '.' in printed else 0.05))


def protector_cases(g):
    def hp(cid, args, protected, atten, source, published=None, credited=None):
        exp = {'protectedDbA': protected, 'attenuationDb': atten}
        if credited is not None:
            exp['creditedNrrDb'] = credited
        g.add(cid, 'hearingProtectorEstimate', [args], exp, source, published)

    hp('otm-appE-field-50', {'exposureDb': 98, 'nrrDb': 25, 'method': 'OSHA_FIELD_50'},
       98 - (25 - 7) * 0.5, (25 - 7) * 0.5, SRC_OTM + ', Appendix E', pub('protectedDbA', 89.0, 0))
    hp('otm-appE-hc', {'exposureDb': 98, 'nrrDb': 25, 'method': 'OSHA_APPENDIX_B'},
       98 - (25 - 7), 18, SRC_OTM + ', Appendix E; ' + SRC_APPB, pub('protectedDbA', 80.0, 0))
    hp('appB-c-weighted', {'exposureDb': 100, 'weighting': 'C', 'nrrDb': 29, 'method': 'OSHA_APPENDIX_B'},
       71, 29, SRC_APPB + ' (i)(B)')
    hp('otm-dual-a', {'exposureDb': 105, 'nrrDb': 33, 'method': 'OSHA_DUAL'}, 105 - (33 - 7 + 5), 31,
       SRC_OTM + ', Appendix E dual protection')
    hp('otm-dual-c', {'exposureDb': 108, 'weighting': 'C', 'nrrDb': 30, 'method': 'OSHA_DUAL'}, 108 - 35, 35,
       SRC_OTM + ', Appendix E dual protection (no 7 dB on C-weighted data)')
    for ptype, f in (('earmuff', F(3, 4)), ('formableEarplug', F(1, 2)), ('otherEarplug', F(3, 10))):
        cred = float(f * 30)
        hp(f'niosh-{ptype}-a', {'exposureDb': 100, 'nrrDb': 30, 'method': 'NIOSH_TYPE', 'protectorType': ptype},
           100 - max(0.0, cred - 7), max(0.0, cred - 7), SRC_NIOSH_N + ', Appendix', credited=cred)
        hp(f'niosh-{ptype}-c', {'exposureDb': 100, 'weighting': 'C', 'nrrDb': 30, 'method': 'NIOSH_TYPE',
                                'protectorType': ptype}, 100 - cred, cred, SRC_NIOSH_N + ', Appendix',
           credited=cred)
    hp('nrr-below-7-floors-at-zero', {'exposureDb': 92, 'nrrDb': 5, 'method': 'OSHA_APPENDIX_B'}, 92, 0,
       'judgement: a protector cannot raise the exposure')
    hp('niosh-plug-small-nrr-floors', {'exposureDb': 92, 'nrrDb': 20, 'method': 'NIOSH_TYPE',
                                        'protectorType': 'otherEarplug'}, 92, 0,
       'judgement: 0.3 x 20 - 7 = -1 dB floors at zero', credited=6.0)


def lex_cases(g):
    fig26 = [{'laeqDbA': 80, 'durationH': 5}, {'laeqDbA': 86, 'durationH': 2}, {'laeqDbA': 95, 'durationH': 0.75}]
    exp = {'lexDbA': lex(fig26), 'totalDurationH': 7.75,
           'exposurePoints': math.fsum(points(p['laeqDbA'], p['durationH']) for p in fig26),
           'exceedsLowerAction': True, 'exceedsUpperAction': True}
    published = {'lexDbA': {'value': 87, 'tolerance': 0.5}, 'exposurePoints': {'value': 145, 'tolerance': 0.5}}
    for i, p in enumerate(fig26):
        exp[f'contributions.{i}.lexDbA'] = task_lex(p)
        exp[f'contributions.{i}.exposurePoints'] = points(p['laeqDbA'], p['durationH'])
    for i, (db, pts) in enumerate(((78, 20), (80, 31), (85, 94))):
        published[f'contributions.{i}.lexDbA'] = {'value': db, 'tolerance': 0.5}
        published[f'contributions.{i}.exposurePoints'] = {'value': pts, 'tolerance': 0.5}
    g.add('l108-figure-26', 'lexEightHourDbA', [fig26], exp, SRC_L108, published)
    g.add('lex-85-8h', 'lexEightHourDbA', [[{'laeqDbA': 85, 'durationH': 8}]],
          {'lexDbA': lex([{'laeqDbA': 85, 'durationH': 8}]), 'exposurePoints': 100.0},
          SRC_L108 + ' App. 3 para 5 (upper EAV is 100 points)',
          {'lexDbA': {'value': 85.0, 'tolerance': EPS}, 'exposurePoints': {'value': 100.0, 'tolerance': EPS}})
    g.add('lex-80-is-32-points', 'lexEightHourDbA', [[{'laeqDbA': 80, 'durationH': 8}]],
          {'lexDbA': lex([{'laeqDbA': 80, 'durationH': 8}]), 'exposurePoints': points(80, 8),
           'exceedsLowerAction': True, 'exceedsUpperAction': False},
          SRC_L108 + ' App. 3 para 5 (lower EAV is 32 points)', pub('exposurePoints', 32.0, 0.5))
    g.add('lex-short-shift-4h-at-88', 'lexEightHourDbA', [[{'laeqDbA': 88, 'durationH': 4}]],
          {'lexDbA': lex([{'laeqDbA': 88, 'durationH': 4}])}, 'oracle (88 - 10 log10 2)')
    g.add('lex-10h-at-85', 'lexEightHourDbA', [[{'laeqDbA': 85, 'durationH': 10}]],
          {'lexDbA': lex([{'laeqDbA': 85, 'durationH': 10}])}, 'oracle (normalised to 8 h, rises above 85)')
    g.add('lex-zero-task', 'lexEightHourDbA', [[{'laeqDbA': 100, 'durationH': 0}, {'laeqDbA': 85, 'durationH': 8}]],
          {'lexDbA': 85.0, 'contributions.0.lexDbA': None}, 'oracle; a zero-length task contributes nothing')
    for db, per_hour in ((80, 4), (86, 16), (95, 125)):
        g.add(f'l108-points-per-hour-{db}', 'hseExposurePoints', [{'laeqDbA': db, 'durationH': 1}],
              {'exposurePoints': points(db, 1)}, SRC_L108 + ' Figure 26, points per hour',
              pub('exposurePoints', float(per_hour), 0.5))
    for db, target, printed_h in ((86, 85, 6 + 21 / 60), (95, 85, 0.8), (86, 80, 2.0), (95, 80, 0.25)):
        g.add(f'l108-time-to-{target}-at-{db}', 'lexAllowedDurationH', [{'laeqDbA': db, 'targetLexDbA': target}],
              {'durationH': 8.0 * 10.0 ** ((target - db) / 10.0)},
              SRC_L108 + ' Figure 26, time to LEAV/UEAV (hh:mm)',
              # one displayed minute: the sheet shows 6:21 for 6 h 20.97 min
              # (rounded) and 2:00 for 2 h 0.57 min, so its display rule is
              # not recoverable from the figure
              pub('durationH', printed_h, 1.0 / 60))
    g.add('l108-lex-from-145-points', 'lexFromExposurePointsDbA', [145],
          {'lexDbA': 85 + 10 * math.log10(1.45)}, SRC_L108 + ' App. 3 para 4 and Figure 26',
          pub('lexDbA', 87.0, 0.5))
    week = [88, 88, 82, 82, 82]
    g.add('lex-weekly', 'lexWeeklyDbA', [week],
          {'lexWeeklyDbA': 10 * math.log10(math.fsum(10 ** (0.1 * x) for x in week) / 5), 'days': 5},
          SRC_L108 + ' Schedule 1 Part 2')
    g.add('lex-weekly-equal-days', 'lexWeeklyDbA', [[85, 85, 85, 85, 85]], {'lexWeeklyDbA': 85.0},
          SRC_L108 + ' Schedule 1 Part 2', pub('lexWeeklyDbA', 85.0, EPS))
    g.add('lex-weekly-four-days', 'lexWeeklyDbA', [[90, 90, 90, 90]],
          {'lexWeeklyDbA': 90 + 10 * math.log10(4 / 5), 'days': 4},
          SRC_L108 + ' Schedule 1 Part 2 (the divisor stays 5)')


def chemical_cases(g):
    d1 = [{'concentration': 150, 'durationH': 2}, {'concentration': 75, 'durationH': 2},
          {'concentration': 50, 'durationH': 4}]
    v = sum(F(p['concentration']) * F(p['durationH']) for p in d1) / 8
    g.add('cfr-1000-d1-example', 'chemicalTwa8h', [d1], {'twa8h': float(v), 'totalDurationH': 8.0},
          SRC_1000 + '(1)(ii)', pub('twa8h', 81.25, 0))
    part = [{'concentration': 40, 'durationH': 3}, {'concentration': 10, 'durationH': 2.5}]
    g.add('twa-part-shift-zero-fill', 'chemicalTwa8h', [part],
          {'twa8h': float((F(40) * 3 + F(10) * F(5, 2)) / 8), 'totalDurationH': 5.5},
          'oracle; unsampled time counts as zero')
    d2 = [{'concentration': 500, 'limit': 1000}, {'concentration': 45, 'limit': 200},
          {'concentration': 40, 'limit': 200}]
    em = [F(c['concentration'], c['limit']) for c in d2]
    exp = {'index': float(sum(em)), 'exceeds': False}
    for i, t in enumerate(em):
        exp[f'terms.{i}'] = float(t)
    g.add('cfr-1000-d2-example', 'mixtureExposureIndex', [d2], exp, SRC_1000 + '(2)(ii)',
          {'index': {'value': 0.925, 'tolerance': EPS}, 'terms.0': {'value': 0.5, 'tolerance': EPS},
           'terms.1': {'value': 0.225, 'tolerance': EPS}, 'terms.2': {'value': 0.2, 'tolerance': EPS}})
    g.add('mixture-over-unity', 'mixtureExposureIndex',
          [[{'concentration': 60, 'limit': 100}, {'concentration': 25, 'limit': 50}]],
          {'index': float(F(60, 100) + F(25, 50)), 'exceeds': True}, 'oracle')
    g.add('mixture-exactly-unity', 'mixtureExposureIndex',
          [[{'concentration': 50, 'limit': 100}, {'concentration': 25, 'limit': 50}]],
          {'index': 1.0, 'exceeds': False}, SRC_1000 + '(2)(i): "shall not exceed unity"')
    stel = [{'concentration': 300, 'durationMin': 5}, {'concentration': 120, 'durationMin': 10}]
    g.add('stel-15', 'chemicalStel15Min', [stel],
          {'stel15Min': float((F(300) * 5 + F(120) * 10) / 15), 'totalDurationMin': 15.0}, 'oracle')
    g.add('stel-short-sample', 'chemicalStel15Min', [[{'concentration': 90, 'durationMin': 10}]],
          {'stel15Min': 60.0, 'totalDurationMin': 10.0}, 'oracle; the remainder counts as zero')

    for h, printed in ((10, 0.7), (12, 0.5), (16, 0.25), (20, 0.1)):
        rf = F(8, 1) / h * (24 - h) / 16
        g.add(f'bs-daily-{h}h', 'briefScalaDailyRf', [h], {'rf': float(min(1, rf)), 'rawRf': float(rf)},
              SRC_BS + f' (BC 5.50 factor {printed})', pub('rf', printed, EPS))
    for h in (8, 6, 24):
        rf = F(8, 1) / h * (24 - h) / 16
        g.add(f'bs-daily-{h}h', 'briefScalaDailyRf', [h], {'rf': float(min(1, rf)), 'rawRf': float(rf)},
              'oracle; the factor never raises a limit')
    for h in (40, 48, 60, 30):
        rf = F(40, 1) / h * (168 - h) / 128
        g.add(f'bs-weekly-{h}h', 'briefScalaWeeklyRf', [h], {'rf': float(min(1, rf)), 'rawRf': float(rf)},
              SRC_BS + ' weekly form')
    g.add('esta-glycol-12h', 'briefScalaAdjustedLimit', [{'limit': 10, 'shiftHours': 12, 'weeklyHours': 60}],
          {'adjustedLimit': 5.0, 'rf': 0.5, 'governingBasis': 'daily'},
          SRC_BS + ' (ESTA: 12 h a day for 5 days, 10 mg/m3 becomes 5 mg/m3)', pub('adjustedLimit', 5.0, EPS))
    rf_w = F(40, 1) / 70 * (168 - 70) / 128
    rf = min(F(7, 10), rf_w)
    g.add('bs-weekly-governs', 'briefScalaAdjustedLimit', [{'limit': 100, 'shiftHours': 10, 'weeklyHours': 70}],
          {'adjustedLimit': float(100 * rf), 'rf': float(rf),
           'governingBasis': 'weekly' if rf_w < F(7, 10) else 'daily'}, 'oracle; the smaller factor governs')


def rel_c(m):
    """NIOSH 2016-106 section 8.1, acclimatized: 56.7 - 11.5 log10 M[W]."""
    return 56.7 - 11.5 * math.log10(m)


def ral_c(m):
    """NIOSH 2016-106 section 8.1, unacclimatized: 59.9 - 14.1 log10 M[W]."""
    return 59.9 - 14.1 * math.log10(m)


def heat_cases(g):
    def wb(tnwb, tg, ta=None):
        if ta is None:
            return float(F('0.7') * F(str(tnwb)) + F('0.3') * F(str(tg)))
        return float(F('0.7') * F(str(tnwb)) + F('0.2') * F(str(tg)) + F('0.1') * F(str(ta)))

    g.add('wbgt-outdoor', 'wbgtOutdoorC', [{'naturalWetBulbC': 25, 'globeC': 45, 'dryBulbC': 32}],
          {'wbgtC': wb(25, 45, 32), 'form': 'outdoor'}, SRC_HEAT + ' 9.3.2 (oracle arithmetic)')
    g.add('wbgt-indoor', 'wbgtIndoorC', [{'naturalWetBulbC': 24.6, 'globeC': 38.2}],
          {'wbgtC': wb(24.6, 38.2), 'form': 'indoor'}, SRC_HEAT + ' 9.3.2 (oracle arithmetic)')
    g.add('wbgt-indoor-equal-temps', 'wbgtIndoorC', [{'naturalWetBulbC': 30, 'globeC': 30}], {'wbgtC': 30.0},
          'the weights sum to 1')
    g.add('wbgt-outdoor-equal-temps', 'wbgtOutdoorC', [{'naturalWetBulbC': 30, 'globeC': 30, 'dryBulbC': 30}],
          {'wbgtC': 30.0}, 'the weights sum to 1')
    wp = [{'wbgtC': 31, 'durationMin': 45}, {'wbgtC': 24, 'durationMin': 15}]
    twa_w = float((F(31) * 45 + F(24) * 15) / 60)
    g.add('wbgt-twa-work-rest', 'wbgtTwaC', [wp], {'wbgtTwaC': twa_w, 'totalDurationMin': 60.0},
          SRC_HEAT + ' 1.1.1 hourly TWA')
    mp = [{'metabolicRateW': 400, 'durationMin': 45}, {'metabolicRateW': 120, 'durationMin': 15}]
    g.add('metabolic-twa', 'metabolicRateTwaW', [mp], {'metabolicRateTwaW': 330.0, 'totalDurationMin': 60.0},
          SRC_HEAT + ' 1.1.3 1-hour TWA')
    for m in (117, 200, 300, 348.9, 400, 465, 580):
        g.add(f'rel-{m}W', 'nioshRecommendedExposureLimitC', [m], {'limitWbgtC': rel_c(m)},
              SRC_HEAT + ' 8.1 equation (oracle arithmetic)')
        g.add(f'ral-{m}W', 'nioshRecommendedAlertLimitC', [m], {'limitWbgtC': ral_c(m)},
              SRC_HEAT + ' 8.1 equation (oracle arithmetic)')
    for kind, acc, limit_fn in (('rel', True, rel_c), ('ral', False, ral_c)):
        lim = limit_fn(330)
        g.add(f'heat-assessment-{kind}', 'nioshHeatAssessment',
              [{'wbgtPeriods': wp, 'metabolicPeriods': mp, 'acclimatized': acc}],
              {'wbgtTwaC': twa_w, 'metabolicRateTwaW': 330.0, 'limitWbgtC': lim, 'marginC': lim - twa_w,
               'exceeds': twa_w > lim, 'criterion': 'NIOSH_REL' if acc else 'NIOSH_RAL'},
              SRC_HEAT + ' (oracle arithmetic)')
    # The one worked example reads the FIGURE, and the equation disagrees.
    g.erratum('niosh-heat-example-rel', 'nioshRecommendedExposureLimitC', [348.9], 'limitWbgtC', 27.8, 0.05,
              'section 1.1.3 example reads 27.8 C off Figure 8-2 at 300 kcal/h (348.9 W); the section 8.1 '
              'equation gives %.3f' % rel_c(348.9), SRC_HEAT + ' 1.1.3')
    g.erratum('niosh-heat-example-ral', 'nioshRecommendedAlertLimitC', [348.9], 'limitWbgtC', 25.0, 0.5,
              'section 1.1.3 example reads 25 C off Figure 8-1 at 348.9 W; the section 8.1 equation gives %.3f'
              % ral_c(348.9), SRC_HEAT + ' 1.1.3')
    return wp, mp


def refusal_cases(g, wp, mp):
    R = g.refuse
    R('ref-level-nan', 'noiseReferenceDurationH', ['loud', 'OSHA_PEL'], 'levelDbA')
    R('ref-bad-preset', 'noiseReferenceDurationH', [90, 'ACGIH'], 'criterion')
    R('ref-exchange-zero', 'noiseReferenceDurationH',
      [90, {'criterionLevelDbA': 90, 'exchangeRateDb': 0, 'thresholdDbA': 80}], 'exchangeRateDb')
    R('ref-criterion-missing', 'noiseReferenceDurationH', [90, {'exchangeRateDb': 5}], 'criterionLevelDbA')
    R('ref-coefficient-negative', 'noiseTwaFromDoseDbA',
      [100, {'criterionLevelDbA': 90, 'exchangeRateDb': 5, 'twaCoefficientDb': -16.61}], 'twaCoefficientDb')
    R('ref-limit-zero', 'noiseTwaFromDoseDbA',
      [100, {'criterionLevelDbA': 90, 'exchangeRateDb': 5, 'limitDosePct': 0}], 'limitDosePct')
    R('level-for-T-zero', 'noiseLevelForReferenceDurationDbA', [0, 'OSHA_PEL'], 'referenceDurationH')
    R('twa-dose-zero', 'noiseTwaFromDoseDbA', [0, 'OSHA_PEL'], 'dosePct')
    R('twa-dose-negative', 'noiseTwaFromDoseDbA', [-5, 'OSHA_PEL'], 'dosePct')
    R('dose-from-twa-null', 'noiseDoseFromTwaPct', [None, 'OSHA_PEL'], 'twaDbA')
    R('dose-empty', 'noiseDose', [[], 'OSHA_PEL'], 'periods')
    R('dose-negative-duration', 'noiseDose', [[{'levelDbA': 90, 'durationH': -1}], 'OSHA_PEL'],
      'periods[0].durationH')
    R('dose-missing-level', 'noiseDose', [[{'levelDbA': 90, 'durationH': 4}, {'durationH': 4}], 'OSHA_PEL'],
      'periods[1].levelDbA')
    R('dose-over-24h', 'noiseDose',
      [[{'levelDbA': 90, 'durationH': 20}, {'levelDbA': 85, 'durationH': 5}], 'OSHA_PEL'], 'periods')
    R('al-shift-zero', 'oshaActionLevelForShiftDbA', [0], 'shiftHours')
    R('hp-no-nrr', 'hearingProtectorEstimate', [{'exposureDb': 95}], 'nrrDb')
    R('hp-negative-nrr', 'hearingProtectorEstimate', [{'exposureDb': 95, 'nrrDb': -3}], 'nrrDb')
    R('hp-bad-weighting', 'hearingProtectorEstimate', [{'exposureDb': 95, 'nrrDb': 25, 'weighting': 'Z'}],
      'weighting')
    R('hp-bad-method', 'hearingProtectorEstimate', [{'exposureDb': 95, 'nrrDb': 25, 'method': 'HALF'}], 'method')
    R('hp-field50-c', 'hearingProtectorEstimate',
      [{'exposureDb': 95, 'nrrDb': 25, 'weighting': 'C', 'method': 'OSHA_FIELD_50'}], 'weighting')
    R('hp-niosh-no-type', 'hearingProtectorEstimate',
      [{'exposureDb': 95, 'nrrDb': 25, 'method': 'NIOSH_TYPE'}], 'protectorType')
    R('hp-no-exposure', 'hearingProtectorEstimate', [{'nrrDb': 25}], 'exposureDb')
    R('lex-empty', 'lexEightHourDbA', [[]], 'periods')
    R('lex-zero-time', 'lexEightHourDbA', [[{'laeqDbA': 90, 'durationH': 0}]], 'periods')
    R('lex-bad-level', 'lexEightHourDbA', [[{'laeqDbA': 'x', 'durationH': 1}]], 'periods[0].laeqDbA')
    R('lex-over-24h', 'lexEightHourDbA', [[{'laeqDbA': 80, 'durationH': 25}]], 'periods')
    R('lexw-eight-days', 'lexWeeklyDbA', [[80] * 8], 'dailyLexDbA')
    R('lexw-bad-day', 'lexWeeklyDbA', [[80, None]], 'dailyLexDbA[1]')
    R('lexw-empty', 'lexWeeklyDbA', [[]], 'dailyLexDbA')
    R('points-negative-time', 'hseExposurePoints', [{'laeqDbA': 85, 'durationH': -1}], 'durationH')
    R('points-no-level', 'hseExposurePoints', [{'durationH': 1}], 'laeqDbA')
    R('lex-from-points-zero', 'lexFromExposurePointsDbA', [0], 'exposurePoints')
    R('allowed-no-target', 'lexAllowedDurationH', [{'laeqDbA': 90}], 'targetLexDbA')
    R('allowed-no-level', 'lexAllowedDurationH', [{'targetLexDbA': 85}], 'laeqDbA')
    R('twa8-negative-conc', 'chemicalTwa8h', [[{'concentration': -1, 'durationH': 8}]],
      'periods[0].concentration')
    R('twa8-over-24', 'chemicalTwa8h', [[{'concentration': 1, 'durationH': 25}]], 'periods')
    R('stel-over-15', 'chemicalStel15Min', [[{'concentration': 1, 'durationMin': 16}]], 'periods')
    R('stel-no-duration', 'chemicalStel15Min', [[{'concentration': 1}]], 'periods[0].durationMin')
    R('mix-zero-limit', 'mixtureExposureIndex', [[{'concentration': 1, 'limit': 0}]], 'components[0].limit')
    R('mix-negative-conc', 'mixtureExposureIndex',
      [[{'concentration': 1, 'limit': 5}, {'concentration': -2, 'limit': 5}]], 'components[1].concentration')
    R('mix-empty', 'mixtureExposureIndex', [[]], 'components')
    R('bs-daily-zero', 'briefScalaDailyRf', [0], 'shiftHours')
    R('bs-daily-25', 'briefScalaDailyRf', [25], 'shiftHours')
    R('bs-weekly-200', 'briefScalaWeeklyRf', [200], 'weeklyHours')
    R('bs-adjust-no-schedule', 'briefScalaAdjustedLimit', [{'limit': 10}], 'shiftHours')
    R('bs-adjust-no-limit', 'briefScalaAdjustedLimit', [{'shiftHours': 10}], 'limit')
    R('bs-adjust-bad-week', 'briefScalaAdjustedLimit', [{'limit': 10, 'weeklyHours': -4}], 'weeklyHours')
    R('wbgt-missing-globe', 'wbgtOutdoorC', [{'naturalWetBulbC': 25, 'dryBulbC': 30}], 'globeC')
    R('wbgt-below-absolute-zero', 'wbgtIndoorC', [{'naturalWetBulbC': -300, 'globeC': 20}], 'naturalWetBulbC')
    R('wbgt-twa-zero-time', 'wbgtTwaC', [[{'wbgtC': 30, 'durationMin': 0}]], 'periods')
    R('metabolic-zero', 'metabolicRateTwaW', [[{'metabolicRateW': 0, 'durationMin': 60}]],
      'periods[0].metabolicRateW')
    R('rel-zero-watts', 'nioshRecommendedExposureLimitC', [0], 'metabolicRateW')
    R('ral-negative-watts', 'nioshRecommendedAlertLimitC', [-10], 'metabolicRateW')
    R('heat-no-acclimatization', 'nioshHeatAssessment', [{'wbgtPeriods': wp, 'metabolicPeriods': mp}],
      'acclimatized')
    R('heat-not-an-hour', 'nioshHeatAssessment',
      [{'wbgtPeriods': [{'wbgtC': 30, 'durationMin': 50}], 'metabolicPeriods': mp, 'acclimatized': True}],
      'wbgtPeriods')
    R('heat-metabolic-not-an-hour', 'nioshHeatAssessment',
      [{'wbgtPeriods': wp, 'metabolicPeriods': [{'metabolicRateW': 300, 'durationMin': 30}],
        'acclimatized': True}], 'metabolicPeriods')
    R('heat-bad-wbgt-row', 'nioshHeatAssessment',
      [{'wbgtPeriods': [{'durationMin': 60}], 'metabolicPeriods': mp, 'acclimatized': True}],
      'wbgtPeriods[0].wbgtC')


def build():
    g = Golden()
    noise_cases(g)
    protector_cases(g)
    lex_cases(g)
    chemical_cases(g)
    wp, mp = heat_cases(g)
    refusal_cases(g, wp, mp)
    return g


def main():
    g = build()
    out = {
        'module': 'exposure',
        'generatedBy': 'tools/validation/hse/oracle_exposure.py',
        'description': 'Occupational hygiene exposure (noise dose and TWA, LEX,8h, hearing protectors, '
                       'chemical TWA, STEL, mixture and Brief and Scala, WBGT and NIOSH heat limits). '
                       'expect = oracle value, agreement to oracleTolerance; published = printed value '
                       'and the tolerance its printed precision allows.',
        'oracleTolerance': 1e-9,
        'cases': g.cases,
        'errata': g.errata,
        'refusals': g.refusals,
    }
    os.makedirs(os.path.dirname(DEST), exist_ok=True)
    with open(DEST, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('wrote', os.path.relpath(DEST, ROOT), len(g.cases), 'cases,', len(g.errata), 'errata,',
          len(g.refusals), 'refusals')


if __name__ == '__main__':
    main()
