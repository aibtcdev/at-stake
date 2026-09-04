// Turns a confirmed Bitcoin transaction into the exact arguments at-stake's
// SPV layer expects.
//
// Two things here are easy to get wrong and both are load-bearing:
//
//  1. NON-WITNESS serialization. A txid is the double-sha of the legacy
//     encoding. bitcoind hands back the segwit encoding for a segwit tx, which
//     hashes to the wtxid instead and will never match a merkle proof. So the
//     marker, flag and witness stanzas are stripped here.
//
//  2. BYTE ORDER. bitcoind reports txids and block hashes reversed, for
//     display. Merkle math -- and the merkle root sitting at bytes 36..68 of
//     the header -- is in internal order. Everything below works in internal
//     order and only reverses at the RPC boundary.

import { createHash } from "node:crypto";
import { rpc, getBlock, getBlockHeaderHex, getRawTransaction } from "./bitcoin-rpc.mjs";

const sha256 = (b) => createHash("sha256").update(b).digest();
export const sha256d = (b) => sha256(sha256(b));
const reverse = (b) => Buffer.from(b).reverse();
const fromDisplay = (hexId) => reverse(Buffer.from(hexId, "hex")); // rpc -> internal

// --- transaction parsing -------------------------------------------------

function readVarInt(buf, pos) {
  const first = buf[pos];
  if (first < 0xfd) return { value: first, size: 1 };
  if (first === 0xfd) return { value: buf.readUInt16LE(pos + 1), size: 3 };
  if (first === 0xfe) return { value: buf.readUInt32LE(pos + 1), size: 5 };
  return { value: Number(buf.readBigUInt64LE(pos + 1)), size: 9 };
}

// Re-serialize a transaction without its witness data.
export function stripWitness(rawHex) {
  const buf = Buffer.from(rawHex, "hex");
  let p = 4; // version
  const segwit = buf[p] === 0x00 && buf[p + 1] === 0x01;
  if (!segwit) return buf; // already legacy

  const parts = [buf.subarray(0, 4)];
  p += 2; // skip marker + flag

  const vin = readVarInt(buf, p);
  const inStart = p;
  p += vin.size;
  for (let i = 0; i < vin.value; i++) {
    p += 36; // prev txid + vout
    const s = readVarInt(buf, p);
    p += s.size + s.value + 4; // script + sequence
  }
  parts.push(buf.subarray(inStart, p));

  const vout = readVarInt(buf, p);
  const outStart = p;
  p += vout.size;
  for (let i = 0; i < vout.value; i++) {
    p += 8; // value
    const s = readVarInt(buf, p);
    p += s.size + s.value;
  }
  parts.push(buf.subarray(outStart, p));

  // witnesses run from here to the final 4-byte locktime; skip them wholesale
  parts.push(buf.subarray(buf.length - 4));
  return Buffer.concat(parts);
}

// --- merkle --------------------------------------------------------------

// Bitcoin duplicates the last node when a level has an odd count.
function buildLevels(leaves) {
  const levels = [leaves];
  let cur = leaves;
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(sha256d(Buffer.concat([cur[i], cur[i + 1] ?? cur[i]])));
    }
    levels.push(next);
    cur = next;
  }
  return levels;
}

// The sibling at each rung, which is exactly what merkle-root-from-proof folds.
function siblingPath(levels, index) {
  const path = [];
  let idx = index;
  for (let l = 0; l < levels.length - 1; l++) {
    const layer = levels[l];
    path.push(layer[idx % 2 === 0 ? Math.min(idx + 1, layer.length - 1) : idx - 1]);
    idx = Math.floor(idx / 2);
  }
  return path;
}

// --- the thing you actually call ----------------------------------------

/**
 * @returns {{
 *   txHex: string,        // NON-witness serialization, for `snap-tx`/`lockup-tx`
 *   txid: Buffer,         // internal order, as the contract computes it
 *   headerHex: string,    // the 80 bytes for `header`
 *   txIndex: number,      // position of the tx in its block
 *   path: Buffer[],       // sibling hashes, for `merkle-path`
 *   burnHeight: number,   // the block's height, for `burn-height`
 * }}
 */
export async function buildProof(txidDisplay) {
  const raw = await getRawTransaction(txidDisplay);
  const legacy = stripWitness(raw);
  const txid = sha256d(legacy);

  // locate the containing block
  const meta = await rpc("getrawtransaction", [txidDisplay, true]);
  if (!meta.blockhash) throw new Error(`${txidDisplay} is not confirmed yet`);

  const block = await getBlock(meta.blockhash, 1);
  const headerHex = await getBlockHeaderHex(meta.blockhash);

  const leaves = block.tx.map(fromDisplay);
  const txIndex = block.tx.findIndex((t) => t === txidDisplay);
  if (txIndex < 0) throw new Error(`${txidDisplay} not listed in block ${meta.blockhash}`);

  // Sanity: our stripped serialization must hash to the txid bitcoind reports.
  if (!txid.equals(leaves[txIndex])) {
    throw new Error(
      "non-witness serialization does not hash to the reported txid -- " +
      "stripWitness is wrong for this transaction");
  }

  const levels = buildLevels(leaves);
  const path = siblingPath(levels, txIndex);

  // Sanity: the path must reproduce the merkle root in the header.
  const headerRoot = Buffer.from(headerHex, "hex").subarray(36, 68);
  let acc = leaves[txIndex], idx = txIndex;
  for (const sib of path) {
    acc = idx % 2 === 1 ? sha256d(Buffer.concat([sib, acc])) : sha256d(Buffer.concat([acc, sib]));
    idx = Math.floor(idx / 2);
  }
  if (!acc.equals(headerRoot)) {
    throw new Error("computed merkle root does not match the block header");
  }
  if (path.length > 14) {
    throw new Error(`proof is ${path.length} deep; the contract accepts at most 14`);
  }

  return {
    txHex: legacy.toString("hex"),
    txid,
    headerHex,
    txIndex,
    path,
    burnHeight: block.height,
  };
}
