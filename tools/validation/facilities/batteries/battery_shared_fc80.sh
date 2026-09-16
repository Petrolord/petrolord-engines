# FC8-0 re-run of the SHARED battery: a defect planted in the engine AND its
# oracle, with the golden regenerated. Eight of thirteen used to survive this,
# because a golden regenerated from a changed oracle agrees with a changed
# engine. Four of the original thirteen no longer patch, because the oracle was
# rewritten; they are re-expressed here, and one of them is now IMPOSSIBLE to
# plant in both files at all, which is the repair working.
source /root/fc-wip-metering/scratch/plant.sh
M=engines/facilities/metering.js
C=engines/facilities/controlValve.js
S=engines/facilities/storageTank.js
OTM=tools/validation/facilities/oracle_tanksmetering.py
OCV=tools/validation/facilities/oracle_controlvalve.py

echo "######## FC8-0 ADAPTED SHARED (engine AND oracle, golden regenerated) ########"
plant "RG 0.5961 -> 0.6100 in BOTH"        $M 's/0\.5961/0.6100/'  $OTM 's/Decimal\("0\.5961"\)/Decimal("0.6100")/'
plant "RG -0.216 b^8 -> -0.300 in BOTH"    $M 's/0\.216 \* b \*\* 8/0.300 * b ** 8/'  $OTM 's/Decimal\("0\.216"\) \* _dpow\(b, 8\)/Decimal("0.300") * _dpow(b, 8)/'
plant "RG small-bore 2.8 -> 4.0 in BOTH"   $M 's/\(2\.8 - D \/ 25\.4\)/(4.0 - D \/ 25.4)/'  $OTM 's/Decimal\("2\.8"\) - d_mm \/ Decimal\("25\.4"\)/Decimal("4.0") - d_mm \/ Decimal("25.4")/'
plant "AP42 Ks 0.053 -> 0.030 in BOTH"     $S 's/1 \+ 0\.053 \* vapourPressurePsia/1 + 0.030 * vapourPressurePsia/'  $OTM 's/ks_coeff_si = 0\.053 \//ks_coeff_si = 0.030 \//'
plant "AP42 365 -> 300 days in BOTH"       $S 's/const standingLbYr = 365 \*/const standingLbYr = 300 */'  $OTM 's/days_per_year=365/days_per_year=300/'
plant "barrel 42 -> 55 gal in BOTH"        $S 's/const FT3_PER_BBL = \(42 \* 231\) \/ 1728;/const FT3_PER_BBL = (55 * 231) \/ 1728;/'  $OTM 's/BBL_TO_M3 = 0\.158987294928/BBL_TO_M3 = 0.20819311217142857/'
plant "fire 199300 A^0.566 -> A^0.500 in BOTH" $S 's/199300 \* wettedFt2 \*\* 0\.566/199300 * wettedFt2 ** 0.500/'  $OTM 's/k, n = 199300\.0, 0\.566/k, n = 199300.0, 0.500/'
plant "liquid Cv sqrt grouping in BOTH"    $C 's/Math\.sqrt\(sg \/ dpUsed\)/Math.sqrt(sg) \/ Math.sqrt(dpUsed) * 1.02/'  $OCV 's/cv = dq \/ dp_used\.sqrt\(\) \* dsg\.sqrt\(\)/cv = dq \/ dp_used.sqrt() * dsg.sqrt() * Decimal("1.02")/'
