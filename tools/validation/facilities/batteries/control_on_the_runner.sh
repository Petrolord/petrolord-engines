#!/bin/bash
# THE CONTROL ON THE RUNNER.
#
# A planting battery is a measuring instrument, and this one was found to
# have three defects that all pushed its reading THE SAME WAY: they inflated
# the number of plants that appeared to survive. A plant that broke the
# harness was indistinguishable from a plant the gate failed to catch.
#
#  1. No `Tests:` line at all was read as "no failures" and scored GREEN.
#  2. Two batteries in one worktree raced and produced bogus greens.
#  3. THE ONE THIS SCRIPT EXISTS FOR. A plant that stopped one suite from
#     LOADING left a clean `Tests:` line from the other suite: a syntax
#     error in storageTank.js printed "Tests: 38 passed, 38 total" from the
#     control valve suite alone and scored GREEN, while `Test Suites:` said
#     "1 failed, 1 passed" two lines above it. A runner that reads one
#     summary line and not the other cannot tell a passing gate from half a
#     gate.
#
# So the runner is itself gated. Both plants below MUST report
# HARNESS-BROKEN or RED and NEITHER may report GREEN. Run this before
# trusting any number a battery gives you.
source "$(dirname "${BASH_SOURCE[0]}")/plant.sh"
S=engines/facilities/storageTank.js
M=engines/facilities/metering.js
echo "######## CONTROL ON THE RUNNER ITSELF ########"
plant "a syntax error in one module (one suite cannot load)"    $S 's/export const tankCapacity = /export const tankCapacity = = /'
plant "a syntax error in the other module"                      $M 's/export const dischargeCoefficient = /export const dischargeCoefficient = = /'
plant "a deleted export (the import fails, tests fail)"         $S 's/export const fireVenting = /const fireVenting_removed = /'
totals
echo
echo "PASS only if GREEN is 0 above. A GREEN here means the runner is scoring"
echo "a broken harness as a surviving plant, and every battery number taken"
echo "with it is an over-count."
