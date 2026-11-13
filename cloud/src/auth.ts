// Cloudflare Access JWT check (defense in depth behind the Access application) and PUSH_KEY check.

interface Jwk extends JsonWebKey { kid: string }

let jwksCache: { url: string; keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function getKeys(teamDomain: string, force = false): Promise<Jwk[]> {
  const url = `${teamDomain.replace(/\/$/, "")}/cdn-cgi/access/certs`;
  if (!force && jwksCache && jwksCache.url === url && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`JWKS fetch ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  jwksCache = { url, keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Returns the user's email (or "service:<client id>" for a service token) if the Access JWT is valid, otherwise null. */
export async function verifyAccess(request: Request, teamDomain: string, aud: string): Promise<string | null> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const dec = new TextDecoder();
    const header = JSON.parse(dec.decode(b64urlDecode(parts[0]))) as { alg: string; kid: string };
    const payload = JSON.parse(dec.decode(b64urlDecode(parts[1]))) as {
      aud: string | string[]; exp: number; nbf?: number; iss: string; email?: string; common_name?: string;
    };
    if (header.alg !== "RS256") return null;

    let keys = await getKeys(teamDomain);
    let jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) {
      keys = await getKeys(teamDomain, true); // key rotation
      jwk = keys.find((k) => k.kid === header.kid);
    }
    if (!jwk) return null;

    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", key, b64urlDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!ok) return null;

    const now = Date.now() / 1000;
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) return null;
    if (payload.exp < now - 30) return null;
    if (payload.nbf && payload.nbf > now + 30) return null;
    if (payload.iss.replace(/\/$/, "") !== teamDomain.replace(/\/$/, "")) return null;
    // Users have an email; Access service tokens (e.g. Home Assistant) have only common_name (the client id).
    if (payload.email) return payload.email;
    if (payload.common_name) return `service:${payload.common_name}`;
    return null;
  } catch {
    return null;
  }
}

/** Constant-time bearer key check (compares SHA-256 digests). */
export async function checkBearer(request: Request, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  const auth = request.headers.get("Authorization") ?? "";
  const m = /^Bearer (.+)$/.exec(auth);
  if (!m) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(m[1])),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}
