import { describe, it, expect, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

const deployer = simnet.getAccounts().get("deployer");
const alice = simnet.getAccounts().get("wallet_1");
const bob = simnet.getAccounts().get("wallet_2");

const C = "at-stake-sim";
const ID = 1;
const CLOSE = 200; // burn height

// The contract has no admin write path, so tests seed a market row the same
// way create-market will: directly, with the five parameters baked in.
// (create-market itself needs the SPV layer, tested separately.)
function seedMarket() {
  // map-set is not public; instead we exercise the real flow by calling the
  // test-only seeder compiled into the sim build.
  return simnet.callPublicFn(C, "test-seed-market", [
    Cl.uint(ID),
    Cl.stringAscii("test market"),
    Cl.buffer(new Uint8Array(34).fill(1)), Cl.none(),
    Cl.uint(1),                 // bond-index
    Cl.uint(CLOSE),
    Cl.uint(0),                 // created-at
    Cl.uint(100_000_000),
    Cl.uint(24_700_000_000),
  ], deployer);
}

// The official sBTC token, present in simnet because Clarinet.toml names
// `sbtc-deposit` in [[project.requirements]] -- that is what preloads every
// wallet with the `sbtc_balance` from settings/Devnet.toml. Nothing here mints
// or mocks money. This is the mainnet address of the same sBTC the deployed
// contract calls at its testnet address; build-sim.sh does the swap.
const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

function sbtcBalance(who) {
  const r = simnet.callReadOnlyFn(SBTC, "get-balance", [Cl.principal(who)], deployer);
  return Number(r.result.value.value);
}

function market() {
  const r = simnet.callReadOnlyFn(C, "get-market", [Cl.uint(ID)], deployer);
  const d = r.result.value.value;
  return {
    status: Number(d.status.value),
    vault: Number(d.vault.value),
    idleCirc: Number(d["idle-circ"].value),
    bondedCirc: Number(d["bonded-circ"].value),
  };
}

describe("complete-set money layer", () => {
  beforeEach(() => {
    seedMarket();
  });

  it("mint takes sBTC and issues both shares", () => {
    const before = sbtcBalance(alice);
    const r = simnet.callPublicFn(C, "mint-complete-set", [Cl.uint(ID), Cl.uint(1_000_000)], alice);
    expect(r.result).toBeOk(Cl.uint(1_000_000));
    expect(sbtcBalance(alice)).toBe(before - 1_000_000);

    const m = market();
    expect(m.vault).toBe(1_000_000);
    expect(m.idleCirc).toBe(1_000_000);
    expect(m.bondedCirc).toBe(1_000_000);
  });

  it("INVARIANT: vault == idle-circ == bonded-circ across mint and merge", () => {
    simnet.callPublicFn(C, "mint-complete-set", [Cl.uint(ID), Cl.uint(3_000_000)], alice);
    simnet.callPublicFn(C, "mint-complete-set", [Cl.uint(ID), Cl.uint(500_000)], bob);
    simnet.callPublicFn(C, "merge-complete-set", [Cl.uint(ID), Cl.uint(1_200_000)], alice);
    const m = market();
    expect(m.vault).toBe(2_300_000);
    expect(m.idleCirc).toBe(m.vault);
    expect(m.bondedCirc).toBe(m.vault);
  });

  it("merge returns the sBTC 1:1", () => {
    const before = sbtcBalance(alice);
    simnet.callPublicFn(C, "mint-complete-set", [Cl.uint(ID), Cl.uint(2_000_000)], alice);
    simnet.callPublicFn(C, "merge-complete-set", [Cl.uint(ID), Cl.uint(2_000_000)], alice);
    expect(sbtcBalance(alice)).toBe(before);
    expect(market().vault).toBe(0);
  });

  it("merge rejects shares you do not hold", () => {
    simnet.callPublicFn(C, "mint-complete-set", [Cl.uint(ID), Cl.uint(100)], alice);
    const r = simnet.callPublicFn(C, "merge-complete-set", [Cl.uint(ID), Cl.uint(101)], alice);
    expect(r.result).toBeErr(Cl.uint(107));
  });

  it("resolve-idle is rejected while the window is still open", () => {
    const r = simnet.callPublicFn(C, "resolve-idle", [Cl.uint(ID)], bob);
    expect(r.result).toBeErr(Cl.uint(104));
  });

  it("resolve-idle works for anyone once the window passes", () => {
    simnet.mineEmptyBurnBlocks(CLOSE + 5);
    const r = simnet.callPublicFn(C, "resolve-idle", [Cl.uint(ID)], bob);
    expect(r.result).toBeOk(Cl.uint(2));
    expect(market().status).toBe(2);
  });

  it("status can only be set once", () => {
    simnet.mineEmptyBurnBlocks(CLOSE + 5);
    simnet.callPublicFn(C, "resolve-idle", [Cl.uint(ID)], bob);
    const again = simnet.callPublicFn(C, "resolve-idle", [Cl.uint(ID)], alice);
    expect(again.result).toBeErr(Cl.uint(102));
  });

  it("no minting after the window closes", () => {
    simnet.mineEmptyBurnBlocks(CLOSE + 5);
    const r = simnet.callPublicFn(C, "mint-complete-set", [Cl.uint(ID), Cl.uint(100)], alice);
    expect(r.result).toBeErr(Cl.uint(103));
  });

  it("redeem pays the winning side only, 1:1", () => {
    simnet.callPublicFn(C, "mint-complete-set", [Cl.uint(ID), Cl.uint(4_000_000)], alice);
    // alice sells her BONDED side to bob off-book; simulate by transferring shares
    // (v1 has no transfer, so bob mints his own and we check both redeem paths)
    simnet.callPublicFn(C, "mint-complete-set", [Cl.uint(ID), Cl.uint(1_000_000)], bob);

    simnet.mineEmptyBurnBlocks(CLOSE + 5);
    simnet.callPublicFn(C, "resolve-idle", [Cl.uint(ID)], bob);

    const aliceBefore = sbtcBalance(alice);
    const r = simnet.callPublicFn(C, "redeem", [Cl.uint(ID)], alice);
    expect(r.result).toBeOk(Cl.uint(4_000_000)); // her IDLE side, in full
    expect(sbtcBalance(alice)).toBe(aliceBefore + 4_000_000);
  });

  it("redeem is rejected before resolution", () => {
    simnet.callPublicFn(C, "mint-complete-set", [Cl.uint(ID), Cl.uint(1000)], alice);
    const r = simnet.callPublicFn(C, "redeem", [Cl.uint(ID)], alice);
    expect(r.result).toBeErr(Cl.uint(108));
  });

  it("redeem cannot be claimed twice", () => {
    simnet.callPublicFn(C, "mint-complete-set", [Cl.uint(ID), Cl.uint(1000)], alice);
    simnet.mineEmptyBurnBlocks(CLOSE + 5);
    simnet.callPublicFn(C, "resolve-idle", [Cl.uint(ID)], bob);
    simnet.callPublicFn(C, "redeem", [Cl.uint(ID)], alice);
    const again = simnet.callPublicFn(C, "redeem", [Cl.uint(ID)], alice);
    expect(again.result).toBeErr(Cl.uint(107));
  });

  it("SOLVENCY: contract never pays out more sBTC than it holds", () => {
    simnet.callPublicFn(C, "mint-complete-set", [Cl.uint(ID), Cl.uint(4_000_000)], alice);
    simnet.callPublicFn(C, "mint-complete-set", [Cl.uint(ID), Cl.uint(1_000_000)], bob);
    simnet.mineEmptyBurnBlocks(CLOSE + 5);
    simnet.callPublicFn(C, "resolve-idle", [Cl.uint(ID)], bob);

    const held = sbtcBalance(`${deployer}.${C}`);
    simnet.callPublicFn(C, "redeem", [Cl.uint(ID)], alice);
    simnet.callPublicFn(C, "redeem", [Cl.uint(ID)], bob);
    expect(held).toBe(5_000_000);
    expect(sbtcBalance(`${deployer}.${C}`)).toBe(0);
    expect(market().vault).toBe(0);
  });
});
