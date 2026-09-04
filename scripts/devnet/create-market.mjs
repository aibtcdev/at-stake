// Creates a market on devnet from a REAL Bitcoin transaction.
//
//   node scripts/devnet/create-market.mjs
//
// This is the path simnet cannot exercise. On devnet the burn chain is a real
// bitcoind, so `get-burn-block-info?` returns genuine header hashes and
// tx-was-mined runs in full -- no SIM-SKIP-HEADER. If this returns (ok ...),
// the header binding and the merkle proof have both been verified on chain
// against Bitcoin.

import { createHash, randomBytes } from "node:crypto";
import {
  makeContractCall, broadcastTransaction, Cl, PostConditionMode,
} from "@stacks/transactions";
import { STACKS_DEVNET } from "@stacks/network";
import {
  rpc, ensureWallet, getNewAddress, sendToAddress, getWalletBalance, mine, WALLET,
} from "./bitcoin-rpc.mjs";
import { buildProof } from "./build-proof.mjs";

const NODE = process.env.STACKS_NODE ?? "http://127.0.0.1:20443";
// STACKS_DEVNET carries the chain id, transaction version and address
// versions; only the endpoint needs overriding (its default is the API on
// 3999, which we do not run).
const NETWORK = { ...STACKS_DEVNET, client: { baseUrl: NODE } };
// Stock Clarinet devnet deployer (ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM).
const DEPLOYER_KEY = process.env.DEPLOYER_KEY
  ?? "753b7cc01a1a2e86221266a154af739463fce51219d97e4f856cd7200c3bd2a601";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS
  ?? "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";

const sha256 = (b) => createHash("sha256").update(b).digest();
const hex = (h) => Buffer.from(String(h).replace(/^0x/, ""), "hex");

const burnHeight = async () =>
  fetch(`${NODE}/v2/info`).then((r) => r.json()).then((i) => i.burn_block_height);

// Mining a burst of blocks floods the Nakamoto signer with sortitions and
// stalls block production outright ("Sortition has timed out"). Feed them in
// small batches and let the Stacks node keep pace.
async function mineGently(total, address, batch = 5) {
  for (let done = 0; done < total; done += batch) {
    await mine(Math.min(batch, total - done), address);
    await waitForNode();
  }
}

// Block until the Stacks node has caught up with bitcoind.
async function waitForNode(slack = 2) {
  for (let i = 0; i < 120; i++) {
    const [btc, stx] = [await rpc("getblockcount"), await burnHeight()];
    if (btc - stx <= slack) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("stacks-node fell behind bitcoind and did not recover");
}

async function main() {
  await ensureWallet();

  // Fund ourselves if this is a fresh chain.
  if ((await getWalletBalance()) < 2) {
    console.log("mining 110 blocks for spendable coinbase (in batches)...");
    await mineGently(110, await getNewAddress("mining"));
    console.log("funded:", await getWalletBalance(), "BTC");
  }

  // The "subject wallet" the market asks about.
  const subject = await getNewAddress("subject");
  console.log("subject wallet :", subject);

  // Its funding transaction. MIN_SNAPSHOT_SATS in at-stake.clar is 1 BTC.
  const txid = await sendToAddress(subject, 1.0);
  await mine(1);
  await waitForNode();
  console.log("funding txid   :", txid);

  // Which output pays the subject, and what is its scriptPubKey?
  const decoded = await rpc("getrawtransaction", [txid, true]);
  const vout = decoded.vout.find((o) => (o.scriptPubKey.address ?? "") === subject);
  if (!vout) throw new Error("could not find the output paying the subject wallet");
  const scriptPubKey = hex(vout.scriptPubKey.hex);
  console.log("snap vout      :", vout.n, `${vout.value} BTC`, `spk=${vout.scriptPubKey.hex}`);

  const proof = await buildProof(txid);
  console.log("proof          : burn", proof.burnHeight, "| tx-index", proof.txIndex,
              "| path depth", proof.path.length);

  const nowBurn = await burnHeight();
  const marketId = randomBytes(32);
  const closeHeight = nowBurn + 500;

  const tx = await makeContractCall({
    contractAddress: CONTRACT_ADDRESS,
    contractName: "at-stake",
    functionName: "create-market",
    functionArgs: [
      Cl.buffer(marketId),
      Cl.buffer(scriptPubKey),
      Cl.uint(1),                                  // bond-index
      Cl.uint(closeHeight),
      Cl.uint(100_000_000),                        // threshold: 1 BTC
      Cl.buffer(hex(proof.txHex)),
      Cl.uint(vout.n),
      Cl.uint(proof.burnHeight),
      Cl.buffer(hex(proof.headerHex)),
      Cl.uint(proof.txIndex),
      Cl.list(proof.path.map((s) => Cl.buffer(s))),
    ],
    senderKey: DEPLOYER_KEY,
    network: NETWORK,
    postConditionMode: PostConditionMode.Deny,
    fee: 10000n,
  });

  console.log("\nbroadcasting create-market (header check LIVE)...");
  const res = await broadcastTransaction({ transaction: tx, network: NETWORK });
  if (res.error) throw new Error(`${res.error} ${res.reason ?? ""} ${JSON.stringify(res.reason_data ?? {})}`);
  console.log("txid:", res.txid);
  console.log("market id:", `0x${marketId.toString("hex")}`);
  console.log("\nwatch it settle:");
  console.log(`  curl -s ${NODE}/v2/info | python3 -c 'import json,sys;print(json.load(sys.stdin)["stacks_tip_height"])'`);
  console.log(`  node scripts/devnet/read-market.mjs 0x${marketId.toString("hex")}`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
