#!/bin/bash
# HARDENED PLANT RUNNER (FC8-0).
#
# Two defects were found in the runner this wave inherited, both of which
# INFLATE the apparent number of surviving plants:
#
#  1. IT SCORED A BROKEN HARNESS AS GREEN. `run()` piped jest through
#     `grep -E '^Tests:'`, and the caller then tested the captured text for
#     the word "failed". If a mutation made jest fail to produce a results
#     line at all, for instance a syntax error or a module that would not
#     load, the capture was EMPTY, the word "failed" was absent, and the
#     plant was scored GREEN. A plant that broke the harness looked exactly
#     like a plant the gate failed to catch.
#
#     This runner REFUSES such a run. No recognisable `Tests:` line is
#     HARNESS-BROKEN, reported by name, never scored.
#
#  2. TWO BATTERIES RACED IN ONE WORKTREE and produced bogus greens. This
#     runner therefore takes a LOCK on the worktree for the whole battery
#     and refuses to start if another battery holds it, and it VERIFIES THE
#     RESTORE after every plant, so a failed restore cannot contaminate the
#     next plant instead of being noticed.
#
# Every plant is run one at a time. Nothing here runs in parallel.
WT="${WT:-/root/wt-fc80-engines}"
cd "$WT" || exit 2
MET=engines/facilities/metering.js
CV=engines/facilities/controlValve.js
ST=engines/facilities/storageTank.js
OTM=tools/validation/facilities/oracle_tanksmetering.py
OCV=tools/validation/facilities/oracle_controlvalve.py
GTM=test-data/facilities/goldens/tanksmetering_cases.json
GCV=test-data/facilities/goldens/controlvalve_cases.json
BAK="$(mktemp -d)"
LOCK="$WT/.battery.lock"

if ! mkdir "$LOCK" 2>/dev/null; then
  echo "REFUSING TO START: another battery holds $LOCK. Two batteries in one worktree produce bogus greens." >&2
  exit 2
fi
cleanup(){ rmdir "$LOCK" 2>/dev/null; }
trap cleanup EXIT

for f in $MET $CV $ST $OTM $OCV $GTM $GCV; do
  mkdir -p "$BAK/$(dirname "$f")"; cp "$f" "$BAK/$f"
done
PRISTINE="$(cd "$BAK" && md5sum $MET $CV $ST $OTM $OCV $GTM $GCV | md5sum | cut -d' ' -f1)"

restore(){ for f in $MET $CV $ST $OTM $OCV $GTM $GCV; do cp "$BAK/$f" "$f"; done; }
verify_restore(){
  local now; now="$(md5sum $MET $CV $ST $OTM $OCV $GTM $GCV | md5sum | cut -d' ' -f1)"
  [ "$now" = "$PRISTINE" ]
}

HARNESS_BROKEN=0
GREENS=0
REDS=0

# The two suites this battery is measuring, and the number of tests they
# hold when nothing is planted. Both are checked on every run, because the
# THIRD defect found in this runner was that a plant which stopped one suite
# from LOADING left a clean `Tests:` line from the other one: a syntax error
# in storageTank.js printed "Tests: 38 passed, 38 total" from the control
# valve suite alone and was scored GREEN, while `Test Suites:` said
# "1 failed, 1 passed" two lines above. A runner that reads one summary line
# and not the other cannot tell a passing gate from half a gate.
EXPECTED_SUITES=2
SUITE_LIST="__tests__/facilities.tanksmetering.test.js __tests__/facilities.controlvalve.test.js"
# A floor rather than an exact count, so adding a test does not break the
# battery, but losing a whole suite's worth cannot pass unnoticed.
MIN_TESTS="${MIN_TESTS:-80}"

# Run the two suites and return a VERDICT: red, green, or broken.
run_verdict(){
  local out tests suites total
  out=$(npx jest $SUITE_LIST 2>&1)
  tests=$(printf '%s' "$out" | grep -E '^Tests:' | head -1)
  suites=$(printf '%s' "$out" | grep -E '^Test Suites:' | head -1)

  # 1. A SUITE THAT DID NOT LOAD is not a result in either direction.
  if printf '%s' "$out" | grep -q 'Test suite failed to run'; then
    VERDICT="broken"
    DETAIL=$(printf '%s' "$out" | grep -iE 'Cannot find module|SyntaxError|Unexpected token|ReferenceError|TypeError' | head -1)
    [ -z "$DETAIL" ] && DETAIL="a test suite failed to run"
    return
  fi
  # 2. NO SUMMARY AT ALL. The harness did not run.
  if [ -z "$tests" ] || [ -z "$suites" ]; then
    VERDICT="broken"
    DETAIL="jest produced no '${tests:+Test Suites}${tests:-Tests}:' summary line"
    return
  fi
  # 3. THE WRONG NUMBER OF SUITES RAN, so part of the gate was not exercised.
  total=$(printf '%s' "$suites" | sed -n 's/.*[^0-9]\([0-9]\+\) total.*/\1/p')
  if [ "$total" != "$EXPECTED_SUITES" ]; then
    VERDICT="broken"; DETAIL="$suites (expected $EXPECTED_SUITES suites)"; return
  fi
  if printf '%s' "$suites" | grep -qE '[0-9]+ (failed|skipped)'; then
    # A suite-level failure with no per-test failure is not a measurement.
    if ! printf '%s' "$tests" | grep -q 'failed'; then
      VERDICT="broken"; DETAIL="$suites with no failing test: $tests"; return
    fi
  fi
  # 4. TOO FEW TESTS RAN to be the gate this battery thinks it is measuring.
  local ran
  ran=$(printf '%s' "$tests" | sed -n 's/.*[^0-9]\([0-9]\+\) total.*/\1/p')
  if [ -z "$ran" ] || [ "$ran" -lt "$MIN_TESTS" ]; then
    VERDICT="broken"; DETAIL="$tests (below the floor of $MIN_TESTS tests)"; return
  fi
  DETAIL="$tests"
  if printf '%s' "$tests" | grep -q 'failed'; then VERDICT="red"; else VERDICT="green"; fi
}

# $1=label $2=file $3=sed-expr  [$4=oracle-file $5=oracle-sed-expr (shared plant)]
plant(){
  restore
  if ! verify_restore; then
    echo "HARNESS-BROKEN  $1   [the worktree did not restore to its pristine state before the plant]"
    HARNESS_BROKEN=$((HARNESS_BROKEN+1)); return
  fi
  local before after
  before=$(md5sum "$2" | cut -d' ' -f1)
  perl -0pi -e "$3" "$2"
  after=$(md5sum "$2" | cut -d' ' -f1)
  if [ "$before" = "$after" ]; then
    echo "PATCH-FAILED    $1   [the pattern did not match: the code this defect lived in is gone or has moved]"
    restore; return
  fi
  local shared=""
  if [ -n "$4" ]; then
    local ob oa
    ob=$(md5sum "$4" | cut -d' ' -f1)
    perl -0pi -e "$5" "$4"
    oa=$(md5sum "$4" | cut -d' ' -f1)
    if [ "$ob" = "$oa" ]; then echo "PATCH-FAILED    $1   [oracle pattern did not match]"; restore; return; fi
    if ! python3 "$4" >/dev/null 2>&1; then
      echo "HARNESS-BROKEN  $1   [the oracle would not run, so the golden was not regenerated]"
      HARNESS_BROKEN=$((HARNESS_BROKEN+1)); restore; return
    fi
    shared=" (shared)"
  fi
  run_verdict
  case "$VERDICT" in
    broken) echo "HARNESS-BROKEN  $1$shared   [$DETAIL]"; HARNESS_BROKEN=$((HARNESS_BROKEN+1)) ;;
    red)    echo "RED             $1$shared   [$DETAIL]"; REDS=$((REDS+1)) ;;
    green)  echo "GREEN           $1$shared   [$DETAIL]"; GREENS=$((GREENS+1)) ;;
  esac
  restore
  if ! verify_restore; then
    echo "HARNESS-BROKEN  $1   [the worktree did not restore AFTER the plant: every later plant is suspect]"
    HARNESS_BROKEN=$((HARNESS_BROKEN+1))
  fi
}

# oracle-only: patch the oracle, REGENERATE the golden, run the suites.
oplant(){
  restore
  local before after
  before=$(md5sum "$2" | cut -d' ' -f1)
  perl -0pi -e "$3" "$2"
  after=$(md5sum "$2" | cut -d' ' -f1)
  if [ "$before" = "$after" ]; then echo "PATCH-FAILED    $1   [pattern did not match]"; restore; return; fi
  if ! python3 "$2" >/dev/null 2>&1; then
    echo "HARNESS-BROKEN  $1   [the oracle would not run]"; HARNESS_BROKEN=$((HARNESS_BROKEN+1)); restore; return
  fi
  run_verdict
  case "$VERDICT" in
    broken) echo "HARNESS-BROKEN  $1   [$DETAIL]"; HARNESS_BROKEN=$((HARNESS_BROKEN+1)) ;;
    red)    echo "RED             $1   [$DETAIL]"; REDS=$((REDS+1)) ;;
    green)  echo "GREEN           $1   [$DETAIL]"; GREENS=$((GREENS+1)) ;;
  esac
  restore
}

totals(){
  echo "TOTALS: GREEN $GREENS  RED $REDS  HARNESS-BROKEN $HARNESS_BROKEN"
  if [ "$HARNESS_BROKEN" -gt 0 ]; then
    echo "A HARNESS-BROKEN plant is NOT a result. Re-express it against the current source and re-run it."
  fi
  restore
  verify_restore && echo "worktree restored to pristine" || echo "WARNING: the worktree did NOT restore"
}
