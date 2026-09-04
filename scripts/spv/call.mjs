// Call a function on the mainnet At Stake contract.
//   node scripts/spv/call.mjs <function> <json-args-file-or-inline>
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { makeContractCall, broadcastTransaction, Cl, PostConditionMode } from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";
import { generateWallet } from "@stacks/wallet-sdk";

const ADDR = process.env.CONTRACT_ADDRESS ?? "SP5Y3W3F78NKFH4HYFNDQMJC484VZWKDH35ZR2M9";
const NAME = process.env.CONTRACT_NAME ?? "at-stake-v2";

export async function senderKey() {
  const m = readFileSync(`${homedir()}/.at-stake/deployer.key`, "utf8").trim();
  return (await generateWallet({ secretKey: m, password: "" })).accounts[0].stxPrivateKey;
}

export async function call(functionName, functionArgs, fee = 20000) {
  const tx = await makeContractCall({
    contractAddress: ADDR, contractName: NAME, functionName, functionArgs,
    senderKey: await senderKey(), network: STACKS_MAINNET,
    postConditionMode: PostConditionMode.Allow,   // moves sBTC in and out of escrow
    fee: BigInt(fee),
  });
  const res = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if (res.error) throw new Error(`${functionName}: ${res.error} ${res.reason ?? ""} ${JSON.stringify(res.reason_data ?? {})}`);
  console.log(`${functionName} -> https://explorer.hiro.so/txid/0x${res.txid}?chain=mainnet`);
  return res.txid;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const MARKET = Buffer.from("fab06a536002d851906237efbbd43bcbc84a78f409519765e98103fa886ec510","hex");
  await call("mint-complete-set", [Cl.buffer(MARKET), Cl.uint(Number(process.argv[2] ?? 400))]);
}
