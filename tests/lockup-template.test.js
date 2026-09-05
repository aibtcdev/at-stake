import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { Cl } from "@stacks/transactions";

// ---------------------------------------------------------------------------
// THESE TESTS FAIL against btc-parse as deployed. That is the point.
//
// `verify-lockup` checks three things: the output is a P2WSH of the supplied
// witness script, the value clears the threshold, and 32 bytes at an offset
// THE CALLER CHOOSES equal sha256d(to-consensus-buff? staker).
//
// It never checks that the script is a pox-5 lockup. No OP_IF, no CLTV, no
// 0xb167, no 0x82012088a820. Any P2WSH carrying the commitment anywhere passes,
// which means resolve-bonded can be satisfied without anyone locking anything.
// Reproduced against mainnet btc-parse on 5 Sep 2026: a bare
// `OP_DROP <pubkey> OP_CHECKSIG` script returned (ok true).
//
// The fix moves the check to at-stake, which already imports pox-5: rebuild the
// script with pox-5's own `construct-lockup-script` and compare the P2WSH byte
// for byte. btc-parse stays dependency-free and keeps only the pure helpers.
// `commitment-offset` disappears from the signature entirely -- there is no
// caller-supplied position left to lie about.
// ---------------------------------------------------------------------------

const POX = "pox5-sim", P = "btc-parse";
const sha256 = (b) => createHash("sha256").update(b).digest();
const hexb = (h) => Buffer.from(String(h).replace(/^0x/, ""), "hex");

// pox-5 derives the unlock height from the bond's period; a lockup naming a
// different one belongs to a different bond window.
const PERIOD_UNLOCK_HEIGHT = 800_000;
const OTHER_UNLOCK_HEIGHT = 900_000;
const STAKER_UNLOCK = new Uint8Array([0x51]); // OP_1
const EARLY_UNLOCK = new Uint8Array([0x51]);

const deployer = simnet.getAccounts().get("deployer");
const staker = simnet.getAccounts().get("wallet_1");
const stranger = simnet.getAccounts().get("wallet_2");

/** A genuine pox-5 lockup, built by pox-5 itself. */
function poxLockup(who, unlockHeight = PERIOD_UNLOCK_HEIGHT) {
  const args = [Cl.principal(who), Cl.uint(unlockHeight),
                Cl.buffer(STAKER_UNLOCK), Cl.buffer(EARLY_UNLOCK)];
  const witness = simnet.callReadOnlyFn(POX, "construct-lockup-script", args, deployer)
    .result.value.value;
  const spk = simnet.callReadOnlyFn(POX, "construct-lockup-output-script", args, deployer)
    .result.value.value;
  return { witness: hexb(witness), spk: hexb(spk) };
}

function commitmentFor(who) {
  return hexb(simnet.callReadOnlyFn(P, "staker-commitment", [Cl.principal(who)], deployer)
    .result.value.value);
}

/**
 * A script pox-5 would never emit, carrying someone else's commitment.
 *
 *   PUSH32 <commitment> OP_DROP PUSH33 <pubkey> OP_CHECKSIG
 *
 * No OP_IF, no timelock, no early-exit branch. Spendable by the forger the
 * moment it confirms -- the coins are never actually locked.
 */
function forgedLockup(who) {
  const witness = Buffer.concat([
    Buffer.from([0x20]), commitmentFor(who), Buffer.from([0x75]),
    Buffer.from([0x21]), Buffer.alloc(33, 0x02), Buffer.from([0xac]),
  ]);
  return { witness, spk: Buffer.concat([Buffer.from([0x00, 0x20]), sha256(witness)]) };
}

/** Current (v4) signature. */
function verifyV4({ spk, witness }, who, offset, value = 500_000_000, min = 100_000) {
  return simnet.callReadOnlyFn(P, "verify-lockup",
    [Cl.buffer(spk), Cl.uint(value), Cl.buffer(witness),
     Cl.principal(who), Cl.uint(offset), Cl.uint(min)], deployer).result;
}

describe("the lockup output is a real pox-5 lockup", () => {
  it("accepts pox-5's own script for the staker it names", () => {
    expect(verifyV4(poxLockup(staker), staker, 13)).toBeOk(Cl.bool(true));
  });

  it("rejects a pox-5 script bound to a different staker", () => {
    expect(verifyV4(poxLockup(staker), stranger, 13).type).toBe("err");
  });

  // ---- FAILS on v4: this is the defect -------------------------------------
  it("rejects a forged script that merely carries the commitment", () => {
    // The forger controls the subject wallet and names any staker holding a
    // live bond above the threshold. Those stakers are public. The coins go
    // into a P2WSH the forger can sweep next block, and YES settles anyway.
    const forged = forgedLockup(staker);
    expect(
      verifyV4(forged, staker, 1).type,
      "a script with no OP_IF and no CLTV must not verify as a lockup",
    ).toBe("err");
  });

  // ---- FAILS on v4: the offset is caller-supplied ---------------------------
  it("does not let the caller state where the commitment sits", () => {
    // Every position in the template is fixed once the unlock height is known.
    // Accepting an offset is what lets a forgery place the commitment anywhere.
    const args = simnet.getFunctionsInterfaces
      ? simnet.getFunctionsInterfaces(P)
      : null;
    const fn = (simnet.getContractsInterfaces().get(`${deployer}.${P}`)?.functions ?? [])
      .find((f) => f.name === "verify-lockup");
    expect(fn, "verify-lockup should still exist").toBeTruthy();
    expect(
      fn.args.map((a) => a.name),
      "commitment-offset must not be a parameter",
    ).not.toContain("commitment-offset");
  });

  // ---- FAILS on v4: no notion of which bond window the script belongs to ----
  it("rejects a genuine template built for a different bond window", () => {
    // A correctly-formed lockup for period N+1 must not settle a market about
    // period N. The unlock height is what distinguishes them, and v4 never
    // looks at it. In v5 it comes from
    // reward-cycle-to-burn-height(bond-period-to-reward-cycle(idx) + 12),
    // derived from pox-5 rather than supplied by the caller.
    const wrongWindow = poxLockup(staker, OTHER_UNLOCK_HEIGHT);
    const expected = poxLockup(staker, PERIOD_UNLOCK_HEIGHT);
    expect(wrongWindow.spk.equals(expected.spk)).toBe(false);
    expect(
      verifyV4(wrongWindow, staker, 13).type,
      "a lockup for the wrong unlock height must not settle this market",
    ).toBe("err");
  });
});

describe("the P2WSH binding itself", () => {
  it("a witness script that does not hash to the output is rejected", () => {
    const good = poxLockup(staker), other = poxLockup(stranger);
    expect(verifyV4({ spk: good.spk, witness: other.witness }, staker, 13).type).toBe("err");
  });

  it("value below the threshold is rejected", () => {
    expect(verifyV4(poxLockup(staker), staker, 13, 50_000, 100_000).type).toBe("err");
  });
});
