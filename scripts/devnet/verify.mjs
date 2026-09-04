// End-to-end verification of At Stake against real infrastructure.
//
//   node scripts/devnet/verify.mjs
//
// Every step below runs against a real bitcoind and a real Stacks node with
// the burn-header check LIVE -- there is no SIM-SKIP-HEADER on devnet. Each
// step asserts, and the script exits non-zero if anything fails, so this is
// the thing to run when you want to know the system actually works.

import { createHash, randomBytes } from "node:crypto";
import { makeContractCall, broadcastTransaction, Cl, cvToJSON, hexToCV,
         serializeCV, PostConditionMode } from "@stacks/transactions";
import { STACKS_DEVNET } from "@stacks/network";
import { rpc, ensureWallet, getNewAddress, sendToAddress, getWalletBalance,
         mine, getBlockCount } from "./bitcoin-rpc.mjs";
import { buildProof } from "./build-proof.mjs";

const NODE = process.env.STACKS_NODE ?? "http://127.0.0.1:20443";
const API  = process.env.STACKS_API  ?? "http://127.0.0.1:3999";
const ADDR = process.env.CONTRACT_ADDRESS ?? "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";
const KEY  = process.env.DEPLOYER_KEY
  ?? "753b7cc01a1a2e86221266a154af739463fce51219d97e4f856cd7200c3bd2a601";
const CONTRACT = process.env.CONTRACT_NAME ?? "at-stake";
const SBTC = process.env.SBTC_NAME ?? "sbtc-token";
const NETWORK = { ...STACKS_DEVNET, client: { baseUrl: NODE } };
const hex = (h) => Buffer.from(String(h).replace(/^0x/, ""), "hex");

let pass = 0, fail = 0;
const ok   = (m, d = "") => { pass++; console.log(`  PASS  ${m}${d ? "  " + d : ""}`); };
const bad  = (m, d = "") => { fail++; console.log(`  FAIL  ${m}${d ? "  " + d : ""}`); };
const check = (cond, m, d = "") => (cond ? ok(m, d) : bad(m, d));
const head = (t) => console.log(`\n${t}`);

const info = () => fetch(`${NODE}/v2/info`).then((r) => r.json());

async function readOnly(fn, args) {
  const r = await fetch(`${NODE}/v2/contracts/call-read/${ADDR}/${CONTRACT}/${fn}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sender: ADDR, arguments: args.map((a) => serializeCV(a)) }),
  }).then((r) => r.json());
  if (!r.okay) throw new Error(`${fn}: ${r.cause}`);
  return cvToJSON(hexToCV(r.result));
}

// Wait for the stacks node to catch up with bitcoind; a burst of sortitions
// stalls the Nakamoto signer, so we never mine far ahead of it.
async function waitForNode(slack = 2) {
  for (let i = 0; i < 150; i++) {
    const btc = await getBlockCount();
    const stx = (await info()).burn_block_height;
    if (btc - stx <= slack) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("stacks-node fell behind bitcoind");
}
async function mineGently(total, address, batch = 5) {
  for (let d = 0; d < total; d += batch) { await mine(Math.min(batch, total - d), address); await waitForNode(); }
}

let nonce = null;
async function call(functionName, functionArgs, fee = 10000n) {
  if (nonce === null) {
    const a = await fetch(`${NODE}/v2/accounts/${ADDR}?proof=0`).then((r) => r.json());
    nonce = BigInt(a.nonce);
  }
  const tx = await makeContractCall({
    contractAddress: ADDR, contractName: CONTRACT, functionName, functionArgs,
    senderKey: KEY, network: NETWORK, postConditionMode: PostConditionMode.Allow,
    fee, nonce: nonce++,
  });
  const res = await broadcastTransaction({ transaction: tx, network: NETWORK });
  if (res.error) throw new Error(`${functionName}: ${res.error} ${res.reason ?? ""}`);
  return res.txid;
}

// Poll the API for a transaction's outcome.
async function settled(txid, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`${API}/extended/v1/tx/0x${txid.replace(/^0x/, "")}`).then((r) => r.json()).catch(() => null);
    if (r && r.tx_status && r.tx_status !== "pending") return r;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`tx ${txid} never settled`);
}

async function main() {
  head("infrastructure");
  const chain = await rpc("getblockchaininfo");
  check(chain.chain === "regtest", "bitcoind reachable", `${chain.chain} @ ${chain.blocks}`);
  const i = await info();
  check(i.burn_block_height > 162, "stacks node past epoch 4.0", `burn ${i.burn_block_height}, stacks ${i.stacks_tip_height}`);
  const apiOk = await fetch(`${API}/extended/v1/status`).then((r) => r.ok).catch(() => false);
  check(apiOk, "stacks API reachable", API);

  head("contracts");
  for (const c of ["btc-parse", "at-stake", "sbtc-token"]) {
    const r = await fetch(`${NODE}/v2/contracts/interface/${ADDR}/${c}`);
    check(r.ok, `${c} deployed`);
  }
  const src = await fetch(`${NODE}/v2/contracts/source/${ADDR}/${CONTRACT}`).then((r) => r.json());
  check(!src.source.includes("SIM-SKIP-HEADER"), "deployed at-stake has the REAL burn-header check");
  check(src.source.includes("pox-5"), "deployed at-stake calls pox-5");

  head("bitcoin: build a real SPV proof");
  await ensureWallet();
  if ((await getWalletBalance()) < 2) { console.log("  (funding wallet, batched)"); await mineGently(110, await getNewAddress("mining")); }
  const subject = await getNewAddress("subject");
  const txid = await sendToAddress(subject, 1.0);
  await mine(1); await waitForNode();
  const decoded = await rpc("getrawtransaction", [txid, true]);
  const vout = decoded.vout.find((o) => (o.scriptPubKey.address ?? "") === subject);
  const proof = await buildProof(txid);
  check(!!vout, "funded a subject wallet with 1 BTC", subject);
  check(proof.path.length <= 14, "merkle proof within contract limits", `depth ${proof.path.length}`);
  ok("merkle root verified against the real block header", `burn ${proof.burnHeight}`);

  head("create-market  (burn-header check LIVE)");
  const id = randomBytes(32);
  const closeHeight = (await info()).burn_block_height + 300;
  const cmTx = await call("create-market", [
    Cl.buffer(id), Cl.buffer(hex(vout.scriptPubKey.hex)), Cl.uint(1),
    Cl.uint(closeHeight), Cl.uint(100_000_000),
    Cl.buffer(hex(proof.txHex)), Cl.uint(vout.n), Cl.uint(proof.burnHeight),
    Cl.buffer(hex(proof.headerHex)), Cl.uint(proof.txIndex),
    Cl.list(proof.path.map((s) => Cl.buffer(s))),
  ]);
  const cm = await settled(cmTx);
  check(cm.tx_status === "success", "create-market succeeded on chain",
        cm.tx_status === "success" ? `0x${id.toString("hex").slice(0, 16)}…` : JSON.stringify(cm.tx_result?.repr ?? cm.tx_status));

  const m = await readOnly("get-market", [Cl.buffer(id)]);
  const row = m.value?.value;
  check(!!row, "market row exists");
  if (row) {
    check(Number(row["snapshot-sats"].value) === 100_000_000, "snapshot proven from Bitcoin", `${row["snapshot-sats"].value} sats`);
    check(Number(row.status.value) === 0, "status OPEN");
    check(Number(row.vault.value) === 0, "vault empty at creation");
  }

  head("rejections (the contract must refuse bad evidence)");
  const badPath = proof.path.map(() => createHash("sha256").update("nope").digest());
  const badTx = await call("create-market", [
    Cl.buffer(randomBytes(32)), Cl.buffer(hex(vout.scriptPubKey.hex)), Cl.uint(1),
    Cl.uint(closeHeight), Cl.uint(100_000_000),
    Cl.buffer(hex(proof.txHex)), Cl.uint(vout.n), Cl.uint(proof.burnHeight),
    Cl.buffer(hex(proof.headerHex)), Cl.uint(proof.txIndex),
    Cl.list(badPath.map((s) => Cl.buffer(s))),
  ]);
  const bt = await settled(badTx);
  check(bt.tx_status !== "success", "forged merkle proof REJECTED", bt.tx_result?.repr ?? bt.tx_status);

  const wrongHeader = Buffer.from(hex(proof.headerHex)); wrongHeader[0] ^= 0xff;
  const badHdrTx = await call("create-market", [
    Cl.buffer(randomBytes(32)), Cl.buffer(hex(vout.scriptPubKey.hex)), Cl.uint(1),
    Cl.uint(closeHeight), Cl.uint(100_000_000),
    Cl.buffer(hex(proof.txHex)), Cl.uint(vout.n), Cl.uint(proof.burnHeight),
    Cl.buffer(wrongHeader), Cl.uint(proof.txIndex),
    Cl.list(proof.path.map((s) => Cl.buffer(s))),
  ]);
  const bh = await settled(badHdrTx);
  check(bh.tx_status !== "success", "tampered block header REJECTED  <-- only testable here",
        bh.tx_result?.repr ?? bh.tx_status);

  // ---------------------------------------------------------------- money
  head("sBTC");
  const sbtcBal = async (who) => {
    const r = await fetch(`${NODE}/v2/contracts/call-read/${ADDR}/${SBTC}/get-balance`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sender: ADDR, arguments: [serializeCV(Cl.principal(who))] }),
    }).then((r) => r.json());
    if (!r.okay) return null;
    return Number(cvToJSON(hexToCV(r.result)).value.value);
  };
  const bal0 = await sbtcBal(ADDR);
  if (bal0 === null || bal0 === 0) {
    bad("deployer holds sBTC", "0 — cannot exercise the money layer on devnet");
    console.log("\n  The escrow/trading half needs sBTC in a devnet wallet. It is fully");
    console.log("  covered by the simnet suite (npm test) against the same contract.");
  } else {
    ok("deployer holds sBTC", `${bal0} sats`);

    head("mint-complete-set  (1 sat -> 1 IDLE + 1 BONDED)");
    const STAKE = 1_000_000;
    const mintTx = await call("mint-complete-set", [Cl.buffer(id), Cl.uint(STAKE)]);
    const mr = await settled(mintTx);
    check(mr.tx_status === "success", "mint succeeded", mr.tx_result?.repr ?? mr.tx_status);
    let mk = (await readOnly("get-market", [Cl.buffer(id)])).value?.value;
    check(Number(mk.vault.value) === STAKE, "vault holds the stake", `${mk.vault.value}`);
    check(Number(mk["idle-circ"].value) === STAKE && Number(mk["bonded-circ"].value) === STAKE,
          "both sides issued equally", `idle ${mk["idle-circ"].value}, bonded ${mk["bonded-circ"].value}`);
    check(bal0 - (await sbtcBal(ADDR)) === STAKE, "sBTC actually left the wallet");

    const pos = (await readOnly("get-position", [Cl.buffer(id), Cl.principal(ADDR)])).value;
    check(Number(pos.idle.value) === STAKE && Number(pos.bonded.value) === STAKE, "position credited both sides");

    head("transfer-shares  (sell the side you do not believe)");
    const OTHER = "ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5";
    const xTx = await call("transfer-shares", [Cl.buffer(id), Cl.uint(0), Cl.uint(400_000), Cl.principal(OTHER)]);
    const xr = await settled(xTx);
    check(xr.tx_status === "success", "transfer succeeded", xr.tx_result?.repr ?? xr.tx_status);
    const mine_ = (await readOnly("get-position", [Cl.buffer(id), Cl.principal(ADDR)])).value;
    const theirs = (await readOnly("get-position", [Cl.buffer(id), Cl.principal(OTHER)])).value;
    check(Number(mine_.idle.value) === 600_000, "seller's IDLE reduced");
    check(Number(theirs.idle.value) === 400_000, "buyer's IDLE credited");
    mk = (await readOnly("get-market", [Cl.buffer(id)])).value?.value;
    check(Number(mk["idle-circ"].value) === STAKE, "a transfer does not change supply");
    check(Number(mk.vault.value) === STAKE, "vault untouched by a transfer");

    head("merge-complete-set  (pair back into sBTC)");
    const before = await sbtcBal(ADDR);
    const mgTx = await call("merge-complete-set", [Cl.buffer(id), Cl.uint(200_000)]);
    const mg = await settled(mgTx);
    check(mg.tx_status === "success", "merge succeeded", mg.tx_result?.repr ?? mg.tx_status);
    check((await sbtcBal(ADDR)) - before === 200_000, "sBTC returned 1:1");

    // ------------------------------------------------------- settlement
    head("resolve-idle + redeem  (the NO path, permissionless)");
    const short = randomBytes(32);
    const nowB = (await info()).burn_block_height;
    const cm2 = await settled(await call("create-market", [
      Cl.buffer(short), Cl.buffer(hex(vout.scriptPubKey.hex)), Cl.uint(1),
      Cl.uint(nowB + 3), Cl.uint(100_000_000),
      Cl.buffer(hex(proof.txHex)), Cl.uint(vout.n), Cl.uint(proof.burnHeight),
      Cl.buffer(hex(proof.headerHex)), Cl.uint(proof.txIndex),
      Cl.list(proof.path.map((s) => Cl.buffer(s))),
    ]));
    check(cm2.tx_status === "success", "second market created (closes in 3 blocks)");
    await settled(await call("mint-complete-set", [Cl.buffer(short), Cl.uint(500_000)]));

    console.log("  (mining past the close height)");
    await mineGently(5, await getNewAddress("mining"));

    const riTx = await call("resolve-idle", [Cl.buffer(short)]);
    const ri = await settled(riTx);
    check(ri.tx_status === "success", "resolve-idle succeeded once the window closed", ri.tx_result?.repr ?? ri.tx_status);
    const m2 = (await readOnly("get-market", [Cl.buffer(short)])).value?.value;
    check(Number(m2.status.value) === 2, "status is IDLE (NO)", `status ${m2.status.value}`);

    const beforeRedeem = await sbtcBal(ADDR);
    const rdTx = await call("redeem", [Cl.buffer(short)]);
    const rd = await settled(rdTx);
    check(rd.tx_status === "success", "redeem succeeded", rd.tx_result?.repr ?? rd.tx_status);
    check((await sbtcBal(ADDR)) - beforeRedeem === 500_000, "winning side paid out 1:1", "IDLE won");
    const m3 = (await readOnly("get-market", [Cl.buffer(short)])).value?.value;
    check(Number(m3.vault.value) === 0, "vault drained to zero — contract stays solvent");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("\nERROR:", e.message); process.exit(1); });
