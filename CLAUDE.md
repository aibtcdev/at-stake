# At Stake — context for Claude Code

## What this is

A prediction market on one bit: **did these Bitcoin coins enter a Stacks
protocol bond before burn height H, or stay idle?**

- Chips are sBTC. The subject is native L1 BTC. They are unrelated.
- Complete-set design: 1 sat mints 1 IDLE + 1 BONDED share, mergeable back to
  1 sat before resolve, so the two prices sum to 1. That is where the "68c"
  number comes from.
- **There is no admin key and no oracle principal.** Do not add one. Status is
  settable by exactly two functions, both permissionless. If you find yourself
  adding an admin path to make a test pass, the test is wrong.

## Commands

```
npm install                   # needs npm >= 11; see toolchain gotchas
npm test                      # 58 tests, regenerates the sim build first
npx vitest run -- --costs     # cost numbers
```

## Build step, do not skip

`contracts/at-stake-sim.clar` is **generated** by `build-sim.sh`. Never edit it,
never deploy it, never commit it (it is gitignored). It makes exactly three
substitutions, and all three exist because simnet cannot do the real thing:

1. sBTC `SN3VMHXEN...` -> `SM3VDXK3...`. Same sBTC, mainnet address. Clarinet
   hardcodes that id as the one it auto-funds, so it is the only one that works.
2. pox-5 `ST000000000000000000002AMW42H.pox-5` -> `pox5-sim`, the same
   contract under our address so tests hold bond-admin. Not a mock.
3. `SIM-SKIP-HEADER`, bypassing the burn-header equality check.

It then appends `test-` seeders. `npm test` runs the build first. If you edit
`at-stake.clar` and tests do not change, you forgot.

## Toolchain gotchas that already cost time

- Clarinet moved **hirosystems → stx-labs**. Use `@stacks/clarinet-sdk` (3.23.x).
  `@hirosystems/clarinet-sdk` is stale at 3.8.1 and only reaches Clarity 4 /
  Epoch 3.3.
- **Real pox-5 IS visible in simnet** at `ST000000000000000000002AMW42H.pox-5`.
  It is an epoch-4.0 boot contract, so it needs no `[[project.requirements]]`
  entry and no deploy. Do not add one.
- Target **Clarity 6 / Epoch 4.0**. That is what pox-5 needs.
- Clarity 4 replaced `as-contract`. Asset movements out of the contract need
  explicit allowances, and `current-contract` replaces `(as-contract tx-sender)`:

```clarity
(as-contract?
  ((with-ft 'SM3...sbtc-token "sbtc-token" payout))
  (try! (contract-call? 'SM3...sbtc-token transfer payout current-contract who none)))
```

- **`npm install` needs npm >= 11.** npm 10.9.0 dies with `Cannot read
  properties of null (reading 'edgesOut')`, an arborist bug. Do NOT reach for
  `--legacy-peer-deps` -- it hides the crash and installs vitest 5 against an
  environment that peers only to `^4.0.0`. Use `npx npm@11 install`.
- vitest is pinned to 4.x because `vitest-environment-clarinet@3.0.2` does not
  support vitest 5 yet.
- Read-only calls do not report costs, so measuring a read-only needs a public
  wrapper. There is no `cost-probe.clar` in the tree right now; re-add one if
  you need to regenerate the cost table.
- sBTC needs no mock. `Clarinet.toml` names `SM3VDXK3...sbtc-deposit` in
  `[[project.requirements]]`, which makes Clarinet preload every wallet with
  the `sbtc_balance` from `settings/Devnet.toml`. Tests never mint.

## Contracts

| file | role | deployed? |
|---|---|---|
| `at-stake.clar` | market, escrow, both resolvers | yes |
| `btc-parse.clar` | Bitcoin tx parsing, P2WSH lockup checks | yes |
| `pox5-sim.clar` | the REAL pox-5, ours so we hold bond-admin | no, simnet only |
| `test-signer-manager.clar` | `signer-manager-trait` impl | no, simnet only |

Real pox-5 IS drivable in simnet: see `build-pox5-sim.sh`. grant-signer-key ->
register-signer -> setup-bond -> register-for-bond writes a genuine membership
row, and `resolve.test.js` uses exactly that.

What the deployed contract calls, and nothing else:

| dependency | id |
|---|---|
| sBTC | `SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token` |
| pox-5 | `ST000000000000000000002AMW42H.pox-5` |

`btc-parse.clar` has no external dependencies at all.

### No mocks

`resolve.test.js` drives real pox-5: grant-signer-key -> register-signer ->
setup-bond -> register-for-bond. The only reason `pox5-sim` is generated rather
than used as-is is the burn-header assert.

The only writer of `protocol-bond-memberships` in real pox-5 is
`register-for-bond`, which runs `verify-l1-lockups` -> `verify-block-header`:

```clarity
(match (get-burn-block-info? header-hash expected-block-height)
    bhh (is-eq bhh (reverse-buff32 (sha256 (sha256 headerbuff))))
    false
```

Same check as `tx-was-mined`, same simnet failure: synthetic burn blocks that
no real Bitcoin header hashes to. Registration is also allowlist-gated by the
bond admin and moves real sBTC via `roll-sbtc`. So real pox-5 returns `none`
forever unless that one assert is bypassed. `build-pox5-sim.sh` bypasses it and
nothing else. **Never let `pox5-sim` reach `at-stake.clar`.**

Clarity has no loops. All Bitcoin scanning is `fold` over a fixed index list
with a cursor in the accumulator, and a `done` flag instead of early exit.
`IDX` caps at 10, matching pox-5's own 10-output cap.

## The six checks in `resolve-bonded`

1. Open, inside the window
2. Lockup tx really in a Bitcoin block (SPV merkle against the burn header)
3. It spends coins committed at create time — **pox-5 does not do this**, and
   it is the only reason a market can be about a Bitcoin wallet
4. Coins landed in a P2WSH whose witness script embeds
   `sha256d(to-consensus-buff?(staker))` at a caller-stated offset, above threshold
5. pox-5 says that staker holds a live bond at this bond-index
6. `is-l1-lock` true. sBTC bonds resolve NO; v1 is native L1 only

Every one has a rejection test. Keep it that way.

## Known gaps, in priority order

1. ~~Lockup script template not pinned.~~ **Done.** `tests/template.test.js`
   pins `btc-parse` to pox-5's real `construct-lockup-script`. Commitment sits
   at byte offset 13.
2. **Header binding untested.** `get-burn-block-info?` returns synthetic burn
   blocks in simnet, so `SIM-SKIP-HEADER` bypasses the check that the supplied
   80 bytes hash to the burn block the chain agreed on. Only testable on testnet.
3. **sBTC contract id for testnet** must be confirmed or deploy fails static
   analysis. Prefer `clarinet requirements add
   SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-deposit`, which pulls the real
   contracts and auto-funds simnet wallets, replacing `mock-sbtc` entirely.
4. **Late resolution.** `get-bond-membership` returns none once a bond's unlock
   cycle is reached, and a rollover overwrites `bondIndex`. Set `close-height`
   to the bond start, not the registration cutoff: registration is blocked in
   the final 100-block prepare phase, so that gap is a free grace window.
5. **Snapshot timing is gameable.** `market-id = hash(script || bond-index)` but
   the snapshot is whatever the first creator saw. Either fix the snapshot to a
   stated burn height in the id, or print it on the page.
6. **No AMM.** Trading is OTC-only via `transfer-shares`.
7. **Early exit unwritten.** `announce-l1-early-exit` before close needs a
   written YES or NO in the market terms and a matching branch.

## Costs, already measured

Against a 5,000,000,000 runtime block limit: merkle 12-deep 44,557; 10-input
spend detection 828,466; 10-output extraction 1,205,416. A full resolve is
~0.042% of a block, so roughly 2,400 would fit in one. **The fully on-chain
resolver is affordable. Do not add a challenge-window fallback "for cost."**

These predate the current tree and cannot be regenerated until a cost-probe
contract is re-added.
