import { test } from "node:test";
import assert from "node:assert/strict";
import { b64u, encryptPayload, unb64u, vapidAuth } from "../src/webpush.ts";
import { inQuiet, wants } from "../src/notify.ts";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/settings.ts";

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}
const enc = new TextEncoder();
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

test("web push: aes128gcm payload decrypts on the receiver side (RFC 8291)", async () => {
  // The browser's keys.
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const uaPub = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const msg = { title: "Світло зникло", body: "Батарея 80%." };
  const body = await encryptPayload(b64u(uaPub), b64u(auth), enc.encode(JSON.stringify(msg)));

  // Parse the header and decrypt like a browser.
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idlen = body[20];
  const asPub = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  assert.equal(rs, 4096);
  assert.equal(idlen, 65);
  const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, cat(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const k = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, k, ct));
  assert.equal(plain[plain.length - 1], 2);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plain.slice(0, -1))), msg);
});

test("web push: VAPID JWT verifies with the public key", async () => {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey) as ArrayBuffer);
  const h = await vapidAuth("https://fcm.googleapis.com/fcm/send/abc", { publicKey: b64u(pub), privateKey: jwk.d!, subject: "mailto:a@b.c" }, 1_800_000_000_000);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!;
  assert.ok(m);
  const claims = JSON.parse(new TextDecoder().decode(unb64u(m[2])));
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.exp, 1_800_000_000 + 12 * 3600);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, kp.publicKey, unb64u(m[3]), enc.encode(`${m[1]}.${m[2]}`));
  assert.equal(ok, true);
});

test("notifications: quiet hours (over midnight), per-type toggles", () => {
  const s = mergeSettings(DEFAULT_SETTINGS, { quiet: { on: true, from: "23:00", to: "07:00" } });
  const kyiv = (hhmm: string) => Date.parse(`2026-11-13T${hhmm}:00+02:00`);
  assert.equal(inQuiet(s, kyiv("23:30")), true);
  assert.equal(inQuiet(s, kyiv("03:00")), true);
  assert.equal(inQuiet(s, kyiv("07:00")), false);
  assert.equal(inQuiet(s, kyiv("12:00")), false);
  assert.equal(wants(s, "grid", kyiv("03:00")), false);
  assert.equal(wants(s, "wont_last", kyiv("03:00")), true);
  assert.equal(wants(s, "stale", kyiv("12:00")), false); // off by default
  assert.equal(wants(mergeSettings(s, { notify: { generator_soon: true }, neighbour: false }), "generator_soon", kyiv("12:00")), false);
});
