# THE CONTROL ON THE CONTROLS, FC8-0. A defect planted in the ORACLE ALONE,
# with the golden regenerated, must go RED: that is what proves the harness
# can tell the two files apart and that the oracle is doing work. Two of the
# original six no longer patch because the oracle was rewritten, and they are
# re-expressed here against the new routes.
source /root/fc-wip-metering/scratch/plant.sh
OTM=tools/validation/facilities/oracle_tanksmetering.py
OCV=tools/validation/facilities/oracle_controlvalve.py
oplant(){ restore; perl -0pi -e "$3" "$2" || return
  python3 "$2" >/dev/null 2>&1 || { echo "ORACLE-RUN-FAILED $1"; restore; return; }
  local out=$(run)
  if echo "$out" | grep -q failed; then echo "RED    $1   [$out]"; else echo "GREEN  $1   [$out]"; fi
  restore; }
echo "######## ORACLE ONLY, golden regenerated (control on the controls) ########"
oplant "oracle only: RG 0.5961 -> 0.6100"        $OTM 's/Decimal\("0\.5961"\)/Decimal("0.6100")/'
oplant "oracle only: FF 0.96 -> 0.98"            $OCV 's/return 0\.96 - 0\.28/return 0.98 - 0.28/'
oplant "oracle only: SI shell rho 1000 -> 900"   $OTM 's/rho = 1000\.0 \* sg/rho = 900.0 * sg/'
oplant "oracle only: MC seed 99 -> 7"            $OTM 's/n=200000, seed=99/n=200000, seed=7/'
oplant "oracle only: MC samples 200k -> 2k"      $OTM 's/n=200000, seed=99/n=2000, seed=99/'
oplant "oracle only: Kv per Cv 0.865 -> 0.9"     $OCV 's/KV_PER_CV = 0\.865/KV_PER_CV = 0.9/'
oplant "oracle only: SI gas constant 8.3145 -> 8.0" $OTM 's/R_SI = 8\.314462618/R_SI = 8.0/'
oplant "oracle only: SI gas constant 8.3145 -> 8.0 (valve)" $OCV 's/R_SI = 8\.314462618/R_SI = 8.0/'
oplant "oracle only: fire band 199300 -> 250000"  $OTM 's/k, n = 199300\.0, 0\.566/k, n = 250000.0, 0.566/'
oplant "oracle only: fire exponent 0.566 -> 0.500" $OTM 's/k, n = 199300\.0, 0\.566/k, n = 199300.0, 0.500/'
oplant "oracle only: SI barrel 0.158987 -> 0.16" $OTM 's/BBL_TO_M3 = 0\.158987294928/BBL_TO_M3 = 0.16/'
