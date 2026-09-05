import { describe, it, expect } from "vitest";
import { Cl } from "@stacks/transactions";

// The bug this file exists for:
//
// get-burn-block-info? returns the burn block hash in DISPLAY order, but
// sha256d(header) is INTERNAL order. at-stake compared them directly, so the
// header check could never pass on a real Bitcoin block -- create-market and
// resolve-bonded were both permanently broken on mainnet.
//
// The whole suite stayed green throughout, because build-sim.sh compiles a
// SIM-SKIP-HEADER constant that bypasses exactly that assert. It took a real
// mainnet transaction, and an ERR_BAD_HEADER, to surface it.
//
// This test needs no chain. It is pure hashing against a real mainnet block,
// so it would have caught the bug in milliseconds.

const C = "at-stake-sim";
const deployer = simnet.getAccounts().get("deployer");

// Bitcoin mainnet block 965,335 -- the block that proved the snapshot in the
// first market At Stake ever settled.
const HEADER = "00800020da83711cf7fdc4c29d528ed777358a07dda6301a76ab0100000000000000000095f4a1b721f0ea7205bca60c4a603a6764bc697464b8b9b58d948ff683702cb7358a996ac13c0217f32adffd";
const BLOCK_HASH = "000000000000000000010684344616e48765a778c7380066ef0064c23d4edea8";

const hex = (h) => Buffer.from(h, "hex");
const call = (fn, args) =>
  simnet.callReadOnlyFn(C, fn, args, deployer).result.value;

describe("burn header byte order", () => {
  it("the header is 80 bytes", () => {
    expect(hex(HEADER).length).toBe(80);
  });

  it("sha256d(header) is NOT the block hash -- it is byte-reversed", () => {
    const internal = call("sha256d", [Cl.buffer(hex(HEADER))]);
    expect(internal).not.toBe(BLOCK_HASH);
  });

  it("reverse-buff32(sha256d(header)) IS the block hash", () => {
    const internal = call("sha256d", [Cl.buffer(hex(HEADER))]);
    const reversed = call("reverse-buff32", [Cl.buffer(hex(internal))]);
    expect(reversed).toBe(BLOCK_HASH);
  });

  it("reverse-buff32 is its own inverse", () => {
    const once = call("reverse-buff32", [Cl.buffer(hex(BLOCK_HASH))]);
    const twice = call("reverse-buff32", [Cl.buffer(hex(once))]);
    expect(twice).toBe(BLOCK_HASH);
  });

  it("the merkle root sits at bytes 36..68 of the header", () => {
    // slice? returns an optional, so unwrap once more
    const root = simnet.callReadOnlyFn(C, "header-merkle-root",
      [Cl.buffer(hex(HEADER))], deployer).result.value.value;
    expect(root).toBe(HEADER.slice(72, 136));
  });
});
