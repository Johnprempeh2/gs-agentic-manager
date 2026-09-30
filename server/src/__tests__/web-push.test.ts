import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { encryptPushPayload, generateVapidKeys, sendWebPush, vapidAuthorization } from "../services/web-push.js";

const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

/** Decrypt as the browser does (RFC 8291 / RFC 8188), independent of the sender code. */
function decryptAsBrowser(body: Buffer, uaPrivate: Buffer, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLength = body[20]!;
  const asPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);
  const ua = createECDH("prime256v1");
  ua.setPrivateKey(uaPrivate);
  const ecdhSecret = ua.computeSecret(asPublic);
  const ikm = hmac(
    hmac(authSecret, ecdhSecret),
    Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic, Buffer.from([1])]),
  );
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  expect(padded[padded.length - 1]).toBe(2);
  return padded.subarray(0, padded.length - 1).toString();
}

describe("web push encryption (RFC 8291)", () => {
  it("matches the RFC 8291 Appendix A example byte for byte", () => {
    const server = createECDH("prime256v1");
    server.setPrivateKey(Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url"));
    expect(server.getPublicKey().toString("base64url")).toBe(
      "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
    );
    const body = encryptPushPayload(
      Buffer.from("When I grow up, I want to be a watermelon"),
      {
        p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        auth: "BTBZMqHH6r4Tts7J_aSIgg",
      },
      { salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"), serverKeys: server },
    );
    expect(body.toString("base64url")).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("round-trips a fresh message that only the browser can read", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = randomBytes(16);
    const message = JSON.stringify({ title: "Decision needed", body: "GRE-259 Sidebar", url: "/GRE/decisions" });
    const body = encryptPushPayload(Buffer.from(message), {
      p256dh: ua.getPublicKey().toString("base64url"),
      auth: auth.toString("base64url"),
    });
    expect(decryptAsBrowser(body, ua.getPrivateKey(), auth)).toBe(message);
    expect(body.toString()).not.toContain("Decision needed");
  });

  it("refuses malformed subscription keys", () => {
    expect(() => encryptPushPayload(Buffer.from("x"), { p256dh: "AAAA", auth: "AAAA" })).toThrow("Invalid push subscription keys");
  });
});

describe("VAPID (RFC 8292)", () => {
  it("signs a short-lived token for the push service origin that verifies with the public key", () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization("https://web.push.apple.com/QGuQyavXutnMH", keys, "mailto:info@greatstone.co.uk", new Date("2026-09-30T12:00:00Z"));
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, h, c, s, k] = match!;
    expect(k).toBe(keys.publicKey);
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
    expect(claims).toEqual({ aud: "https://web.push.apple.com", exp: Math.floor(Date.parse("2026-09-30T12:00:00Z") / 1000) + 43200, sub: "mailto:info@greatstone.co.uk" });
    const pub = Buffer.from(keys.publicKey, "base64url");
    const publicKey = createPublicKey({
      format: "jwk",
      key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") },
    });
    expect(verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url"))).toBe(true);
  });
});

describe("sendWebPush", () => {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const target = {
    endpoint: "https://web.push.apple.com/abc",
    p256dh: ua.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  };

  it("posts an encrypted aes128gcm body with VAPID auth and a TTL", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 201 }));
    const result = await sendWebPush(target, { title: "t" }, generateVapidKeys(), { subject: "mailto:info@greatstone.co.uk", fetcher });
    expect(result).toEqual({ ok: true, status: 201 });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(target.endpoint);
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers.Authorization).toMatch(/^vapid t=.+, k=/);
    expect(headers.TTL).toBe("86400");
  });

  it("reports a subscription the push service has dropped as gone", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 410 }));
    expect(await sendWebPush(target, {}, generateVapidKeys(), { subject: "mailto:x@y.z", fetcher })).toEqual({ ok: false, status: 410, gone: true });
  });
});
