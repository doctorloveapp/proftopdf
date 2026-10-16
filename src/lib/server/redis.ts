import 'server-only';
import { Redis } from '@upstash/redis';
import { getServerConfig } from './config';

let redis: Redis | undefined;

export function getRedis(): Redis {
  if (redis) return redis;
  const config = getServerConfig();
  if (!config.UPSTASH_REDIS_REST_URL || !config.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error('Contatori non disponibili: configurazione Redis mancante.');
  }
  redis = new Redis({
    url: config.UPSTASH_REDIS_REST_URL,
    token: config.UPSTASH_REDIS_REST_TOKEN,
    retry: false,
    automaticDeserialization: true,
    enableTelemetry: false,
  });
  return redis;
}

// Quota logic will use a single atomic EVAL reservation in Phase 2.
// Never replace a failing Redis call with an in-memory quota counter.
