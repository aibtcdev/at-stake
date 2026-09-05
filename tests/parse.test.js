import { describe, it, expect } from "vitest";
import { Cl } from "@stacks/transactions";
import { createHash } from "node:crypto";

// Input parsing is the only Bitcoin code left in at-stake. Reading an output is
// a Clarity builtin now, so what still needs proving is OUR half: that
// tx-spends-outpoint walks inputs correctly, and that the txid it compares
// against is in the same byte order the builtin reports.
//
// That byte-order agreement is the whole point of this file. v1 shipped dead
// because a Bitcoin hash was compared in the wrong order and every test passed
// anyway, so it is checked here against an independent serializer rather than
// assumed.

const deployer = simnet.getAccounts().get("deployer");
const C = "at-stake-sim";

const sha256 = (b) => createHash("sha256").update(b).digest();
const sha256d = (b) => sha256(sha256(b));

// --- an independent Bitcoin serializer, so the Clarity parser is checked
// --- against something that did not come from the same code path.

function varint(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) return Buffer.concat([Buffer.from([0xfd]), u16le(n)]);
  if (n <= 0xffffffff) return Buffer.concat([Buffer.from([0xfe]), u32le(n)]);
  return Buffer.concat([Buffer.from([0xff]), u64le(BigInt(n))]);
}
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

// Legacy (non-witness) serialization -- the one the txid is taken over.
function serializeTx({ inputs, outputs, version = 2, locktime = 0 }) {
  const parts = [u32le(version), varint(inputs.length)];
  for (const i of inputs) {
    parts.push(i.txid);                       // 32 bytes, internal order
    parts.push(u32le(i.vout));
    parts.push(varint(i.script.length), i.script);
    parts.push(u32le(i.sequence ?? 0xfffffffd));
  }
  parts.push(varint(outputs.length));
  for (const o of outputs) {
    parts.push(u64le(o.value));
    parts.push(varint(o.script.length), o.script);
  }
  parts.push(u32le(locktime));
  return Buffer.concat(parts);
}

const p2wsh = (ws) => Buffer.concat([Buffer.from([0x00, 0x20]), sha256(ws)]);
const p2wpkh = (h20) => Buffer.concat([Buffer.from([0x00, 0x14]), h20]);

const spends = (txBuf, txid, vout) =>
  simnet.callReadOnlyFn(C, "tx-spends-outpoint",
    [Cl.buffer(txBuf), Cl.buffer(txid), Cl.uint(vout)], deployer).result;

const SNAP_TXID = sha256d(Buffer.from("the whale's dormant utxo"));
const OTHER_TXID = sha256d(Buffer.from("somebody else entirely"));
const LOCK_SCRIPT = Buffer.from("21" + "02".repeat(33) + "ac", "hex");
const WALLET = p2wpkh(Buffer.alloc(20, 0xd1));

describe("byte order: the builtin and our parser must agree", () => {
  // The funding transaction, and its txid computed independently of Clarity.
  const funding = serializeTx({
    inputs: [{ txid: OTHER_TXID, vout: 0, script: Buffer.alloc(0) }],
    outputs: [{ value: 148_712, script: WALLET }],
  });
  const fundingTxid = sha256d(funding);   // internal order, by construction

  it("get-bitcoin-tx-output? reports the txid in internal order", () => {
    // If the builtin returned display order this would be the reverse, and
    // every spend check downstream would silently never match.
    const r = simnet.callReadOnlyFn(C, "test-tx-output",
      [Cl.buffer(funding), Cl.uint(0)], deployer).result;
    expect(r).toBeOk(
      Cl.tuple({
        txid: Cl.buffer(fundingTxid),
        amount: Cl.uint(148_712),
        script: Cl.buffer(WALLET),
      }),
    );
  });

  it("a lockup spending that output is detected using the builtin's own txid", () => {
    // This is exactly what resolve-bonded does: take (get txid funded) straight
    // from the builtin and hand it to tx-spends-outpoint. If the two disagreed
    // on byte order, YES could never be proven for anyone.
    const lockup = serializeTx({
      inputs: [{ txid: fundingTxid, vout: 0, script: Buffer.alloc(0) }],
      outputs: [{ value: 148_000, script: p2wsh(LOCK_SCRIPT) }],
    });
    expect(spends(lockup, fundingTxid, 0)).toBeOk(Cl.bool(true));
  });

  it("the REVERSED txid does not match, proving the orders are not interchangeable", () => {
    const lockup = serializeTx({
      inputs: [{ txid: fundingTxid, vout: 0, script: Buffer.alloc(0) }],
      outputs: [{ value: 148_000, script: p2wsh(LOCK_SCRIPT) }],
    });
    const reversed = Buffer.from(fundingTxid).reverse();
    expect(spends(lockup, reversed, 0)).toBeOk(Cl.bool(false));
  });
});

describe("tx-spends-outpoint", () => {
  it("detects the outpoint among several inputs", () => {
    const lockup = serializeTx({
      inputs: [
        { txid: OTHER_TXID, vout: 3, script: Buffer.alloc(0) },
        { txid: SNAP_TXID, vout: 1, script: Buffer.alloc(0) },
        { txid: OTHER_TXID, vout: 7, script: Buffer.alloc(0) },
      ],
      outputs: [{ value: 100_000, script: p2wsh(LOCK_SCRIPT) }],
    });
    expect(spends(lockup, SNAP_TXID, 1)).toBeOk(Cl.bool(true));
  });

  it("rejects an unrelated transaction", () => {
    const tx = serializeTx({
      inputs: [{ txid: OTHER_TXID, vout: 0, script: Buffer.alloc(0) }],
      outputs: [{ value: 100_000, script: p2wsh(LOCK_SCRIPT) }],
    });
    expect(spends(tx, SNAP_TXID, 0)).toBeOk(Cl.bool(false));
  });

  it("rejects the right txid at the wrong vout", () => {
    const tx = serializeTx({
      inputs: [{ txid: SNAP_TXID, vout: 0, script: Buffer.alloc(0) }],
      outputs: [{ value: 100_000, script: p2wsh(LOCK_SCRIPT) }],
    });
    expect(spends(tx, SNAP_TXID, 1)).toBeOk(Cl.bool(false));
  });

  it("walks past inputs carrying long scriptSigs", () => {
    // The cursor advances by a varint-prefixed script length; a fixed stride
    // would desynchronise here and read garbage as the next txid.
    const lockup = serializeTx({
      inputs: [
        { txid: OTHER_TXID, vout: 0, script: Buffer.alloc(253, 0xab) },
        { txid: SNAP_TXID, vout: 2, script: Buffer.alloc(0) },
      ],
      outputs: [{ value: 100_000, script: p2wsh(LOCK_SCRIPT) }],
    });
    expect(spends(lockup, SNAP_TXID, 2)).toBeOk(Cl.bool(true));
  });

  it("finds an outpoint at the last walkable input", () => {
    const inputs = [];
    for (let i = 0; i < 23; i++) inputs.push({ txid: OTHER_TXID, vout: i, script: Buffer.alloc(0) });
    inputs.push({ txid: SNAP_TXID, vout: 0, script: Buffer.alloc(0) });
    const tx = serializeTx({ inputs, outputs: [{ value: 1, script: p2wsh(LOCK_SCRIPT) }] });
    expect(spends(tx, SNAP_TXID, 0)).toBeOk(Cl.bool(true));
  });

  it("refuses a transaction with more inputs than it can walk", () => {
    // Loud failure, not a silent false: a wrong answer here would read as
    // "these coins did not fund the bond" and settle a true market NO.
    const inputs = [];
    for (let i = 0; i < 25; i++) inputs.push({ txid: OTHER_TXID, vout: i, script: Buffer.alloc(0) });
    const tx = serializeTx({ inputs, outputs: [{ value: 1, script: p2wsh(LOCK_SCRIPT) }] });
    expect(spends(tx, SNAP_TXID, 0)).toBeErr(Cl.uint(302));
  });
});
