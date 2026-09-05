// Drive at-stake-v5 on mainnet.
//
//   node scripts/spv/v5.mjs create <txid> <vout> <bond-index> <close-height> <threshold> <title...>
//   node scripts/spv/v5.mjs snapshot <id> <txid> <vout>
//   node scripts/spv/v5.mjs mint <id> <sats>
//   node scripts/spv/v5.mjs merge <id> <sats>
//   node scripts/spv/v5.mjs transfer <id> <side> <amount> <to>
//   node scripts/spv/v5.mjs cancel <min-nonce>
//   node scripts/spv/v5.mjs resolve-idle <id>
//   node scripts/spv/v5.mjs redeem <id>
//   node scripts/spv/v5.mjs read <fn> [args...]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  makeContractCall, broadcastTransaction, fetchCallReadOnlyFunction,
  Cl, cvToString, PostConditionMode, Pc,
} from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";
import { generateWallet } from "@stacks/wallet-sdk";
import { mainnetProof } from "./mainnet-proof.mjs";

const ADDR = "SP5Y3W3F78NKFH4HYFNDQMJC484VZWKDH35ZR2M9";
const NAME = process.env.CONTRACT_NAME ?? "at-stake-v5";
const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const hex = (h) => Buffer.from(String(h).replace(/^0x/, ""), "hex");

async function key() {
  const m = readFileSync(`${homedir()}/.at-stake/deployer.key`, "utf8").trim();
  return (await generateWallet({ secretKey: m, password: "" })).accounts[0].stxPrivateKey;
}

async function call(fn, args, postConditions = [], mode = PostConditionMode.Deny) {
  const tx = await makeContractCall({
    contractAddress: ADDR, contractName: NAME, functionName: fn, functionArgs: args,
    senderKey: await key(), network: STACKS_MAINNET,
    postConditionMode: mode, postConditions, fee: BigInt(process.env.FEE ?? 25000),
  });
  const r = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if (r.error) throw new Error(`${fn}: ${r.error} ${r.reason ?? ""} ${JSON.stringify(r.reason_data ?? {})}`);
  console.log(`  ${fn} -> 0x${r.txid}`);
  return r.txid;
}

export async function settled(txid, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`https://api.hiro.so/extended/v1/tx/0x${txid.replace(/^0x/, "")}`)
      .then((x) => x.json()).catch(() => null);
    if (r && r.tx_status && r.tx_status !== "pending") return r;
    await new Promise((s) => setTimeout(s, 10000));
  }
  throw new Error("never settled");
}

const read = (fn, args = []) => fetchCallReadOnlyFunction({
  contractAddress: ADDR, contractName: NAME, functionName: fn,
  functionArgs: args, network: STACKS_MAINNET, senderAddress: ADDR,
});

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "create") {
  const [txid, vout, bondIndex, closeHeight, threshold, ...title] = rest;
  const p = await mainnetProof(txid, Number(vout));
  console.log("  subject   :", p.address);
  console.log("  snapshot  :", p.valueSats.toLocaleString(), "sats @ block", p.blockHeight);
  console.log("  bond-index:", bondIndex, "| close", closeHeight, "| threshold", threshold);
  await call("create-market", [
    Cl.stringAscii(title.join(" ")), Cl.buffer(hex(p.scriptPubKey)),
    Cl.uint(Number(bondIndex)), Cl.uint(Number(closeHeight)), Cl.uint(Number(threshold)),
    Cl.buffer(hex(p.txHex)), Cl.uint(Number(vout)), Cl.uint(p.blockHeight),
    Cl.buffer(hex(p.headerHex)), Cl.uint(p.txIndex), Cl.uint(p.txCount),
    Cl.list(p.path.map((h) => Cl.buffer(h))),
  ]);
} else if (cmd === "snapshot") {
  const [id, txid, vout] = rest;
  const p = await mainnetProof(txid, Number(vout));
  await call("add-snapshot", [
    Cl.uint(Number(id)), Cl.buffer(hex(p.txHex)), Cl.uint(Number(vout)),
    Cl.uint(p.blockHeight), Cl.buffer(hex(p.headerHex)),
    Cl.uint(p.txIndex), Cl.uint(p.txCount), Cl.list(p.path.map((h) => Cl.buffer(h))),
  ]);
} else if (cmd === "mint") {
  const [id, sats] = rest;
  await call("mint-complete-set", [Cl.uint(Number(id)), Cl.uint(Number(sats))],
    [Pc.principal(ADDR).willSendEq(Number(sats)).ft(SBTC, "sbtc-token")]);
} else if (cmd === "merge") {
  const [id, sats] = rest;
  await call("merge-complete-set", [Cl.uint(Number(id)), Cl.uint(Number(sats))],
    [Pc.principal(`${ADDR}.${NAME}`).willSendEq(Number(sats)).ft(SBTC, "sbtc-token")]);
} else if (cmd === "transfer") {
  const [id, side, amount, to] = rest;
  await call("transfer-shares",
    [Cl.uint(Number(id)), Cl.uint(Number(side)), Cl.uint(Number(amount)), Cl.principal(to)]);
} else if (cmd === "cancel") {
  await call("cancel-orders-below", [Cl.uint(Number(rest[0]))]);
} else if (cmd === "resolve-idle") {
  await call("resolve-idle", [Cl.uint(Number(rest[0]))]);
} else if (cmd === "redeem") {
  await call("redeem", [Cl.uint(Number(rest[0]))],
    [Pc.principal(`${ADDR}.${NAME}`).willSendGte(1).ft(SBTC, "sbtc-token")]);
} else if (cmd === "read") {
  const [fn, ...args] = rest;
  const cv = args.map((a) => (a.startsWith("SP") || a.startsWith("ST")
    ? Cl.principal(a) : a.startsWith("0x") ? Cl.buffer(hex(a)) : Cl.uint(Number(a))));
  console.log(cvToString(await read(fn, cv)));
} else {
  console.error("unknown command:", cmd);
  process.exit(1);
}
