import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptText, decryptText, randomToken, sha256Hex, safeEqual, ConfigError, bytesToBase64Url } from "../../src/crypto.js";

const key = Buffer.alloc(32, 7).toString("base64");
const otherKey = Buffer.alloc(32, 9).toString("base64");

test("encrypt/decrypt round trip, with a fresh IV every time", async () => {
  const a = await encryptText("gho_secret", key);
  const b = await encryptText("gho_secret", key);
  assert.notEqual(a, b);
  assert.ok(a.startsWith("v1."));
  assert.ok(!a.includes("gho_secret"));
  assert.equal(await decryptText(a, key), "gho_secret");
});

test("decrypt fails with the wrong key or tampered data", async () => {
  const c = await encryptText("gho_secret", key);
  await assert.rejects(decryptText(c, otherKey));
  const parts = c.split(".");
  const flipped = parts[2][0] === "A" ? "B" + parts[2].slice(1) : "A" + parts[2].slice(1);
  await assert.rejects(decryptText(`${parts[0]}.${parts[1]}.${flipped}`, key));
  await assert.rejects(decryptText("garbage", key));
});

test("encryption key must be 32 bytes of base64", async () => {
  await assert.rejects(encryptText("x", Buffer.alloc(16).toString("base64")), ConfigError);
  await assert.rejects(encryptText("x", ""), ConfigError);
});

test("randomToken is URL-safe with the requested entropy", () => {
  const t = randomToken(32);
  assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(randomToken(32), t);
  assert.equal(bytesToBase64Url(new Uint8Array([251, 255])), "-_8");
});

test("sha256Hex and safeEqual", async () => {
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual(undefined, "a"), false);
});
