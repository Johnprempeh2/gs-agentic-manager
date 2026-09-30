import { createECDH, createHmac, createCipheriv, createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto";

/**
 * Web Push with no dependency (RFC 8030 delivery, RFC 8291 message
 * encryption with aes128gcm from RFC 8188, RFC 8292 VAPID). The browser's
 * push service only relays the encrypted payload; it never sees its content.
 */

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url (65 bytes). Given to the browser. */
  publicKey: string;
  /** P-256 private scalar, base64url (32 bytes). Never leaves the server. */
  privateKey: string;
}

export interface PushTarget {
  endpoint: string;
  /** The browser's P-256 public key, base64url. */
  p256dh: string;
  /** The browser's 16-byte auth secret, base64url. */
  auth: string;
}

export type PushSendResult =
  | { ok: true; status: number }
  /** `gone`: the push service no longer knows this subscription; delete it. */
  | { ok: false; status: number; gone: boolean };

const RECORD_SIZE = 4096;

function b64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

function vapidPrivateKeyObject(keys: VapidKeys): KeyObject {
  const pub = fromB64url(keys.publicKey);
  return createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey,
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
    },
  });
}

/** The VAPID `Authorization` header for one push service origin. */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  now: Date = new Date(),
): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(Buffer.from(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now.getTime() / 1000) + 12 * 60 * 60,
    sub: subject,
  })));
  const unsigned = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(unsigned), {
    key: vapidPrivateKeyObject(keys),
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${unsigned}.${b64url(signature)}, k=${keys.publicKey}`;
}

/**
 * Encrypt one message for one browser (RFC 8291, aes128gcm). `salt` and the
 * server key pair are random per message; tests may pass fixed ones.
 */
export function encryptPushPayload(
  payload: Buffer,
  target: Pick<PushTarget, "p256dh" | "auth">,
  fixed: { salt?: Buffer; serverKeys?: ReturnType<typeof createECDH> } = {},
): Buffer {
  const uaPublic = fromB64url(target.p256dh);
  const authSecret = fromB64url(target.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) {
    throw new Error("Invalid push subscription keys");
  }
  const server = fixed.serverKeys ?? createECDH("prime256v1");
  if (!fixed.serverKeys) server.generateKeys();
  const asPublic = server.getPublicKey();
  const ecdhSecret = server.computeSecret(uaPublic);

  // RFC 8291 section 3.4: combine the ECDH secret with the auth secret.
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);

  // RFC 8188: content key and nonce from the salt.
  const salt = fixed.salt ?? randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);

  // One record: the payload, then the 0x02 last-record delimiter.
  if (payload.length + 1 + 16 > RECORD_SIZE) throw new Error("Push payload too large");
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, body]);
}

/** Send one notification. Never throws for a push-service refusal. */
export async function sendWebPush(
  target: PushTarget,
  message: unknown,
  keys: VapidKeys,
  options: { subject: string; ttlSeconds?: number; fetcher?: typeof fetch } = { subject: "mailto:info@greatstone.co.uk" },
): Promise<PushSendResult> {
  const body = encryptPushPayload(Buffer.from(JSON.stringify(message)), target);
  const response = await (options.fetcher ?? fetch)(target.endpoint, {
    method: "POST",
    headers: {
      Authorization: vapidAuthorization(target.endpoint, keys, options.subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(options.ttlSeconds ?? 24 * 60 * 60),
      Urgency: "high",
    },
    body: new Uint8Array(body),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel().catch(() => undefined);
  if (response.ok) return { ok: true, status: response.status };
  return { ok: false, status: response.status, gone: response.status === 404 || response.status === 410 };
}
