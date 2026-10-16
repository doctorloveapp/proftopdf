import "server-only";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { getServerConfig } from "./config";
import { getRedis } from "./redis";
import { enforceRateLimit } from "./quota";
import { RouteError } from "./http-core";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  credentialRevision,
  createSessionToken,
  readSessionToken,
  equalSecret,
  clientAddressKey,
} from "./auth-crypto";

interface SessionRecord {
  csrfToken: string;
  expiresAt: number;
  revision: string;
}
export interface Session extends SessionRecord {
  id: string;
}

function authConfig() {
  const config = getServerConfig();
  if (!config.SESSION_SECRET || !config.APP_ACCESS_PASSWORD)
    throw new RouteError(
      503,
      "AUTH_UNAVAILABLE",
      "Accesso temporaneamente non disponibile.",
    );
  return {
    ...config,
    SESSION_SECRET: config.SESSION_SECRET,
    APP_ACCESS_PASSWORD: config.APP_ACCESS_PASSWORD,
  };
}
function recordKey(id: string) {
  return `proftopdf:v1:session:${id}`;
}

export async function resolveSession(
  token: string | undefined,
): Promise<Session | null> {
  if (!token) return null;
  const config = authConfig();
  const revision = credentialRevision(
    config.APP_ACCESS_PASSWORD,
    config.SESSION_SECRET,
  );
  const id = readSessionToken(token, config.SESSION_SECRET, revision);
  if (!id) return null;
  const record = await getRedis().get<SessionRecord>(recordKey(id));
  if (
    !record ||
    record.expiresAt <= Date.now() ||
    record.revision !== revision ||
    !/^[A-Za-z0-9_-]{43}$/.test(record.csrfToken)
  )
    return null;
  return { ...record, id };
}
export async function currentSession() {
  return resolveSession((await cookies()).get(SESSION_COOKIE)?.value);
}
export async function requireSession(
  request: NextRequest,
  csrf = false,
): Promise<Session> {
  const session = await resolveSession(
    request.cookies.get(SESSION_COOKIE)?.value,
  );
  if (!session)
    throw new RouteError(401, "UNAUTHENTICATED", "Accedi per continuare.");
  if (
    csrf &&
    !equalSecret(
      request.headers.get("x-csrf-token") ?? "",
      session.csrfToken,
      authConfig().SESSION_SECRET,
    )
  ) {
    throw new RouteError(
      403,
      "INVALID_CSRF",
      "Sessione da aggiornare. Ricarica la pagina e riprova.",
    );
  }
  return session;
}

export async function login(request: NextRequest, password: string) {
  const config = authConfig();
  // Vercel overwrites x-forwarded-for at ingress; never store raw addresses.
  const candidate =
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "";
  const address = isIP(candidate) ? candidate : "unknown";
  await enforceRateLimit(
    [
      `login:${clientAddressKey(address, config.SESSION_SECRET)}`,
      "login:global",
    ],
    [
      { limit: 10, windowMs: 900_000 },
      { limit: 100, windowMs: 900_000 },
    ],
  );
  if (!equalSecret(password, config.APP_ACCESS_PASSWORD, config.SESSION_SECRET))
    throw new RouteError(401, "INVALID_CREDENTIALS", "Password non corretta.");
  const revision = credentialRevision(
    config.APP_ACCESS_PASSWORD,
    config.SESSION_SECRET,
  );
  const { id, token } = createSessionToken(config.SESSION_SECRET, revision);
  const record: SessionRecord = {
    csrfToken: randomBytes(32).toString("base64url"),
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
    revision,
  };
  await getRedis().set(recordKey(id), record, { ex: SESSION_TTL_SECONDS });
  // Rotate any valid previous session rather than leaving it alive.
  const previous = request.cookies.get(SESSION_COOKIE)?.value;
  const oldId = previous
    ? readSessionToken(previous, config.SESSION_SECRET, revision)
    : null;
  if (oldId) await getRedis().del(recordKey(oldId));
  return { token, session: { ...record, id } };
}
export async function revokeSession(session: Session) {
  await getRedis().del(recordKey(session.id));
}
export function publicSession(session: Session) {
  return {
    authenticated: true as const,
    csrfToken: session.csrfToken,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}
