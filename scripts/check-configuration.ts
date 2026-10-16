import { resolve } from "node:path";
import { parseServerConfig } from "../src/lib/server/config-schema";

try {
  process.loadEnvFile(resolve(".env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT")
    throw new Error("Configurazione locale illeggibile.");
}

const config = parseServerConfig(process.env);
console.log(
  `Configurazione valida: HTTPS, limiti prudenti, IA ${config.AI_ENABLED ? "abilitata" : "disabilitata"}. Credenziali non visualizzate.`,
);
