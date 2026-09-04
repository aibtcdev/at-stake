import { describe, it, expect, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

const deployer = simnet.getAccounts().get("deployer");
const alice = simnet.getAccounts().get("wallet_1");
const bob = simnet.getAccounts().get("wallet_2");
const C = "at-stake-sim";
const ID = new Uint8Array(32).fill(9);
const CLOSE = 300;
const IDLE = 0, BONDED = 1;

// The official sBTC token, present in simnet because Clarinet.toml names
// `sbtc-deposit` in [[project.requirements]] -- that is what preloads every
// wallet with the `sbtc_balance` from settings/Devnet.toml. Nothing here mints
// or mocks money. This is the mainnet address of the same sBTC the deployed
// contract calls at its testnet address; build-sim.sh does the swap.
const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

const seed = () => simnet.callPublicFn(C, "test-seed-market", [
  Cl.buffer(ID), Cl.buffer(new Uint8Array(34).fill(1)), Cl.uint(0),
  Cl.uint(CLOSE), Cl.uint(100_000_000), Cl.uint(24_700_000_000)], deployer);
const mint = (w, n) => simnet.callPublicFn(C, "mint-complete-set", [Cl.buffer(ID), Cl.uint(n)], w);
const xfer = (w, side, n, to) => simnet.callPublicFn(C, "transfer-shares",
  [Cl.buffer(ID), Cl.uint(side), Cl.uint(n), Cl.principal(to)], w);
const pos = (w) => {
  const d = simnet.callReadOnlyFn(C, "get-position", [Cl.buffer(ID), Cl.principal(w)], deployer).result.value;
  return { idle: Number(d.idle.value), bonded: Number(d.bonded.value) };
};
const mkt = () => {
  const d = simnet.callReadOnlyFn(C, "get-market", [Cl.buffer(ID)], deployer).result.value.value;
  return { vault: Number(d.vault.value), idle: Number(d["idle-circ"].value), bonded: Number(d["bonded-circ"].value) };
};
const sbtc = (w) => Number(simnet.callReadOnlyFn(SBTC,"get-balance",[Cl.principal(w)],deployer).result.value.value);

describe("share transfer -- the thing that makes a price", () => {
  beforeEach(() => { seed(); });

  it("moves one side and leaves the other alone", () => {
    mint(alice, 1_000_000);
    expect(xfer(alice, BONDED, 400_000, bob).result).toBeOk(Cl.uint(400_000));
    expect(pos(alice)).toEqual({ idle: 1_000_000, bonded: 600_000 });
    expect(pos(bob)).toEqual({ idle: 0, bonded: 400_000 });
  });

  it("INVARIANT: a transfer does not change circulating supply", () => {
    mint(alice, 2_000_000);
    const before = mkt();
    xfer(alice, IDLE, 750_000, bob);
    xfer(alice, BONDED, 2_000_000, bob);
    expect(mkt()).toEqual(before);
  });

  it("rejects transferring more than you hold", () => {
    mint(alice, 100);
    expect(xfer(alice, IDLE, 101, bob).result).toBeErr(Cl.uint(107));
  });

  it("rejects an unknown side", () => {
    mint(alice, 100);
    expect(simnet.callPublicFn(C, "transfer-shares",
      [Cl.buffer(ID), Cl.uint(7), Cl.uint(10), Cl.principal(bob)], alice).result).toBeErr(Cl.uint(109));
  });

  it("rejects transfer to yourself", () => {
    mint(alice, 100);
    expect(xfer(alice, IDLE, 10, alice).result).toBeErr(Cl.uint(110));
  });

  it("rejects transfer after the market resolves", () => {
    mint(alice, 100);
    simnet.mineEmptyBurnBlocks(CLOSE + 5);
    simnet.callPublicFn(C, "resolve-idle", [Cl.buffer(ID)], bob);
    expect(xfer(alice, IDLE, 10, bob).result).toBeErr(Cl.uint(102));
  });

  it("THE 68c TRADE: alice sells her bonded side, keeps idle, and wins", () => {
    // Alice mints 1,000,000 sats of complete sets: 1M IDLE + 1M BONDED.
    mint(alice, 1_000_000);
    // She thinks the whale stays idle, so she sells all her BONDED to Bob.
    // Off-chain Bob pays her 320,000 sats for it -- the 32c side.
    xfer(alice, BONDED, 1_000_000, bob);
    expect(pos(alice)).toEqual({ idle: 1_000_000, bonded: 0 });
    expect(pos(bob)).toEqual({ idle: 0, bonded: 1_000_000 });

    // Window closes with no bond registered.
    simnet.mineEmptyBurnBlocks(CLOSE + 5);
    simnet.callPublicFn(C, "resolve-idle", [Cl.buffer(ID)], bob);

    const aBefore = sbtc(alice);
    expect(simnet.callPublicFn(C, "redeem", [Cl.buffer(ID)], alice).result).toBeOk(Cl.uint(1_000_000));
    expect(sbtc(alice)).toBe(aBefore + 1_000_000);
    // Alice: paid 1,000,000 to mint, received 320,000 from Bob, redeemed
    // 1,000,000. Net +320,000. Bob's bonded shares are worthless.
    expect(simnet.callPublicFn(C, "redeem", [Cl.buffer(ID)], bob).result).toBeErr(Cl.uint(107));
    expect(mkt().vault).toBe(0);
  });

  it("SOLVENCY survives transfers: contract drains to exactly zero", () => {
    mint(alice, 3_000_000);
    mint(bob, 2_000_000);
    xfer(alice, IDLE, 1_500_000, bob);
    xfer(bob, BONDED, 2_000_000, alice);
    expect(sbtc(`${deployer}.${C}`)).toBe(5_000_000);

    simnet.mineEmptyBurnBlocks(CLOSE + 5);
    simnet.callPublicFn(C, "resolve-idle", [Cl.buffer(ID)], bob);
    simnet.callPublicFn(C, "redeem", [Cl.buffer(ID)], alice);
    simnet.callPublicFn(C, "redeem", [Cl.buffer(ID)], bob);
    expect(sbtc(`${deployer}.${C}`)).toBe(0);
    expect(mkt().vault).toBe(0);
  });
});
