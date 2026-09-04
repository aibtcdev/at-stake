import { describe, it, expect } from "vitest";
import { Cl } from "@stacks/transactions";
import { createHash } from "node:crypto";

const deployer = simnet.getAccounts().get("deployer");
const C = "at-stake-sim";

const sha256d = (b) =>
  createHash("sha256").update(createHash("sha256").update(b).digest()).digest();

// Build a Bitcoin merkle tree exactly the way Bitcoin does, including the
// odd-node duplication rule, and emit the sibling path for one leaf.
function buildTree(leaves) {
  const levels = [leaves];
  let cur = leaves;
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      const a = cur[i];
      const b = i + 1 < cur.length ? cur[i + 1] : cur[i]; // duplicate last
      next.push(sha256d(Buffer.concat([a, b])));
    }
    levels.push(next);
    cur = next;
  }
  return levels;
}

function proofFor(levels, index) {
  const path = [];
  let idx = index;
  for (let lvl = 0; lvl < levels.length - 1; lvl++) {
    const layer = levels[lvl];
    const sibIdx = idx % 2 === 0 ? Math.min(idx + 1, layer.length - 1) : idx - 1;
    path.push(layer[sibIdx]);
    idx = Math.floor(idx / 2);
  }
  return path;
}

function clarityRoot(leaf, index, path) {
  const r = simnet.callReadOnlyFn(
    C,
    "merkle-root-from-proof",
    [Cl.buffer(leaf), Cl.uint(index), Cl.list(path.map((p) => Cl.buffer(p)))],
    deployer
  );
  return Buffer.from(r.result.value, "hex");
}

function randomTxids(n) {
  return Array.from({ length: n }, (_, i) =>
    sha256d(Buffer.from(`tx-${i}-${n}`))
  );
}

describe("bitcoin merkle verifier in clarity", () => {
  it("matches JS for a 2-tx block", () => {
    const leaves = randomTxids(2);
    const levels = buildTree(leaves);
    for (let i = 0; i < 2; i++) {
      expect(clarityRoot(leaves[i], i, proofFor(levels, i))).toEqual(
        levels[levels.length - 1][0]
      );
    }
  });

  it("matches JS for an 8-tx block at every index", () => {
    const leaves = randomTxids(8);
    const levels = buildTree(leaves);
    const root = levels[levels.length - 1][0];
    for (let i = 0; i < 8; i++) {
      expect(clarityRoot(leaves[i], i, proofFor(levels, i))).toEqual(root);
    }
  });

  it("matches JS for an odd-sized block (7 txs, duplication rule)", () => {
    const leaves = randomTxids(7);
    const levels = buildTree(leaves);
    const root = levels[levels.length - 1][0];
    for (let i = 0; i < 7; i++) {
      expect(clarityRoot(leaves[i], i, proofFor(levels, i))).toEqual(root);
    }
  });

  it("handles a realistic block depth (4096 txs, 12-deep proof)", () => {
    const leaves = randomTxids(4096);
    const levels = buildTree(leaves);
    const root = levels[levels.length - 1][0];
    const idx = 2731;
    const path = proofFor(levels, idx);
    expect(path.length).toBe(12);
    expect(clarityRoot(leaves[idx], idx, path)).toEqual(root);
  });

  it("REJECTS a tampered transaction", () => {
    const leaves = randomTxids(8);
    const levels = buildTree(leaves);
    const root = levels[levels.length - 1][0];
    const fake = sha256d(Buffer.from("i made this up"));
    expect(clarityRoot(fake, 3, proofFor(levels, 3))).not.toEqual(root);
  });

  it("REJECTS a real tx claimed at the wrong index", () => {
    const leaves = randomTxids(8);
    const levels = buildTree(leaves);
    const root = levels[levels.length - 1][0];
    expect(clarityRoot(leaves[3], 5, proofFor(levels, 3))).not.toEqual(root);
  });

  it("COST: what a 12-deep verification actually burns", () => {
    const leaves = randomTxids(4096);
    const levels = buildTree(leaves);
    const idx = 2731;
    const path = proofFor(levels, idx);
    const r = simnet.callPublicFn(
      C,
      "test-cost-merkle",
      [Cl.buffer(leaves[idx]), Cl.uint(idx), Cl.list(path.map((p) => Cl.buffer(p)))],
      deployer
    );
    console.log("\n=== 12-deep merkle proof cost ===");
    console.log(JSON.stringify(r.costs, null, 2));
    expect(r.costs).toBeDefined();
  });
});
