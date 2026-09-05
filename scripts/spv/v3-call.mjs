import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { makeContractCall, broadcastTransaction, Cl, PostConditionMode } from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";
import { generateWallet } from "@stacks/wallet-sdk";
const ADDR="SP5Y3W3F78NKFH4HYFNDQMJC484VZWKDH35ZR2M9", NAME="at-stake-v3";
export async function call(fn, args, fee=20000) {
  const m = readFileSync(`${homedir()}/.at-stake/deployer.key`,"utf8").trim();
  const key = (await generateWallet({secretKey:m,password:""})).accounts[0].stxPrivateKey;
  const tx = await makeContractCall({ contractAddress:ADDR, contractName:NAME,
    functionName:fn, functionArgs:args, senderKey:key, network:STACKS_MAINNET,
    postConditionMode:PostConditionMode.Allow, fee:BigInt(fee) });
  const r = await broadcastTransaction({transaction:tx, network:STACKS_MAINNET});
  if (r.error) throw new Error(`${fn}: ${r.error} ${r.reason??""} ${JSON.stringify(r.reason_data??{})}`);
  console.log(`${fn} -> https://explorer.hiro.so/txid/0x${r.txid}?chain=mainnet`);
  return r.txid;
}
export async function settled(txid, tries=60) {
  for (let i=0;i<tries;i++){
    const r=await fetch(`https://api.hiro.so/extended/v1/tx/0x${txid.replace(/^0x/,"")}`).then(r=>r.json()).catch(()=>null);
    if (r && r.tx_status && r.tx_status!=="pending") return r;
    await new Promise(s=>setTimeout(s,10000));
  }
  throw new Error("never settled");
}
