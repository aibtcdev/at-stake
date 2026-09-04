// Verifies the devnet rig can produce a proof at-stake would accept.
//
//   node scripts/devnet/check.mjs
//
// Mines a little regtest chain, pays an address, confirms it, then turns that
// transaction into the exact arguments create-market takes. If this prints a
// proof, the Bitcoin side of the pipeline works and the burn-header check will
// pass for real -- the one thing simnet cannot show you.

import { rpc, getBlockCount, mine, getNewAddress } from "./bitcoin-rpc.mjs";
import { buildProof } from "./build-proof.mjs";

const clarityBuff = (b) => `0x${Buffer.from(b).toString("hex")}`;

async function ensureWallet() {
  const wallets = await rpc("listwallets");
  if (wallets.length) return wallets[0];
  try { await rpc("createwallet", ["at-stake"]); }
  catch { await rpc("loadwallet", ["at-stake"]); }
  return "at-stake";
}

async function main() {
  console.log("bitcoind:", await rpc("getblockchaininfo").then((i) => `${i.chain} @ height ${i.blocks}`));
  await ensureWallet();

  // Coinbase outputs need 100 confirmations before they are spendable.
  let height = await getBlockCount();
  if (height < 101) {
    console.log(`mining ${101 - height} blocks to reach coinbase maturity...`);
    await mine(101 - height);
    height = await getBlockCount();
  }

  const addr = await getNewAddress("subject-wallet");
  console.log("subject wallet:", addr);

  // 1 BTC, because MIN_SNAPSHOT_SATS in at-stake.clar is u100000000.
  const txid = await rpc("sendtoaddress", [addr, 1.0]);
  console.log("funding txid:", txid);
  await mine(1);

  const p = await buildProof(txid);
  console.log("\n--- proof, ready for create-market ---");
  console.log("burn-height :", p.burnHeight);
  console.log("tx-index    :", p.txIndex);
  console.log("header      :", clarityBuff(Buffer.from(p.headerHex, "hex")));
  console.log("merkle-path : (list");
  for (const s of p.path) console.log("                ", clarityBuff(s));
  console.log("              )");
  console.log("snap-tx     :", `0x${p.txHex}`);
  console.log(`\nproof depth ${p.path.length}/14, non-witness tx ${p.txHex.length / 2} bytes`);
  console.log("merkle root and txid both verified against the block header.");
}

main().catch((e) => {
  console.error("\nFAILED:", e.message);
  console.error("\nIs devnet up, and is 18443 reachable? For a remote VPS:");
  console.error("  ssh -N -L 18443:127.0.0.1:18443 -L 20443:127.0.0.1:20443 user@your-vps");
  process.exit(1);
});
