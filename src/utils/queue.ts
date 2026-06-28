import { Queue } from "bullmq";
import { redisClient } from "./redis";

/**
 * Queue name — kept as a LOCAL literal on purpose. Importing it from
 * `@hoizr-technology/shared` pulls that package's barrel, which transitively
 * `require`s `type-graphql` (via its GraphQL enums). tracking-server is a
 * lightweight ingest process that does NOT install type-graphql, so any shared
 * import crashes it on boot (MODULE_NOT_FOUND) → PM2 crash-loop → nginx 502 →
 * the browser surfaces it as a "CORS error". Keep this string byte-identical to
 * `QueueNames.analyticsEventsQueue` in hoizr-shared so the worker drains it.
 */
const ANALYTICS_EVENTS_QUEUE = "{analytics-events-queue}";

/**
 * Payload shape pushed onto `analyticsEventsQueue`. The worker
 * (hoizr-workers / analytics-events worker) consumes and persists to
 * Mongo. Shape is intentionally loose — the schema in shared has all
 * the strongly-typed fields; this is just transport.
 */
export type AnalyticsEventJob = Record<string, any>;

export const analyticsEventsQueue = new Queue<AnalyticsEventJob>(
  ANALYTICS_EVENTS_QUEUE,
  {
    connection: redisClient,
    defaultJobOptions: {
      // Tracking events are best-effort. Don't pile up forever on
      // worker outage — drop after 2 retries.
      attempts: 2,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { age: 60, count: 1000 },
      removeOnFail: { age: 86400, count: 1000 },
    },
  }
);
