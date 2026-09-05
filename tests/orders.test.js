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
function hashOf(side, amount, price, nonce, expiry, sellerP = seller) {
  return simnet.callReadOnlyFn(C, "order-hash", [
    Cl.principal(sellerP), Cl.uint(ID), Cl.uint(side), Cl.uint(amount),
    Cl.uint(price), Cl.uint(nonce), Cl.uint(expiry),
  ], deployer).result.value;
}

function signedOrder({ side = IDLE, amount = 100, price = 68, nonce = 1, expiry = 9999,
                       signer = "wallet_1", sellerP = seller } = {}) {
  const h = hashOf(side, amount, price, nonce, expiry, sellerP);
  const sig = signMessageHashRsv({ messageHash: h, privateKey: key(signer) });
  return { side, amount, price, nonce, expiry, sig, hash: h };
}

const fill = (o, who = buyer, sellerP = seller, fillAmount = null) =>
  simnet.callPublicFn(C, "fill-order", [
    Cl.uint(ID), Cl.uint(o.side), Cl.uint(o.amount), Cl.uint(o.price),
    Cl.uint(o.nonce), Cl.uint(o.expiry), Cl.principal(sellerP),
    Cl.buffer(Buffer.from(String(o.sig).replace(/^0x/, ""), "hex")),
    Cl.uint(fillAmount ?? o.amount),
  ], who);

const filledSoFar = (o) =>
  Number(simnet.callReadOnlyFn(C, "order-filled",
    [Cl.buffer(Buffer.from(String(o.hash).replace(/^0x/, ""), "hex"))], deployer).result.value);
const priceFor = (o, n) =>
  Number(simnet.callReadOnlyFn(C, "fill-price",
    [Cl.uint(o.price), Cl.uint(o.amount), Cl.uint(n)], deployer).result.value);

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
    const o = signedOrder({ signer: "wallet_3" }); // hash names the seller, key does not
    expect(fill(o).result).toBeErr(Cl.uint(113));
  });

  it("REJECTS a tampered price -- the hash no longer matches", () => {
    const o = signedOrder({ price: 68 });
    expect(fill({ ...o, price: 1 }).result).toBeErr(Cl.uint(113));
  });

  it("REJECTS taking more than is left", () => {
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


describe("partial fills", () => {
  beforeEach(() => {
    seed();
    simnet.callPublicFn(C, "mint-complete-set", [Cl.uint(ID), Cl.uint(5_000)], seller);
  });

  it("a buyer can take a slice and leave the rest", () => {
    const o = signedOrder({ amount: 1_000, price: 680, nonce: 11 });
    expect(fill(o, buyer, seller, 300).result).toBeOk(Cl.uint(300));
    expect(pos(buyer).idle).toBe(300);
    expect(filledSoFar(o)).toBe(300);
  });

  it("several buyers can share one order until it is exhausted", () => {
    const o = signedOrder({ amount: 1_000, price: 680, nonce: 12 });
    expect(fill(o, buyer, seller, 400).result).toBeOk(Cl.uint(400));
    expect(fill(o, accounts.get("wallet_3"), seller, 600).result).toBeOk(Cl.uint(600));
    expect(filledSoFar(o)).toBe(1_000);
    // and now there is nothing left
    expect(fill(o, accounts.get("wallet_4"), seller, 1).result).toBeErr(Cl.uint(115));
  });

  it("REJECTS taking more than remains", () => {
    const o = signedOrder({ amount: 1_000, price: 680, nonce: 13 });
    fill(o, buyer, seller, 900);
    expect(fill(o, buyer, seller, 200).result).toBeErr(Cl.uint(118));
  });

  it("charges pro-rata, and the buyer pays it", () => {
    const o = signedOrder({ amount: 1_000, price: 680, nonce: 14 });
    const before = sbtc(seller);
    fill(o, buyer, seller, 500);
    expect(sbtc(seller) - before).toBe(340);       // half of 680
  });
});

describe("the rounding must favour the seller", () => {
  beforeEach(() => {
    seed();
    simnet.callPublicFn(C, "mint-complete-set", [Cl.uint(ID), Cl.uint(5_000)], seller);
  });

  it("one share of a 1000-share order is NOT free", () => {
    // floor division would make this 680 * 1 / 1000 = 0, and the whole order
    // could then be taken apart for nothing.
    const o = signedOrder({ amount: 1_000, price: 680, nonce: 21 });
    expect(priceFor(o, 1)).toBe(1);
    expect(priceFor(o, 1)).toBeGreaterThan(0);
  });

  it("a fraction always rounds up, never down", () => {
    const o = signedOrder({ amount: 1_000, price: 680, nonce: 22 });
    expect(priceFor(o, 3)).toBe(3);      // 2.04 -> 3
    expect(priceFor(o, 100)).toBe(68);   // exact stays exact
    expect(priceFor(o, 999)).toBe(680);  // 679.32 -> 680
  });

  it("the whole order still costs exactly the asking price", () => {
    const o = signedOrder({ amount: 1_000, price: 680, nonce: 23 });
    expect(priceFor(o, 1_000)).toBe(680);
  });
});

describe("the minimum-fill guard", () => {
  beforeEach(() => {
    seed();
    simnet.callPublicFn(C, "mint-complete-set", [Cl.uint(ID), Cl.uint(5_000)], seller);
  });

  it("REJECTS a nibble far below the floor", () => {
    // 1% of 1000 is 10, so a single share is grief, not a trade
    const o = signedOrder({ amount: 1_000, price: 680, nonce: 31 });
    expect(fill(o, buyer, seller, 1).result).toBeErr(Cl.uint(117));
  });

  it("accepts exactly the floor", () => {
    const o = signedOrder({ amount: 1_000, price: 680, nonce: 32 });
    expect(fill(o, buyer, seller, 10).result).toBeOk(Cl.uint(10));
  });

  it("lets the tail be cleared however small it is", () => {
    // otherwise the last few shares of every order would be stranded
    const o = signedOrder({ amount: 1_000, price: 680, nonce: 33 });
    fill(o, buyer, seller, 995);
    expect(fill(o, accounts.get("wallet_3"), seller, 5).result).toBeOk(Cl.uint(5));
  });

  it("a tiny order is fillable in one go", () => {
    const o = signedOrder({ amount: 5, price: 4, nonce: 34 });
    expect(fill(o, buyer, seller, 5).result).toBeOk(Cl.uint(5));
  });
});


describe("two sellers offering identical terms", () => {
  it("do not share a fill counter", () => {
    // Before the seller was in the hash, both orders hashed the same, so
    // filling one marked the other spent -- a free way to kill someone's offer.
    seed();
    simnet.callPublicFn(C, "mint-complete-set", [Cl.uint(ID), Cl.uint(1_000)], seller);
    simnet.callPublicFn(C, "mint-complete-set", [Cl.uint(ID), Cl.uint(1_000)], buyer);
    const carol = accounts.get("wallet_3"), dave = accounts.get("wallet_4");

    const fromSeller = signedOrder({ nonce: 1 });
    const fromBuyer  = signedOrder({ nonce: 1, signer: "wallet_2", sellerP: buyer });
    expect(fromSeller.hash).not.toBe(fromBuyer.hash);

    expect(fill(fromSeller, carol, seller).result).toBeOk(Cl.uint(100));
    expect(fill(fromBuyer,  dave,  buyer ).result).toBeOk(Cl.uint(100));
  });
});

describe("the gap between the deadline and resolve-idle", () => {
  // Past close-height nobody has bonded, so IDLE has certainly won -- but the
  // market only flips to IDLE when somebody bothers to call resolve-idle.
  // Trading in that gap is buying a known winner off whoever left an order up.
  beforeEach(() => {
    seed();
    simnet.callPublicFn(C, "mint-complete-set", [Cl.uint(ID), Cl.uint(1_000)], seller);
  });

  it("REFUSES to fill an order once the deadline has passed", () => {
    const o = signedOrder({ nonce: 41 });
    simnet.mineEmptyBurnBlocks(CLOSE + 10);
    expect(fill(o).result).toBeErr(Cl.uint(103));
  });

  it("REFUSES a plain transfer once the deadline has passed", () => {
    simnet.mineEmptyBurnBlocks(CLOSE + 10);
    expect(simnet.callPublicFn(C, "transfer-shares",
      [Cl.uint(ID), Cl.uint(IDLE), Cl.uint(10), Cl.principal(buyer)], seller).result)
      .toBeErr(Cl.uint(103));
  });

  it("still lets you merge out -- handing back a pair cannot be gamed", () => {
    simnet.mineEmptyBurnBlocks(CLOSE + 10);
    expect(simnet.callPublicFn(C, "merge-complete-set",
      [Cl.uint(ID), Cl.uint(500)], seller).result).toBeOk(Cl.uint(500));
  });
});
