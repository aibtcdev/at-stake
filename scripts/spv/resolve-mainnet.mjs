import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Cl } from "@stacks/transactions";
import { call } from "./call.mjs";

const L = JSON.parse(readFileSync("/tmp/lockup.json","utf8"));
const W = JSON.parse(readFileSync("/tmp/witness.json","utf8"));
const hx = (h)=>Buffer.from(String(h).replace(/^0x/,""),"hex");
const sha256=(b)=>createHash("sha256").update(b).digest();
const sha256d=(b)=>sha256(sha256(b));

const witness = hx(W.witness);
const commit  = hx("f4e35c300097271275aa40ce603e1a0a");   // prefix, for locating
const offset  = witness.indexOf(commit);
console.log("  commitment offset:", offset);

// snapshot txid as the contract computed it: sha256d over the NON-WITNESS tx
const snapTxHex = readFileSync("/tmp/snap_tx.hex","utf8").trim();
const snapTxid  = sha256d(hx(snapTxHex));
console.log("  snap txid (internal):", snapTxid.toString("hex"));

const MARKET = hx("fab06a536002d851906237efbbd43bcbc84a78f409519765e98103fa886ec510");
await call("resolve-bonded", [
  Cl.buffer(MARKET),
  Cl.principal("SP38S7KVNENN7BGKW76VN1840PFMDHMA674C0FSZY"),
  Cl.buffer(hx(L.tx)),
  Cl.uint(L["output-index"]),
  Cl.uint(L.height),
  Cl.buffer(hx(L.header)),
  Cl.uint(L["tx-index"]),
  Cl.list(L.leaf_hashes.map(h=>Cl.buffer(hx(h)))),
  Cl.buffer(witness),
  Cl.uint(offset),
  Cl.buffer(snapTxid),
  Cl.uint(0),
], 30000);
