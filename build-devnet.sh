#!/usr/bin/env bash
# Generates contracts/at-stake-devnet.clar from the deployable contract.
#
# ONE substitution, and only because the real sBTC cannot be minted on a
# devnet we operate (its protocol-mint is gated on a registry map that is
# empty at deploy and only a registered governance caller can write):
#
#   sBTC SN3VMHXEN... -> .devnet-sbtc
#
# Everything else is the deployed contract, byte for byte. In particular:
#   - pox-5 stays ST000000000000000000002AMW42H.pox-5, the real boot contract
#   - the burn-header check is NOT bypassed; devnet has real Bitcoin headers
#
# contracts/at-stake-devnet.clar is generated. Never edit it.
set -e
sed -e "s|'SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token|.devnet-sbtc|g" \
  contracts/at-stake.clar > contracts/at-stake-devnet.clar
echo "built contracts/at-stake-devnet.clar"
