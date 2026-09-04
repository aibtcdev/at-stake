// Deploy a contract to Stacks mainnet with an explicit Clarity version.
//
//   node scripts/deploy/mainnet.mjs contracts/btc-parse.clar btc-parse
//
// The key is read from a file, never from an argument, so it does not land in
// shell history. Clarity 6 / epoch 4.0 is stated explicitly: at-stake calls
// pox-5, which needs it, and defaulting to an older version silently produces
// a contract that cannot compile against it.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  makeContractDeploy, broadcastTransaction, ClarityVersion, PostConditionMode,
} from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";
import { generateWallet } from "@stacks/wallet-sdk";

const [file, name] = process.argv.slice(2);
if (!file || !name) {
  console.error("usage: mainnet.mjs <path/to/contract.clar> <contract-name>");
  process.exit(1);
}

const KEY_FILE = process.env.KEY_FILE ?? `${homedir()}/.at-stake/deployer.key`;

async function senderKey() {
  const raw = readFileSync(KEY_FILE, "utf8").trim();
  // a raw private key, or a mnemonic we derive account 0 from
  if (/^[0-9a-f]{64}(01)?$/i.test(raw)) return raw;
  const wallet = await generateWallet({ secretKey: raw, password: "" });
  return wallet.accounts[0].stxPrivateKey;
}

const codeBody = readFileSync(file, "utf8");
const key = await senderKey();

const tx = await makeContractDeploy({
  contractName: name,
  codeBody,
  senderKey: key,
  network: STACKS_MAINNET,
  clarityVersion: ClarityVersion.Clarity6,
  postConditionMode: PostConditionMode.Deny,
  fee: BigInt(process.env.FEE ?? 60_000),
});

console.log(`deploying ${name} (${codeBody.length} bytes, clarity 6)`);
const res = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
if (res.error) {
  console.error("FAILED:", res.error, res.reason ?? "", JSON.stringify(res.reason_data ?? {}));
  process.exit(1);
}
console.log("txid    :", res.txid);
console.log("explorer:", `https://explorer.hiro.so/txid/0x${res.txid}?chain=mainnet`);
