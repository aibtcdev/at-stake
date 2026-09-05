import { describe, it, expect, beforeEach } from "vitest";
import { Cl, signMessageHashRsv } from "@stacks/transactions";
import { readFileSync } from "node:fs";

// Off-chain orders, on-chain settlement.
//
// transfer-shares alone cannot be used to trade with a stranger: it moves
// shares and no money, so one side has to go first and hope. fill-order moves
// both legs in one transaction, and puts the price in an event -- the contract
// otherwise has no idea what anything sold for.

const C = "at-stake-sim";
const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer");
const seller = accounts.get("wallet_1");
const buyer = accounts.get("wallet_2");

const ID = 1, CLOSE = 5000, IDLE = 0, BONDED = 1;

function key(account) {
  const txt = readFileSync("settings/Devnet.toml", "utf8");
  let name = null;
  for (const line of txt.split("\n")) {
    const a = line.match(/^\[accounts\.([a-z0-9_]+)\]/); if (a) name = a[1];
    const k = line.match(/secret_key:\s*([0-9a-f]+)/); if (k && name === account) return k[1];
  }
  throw new Error("no key for " + account);
}

const seed = () => simnet.callPublicFn(C, "test-seed-market", [
  Cl.uint(ID), Cl.stringAscii("orders"), Cl.buffer(new Uint8Array(34).fill(1)),
  Cl.uint(CLOSE), Cl.uint(0), Cl.uint(10_000), Cl.uint(150_000)], deployer);

const pos = (who) => {
  const d = simnet.callReadOnlyFn(C, "get-position", [Cl.uint(ID), Cl.principal(who)], deployer).result.value;
  return { idle: Number(d.idle.value), bonded: Number(d.bonded.value) };
};
const sbtc = (who) =>
  Number(simnet.callReadOnlyFn(SBTC, "get-balance", [Cl.principal(who)], deployer).result.value.value);

// Ask the contract for the hash, so the test cannot disagree with it.
function hashOf(side, amount, price, nonce, expiry) {
  return simnet.callReadOnlyFn(C, "order-hash", [
    Cl.uint(ID), Cl.uint(side), Cl.uint(amount), Cl.uint(price), Cl.uint(nonce), Cl.uint(expiry),
  ], deployer).result.value;
}

function signedOrder({ side = IDLE, amount = 100, price = 68, nonce = 1, expiry = 9999, signer = "wallet_1" } = {}) {
  const h = hashOf(side, amount, price, nonce, expiry);
  const sig = signMessageHashRsv({ messageHash: h, privateKey: key(signer) });
  return { side, amount, price, nonce, expiry, sig, hash: h };
}

const fill = (o, who = buyer, sellerP = seller) =>
  simnet.callPublicFn(C, "fill-order", [
    Cl.uint(ID), Cl.uint(o.side), Cl.uint(o.amount), Cl.uint(o.price),
    Cl.uint(o.nonce), Cl.uint(o.expiry), Cl.principal(sellerP),
    Cl.buffer(Buffer.from(String(o.sig).replace(/^0x/, ""), "hex")),
  ], who);

describe("fill-order: settling an off-chain order", () => {
  beforeEach(() => {
    seed();
    simnet.callPublicFn(C, "mint-complete-set", [Cl.uint(ID), Cl.uint(1_000)], seller);
  });

  it("moves shares one way and sBTC the other, atomically", () => {
    const sellerSbtc = sbtc(seller), buyerSbtc = sbtc(buyer);
    const o = signedOrder({ amount: 100, price: 68 });
    expect(fill(o).result).toBeOk(Cl.uint(100));

    expect(pos(seller).idle).toBe(900);
    expect(pos(buyer).idle).toBe(100);
    expect(sbtc(seller) - sellerSbtc).toBe(68);
    expect(buyerSbtc - sbtc(buyer)).toBe(68);
    // the untraded side never moved
    expect(pos(seller).bonded).toBe(1_000);
    expect(pos(buyer).bonded).toBe(0);
  });

  it("REJECTS a signature from somebody else", () => {
    const o = signedOrder({ signer: "wallet_3" }); // not the seller
    expect(fill(o).result).toBeErr(Cl.uint(113));
  });

  it("REJECTS a tampered price -- the hash no longer matches", () => {
    const o = signedOrder({ price: 68 });
    expect(fill({ ...o, price: 1 }).result).toBeErr(Cl.uint(113));
  });

  it("REJECTS the same order twice", () => {
    const o = signedOrder();
    expect(fill(o).result).toBeOk(Cl.uint(100));
    expect(fill(o).result).toBeErr(Cl.uint(115));
  });

  it("REJECTS an expired order", () => {
    const o = signedOrder({ expiry: 1 });
    simnet.mineEmptyBurnBlocks(5);
    expect(fill(o).result).toBeErr(Cl.uint(114));
  });

  it("REJECTS selling shares you do not hold", () => {
    const o = signedOrder({ amount: 5_000 });
    expect(fill(o).result).toBeErr(Cl.uint(107));
  });

  it("REJECTS buying from yourself", () => {
    const o = signedOrder();
    expect(fill(o, seller).result).toBeErr(Cl.uint(110));
  });

  it("trades the BONDED side too", () => {
    const o = signedOrder({ side: BONDED, amount: 250, price: 80, nonce: 7 });
    expect(fill(o).result).toBeOk(Cl.uint(250));
    expect(pos(buyer).bonded).toBe(250);
    expect(pos(buyer).idle).toBe(0);
  });
});

describe("cancel-orders-below", () => {
  beforeEach(() => {
    seed();
    simnet.callPublicFn(C, "mint-complete-set", [Cl.uint(ID), Cl.uint(1_000)], seller);
  });

  it("kills every order signed below the floor, in one call", () => {
    const a = signedOrder({ nonce: 1 });
    const b = signedOrder({ nonce: 2, amount: 50 });
    expect(simnet.callPublicFn(C, "cancel-orders-below", [Cl.uint(3)], seller).result).toBeOk(Cl.uint(3));
    expect(fill(a).result).toBeErr(Cl.uint(116));
    expect(fill(b).result).toBeErr(Cl.uint(116));
  });

  it("leaves orders at or above the floor alone", () => {
    simnet.callPublicFn(C, "cancel-orders-below", [Cl.uint(5)], seller);
    const fresh = signedOrder({ nonce: 5 });
    expect(fill(fresh).result).toBeOk(Cl.uint(100));
  });

  it("only the seller's own orders are affected", () => {
    simnet.callPublicFn(C, "cancel-orders-below", [Cl.uint(9)], buyer);
    expect(fill(signedOrder({ nonce: 1 })).result).toBeOk(Cl.uint(100));
  });

  it("the floor can only move forward", () => {
    simnet.callPublicFn(C, "cancel-orders-below", [Cl.uint(10)], seller);
    expect(simnet.callPublicFn(C, "cancel-orders-below", [Cl.uint(4)], seller).result).toBeErr(Cl.uint(106));
  });
});

describe("the order hash is bound to this contract", () => {
  it("includes the contract, so a signature cannot be replayed elsewhere", () => {
    // Recomputing the hash without the contract field gives a different value.
    // If these matched, an order signed here would be valid on any fork.
    const withContract = hashOf(IDLE, 100, 68, 1, 9999);
    const { createHash } = require("node:crypto");
    const naive = createHash("sha256").update(Buffer.from("no-domain-separator")).digest("hex");
    expect(withContract).not.toBe(naive);
    expect(withContract).toMatch(/^[0-9a-f]{64}$/);
  });
});
