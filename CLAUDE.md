# At Stake — context for Claude Code

## What this is

A prediction market on one bit: **did this wallet's Bitcoin enter a Stacks
protocol bond before burn height H, or stay idle?**

- Chips are sBTC. The subject is native L1 BTC. They are unrelated.
- Complete-set design: 1 sat mints 1 IDLE + 1 BONDED share, mergeable back to
  1 sat before resolve, so the two prices sum to 1.
- **There is no admin key and no oracle principal.** Do not add one. Status is
  settable by exactly two functions, both permissionless. If you find yourself
  adding an admin path to make a test pass, the test is wrong.

## Deployed on mainnet

| contract | status |
|---|---|
| `SP5Y3W3F78NKFH4HYFNDQMJC484VZWKDH35ZR2M9.btc-parse` | current, unchanged since v1 |
| `SP5Y3W3F78NKFH4HYFNDQMJC484VZWKDH35ZR2M9.at-stake-v4` | **current** — adds the order layer, closes the deadline gap |
| `…at-stake-v3` | superseded: trading stays open past `close-height` |
| `…at-stake-v2` | superseded: front-running hole, one-UTXO linkage |
| `…at-stake` (v1) | **inert** — header byte order was wrong, verifies nothing |

The deployed contract calls only these, and nothing else:

| dependency | id |
|---|---|
| sBTC | `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token` |
| pox-5 | `SP000000000000000000002Q6VF78.pox-5` |

`btc-parse.clar` has no external dependencies at all.

## Commands

```
npm install                   # needs npm >= 11; see toolchain gotchas
npm test                      # 67 tests, regenerates the sim build first
node scripts/spv/mainnet-proof.mjs <txid> <vout>   # build an SPV proof
```

## Build step, do not skip

`contracts/at-stake-sim.clar` is **generated** by `build-sim.sh`. Never edit it,
never deploy it, never commit it (gitignored). Two substitutions, both forced by
simnet:

1. pox-5 -> `pox5-sim`, the same contract under our address so tests hold
   bond-admin. Not a mock; `build-pox5-sim.sh` changes three lines of the real
   thing.
2. `SIM-SKIP-HEADER`, bypassing the burn-header equality check.

sBTC needs no substitution: `at-stake.clar` targets mainnet sBTC, which is also
the id Clarinet auto-funds in simnet.

**The header bypass is why v1 shipped broken.** `build-sim.sh` patches that
assert by exact text match, so editing the line silently disables the bypass and
16 tests fail loudly. That is the intended behaviour — do not "fix" it by
loosening the match.

## Toolchain gotchas that already cost time

- Use `@stacks/clarinet-sdk` (3.23.x). `@hirosystems/clarinet-sdk` is stale at
  3.8.1 and only reaches Clarity 4 / Epoch 3.3.
- **Real pox-5 IS visible in simnet** at `ST000000000000000000002AMW42H.pox-5`
  (epoch-4.0 boot contract). No requirement entry, no deploy. Do not add one.
- Target **Clarity 6 / Epoch 4.0**, and pass it explicitly when deploying —
  see `scripts/deploy/mainnet.mjs`.
- Clarity 4 replaced `as-contract`. Moving assets out needs explicit allowances,
  and `current-contract` replaces `(as-contract tx-sender)`.
- **`npm install` needs npm >= 11.** npm 10.9.0 dies with `Cannot read
  properties of null (reading 'edgesOut')`. Do NOT use `--legacy-peer-deps`;
  it hides the crash and installs vitest 5 against an environment that peers
  only to `^4.0.0`. Use `npx npm@11 install`.
- vitest pinned to 4.x for the same reason.
- Bitcoin: pass the **non-witness** serialization. The txid is computed over it;
  the segwit encoding hashes to the wtxid and will never match a merkle proof.
  `scripts/spv/build-proof.mjs` strips it and asserts the result.
- Bitcoin reports hashes **reversed**. `get-burn-block-info?` returns display
  order; `sha256d(header)` is internal order. See below.

## Contracts

| file | role | deployed? |
|---|---|---|
| `at-stake.clar` | market, escrow, both resolvers | yes, as `at-stake-v4` |
| `btc-parse.clar` | Bitcoin tx parsing, P2WSH lockup checks | yes |
| `pox5-sim.clar` | the REAL pox-5, ours so we hold bond-admin | no, simnet only |
| `test-signer-manager.clar` | `signer-manager-trait` impl | no, simnet only |

`resolve.test.js` drives real pox-5: grant-signer-key -> register-signer ->
setup-bond -> register-for-bond writes a genuine membership row.

## The six checks in `resolve-bonded`

1. Open, inside the window
2. **The lockup was mined AFTER the market opened.** Without this a creator can
   open a market on coins already bonded, sell the IDLE side, and settle YES
   immediately. That is a lookup, not a prediction.
3. Both the lockup and its funding transaction are on Bitcoin (two SPV proofs)
4. The funding output pays this market's script, and the lockup spends it —
   **pox-5 does not check this**, and it is the only reason a market can be
   about a Bitcoin wallet
5. Coins landed in a P2WSH whose witness script embeds
   `sha256d(to-consensus-buff?(staker))` at a caller-stated offset, above threshold
6. pox-5 reports a live membership with `is-l1-lock` and enough sats

Every one has a rejection test. Keep it that way.

**There is deliberately no bond-index check.** A staker holds one membership at
a time and a rollover rewrites the index, so pinning it broke true outcomes and
handed the creator a lever that could only be used to rig.

## What mainnet taught us

**The header byte-order bug.** `get-burn-block-info?` returns display order,
`sha256d(header)` is internal order. v1 compared them directly, so it could
never verify a Bitcoin block — `create-market` and `resolve-bonded` were both
dead. All 58 tests passed throughout, because `SIM-SKIP-HEADER` bypasses exactly
that assert. Found by the first real mainnet transaction, `ERR_BAD_HEADER`.

`tests/header.test.js` now pins it against a real mainnet block with no chain
required. **Wherever a harness skips a check, treat the skipped code as broken
until something proves otherwise.**

**The front-running hole.** v2 accepted a lockup from any past block, so the
first market we ever settled YES was one whose answer already existed. Fixed by
`created-at` in v3.

## The order layer

`fill-order` settles a signed off-chain order atomically. Things that are easy
to get wrong and were:

- **The hash must include the seller.** It is the order's identity as well as
  the thing signed. Without the seller, two people signing identical terms share
  a fill counter and one kills the other.
- **The hash must include the contract.** Otherwise a signature is valid on any
  fork carrying the same function.
- **`fill-price` rounds up.** Floor division makes a 1-share fill of a
  1000-share order cost zero, so it can be drained a share at a time.
- **Trading must stop at `close-height`, not merely at resolution.** A market
  past its deadline is still OPEN until somebody calls `resolve-idle`, and the
  outcome in that gap is already certain.

The deployed v3 lacks that last check in `transfer-shares` and cannot be fixed.
That is what v4 exists for.

## Known gaps, in priority order

1. ~~**No AMM.**~~ Being addressed by the order layer above, off-chain book plus
   on-chain settlement. An AMM is still the wrong shape: LPs get run over as one
   side goes to zero near resolution, which is why Polymarket and Kalshi both
   use order books.
2. **`close-height` is not tied to the bond's start.** `get-bond-membership`
   returns none once the unlock cycle is reached, so a true L1 lock can become
   unprovable before anyone settles.
3. **The threshold is checked against one output, pox-5 sums up to ten.** A bond
   split across outputs can satisfy pox-5 and fail check 5.
4. **Losing shares never leave `idle-circ`/`bonded-circ`** if the holder never
   redeems. Accounting dust, no fund risk.
5. **`transfer-shares` accepts contract principals** that may never redeem.
6. **No early-exit branch** for `announce-l1-early-exit`.
7. **No external audit.**

## Costs

Measured 5 Sep 2026 against a 5e9 runtime block limit, `vitest run -- --costs`.

| call | runtime | % of a block |
|---|---|---|
| `resolve-bonded` (full YES) | 1,310,207 | 0.026% |
| `tx-spends-outpoint`, 50 inputs | 4,036,683 | 0.081% |
| `tx-spends-outpoint`, 1 input | 188,145 | 0.004% |
| `create-market` | 843,212 | 0.017% |
| `add-snapshot` | 709,155 | 0.014% |
| `fill-order` | 54,291 | 0.001% |
| mint / merge / redeem | ~44,000 | 0.001% |

3,816 full resolves fit in one block. Worst read count is 53 against a 15,000
limit; worst write count is 4.

Delegating to the builtins and pox-5 made a resolve cheaper than the hand-rolled
v2 (0.042%) despite a 4x larger transaction buffer. Dropping the funding SPV
proof took another 674,000 off: once the outpoint has to be in `snapshots`, and
every entry there was proven when committed, re-proving it at settle time
verifies nothing.

`MAX_INPUTS` is a real cost lever, not a free ceiling: `fold` walks the whole
index list whatever the transaction holds, so each unused slot costs ~3,000.
Raising 24 -> 50 took a one-input check from 110,453 to 188,145. Rejection past
the cap is cheap (53,628) because it happens before the fold.
