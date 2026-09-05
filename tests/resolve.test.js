import { describe, it, expect, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";
import { createHash } from "node:crypto";
import {
  registerSigner, setupBond, currentBondIndex, minUnlockHeight,
  lockupScriptFor, registerL1Bond, registerSbtcBond, STAKER_UNLOCK_BYTES,
  stakerCommitment,
} from "./helpers/pox5.js";

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
  return { txid, index: 2, count: leaves.length, path: proofFor(levels, 2), header };
}

// A block containing exactly one transaction. Its merkle root is the txid, so
// the proof is the empty path -- which both pox-5 and at-stake accept as valid.
// The lockup uses this so that ONE transaction satisfies pox-5's lockup
// verification and at-stake's snapshot-spend check at the same time.
function inSoloBlock(txBuf) {
  const txid = sha256d(txBuf);
  const header = Buffer.alloc(80, 0xab);
  txid.copy(header, 36);
  return { txid, index: 0, count: 1, path: [], header };
}


const WALLET_SPK = p2wpkh(Buffer.alloc(20, 0x42)); // the subject wallet
const SNAP_PREV = sha256d(Buffer.from("older utxo"));
// pox-5 only accepts setup-bond for the single index whose start lies in the
// next two reward cycles. At simnet's starting burn height that is index 1.
const BOND_INDEX = 1;
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

// create-market assigns the id itself and returns it. Terms are
// (script, close-height, threshold), so distinct markets need distinct terms --
// varying close-height is enough.
function createMarketRaw(closeHeight, threshold = THRESHOLD, title = "will it bond",
                         bondIndex = BOND_INDEX, namedStaker = Cl.none(), who = alice) {
  const b = inBlock(snapTx);
  return simnet.callPublicFn(C, "create-market", [
    Cl.stringAscii(title), Cl.buffer(WALLET_SPK), namedStaker, Cl.uint(bondIndex),
    Cl.uint(closeHeight), Cl.uint(threshold),
    Cl.buffer(snapTx), Cl.uint(0), Cl.uint(1),
    Cl.buffer(b.header), Cl.uint(b.index), Cl.uint(b.count),
    Cl.list(b.path.map((x) => Cl.buffer(x))),
  ], who);
}

let closeSeq = 500;
function createMarket(closeHeight = ++closeSeq, threshold = THRESHOLD) {
  const r = createMarketRaw(closeHeight, threshold);
  // A bond only counts if it lands AFTER the market opened, so give the chain
  // a block. Without this every resolve is ERR_BOND_TOO_EARLY.
  simnet.mineEmptyBurnBlocks(1);
  return { r, id: r.result.type === "ok" ? Number(r.result.value.value) : null };
}

// Set up a real bond in pox-5 and remember the unlock height its lockup script
// is bound to. Everything downstream uses pox-5's own template.
let UNLOCK = 0;
function bondSetup() {
  const idx = currentBondIndex();
  registerSigner(deployer);
  setupBond(deployer, idx, [staker, alice, bob]);
  UNLOCK = minUnlockHeight(deployer, idx) + 10;
  return idx;
}

// The lockup: spends the snapshot outpoint and pays pox-5's REAL lockup P2WSH.
// One transaction, verified independently by both contracts -- pox-5 accepts it
// as a timelock, at-stake sees it spend the committed coins.
function buildLockup(sats = SNAP_SATS, stakerPrincipal = staker, prevTxid = SNAP_TXID) {
  const { witness, spk } = lockupScriptFor(deployer, stakerPrincipal, UNLOCK);
  const tx = ser({
    inputs: [{ txid: prevTxid, vout: 0, script: Buffer.alloc(0) }],
    outputs: [
      { value: sats, script: spk },
      { value: 12_000, script: p2wpkh(Buffer.alloc(20, 7)) },
    ],
  });
  return { tx, script: witness, block: inSoloBlock(tx) };
}

// The funding proof: snapTx pays WALLET_SPK at output 0, and the lockup spends
// it. That is what proves the bonded coins came from the subject's wallet
// without naming one UTXO up front.
// A second coin paying the same wallet. Real, mined, and NOT in the photo
// unless somebody commits it with add-snapshot.
const otherCoinTx = ser({
  inputs: [{ txid: sha256d(Buffer.from("another older utxo")), vout: 0, script: Buffer.alloc(0) }],
  outputs: [{ value: 9_000_000_000, script: WALLET_SPK }],
});
const OTHER_COIN_TXID = sha256d(otherCoinTx);

function addSnapshot(id, tx = otherCoinTx, vout = 0, height = 1, who = alice) {
  const b = inBlock(tx);
  return simnet.callPublicFn(C, "add-snapshot", [
    Cl.uint(id), Cl.buffer(tx), Cl.uint(vout), Cl.uint(height),
    Cl.buffer(b.header), Cl.uint(b.index), Cl.uint(b.count),
    Cl.list(b.path.map((x) => Cl.buffer(x))),
  ], who);
}

function resolveBonded(id, lk, who = bob, stakerPrincipal = staker, lockupHeight = null,
                       opts = {}) {
  const fundingTxid = opts.fundingTxid ?? SNAP_TXID;
  const fundingVout = opts.fundingVout ?? 0;
  const h = lockupHeight ?? simnet.burnBlockHeight;
  const unlock = opts.unlock ?? UNLOCK;
  const unlockBytes = opts.unlockBytes ?? STAKER_UNLOCK_BYTES;
  return simnet.callPublicFn(C, "resolve-bonded", [
    Cl.uint(id), Cl.principal(stakerPrincipal),
    Cl.uint(unlock), Cl.buffer(unlockBytes),
    Cl.buffer(lk.tx), Cl.uint(0),
    Cl.uint(h), Cl.buffer(lk.block.header), Cl.uint(lk.block.index),
    Cl.uint(lk.block.count), Cl.list(lk.block.path.map((x) => Cl.buffer(x))),
    Cl.buffer(fundingTxid), Cl.uint(fundingVout),
  ], who);
}

// Establishes REAL pox-5 bond state -- no mock. Returns the lockup that pox-5
// accepted, so the same transaction can be handed to resolve-bonded.
//
// isL1 false takes pox-5's sBTC-locked branch, which really moves sBTC out of
// the staker, so the amount there is capped by the wallet's balance. The L1
// branch only needs the amount to appear in the Bitcoin output.
function setBond(isL1, sats, who = staker, prevTxid = SNAP_TXID) {
  const idx = bondSetup();
  if (!isL1) {
    registerSbtcBond(who, deployer, idx, Math.min(sats, 100_000_000));
    return null;
  }
  const lk = buildLockup(sats, who, prevTxid);
  registerL1Bond(who, deployer, idx,
    { tx: lk.tx, header: lk.block.header, amount: sats, unlockHeight: UNLOCK });
  return lk;
}

const mktStatus = (id) => {
  const r = simnet.callReadOnlyFn(C, "get-market", [Cl.uint(id)], deployer);
  return r.result.type === 10 ? null : Number(r.result.value.value.status.value);
};


describe("create-market: proving the snapshot on chain", () => {
  it("creates a market from a real proven UTXO and numbers it", () => {
    const { r, id } = createMarket();
    expect(r.result).toBeOk(Cl.uint(id));
    const m = simnet.callReadOnlyFn(C, "get-market", [Cl.uint(id)], deployer).result.value.value;
    expect(Number(m["snapshot-sats"].value)).toBe(SNAP_SATS);
    expect(m.title.value).toBe("will it bond");
    expect(Number(m["created-at"].value)).toBeLessThan(simnet.burnBlockHeight);
  });

  it("numbers markets sequentially", () => {
    const a = createMarket();
    const b = createMarket();
    expect(b.id).toBe(a.id + 1);
  });

  it("REJECTS an empty title", () => {
    expect(createMarketRaw(700, THRESHOLD, "").result).toBeErr(Cl.uint(112));
  });

  it("REJECTS a threshold above the snapshot -- YES must stay reachable", () => {
    expect(createMarketRaw(701, SNAP_SATS + 1).result).toBeErr(Cl.uint(111));
  });

  it("REJECTS a zero threshold -- dust must not claim YES", () => {
    expect(createMarketRaw(702, 0).result).toBeErr(Cl.uint(111));
  });

  it("REJECTS a zero-value snapshot output", () => {
    const small = ser({
      inputs: [{ txid: SNAP_PREV, vout: 0, script: Buffer.alloc(0) }],
      outputs: [{ value: 0, script: WALLET_SPK }],
    });
    const b = inBlock(small);
    const r = simnet.callPublicFn(C, "create-market", [
      Cl.stringAscii("zero value"), Cl.buffer(WALLET_SPK), Cl.none(), Cl.uint(BOND_INDEX), Cl.uint(710),
      Cl.uint(THRESHOLD), Cl.buffer(small), Cl.uint(0), Cl.uint(1),
      Cl.buffer(b.header), Cl.uint(b.index), Cl.uint(b.count),
      Cl.list(b.path.map((x) => Cl.buffer(x))),
    ], alice);
    expect(r.result).toBeErr(Cl.uint(203));
  });

  it("REJECTS an output that pays a different wallet", () => {
    const b = inBlock(snapTx);
    const r = simnet.callPublicFn(C, "create-market", [
      Cl.stringAscii("wrong wallet"), Cl.buffer(p2wpkh(Buffer.alloc(20, 0x99))),
      Cl.none(), Cl.uint(BOND_INDEX), Cl.uint(711), Cl.uint(THRESHOLD), Cl.buffer(snapTx), Cl.uint(0), Cl.uint(1),
      Cl.buffer(b.header), Cl.uint(b.index), Cl.uint(b.count),
      Cl.list(b.path.map((x) => Cl.buffer(x))),
    ], alice);
    expect(r.result).toBeErr(Cl.uint(204));
  });

  it("REJECTS a forged merkle proof", () => {
    const b = inBlock(snapTx);
    const badPath = b.path.map(() => sha256d(Buffer.from("nope")));
    const r = simnet.callPublicFn(C, "create-market", [
      Cl.stringAscii("forged proof"), Cl.buffer(WALLET_SPK), Cl.none(), Cl.uint(BOND_INDEX), Cl.uint(712),
      Cl.uint(THRESHOLD), Cl.buffer(snapTx), Cl.uint(0), Cl.uint(1),
      Cl.buffer(b.header), Cl.uint(b.index), Cl.uint(b.count),
      Cl.list(badPath.map((x) => Cl.buffer(x))),
    ], alice);
    expect(r.result).toBeErr(Cl.uint(201));
  });

  // The id is assigned, so duplicates are caught by the terms hash instead:
  // same wallet, same deadline, same threshold is the same question.
  it("REJECTS a deadline past the point this period's coins unlock", () => {
    // The window has to close while the bond is still provable. pox-5 computes
    // that height; nothing here is allowed to guess it.
    const tooLate = minUnlockHeight(deployer, BOND_INDEX) + 1;
    expect(createMarketRaw(tooLate, THRESHOLD, "too late").result).toBeErr(Cl.uint(121));
  });

  it("treats the same wallet in a different bond period as a different market", () => {
    // One market per wallet per bond window: the index is part of the terms,
    // so this is not a duplicate even though everything else matches.
    const a = createMarketRaw(730, THRESHOLD, "period 1", 1);
    const b = createMarketRaw(730, THRESHOLD, "period 2", 2);
    expect(a.result.type).toBe("ok");
    expect(b.result.type).toBe("ok");
  });

  it("REJECTS a second market with identical terms", () => {
    createMarketRaw(720);
    expect(createMarketRaw(720).result).toBeErr(Cl.uint(100));
  });

  it("allows the same wallet at a different deadline", () => {
    expect(createMarketRaw(721).result.type).toBe("ok");
    expect(createMarketRaw(722).result.type).toBe("ok");
  });
});

describe("the snapshot: which coins this market is about", () => {
  it("records the coin proven at create", () => {
    const { id } = createMarket();
    const r = simnet.callReadOnlyFn(C, "get-snapshot",
      [Cl.uint(id), Cl.buffer(SNAP_TXID), Cl.uint(0)], deployer).result;
    expect(Number(r.value.value.sats.value)).toBe(SNAP_SATS);
  });

  it("commits another coin the wallet already held", () => {
    const { id } = createMarket();
    expect(addSnapshot(id).result).toBeOk(Cl.uint(9_000_000_000));
    const r = simnet.callReadOnlyFn(C, "get-snapshot",
      [Cl.uint(id), Cl.buffer(OTHER_COIN_TXID), Cl.uint(0)], deployer).result;
    expect(r.type).not.toBe("none");
  });

  it("REJECTS a coin mined after the market opened", () => {
    // The point of the photo: money arriving later is not what was asked about.
    const { id } = createMarket();
    const after = simnet.burnBlockHeight;
    expect(addSnapshot(id, otherCoinTx, 0, after).result).toBeErr(Cl.uint(123));
  });

  it("REJECTS a coin paying a different wallet", () => {
    const { id } = createMarket();
    const stranger = ser({
      inputs: [{ txid: SNAP_PREV, vout: 0, script: Buffer.alloc(0) }],
      outputs: [{ value: 5_000_000, script: p2wpkh(Buffer.alloc(20, 0x99)) }],
    });
    expect(addSnapshot(id, stranger).result).toBeErr(Cl.uint(204));
  });

  it("REJECTS committing the same coin twice", () => {
    const { id } = createMarket();
    expect(addSnapshot(id).result.type).toBe("ok");
    expect(addSnapshot(id).result).toBeErr(Cl.uint(124));
  });

  it("REFUSES to change the terms once money is at stake", () => {
    // Adding a coin makes YES easier. A NO holder who has already paid must
    // not have their odds moved underneath them.
    const { id } = createMarket();
    simnet.callPublicFn(C, "mint-complete-set", [Cl.uint(id), Cl.uint(500)], alice);
    expect(addSnapshot(id).result).toBeErr(Cl.uint(125));
  });

  it("grows the market's snapshot total", () => {
    const { id } = createMarket();
    addSnapshot(id);
    const m = simnet.callReadOnlyFn(C, "get-market", [Cl.uint(id)], deployer).result.value.value;
    expect(Number(m["snapshot-sats"].value)).toBe(SNAP_SATS + 9_000_000_000);
  });
});

describe("resolve-bonded: the full YES claim", () => {
  it("resolves BONDED when every check passes", () => {
    const { id } = createMarket();
    const lk = setBond(true, SNAP_SATS);
    expect(resolveBonded(id, lk).result).toBeOk(Cl.uint(1));
    expect(mktStatus(id)).toBe(1);
  });

  it("REJECTS an sBTC bond -- v1 is native L1 only", () => {
    const { id } = createMarket();
    setBond(false, SNAP_SATS); // is-l1-lock: false
    expect(resolveBonded(id, buildLockup()).result).toBeErr(Cl.uint(207));
  });

  // pox-5 derives amount-sats from the lockup transaction itself, so a staker
  // cannot simply claim a larger bond than they funded. The real attack is to
  // bond a little of your own money and then point at somebody else's much
  // larger snapshot. pox-5 is satisfied; check 6 is not.
  it("REJECTS a bond under the threshold", () => {
    const { id } = createMarket();
    const idx = bondSetup();
    const OWN = sha256d(Buffer.from("the staker's own, smaller utxo"));
    const funded = buildLockup(50_000_000, staker, OWN); // 0.5 BTC really locked
    registerL1Bond(staker, deployer, idx, {
      tx: funded.tx, header: funded.block.header,
      amount: 50_000_000, unlockHeight: UNLOCK,
    });
    // now point at the market's 247 BTC snapshot instead
    expect(resolveBonded(id, buildLockup()).result).toBeErr(Cl.uint(209));
  });

  it("REJECTS a staker with no pox-5 membership at all", () => {
    const { id } = createMarket();
    bondSetup(); // a real bond exists, but this staker never registered for it
    expect(resolveBonded(id, buildLockup()).result).toBeErr(Cl.uint(206));
  });

  it("REJECTS a lockup that does not spend the snapshot coins", () => {
    const { id } = createMarket();
    setBond(true, SNAP_SATS);
    const { witness, spk, offset } = lockupScriptFor(deployer, staker, UNLOCK);
    const unrelated = ser({
      inputs: [{ txid: sha256d(Buffer.from("someone else's coins")), vout: 0, script: Buffer.alloc(0) }],
      outputs: [{ value: SNAP_SATS, script: spk }],
    });
    const lk = { tx: unrelated, script: witness, block: inSoloBlock(unrelated) };
    expect(resolveBonded(id, lk).result).toBeErr(Cl.uint(205));
  });

  it("REJECTS a lookalike P2WSH bound to the wrong staker", () => {
    const { id } = createMarket();
    setBond(true, SNAP_SATS);
    // a real pox-5 lockup script, but one that commits to bob, not the staker
    const { witness, spk, offset } = lockupScriptFor(deployer, bob, UNLOCK);
    const tx = ser({
      inputs: [{ txid: SNAP_TXID, vout: 0, script: Buffer.alloc(0) }],
      outputs: [{ value: SNAP_SATS, script: spk }],
    });
    const lk = { tx, script: witness, block: inSoloBlock(tx) };
    expect(resolveBonded(id, lk).result).toBeErr(Cl.uint(313));
  });

  // The forgery that v4 accepted. The witness script is no longer a parameter:
  // pox-5 builds the script from the staker and the bond period, and the lockup
  // output must equal its P2WSH byte for byte. A P2WSH that merely carries the
  // commitment -- no OP_IF, no CLTV, sweepable the next block -- cannot settle.
  it("REJECTS a forged P2WSH that only carries the staker commitment", () => {
    const { id } = createMarket();
    setBond(true, SNAP_SATS);
    const forged = Buffer.concat([
      Buffer.from([0x20]), stakerCommitment(staker), Buffer.from([0x75]),
      Buffer.from([0x21]), Buffer.alloc(33, 0x02), Buffer.from([0xac]),
    ]);
    const tx = ser({
      inputs: [{ txid: SNAP_TXID, vout: 0, script: Buffer.alloc(0) }],
      outputs: [{ value: SNAP_SATS, script: p2wsh(forged) }],
    });
    const lk = { tx, script: forged, block: inSoloBlock(tx) };
    expect(resolveBonded(id, lk).result).toBeErr(Cl.uint(313));
  });

  // Same shape, right template, wrong period: the unlock height is what
  // separates one bond window from the next.
  // resolve-bonded reads bond-index from the market, so a caller cannot name a
  // different period than the one the market is about.
  //
  // This covers the unconfigured-period case. The other branch -- a live bond
  // in period N settling a market about period M -- is not reachable in simnet:
  // pox-5's setup-bond only accepts the index whose start falls in the next two
  // reward cycles, so two periods cannot be live at once. It is guarded by
  // (is-eq (get bond-index mem) bidx) in check 6.
  it("REJECTS a market whose bond period pox-5 does not know", () => {
    const r = createMarketRaw(740, THRESHOLD, "other period", BOND_INDEX + 1);
    const id = Number(r.result.value.value);
    simnet.mineEmptyBurnBlocks(1);
    const lk = setBond(true, SNAP_SATS);
    expect(resolveBonded(id, lk).result).toBeErr(Cl.uint(211));
  });

  // Coins outside the photo cannot settle the market, even paying the same
  // wallet. Without this, a deposit made after the question was asked would
  // answer it.
  it("REJECTS bonded coins that were never committed to this market", () => {
    const { id } = createMarket();
    const lk = setBond(true, SNAP_SATS, staker, OTHER_COIN_TXID);
    expect(resolveBonded(id, lk, bob, staker, null,
      { fundingTxid: OTHER_COIN_TXID, fundingVout: 0 }).result).toBeErr(Cl.uint(122));
  });

  it("SETTLES once that same coin is committed with add-snapshot", () => {
    const { id } = createMarket();
    expect(addSnapshot(id).result.type).toBe("ok");
    const lk = setBond(true, SNAP_SATS, staker, OTHER_COIN_TXID);
    expect(resolveBonded(id, lk, bob, staker, null,
      { fundingTxid: OTHER_COIN_TXID, fundingVout: 0 }).result).toBeOk(Cl.uint(1));
  });

  // The borrowed-membership hole, closed for markets that name who must bond.
  // pox-5 records that a staker is a member but never which Bitcoin backs it,
  // so an unnamed market can be settled against any stranger's live bond.
  it("REJECTS a stranger's membership when the market names a staker", () => {
    const r = createMarketRaw(750, THRESHOLD, "named", BOND_INDEX, Cl.some(Cl.principal(alice)), alice);
    const id = Number(r.result.value.value);
    simnet.mineEmptyBurnBlocks(1);
    const lk = setBond(true, SNAP_SATS, staker);   // a real bond, wrong person
    expect(resolveBonded(id, lk, bob, staker).result).toBeErr(Cl.uint(126));
  });

  it("REFUSES to open a named market whose staker has already bonded", () => {
    // Otherwise the answer exists before the question does, and the forger
    // only has to build a lockbox around a membership that is already there.
    setBond(true, SNAP_SATS, staker);
    expect(createMarketRaw(752, THRESHOLD, "already", BOND_INDEX,
      Cl.some(Cl.principal(staker)), staker).result).toBeErr(Cl.uint(127));
  });

  it("SETTLES when the named staker is the one who bonded", () => {
    const r = createMarketRaw(751, THRESHOLD, "named ok", BOND_INDEX, Cl.some(Cl.principal(staker)), staker);
    const id = Number(r.result.value.value);
    simnet.mineEmptyBurnBlocks(1);
    const lk = setBond(true, SNAP_SATS, staker);
    expect(resolveBonded(id, lk).result).toBeOk(Cl.uint(1));
  });

  it("REJECTS naming somebody else as the staker", () => {
    // Otherwise the creator can name a stranger who will never bond, and sell
    // YES into a market they know settles NO.
    expect(createMarketRaw(753, THRESHOLD, "rigged", BOND_INDEX,
      Cl.some(Cl.principal(staker)), alice).result).toBeErr(Cl.uint(128));
  });

  it("REJECTS a real pox-5 lockup built for a later unlock height", () => {
    const { id } = createMarket();
    const lk = setBond(true, SNAP_SATS);
    expect(resolveBonded(id, lk, bob, staker, null, { unlock: UNLOCK + 1000 }).result)
      .toBeErr(Cl.uint(313));
  });

  it("REJECTS resolving after the window closed", () => {
    const { id } = createMarket(260);
    const lk = setBond(true, SNAP_SATS);
    simnet.mineEmptyBurnBlocks(300);
    expect(resolveBonded(id, lk).result).toBeErr(Cl.uint(103));
  });

  it("cannot be resolved twice", () => {
    const { id } = createMarket();
    const lk = setBond(true, SNAP_SATS);
    resolveBonded(id, lk);
    expect(resolveBonded(id, lk).result).toBeErr(Cl.uint(102));
  });

  it("FULL LIFECYCLE: create, bet, resolve bonded, redeem", () => {
    const { id } = createMarket();

    // Alice mints complete sets and sells her IDLE side to Bob at 68c.
    simnet.callPublicFn(C, "mint-complete-set", [Cl.uint(id), Cl.uint(1_000_000)], alice);
    simnet.callPublicFn(C, "transfer-shares",
      [Cl.uint(id), Cl.uint(0), Cl.uint(1_000_000), Cl.principal(bob)], alice);

    const lk = setBond(true, SNAP_SATS);
    expect(resolveBonded(id, lk).result).toBeOk(Cl.uint(1));

    // Alice held BONDED and was right.
    const before = Number(simnet.callReadOnlyFn(SBTC, "get-balance",
      [Cl.principal(alice)], deployer).result.value.value);
    expect(simnet.callPublicFn(C, "redeem", [Cl.uint(id)], alice).result).toBeOk(Cl.uint(1_000_000));
    expect(Number(simnet.callReadOnlyFn(SBTC, "get-balance",
      [Cl.principal(alice)], deployer).result.value.value)).toBe(before + 1_000_000);
    // Bob's IDLE shares are worthless.
    expect(simnet.callPublicFn(C, "redeem", [Cl.uint(id)], bob).result).toBeErr(Cl.uint(107));
  });
});

describe("the creator cannot open a market too short to win", () => {
  // A bond needs a Bitcoin timelock built and registered, and resolve-bonded
  // requires the lockup to post-date the market. A window shorter than that
  // cannot resolve YES whatever happens, so it is a rigged NO, not a question.
  it("REJECTS a market that closes almost immediately", () => {
    const b = simnet.burnBlockHeight;
    expect(createMarketRaw(b + 1).result).toBeErr(Cl.uint(119));
    expect(createMarketRaw(b + 143).result).toBeErr(Cl.uint(119));
  });

  it("accepts a market a day out", () => {
    const b = simnet.burnBlockHeight;
    expect(createMarketRaw(b + 144).result.type).toBe("ok");
  });
});
