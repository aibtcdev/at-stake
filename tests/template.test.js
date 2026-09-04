import { describe, it, expect } from "vitest";
import { Cl } from "@stacks/transactions";

// Pins btc-parse against pox-5's ACTUAL lockup script template, read out of
// the real contract rather than reconstructed from documentation. This is the
// gap the README used to list first: "we do not reconstruct pox-5's exact
// template". Now we check against it directly, so a template change upstream
// breaks this test instead of silently breaking resolve-bonded.
//
// pox-5 construct-lockup-script builds:
//   0x63                  OP_IF
//   <scriptnum unlock-height>
//   0xb167                OP_CHECKLOCKTIMEVERIFY OP_ELSE
//   0x82012088a820        OP_SIZE <32> OP_EQUALVERIFY OP_SHA256 OP_PUSHBYTES_32
//   sha256d(to-consensus-buff? staker)      <-- the 32-byte commitment
//   0x88                  OP_EQUALVERIFY
//   <early-unlock-bytes>
//   0x6869                OP_ENDIF OP_VERIFY
//   <staker-unlock-bytes>

const POX = "pox5-sim", P = "btc-parse";
const UNLOCK_HEIGHT = 800_000;
const STAKER_UNLOCK = new Uint8Array([0x51]); // OP_1
const EARLY_UNLOCK = new Uint8Array([0x51]);

function poxScript(staker, deployer) {
  const ws = simnet.callReadOnlyFn(POX, "construct-lockup-script",
    [Cl.principal(staker), Cl.uint(UNLOCK_HEIGHT), Cl.buffer(STAKER_UNLOCK), Cl.buffer(EARLY_UNLOCK)], deployer);
  const spk = simnet.callReadOnlyFn(POX, "construct-lockup-output-script",
    [Cl.principal(staker), Cl.uint(UNLOCK_HEIGHT), Cl.buffer(STAKER_UNLOCK), Cl.buffer(EARLY_UNLOCK)], deployer);
  return { witness: ws.result.value.value, spk: spk.result.value.value };
}

describe("btc-parse is pinned to pox-5's real lockup template", () => {
  const deployer = simnet.getAccounts().get("deployer");
  const staker = simnet.getAccounts().get("wallet_1");

  it("builds byte-identical P2WSH to construct-lockup-output-script", () => {
    const { witness, spk } = poxScript(staker, deployer);
    const ours = simnet.callReadOnlyFn(P, "p2wsh-script-pubkey",
      [Cl.buffer(Buffer.from(witness, "hex"))], deployer);
    expect(ours.result.value).toBe(spk);
  });

  it("computes the same staker commitment pox-5 embeds", () => {
    const { witness } = poxScript(staker, deployer);
    const c = simnet.callReadOnlyFn(P, "staker-commitment", [Cl.principal(staker)], deployer)
      .result.value.value;
    expect(witness).toContain(c);
  });

  it("finds the commitment at the offset the template dictates", () => {
    // 1 (OP_IF) + 4 (scriptnum for 800000) + 2 (0xb167) + 6 (0x82012088a820)
    const { witness } = poxScript(staker, deployer);
    const c = simnet.callReadOnlyFn(P, "staker-commitment", [Cl.principal(staker)], deployer)
      .result.value.value;
    expect(witness.indexOf(c) / 2).toBe(13);
    const ok = simnet.callReadOnlyFn(P, "script-commits-to-staker",
      [Cl.buffer(Buffer.from(witness, "hex")), Cl.principal(staker), Cl.uint(13)], deployer);
    expect(ok.result).toStrictEqual(Cl.bool(true));
  });

  it("rejects the same script bound to a different staker", () => {
    const { witness } = poxScript(staker, deployer);
    const other = simnet.getAccounts().get("wallet_2");
    const ok = simnet.callReadOnlyFn(P, "script-commits-to-staker",
      [Cl.buffer(Buffer.from(witness, "hex")), Cl.principal(other), Cl.uint(13)], deployer);
    expect(ok.result).toStrictEqual(Cl.bool(false));
  });

  it("rejects a correct commitment at a wrong offset", () => {
    const { witness } = poxScript(staker, deployer);
    const ok = simnet.callReadOnlyFn(P, "script-commits-to-staker",
      [Cl.buffer(Buffer.from(witness, "hex")), Cl.principal(staker), Cl.uint(12)], deployer);
    expect(ok.result).toStrictEqual(Cl.bool(false));
  });
});
