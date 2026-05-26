import crypto from "node:crypto";
import UAParser from "ua-parser-js";
import {
  AnalyticsEventType,
  DeviceType,
  TrafficSource,
} from "@hoizr-technology/shared";

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

  return {
    eventType: body.eventType,

    visitorHash: visitorHashOf(ip, userAgent),
    sessionId: trunc(body?.sessionId, 64),
    customerId: trunc(body?.customerId, 64),
    userId: trunc(body?.userId, 64),
    artistId: trunc(body?.artistId, 64),

    eventId: trunc(body?.eventId, 64),
    hostId: trunc(body?.hostId, 64),
    orderId: trunc(body?.orderId, 64),
    itemIds: Array.isArray(body?.itemIds)
      ? body.itemIds
          .filter((s: any) => typeof s === "string")
          .slice(0, 50)
          .map((s: string) => s.slice(0, 64))
      : undefined,

    pageUrl: trunc(body?.pageUrl, 2048),
    route: trunc(body?.route, 256),
    pageTitle: trunc(body?.pageTitle, 256),
    pageQuery: trunc(body?.pageQuery, 1024),
    referrer: trunc(body?.referrer, 2048),
    referrerHost,

    utmSource: trunc(body?.utmSource, 128),
    utmMedium: trunc(body?.utmMedium, 128),
    utmCampaign: trunc(body?.utmCampaign, 128),
    utmTerm: trunc(body?.utmTerm, 128),
    utmContent: trunc(body?.utmContent, 128),
    trafficSource,

    userAgent: trunc(userAgent, 512),
    deviceType: classifyDevice(parsed),
    browser: parsed.browser.name,
    browserVersion: parsed.browser.version,
    os: parsed.os.name,
    osVersion: parsed.os.version,
    viewport: trunc(body?.viewport, 16),
    language: trunc(body?.language, 16),
    timezone: trunc(body?.timezone, 64),

    ip,
    // country + city are filled by a downstream IP-lookup pass; left
    // empty here so the tracking-server stays fast (no synchronous geo
    // lookup on the hot path).

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
    origin: trunc(origin, 256),
    app: trunc(body?.app, 64),
  };
};
