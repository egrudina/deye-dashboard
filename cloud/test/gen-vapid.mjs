// Prints a new VAPID key pair (base64url) for the Worker secrets VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
const b64u = (b) => Buffer.from(b).toString("base64url");
console.log(`VAPID_PUBLIC_KEY=${b64u(raw)}\nVAPID_PRIVATE_KEY=${jwk.d}`);
