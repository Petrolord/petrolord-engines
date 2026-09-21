# FC8-0 re-run: the ten plants whose code MOVED in the repair, re-expressed
# against the repaired source so the measurement stays honest. PATCH-FAILED
# in the original battery means the defect is unplantable, not that it is
# caught, so every one of these is either adapted here or recorded as
# removed with the code it lived in.
source "$(dirname "${BASH_SOURCE[0]}")/plant.sh"
M=engines/facilities/metering.js
C=engines/facilities/controlValve.js
S=engines/facilities/storageTank.js

echo "######## FC8-0 ADAPTED (engine only) ########"
plant "orifice: inH2O 0.0361273 -> 0.0360 (now a named constant)"  $M 's/const INH2O_TO_PSI = 0\.0361273;/const INH2O_TO_PSI = 0.0360;/'
plant "transmitter: flow-turndown warn 3 -> 30"                    $M 's/flowTurndown > 3\n      \? /flowTurndown > 30\n      ? /'
plant "transmitter: flowTurndown = sqrt -> identity"               $M 's/const flowTurndown = Math\.sqrt\(differentialTurndown\);/const flowTurndown = differentialTurndown;/'
plant "uncertainty: ignore the transmitter, keep the typed dP"      $M 's/    dpPct = transmitter\.uncertaintyPctOfReading;/    dpPct = dpUncertaintyPct;/'
plant "straightRun: withheld column answered again"                $M "s/  if \(STRAIGHT_RUN_WITHHELD_FITTINGS\[upstreamFitting\]\) \{/  if (false) {/"
plant "straightRun: answer above the table again (beta 0.95)"      $M 's/  if \(beta > tableMaxBeta\) \{/  if (false) {/'
plant "sizeOrifice: swallow EVERY error guard (a bore beside an error)" $M 's/  if \(hiR\.error\) return \{ error: hiR\.error \};/  if (false) return { error: hiR.error };/; s/  if \(loR\.error\) return \{ error: loR\.error \};/  if (false) return { error: loR.error };/; s/    if \(r\.error\) return \{ error: r\.error \};/    if (false) return { error: r.error };/; s/  if \(flow\.error\) return \{ error: flow\.error \};/  if (false) return { error: flow.error };/'
plant "liquid: sigma thresholds 2\/3 -> 1\/1.5"                      $C 's/SIGMA_THRESHOLDS = \{ cavitating: 2, incipient: 3 \}/SIGMA_THRESHOLDS = { cavitating: 1, incipient: 1.5 }/'
plant "liquid: sigma on dpStated again"                            $C 's/const sigma = \(p1Psia - pvPsia\) \/ dpUsed;/const sigma = (p1Psia - pvPsia) \/ dpStated;/'
plant "liquid: accept a missing vapour pressure again"             $C 's/  if \(!\(pvPsia > 0\)\) \{/  if (false) {/'
plant "noise: bands 2\/4\/10 -> 3\/8\/20"                             $C 's/NOISE_RATIO_BANDS = \{ moderate: 2, high: 4, severe: 10 \}/NOISE_RATIO_BANDS = { moderate: 3, high: 8, severe: 20 }/'
plant "noise: power thresholds 1\/1000 -> 1e-9\/1e9 (band blind again)" $C 's/NOISE_POWER_BANDS = \{ quietKw: 1, loudKw: 1000 \}/NOISE_POWER_BANDS = { quietKw: 1e-9, loudKw: 1e9 }/'
plant "noise: 379.49 -> 380 (now checked in SI)"                   $C 's/qScfh \/ 379\.49/qScfh \/ 380/'
plant "noise: drop ln(ratio) from the power"                       $C 's/\* Math\.log\(ratio\) \/ 1000;/\/ 1000;/'
plant "travel: pass over zero checks again"                        $C 's/    pass: checksSkipped\.length === 0 \? warnings\.length === 0 : null,/    pass: warnings.length === 0,/'
plant "travel: beyond the valve and not given merged again"        $C "s/return \\{ state: .not given., travel: null \\};\\n    if/return { state: 'beyond the valve', travel: null };\\n    if/"
plant "thermal: 1 scfh\/bbl -> 0.5 (now a named parameter)"         $S 's/scfhPerBbl = 1\.0,/scfhPerBbl = 0.5,/'
plant "thermal: low-vol 0.6 -> 0.9 (now a named parameter)"        $S 's/lowVolatilityOutFactor = 0\.6,/lowVolatilityOutFactor = 0.9,/'
plant "thermal: insulation credit 0.25 -> 0.05"                    $S 's/insulationCredit = 0\.25,/insulationCredit = 0.05,/'
plant "AP42: days 365 -> 300"                                     $S 's/const standingLbYr = 365 \\*/const standingLbYr = 300 */'
plant "tank: accept a TVP at or above atmospheric again"           $S 's/  if \(vapourPressurePsia >= atmosphericPsia\) \{/  if (false) {/'
plant "tank: accept a negative fill again"                         $S 's/  if \(Number\.isFinite\(fillHeightFt\) && fillHeightFt < 0\) \{/  if (false) {/'
plant "movement: drop the error path again"                        $S 's/  if \(!\(fillBblPerHr >= 0\) \|\| !\(drawBblPerHr >= 0\)\) \{/  if (false) {/'
plant "normalVent: two predicates for the governing case again"    $S 's/  const vacuumGoverns = inn >= out;/  const vacuumGoverns = inn > out;/'
plant "fire: offer a vent number again (a guessed conversion)"     $S 's/    ventScfhAir: null,/    ventScfhAir: (1107 * qBtuHr) \/ 130,/'
plant "fire: environment factor unbounded again"                   $S 's/  if \(!\(environmentFactor > 0\) \|\| environmentFactor > 1\) \{/  if (false) {/'
plant "fire: band edges broken (199300 A^0.566 -> A^0.500)"        $S 's/199300 \* wettedFt2 \*\* 0\.566/199300 * wettedFt2 ** 0.500/'
plant "shell: minimum plate 0.1875 -> 0.3125"                      $S 's/minimumThicknessIn = 0\.1875/minimumThicknessIn = 0.3125/'
plant "shell: minimum-plate crossover reported as course 1"        $S 's/    firstMinimumGovernedCourse: firstMin,/    firstMinimumGovernedCourse: 1,/'
plant "shell: water-test crossover reported as the last course"    $S 's/    lastTestGovernedCourse: lastTest,/    lastTestGovernedCourse: n,/'
plant "lossControl: swallow a missing efficiency again"            $S 's/  if \(!Number\.isFinite\(controlEfficiencyPct\)\) \{/  if (false) {/'
totals
