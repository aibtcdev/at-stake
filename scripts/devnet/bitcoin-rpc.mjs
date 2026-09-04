// Minimal bitcoind JSON-RPC client for the Clarinet devnet node.
//
// Devnet exposes bitcoind on 18443 with the credentials in
// settings/Devnet.toml (devnet/devnet by default). Nothing here is meant to
// touch a node holding real value -- it is a regtest driver.

const RPC_URL = process.env.BTC_RPC_URL ?? "http://127.0.0.1:18443";
const RPC_USER = process.env.BTC_RPC_USER ?? "devnet";
const RPC_PASS = process.env.BTC_RPC_PASS ?? "devnet";

let nextId = 0;

export async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Basic " + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString("base64"),
    },
    body: JSON.stringify({ jsonrpc: "1.0", id: `at-stake-${nextId++}`, method, params }),
  });
  if (!res.ok && res.status !== 500) {
    throw new Error(`bitcoind ${method}: HTTP ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  if (body.error) {
    throw new Error(`bitcoind ${method}: ${body.error.message} (code ${body.error.code})`);
  }
  return body.result;
}

// --- the handful of calls the proof builder needs ---
export const getBlockCount = () => rpc("getblockcount");
export const getBlockHash = (height) => rpc("getblockhash", [height]);
export const getBlock = (hash, verbosity = 1) => rpc("getblock", [hash, verbosity]);
export const getBlockHeaderHex = (hash) => rpc("getblockheader", [hash, false]);
export const getRawTransaction = (txid, blockhash) =>
  rpc("getrawtransaction", blockhash ? [txid, false, blockhash] : [txid, false]);
export const sendRawTransaction = (hex) => rpc("sendrawtransaction", [hex]);
export const generateToAddress = (n, address) => rpc("generatetoaddress", [n, address]);
export const getNewAddress = (label = "", type = "legacy") =>
  rpc("getnewaddress", [label, type]);

// Mine `n` blocks to an address we control, so the chain advances on demand.
export async function mine(n = 1, address) {
  const to = address ?? (await getNewAddress());
  return generateToAddress(n, to);
}
