import { describe, it, expect, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";
import { createHash } from "node:crypto";

const deployer = simnet.getAccounts().get("deployer");
const alice = simnet.getAccounts().get("wallet_1");
const bob = simnet.getAccounts().get("wallet_2");
const staker = simnet.getAccounts().get("wallet_3");
const C = "at-stake-sim";

const sha256 = (b) => createHash("sha256").update(b).digest();
const sha256d = (b) => sha256(sha256(b));

// --- bitcoin serialization (independent of the contract) ---
const varint = (n) => (n < 0xfd ? Buffer.from([n]) : Buffer.concat([Buffer.from([0xfd]), u16le(n)]));
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

function ser({ inputs, outputs }) {
  const p = [u32le(2), varint(inputs.length)];
  for (const i of inputs) p.push(i.txid, u32le(i.vout), varint(i.script.length), i.script, u32le(0xfffffffd));
  p.push(varint(outputs.length));
  for (const o of outputs) p.push(u64le(o.value), varint(o.script.length), o.script);
  p.push(u32le(0));
  return Buffer.concat(p);
}
const p2wsh = (ws) => Buffer.concat([Buffer.from([0x00, 0x20]), sha256(ws)]);
const p2wpkh = (h) => Buffer.concat([Buffer.from([0x00, 0x14]), h]);

// merkle
function buildTree(leaves) {
  const levels = [leaves]; let cur = leaves;
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(sha256d(Buffer.concat([cur[i], cur[i + 1] ?? cur[i]])));
    levels.push(next); cur = next;
  }
  return levels;
}
function proofFor(levels, index) {
  const path = []; let idx = index;
  for (let l = 0; l < levels.length - 1; l++) {
    const layer = levels[l];
    path.push(layer[idx % 2 === 0 ? Math.min(idx + 1, layer.length - 1) : idx - 1]);
    idx = Math.floor(idx / 2);
  }
  return path;
}
// Put our tx in a synthetic 8-tx block and return everything the proof needs.
function inBlock(txBuf) {
  const others = Array.from({ length: 7 }, (_, i) => sha256d(Buffer.from("filler" + i)));
  const txid = sha256d(txBuf);
  const leaves = [others[0], others[1], txid, ...others.slice(2)];
  const levels = buildTree(leaves);
  const root = levels[levels.length - 1][0];
  // A real 80-byte header: version, prev hash, merkle root at 36..68, time,
  // bits, nonce. Only the root matters to the contract.
  const header = Buffer.alloc(80, 0xab);
  root.copy(header, 36);
  return { txid, index: 2, path: proofFor(levels, 2), header };
}

// --- the pox-5 lockup witness script, with the staker commitment inside it ---
// The commitment is sha256d(to-consensus-buff?(staker principal)). Its byte
// offset inside the script is passed to the contract so the check is exact.
function lockupScript(stakerCommitment) {
  const prefix = Buffer.from("63" + "04" + "00000000" + "b1" + "75" + "67" + "a8" + "20", "hex");
  const suffix = Buffer.from("88" + "21" + "02".repeat(33) + "ac" + "68" + "69", "hex");
  return { script: Buffer.concat([prefix, stakerCommitment, suffix]), offset: prefix.length };
}

function stakerCommitment(principalStr) {
  const r = simnet.callReadOnlyFn("btc-parse", "staker-commitment", [Cl.principal(principalStr)], deployer);
  return Buffer.from(r.result.value.value, "hex");
}

const WALLET_SPK = p2wpkh(Buffer.alloc(20, 0x42)); // the subject wallet
const SNAP_PREV = sha256d(Buffer.from("older utxo"));
const BOND_INDEX = 7;
const THRESHOLD = 100_000_000; // 1 BTC
// The official sBTC token, present in simnet because Clarinet.toml names
// `sbtc-deposit` in [[project.requirements]] -- that is what preloads every
// wallet with the `sbtc_balance` from settings/Devnet.toml. Nothing here mints
// or mocks money. This is the mainnet address of the same sBTC the deployed
// contract calls at its testnet address; build-sim.sh does the swap.
const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

const SNAP_SATS = 24_710_000_000; // 247.1 BTC

// The transaction that funded the subject wallet. Its output 0 is the snapshot.
const snapTx = ser({
  inputs: [{ txid: SNAP_PREV, vout: 0, script: Buffer.alloc(0) }],
  outputs: [{ value: SNAP_SATS, script: WALLET_SPK }],
});
const SNAP_TXID = sha256d(snapTx);

function createMarket(id, closeHeight = 500, threshold = THRESHOLD) {
  const b = inBlock(snapTx);
  return simnet.callPublicFn(C, "create-market", [
    Cl.buffer(id), Cl.buffer(WALLET_SPK), Cl.uint(BOND_INDEX), Cl.uint(closeHeight),
    Cl.uint(threshold), Cl.buffer(snapTx), Cl.uint(0), Cl.uint(1),
    Cl.buffer(b.header), Cl.uint(b.index), Cl.list(b.path.map((x) => Cl.buffer(x))),
  ], alice);
}

// The lockup: spends the snapshot outpoint, pays a P2WSH bound to the staker.
function buildLockup(sats = SNAP_SATS) {
  const c = stakerCommitment(staker);
  const { script, offset } = lockupScript(c);
  const tx = ser({
    inputs: [{ txid: SNAP_TXID, vout: 0, script: Buffer.alloc(0) }],
    outputs: [
      { value: sats, script: p2wsh(script) },
      { value: 12_000, script: p2wpkh(Buffer.alloc(20, 7)) },
    ],
  });
  return { tx, script, offset, block: inBlock(tx) };
}

function resolveBonded(id, lk, who = bob, stakerPrincipal = staker) {
  return simnet.callPublicFn(C, "resolve-bonded", [
    Cl.buffer(id), Cl.principal(stakerPrincipal), Cl.buffer(lk.tx), Cl.uint(0),
    Cl.uint(1), Cl.buffer(lk.block.header), Cl.uint(lk.block.index),
    Cl.list(lk.block.path.map((x) => Cl.buffer(x))),
    Cl.buffer(lk.script), Cl.uint(lk.offset),
    Cl.buffer(SNAP_TXID), Cl.uint(0),
  ], who);
}

const setBond = (isL1, sats, bondIndex = BOND_INDEX, who = staker) =>
  simnet.callPublicFn("mock-pox5", "set-membership",
    [Cl.principal(who), Cl.uint(bondIndex), Cl.bool(isL1), Cl.uint(sats)], deployer);

const mktStatus = (id) => {
  const r = simnet.callReadOnlyFn(C, "get-market", [Cl.buffer(id)], deployer);
  return r.result.type === 10 ? null : Number(r.result.value.value.status.value);
};

let n = 0;
const freshId = () => new Uint8Array(32).fill(++n % 250 + 1);

describe("create-market: proving the snapshot on chain", () => {
  it("creates a market from a real proven UTXO", () => {
    const id = freshId();
    expect(createMarket(id).result).toBeOk(Cl.buffer(id));
    const m = simnet.callReadOnlyFn(C, "get-market", [Cl.buffer(id)], deployer).result.value.value;
    expect(Number(m["snapshot-sats"].value)).toBe(SNAP_SATS);
    expect(Number(m["bond-index"].value)).toBe(BOND_INDEX);
  });

  it("REJECTS a wallet under 1 BTC -- the cutoff is in the contract", () => {
    const small = ser({
      inputs: [{ txid: SNAP_PREV, vout: 0, script: Buffer.alloc(0) }],
      outputs: [{ value: 99_999_999, script: WALLET_SPK }],
    });
    const b = inBlock(small);
    const r = simnet.callPublicFn(C, "create-market", [
      Cl.buffer(freshId()), Cl.buffer(WALLET_SPK), Cl.uint(BOND_INDEX), Cl.uint(500),
      Cl.uint(THRESHOLD), Cl.buffer(small), Cl.uint(0), Cl.uint(1),
      Cl.buffer(b.header), Cl.uint(b.index), Cl.list(b.path.map((x) => Cl.buffer(x))),
    ], alice);
    expect(r.result).toBeErr(Cl.uint(203));
  });

  it("REJECTS an output that pays a different wallet", () => {
    const b = inBlock(snapTx);
    const r = simnet.callPublicFn(C, "create-market", [
      Cl.buffer(freshId()), Cl.buffer(p2wpkh(Buffer.alloc(20, 0x99))), Cl.uint(BOND_INDEX),
      Cl.uint(500), Cl.uint(THRESHOLD), Cl.buffer(snapTx), Cl.uint(0), Cl.uint(1),
      Cl.buffer(b.header), Cl.uint(b.index), Cl.list(b.path.map((x) => Cl.buffer(x))),
    ], alice);
    expect(r.result).toBeErr(Cl.uint(204));
  });

  it("REJECTS a forged merkle proof", () => {
    const b = inBlock(snapTx);
    const badPath = b.path.map(() => sha256d(Buffer.from("nope")));
    const r = simnet.callPublicFn(C, "create-market", [
      Cl.buffer(freshId()), Cl.buffer(WALLET_SPK), Cl.uint(BOND_INDEX), Cl.uint(500),
      Cl.uint(THRESHOLD), Cl.buffer(snapTx), Cl.uint(0), Cl.uint(1),
      Cl.buffer(b.header), Cl.uint(b.index), Cl.list(badPath.map((x) => Cl.buffer(x))),
    ], alice);
    expect(r.result).toBeErr(Cl.uint(201));
  });

  it("REJECTS a duplicate market id", () => {
    const id = freshId();
    createMarket(id);
    expect(createMarket(id).result).toBeErr(Cl.uint(100));
  });
});

describe("resolve-bonded: the full YES claim", () => {
  it("resolves BONDED when every check passes", () => {
    const id = freshId();
    createMarket(id);
    setBond(true, SNAP_SATS);
    const lk = buildLockup();
    expect(resolveBonded(id, lk).result).toBeOk(Cl.uint(1));
    expect(mktStatus(id)).toBe(1);
  });

  it("REJECTS an sBTC bond -- v1 is native L1 only", () => {
    const id = freshId();
    createMarket(id);
    setBond(false, SNAP_SATS); // is-l1-lock: false
    expect(resolveBonded(id, buildLockup()).result).toBeErr(Cl.uint(207));
  });

  it("REJECTS a bond for a different bond-index", () => {
    const id = freshId();
    createMarket(id);
    setBond(true, SNAP_SATS, BOND_INDEX + 1);
    expect(resolveBonded(id, buildLockup()).result).toBeErr(Cl.uint(208));
  });

  it("REJECTS a bond under the threshold", () => {
    const id = freshId();
    createMarket(id);
    setBond(true, 50_000_000); // 0.5 BTC against a 1 BTC threshold
    expect(resolveBonded(id, buildLockup()).result).toBeErr(Cl.uint(209));
  });

  it("REJECTS a staker with no pox-5 membership at all", () => {
    const id = freshId();
    createMarket(id);
    simnet.callPublicFn("mock-pox5", "clear-membership", [Cl.principal(staker)], deployer);
    expect(resolveBonded(id, buildLockup()).result).toBeErr(Cl.uint(206));
  });

  it("REJECTS a lockup that does not spend the snapshot coins", () => {
    const id = freshId();
    createMarket(id);
    setBond(true, SNAP_SATS);
    const c = stakerCommitment(staker);
    const { script, offset } = lockupScript(c);
    const unrelated = ser({
      inputs: [{ txid: sha256d(Buffer.from("someone else's coins")), vout: 0, script: Buffer.alloc(0) }],
      outputs: [{ value: SNAP_SATS, script: p2wsh(script) }],
    });
    const lk = { tx: unrelated, script, offset, block: inBlock(unrelated) };
    expect(resolveBonded(id, lk).result).toBeErr(Cl.uint(205));
  });

  it("REJECTS a lookalike P2WSH bound to the wrong staker", () => {
    const id = freshId();
    createMarket(id);
    setBond(true, SNAP_SATS);
    // script commits to bob, but we claim it is the staker's
    const { script, offset } = lockupScript(stakerCommitment(bob));
    const tx = ser({
      inputs: [{ txid: SNAP_TXID, vout: 0, script: Buffer.alloc(0) }],
      outputs: [{ value: SNAP_SATS, script: p2wsh(script) }],
    });
    const lk = { tx, script, offset, block: inBlock(tx) };
    expect(resolveBonded(id, lk).result).toBeErr(Cl.uint(313));
  });

  it("REJECTS a witness script that does not hash to the output", () => {
    const id = freshId();
    createMarket(id);
    setBond(true, SNAP_SATS);
    const lk = buildLockup();
    lk.script = Buffer.concat([lk.script, Buffer.from([0x51])]); // one byte off
    expect(resolveBonded(id, lk).result).toBeErr(Cl.uint(310));
  });

  it("REJECTS resolving after the window closed", () => {
    const id = freshId();
    createMarket(id, 260);
    setBond(true, SNAP_SATS);
    simnet.mineEmptyBurnBlocks(300);
    expect(resolveBonded(id, buildLockup()).result).toBeErr(Cl.uint(103));
  });

  it("cannot be resolved twice", () => {
    const id = freshId();
    createMarket(id);
    setBond(true, SNAP_SATS);
    const lk = buildLockup();
    resolveBonded(id, lk);
    expect(resolveBonded(id, lk).result).toBeErr(Cl.uint(102));
  });

  it("FULL LIFECYCLE: create, bet, resolve bonded, redeem", () => {
    const id = freshId();
    createMarket(id);

    // Alice mints complete sets and sells her IDLE side to Bob at 68c.
    simnet.callPublicFn(C, "mint-complete-set", [Cl.buffer(id), Cl.uint(1_000_000)], alice);
    simnet.callPublicFn(C, "transfer-shares",
      [Cl.buffer(id), Cl.uint(0), Cl.uint(1_000_000), Cl.principal(bob)], alice);

    setBond(true, SNAP_SATS);
    expect(resolveBonded(id, buildLockup()).result).toBeOk(Cl.uint(1));

    // Alice held BONDED and was right.
    const before = Number(simnet.callReadOnlyFn(SBTC, "get-balance",
      [Cl.principal(alice)], deployer).result.value.value);
    expect(simnet.callPublicFn(C, "redeem", [Cl.buffer(id)], alice).result).toBeOk(Cl.uint(1_000_000));
    expect(Number(simnet.callReadOnlyFn(SBTC, "get-balance",
      [Cl.principal(alice)], deployer).result.value.value)).toBe(before + 1_000_000);
    // Bob's IDLE shares are worthless.
    expect(simnet.callPublicFn(C, "redeem", [Cl.buffer(id)], bob).result).toBeErr(Cl.uint(107));
  });
});
