import { describe, it, expect } from "vitest";
import { Cl } from "@stacks/transactions";
import { createHash } from "node:crypto";

const deployer = simnet.getAccounts().get("deployer");
const P = "btc-parse";

const sha256d = (b) =>
  createHash("sha256").update(createHash("sha256").update(b).digest()).digest();

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

// A P2WSH output is OP_0 <32-byte script hash>.
const p2wsh = (witnessScript) =>
  Buffer.concat([Buffer.from([0x00, 0x20]), createHash("sha256").update(witnessScript).digest()]);

// P2WPKH: OP_0 <20-byte key hash>
const p2wpkh = (hash20) => Buffer.concat([Buffer.from([0x00, 0x14]), hash20]);

function getOutput(txBuf, index) {
  const r = simnet.callReadOnlyFn(
    P, "get-output", [Cl.buffer(txBuf), Cl.uint(index)], deployer
  );
  return r.result;
}

function spendsOutpoint(txBuf, txid, vout) {
  const r = simnet.callReadOnlyFn(
    P, "tx-spends-outpoint",
    [Cl.buffer(txBuf), Cl.buffer(txid), Cl.uint(vout)], deployer
  );
  return r.result;
}

const SNAP_TXID = sha256d(Buffer.from("the whale's dormant utxo"));
const OTHER_TXID = sha256d(Buffer.from("somebody else entirely"));
const LOCK_SCRIPT = Buffer.from("21" + "02".repeat(33) + "ac", "hex"); // stand-in witness script

describe("bitcoin transaction parser in clarity", () => {
  it("reads a single output's value and scriptPubKey", () => {
    const tx = serializeTx({
      inputs: [{ txid: SNAP_TXID, vout: 0, script: Buffer.alloc(0) }],
      outputs: [{ value: 24_710_000_000, script: p2wsh(LOCK_SCRIPT) }],
    });
    const r = getOutput(tx, 0);
    expect(r).toBeOk(
      Cl.tuple({ value: Cl.uint(24_710_000_000), script: Cl.buffer(p2wsh(LOCK_SCRIPT)) })
    );
  });

  it("reads the right output out of several", () => {
    const change = p2wpkh(Buffer.alloc(20, 9));
    const tx = serializeTx({
      inputs: [{ txid: SNAP_TXID, vout: 3, script: Buffer.alloc(0) }],
      outputs: [
        { value: 1_000, script: change },
        { value: 24_710_000_000, script: p2wsh(LOCK_SCRIPT) },
        { value: 5_500, script: change },
      ],
    });
    expect(getOutput(tx, 1)).toBeOk(
      Cl.tuple({ value: Cl.uint(24_710_000_000), script: Cl.buffer(p2wsh(LOCK_SCRIPT)) })
    );
    expect(getOutput(tx, 0)).toBeOk(
      Cl.tuple({ value: Cl.uint(1_000), script: Cl.buffer(change) })
    );
    expect(getOutput(tx, 2)).toBeOk(
      Cl.tuple({ value: Cl.uint(5_500), script: Cl.buffer(change) })
    );
  });

  it("handles non-empty scriptSigs (legacy P2PKH-style inputs)", () => {
    const bigSig = Buffer.alloc(107, 0x47);
    const tx = serializeTx({
      inputs: [
        { txid: OTHER_TXID, vout: 1, script: bigSig },
        { txid: SNAP_TXID, vout: 0, script: bigSig },
      ],
      outputs: [{ value: 777, script: p2wsh(LOCK_SCRIPT) }],
    });
    expect(getOutput(tx, 0)).toBeOk(
      Cl.tuple({ value: Cl.uint(777), script: Cl.buffer(p2wsh(LOCK_SCRIPT)) })
    );
  });

  it("rejects an out-of-range output index", () => {
    const tx = serializeTx({
      inputs: [{ txid: SNAP_TXID, vout: 0, script: Buffer.alloc(0) }],
      outputs: [{ value: 1, script: p2wpkh(Buffer.alloc(20)) }],
    });
    expect(getOutput(tx, 5)).toBeErr(Cl.uint(301));
  });

  it("DETECTS that the lockup spends the snapshot outpoint", () => {
    const tx = serializeTx({
      inputs: [
        { txid: OTHER_TXID, vout: 0, script: Buffer.alloc(0) },
        { txid: SNAP_TXID, vout: 2, script: Buffer.alloc(0) },
      ],
      outputs: [{ value: 24_710_000_000, script: p2wsh(LOCK_SCRIPT) }],
    });
    expect(spendsOutpoint(tx, SNAP_TXID, 2)).toBeOk(Cl.bool(true));
  });

  it("REJECTS the right txid at the wrong vout", () => {
    const tx = serializeTx({
      inputs: [{ txid: SNAP_TXID, vout: 2, script: Buffer.alloc(0) }],
      outputs: [{ value: 1, script: p2wpkh(Buffer.alloc(20)) }],
    });
    expect(spendsOutpoint(tx, SNAP_TXID, 7)).toBeOk(Cl.bool(false));
  });

  it("REJECTS an unrelated transaction", () => {
    const tx = serializeTx({
      inputs: [{ txid: OTHER_TXID, vout: 0, script: Buffer.alloc(0) }],
      outputs: [{ value: 1, script: p2wpkh(Buffer.alloc(20)) }],
    });
    expect(spendsOutpoint(tx, SNAP_TXID, 0)).toBeOk(Cl.bool(false));
  });

  it("handles a 3-in 3-out transaction", () => {
    const tx = serializeTx({
      inputs: [
        { txid: OTHER_TXID, vout: 0, script: Buffer.alloc(72, 1) },
        { txid: SNAP_TXID, vout: 1, script: Buffer.alloc(0) },
        { txid: OTHER_TXID, vout: 5, script: Buffer.alloc(107, 2) },
      ],
      outputs: [
        { value: 100, script: p2wpkh(Buffer.alloc(20, 1)) },
        { value: 200, script: p2wpkh(Buffer.alloc(20, 2)) },
        { value: 24_710_000_000, script: p2wsh(LOCK_SCRIPT) },
      ],
    });
    expect(spendsOutpoint(tx, SNAP_TXID, 1)).toBeOk(Cl.bool(true));
    expect(getOutput(tx, 2)).toBeOk(
      Cl.tuple({ value: Cl.uint(24_710_000_000), script: Cl.buffer(p2wsh(LOCK_SCRIPT)) })
    );
  });

  it("txid matches an independent sha256d of the same bytes", () => {
    const tx = serializeTx({
      inputs: [{ txid: SNAP_TXID, vout: 0, script: Buffer.alloc(0) }],
      outputs: [{ value: 42, script: p2wsh(LOCK_SCRIPT) }],
    });
    const r = simnet.callReadOnlyFn(P, "tx-id", [Cl.buffer(tx)], deployer);
    expect(Buffer.from(r.result.value, "hex")).toEqual(sha256d(tx));
  });

  it("END TO END: lockup tx spends the snapshot AND pays the P2WSH", () => {
    const tx = serializeTx({
      inputs: [
        { txid: SNAP_TXID, vout: 0, script: Buffer.alloc(0) },
        { txid: SNAP_TXID, vout: 1, script: Buffer.alloc(0) },
      ],
      outputs: [
        { value: 24_710_000_000, script: p2wsh(LOCK_SCRIPT) },
        { value: 12_000, script: p2wpkh(Buffer.alloc(20, 7)) },
      ],
    });
    // condition 1: the coins in question really moved
    expect(spendsOutpoint(tx, SNAP_TXID, 0)).toBeOk(Cl.bool(true));
    // condition 2: they landed in a lockup-shaped output of the declared size
    const out = getOutput(tx, 0);
    expect(out).toBeOk(
      Cl.tuple({ value: Cl.uint(24_710_000_000), script: Cl.buffer(p2wsh(LOCK_SCRIPT)) })
    );
  });
});
