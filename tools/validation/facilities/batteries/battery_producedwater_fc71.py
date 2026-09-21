#!/usr/bin/env python3
"""FC7-1 planting battery for the produced water engine.

Plants ONE defect at a time, runs the produced-water jest suite, restores.
A defect that leaves the suite GREEN is a defect the gate cannot see, and
the whole count is the measure of the gate.

  python3 battery_producedwater_fc71.py            # the whole battery
  python3 battery_producedwater_fc71.py --only P   # one prefix

A BATTERY IS A MEASURING INSTRUMENT, AND THREE DEFECTS HAVE BEEN FOUND
IN THIS FAMILY OF RUNNERS, all of which pushed the reading THE SAME WAY:
they inflated the number of plants that appeared to survive, so a plant
that broke the harness was indistinguishable from a plant the gate
failed to catch. All three are refused here. The first two came from the
FC9-0 and FC8-0 waves; the third is from engines PR #205, which hardened
the shell runner `plant.sh` against exactly these and gated it against
itself in `control_on_the_runner.sh`.

 1. NO RESULTS LINE WAS READ AS NO FAILURES. `plant.sh` piped jest
    through `grep -E '^Tests:'` and tested the capture for the word
    "failed". A plant that stopped jest producing a summary at all gave
    an EMPTY capture, no "failed", and a GREEN score.
 2. TWO CONCURRENT BATTERIES ON ONE WORKTREE produced seven bogus
    greens that were all red when re-run serially, because each one was
    restoring the files the other was mutating.
 3. A SUITE THAT FAILED TO LOAD LEFT A CLEAN SUMMARY. A runner that
    reads `Tests:` and not `Test Suites:` cannot tell a passing gate
    from half a gate.

What this runner requires before it will score a plant at all: BOTH
summary lines; no `Test suite failed to run` anywhere in the output; the
expected number of suites to have run; and a FLOOR on the number of
tests, so losing a suite's worth of gate cannot pass unnoticed. It
verifies the restore BEFORE and AFTER every plant, so a failed restore
is reported rather than contaminating every later plant. It is strictly
serial, one subprocess at a time in one loop, and it takes an exclusive
lock so a second copy refuses to start. A plant it cannot read is
HARNESS-BROKEN, is never scored in either direction, and makes the run
exit non-zero.

AND IT IS GATED AGAINST ITSELF. The battery carries H1, a deliberate
parse-breaking plant whose EXPECTED verdict is that refusal, so the fix
is not a promise: a runner that scored H1 green would fail its own run.

This is a Python runner rather than a copy of `plant.sh` because the
produced water battery is a list of SIXTY substitutions carried as JSON,
several of them planting the engine and the oracle together and
regenerating the golden in between, which is a case table rather than a
script. It is held to the same bar.
"""
import argparse
import fcntl
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
W = os.environ.get("FC71_WORKTREE", os.path.normpath(os.path.join(HERE, "..", "..", "..", "..")))
ENG = os.path.join(W, "engines/facilities/producedWater.js")
ORA = os.path.join(W, "tools/validation/facilities/oracle_producedwater.py")
GLD = os.path.join(W, "test-data/facilities/goldens/producedwater_cases.json")
TEST = "__tests__/facilities.producedwater.test.js"
CASES = os.path.join(HERE, "battery_producedwater_fc71.json")


def plant(path, a, b):
    s = open(path).read()
    if s.count(a) < 1:
        return False
    open(path, "w").write(s.replace(a, b, 1))
    return True


# The one suite this battery measures, and the number of tests it holds
# when nothing is planted. A FLOOR rather than an exact count, so adding a
# test does not break the battery while losing a suite's worth of gate
# cannot pass unnoticed.
EXPECTED_SUITES = 1
MIN_TESTS = int(os.environ.get("FC71_MIN_TESTS", "70"))


def run_suite():
    """Run the suite and REFUSE any result this runner cannot read.

    Returns (verdict, detail). The verdict is 'CAUGHT', 'GREEN' or
    'HARNESS-BROKEN', and HARNESS-BROKEN is never a pass in either
    direction: it means the instrument could not take a reading.
    """
    p = subprocess.run(["npx", "jest", TEST], cwd=W, capture_output=True, text=True)
    blob = p.stderr + p.stdout
    # 1. a suite that did not LOAD is not a result in either direction
    if "Test suite failed to run" in blob:
        why = re.search(
            r"(Cannot find module|SyntaxError|Unexpected token|ReferenceError|TypeError)[^\n]*", blob)
        return "HARNESS-BROKEN", f"a test suite failed to run: {why.group(0)[:160] if why else 'no cause printed'}"
    tests = re.search(r"^Tests:\s+(.*)$", blob, re.M)
    suites = re.search(r"^Test Suites:\s+(.*)$", blob, re.M)
    # 2. BOTH summary lines, or the harness did not run
    if not tests or not suites:
        tail = " / ".join(x.strip() for x in blob.strip().splitlines()[-3:])[:220]
        missing = "Tests" if not tests else "Test Suites"
        return "HARNESS-BROKEN", f"no jest '{missing}:' summary line (exit {p.returncode}): {tail}"
    tline, sline = tests.group(1).strip(), suites.group(1).strip()
    # 3. the expected number of suites ran, or part of the gate was not exercised
    stotal = re.search(r"(\d+) total", sline)
    if not stotal or int(stotal.group(1)) != EXPECTED_SUITES:
        return "HARNESS-BROKEN", f"Test Suites: {sline} (expected {EXPECTED_SUITES})"
    if re.search(r"\d+ (failed|skipped)", sline) and "failed" not in tline:
        return "HARNESS-BROKEN", f"Test Suites: {sline} with no failing test: {tline}"
    # 4. enough tests ran to be the gate this battery thinks it is measuring
    ran = re.search(r"(\d+) total", tline)
    if not ran or int(ran.group(1)) < MIN_TESTS:
        return "HARNESS-BROKEN", f"{tline} (below the floor of {MIN_TESTS} tests)"
    if re.search(r"\d+ failed", tline):
        return "CAUGHT", tline
    if re.search(r"\d+ passed", tline):
        return "GREEN", tline
    return "HARNESS-BROKEN", f"a results line this runner cannot read: {tline}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    args = ap.parse_args()

    # in /tmp, not in the worktree: a lock file is not a repository file
    lock_path = os.path.join(
        "/tmp", "battery-producedwater-%s.lock" % re.sub(r"\W+", "-", W.strip("/")))
    lock = open(lock_path, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print(f"REFUSES: another battery holds {lock_path}. Two batteries on one "
              f"worktree produced seven bogus greens on FC8. Run them serially.")
        sys.exit(3)

    cases = [c for c in json.load(open(CASES)) if c["id"].startswith(args.only)]
    bak = {p: open(p).read() for p in (ENG, ORA, GLD)}

    def restore():
        for q in bak:
            open(q, "w").write(bak[q])

    def restored():
        """The restore VERIFIED, not assumed: a failed restore contaminates
        every later plant instead of being noticed."""
        return all(open(q).read() == bak[q] for q in bak)

    rows = []
    try:
        for c in cases:
            restore()
            if not restored():
                rows.append((c["id"], c["label"], "HARNESS-BROKEN",
                             "the worktree did not restore to pristine BEFORE this plant"))
                continue
            missing = []
            notes = []
            if c.get("eng") and not plant(ENG, c["eng"][0], c["eng"][1]):
                missing.append("ENGINE PATTERN ABSENT")
            if c.get("ora") and not plant(ORA, c["ora"][0], c["ora"][1]):
                if c.get("oraOptional"):
                    notes.append("ORACLE LOCUS GONE")
                else:
                    missing.append("ORACLE PATTERN ABSENT")
            if missing:
                rows.append((c["id"], c["label"], "PATCH-FAILED", "; ".join(missing)))
                continue
            if c.get("regen"):
                r = subprocess.run(["python3", ORA], capture_output=True, text=True)
                if r.returncode != 0:
                    rows.append((c["id"], c["label"], "ORACLE-DIED", r.stderr.strip()[-160:]))
                    continue
            verdict, detail = run_suite()
            rows.append((c["id"], c["label"], verdict,
                         (detail + " | " + "; ".join(notes)) if notes else detail))
            restore()
            if not restored():
                rows.append((c["id"] + "!", c["label"], "HARNESS-BROKEN",
                             "the worktree did not restore AFTER this plant: every later plant is suspect"))
    finally:
        restore()
        subprocess.run(["python3", ORA], capture_output=True, text=True)
        fcntl.flock(lock, fcntl.LOCK_UN)

    print("%-5s %-70s %-13s %s" % ("id", "defect", "verdict", "jest"))
    for r in rows:
        print("%-5s %-70s %-13s %s" % r)
    green = [r for r in rows if r[2] == "GREEN"]
    broken = [r for r in rows if r[2] == "HARNESS-BROKEN"]
    unplantable = [r for r in rows if r[2] in ("PATCH-FAILED", "ORACLE-DIED")]
    caught = [r for r in rows if r[2] == "CAUGHT"]
    expect_refusal = {c["id"] for c in cases if c.get("expectNoResult")}
    unexpected_broken = [r for r in broken if r[0] not in expect_refusal]
    print("\n%d cases: %d CAUGHT, %d GREEN, %d HARNESS-BROKEN, %d unplantable"
          % (len(rows), len(caught), len(green), len(broken), len(unplantable)))
    for r in green:
        print("  GREEN, so the gate cannot see it: %s %s" % (r[0], r[1]))
    for r in broken:
        tag = "EXPECTED (the control on the runner)" if r[0] in expect_refusal else "UNEXPECTED"
        print("  HARNESS-BROKEN %s: %s %s -- %s" % (tag, r[0], r[1], r[3]))
    if broken:
        print("  A HARNESS-BROKEN plant is NOT a result in either direction.")
    print("  the worktree restored to pristine: %s" % ("yes" if restored() else "NO"))
    bad = len(green) + len(unexpected_broken) + len(unplantable)
    print("VERDICT: %s" % ("every plant caught" if bad == 0
                           else "%d case(s) this gate cannot honestly claim" % bad))
    sys.exit(0 if bad == 0 else 1)


if __name__ == "__main__":
    main()
