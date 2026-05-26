import { Redis } from "ioredis";

/**
 * Single Redis connection reused across the BullMQ queue producer and
 * the dedup-cache. BullMQ requires `maxRetriesPerRequest: null` for
 * blocking commands; we keep the same setting everywhere.
 */
export const redisClient = new Redis({
  host: process.env.REDIS_HOST ?? "127.0.0.1",
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  ...(process.env.REDIS_TLS === "true" ? { tls: {} } : {}),
});

redisClient.on("error", (err) => {
  // Don't crash on a transient Redis blip — BullMQ has its own retries.
  console.error("[tracking-server][redis] error:", err.message);
});
