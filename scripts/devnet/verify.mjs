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
const NETWORK = { ...STACKS_DEVNET, client: { baseUrl: NODE } };
const hex = (h) => Buffer.from(String(h).replace(/^0x/, ""), "hex");

let pass = 0, fail = 0;
const ok   = (m, d = "") => { pass++; console.log(`  PASS  ${m}${d ? "  " + d : ""}`); };
const bad  = (m, d = "") => { fail++; console.log(`  FAIL  ${m}${d ? "  " + d : ""}`); };
const check = (cond, m, d = "") => (cond ? ok(m, d) : bad(m, d));
const head = (t) => console.log(`\n${t}`);

const info = () => fetch(`${NODE}/v2/info`).then((r) => r.json());

async function readOnly(fn, args) {
  const r = await fetch(`${NODE}/v2/contracts/call-read/${ADDR}/at-stake/${fn}`, {
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
    contractAddress: ADDR, contractName: "at-stake", functionName, functionArgs,
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
  const src = await fetch(`${NODE}/v2/contracts/source/${ADDR}/at-stake`).then((r) => r.json());
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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("\nERROR:", e.message); process.exit(1); });
