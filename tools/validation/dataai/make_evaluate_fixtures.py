#!/usr/bin/env python3
"""Builds the synthetic Ekene document fixtures for engines/dataai/evaluate.js (Data & AI D5).

STDLIB ONLY:

    python3 tools/validation/dataai/make_evaluate_fixtures.py

Writes test-data/dataai/ekene-docs/{corpus,queries,extraction,systems,calibration}.json.
Everything is SYNTHETIC: the Ekene field is Petrolord's teaching field (block
EK-11, fictional acreage); no real company, person or incident appears. The
passage text is hand-written here; every figure that overlaps the existing
Ekene data is READ from test-data/ekene-dynamic/*.json (rates, pressures,
PVT, SCAL, the flood) and printed at the stated rounding, so the corpus
agrees with the other Ekene teaching packages. The judgments, the second
annotator's grades, the extraction labels and both systems' answers are
hand-written fixture text (no language model is run, now or at runtime).
The systems' retrieved lists are the top 5 of BM25 (system A) and TF-IDF
(system B) as the stdlib oracle ranks them; the jest gate checks they equal
the engine's. The calibration probabilities and the second annotator's
disagreements are drawn from Python's `random` with fixed seeds.

Re-running it reproduces the committed files byte for byte (the gate
re-runs nothing; the files are the fixture of record).
"""
import json
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import oracle_evaluate as O  # noqa: E402

ROOT = os.path.join(HERE, '..', '..', '..')
EK = os.path.join(ROOT, 'test-data', 'ekene-dynamic')
OUT = os.path.join(ROOT, 'test-data', 'dataai', 'ekene-docs')

rates = json.load(open(os.path.join(EK, 'rates.json')))
mbal = json.load(open(os.path.join(EK, 'mbal.json')))
flood = json.load(open(os.path.join(EK, 'waterflood.json')))
field = json.load(open(os.path.join(EK, 'field.json')))
scal = json.load(open(os.path.join(EK, 'scal.json')))

MONTHLY = {w['name']: {r['date'][:7]: r['oil_bpd'] for r in w['monthly']} for w in rates['wells']}
SURV = {(r['date'][:7], r['well']): r for r in flood['surveillance_rows']}
WELLS = {w['name']: w for w in field['wells']}
PLANT = {w['name']: w for w in rates['wells']}


def r1(x):
    return f'{round(x + 0.0, 1):.1f}'


def r0(x):
    return f'{int(round(x)):,}'


def oil(well, ym):
    return r1(MONTHLY[well][ym])


def wc(well, ym):
    r = SURV[(ym, well)]
    return r1(100 * r['water_bbl'] / (r['oil_bbl'] + r['water_bbl']))


def water(well, ym):
    return r1(SURV[(ym, well)]['water_bbl'])


def inj(well, ym):
    return r1(SURV[(ym, well)]['inj_bbl'])


def whp(well, ym):
    return r0(SURV[(ym, well)]['whp_psi'])


PD = {r['observation_date']: r for r in mbal['inputs']['production_data']}
PVT = {r['pressure_psia']: r for r in mbal['inputs']['pvt_lab_table']}
DES = mbal['design']
ST = field['static']
FS = {s['date']: s['p_psia'] for s in flood['pressure']['surveys']}
KR = scal['design']['krSpec']
CAP = scal['capillary']['design']
PLUG = CAP['plugs'][0]


def p_at(date):
    return r0(PD[date]['pressure_psia'])


def np_at(date):
    return r0(PD[date]['cum_oil_stb'])


def top(w):
    return WELLS[w]['top_sand_m']


def base(w):
    return WELLS[w]['base_sand_m']


def first_oil(w):
    p = PLANT[w]
    return p['start_date'], r0(p['planted']['qi_bpd'])


def eur(w):
    return r0(PLANT[w]['closed_form']['eur_at_econ_limit_stb'])


E1, E2, E3, E4, E5, E6 = (f'Ekene-{i}' for i in range(1, 7))
OWC = ST['owc_m_tvd']

P = []


def doc(pid, kind, well, date, title, text):
    assert '—' not in text and '–' not in text, pid
    P.append({'id': pid, 'type': kind, 'well': well, 'date': date, 'title': title, 'text': ' '.join(text.split())})


# ---------------------------------------------------------------- well reports
for pid, w in (('EKD-001', E1), ('EKD-003', E3), ('EKD-005', E5), ('EKD-006', E6)):
    d, q = first_oil(w)
    doc(pid, 'well_report', w, d, f'{w} end of well summary', f"""
    {w} end of well summary. Top of the Ekene Sand at {top(w)} m TVD and base at {base(w)} m TVD,
    {base(w) - top(w)} m of gross sand, with the top above the {OWC} m TVD oil-water contact.
    The well was completed as an oil producer and came on stream on {d} at {q} bopd.""")
for pid, w in (('EKD-002', E2), ('EKD-004', E4)):
    doc(pid, 'well_report', w, '2023-01-01', f'{w} end of well summary', f"""
    {w} end of well summary. Top of the Ekene Sand at {top(w)} m TVD and base at {base(w)} m TVD.
    The sand was found below the {OWC} m TVD oil-water contact and is water bearing, so the well was
    suspended. It was converted to a water injector for the waterflood that started on 2023-01-01.""")
P.sort(key=lambda p: p['id'])

# ---------------------------------------------------------------- geology
doc('EKD-007', 'geology_note', None, None, 'Ekene Sand structure', f"""
The Ekene Sand is a drape anticline over a deeper growth structure. The mapped oil-water contact is
{OWC} m TVD and the maximum oil column is {r1(ST['max_oil_column_m'])} m. The Ekene Growth Fault dies out
just below the sand base, so the base-case tank is unfaulted and the sealing-fault case is a what-if only.""")
doc('EKD-008', 'geology_note', None, None, 'Ekene volumetrics', f"""
Volumetric STOIIP for the Ekene Sand is {r0(ST['stoiip_stb'])} stb, from net to gross {ST['ntg']},
porosity {ST['phi']}, initial water saturation {ST['swi']} and Boi {ST['boi_rb_stb']} rb/stb over
{ST['oil_cells']} oil cells of {ST['cell_size_m']} m. Material balance on the primary history returns the same
{r0(mbal['expected']['estimated_ooip_stb'])} stb.""")
doc('EKD-009', 'geology_note', E1, None, 'Stratigraphy at Ekene-1', """
Stratigraphic tops at Ekene-1 in m MD below KB: Benin Formation 350, Agbada Formation 1150, Ogbia Shale 1290,
Ekene Sand 1548, Oboro Unconformity 1790, Oboro Sand 1845 and Akata Formation 2080. The Oboro Sand is the
deeper gas target, with a gas-water contact at 1935 m MD at Ekene-1.""")

# ---------------------------------------------------------------- PVT
p0 = PVT[3200]
doc('EKD-010', 'pvt_report', None, None, 'Ekene PVT summary', f"""
Ekene reservoir fluid summary. Stock tank oil gravity {DES['api']} API, reservoir temperature {DES['temp_f']} F,
bubble point {DES['pb_psia']} psia and solution gas oil ratio {DES['rsi_scf_stb']} scf/stb. Boi is
{p0['bo_rb_stb']} rb/stb at the initial pressure of {DES['pi_psia']} psia, where the oil viscosity is
{p0['oil_viscosity_cp']} cp.""")
bo = {p: PVT[p]['bo_rb_stb'] for p in (3400, 3200, 2900, 2600, 2000)}
doc('EKD-011', 'pvt_report', None, None, 'Ekene differential liberation table', f"""
Laboratory oil formation volume factor: {round(bo[3400], 5)} rb/stb at 3400 psia, {bo[3200]} at 3200 psia,
{round(bo[2900], 5)} at 2900 psia, {round(bo[2600], 5)} at 2600 psia and {round(bo[2000], 5)} at 2000 psia,
the bubble point. The solution gas oil ratio stays at {DES['rsi_scf_stb']} scf/stb above the bubble point.""")
doc('EKD-012', 'pvt_report', None, None, 'Compressibility and water properties', f"""
Compressibilities used for material balance: oil 0.000012 per psi, formation 0.000004 per psi and
water 0.000003 per psi. Formation water salinity is {r0(DES['salinity_ppm'])} ppm and Bw is
{DES['bw_rb_stb']} rb/stb. Associated gas gravity is {DES['gas_sg']}.""")

# ---------------------------------------------------------------- pressure surveys
for pid, d in (('EKD-013', '2020-07-01'), ('EKD-014', '2021-01-01'), ('EKD-015', '2021-07-01'),
               ('EKD-016', '2022-01-01'), ('EKD-017', '2022-07-01')):
    doc(pid, 'pressure_survey', None, d, f'Static pressure survey {d}', f"""
    Static pressure survey on {d}: average reservoir pressure {p_at(d)} psia at the {OWC} m TVD datum,
    down from {DES['pi_psia']} psia initial. Cumulative field oil at the survey was {np_at(d)} stb.""")
doc('EKD-018', 'pressure_survey', None, '2023-01-01', 'Static pressure survey 2023-01-01', f"""
Static pressure survey on 2023-01-01: average reservoir pressure {p_at('2023-01-01')} psia at the datum,
close to the {DES['pb_psia']} psia bubble point, with cumulative field oil of {np_at('2023-01-01')} stb.
The waterflood started the same day to hold pressure above the bubble point.""")
doc('EKD-019', 'pressure_survey', None, '2025-08-01', 'Flood pressure surveys', f"""
Pressure surveys under the flood: {r0(FS['2024-02-01'])} psia on 2024-02-01 and {r0(FS['2025-08-01'])} psia on
2025-08-01. Pressure is recovering slowly with the voidage replacement ratio held at
{flood['expected']['latest_instantaneous_vrr']}.""")

# ---------------------------------------------------------------- production notes
doc('EKD-020', 'production_note', E1, '2020-04-01', 'Ekene-1 production note 2020-04-01', f"""
Morning report 2020-04-01. Ekene-1 flowing at {oil(E1, '2020-04')} bopd with no water. Producing GOR
steady at {DES['rsi_scf_stb']} scf/stb, as expected above the bubble point.""")
doc('EKD-021', 'production_note', None, '2021-01-01', 'Field production 2021-01-01', f"""
Field morning report 2021-01-01. Ekene-1 {oil(E1, '2021-01')} bopd, Ekene-3 {oil(E3, '2021-01')} bopd,
Ekene-5 {oil(E5, '2021-01')} bopd and Ekene-6 {oil(E6, '2021-01')} bopd. All four producers are water free
and declining as expected under primary depletion.""")
doc('EKD-022', 'production_note', E6, '2022-10-01', 'Ekene-6 production note 2022-10-01', f"""
Ekene-6 production 2022-10-01: {oil(E6, '2022-10')} bopd, water free. Decline continues on trend.
The well will be watched for response once injection starts at Ekene-2 and Ekene-4.""")
doc('EKD-023', 'production_note', None, '2023-01-01', 'Rates at flood start', f"""
Rates on 2023-01-01, the first day of injection: Ekene-1 {oil(E1, '2023-01')} bopd, Ekene-3
{oil(E3, '2023-01')} bopd, Ekene-5 {oil(E5, '2023-01')} bopd and Ekene-6 {oil(E6, '2023-01')} bopd, no water.""")
doc('EKD-024', 'production_note', E6, '2023-06-01', 'Ekene-6 flood response', f"""
Ekene-6 is the first producer to respond to injection: {oil(E6, '2023-06')} bopd on 2023-06-01 against
{oil(E6, '2023-01')} bopd at flood start, about 3 months after injection began.""")
doc('EKD-025', 'production_note', E1, '2023-10-01', 'Ekene-1 flood response', f"""
Ekene-1 responded to the flood 5 months after injection began. Rate on 2023-10-01 was {oil(E1, '2023-10')} bopd,
up from {oil(E1, '2023-06')} bopd in June.""")
doc('EKD-026', 'production_note', E6, '2024-03-01', 'Ekene-6 water breakthrough', f"""
Water breakthrough at Ekene-6 dated 2024-03-01, the first producer to see injected water. Oil rate
{oil(E6, '2024-03')} bopd. Water sampling started to confirm injection water chemistry.""")
doc('EKD-027', 'production_note', E3, '2024-09-01', 'Ekene-3 water breakthrough', f"""
Water breakthrough at Ekene-3 dated 2024-09-01, with oil at {oil(E3, '2024-09')} bopd. Ekene-6 water cut has
reached {wc(E6, '2024-09')} percent.""")
doc('EKD-028', 'production_note', None, '2025-01-01', 'Field production 2025-01-01', f"""
Field report 2025-01-01. Ekene-6 {oil(E6, '2025-01')} bopd with {water(E6, '2025-01')} bwpd, a water cut of
{wc(E6, '2025-01')} percent. Ekene-3 {oil(E3, '2025-01')} bopd with {water(E3, '2025-01')} bwpd. Ekene-1
{oil(E1, '2025-01')} bopd and Ekene-5 {oil(E5, '2025-01')} bopd, both water free.""")
doc('EKD-029', 'production_note', E1, '2025-06-01', 'Ekene-1 water breakthrough', f"""
Water breakthrough at Ekene-1 dated 2025-06-01, the last of the three flooded producers. Oil {oil(E1, '2025-06')}
bopd. Ekene-6 water cut is now {wc(E6, '2025-06')} percent.""")
doc('EKD-030', 'production_note', None, '2025-12-01', 'Field production 2025-12-01', f"""
Year end report 2025-12-01. Ekene-6 {oil(E6, '2025-12')} bopd at {wc(E6, '2025-12')} percent water cut;
Ekene-3 {oil(E3, '2025-12')} bopd at {wc(E3, '2025-12')} percent; Ekene-1 {oil(E1, '2025-12')} bopd at
{wc(E1, '2025-12')} percent; Ekene-5 {oil(E5, '2025-12')} bopd, still water free.""")
doc('EKD-031', 'production_note', E5, '2025-12-01', 'Ekene-5 status', f"""
Ekene-5 has produced no water to date. It responded late to the flood, about 9 months after injection
began, and the oil rate on 2025-12-01 was {oil(E5, '2025-12')} bopd.""")
doc('EKD-032', 'production_note', E3, '2022-06-01', 'Ekene-3 well test 2022-06-01', f"""
Well test Ekene-3 on 2022-06-01: {oil(E3, '2022-06')} bopd through the test separator over 12 hours,
GOR {DES['rsi_scf_stb']} scf/stb, no water.""")
doc('EKD-033', 'production_note', E5, '2021-06-01', 'Ekene-5 well test 2021-06-01', f"""
Well test Ekene-5 on 2021-06-01: {oil(E5, '2021-06')} bopd over 12 hours, GOR {DES['rsi_scf_stb']} scf/stb,
no water. The rate sits on the harmonic decline trend.""")

# ---------------------------------------------------------------- injection
split = flood['design']['injection_split']
doc('EKD-034', 'injection_note', None, '2023-01-01', 'Injection start-up', f"""
Injection started on 2023-01-01. Ekene-2 took {inj(E2, '2023-01')} bwpd at a wellhead pressure of
{whp(E2, '2023-01')} psi and Ekene-4 took {inj(E4, '2023-01')} bwpd at {whp(E4, '2023-01')} psi, a
{int(split[E2] * 100)} to {int(split[E4] * 100)} split.""")
doc('EKD-035', 'injection_note', None, '2024-03-01', 'Injection 2024-03-01', f"""
Injection on 2024-03-01: Ekene-2 {inj(E2, '2024-03')} bwpd at {whp(E2, '2024-03')} psi wellhead pressure and
Ekene-4 {inj(E4, '2024-03')} bwpd at {whp(E4, '2024-03')} psi.""")
doc('EKD-036', 'injection_note', E4, '2025-01-01', 'Ekene-4 injectivity decline', f"""
Ekene-4 injectivity index fell from 0.5 to 0.35 bbl/d/psi from 2025-01-01, seen as a kink in the Hall plot
slope. On 2025-01-01 it took {inj(E4, '2025-01')} bwpd at {whp(E4, '2025-01')} psi wellhead pressure.""")
doc('EKD-037', 'injection_note', None, '2025-12-01', 'Voidage replacement', f"""
Voidage replacement ratio target: 0.85 in the first month of injection, rising by 0.04 a month to 1.05 from
the sixth month. Cumulative VRR at the end of 2025 is {round(flood['expected']['cumulative_vrr'], 3)}.""")

# ---------------------------------------------------------------- drilling
doc('EKD-038', 'drilling_report', E6, '2020-07-18', 'Ekene-6 daily drilling report', """
Ekene-6 daily drilling report 2020-07-18. Drilled 12.25 in hole from 1450 m to 1800 m MD with 12.4 ppg mud.
Ran and cemented 9.625 in casing with the shoe at 1800 m MD. No losses.""")
doc('EKD-039', 'drilling_report', E3, '2019-11-02', 'Ekene-3 daily drilling report', """
Ekene-3 daily drilling report 2019-11-02. Drilled 17.5 in hole to 1450 m MD with 10.5 ppg mud and set
13.375 in casing at 1450 m MD, above the Ogbia Shale pressure ramp.""")
doc('EKD-040', 'drilling_report', E4, '2020-10-09', 'Ekene-4 daily drilling report', """
Ekene-4 daily drilling report 2020-10-09. Partial losses of 15 bbl/hr at 1612 m MD while drilling with
12.6 ppg mud. Pumped a 40 bbl lost circulation material pill and losses stopped.""")
doc('EKD-041', 'drilling_report', E3, '2019-11-20', 'Ekene-3 gas readings', """
Ekene-3 drilling report 2019-11-20. Background gas 0.4 percent and connection gas 1.2 percent while drilling
the Ekene Sand at 1550 m MD. Mud weight held at 12.4 ppg; no influx.""")
doc('EKD-042', 'drilling_report', E1, '2019-09-30', 'Ekene-1 reached TD', """
Ekene-1 daily drilling report 2019-09-30. Drilled 8.5 in hole to TD at 2250 m MD. Ran a 7 in liner from
1800 m to 2250 m MD. KB elevation is 25 m and water depth 35 m.""")
doc('EKD-043', 'drilling_report', E5, '2020-04-11', 'Ekene-5 bit run', """
Ekene-5 daily drilling report 2020-04-11. Pulled the 12.25 in bit at 1760 m MD after 310 m at an average rate
of penetration of 14 m/hr. Bit graded 2-3-WT. Mud weight 12.4 ppg.""")

# ---------------------------------------------------------------- HSE
doc('EKD-044', 'hse_note', None, '2021-03-14', 'Dropped object near miss', """
Near miss on 2021-03-14: a 2 kg wrench fell 6 m from the monkey board to the drill floor on the Ekene platform.
Nobody was in the drop zone and there was no injury. Tool lanyards and the drop zone barrier rule were
re-briefed at the next toolbox talk.""")
doc('EKD-045', 'hse_note', None, '2022-05-06', 'H2S drill', """
Monthly H2S drill on 2022-05-06. Full muster at the lifeboat station in 7 minutes. Ekene produced gas has
tested at 0 ppm H2S; the drill keeps the crew ready for the deeper Oboro gas.""")
doc('EKD-046', 'hse_note', None, '2022-08-09', 'Diesel spill during bunkering', """
Minor diesel spill of 0.5 bbl on deck during bunkering on 2022-08-09. It was contained in the drip trays
and cleaned up with absorbent pads, with no discharge to sea. The bunkering hose coupling was replaced.""")
doc('EKD-047', 'hse_note', None, '2023-03-22', 'Permit to work audit', """
Permit to work audit on 2023-03-22: 48 permits reviewed, 3 findings, all for missing gas test records on
hot work permits. Supervisors were re-briefed and a gas test column was added to the permit form.""")
doc('EKD-048', 'hse_note', None, '2023-05-20', 'Lost time injury free milestone', """
The Ekene platform reached 1,000 days without a lost time injury on 2023-05-20.""")
doc('EKD-049', 'hse_note', None, '2024-06-12', 'Hot work fire watch', """
Hot work on the separator skid on 2024-06-12 ran under a fire watch with a charged hose and two
extinguishers. Continuous gas monitoring read 0 percent LEL throughout.""")
doc('EKD-050', 'hse_note', None, '2025-02-17', 'Chemical handling', """
Chemical handling review on 2025-02-17 for the scale inhibitor now dosed at Ekene-6 and Ekene-3.
Safety data sheets were posted at the injection skid and gloves and face shields issued.""")

# ---------------------------------------------------------------- facilities
doc('EKD-051', 'facilities_note', None, '2021-08-03', 'Test separator', """
The test separator on the Ekene platform operates at 150 psig and 120 F. It was recalibrated on 2021-08-03
and the oil meter factor set to 0.998.""")
doc('EKD-052', 'facilities_note', None, '2022-02-15', 'Associated gas handling', f"""
Associated gas at {DES['rsi_scf_stb']} scf/stb is used as fuel gas for the power generators. Gas beyond the
fuel demand is flared under the platform flaring consent.""")
doc('EKD-053', 'facilities_note', None, '2025-04-08', 'Produced water treatment', """
Produced water from the flooded producers passes a hydrocyclone and a degasser. Oil in water measured
25 mg/l on 2025-04-08 against the 40 mg/l discharge limit.""")
doc('EKD-054', 'facilities_note', E4, '2024-11-19', 'Injection pump overhaul', """
Injection pump A was overhauled on 2024-11-19 and returned to service. Injection filter change-out moved from
monthly to fortnightly after solids were found upstream of the Ekene-4 wellhead.""")
doc('EKD-055', 'facilities_note', E6, '2024-04-02', 'Scale inhibitor at Ekene-6', """
Scale inhibitor squeeze planned at Ekene-6 after water breakthrough. Continuous downhole dosing started on
2024-04-02 at 20 ppm based on produced water rate.""")

# ---------------------------------------------------------------- SCAL, DCA
doc('EKD-056', 'core_report', E1, None, 'Ekene-1 core plug', f"""
Core plug {PLUG['name']} from Ekene-1: permeability {PLUG['k_md']} md and porosity {PLUG['phi']}, with an
air-brine capillary pressure test. The reservoir average permeability used for modelling is
{CAP['reservoir']['k_md']} md.""")
doc('EKD-057', 'core_report', None, None, 'Relative permeability', f"""
Corey relative permeability for the Ekene Sand: connate water saturation {KR['Swc']}, residual oil
{KR['Sor']}, krw end point {KR['krwMax']} and kro end point {KR['kroMax']}, water exponent {KR['nw']} and oil
exponent {KR['no']}. With oil viscosity {scal['design']['muO_cp']} cp and water viscosity
{scal['design']['muW_cp']} cp the end-point mobility ratio is {scal['expected']['mobility_ratio']}.""")
doc('EKD-058', 'hse_note', None, '2022-08-09', 'Diesel spill during bunkering (shift handover copy)',
    P[[p['id'] for p in P].index('EKD-046')]['text'])
doc('EKD-059', 'dca_note', None, None, 'Primary decline parameters', f"""
Primary decline fits: Ekene-1 exponential with Di {PLANT[E1]['planted']['di_per_day']} per day; Ekene-3
hyperbolic with b {PLANT[E3]['planted']['b']} and Di {PLANT[E3]['planted']['di_per_day']} per day; Ekene-5
harmonic with Di {PLANT[E5]['planted']['di_per_day']} per day; Ekene-6 hyperbolic with b
{PLANT[E6]['planted']['b']} and Di {PLANT[E6]['planted']['di_per_day']} per day.""")
doc('EKD-060', 'dca_note', None, None, 'Primary EUR', f"""
EUR at the 10 bopd economic limit on primary decline alone: Ekene-1 {eur(E1)} stb, Ekene-3 {eur(E3)} stb,
Ekene-5 {eur(E5)} stb and Ekene-6 {eur(E6)} stb. The flood adds to these.""")

P.sort(key=lambda p: p['id'])
assert [p['id'] for p in P] == [f'EKD-{i:03d}' for i in range(1, 61)], [p['id'] for p in P]
assert P[45]['text'] == P[57]['text']

# ---------------------------------------------------------------- queries and graded judgments
# grades: 3 answers the question, 2 relevant, 1 related, 0 judged not relevant.
Q = [
    ('Q01', 'What was the reservoir pressure when the waterflood started?', {'EKD-018': 3, 'EKD-034': 1, 'EKD-023': 1, 'EKD-019': 1, 'EKD-017': 1, 'EKD-016': 1, 'EKD-014': 1, 'EKD-013': 1, 'EKD-002': 0, 'EKD-004': 0}),
    ('Q02', 'initial oil rate of Ekene-3', {'EKD-003': 3, 'EKD-021': 1, 'EKD-059': 1, 'EKD-032': 1, 'EKD-027': 1, 'EKD-039': 0, 'EKD-041': 0, 'EKD-043': 0, 'EKD-010': 0, 'EKD-013': 0, 'EKD-008': 0, 'EKD-001': 0}),
    ('Q03', 'Which wells were converted to water injectors?', {'EKD-002': 3, 'EKD-004': 3, 'EKD-034': 2, 'EKD-035': 1, 'EKD-036': 1, 'EKD-054': 1, 'EKD-047': 0, 'EKD-044': 0, 'EKD-026': 0}),
    ('Q04', 'bubble point pressure of the Ekene oil', {'EKD-010': 3, 'EKD-011': 2, 'EKD-018': 2, 'EKD-020': 1, 'EKD-012': 0, 'EKD-057': 0}),
    ('Q05', 'When did water break through at Ekene-6?', {'EKD-026': 3, 'EKD-055': 2, 'EKD-027': 1, 'EKD-029': 1, 'EKD-030': 1, 'EKD-024': 0, 'EKD-032': 0}),
    ('Q06', 'depth of the oil-water contact', {'EKD-007': 3, 'EKD-001': 2, 'EKD-002': 2, 'EKD-004': 2, 'EKD-003': 1, 'EKD-005': 1, 'EKD-006': 1, 'EKD-013': 1}),
    ('Q07', 'volumetric STOIIP estimate for the Ekene Sand', {'EKD-008': 3, 'EKD-007': 1, 'EKD-002': 0, 'EKD-004': 0, 'EKD-057': 0, 'EKD-009': 0, 'EKD-001': 0}),
    ('Q08', 'Ekene-4 injectivity decline and Hall plot', {'EKD-036': 3, 'EKD-054': 2, 'EKD-035': 1, 'EKD-034': 1, 'EKD-022': 0, 'EKD-060': 0, 'EKD-059': 0, 'EKD-033': 0, 'EKD-041': 0, 'EKD-023': 0}),
    ('Q09', 'dropped object near miss on the drill floor', {'EKD-044': 3, 'EKD-047': 0, 'EKD-045': 0, 'EKD-051': 0, 'EKD-033': 0, 'EKD-019': 0, 'EKD-001': 0}),
    ('Q10', 'diesel spill during bunkering', {'EKD-046': 3, 'EKD-058': 3, 'EKD-050': 0}),
    ('Q11', 'mud weight used to drill the Ekene Sand', {'EKD-041': 3, 'EKD-038': 2, 'EKD-040': 2, 'EKD-043': 1, 'EKD-039': 1, 'EKD-045': 0, 'EKD-044': 0, 'EKD-002': 0, 'EKD-004': 0}),
    ('Q12', 'setting depth of the 9.625 in casing shoe', {'EKD-038': 3, 'EKD-042': 1, 'EKD-039': 1, 'EKD-037': 0, 'EKD-043': 0, 'EKD-021': 0}),
    ('Q13', 'Ekene-6 water cut at the end of 2025', {'EKD-030': 3, 'EKD-029': 1, 'EKD-028': 1, 'EKD-027': 1, 'EKD-026': 1, 'EKD-037': 0, 'EKD-006': 0}),
    ('Q14', 'Is Ekene-5 producing water?', {'EKD-031': 3, 'EKD-030': 2, 'EKD-028': 2, 'EKD-033': 0, 'EKD-020': 0, 'EKD-057': 0, 'EKD-042': 0, 'EKD-007': 0, 'EKD-012': 0, 'EKD-027': 0}),
    ('Q15', 'decline curve parameters for Ekene-1', {'EKD-059': 3, 'EKD-060': 1, 'EKD-020': 1, 'EKD-022': 0, 'EKD-033': 0, 'EKD-056': 0, 'EKD-028': 0, 'EKD-011': 0}),
    ('Q16', 'EUR of each producer at the economic limit', {'EKD-060': 3, 'EKD-059': 1, 'EKD-001': 0, 'EKD-003': 0, 'EKD-005': 0, 'EKD-006': 0}),
    ('Q17', 'oil viscosity at initial reservoir pressure', {'EKD-010': 3, 'EKD-057': 1, 'EKD-011': 0, 'EKD-013': 0, 'EKD-014': 0, 'EKD-015': 0, 'EKD-016': 0, 'EKD-017': 0}),
    ('Q18', 'voidage replacement ratio target for the flood', {'EKD-037': 3, 'EKD-019': 2, 'EKD-034': 1, 'EKD-057': 0, 'EKD-009': 0, 'EKD-025': 0, 'EKD-031': 0, 'EKD-024': 0}),
    ('Q19', 'core plug permeability from Ekene-1', {'EKD-056': 3, 'EKD-057': 1, 'EKD-025': 0, 'EKD-037': 0, 'EKD-042': 0, 'EKD-028': 0, 'EKD-011': 0}),
    ('Q20', 'oil in water limit for produced water discharge', {'EKD-053': 3, 'EKD-046': 1, 'EKD-058': 1, 'EKD-052': 0, 'EKD-045': 0, 'EKD-031': 0, 'EKD-026': 0, 'EKD-055': 0, 'EKD-002': 0}),
    ('Q21', 'lost circulation while drilling Ekene-4', {'EKD-040': 3, 'EKD-038': 1, 'EKD-004': 0, 'EKD-041': 0, 'EKD-048': 0, 'EKD-043': 0}),
    ('Q22', 'gas-water contact of the Oboro Sand', {'EKD-009': 3, 'EKD-045': 1, 'EKD-002': 0, 'EKD-004': 0, 'EKD-001': 0, 'EKD-003': 0}),
    ('Q23', 'H2S concentration in the produced gas', {'EKD-045': 3, 'EKD-052': 1, 'EKD-053': 0, 'EKD-009': 0, 'EKD-031': 0, 'EKD-041': 0}),
    ('Q24', 'subsea tree replacement on Ekene-5', {'EKD-031': 0, 'EKD-043': 0, 'EKD-005': 0, 'EKD-019': 0, 'EKD-037': 0, 'EKD-033': 0, 'EKD-023': 0, 'EKD-028': 0}),
]
assert len(Q) == 24
DOC_IDS = {p['id'] for p in P}
for qid, _, j in Q:
    assert set(j) <= DOC_IDS, qid

# second annotator: the primary grade, moved by one grade with probability 0.25 and by two with 0.05
rnd = random.Random(20260925)
second = {}
for qid, _, j in Q:
    s = {}
    for did in sorted(j):
        g = j[did]
        u = rnd.random()
        if u < 0.05:
            g2 = g + (2 if g <= 1 else -2)
        elif u < 0.30:
            g2 = g + (1 if (g == 0 or (g < 3 and rnd.random() < 0.5)) else -1)
        else:
            g2 = g
        s[did] = g2
    second[qid] = s

SYS_K = 5


def runs_for(method):
    out = {}
    for qid, text, _ in Q:
        if method == 'bm25':
            r = O.bm25_scores(P, text, 1.2, 0.75, False)
            top, *_ = O.rank([p['id'] for p in P], r['scores'], SYS_K)
        else:
            m = O.tfidf_model(P, False, False)
            top, *_ = O.rank([p['id'] for p in P], O.tfidf_scores(m, O.tfidf_query(m, text, False)), SYS_K)
        out[qid] = [P[i]['id'] for i in top]
    return out


RUN_A = runs_for('bm25')
RUN_B = runs_for('tfidf')


# ---------------------------------------------------------------- reference short answers and both systems
# (query, reference short answer, A text, A citations, A short, B text, B citations, B short)
ANS = [
    ('Q01', '2,096 psia',
     'Average reservoir pressure was 2,096 psia on 2023-01-01, the day the waterflood started.', ['EKD-018'], '2,096 psia',
     'Reservoir pressure was about 2,100 psia when injection started on 2023-01-01.', ['EKD-018'], 'about 2,100 psia'),
    ('Q02', '150 bopd',
     'Ekene-3 came on stream on 2020-03-01 at 150 bopd.', ['EKD-003'], '150 bopd',
     'Ekene-3 started at 150 bopd on 2020-03-01.', ['EKD-003'], '150 bopd'),
    ('Q03', 'Ekene-2 and Ekene-4',
     'Ekene-2 and Ekene-4 were converted to water injectors for the waterflood that started on 2023-01-01, because both found the sand below the 1560 m TVD contact.', ['EKD-002', 'EKD-004'], 'Ekene-2 and Ekene-4',
     'Ekene-2 and Ekene-4 were converted to injectors, taking 92.7 and 61.8 bwpd at start-up.', ['EKD-002', 'EKD-004'], 'Ekene 2 and Ekene 4'),
    ('Q04', '2000 psia',
     'The bubble point is 2000 psia (EKD-010).', ['EKD-010'], '2000 psia',
     'The bubble point is 2000 psia and Boi is 1.2 rb/stb.', ['EKD-018'], '2,000 psia'),
    ('Q05', '2024-03-01',
     'Water broke through at Ekene-6 on 2024-03-01, when the oil rate was 54.7 bopd.', ['EKD-026'], '2024-03-01',
     'Water broke through at Ekene-6 on 2024-09-01.', ['EKD-027'], '2024-09-01'),
    ('Q06', '1560 m TVD',
     'The oil-water contact is at 1560 m TVD and the maximum oil column is 20.3 m.', ['EKD-001'], '1560 m TVD',
     'The oil-water contact is at 1560 m TVD.', ['EKD-001'], '1560 m TVD'),
    ('Q07', '12,139,208 stb',
     'Volumetric STOIIP is 12,139,208 stb, and material balance agrees.', ['EKD-008'], '12,139,208 stb',
     'STOIIP is 12.1 million stb.', ['EKD-008'], '12.1 million stb'),
    ('Q08', 'from 0.5 to 0.35 bbl/d/psi',
     'Ekene-4 injectivity index fell from 0.5 to 0.35 bbl/d/psi from 2025-01-01, a kink in the Hall plot.', ['EKD-036'], '0.5 to 0.35 bbl/d/psi',
     'Ekene-4 injectivity index fell to 0.35 bbl/d/psi, seen as a "kink in the Hall plot slope".', ['EKD-036'], '0.35 bbl/d/psi'),
    ('Q09', 'a 2 kg wrench',
     'On 2021-03-14 a 2 kg wrench fell 6 m from the monkey board; nobody was hurt.', ['EKD-044'], 'a 2 kg wrench',
     'A 2 kg wrench fell 6 m to the drill floor on 2021-03-14.', ['EKD-044'], 'a wrench'),
    ('Q10', '0.5 bbl',
     'About 0.5 bbl of diesel spilled on deck during bunkering on 2022-08-09 and was contained in the drip trays.', ['EKD-046', 'EKD-058'], '0.5 bbl',
     'About 5 bbl of diesel was spilled during bunkering on 2022-08-09.', ['EKD-046'], 'about 5 bbl'),
    ('Q11', '12.4 ppg',
     'The Ekene Sand was drilled with 12.4 ppg mud at Ekene-3.', ['EKD-041'], '12.4 ppg',
     'Mud weight in the Ekene Sand was 12.6 ppg.', ['EKD-041'], '12.6 ppg'),
    ('Q12', '1800 m MD',
     'The 9.625 in casing shoe was set at 1800 m MD.', ['EKD-038'], '1800 m MD',
     'The 9.625 in shoe is at 1800 m MD.', ['EKD-039'], '1800 m MD'),
    ('Q13', '45.0 percent',
     'Ekene-6 water cut was 45 percent at the end of 2025 (2025-12-01).', ['EKD-030'], '45 percent',
     'Ekene-6 water cut reached 45.0 percent on 2025-12-01.', ['EKD-030'], '45.0 percent'),
    ('Q14', 'water free',
     'The retrieved passages do not say whether Ekene-5 produces water.', [], '',
     'Ekene-5 is still water free; on 2025-12-01 it made 38.5 bopd.', ['EKD-030'], 'water free'),
    ('Q15', 'exponential, Di 0.0012 per day',
     'Ekene-1 follows an exponential decline with Di 0.0012 per day.', ['EKD-059'], 'exponential, Di 0.0012 per day',
     'Ekene-1 declines exponentially with Di 0.0012 per day.', ['EKD-059'], 'exponential, Di 0.0012 per day'),
    ('Q16', 'Ekene-1 91,667 stb, Ekene-3 111,270 stb, Ekene-5 153,506 stb, Ekene-6 105,267 stb',
     'EUR at the 10 bopd limit: Ekene-1 91,667 stb, Ekene-3 111,270 stb, Ekene-5 153,506 stb and Ekene-6 105,267 stb.', ['EKD-060'], 'Ekene-1 91,667 stb, Ekene-3 111,270 stb, Ekene-5 153,506 stb, Ekene-6 105,267 stb',
     'EUR at the economic limit is 91,667 stb for Ekene-1 and 153,506 stb for Ekene-5.', ['EKD-060'], 'Ekene-1 91,667 stb, Ekene-5 153,506 stb'),
    ('Q17', '2.05 cp',
     'Oil viscosity is 2.05 cp at the initial 3200 psia.', ['EKD-010'], '2.05 cp',
     'Oil viscosity is 2.05 cp at 3,200 psia.', ['EKD-010'], '2.05 cp'),
    ('Q18', '0.85 rising to 1.05',
     'The VRR target starts at 0.85 and rises by 0.04 a month to 1.05; cumulative VRR reached 1.035 at the end of 2025.', ['EKD-037'], '0.85 rising by 0.04 a month to 1.05',
     'The VRR target is 1.05, reached from the sixth month.', ['EKD-019'], '1.05'),
    ('Q19', '420 md',
     'Plug EK1-P from Ekene-1 measured 420 md.', ['EKD-056'], '420 md',
     'The Ekene-1 core plug measured 420 md and porosity 0.23.', ['EKD-056'], '420 md'),
    ('Q20', '40 mg/l',
     'The discharge limit is 40 mg/l; the 2025-04-08 sample read 25 mg/l.', ['EKD-053'], '40 mg/l',
     'Oil in water must stay below 40 mg/l.', ['EKD-053'], '40 mg/l'),
    ('Q21', '15 bbl/hr at 1612 m MD',
     'Ekene-4 had partial losses of 15 bbl/hr at 1612 m MD with 12.6 ppg mud, cured with a 40 bbl pill.', ['EKD-040'], '15 bbl/hr at 1612 m MD',
     'Losses of 15 bbl/hr at 1612 m MD were cured with a 40 bbl pill.', ['EKD-040', 'EKD-061'], '15 bbl/hr at 1612 m MD'),
    ('Q22', '1935 m MD',
     'The Oboro Sand gas-water contact is at 1935 m MD at Ekene-1.', ['EKD-009'], '1935 m MD',
     'The Oboro gas-water contact is at 1935 m MD.', ['EKD-009'], '1935 m MD'),
    ('Q23', '0 ppm',
     'Produced gas tested at 0 ppm H2S.', ['EKD-045'], '0 ppm',
     'H2S in the produced gas is 0 ppm; the muster took 7 minutes.', ['EKD-045'], '0 ppm'),
    ('Q24', '',
     'No retrieved passage mentions a subsea tree replacement.', [], '',
     'The Ekene-5 subsea tree was replaced on 2024-03-01.', ['EKD-031'], '2024-03-01'),
]
assert [a[0] for a in ANS] == [q[0] for q in Q]

# ---------------------------------------------------------------- extraction labels (30 records) and two prediction sets
FIELDS = [
    {'name': 'well', 'type': 'text'},
    {'name': 'date', 'type': 'text'},
    {'name': 'event', 'type': 'text'},
    {'name': 'oil_rate_bopd', 'type': 'number', 'absTol': 0.05},
    {'name': 'water_cut_pct', 'type': 'number', 'absTol': 0.05},
    {'name': 'reservoir_pressure_psia', 'type': 'number', 'absTol': 0.5},
]
N_ = None
# id: well, date, event, oil, water cut, reservoir pressure
LAB = {
    'EKD-001': (E1, '2020-01-01', 'first oil', 120, N_, N_),
    'EKD-002': (E2, '2023-01-01', 'conversion to injector', N_, N_, N_),
    'EKD-003': (E3, '2020-03-01', 'first oil', 150, N_, N_),
    'EKD-004': (E4, '2023-01-01', 'conversion to injector', N_, N_, N_),
    'EKD-005': (E5, '2020-06-01', 'first oil', 100, N_, N_),
    'EKD-006': (E6, '2020-09-01', 'first oil', 90, N_, N_),
    'EKD-013': (N_, '2020-07-01', 'pressure survey', N_, N_, 3038),
    'EKD-014': (N_, '2021-01-01', 'pressure survey', N_, N_, 2783),
    'EKD-015': (N_, '2021-07-01', 'pressure survey', N_, N_, 2562),
    'EKD-016': (N_, '2022-01-01', 'pressure survey', N_, N_, 2378),
    'EKD-017': (N_, '2022-07-01', 'pressure survey', N_, N_, 2226),
    'EKD-018': (N_, '2023-01-01', 'pressure survey', N_, N_, 2096),
    'EKD-020': (E1, '2020-04-01', 'production', 107.6, 0, N_),
    'EKD-022': (E6, '2022-10-01', 'production', 45.9, 0, N_),
    'EKD-024': (E6, '2023-06-01', 'flood response', 47.7, N_, N_),
    'EKD-025': (E1, '2023-10-01', 'flood response', 38.2, N_, N_),
    'EKD-026': (E6, '2024-03-01', 'water breakthrough', 54.7, N_, N_),
    'EKD-027': (E3, '2024-09-01', 'water breakthrough', 41.5, N_, N_),
    'EKD-029': (E1, '2025-06-01', 'water breakthrough', 34.0, N_, N_),
    'EKD-031': (E5, '2025-12-01', 'production', 38.5, 0, N_),
    'EKD-032': (E3, '2022-06-01', 'well test', 45.2, 0, N_),
    'EKD-033': (E5, '2021-06-01', 'well test', 64.6, 0, N_),
    'EKD-036': (E4, '2025-01-01', 'injectivity decline', N_, N_, N_),
    'EKD-038': (E6, '2020-07-18', 'casing', N_, N_, N_),
    'EKD-040': (E4, '2020-10-09', 'losses', N_, N_, N_),
    'EKD-041': (E3, '2019-11-20', 'gas reading', N_, N_, N_),
    'EKD-044': (N_, '2021-03-14', 'near miss', N_, N_, N_),
    'EKD-046': (N_, '2022-08-09', 'spill', N_, N_, N_),
    'EKD-053': (N_, '2025-04-08', 'water treatment', N_, N_, N_),
    'EKD-056': (E1, N_, 'core plug', N_, N_, N_),
}
assert len(LAB) == 30
NAMES = [f['name'] for f in FIELDS]


def rec(rid, vals):
    return {'id': rid, 'fields': {n: v for n, v in zip(NAMES, vals) if v is not None}}


# System A: careful; its errors are planted and listed in the README.
PRED_A = {k: list(v) for k, v in LAB.items()}
PRED_A['EKD-013'][5] = '3,038'            # a numeric string: parsed, correct
PRED_A['EKD-020'][4] = None               # missed: "with no water" is a 0 water cut
PRED_A['EKD-027'][4] = 3.7                # unsupported: 3.7 percent is Ekene-6, not Ekene-3
PRED_A['EKD-036'][5] = 2289               # unsupported: 2,289 psi is wellhead pressure
PRED_A['EKD-038'][2] = 'casing run'       # wrong event wording
PRED_A['EKD-044'][2] = 'near-miss'        # wrong: normalises to "nearmiss"
# System B: sloppier.
PRED_B = {k: list(v) for k, v in LAB.items() if k not in ('EKD-053', 'EKD-056')}   # two records not returned
PRED_B['EKD-003'][0] = 'Ekene 3'          # wrong: "ekene 3" is not "ekene3"
PRED_B['EKD-003'][3] = '150 bopd'         # wrong: not a plain number
PRED_B['EKD-005'][0] = 'Ekene 5'
PRED_B['EKD-013'][0] = E1                 # unsupported: a field-wide survey has no well
PRED_B['EKD-017'][5] = 2230               # wrong: 4 psi off
PRED_B['EKD-026'][1] = '2024-09-01'       # wrong date (Ekene-3's breakthrough)
PRED_B['EKD-027'][4] = 3.7                # unsupported
PRED_B['EKD-029'][4] = 23.0               # unsupported: Ekene-6's water cut
PRED_B['EKD-032'][3] = 45.25              # correct: 0.05 off, at the absTol 0.05 (inclusive)
PRED_B['EKD-033'][3] = 64.7               # wrong: 0.1 off
PRED_B['EKD-038'][2] = 'casing'
PRED_B['EKD-040'][2] = 'lost circulation' # wrong wording
PRED_B['EKD-041'][4] = 0.4                # unsupported: 0.4 percent is background gas
PRED_B['EKD-044'][2] = 'the near miss'    # correct: the article is dropped

# ---------------------------------------------------------------- calibration set (200 rows)
# A relevance classifier's probability that a passage answers or supports a
# query (label: judged grade >= 2), from a logistic curve on the BM25 score
# that was "fitted on another field": over-confident at the top by design.
ids = [p['id'] for p in P]
pairs = []
for qid, text, j in Q:
    sc = O.bm25_scores(P, text, 1.2, 0.75, False)['scores']
    for did in sorted(j):
        pairs.append((qid, did, float(sc[ids.index(did)]), 1 if j[did] >= 2 else 0))
judged = {(a, b) for a, b, _, _ in pairs}
rc = random.Random(7)
extra = []
for qid, text, j in Q:
    sc = O.bm25_scores(P, text, 1.2, 0.75, False)['scores']
    for i, did in enumerate(ids):
        if (qid, did) not in judged:
            extra.append((qid, did, float(sc[i]), 0))
rc.shuffle(extra)
need = 200 - len(pairs)
assert need > 0, len(pairs)
pairs = sorted(pairs + extra[:need])


def prob(s):
    return round(1 / (1 + math.exp(-(0.6 * s - 3.0))), 2)


CAL = [{'query': a, 'passage': b, 'bm25': round(s, 6), 'probability': prob(s), 'relevant': y} for a, b, s, y in pairs]
assert len(CAL) == 200


def dump(name, obj):
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, name), 'w') as fh:
        json.dump(obj, fh, indent=1, ensure_ascii=False)
        fh.write('\n')


SYN = 'SYNTHETIC teaching data for the Ekene field (Petrolord, fictional block EK-11). No real company, person, well or incident.'


def main():
    dump('corpus.json', {
        'synthetic': SYN,
        'generatedBy': 'tools/validation/dataai/make_evaluate_fixtures.py',
        'description': 'Short Ekene field documents: end of well summaries, geology, PVT, pressure surveys, production and injection notes, daily drilling reports, HSE and facilities notes, core and decline notes. EKD-058 is an exact copy of EKD-046 (a shift handover copy), so rankings tie on it. The engine indexes `text` only.',
        'passages': P,
    })
    dump('queries.json', {
        'synthetic': SYN,
        'generatedBy': 'tools/validation/dataai/make_evaluate_fixtures.py',
        'grades': {'3': 'answers the query', '2': 'relevant', '1': 'related', '0': 'judged not relevant'},
        'pooling': 'every passage in the top 5 of either system (BM25 and TF-IDF, default settings) is judged, plus passages the assessor added; unjudged passages count as grade 0',
        'secondAnnotator': 'an independent second grading of every judged pair, for Cohen kappa (drawn: the primary grade moved one grade with probability 0.25 and two grades with probability 0.05, random.Random(20260925))',
        'queries': [{'id': qid, 'text': t, 'reference': next(a[1] for a in ANS if a[0] == qid), 'judgments': dict(sorted(j.items())), 'secondAnnotator': second[qid]} for qid, t, j in Q],
    })
    dump('systems.json', {
        'synthetic': SYN,
        'generatedBy': 'tools/validation/dataai/make_evaluate_fixtures.py',
        'description': 'Two fixed question-answering systems over the corpus. The answer text is hand-written fixture text; no language model is run. retrieved is the top 5 of the named retriever at the stated settings (the gate checks it against the engine).',
        'systems': [
            {'id': 'A', 'name': 'System A', 'retriever': {'method': 'bm25', 'k': SYS_K, 'k1': 1.2, 'b': 0.75, 'stopWords': False},
             'answers': [{'query': a[0], 'retrieved': RUN_A[a[0]], 'text': a[2], 'citations': a[3], 'short': a[4]} for a in ANS]},
            {'id': 'B', 'name': 'System B', 'retriever': {'method': 'tfidf', 'k': SYS_K, 'sublinearTf': False, 'stopWords': False},
             'answers': [{'query': a[0], 'retrieved': RUN_B[a[0]], 'text': a[5], 'citations': a[6], 'short': a[7]} for a in ANS]},
        ],
    })
    dump('extraction.json', {
        'synthetic': SYN,
        'generatedBy': 'tools/validation/dataai/make_evaluate_fixtures.py',
        'description': 'One record per source passage (the record id is the passage id). A field is empty where the passage does not state it for that record. water_cut_pct 0 where the passage says the well makes no water. reservoir_pressure_psia is the static reservoir pressure, never a wellhead pressure.',
        'fields': FIELDS,
        'labels': [rec(k, v) for k, v in sorted(LAB.items())],
        'predictions': {'A': [rec(k, v) for k, v in sorted(PRED_A.items())], 'B': [rec(k, v) for k, v in sorted(PRED_B.items())]},
    })
    dump('calibration.json', {
        'synthetic': SYN,
        'generatedBy': 'tools/validation/dataai/make_evaluate_fixtures.py',
        'description': 'A relevance classifier on (query, passage) pairs: probability that the passage is relevant (judged grade 2 or 3). Every judged pair plus unjudged pairs (grade 0) drawn with random.Random(7) to make 200 rows. probability = 1 / (1 + exp(-(0.6 x bm25 - 3.0))) rounded to 2 dp, a curve fitted elsewhere, so it is not calibrated here.',
        'rows': CAL,
    })
    print('wrote', OUT, len(P), 'passages,', len(Q), 'queries,', sum(len(j) for _, _, j in Q), 'judgments,', len(LAB), 'labelled records,', len(CAL), 'calibration rows')


if __name__ == '__main__' and '--runs' in sys.argv:
    for qid, text, j in Q:
        print(qid, text)
        print('  A', [(d, j.get(d, '-')) for d in RUN_A[qid]])
        print('  B', [(d, j.get(d, '-')) for d in RUN_B[qid]])
    sys.exit(0)


if __name__ == '__main__':
    main()
