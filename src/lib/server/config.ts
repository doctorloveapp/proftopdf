import 'server-only';
import { parseServerConfig, type ServerConfig } from './config-schema';

let cachedConfig: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  // Lazy: static generation never needs to resolve production credentials.
  cachedConfig ??= parseServerConfig(process.env);
  return cachedConfig;
}

export function requireAiConfig(): ServerConfig {
  const config = getServerConfig();
  if (!config.AI_ENABLED) throw new Error('Elaborazione IA disabilitata.');
  return config;
}
