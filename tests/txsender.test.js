import { describe, it, expect } from "vitest";
import { Cl } from "@stacks/transactions";

// SWC-115 in Clarity: tx-sender is the ORIGIN of the call chain, not the
// immediate caller. A contract that authorises on tx-sender can be driven by
// any other contract the victim happens to call.
//
// Post-conditions do not help here. They guard token movements, and
// transfer-shares moves map entries -- no fungible token leaves the wallet, so
// there is nothing for a post-condition to catch.

const C = "at-stake-sim";
const deployer = simnet.getAccounts().get("deployer");
const victim = simnet.getAccounts().get("wallet_1");
const thief = simnet.getAccounts().get("wallet_2");
const ID = 1, CLOSE = 100000;

const seed = () => simnet.callPublicFn(C, "test-seed-market", [
  Cl.uint(ID), Cl.stringAscii("t"), Cl.buffer(new Uint8Array(34).fill(1)), Cl.none(),
  Cl.uint(1), Cl.uint(CLOSE), Cl.uint(0), Cl.uint(10_000), Cl.uint(150_000)], deployer);

const pos = (w) => {
  const d = simnet.callReadOnlyFn(C, "get-position",
    [Cl.uint(ID), Cl.principal(w)], deployer).result.value;
  return { idle: Number(d.idle.value), bonded: Number(d.bonded.value) };
};

describe("authorisation through an intermediate contract", () => {
  it("a hostile contract cannot move a victim's shares", () => {
    seed();
    simnet.callPublicFn(C, "mint-complete-set", [Cl.uint(ID), Cl.uint(1000)], victim);
    expect(pos(victim).bonded).toBe(1000);

    // The victim calls the attacker's contract and never touches at-stake.
    simnet.callPublicFn("test-hostile-relay", "steal",
      [Cl.uint(ID), Cl.uint(1), Cl.uint(1000), Cl.principal(thief)], victim);

    expect(pos(thief).bonded, "the thief must not end up holding them").toBe(0);
    expect(pos(victim).bonded, "the victim must keep their shares").toBe(1000);
  });

  it("a hostile contract cannot cancel a victim's outstanding orders", () => {
    seed();
    simnet.callPublicFn("test-hostile-relay", "grief-cancel", [Cl.uint(9)], victim);
    const floor = simnet.callReadOnlyFn(C, "get-order-floor",
      [Cl.principal(victim)], deployer).result;
    expect(Number(floor.value), "the victim's nonce floor must not move").toBe(0);
  });
});
