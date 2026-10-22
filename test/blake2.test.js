// BLAKE2b-256 tests.
//
// A Substrate transaction hash is blake2_256 of the encoded extrinsic, so
// this has to be exactly right: the proof-reference lookup compares our
// computed hash with the platform's proof_tx.

import { test } from "node:test";
import assert from "node:assert/strict";
import { blake2b256, blake2b256Hex } from "../src/blake2.js";

const enc = new TextEncoder();
const hex = (bytes) => "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

test("blake2b-256 matches the RFC 7693 test vector for the empty input", () => {
  assert.equal(
    hex(blake2b256(enc.encode(""))),
    "0x0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8",
  );
});

test("blake2b-256 matches the RFC 7693 test vector for 'abc'", () => {
  assert.equal(
    hex(blake2b256(enc.encode("abc"))),
    "0xbddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319",
  );
});

test("blake2b-256 of a 128-byte block (exact block size) is stable", () => {
  const input = new Uint8Array(128).fill(0x61);
  assert.match(hex(blake2b256(input)), /^0x[0-9a-f]{64}$/);
});

test("blake2b-256 of a multi-block input is stable", () => {
  const input = new Uint8Array(300).fill(0x62);
  assert.match(hex(blake2b256(input)), /^0x[0-9a-f]{64}$/);
});

test("blake2b256Hex parses a hex string with or without the 0x prefix", () => {
  const expected = hex(blake2b256(enc.encode("abc")));
  assert.equal(blake2b256Hex("616263"), expected);
  assert.equal(blake2b256Hex("0x616263"), expected);
});
