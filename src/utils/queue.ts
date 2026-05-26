import { Queue } from "bullmq";
import { QueueNames } from "@hoizr-technology/shared";
import { redisClient } from "./redis";

/**
 * Payload shape pushed onto `analyticsEventsQueue`. The worker
 * (hoizr-workers / analytics-events worker) consumes and persists to
 * Mongo. Shape is intentionally loose — the schema in shared has all
 * the strongly-typed fields; this is just transport.
 */
export type AnalyticsEventJob = Record<string, any>;

export const analyticsEventsQueue = new Queue<AnalyticsEventJob>(
  QueueNames.analyticsEventsQueue,
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
