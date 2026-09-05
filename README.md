# At Stake

A prediction market on one bit: **did this wallet's Bitcoin enter a Stacks
protocol bond before burn height H, or did it stay idle?**

Chips are sBTC. The subject is native L1 BTC. Settlement reads Bitcoin.
There is no admin key and no oracle principal.

## Live on mainnet

```
SP5Y3W3F78NKFH4HYFNDQMJC484VZWKDH35ZR2M9.at-stake-v4
SP5Y3W3F78NKFH4HYFNDQMJC484VZWKDH35ZR2M9.btc-parse
```

Three earlier deploys remain on chain and should not be used:

| deploy | why not |
|---|---|
| `at-stake` (v1) | **inert** — compared the burn header in the wrong byte order, so it can verify no Bitcoin proof at all |
| `at-stake-v2` | a market can be opened on coins that already bonded |
| `at-stake-v3` | trading stays open past `close-height`, when the outcome is already certain |

Each hole is immutable once deployed, which is the whole reason for a v4. v4
adds the order layer on top of v3 and closes the deadline gap in both
`transfer-shares` and `fill-order`.

The full lifecycle has run end to end on mainnet against v2, and every function
except the YES resolver has run against v3:

| step | result |
|---|---|
| `create-market` | `(ok u1)` — snapshot proven at Bitcoin block 965,335 |
| `mint-complete-set` | `(ok u400)` — real sBTC escrowed |
| `transfer-shares` | `(ok u100)` |
| `merge-complete-set` | `(ok u100)` — sBTC returned 1:1 |
| `resolve-bonded` (on v2) | `(ok u1)` — six checks against real evidence |
| `redeem` (on v2) | `(ok u400)` — vault drained to zero |

The YES outcome was not arranged. A third party locked 5 BTC into pox-5 bond 1;
the market was built around their coins without their involvement, and the
contract verified it from a real block header, a merkle proof, and pox-5's own
membership record.

## Status

67 tests green on Clarity 6 / Epoch 4.0.

```
npm install     # needs npm >= 11, see Toolchain
npm test
```

### Proven

- Complete-set escrow: 1 sat of sBTC mints 1 IDLE + 1 BONDED share; the pair
  merges back to 1 sat any time before resolve, so the two prices sum to 1.
- `vault == idle-circ == bonded-circ` across every mint, merge and transfer.
- Contract solvency: it never pays out more sBTC than it holds.
- Status is settable by exactly two functions. No admin path exists.
- A Clarity SPV merkle verifier matching real Bitcoin tree math at every index,
  handling the odd-node duplication rule, working at 12-deep proofs.
- `btc-parse` pinned byte-for-byte against pox-5's own
  `construct-lockup-script`; the staker commitment sits at offset 13.
- Bitcoin transaction parsing checked against an independent serializer.

## How a market works

**Create** — anyone. Name a wallet, a deadline and a threshold, and prove on
chain that the wallet really holds coins. The creator gets no special rights
afterwards and is not betting.

**Trade** — 1 sat of sBTC mints one share of each side. Sell the side you do not
believe; that is the bet, and where a price comes from. A matched pair can
always be merged back to sBTC before settlement, so you are only exposed once
you sell one side.

**Settle** — two permissionless paths. `resolve-bonded` takes Bitcoin evidence
and proves YES. `resolve-idle` needs no evidence at all: the deadline passed.
Whoever settles gains nothing from it and cannot bias it.

**Redeem** — the winning side pays 1:1. The losing side is worth nothing.

### The six checks in `resolve-bonded`

1. Market is open and inside the window.
2. The lockup was mined **after the market opened**. A bond that predates the
   market is a lookup, not a prediction.
3. Both the lockup and the transaction that funded it are really in Bitcoin
   blocks (two SPV proofs).
4. The funding output pays this market's wallet, and the lockup spends it.
   **This is the step pox-5 does not do**, and the only reason a market can be
   about a Bitcoin wallet rather than a Stacks account.
5. The coins landed in a P2WSH whose witness script embeds
   `sha256d(to-consensus-buff?(staker))`, above the threshold.
6. pox-5 reports a live membership, native L1, of sufficient size.

Each has a test that it rejects the corresponding forgery.

There is deliberately **no bond-index check**. A staker holds one membership at
a time and a rollover rewrites the index, so pinning it rejected true outcomes
and gave the creator a lever that could only be used to rig.

## The bug mainnet caught

The first mainnet `create-market` aborted with `ERR_BAD_HEADER`:

```
bitcoin block hash        000000000000000000010684344616e48765a778c7380066ef0064c23d4edea8
sha256d(header)           a8de4e3dc26400ef660038c778a76587e4164634840601000000000000000000
reversed(sha256d(header)) 000000000000000000010684344616e48765a778c7380066ef0064c23d4edea8  ✓
```

`get-burn-block-info?` returns the hash in display order; `sha256d(header)` is
internal order. The comparison could never succeed on a real Bitcoin block, so
**both resolvers were dead** — no market could be created or settled.

All 58 tests passed throughout, because the simnet build compiles a
`SIM-SKIP-HEADER` constant that bypasses exactly that assert. Header binding was
listed as an untested gap; it was untested *and wrong*.

`tests/header.test.js` now pins the byte order against a real mainnet block with
no chain required. The general lesson: **wherever a harness skips a check, treat
the skipped code as broken until something proves otherwise.**

## Toolchain

Use `@stacks/clarinet-sdk` (3.23.x); `@hirosystems/clarinet-sdk` is stale at
3.8.1 and only reaches Clarity 4 / Epoch 3.3. This project targets **Clarity 6 /
Epoch 4.0**, which is what pox-5 needs, and `scripts/deploy/mainnet.mjs` states
it explicitly rather than relying on a default.

**`npm install` requires npm 11 or newer.** npm 10.9.0 crashes with
`Cannot read properties of null (reading 'edgesOut')`. `--legacy-peer-deps`
silences it but installs vitest 5 against an environment that peers only to
`^4.0.0`; use `npx npm@11 install` instead. vitest is pinned to 4.x for the same
reason.

## Layout

- `contracts/at-stake.clar` — the market, deployed as `at-stake-v4`
- `contracts/btc-parse.clar` — Bitcoin parsing and P2WSH lockup checks
- `contracts/pox5-sim.clar` — the real pox-5 under our own address, so tests
  hold bond-admin. Generated by `build-pox5-sim.sh`; simnet only.
- `build-sim.sh` — generates `at-stake-sim.clar`. Generated, never committed.
- `scripts/spv/` — build SPV proofs from a Bitcoin node or mempool.space
- `scripts/deploy/` — mainnet deploys with an explicit Clarity version

## Trading

`transfer-shares` moves shares and no money, so trading with a stranger means
one side going first and hoping. The order layer fixes that:

| function | what it does |
|---|---|
| `order-hash` | the digest a seller signs: contract, seller, market, side, amount, price, nonce, expiry |
| `fill-order` | settles a signed order — shares one way, sBTC the other, both or neither |
| `cancel-orders-below` | moves a per-seller nonce floor, revoking every older order in one call |
| `fill-price` | what a slice costs, rounded up |
| `order-filled` | how much of an order has gone |

The book itself stays off chain, which is how Polymarket works too: match in a
backend, settle on chain. The `fill` event carries the price, which is the only
way one reaches an indexer — the contract has no other notion of what anything
sold for.

Orders fill partially. Two guards come with that:

**Rounding favours the seller.** Floor division makes one share of a 1,000-share
order at 680 sats cost `680 * 1 / 1000 = 0`, so an order could be taken apart
for free a share at a time. `fill-price` rounds up.

**A fill must be at least 1% of the order**, or clear the remainder exactly.
Without a floor an order can be chewed away one share at a time, each nibble
costing a state write. The remainder exception stops order tails being stranded.

### Two bugs the audit caught here

The order hash originally left out the seller. It is both the thing signed and
the order's identity, and as an identity it was wrong: two sellers signing the
same terms produced the same hash and shared a fill counter, so filling one
marked the other spent.

`transfer-shares` and `fill-order` checked only that a market was OPEN, not that
it was inside its window. A market past `close-height` stays OPEN until somebody
calls `resolve-idle`, and in that gap the outcome is certain — buying off a
stale order there and resolving it yourself was free money. Fixed in v4. **The
deployed v3 still has it in `transfer-shares`** and cannot be patched, which is
why v4 was necessary rather than optional.

## Known gaps

1. **No AMM.** Trading is OTC via `transfer-shares`, which is the real reason
   there is no liquidity yet. Polymarket and Kalshi both use an order book
   rather than an AMM: because 1 YES + 1 NO = 1 sat, a buy order on one side
   mirrors into a sell on the other and doubles depth. That is the shape to
   copy, and it fits this contract better than a constant-product curve.
2. `close-height` is not tied to the bond's start, so a true L1 lock can become
   unprovable once the unlock cycle is reached.
3. The threshold is checked against one lockup output, while pox-5 sums up to
   ten. A split bond can satisfy pox-5 and fail check 5.
4. Losing shares stay in the circulating counts if their holder never redeems.
5. No early-exit branch for `announce-l1-early-exit`.
6. **No external audit.**
