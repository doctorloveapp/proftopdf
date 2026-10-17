// Read-only quota audit. Snapshot pruning removes only normally expired rows.
// Never resets counters, releases reservations or changes billing.
import { mkdir, writeFile } from "node:fs/promises";
import { getQuotaSnapshot } from "../src/lib/server/quota";
import { getRedis } from "../src/lib/server/redis";
try {
  process.loadEnvFile(".env");
  const snapshot = await getQuotaSnapshot("notes");
  const rows = await getRedis().zrange<string[]>(
    "proftopdf:v1:quota:notes:tokens:86400000",
    0,
    -1,
    { withScores: true },
  );
  const hourlyUtc: Record<
    string,
    {
      used: number;
      reserved: number;
      usedRequests: number;
      reservedRequests: number;
    }
  > = {};
  for (let i = 0; i < rows.length; i += 2) {
    const match = String(rows[i]).match(/\|([ru])\|(\d+)$/);
    if (!match) continue;
    const hour = new Date(Number(rows[i + 1])).toISOString().slice(0, 13);
    const bucket = (hourlyUtc[hour] ??= {
      used: 0,
      reserved: 0,
      usedRequests: 0,
      reservedRequests: 0,
    });
    bucket[match[1] === "u" ? "used" : "reserved"] += Number(match[2]);
    bucket[match[1] === "u" ? "usedRequests" : "reservedRequests"]++;
  }
  const report = {
    checkedAt: snapshot.checkedAt,
    model: snapshot.model,
    windows: snapshot.windows,
    hourlyUtc,
    evidence:
      "Live application ledger, aggregated without operation IDs; cannot attribute legacy usage to a particular lesson or see provider calls outside this app.",
  };
  await mkdir("docs", { recursive: true });
  await writeFile(
    "docs/quota-audit.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} catch {
  console.error(
    "QUOTA_AUDIT_FAILED: verifica configurazione e connettività senza condividere credenziali.",
  );
  process.exitCode = 1;
}
