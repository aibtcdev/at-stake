// Build an At Stake SPV proof from mainnet Bitcoin, via mempool.space.
//
//   node scripts/spv/mainnet-proof.mjs <txid> <vout>
//
// Two things to get right, both of which silently produce a wrong answer:
//
//  1. NON-WITNESS serialization. The txid is the double-sha of the legacy
//     encoding; the segwit encoding hashes to the wtxid and will never match.
//  2. BYTE ORDER. mempool.space reports txids and merkle hashes reversed for
//     display. Merkle math and the root inside the header are internal order.
//
// The computed root is checked against the block header before anything is
// printed, so a proof that comes out of here is one the contract will accept.

import { createHash } from "node:crypto";
import { stripWitness } from "./build-proof.mjs";

const API = process.env.BTC_API ?? "https://mempool.space/api";
const sha256 = (b) => createHash("sha256").update(b).digest();
const sha256d = (b) => sha256(sha256(b));
const rev = (b) => Buffer.from(b).reverse();
const get = async (p) => {
  const r = await fetch(`${API}${p}`);
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : r.text();
};

export async function mainnetProof(txid, vout) {
  const info = await get(`/tx/${txid}`);
  if (!info.status?.confirmed) throw new Error("transaction is not confirmed");
  const blockHeight = info.status.block_height;
  const blockHash = info.status.block_hash;

  const legacy = stripWitness(await get(`/tx/${txid}/hex`));
  const ourTxid = sha256d(legacy);
  if (ourTxid.toString("hex") !== rev(Buffer.from(txid, "hex")).toString("hex")) {
    throw new Error("non-witness serialization does not hash to the reported txid");
  }

  const headerHex = await get(`/block/${blockHash}/header`);
  const header = Buffer.from(headerHex, "hex");
  const headerRoot = header.subarray(36, 68);

  // mempool gives display order; the contract folds internal order
  const mp = await get(`/tx/${txid}/merkle-proof`);
  const path = mp.merkle.map((h) => rev(Buffer.from(h, "hex")));

  let acc = ourTxid, idx = mp.pos;
  for (const sib of path) {
    acc = idx % 2 === 1 ? sha256d(Buffer.concat([sib, acc])) : sha256d(Buffer.concat([acc, sib]));
    idx = Math.floor(idx / 2);
  }
  if (!acc.equals(headerRoot)) throw new Error("computed merkle root does not match the block header");
  if (path.length > 14) throw new Error(`proof ${path.length} deep; contract accepts 14`);

  const out = info.vout[vout];
  if (!out) throw new Error(`no output ${vout}`);

  return {
    txHex: legacy.toString("hex"),
    headerHex, blockHeight,
    txIndex: mp.pos,
    path,
    scriptPubKey: out.scriptpubkey,
    address: out.scriptpubkey_address,
    valueSats: out.value,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [txid, vout] = process.argv.slice(2);
  const p = await mainnetProof(txid, Number(vout ?? 0));
  console.log("  bitcoin block :", p.blockHeight);
  console.log("  tx-index      :", p.txIndex, "| merkle depth", p.path.length);
  console.log("  output value  :", p.valueSats.toLocaleString(), "sats");
  console.log("  address       :", p.address);
  console.log("  scriptPubKey  :", p.scriptPubKey);
  console.log("  non-witness tx:", p.txHex.length / 2, "bytes");
  console.log("  merkle root verified against the real block header");
}
