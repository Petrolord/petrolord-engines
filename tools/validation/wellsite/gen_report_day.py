#!/usr/bin/env python3
"""A synthetic report day for the WS7/WS8 report goldens (test-data/wellsite/report-day.json).

Two tours (06:00 to 18:00 and 18:00 to 06:00 rig local, offset +60 min) on
2026-09-07. Deterministic: every id and time is derived from its index, so
the expected counts in README.md are worked by hand and the JSON is
byte-identical on regeneration. The expected section counts live in the
"expected" block and the JS test asserts against them.
"""
import json, os

FT = 0.3048
OFFSET_MIN = 60
DAY_START_UTC = "2026-09-07T05:00:00Z"   # 06:00 rig local
def utc(h, m=0):  # rig-local hour on 2026-09-07 (or 08 when h >= 24) to UTC ISO
    h_utc = h - 1
    day = 7 + (h_utc // 24)
    return f"2026-09-{day:02d}T{h_utc % 24:02d}:{m:02d}:00.000Z"

records, samples, stages, tops, photos, events = [], [], [], [], [], []
W = "well-1"
# bit depth every hour from 06:00 to 06:00 next day: 10,000 ft at 06:00, 40 ft/hr
for i in range(25):
    records.append({"id": f"bit-{i:02d}", "well_id": W, "kind": "observation", "subtype": "bit_depth", "chain_id": f"bit-{i:02d}", "version_no": 1,
                    "occurred_at": utc(6 + i), "local_offset_min": OFFSET_MIN, "md_calc_m": (10000 + 40 * i) * FT, "tvd_calc_m": (10000 + 40 * i) * FT * 0.95, "depth_kind": "bit_depth", "payload": {"source": "manual"}})
# pump log: on all day
records.append({"id": "pump-0", "well_id": W, "kind": "observation", "subtype": "pump_rate", "chain_id": "pump-0", "version_no": 1, "occurred_at": utc(6), "local_offset_min": OFFSET_MIN, "payload": {"spm": 60}})
# samples every 10 ft from 10,000 to 10,960 (96 samples), caught when the bit passes plus 3 h, described 1 h later, bagged for the day tour
for k in range(96):
    md = (10010 + 10 * k) * FT
    samples.append({"id": f"s-{k:03d}", "well_id": W, "sample_no": k + 1, "md_calc_m": md, "scheduled_at": utc(6)})
    hour_cut = 6 + (10 + 10 * k) / 40.0
    if hour_cut + 3 < 30:
        stages.append({"id": f"st-c-{k:03d}", "well_id": W, "sample_id": f"s-{k:03d}", "stage": "caught", "at_utc": utc(int(hour_cut + 3), int(((hour_cut + 3) % 1) * 60)), "local_offset_min": OFFSET_MIN})
    if hour_cut + 4 < 30:
        stages.append({"id": f"st-d-{k:03d}", "well_id": W, "sample_id": f"s-{k:03d}", "stage": "described", "at_utc": utc(int(hour_cut + 4), int(((hour_cut + 4) % 1) * 60)), "local_offset_min": OFFSET_MIN})
    if hour_cut + 4 < 18:
        stages.append({"id": f"st-b-{k:03d}", "well_id": W, "sample_id": f"s-{k:03d}", "stage": "bagged", "at_utc": utc(int(hour_cut + 5), int(((hour_cut + 5) % 1) * 60)), "local_offset_min": OFFSET_MIN})
# descriptions: one per 40 ft interval, 24 in the day, sandstone/shale alternating
for i in range(24):
    top = (10000 + 40 * i) * FT
    comps = [{"lithology": "sandstone", "percent": 70, "colour": {"hue": "grey", "modifier": "light"}, "grainSize": {"from": "f_sand", "to": "m_sand"}, "texture": [], "cement": [], "accessories": [], "fossils": [], "porosityTypes": []},
             {"lithology": "shale", "percent": 30, "colour": {"hue": "grey", "modifier": "dark"}, "texture": ["fissile"], "cement": [], "accessories": [], "fossils": [], "porosityTypes": []}] if i % 2 == 0 else \
            [{"lithology": "shale", "percent": 100, "colour": {"hue": "grey", "modifier": "dark"}, "hardness": "firm", "texture": ["fissile"], "cement": [], "accessories": [], "fossils": [], "porosityTypes": []}]
    records.append({"id": f"desc-{i:02d}", "well_id": W, "kind": "observation", "subtype": "cuttings_description", "chain_id": f"desc-{i:02d}", "version_no": 1,
                    "occurred_at": utc(10 + i), "local_offset_min": OFFSET_MIN, "md_calc_m": top, "md2_calc_m": top + 40 * FT, "payload": {"components": comps, "comment": "", "mode": "quick"}})
# 3 shows in the day tour, 1 at night
for i, (h, q) in enumerate([(9, "fair"), (13, "good"), (16, "very_good"), (22, "poor")]):
    fl = {"fair": ("yellow", "moderate", 25), "good": ("gold", "bright", 25), "very_good": ("bright_yellow", "bright", 50), "poor": ("dull_brown", "dull", 5)}[q]
    cut = {"fair": ("moderate", "streaming"), "good": ("fast", "streaming"), "very_good": ("fast", "streaming"), "poor": ("slow", "crush")}[q]
    records.append({"id": f"show-{i}", "well_id": W, "kind": "observation", "subtype": "show", "chain_id": f"show-{i}", "version_no": 1, "occurred_at": utc(h), "local_offset_min": OFFSET_MIN, "md_calc_m": (10000 + 40 * (h - 6)) * FT,
                    "payload": {"fluorescence": {"colour": fl[0], "intensity": fl[1], "distributionPct": fl[2]}, "cut": {"speed": cut[0], "colour": "yellow", "type": cut[1]}, "stain": "spotty" if q in ("good", "very_good") else "none", "odour": "faint" if q == "very_good" else "none", "residue": "none"}})
# gas: total gas every 2 hours, connection gas at 12:00 and 20:00
for i in range(12):
    records.append({"id": f"gas-{i:02d}", "well_id": W, "kind": "observation", "subtype": "total_gas", "chain_id": f"gas-{i:02d}", "version_no": 1, "occurred_at": utc(6 + 2 * i, 30), "local_offset_min": OFFSET_MIN, "md_calc_m": (10000 + 40 * (2 * i)) * FT, "payload": {"value": 0.5 + 0.1 * i, "unit": "%", "source": "external"}})
for i, h in enumerate([12, 20]):
    records.append({"id": f"cgas-{i}", "well_id": W, "kind": "observation", "subtype": "connection_gas", "chain_id": f"cgas-{i}", "version_no": 1, "occurred_at": utc(h), "local_offset_min": OFFSET_MIN, "md_calc_m": (10000 + 40 * (h - 6)) * FT, "payload": {"value": 3.2, "unit": "%", "source": "external"}})
# other observations: cavings at 15:00, a note at 23:00
records.append({"id": "obs-cav", "well_id": W, "kind": "observation", "subtype": "cavings", "chain_id": "obs-cav", "version_no": 1, "occurred_at": utc(15), "local_offset_min": OFFSET_MIN, "md_calc_m": (10000 + 40 * 9) * FT, "payload": {"text": "Splintery cavings increasing", "source": "manual"}})
records.append({"id": "obs-note", "well_id": W, "kind": "observation", "subtype": "note", "chain_id": "obs-note", "version_no": 1, "occurred_at": utc(23), "local_offset_min": OFFSET_MIN, "payload": {"text": "Sand stringers thickening", "source": "manual"}})
# narratives: a geological summary for the day tour and one for the night tour (records of kind narrative)
records.append({"id": "narr-day", "well_id": W, "kind": "narrative", "subtype": "geological_summary", "chain_id": "narr-day", "version_no": 1, "occurred_at": utc(17, 50), "local_offset_min": OFFSET_MIN, "payload": {"text": "Drilled ahead in interbedded sand and shale; good show at 10280 ft.", "period_start": "2026-09-07T05:00:00.000Z"}})
records.append({"id": "narr-night-v1", "well_id": W, "kind": "narrative", "subtype": "geological_summary", "chain_id": "narr-night", "version_no": 1, "occurred_at": utc(29, 40), "local_offset_min": OFFSET_MIN, "payload": {"text": "Shale dominated.", "period_start": "2026-09-07T17:00:00.000Z"}})
records.append({"id": "narr-night-v2", "well_id": W, "kind": "narrative", "subtype": "geological_summary", "chain_id": "narr-night", "version_no": 2, "previous_version_id": "narr-night-v1", "occurred_at": utc(29, 50), "local_offset_min": OFFSET_MIN, "payload": {"text": "Shale dominated with thin sand stringers from 10800 ft.", "period_start": "2026-09-07T17:00:00.000Z"}})
# tops: Agbada interpreted then called preliminary at 13:00, confirmed at 14:00 (day tour); Akata prognosed only
tops.append({"id": "top-i1", "well_id": W, "formation_key": "top_agbada", "name": "Top Agbada", "chain_id": "top-i1", "version_no": 1, "role": "interpretation", "status": "preliminary", "confidence": "high", "occurred_at": utc(12, 30), "local_offset_min": OFFSET_MIN, "md_calc_m": 10260 * FT, "range_top_md_m": 10250 * FT, "range_base_md_m": 10270 * FT})
tops.append({"id": "top-c1", "well_id": W, "formation_key": "top_agbada", "name": "Top Agbada", "chain_id": "top-c1", "version_no": 1, "role": "official", "status": "preliminary", "basis": "GR drop and sand", "occurred_at": utc(13), "local_offset_min": OFFSET_MIN, "md_calc_m": 10262 * FT})
tops.append({"id": "top-c2", "well_id": W, "formation_key": "top_agbada", "name": "Top Agbada", "chain_id": "top-c1", "version_no": 2, "previous_version_id": "top-c1", "role": "official", "status": "confirmed", "basis": "Cuttings confirm", "occurred_at": utc(14), "local_offset_min": OFFSET_MIN, "md_calc_m": 10262 * FT})
# events (engine shapes, ms): drilling all day with 12 connections of 10 min, a 30 min circulation at 17:00
def ms(h, m=0):
    import datetime
    return int(datetime.datetime(2026, 9, 7 + ((h - 1) // 24), (h - 1) % 24, m, tzinfo=datetime.timezone.utc).timestamp() * 1000)
for i in range(12):
    h = 6 + 2 * i
    events.append({"id": f"ev-conn-{i:02d}", "type": "connection", "label": "Connection", "startUtcMs": ms(h, 45), "endUtcMs": ms(h, 55), "mdM": (10000 + 40 * (h - 6)) * FT, "duration": True, "family": "rig", "by": "user-a"})
events.append({"id": "ev-circ", "type": "circulation", "label": "Circulation", "startUtcMs": ms(17), "endUtcMs": ms(17, 30), "mdM": 10440 * FT, "duration": True, "family": "rig", "by": "user-a"})
events.append({"id": "ev-top", "type": "top_called", "label": "Top Agbada called at 10262 ft (preliminary)", "startUtcMs": ms(13), "endUtcMs": ms(13), "mdM": 10262 * FT, "duration": False, "family": "geology", "by": "user-a"})
events.append({"id": "ev-open", "type": "sweep", "label": "Sweep", "startUtcMs": ms(29, 30), "endUtcMs": None, "mdM": 10920 * FT, "duration": True, "family": "rig", "by": "user-a"})
# photos: 6 in the day tour, 2 at night
for i in range(8):
    h = 8 + 2 * i
    photos.append({"id": f"ph-{i}", "well_id": W, "captured_at": utc(h, 15), "local_offset_min": OFFSET_MIN, "md_calc_m": (10000 + 40 * (h - 6)) * FT, "caption": f"Tray {i + 1}", "sample_id": f"s-{(4 * (h - 6)) // 1:03d}", "variants": {"thumb": {"bytes": 1}, "working": {"bytes": 1}, "original": None}})

fixture = {
    "note": "Synthetic report day, generated by tools/validation/wellsite/gen_report_day.py; expected counts worked by hand in README.md.",
    "well": {"id": W, "name": "KETA-2", "header": {"field": "Keta", "rig": "Rig 12", "operator": "Petrolord E&P"}, "settings": {"rig_offset_min": OFFSET_MIN, "tour_starts_local": ["06:00", "18:00"], "report_day_start_local": "06:00"}},
    "offsetMin": OFFSET_MIN,
    "nowUtc": "2026-09-08T05:00:00.000Z",
    "data": {"records": records, "samples": samples, "stages": stages, "tops": tops, "photos": photos, "events": events},
    "expected": {
        "dayTour": {"period": {"start": "2026-09-07T05:00:00.000Z", "end": "2026-09-07T17:00:00.000Z"}, "topsCalled": 2, "shows": 3, "gasRows": 7, "otherObservations": 1, "events": 8, "photos": 5,
                    "caught": 35, "described": 31, "bagged": 27, "made_ft": 440, "narrative": "Drilled ahead in interbedded sand and shale; good show at 10280 ft.", "connectionMinutes": 60, "circulationMinutes": 30},
        "nightTour": {"period": {"start": "2026-09-07T17:00:00.000Z", "end": "2026-09-08T05:00:00.000Z"}, "topsCalled": 0, "shows": 1, "gasRows": 7, "otherObservations": 1, "events": 7, "photos": 3,
                      "narrative": "Shale dominated with thin sand stringers from 10800 ft."},
        "day": {"period": {"start": "2026-09-07T05:00:00.000Z", "end": "2026-09-08T05:00:00.000Z"}, "topsCalled": 2, "shows": 4, "gasRows": 14, "events": 15, "photos": 8, "lithologyRows": 20, "made_ft": 920, "peakGas": "1.6 %"},
    },
}
out = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'test-data', 'wellsite', 'report-day.json')
with open(out, 'w') as f:
    json.dump(fixture, f, indent=2, sort_keys=True)
    f.write('\n')
print('wrote', os.path.relpath(out))
