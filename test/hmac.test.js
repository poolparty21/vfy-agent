// HMAC contract tests.
//
// The platform signs the RAW request body and puts the digest in
// `x-agent-games-signature`. The secret is shown once as 32 random bytes
// (64 hex chars), and the docs do not say whether the platform keys the HMAC
// with the hex TEXT or the DECODED BYTES, so both must verify.

import { test } from "node:test";
import assert from "node:assert/strict";
import { verifySignature, signBody, parseSignature, hmacHex, keyForms } from "../src/hmac.js";

const SECRET_TEXT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const enc = new TextEncoder();

test("a signature made with the secret text verifies", async () => {
  const body = enc.encode(JSON.stringify({ type: "agent-games.preflight.v1" }));
  const sig = await hmacHex(enc.encode(SECRET_TEXT), body);
  const res = await verifySignature(SECRET_TEXT, body, sig);
  assert.equal(res.ok, true);
  assert.equal(res.keyForm, "text");
});

test("a signature made with the decoded hex bytes also verifies", async () => {
  const body = enc.encode("{}");
  const key = Uint8Array.from(SECRET_TEXT.match(/../g), (b) => parseInt(b, 16));
  const sig = await hmacHex(key, body);
  const res = await verifySignature(SECRET_TEXT, body, sig);
  assert.equal(res.ok, true);
  assert.equal(res.keyForm, "hex");
});

test("a sha256= prefixed signature verifies and keeps the prefix", async () => {
  const body = enc.encode("{}");
  const sig = await hmacHex(enc.encode(SECRET_TEXT), body);
  const res = await verifySignature(SECRET_TEXT, body, `sha256=${sig}`);
  assert.equal(res.ok, true);
  assert.equal(res.prefix, "sha256=");
});

test("a wrong signature is rejected", async () => {
  const body = enc.encode("{}");
  const res = await verifySignature(SECRET_TEXT, body, "0".repeat(64));
  assert.equal(res.ok, false);
});

test("a signature over a different body is rejected", async () => {
  const body = enc.encode('{"a":1}');
  const other = enc.encode('{"a":2}');
  const sig = await hmacHex(enc.encode(SECRET_TEXT), other);
  const res = await verifySignature(SECRET_TEXT, body, sig);
  assert.equal(res.ok, false);
});

test("an empty signature header is rejected", async () => {
  const res = await verifySignature(SECRET_TEXT, enc.encode("{}"), "");
  assert.equal(res.ok, false);
});

test("responses are signed the same way they are verified", async () => {
  const body = enc.encode('{"ok":true}');
  const sig = await signBody(SECRET_TEXT, body);
  const res = await verifySignature(SECRET_TEXT, body, sig);
  assert.equal(res.ok, true);
});

test("keyForms offers text and, for hex secrets, the decoded bytes", () => {
  const forms = keyForms(SECRET_TEXT).map((f) => f.form);
  assert.ok(forms.includes("text"));
  assert.ok(forms.includes("hex"));
  // A non-hex secret only has the text form.
  assert.equal(keyForms("not-hex!").length, 1);
});

test("parseSignature splits an algo prefix off a digest", () => {
  assert.deepEqual(parseSignature("sha256=ABC"), { prefix: "sha256=", digest: "abc" });
  assert.deepEqual(parseSignature("ABC"), { prefix: "", digest: "abc" });
});
