import crypto from "node:crypto";
import UAParser from "ua-parser-js";

// Keep these string values aligned with hoizr-shared's analytics enums without
// importing the shared enum module at runtime; that module registers GraphQL
// enums and pulls GraphQL/Mongoose peers into this lightweight ingest process.
// The only event types we accept. This is the ingest gate — anything not
// listed here is dropped with `unknown_event_type`, so the funnel stays
// tiny no matter what a stale client sends.
//   pageView      — every route change (event-list / detail views are
//                   derived from `route` at report time)
//   cartCreated   — feeds the abandoned-cart automation (≈ ticket selected)
//   cartDestroyed — buyer discarded an active cart
//   paymentStarted— buyer opened the Razorpay payment sheet (funnel: payment stage)
//   paymentFailed — payment attempt failed / dismissed (funnel: payment drop-off)
//   orderPlaced   — server-emitted conversion (customer-server)
//
// The funnel (event view → ticket selected → checkout → payment → paid) is
// reconstructed from these + `pageView.route` — we add ONLY the steps that
// route-derivation can't see (the Razorpay payment stage). Every type here is
// a row in Mongo forever, so the list stays deliberately tiny.
enum AnalyticsEventType {
  PageView = "pageView",
  CartCreated = "cartCreated",
  CartDestroyed = "cartDestroyed",
  PaymentStarted = "paymentStarted",
  PaymentFailed = "paymentFailed",
  OrderPlaced = "orderPlaced",
}

enum TrafficSource {
  Direct = "direct",
  Organic = "organic",
  Paid = "paid",
  Social = "social",
  Email = "email",
  Referral = "referral",
  Internal = "internal",
  Unknown = "unknown",
}

enum DeviceType {
  Desktop = "desktop",
  Mobile = "mobile",
  Tablet = "tablet",
  Bot = "bot",
  Unknown = "unknown",
}

const VISITOR_SALT = process.env.VISITOR_HASH_SALT ?? "hoizr-visitor";

/**
 * Day-bucketed visitor hash. Same `(ip, userAgent)` produces the same
 * hash for a 24h window — gives us "unique visitors per day" without
 * storing a long-lived identifier.
 *
 * If you change the day-bucket logic later, you'll reset all visitor
 * timelines — done on purpose so a rotation policy is straightforward.
 */
export const visitorHashOf = (ip: string, userAgent: string): string => {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  return crypto
    .createHash("sha256")
    .update(`${VISITOR_SALT}|${day}|${ip}|${userAgent}`)
    .digest("hex")
    .slice(0, 32);
};

/**
 * Coarse device classification from User-Agent. Matches the
 * `DeviceType` enum in shared so reports can group cleanly.
 */
const classifyDevice = (parsed: UAParser.IResult): DeviceType => {
  const type = parsed.device.type;
  if (type === "mobile") return DeviceType.Mobile;
  if (type === "tablet") return DeviceType.Tablet;
  if (parsed.browser.name?.toLowerCase().includes("bot")) return DeviceType.Bot;
  if (parsed.ua.toLowerCase().includes("bot")) return DeviceType.Bot;
  if (!type) return DeviceType.Desktop;
  return DeviceType.Unknown;
};

/**
 * Map referrer host + UTM medium to a TrafficSource bucket.
 * `Internal` is used when the referrer is one of our own domains.
 */
const classifyTrafficSource = (
  referrerHost: string | undefined,
  utmMedium: string | undefined,
  origin: string | undefined
): TrafficSource => {
  if (utmMedium) {
    const m = utmMedium.toLowerCase();
    if (m === "email") return TrafficSource.Email;
    if (m === "cpc" || m === "paid" || m === "ppc") return TrafficSource.Paid;
    if (m === "social" || m === "facebook" || m === "instagram")
      return TrafficSource.Social;
    if (m === "organic") return TrafficSource.Organic;
    if (m === "referral") return TrafficSource.Referral;
  }
  if (!referrerHost) return TrafficSource.Direct;
  const r = referrerHost.toLowerCase();
  if (origin && r === new URL(origin).hostname) return TrafficSource.Internal;
  if (r.endsWith("hoizr.com")) return TrafficSource.Internal;
  if (r.includes("google.") || r.includes("bing.") || r.includes("duckduckgo."))
    return TrafficSource.Organic;
  if (
    r.includes("instagram.com") ||
    r.includes("facebook.com") ||
    r.includes("t.co") ||
    r.includes("twitter.com") ||
    r.includes("x.com") ||
    r.includes("linkedin.com")
  ) {
    return TrafficSource.Social;
  }
  return TrafficSource.Referral;
};

/**
 * Extracts the host portion of a referrer URL. Returns undefined when
 * the input is empty / not a parseable URL.
 */
const referrerHostOf = (referrer?: string): string | undefined => {
  if (!referrer) return undefined;
  try {
    return new URL(referrer).hostname;
  } catch {
    return undefined;
  }
};

/**
 * Validate that the incoming `eventType` is one we accept. Unknown
 * types get dropped at ingest — protects against typos at call sites
 * polluting the funnel.
 */
export const isKnownEventType = (value: any): value is AnalyticsEventType =>
  typeof value === "string" &&
  Object.values(AnalyticsEventType).includes(value as AnalyticsEventType);

/**
 * Bot heuristic — drops requests that look like crawlers / monitoring
 * before they hit Mongo. Cheap to add a UA term here; expensive to
 * filter at report time.
 */
const BOT_HINTS = [
  "bot",
  "crawler",
  "spider",
  "headlesschrome",
  "googlebot",
  "bingbot",
  "yahoobot",
  "duckduckbot",
  "baiduspider",
  "yandex",
  "facebot",
  "ia_archiver",
  "uptimerobot",
  "pingdom",
  "ahrefsbot",
  "mj12bot",
  "semrush",
];

export const looksLikeBot = (userAgent: string): boolean => {
  const ua = (userAgent || "").toLowerCase();
  return BOT_HINTS.some((hint) => ua.includes(hint));
};

/**
 * Enrich a raw ingest payload into the canonical AnalyticsEvent shape
 * before enqueueing. Pure function — no I/O.
 *
 * `ip` and `userAgent` come from request headers (server-side); the
 * client cannot spoof them through the JSON body.
 */
export const enrichEvent = (
  body: any,
  ip: string,
  userAgent: string,
  origin: string | undefined
): Record<string, any> | null => {
  if (!isKnownEventType(body?.eventType)) return null;

  const parsed = new UAParser(userAgent).getResult();
  const referrerHost = referrerHostOf(body?.referrer);
  const trafficSource = classifyTrafficSource(
    referrerHost,
    body?.utmMedium,
    origin
  );

  // Truncate strings defensively so a hostile client can't push a
  // 1MB body into Mongo. Mongo doc cap is 16MB but we don't want any
  // single tracking event over a few KB.
  const trunc = (v: any, max: number) =>
    typeof v === "string" ? v.slice(0, max) : v;

  // Lean by design: every field here is a column in Mongo on every event.
  // We keep only what's queried — identity/stitching, entity refs, the
  // route, attribution, and a coarse device class. Raw UA / IP / full URL /
  // page title / query / version strings are derived-from then dropped, so
  // a single event stays well under a kilobyte.
  return {
    eventType: body.eventType,

    // Identity + stitching
    visitorHash: visitorHashOf(ip, userAgent),
    sessionId: trunc(body?.sessionId, 64),
    customerId: trunc(body?.customerId, 64),

    // Entity references
    eventId: trunc(body?.eventId, 64),
    hostId: trunc(body?.hostId, 64),
    orderId: trunc(body?.orderId, 64),
    itemIds: Array.isArray(body?.itemIds)
      ? body.itemIds
          .filter((s: any) => typeof s === "string")
          .slice(0, 50)
          .map((s: string) => s.slice(0, 64))
      : undefined,

    // Route only — page-level funnels are derived from this at report time.
    route: trunc(body?.route, 256),

    // Attribution (raw referrer is used to derive these two, then discarded)
    referrerHost,
    utmSource: trunc(body?.utmSource, 128),
    utmMedium: trunc(body?.utmMedium, 128),
    utmCampaign: trunc(body?.utmCampaign, 128),
    utmTerm: trunc(body?.utmTerm, 128),
    utmContent: trunc(body?.utmContent, 128),
    trafficSource,

    // Coarse device class only (no raw UA, no version strings)
    deviceType: classifyDevice(parsed),
    browser: parsed.browser.name,
    os: parsed.os.name,

    // Event-specific bag — keep it small at the call site.
    metadata:
      body?.metadata && typeof body.metadata === "object"
        ? Object.fromEntries(
            Object.entries(body.metadata).slice(0, 50).map(([k, v]) => [
              String(k).slice(0, 64),
              typeof v === "string" ? v.slice(0, 1024) : v,
            ])
          )
        : undefined,

    clientTimestamp: body?.clientTimestamp
      ? new Date(body.clientTimestamp)
      : undefined,
    app: trunc(body?.app, 64),
  };
};
