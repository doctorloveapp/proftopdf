import "server-only";
import { randomUUID } from "node:crypto";
import { getRedis } from "../redis";
import { RouteError } from "../http-core";
import { freshCascade, type CascadeState } from "./cascade-core";
interface Stored {
  fingerprint: string;
  state: CascadeState;
  lock?: string;
  started?: boolean;
  leaseUntil?: number;
}
const PREFIX = "proftopdf:v2:llm-route:";
export async function claimRoute(
  id: string,
  fingerprint: string,
  tombstone: string,
  jobIndex: string,
) {
  const token = randomUUID(),
    key = `${PREFIX}${id}`;
  const raw = await getRedis().eval(
    `
if redis.call('EXISTS',KEYS[2])==1 then return 'deleted' end
local clock=redis.call('TIME'); local now=tonumber(clock[1])*1000
local prior=redis.call('GET',KEYS[1]); local record
if prior then record=cjson.decode(prior) else record=cjson.decode(ARGV[3]) end
if record.fingerprint~=ARGV[1] then return 'conflict' end
if record.lock and (record.started or record.leaseUntil>now) then return 'busy' end
record.lock=ARGV[2]; record.started=false; record.leaseUntil=now+120000
redis.call('SET',KEYS[1],cjson.encode(record),'EX',90000)
redis.call('SADD',KEYS[3],KEYS[1]); redis.call('EXPIRE',KEYS[3],90000)
return cjson.encode(record)`,
    [key, tombstone, jobIndex],
    [
      fingerprint,
      token,
      JSON.stringify({ fingerprint, state: freshCascade() }),
    ],
  );
  if (raw === "deleted")
    throw new RouteError(
      410,
      "JOB_DELETED",
      "Questa lezione è stata eliminata.",
    );
  if (raw === "conflict")
    throw new RouteError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Il contenuto della richiesta è cambiato.",
    );
  if (raw === "busy")
    throw new RouteError(
      409,
      "RESULT_UNCERTAIN",
      "Questa unità è già stata avviata. Recupero della stessa operazione in corso.",
      new Date(Date.now() + 15000).toISOString(),
    );
  const record = (typeof raw === "string" ? JSON.parse(raw) : raw) as Stored;
  async function update(
    state: CascadeState,
    mode: "keep" | "start" | "release",
  ) {
    const result = await getRedis().eval(
      `
local raw=redis.call('GET',KEYS[1]); if not raw or redis.call('EXISTS',KEYS[2])==1 then return 0 end
local record=cjson.decode(raw); if record.lock~=ARGV[1] then return 0 end
record.state=cjson.decode(ARGV[2])
if ARGV[3]=='start' then record.started=true end
if ARGV[3]=='release' then record.lock=nil; record.started=false; record.leaseUntil=nil end
redis.call('SET',KEYS[1],cjson.encode(record),'EX',90000); return 1`,
      [key, tombstone],
      [token, JSON.stringify(state), mode],
    );
    if (result !== 1)
      throw new RouteError(
        410,
        "JOB_DELETED",
        "La lezione è stata eliminata o il lock non è più valido.",
      );
  }
  return {
    state: record.state,
    save: (s: CascadeState) => update(s, "keep"),
    started: (s: CascadeState) => update(s, "start"),
    release: (s: CascadeState) => update(s, "release"),
  };
}
