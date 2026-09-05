// Create a v3 market on mainnet. The contract assigns the id and returns it.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { makeContractCall, broadcastTransaction, Cl, PostConditionMode } from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";
import { generateWallet } from "@stacks/wallet-sdk";
import { mainnetProof } from "./mainnet-proof.mjs";

const ADDR = "SP5Y3W3F78NKFH4HYFNDQMJC484VZWKDH35ZR2M9";
const NAME = process.env.CONTRACT_NAME ?? "at-stake-v3";
const hex = (h) => Buffer.from(String(h).replace(/^0x/, ""), "hex");

const [txid, vout, closeHeight, threshold, ...titleWords] = process.argv.slice(2);
const title = titleWords.join(" ");

const m = readFileSync(`${homedir()}/.at-stake/deployer.key`, "utf8").trim();
const key = (await generateWallet({ secretKey: m, password: "" })).accounts[0].stxPrivateKey;

const p = await mainnetProof(txid, Number(vout));
console.log("title        :", title);
console.log("subject      :", p.address);
console.log("snapshot     :", p.valueSats.toLocaleString(), "sats @ block", p.blockHeight);
console.log("threshold    :", Number(threshold).toLocaleString(), "sats");
console.log("close-height :", closeHeight);
if (Number(threshold) > p.valueSats) { console.error("threshold exceeds snapshot — v3 will reject"); process.exit(1); }

const tx = await makeContractCall({
  contractAddress: ADDR, contractName: NAME, functionName: "create-market",
  functionArgs: [
    Cl.stringAscii(title),
    Cl.buffer(hex(p.scriptPubKey)),
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
  postConditionMode: PostConditionMode.Deny, fee: 20000n,
});
const res = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
if (res.error) { console.error("FAILED:", res.error, res.reason ?? "", JSON.stringify(res.reason_data ?? {})); process.exit(1); }
console.log("\ntxid    :", res.txid);
console.log("explorer:", `https://explorer.hiro.so/txid/0x${res.txid}?chain=mainnet`);
