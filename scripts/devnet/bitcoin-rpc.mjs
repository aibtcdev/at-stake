// Minimal bitcoind JSON-RPC client for the Clarinet devnet node.
//
// Devnet exposes bitcoind on 18443 with the credentials in
// settings/Devnet.toml (devnet/devnet by default). Nothing here is meant to
// touch a node holding real value -- it is a regtest driver.

const RPC_URL = process.env.BTC_RPC_URL ?? "http://127.0.0.1:18443";
const RPC_USER = process.env.BTC_RPC_USER ?? "devnet";
const RPC_PASS = process.env.BTC_RPC_PASS ?? "devnet";

let nextId = 0;

// Wallet RPCs (getnewaddress, sendtoaddress, ...) must be addressed to a
// specific wallet once more than one is loaded, and devnet always loads its
// own. `wallet` selects the /wallet/<name> endpoint; omit it for chain RPCs.
export async function rpc(method, params = [], wallet) {
  const url = wallet ? `${RPC_URL}/wallet/${encodeURIComponent(wallet)}` : RPC_URL;
  const res = await fetch(url, {
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

// --- chain RPCs (no wallet involved) ---
export const getBlockCount = () => rpc("getblockcount");
export const getBlockHash = (height) => rpc("getblockhash", [height]);
export const getBlock = (hash, verbosity = 1) => rpc("getblock", [hash, verbosity]);
export const getBlockHeaderHex = (hash) => rpc("getblockheader", [hash, false]);
export const getRawTransaction = (txid, blockhash) =>
  rpc("getrawtransaction", blockhash ? [txid, false, blockhash] : [txid, false]);
export const sendRawTransaction = (hex) => rpc("sendrawtransaction", [hex]);
export const generateToAddress = (n, address) => rpc("generatetoaddress", [n, address]);

// --- our own spendable wallet ---
//
// Devnet's bitcoind carries a watch-only wallet with no private keys, so it
// cannot hand out addresses or sign. We keep a separate wallet purely for
// building test transactions and never touch devnet's.
export const WALLET = process.env.BTC_WALLET ?? "at-stake";

export async function ensureWallet(name = WALLET) {
  const loaded = await rpc("listwallets");
  if (loaded.includes(name)) return name;
  try {
    // descriptors + private keys, so we can actually spend
    await rpc("createwallet", [name, false, false, "", false, true, true]);
  } catch (e) {
    if (!/already exists/i.test(e.message)) throw e;
    await rpc("loadwallet", [name]);
  }
  return name;
}

export const getNewAddress = (label = "", type = "bech32", wallet = WALLET) =>
  rpc("getnewaddress", [label, type], wallet);
export const sendToAddress = (address, btc, wallet = WALLET) =>
  rpc("sendtoaddress", [address, btc], wallet);
export const getWalletBalance = (wallet = WALLET) => rpc("getbalance", [], wallet);

// Mine `n` blocks to an address we control, so the chain advances on demand
// and the coinbase rewards land somewhere spendable.
export async function mine(n = 1, address) {
  const to = address ?? (await getNewAddress());
  return generateToAddress(n, to);
}
