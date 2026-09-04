// Reads a market back off devnet.
//
//   node scripts/devnet/read-market.mjs 0x<32-byte market id>
//
// A market only exists if create-market's SPV checks passed, so a populated
// row here is proof that the burn-header binding and the merkle proof were
// both verified on chain against real Bitcoin.

import { Cl, cvToJSON, serializeCV, hexToCV } from "@stacks/transactions";

const NODE = process.env.STACKS_NODE ?? "http://127.0.0.1:20443";
const ADDRESS = process.env.CONTRACT_ADDRESS ?? "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";

const id = process.argv[2];
if (!id) { console.error("usage: read-market.mjs 0x<market-id>"); process.exit(1); }

const arg = serializeCV(Cl.buffer(Buffer.from(id.replace(/^0x/, ""), "hex")));

const res = await fetch(
  `${NODE}/v2/contracts/call-read/${ADDRESS}/at-stake/get-market`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sender: ADDRESS, arguments: [arg] }),
  },
).then((r) => r.json());

if (!res.okay) { console.error("read failed:", res.cause ?? res); process.exit(1); }

const val = cvToJSON(hexToCV(res.result));
if (val.value === null || val.type === "none") {
  console.log("no such market — create-market did not succeed");
  process.exit(1);
}
const m = val.value.value;
const n = (k) => m[k]?.value;
console.log("market       :", id);
console.log("script       :", n("script"));
console.log("bond-index   :", n("bond-index"));
console.log("close-height :", n("close-height"));
console.log("snapshot-sats:", n("snapshot-sats"), "(proven on Bitcoin)");
console.log("threshold    :", n("threshold-sats"));
console.log("status       :", n("status"), "(0 open, 1 bonded, 2 idle)");
console.log("vault        :", n("vault"));
