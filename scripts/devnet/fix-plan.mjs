// Clarinet generates a devnet plan that publishes BOTH sBTC requirement sets,
// and on devnet every requirement is remapped under the deployer address --
// so SM3VDXK3....sbtc-token and SN3VMHXEN....sbtc-token both become
// ST1PQHQ....sbtc-token. The second publish fails with ContractAlreadyExists
// and takes the whole deployment down with it.
//
// Both requirements are genuinely needed, just not in the same place: simnet
// funds wallets from the SM3VDXK3 set, while at-stake.clar calls the
// SN3VMHXEN one. So drop the SM3VDXK3 publishes from the DEVNET plan only.
//
//   node scripts/devnet/fix-plan.mjs
//
// Then start devnet with --use-on-disk-deployment-plan so it is not recomputed.
import { readFileSync, writeFileSync } from "node:fs";

const PATH = "deployments/default.devnet-plan.yaml";
const lines = readFileSync(PATH, "utf8").split("\n");

const out = [];
let dropping = false;
for (const line of lines) {
  const isStep = /^\s{4}- transaction-type:/.test(line);
  if (isStep) dropping = false;
  if (isStep && line.includes("requirement-publish")) {
    // look ahead handled by the contract-id check below
  }
  if (/^\s{6}contract-id: SM3VDXK3/.test(line)) {
    // rewind to the start of this step and drop it
    for (let i = out.length - 1; i >= 0; i--) {
      const popped = out.pop();
      if (/^\s{4}- transaction-type:/.test(popped)) break;
    }
    dropping = true;
    continue;
  }
  if (dropping) continue;
  out.push(line);
}
writeFileSync(PATH, out.join("\n"));
const kept = out.filter((l) => /contract-id:|contract-name:/.test(l)).map((l) => l.trim());
console.log("plan now publishes:");
for (const k of kept) console.log("  " + k);
