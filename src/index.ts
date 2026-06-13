import "dotenv/config";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify, { FastifyRequest } from "fastify";
import { analyticsEventsQueue } from "./utils/queue";
import { enrichEvent, looksLikeBot } from "./utils/enrich";

/**
 * tracking-server — ingests CUSTOMER behaviour only. The single client is
 * the customer storefront (`hoizr-client`); the host/admin/artist consoles
 * do NOT send analytics here. Events arrive via a single `POST /track`
 * endpoint, are enriched with IP/UA/visitor hash, then enqueued to
 * `analyticsEventsQueue` for the worker to persist.
 *
 * Deliberately a separate Node process from main-server / customer-server
 * because (a) it's a high-write, no-read surface and shouldn't share the
 * GraphQL server's hot path, (b) it must keep accepting writes during a
 * GraphQL deploy, (c) it sees raw IPs and we want a tight allow-list of
 * what it accepts.
 *
 * Workflow:
 *   POST /track
 *     ↓ validate eventType, drop bots, drop opted-out (DNT)
 *     ↓ enrich with server-side IP + UA parsing + visitor hash
 *     ↓ enqueue to BullMQ
 *   GET /  (health check for the load balancer)
 */

const app = Fastify({ logger: false });

const PORT = Number(process.env.PORT ?? 4100);
// Customer storefront only — hoizr-client (prod + dev) and its localhost
// port. Host/admin/artist origins are intentionally NOT here: this server
// ingests customer behaviour, nothing else.
//
// Trailing slashes are stripped so `https://dev.hoizr.com/` from a sloppy env
// still matches the browser's `Origin: https://dev.hoizr.com` (which never has
// one). Any `*.hoizr.com` / apex `hoizr.com` https origin is also accepted as a
// safety net so a forgotten env entry on a new subdomain can't silently break
// tracking again.
const stripSlash = (s: string): string => s.replace(/\/+$/, "");
const allowedOrigins = (
  process.env.TRACKING_CORS_ORIGINS ??
  "https://www.hoizr.com,https://hoizr.com,https://dev.hoizr.com,http://localhost:3002"
)
  .split(",")
  .map((s) => stripSlash(s.trim()))
  .filter(Boolean);

const extractIp = (req: FastifyRequest): string => {
  // Trust DO App Platform's X-Forwarded-For. We take the first entry —
  // the public-facing client IP — and fall back to the socket.
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  if (Array.isArray(xff) && xff.length > 0) {
    return xff[0].split(",")[0].trim();
  }
  return req.ip;
};

async function start() {
  await app.register(helmet, {
    contentSecurityPolicy: false, // we never serve HTML
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });

  const isLocalhostOrigin = (origin: string): boolean => {
    try {
      const u = new URL(origin);
      return u.hostname === "localhost" || u.hostname === "127.0.0.1";
    } catch {
      return false;
    }
  };

  // Any https origin under hoizr.com (apex or subdomain). Customer traffic only
  // ever comes from a hoizr.com host, so this is a safe fallback that survives a
  // missing env entry for a freshly-provisioned subdomain.
  const isHoizrOrigin = (origin: string): boolean => {
    try {
      const u = new URL(origin);
      return (
        u.protocol === "https:" &&
        (u.hostname === "hoizr.com" || u.hostname.endsWith(".hoizr.com"))
      );
    } catch {
      return false;
    }
  };

  await app.register(cors, {
    origin: (origin, cb) => {
      // Allow same-origin / no-origin (server-side fetch / sendBeacon),
      // any localhost port in dev, any hoizr.com origin, and the explicit
      // allow-list otherwise.
      if (!origin) return cb(null, true);
      const o = stripSlash(origin);
      if (isLocalhostOrigin(o)) return cb(null, true);
      if (isHoizrOrigin(o)) return cb(null, true);
      if (allowedOrigins.includes(o)) return cb(null, true);
      // Reject WITHOUT throwing: @fastify/cors then simply omits the
      // Access-Control-Allow-Origin header (browser blocks the response)
      // instead of returning a 500 — a thrown error here surfaces in the
      // browser as a confusing "CORS error" on an otherwise-200 endpoint.
      console.warn(`[tracking-server] CORS reject: ${origin}`);
      cb(null, false);
    },
    methods: ["POST", "GET", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    // MUST be true: the client uses `navigator.sendBeacon`, which ALWAYS sends
    // the request with credentials (cookies) included. A credentialed
    // cross-origin request is blocked by the browser unless the response
    // carries `Access-Control-Allow-Credentials: true` (with a specific, non-*
    // Allow-Origin — which the origin callback above already returns). Without
    // this, beacons fail the CORS check even though plain fetch/curl succeed.
    // The server ignores the cookies; this only satisfies the browser.
    credentials: true,
  });

  // ─── Health check ────────────────────────────────────────────────
  app.get("/", async () => "tracking-server ok");
  app.get("/health", async () => ({ ok: true, queue: "ready" }));

  // ─── Ingest a single event ───────────────────────────────────────
  app.post<{ Body: any }>("/track", async (req, reply) => {
    try {
      // Do-Not-Track signal — quietly accept but drop.
      const dnt = req.headers["dnt"];
      if (dnt === "1") {
        return reply.code(204).send();
      }

      const userAgent = String(req.headers["user-agent"] ?? "");
      if (looksLikeBot(userAgent)) {
        // 204 — keep response shape consistent for the SDK while
        // refusing to record bot traffic.
        return reply.code(204).send();
      }

      const ip = extractIp(req);
      const origin = req.headers["origin"] as string | undefined;

      const enriched = enrichEvent(req.body, ip, userAgent, origin);
      if (!enriched) {
        return reply.code(400).send({ ok: false, reason: "unknown_event_type" });
      }

      await analyticsEventsQueue.add("analytics-event", enriched, {
        // jobId is intentionally NOT visitor-stable — every event is a
        // distinct row. BullMQ assigns its own id.
      });

      return reply.code(202).send({ ok: true });
    } catch (err: any) {
      // Never blow up the page-load funnel because tracking failed.
      // Return 204 so the SDK's `fetch().catch()` stays quiet.
      console.error("[tracking-server] /track error:", err?.message ?? err);
      return reply.code(204).send();
    }
  });

  // ─── Ingest a batch (SDK can `sendBeacon` multiple events) ──────
  app.post<{ Body: { events: any[] } }>("/track/batch", async (req, reply) => {
    try {
      const dnt = req.headers["dnt"];
      if (dnt === "1") return reply.code(204).send();

      const userAgent = String(req.headers["user-agent"] ?? "");
      if (looksLikeBot(userAgent)) return reply.code(204).send();

      const ip = extractIp(req);
      const origin = req.headers["origin"] as string | undefined;

      const events = Array.isArray(req.body?.events) ? req.body.events : [];
      if (events.length === 0 || events.length > 50) {
        return reply
          .code(400)
          .send({ ok: false, reason: "invalid_batch_size" });
      }

      let accepted = 0;
      const jobs: { name: string; data: Record<string, any> }[] = [];
      for (const ev of events) {
        const enriched = enrichEvent(ev, ip, userAgent, origin);
        if (!enriched) continue;
        jobs.push({ name: "analytics-event", data: enriched });
        accepted += 1;
      }
      if (jobs.length > 0) await analyticsEventsQueue.addBulk(jobs);

      return reply.code(202).send({ ok: true, accepted });
    } catch (err: any) {
      console.error(
        "[tracking-server] /track/batch error:",
        err?.message ?? err
      );
      return reply.code(204).send();
    }
  });

  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`[tracking-server] listening on http://localhost:${PORT}`);
}

start().catch((err) => {
  console.error("[tracking-server] failed to start:", err);
  process.exit(1);
});
