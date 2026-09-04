#!/usr/bin/env bash
# Generates contracts/at-stake-devnet.clar from the deployable contract.
#
# ONE substitution, and only because the real sBTC cannot be minted on a
# devnet we operate (its protocol-mint is gated on a registry map that is
# empty at deploy and only a registered governance caller can write):
#
#   sBTC SM3VDXK3... -> .devnet-sbtc, and mainnet pox-5 -> the devnet boot
#   address (devnet uses testnet-style boot principals)
#
# Everything else is the deployed contract, byte for byte. In particular:
#   - pox-5 stays the real boot contract, at devnet's address
#   - the burn-header check is NOT bypassed; devnet has real Bitcoin headers
#
# contracts/at-stake-devnet.clar is generated. Never edit it.
set -e
sed -e "s|'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token|.devnet-sbtc|g" \
    -e "s|'SP000000000000000000002Q6VF78.pox-5|'ST000000000000000000002AMW42H.pox-5|g" \
  contracts/at-stake.clar > contracts/at-stake-devnet.clar
echo "built contracts/at-stake-devnet.clar"
