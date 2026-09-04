// Create an At Stake market on mainnet from real Bitcoin data.
//
//   node scripts/spv/create-market-mainnet.mjs <snap-txid> <vout> <close-height> <threshold-sats> <bond-index>

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { makeContractCall, broadcastTransaction, Cl, PostConditionMode } from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";
import { generateWallet } from "@stacks/wallet-sdk";
import { mainnetProof } from "./mainnet-proof.mjs";

const ADDR = process.env.CONTRACT_ADDRESS ?? "SP5Y3W3F78NKFH4HYFNDQMJC484VZWKDH35ZR2M9";
const NAME = process.env.CONTRACT_NAME ?? "at-stake";
const hex = (h) => Buffer.from(String(h).replace(/^0x/, ""), "hex");

const [txid, vout, closeHeight, threshold, bondIndex] = process.argv.slice(2);

const mnemonic = readFileSync(`${homedir()}/.at-stake/deployer.key`, "utf8").trim();
const key = (await generateWallet({ secretKey: mnemonic, password: "" })).accounts[0].stxPrivateKey;

const p = await mainnetProof(txid, Number(vout));
const id = randomBytes(32);

console.log("market id     :", `0x${id.toString("hex")}`);
console.log("subject wallet:", p.address);
console.log("snapshot      :", p.valueSats.toLocaleString(), "sats @ bitcoin block", p.blockHeight);
console.log("close-height  :", closeHeight, "| threshold", Number(threshold).toLocaleString(), "sats | bond", bondIndex);

const tx = await makeContractCall({
  contractAddress: ADDR, contractName: NAME, functionName: "create-market",
  functionArgs: [
    Cl.buffer(id),
    Cl.buffer(hex(p.scriptPubKey)),
    Cl.uint(Number(bondIndex)),
    Cl.uint(Number(closeHeight)),
    Cl.uint(Number(threshold)),
    Cl.buffer(hex(p.txHex)),
    Cl.uint(Number(vout)),
    Cl.uint(p.blockHeight),
    Cl.buffer(hex(p.headerHex)),
    Cl.uint(p.txIndex),
    Cl.list(p.path.map((h) => Cl.buffer(h))),
  ],
  senderKey: key, network: STACKS_MAINNET,
  postConditionMode: PostConditionMode.Deny,
  fee: BigInt(process.env.FEE ?? 20000),
});

const res = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
if (res.error) { console.error("FAILED:", res.error, res.reason ?? "", JSON.stringify(res.reason_data ?? {})); process.exit(1); }
console.log("\ntxid    :", res.txid);
console.log("explorer:", `https://explorer.hiro.so/txid/0x${res.txid}?chain=mainnet`);
