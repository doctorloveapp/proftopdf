import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "__Host-proftopdf-session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
export const sessionCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "strict",
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
} as const;

function mac(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}
export function equalSecret(
  left: string,
  right: string,
  secret: string,
): boolean {
  return timingSafeEqual(
    Buffer.from(mac(left, secret)),
    Buffer.from(mac(right, secret)),
  );
}
export function credentialRevision(password: string, secret: string) {
  return mac(`credentials:${password}`, secret);
}
export function createSessionToken(secret: string, revision: string) {
  const id = randomBytes(32).toString("base64url");
  return { id, token: `${id}.${mac(`session:${id}:${revision}`, secret)}` };
}
export function readSessionToken(
  token: string,
  secret: string,
  revision: string,
): string | null {
  if (!/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [id, signature] = token.split(".");
  return equalSecret(
    signature,
    mac(`session:${id}:${revision}`, secret),
    secret,
  )
    ? id
    : null;
}
export function clientAddressKey(address: string, secret: string) {
  return mac(`login-ip:${address}`, secret);
}
