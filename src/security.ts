import type { Env } from "./platform.js";

const encoder = new TextEncoder();

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function verifyDiscordSignature(
  env: Env,
  timestamp: string | null,
  signature: string | null,
  body: string
): Promise<boolean> {
  if (!timestamp || !signature) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isInteger(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 5 * 60) return false;
  if (typeof env.DISCORD_PUBLIC_KEY !== "string") return false;
  const publicKeyBytes = fromHex(env.DISCORD_PUBLIC_KEY);
  const signatureBytes = fromHex(signature);
  if (!publicKeyBytes || !signatureBytes) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      asArrayBuffer(publicKeyBytes),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      asArrayBuffer(signatureBytes),
      encoder.encode(timestamp + body)
    );
  } catch (error) {
    console.error("Discord signature verification failed:", error);
    return false;
  }
}

export async function verifyGatewayRequest(
  env: Env,
  request: Request,
  body: Uint8Array
): Promise<boolean> {
  if (typeof env.GATEWAY_SHARED_SECRET !== "string" || env.GATEWAY_SHARED_SECRET.length < 32) return false;
  const timestamp = request.headers.get("x-koryuu-timestamp");
  const nonce = request.headers.get("x-koryuu-nonce");
  const signature = request.headers.get("x-koryuu-signature");
  const actorId = request.headers.get("x-koryuu-actor") ?? "";
  const contentType = request.headers.get("content-type") ?? "";
  const fileName = request.headers.get("x-koryuu-file-name") ?? "";
  const seconds = Number(timestamp);
  if (
    !timestamp || !nonce || !signature ||
    !Number.isInteger(seconds) ||
    Math.abs(Date.now() / 1000 - seconds) > 60 ||
    !/^[0-9a-f-]{36}$/i.test(nonce)
  ) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.GATEWAY_SHARED_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const prefix = encoder.encode(
    `${timestamp}.${nonce}.${request.method}.${new URL(request.url).pathname}.${actorId}.${contentType}.${fileName}.`
  );
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix);
  message.set(body, prefix.length);
  const expected = toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, message)));
  if (expected.length !== signature.length) return false;

  let mismatch = 0;
  for (let index = 0; index < expected.length; index++) {
    mismatch |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  }
  if (mismatch !== 0) return false;

  const result = await env.DB.prepare(
    "INSERT INTO gateway_request_nonces(nonce, created_at) VALUES (?, ?) ON CONFLICT(nonce) DO NOTHING"
  ).bind(nonce, seconds).run();
  return result.meta?.changes === 1;
}

export function jsonResponse(
  value: unknown,
  status = 200,
  headers?: HeadersInit
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  return new Response(JSON.stringify(value), {
    status,
    headers: responseHeaders
  });
}

export function discordResponse(data: Record<string, unknown>, status = 200): Response {
  return jsonResponse(data, status);
}
