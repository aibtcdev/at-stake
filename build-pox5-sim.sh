#!/usr/bin/env bash
# Generates contracts/pox5-sim.clar from the pristine PoX-5 testnet source in
# vendor/pox-5.testnet.clar (fetched from ST000000000000000000002AMW42H.pox-5).
#
# This is the REAL contract, deployed under our own address so that we hold
# bond-admin and can drive the real bond lifecycle in tests. Three edits, all
# forced by simnet, none of which touch bond logic:
#
#   1. sBTC id -> SM3VDXK3..., the only sBTC clarinet auto-funds in simnet.
#   2. bond-admin -> the simnet deployer, so tests can call setup-bond.
#   3. SIM-SKIP-HEADER on the single burn-header assert (line ~2089). simnet
#      serves synthetic burn blocks that no real Bitcoin header hashes to.
#      The merkle proof below it still runs for real.
#
# Everything else -- cycles, allowlist, rollover, sBTC custody, membership
# bookkeeping -- is the untouched deployed contract.
#
# contracts/pox5-sim.clar is generated. Never edit it, never deploy it.
set -e
DEPLOYER='ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM'
sed -e "s|'SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token|'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token|g" \
    -e "s|(define-data-var bond-admin principal 'ST1V2ASRWGR81W7GBN1Z4W2JQKXJWCADPVZG30X45)|(define-data-var bond-admin principal '${DEPLOYER}) ;; SIMNET: we are the admin|" \
    -e "s|(asserts! (verify-block-header (get header lockup) (get height lockup))|(asserts! (or SIM-SKIP-HEADER (verify-block-header (get header lockup) (get height lockup)))|" \
    -e "s|^(define-trait signer-manager-trait (|(define-constant SIM-SKIP-HEADER true) ;; SIMNET ONLY\n(define-trait signer-manager-trait (|" \
  vendor/pox-5.testnet.clar > contracts/pox5-sim.clar
echo "built contracts/pox5-sim.clar"
