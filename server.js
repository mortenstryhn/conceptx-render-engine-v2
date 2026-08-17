// Concept X — Playwright Render Engine
// Renders any public URL at a chosen device size, waits for ads/lazy content,
// dismisses common consent banners, and returns a screenshot (PNG/JPEG).
//
// GET /render?url=<page>&device=<id>&landscape=0&fullPage=1&format=jpeg&fresh=0&token=<secret>
// GET /health
//
// Config via environment variables:
//   PORT            (default 8080)
//   RENDER_TOKEN    if set, requests must include ?token=<value> (recommended for public hosting)
//   LOCALE          browser locale / Accept-Language (default da-DK)
//   TIMEZONE        timezone id (default Europe/Copenhagen)
//   MAX_CONCURRENCY number of pages rendered at once (default 2)
//   CACHE_TTL_MS    screenshot cache lifetime (default 300000 = 5 min)
//   NAV_TIMEOUT_MS  navigation timeout (default 45000)
//   ALLOW_ORIGIN    CORS Access-Control-Allow-Origin (default *)
//   PROXY_URL       route ALL browser traffic through this proxy so the page sees a
//                   real (e.g. Danish residential) IP instead of the datacenter IP.
//                   Formats: http://host:port  ·  http://user:pass@host:port  ·  socks5://host:port
//   PROXY_USERNAME  proxy auth username (optional; overrides any user in PROXY_URL)
//   PROXY_PASSWORD  proxy auth password (optional; overrides any pass in PROXY_URL)

import express from "express";
import dns from "node:dns/promises";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { WebSocketServer } from "ws";
import { chromium } from "playwright";
import ProxyChain from "proxy-chain";
import { DEVICES, DEFAULT_DEVICE } from "./devices.js";

const PORT            = parseInt(process.env.PORT || "8080", 10);
const RENDER_TOKEN    = process.env.RENDER_TOKEN || "";
const LOCALE          = process.env.LOCALE || "da-DK";
const TIMEZONE        = process.env.TIMEZONE || "Europe/Copenhagen";
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || "2", 10);
const CACHE_TTL_MS    = parseInt(process.env.CACHE_TTL_MS || "300000", 10);
const NAV_TIMEOUT_MS  = parseInt(process.env.NAV_TIMEOUT_MS || "45000", 10);
const ALLOW_ORIGIN    = process.env.ALLOW_ORIGIN || "*";
// Real publisher pages are very tall + ad-heavy. Cap capture size so the
// screenshot bitmap can't blow up memory (a common cause of render failures).
const MAX_SHOT_HEIGHT = parseInt(process.env.MAX_SHOT_HEIGHT || "4500", 10); // CSS px (lower = safer on 512MB)
const MAX_DSF         = parseFloat(process.env.MAX_DSF || "2");              // cap pixel ratio for screenshots
const RENDER_TIMEOUT_MS = parseInt(process.env.RENDER_TIMEOUT_MS || "75000", 10);
const BLOCK_MEDIA     = (process.env.BLOCK_MEDIA || "true") === "true";      // drop video/audio streams (heavy, not needed for a screenshot)
const MAX_LIVE        = parseInt(process.env.MAX_LIVE_SESSIONS || "2", 10);  // concurrent live/interactive sessions (each holds a browser tab open)
const LIVE_IDLE_MS    = parseInt(process.env.LIVE_IDLE_MS || "180000", 10);  // auto-close a live session after this much inactivity
const LIVE_DSF        = parseFloat(process.env.LIVE_DSF || "1");             // pixel ratio for LIVE streaming (1 = smoothest; 2 = sharper but heavier)
const LIVE_QUALITY    = parseInt(process.env.LIVE_QUALITY || "72", 10);      // JPEG quality of streamed frames (higher = sharper)
const LIVE_QUALITY_MIN= parseInt(process.env.LIVE_QUALITY_MIN || "58", 10);  // never stream grainier than this
const LIVE_MAX_W      = parseInt(process.env.LIVE_MAX_W || "1920", 10);      // cap streamed frame width — SHARPNESS lever (higher = sharper, heavier). ~1:1 with the tool's display at 1920.
const LIVE_MAX_H      = parseInt(process.env.LIVE_MAX_H || "1200", 10);      // cap streamed frame height
const LIVE_EVERYNTH_BIG = parseInt(process.env.LIVE_EVERYNTH_BIG || "1", 10);// frames to send on big viewports (1 = every frame). Metrics showed no backpressure, so default is now 1 for max fps; raise to 2 only if drops appear.
const ENGINE_VERSION  = "2.70-warm-login";                                    // bump when deploying; visible at /health

// Never let a single bad render (a thrown Playwright/proxy error in a stray async
// callback) crash the whole service — that shows up in Render as "Exited with status 1"
// and takes down every in-flight preview. Log and keep serving instead.
process.on("uncaughtException", (e) => { try { console.error("uncaughtException:", e && e.stack || e); } catch {} });
process.on("unhandledRejection", (e) => { try { console.error("unhandledRejection:", e && e.stack || e); } catch {} });

/* ------------------------------------------------------------------ *
 * METRICS — "measure first". Live-stream + render counters exposed on *
 * /health so we can see whether the desktop stutter is CPU-, band-    *
 * width- or latency-bound instead of guessing.                        *
 * ------------------------------------------------------------------ */
const METRICS = {
  startedAt: Date.now(),
  cpuPercent: 0,                                   // % of ONE core (≈100 = one core pinned)
  cores: os.cpus() ? os.cpus().length : 1,
  renders: { total: 0, active: 0, queueDepth: 0 },
  live: { active: 0, total: 0 },
  frames: { sent: 0, dropped: 0, bytesSent: 0, peakBufferedKB: 0 },   // cumulative (whole process life)
  _cpuLast: process.cpuUsage(),
  _cpuAt: Date.now(),
  // Container-wide CPU (captures Chromium too — the render/encode work Node's cpuUsage misses).
  containerCpuPercentOneCore: null,   // % of ONE core used by the WHOLE container (right now)
  peakContainerCpuPercentOneCore: 0,  // highest value seen this session — scroll, then read THIS
  peakContainerCpuPercentOfQuota: 0,  // same as % of the allocated CPU (≈100 = was maxed → CPU-bound)
  allocatedCores: null,               // CPU cores the container is actually allowed (from cgroup quota)
  containerCpuPercentOfQuota: null,   // ≈100 = the container is maxing its allocation (throttled)
  _cgLast: null,
  _cgAt: Date.now(),
  _win: [],                                        // recent frames: { at, bytes, buffered, sendMs, latMs }
  _rtt: null,                                      // last measured client round-trip (ms), if the client echoes pings
};
// Read the CONTAINER's cumulative CPU time (microseconds) — cgroup v2 then v1. This includes
// the Chromium render/encode processes, which process.cpuUsage() (Node only) does not.
function cgroupCpuUsec() {
  try { const m = /usage_usec\s+(\d+)/.exec(fs.readFileSync("/sys/fs/cgroup/cpu.stat", "utf8")); if (m) return parseInt(m[1], 10); } catch (e) {}
  try { return Math.round(parseInt(fs.readFileSync("/sys/fs/cgroup/cpuacct/cpuacct.usage", "utf8").trim(), 10) / 1000); } catch (e) {}
  return null;
}
// How many cores the container is actually allowed (cgroup quota) — v2 cpu.max, then v1.
function cgroupAllocatedCores() {
  try { const p = fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/); if (p[0] !== "max") { const c = parseInt(p[0], 10) / parseInt(p[1], 10); if (c > 0) return Math.round(c * 100) / 100; } } catch (e) {}
  try { const q = parseInt(fs.readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "utf8").trim(), 10); const per = parseInt(fs.readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf8").trim(), 10); if (q > 0 && per > 0) return Math.round(q / per * 100) / 100; } catch (e) {}
  return null;
}
METRICS.allocatedCores = cgroupAllocatedCores();
METRICS._cgLast = cgroupCpuUsec();
// CPU sampler: Node process CPU% AND container-wide CPU% (the one that includes Chromium).
setInterval(() => {
  try {
    const now = Date.now();
    const u = process.cpuUsage(METRICS._cpuLast);
    const elapsed = now - METRICS._cpuAt;
    METRICS.cpuPercent = elapsed > 0 ? Math.round(((u.user + u.system) / 1000 / elapsed) * 100) : 0;
    METRICS._cpuLast = process.cpuUsage();
    METRICS._cpuAt = now;
    // container-wide
    const cg = cgroupCpuUsec();
    if (cg != null && METRICS._cgLast != null) {
      const elapsedUs = (now - METRICS._cgAt) * 1000;
      const pct = elapsedUs > 0 ? Math.round((cg - METRICS._cgLast) / elapsedUs * 100) : 0;
      METRICS.containerCpuPercentOneCore = pct;
      if (pct > METRICS.peakContainerCpuPercentOneCore) METRICS.peakContainerCpuPercentOneCore = pct;
      if (METRICS.allocatedCores) {
        const ofQuota = Math.round(pct / (METRICS.allocatedCores * 100) * 100);
        METRICS.containerCpuPercentOfQuota = ofQuota;
        if (ofQuota > METRICS.peakContainerCpuPercentOfQuota) METRICS.peakContainerCpuPercentOfQuota = ofQuota;
      }
    }
    METRICS._cgLast = cg; METRICS._cgAt = now;
  } catch (e) {}
}, 2000).unref?.();

function recordFrame({ bytes, sent, buffered, sendMs, latMs }) {
  METRICS.frames.sent += sent ? 1 : 0;
  METRICS.frames.dropped += sent ? 0 : 1;
  METRICS.frames.bytesSent += sent ? (bytes || 0) : 0;
  const bufKB = Math.round((buffered || 0) / 1024);
  if (bufKB > METRICS.frames.peakBufferedKB) METRICS.frames.peakBufferedKB = bufKB; // lifetime peak
  const at = Date.now();
  METRICS._win.push({ at, bytes: bytes || 0, buffered: buffered || 0, sendMs: sendMs || 0, latMs: (typeof latMs === "number" ? latMs : null), sent: !!sent });
  // keep ~last 12 seconds
  const cutoff = at - 12000;
  while (METRICS._win.length && METRICS._win[0].at < cutoff) METRICS._win.shift();
}
function streamStats() {
  const w = METRICS._win;
  if (!w.length) return { fps: 0, avgFrameKB: 0, dropRatePct: 0, peakBufferedKB: 0, lastSendMs: 0, frameLatencyMs: METRICS._rtt };
  const spanSec = Math.max(0.001, (w[w.length - 1].at - w[0].at) / 1000);
  const sentFrames = w.filter((f) => f.sent);
  const bytes = sentFrames.reduce((a, f) => a + f.bytes, 0);
  const peakBuf = w.reduce((a, f) => Math.max(a, f.buffered), 0);
  return {
    fps: Math.round((sentFrames.length / spanSec) * 10) / 10,
    avgFrameKB: sentFrames.length ? Math.round(bytes / sentFrames.length / 1024) : 0,
    dropRatePct: w.length ? Math.round((w.filter((f) => !f.sent).length / w.length) * 100) : 0,
    peakBufferedKB: Math.round(peakBuf / 1024),
    lastSendMs: Math.round((w[w.length - 1].sendMs || 0) * 10) / 10,
    frameLatencyMs: METRICS._rtt,                  // client round-trip, if the frontend echoes {t:"ping"} → {t:"pong"}
  };
}

/* ------------------------------------------------------------------ *
 * Outbound proxy (optional) — route the browser through a residential *
 * proxy so ad auctions see a real Danish user IP, not a datacenter IP.*
 *                                                                     *
 * Chromium authenticates the proxy per-request and drops the login on *
 * a subset of the 100+ concurrent third-party ad requests → floods of *
 * "407 Proxy Authentication Required". To avoid that we DON'T hand the *
 * upstream login to Chromium; instead we spin up a local auth-less     *
 * relay (proxy-chain) that injects the login on EVERY request and      *
 * tunnels to the real proxy. Chromium points at the local relay.       *
 * ------------------------------------------------------------------ */
function parseProxy() {
  let raw = (process.env.PROXY_URL || "").trim();
  if (!raw) return null;
  // Add a default scheme for bare "host:port" (note: URL() would mis-read "host:port"
  // as scheme "host:" + path "port", so we must detect a real "scheme://" ourselves).
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = "http://" + raw;
  let u;
  try { u = new URL(raw); } catch { return null; }
  const server = `${u.protocol}//${u.host}`; // u.host already includes the port
  const username = (process.env.PROXY_USERNAME || (u.username ? decodeURIComponent(u.username) : "")).trim();
  const password = (process.env.PROXY_PASSWORD || (u.password ? decodeURIComponent(u.password) : "")).trim();
  const proxy = { server };
  if (username) proxy.username = username;
  if (password) proxy.password = password;
  return proxy;
}
const PROXY = parseProxy();
// Full upstream URL WITH credentials, for the local relay (proxy-chain). Credentials
// are percent-encoded so specials like "+" in the password survive URL parsing.
function upstreamProxyUrl() {
  if (!PROXY) return null;
  const auth = PROXY.username
    ? `${encodeURIComponent(PROXY.username)}:${encodeURIComponent(PROXY.password || "")}@`
    : "";
  return `${PROXY.server.replace("://", "://" + auth)}`;
}
let relayUrl = null;    // local proxy URL once the selective relay is up
let relayServer = null; // the proxy-chain Server instance (selective routing)

// SELECTIVE PROXY ROUTING — SAFE-FOR-ADS design. An allowlist of ad domains is fragile
// (each site uses different SSPs; miss one → its ads don't fill). So we INVERT it: send ALL
// third-party traffic (which is where every ad exchange lives) through the Danish proxy, and
// only the page's OWN content + well-known static CDNs go DIRECT (fast). Ads always fill
// regardless of which SSP a site uses; the heavy first-party images still load direct.
const MULTI_TLD_RE = /\.(co\.uk|gov\.uk|org\.uk|com\.au|net\.au|org\.au|co\.jp|ac\.jp|co\.nz|com\.br|com\.mx|co\.il|com\.tr|com\.hk|com\.sg)$/i;
function registrableDomain(host) {
  host = (host || "").toLowerCase().replace(/\.$/, "");
  const parts = host.split(".").filter(Boolean);
  const take = MULTI_TLD_RE.test(host) ? 3 : 2;
  return parts.length <= take ? host : parts.slice(-take).join(".");
}
// The page's own registrable domains, registered per navigation → loaded DIRECT.
const FIRST_PARTY = new Set();
function registerFirstParty(url) { try { FIRST_PARTY.add(registrableDomain(new URL(url).hostname)); } catch (e) {} }
// Pure static content CDNs (geo-irrelevant) that are safe + beneficial to load DIRECT.
const DIRECT_CDNS = (process.env.PROXY_DIRECT_CDNS ||
  "fonts.gstatic.com,fonts.googleapis.com,cdnjs.cloudflare.com,jsdelivr.net,unpkg.com,cloudfront.net,akamaihd.net,akamaized.net,akamai.net,fastly.net,imgix.net,cloudinary.com,gstatic.com,ytimg.com"
).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const PROXY_ALL = (process.env.PROXY_ALL || "false") === "true"; // escape hatch: force everything through the proxy
const PROXY_SELECTIVE = (process.env.PROXY_SELECTIVE || "false") === "true"; // OFF by default: all traffic via DK relay (reliable ad fill). Set true to re-enable selective routing.

function shouldProxyHost(hostname) {
  const h = (hostname || "").toLowerCase();
  if (PROXY_ALL) return true;
  const rd = registrableDomain(h);
  for (const d of FIRST_PARTY) { if (rd === d || h === d || h.endsWith("." + d)) return false; } // first-party → direct
  if (DIRECT_CDNS.some((d) => h === d || h.endsWith("." + d))) return false;                       // static CDN → direct
  return true;                                                                                     // everything else (all ad tech) → DK proxy
}

const proxyInfo = () => PROXY
  ? { enabled: true, server: PROXY.server, auth: !!PROXY.username, relay: !!relayUrl, selective: !!relayServer, mode: (relayServer ? "selective" : "all-through-DK") }
  : { enabled: false };
if (PROXY) console.log(`Proxy aktiv → ${PROXY.server}${PROXY.username ? " (login via lokal relay)" : ""}`);

/* ------------------------------------------------------------------ *
 * AUTO-LOGIN (opt-in per domain) — for sites that require sign-in to *
 * show ads. Config lives in the SITE_LOGINS env var (a Render secret,*
 * so it SURVIVES DEPLOYS and is never in the code/GitHub). Only the  *
 * listed domains get auto-login; every other site is untouched.      *
 *                                                                    *
 * SITE_LOGINS = JSON array, e.g.:                                    *
 * [{"domain":"mingolf.golf.se","user":"NAME","pass":"SECRET",        *
 *   "userSel":"#username","passSel":"#password",                     *
 *   "submitSel":"button[type=submit]",                              *
 *   "warmUrl":"https://mingolf.golf.se/start/"}]                    *
 * userSel/passSel/submitSel are OPTIONAL — a generic form heuristic  *
 * is used when they're absent. warmUrl is OPTIONAL: a page that      *
 * REQUIRES sign-in; the engine pre-logs-in there at boot so your     *
 * first real visit is instant (the slow sign-in happens in the       *
 * background, not while you wait).                                    *
 * ------------------------------------------------------------------ */
let SITE_LOGINS = [];
try { if (process.env.SITE_LOGINS) SITE_LOGINS = JSON.parse(process.env.SITE_LOGINS) || []; }
catch (e) { console.log("SITE_LOGINS kunne ikke parses som JSON — auto-login er slået fra:", e && e.message || e); }
if (!Array.isArray(SITE_LOGINS)) SITE_LOGINS = [];
function getLogin(url) {
  let host = ""; try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  return SITE_LOGINS.find((c) => c && c.domain && (host === String(c.domain).toLowerCase() || host.endsWith("." + String(c.domain).toLowerCase()))) || null;
}
// Cached logged-in sessions (cookies + storage) per hostname — reused across refreshes /
// device switches / new sessions so a sign-in happens once, then re-runs itself automatically
// (from the env-stored credentials) after a deploy wipes the in-memory cache.
const SESSION_CACHE = new Map();
function hostKey(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } }

const app = express();
app.disable("x-powered-by");

/* ------------------------------------------------------------------ *
 * Shared browser (launched once, reused across requests)             *
 * ------------------------------------------------------------------ */
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    // Start the local auth-injecting relay so Chromium never has to answer 407s.
    let launchProxy = null;
    const upstream = upstreamProxyUrl();
    if (upstream) {
      try {
        if (PROXY_SELECTIVE) {
          // OPT-IN only. Selective relay: route ad-tech through the DK upstream, rest direct.
          // Off by default because it proved less reliable for ad fill than the all-through relay.
          const server = new ProxyChain.Server({
            port: 0, verbose: false,
            prepareRequestFunction: ({ hostname }) => ({ upstreamProxyUrl: shouldProxyHost(hostname) ? upstream : null }),
          });
          await server.listen();
          relayServer = server;
          relayUrl = `http://127.0.0.1:${server.port}`;
          launchProxy = { server: relayUrl };
          console.log("Selektiv proxy-relay (opt-in) → " + relayUrl);
        } else {
          // DEFAULT — the proven, reliable behavior: ALL browser traffic through the DK relay
          // (this is what filled ads every time). Restored after selective routing hurt fill.
          relayUrl = await ProxyChain.anonymizeProxy({ url: upstream, port: 0 });
          launchProxy = { server: relayUrl };
          console.log("Gennemgående proxy-relay klar → " + relayUrl + " (alt via DK — pålideligt annonce-fyld)");
        }
      } catch (e) {
        try {
          relayUrl = await ProxyChain.anonymizeProxy({ url: upstream, port: 0 });
          launchProxy = { server: relayUrl };
          console.log("Relay-fallback → " + relayUrl + " (" + (e && e.message || e) + ")");
        } catch (e2) {
          launchProxy = PROXY;
          console.log("Proxy-relay kunne ikke starte, bruger direkte proxy-login: " + (e2 && e2.message || e2));
        }
      }
    }
    browserPromise = chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined, // optional override (local dev); unset in production
      ...(launchProxy ? { proxy: launchProxy } : {}), // route every context/page through the (relayed) proxy
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-gpu",
        // Keep the headless (effectively "hidden") page rendering at full speed. Otherwise Chromium
        // throttles its timers / requestAnimationFrame / compositor for the backgrounded page — which
        // is exactly what shows up as scroll-jank in the live desktop stream. Safe; no feature impact.
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-ipc-flooding-protection",
        // Share one process across cross-origin iframes (ad slots) → big memory saving on ad-heavy pages.
        "--disable-features=IsolateOrigins,site-per-process,CalculateNativeWinOcclusion",
        "--disable-site-isolation-trials",
      ],
    });
  }
  return browserPromise;
}

/* ------------------------------------------------------------------ *
 * Tiny concurrency limiter                                            *
 * ------------------------------------------------------------------ */
let active = 0;
const queue = [];
function acquire() {
  METRICS.renders.total++;
  if (active < MAX_CONCURRENCY) { active++; METRICS.renders.active = active; return Promise.resolve(); }
  return new Promise((res) => queue.push(res));
}
function release() {
  active--;
  const next = queue.shift();
  if (next) { active++; next(); }
  METRICS.renders.active = active;
}

/* ------------------------------------------------------------------ *
 * In-memory screenshot cache                                          *
 * ------------------------------------------------------------------ */
const cache = new Map(); // key -> { buf, type, at }
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit;
}
function cacheSet(key, buf, type) {
  cache.set(key, { buf, type, at: Date.now() });
  if (cache.size > 200) cache.delete(cache.keys().next().value); // simple cap
}
// Quick win: strip tracking params (they don't change what renders) so the same page
// caches regardless of utm/fbclid/gclid/token → better cache hit rate.
const TRACKING_PARAMS = ["token", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid", "mc_cid", "mc_eid", "_ga", "msclkid", "igshid"];
function normalizeCacheUrl(url) {
  try {
    const u = new URL(url);
    TRACKING_PARAMS.forEach((p) => u.searchParams.delete(p));
    return u.href;
  } catch (e) { return url; }
}
// Quick win: device-aware full-page height cap. Mobile pages are captured shorter (less
// memory + faster) than desktop; both stay within the global MAX_SHOT_HEIGHT safety cap.
function adaptiveMaxHeight(dev) {
  const base = (dev && dev.mobile)
    ? parseInt(process.env.MAX_SHOT_HEIGHT_MOBILE || "2600", 10)
    : parseInt(process.env.MAX_SHOT_HEIGHT_DESKTOP || "4000", 10);
  return Math.min(base, MAX_SHOT_HEIGHT);
}

/* ------------------------------------------------------------------ *
 * SSRF guard — only allow public http(s) hosts                       *
 * ------------------------------------------------------------------ */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;        // link-local / cloud metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    return false;
  }
  const low = ip.toLowerCase();
  if (low === "::1" || low.startsWith("fc") || low.startsWith("fd") || low.startsWith("fe80")) return true;
  return false;
}

async function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("Ugyldig URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Kun http/https er tilladt");
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new Error("Intern host er ikke tilladt");
  }
  // Resolve DNS and reject private/loopback targets.
  let addrs = [];
  try {
    const res = await dns.lookup(host, { all: true });
    addrs = res.map((r) => r.address);
  } catch {
    throw new Error("Kunne ikke slå host op");
  }
  if (process.env.ALLOW_PRIVATE !== "true" && (addrs.length === 0 || addrs.some(isPrivateIp))) {
    throw new Error("Host peger på et privat/internt netværk");
  }
  return u.toString();
}

/* ------------------------------------------------------------------ *
 * Consent-banner dismissal (best effort, covers common CMPs)         *
 * ------------------------------------------------------------------ */
const CONSENT_TEXT = [
  // Danish
  "Accepter alle", "Accepter alle cookies", "Tillad alle", "Accepter alle og luk",
  "Accepter", "Godkend alle", "Jeg accepterer", "Enig", "Accepter og luk",
  // Swedish (mingolf.golf.se etc.)
  "Acceptera alla", "Acceptera alla cookies", "Acceptera", "Godkänn alla", "Godkänn",
  "Tillåt alla", "Jag accepterar", "Tillåt alla cookies", "Acceptera och stäng",
  // English
  "Accept all", "Accept All", "Allow all", "I accept", "Agree", "Accept & close", "Allow cookies",
];
const CONSENT_SELECTORS = [
  "#onetrust-accept-btn-handler",
  "button#didomi-notice-agree-button",
  "button[aria-label='Accept all']",
  "button[aria-label='Accepter alle']",
  ".fc-cta-consent",                       // Google Funding Choices
  "#sp-cc-accept",                          // Sourcepoint
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", // Cookiebot
  "#CybotCookiebotDialogBodyButtonAccept",                  // Cookiebot "Allow all"
  "#CybotCookiebotDialogBodyLevelButtonAccept",             // Cookiebot variant
  "#CybotCookiebotDialogBodyButtonAcceptAll",               // Cookiebot variant
  "button[data-testid='uc-accept-all-button']",             // Usercentrics
  "button[mode='primary']",
];

// Give proper GDPR/TCF consent so the page's ad auction actually serves ads.
// valdemarsro uses Cookiebot (IAB TCF) — accept via its JS API AND the banner button.
async function giveConsent(page) {
  // 1) Wait for the CMP to actually initialise (it isn't ready at domcontentloaded).
  await page.waitForFunction(
    () => !!(window.Cookiebot || document.querySelector('#CybotCookiebotDialog, #onetrust-banner-sdk, [id*="didomi"], [id*="sp_message_container"]')),
    { timeout: 10000 }
  ).catch(() => {});
  await page.waitForTimeout(400);
  // 2) Accept ALL via Cookiebot's API (most reliable for the TCF string).
  await page.evaluate(() => {
    try {
      if (window.Cookiebot) {
        if (typeof window.Cookiebot.submitCustomConsent === "function") window.Cookiebot.submitCustomConsent(true, true, true);
        else if (typeof window.Cookiebot.submit === "function") { try { window.Cookiebot.consent.preferences = true; window.Cookiebot.consent.statistics = true; window.Cookiebot.consent.marketing = true; } catch (e) {} window.Cookiebot.submit(window.Cookiebot.consent); }
      }
    } catch (e) {}
  }).catch(() => {});
  // 3) Also click the accept-all button (covers Cookiebot versions where the API differs).
  await dismissConsent(page).catch(() => {});
  // 4) WAIT for the TCF consent to actually be written (user-action-complete event).
  await page.evaluate(() => new Promise((resolve) => {
    try {
      if (typeof window.__tcfapi !== "function") return resolve();
      let done = false;
      window.__tcfapi("addEventListener", 2, (d, ok) => {
        if (ok && d && d.tcString && (d.eventStatus === "useractioncomplete" || d.eventStatus === "tcloaded")) { done = true; resolve(); }
      });
      setTimeout(() => { if (!done) resolve(); }, 7000);
    } catch (e) { resolve(); }
  })).catch(() => {});
  await page.waitForTimeout(800);
}

// Report whether a valid TCF consent string is now present (for diagnostics).
async function consentState(page) {
  return await page.evaluate(() => new Promise((resolve) => {
    const out = { tcfApi: typeof window.__tcfapi === "function", cookiebot: !!window.Cookiebot, consented: null, gdprApplies: null };
    if (!out.tcfApi) return resolve(out);
    try {
      let settled = false;
      window.__tcfapi("getTCData", 2, (d, ok) => {
        settled = true;
        out.gdprApplies = d && d.gdprApplies;
        out.consented = !!(d && d.tcString && d.tcString.length > 20);
        resolve(out);
      });
      setTimeout(() => { if (!settled) resolve(out); }, 2500);
    } catch (e) { resolve(out); }
  })).catch(() => ({ error: true }));
}

async function tryConsentIn(frame) {
  for (const sel of CONSENT_SELECTORS) {
    const el = frame.locator(sel).first();
    if (await el.count().catch(() => 0) && await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 1500 }).catch(() => {});
      return true;
    }
  }
  for (const t of CONSENT_TEXT) {
    const el = frame.getByRole("button", { name: t, exact: false }).first();
    if (await el.count().catch(() => 0) && await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 1500 }).catch(() => {});
      return true;
    }
  }
  return false;
}

// Consent banners often live inside a CMP iframe (Sourcepoint, Didomi, etc.),
// so we scan the main document AND every child frame.
async function dismissConsent(page) {
  try {
    if (await tryConsentIn(page.mainFrame())) return;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      if (await tryConsentIn(frame)) return;
    }
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ *
 * Scroll the full page so lazy-loaded ads request and render         *
 * ------------------------------------------------------------------ */
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const step = 400;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total >= document.body.scrollHeight - window.innerHeight - step) {
          clearInterval(timer);
          resolve();
        }
      }, 250);
      setTimeout(() => { clearInterval(timer); resolve(); }, 12000); // hard cap
    });
    window.scrollTo(0, 0);
  }).catch(() => {});
}

/* ------------------------------------------------------------------ *
 * Adnami creative injection                                           *
 *                                                                     *
 * Given a creative code (a GUID), fetch the public "ins-tag" Adnami   *
 * serves for that creative, insert it into the already-loaded page,   *
 * load Adnami's render engine (adnm.ads.v2.js) and wait for the       *
 * high-impact format to mount. This mirrors what the "Adnami Tool"    *
 * browser extension does — but server-side, where we have the same    *
 * full control over the page that an extension has in the browser.    *
 * Only public Adnami endpoints are used; no extension code is copied. *
 * ------------------------------------------------------------------ */
const ADNAMI_CREATIVE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADNAMI_ENGINE_SRC  = "https://macro.adnami.io/macro/gen/adnm.ads.v2.js";
const ADNAMI_INSTAGS_URL = (cc) => `https://app.adnami.io/api/public/creatives/${encodeURIComponent(cc)}/ins-tags`;

function normalizeCreative(raw) {
  const cc = String(raw || "").trim();
  if (!cc) return "";
  if (!ADNAMI_CREATIVE_RE.test(cc)) throw new Error("Ugyldigt Adnami creative-ID (forventer et GUID)");
  return cc.toLowerCase();
}

// Fetch (server-side) the ins-tag markup Adnami publishes for a creative.
// The endpoint returns a text block with many DSP-specific variants of the SAME
// <ins> tag (ActiveAgent, Adform, DV360, Xandr, …). We only need the slot size
// and the format type from it — we build our own single, clean preview tag.
async function fetchAdnamiInsTags(creativeCode) {
  const url = ADNAMI_INSTAGS_URL(creativeCode);
  const opts = { headers: { accept: "text/html,application/xhtml+xml,*/*" } };
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) opts.signal = AbortSignal.timeout(12000);
  let res;
  try { res = await fetch(url, opts); }
  catch (e) { throw new Error("Kunne ikke nå Adnami (ins-tags): " + (e.message || e)); }
  if (!res.ok) throw new Error(`Adnami svarede ${res.status} for creative ${creativeCode} (findes det ID?)`);
  const text = ((await res.text()) || "").trim();
  if (!text) throw new Error("Adnami returnerede et tomt svar for dette creative-ID");
  return text;
}

// Pull slot width/height and the format type out of the served tag text.
function parseAdnamiSpec(text) {
  const w = /width:\s*(\d+)px/i.exec(text);
  const h = /height:\s*(\d+)px/i.exec(text);
  const t = /data-adnm-type=['"]?([\w-]+)/i.exec(text);
  const fn = /tag for ['"]([^'"]+)['"]/i.exec(text); // e.g. "… Seamless Skin …"
  const formatName = fn ? fn[1] : "";
  return {
    width:  w ? parseInt(w[1], 10) : 300,
    height: h ? parseInt(h[1], 10) : 240,
    type:   t ? t[1] : "",
    formatName,
    isSkin: /skin|wallpaper/i.test(formatName),
  };
}

// Derive a generic format keyword from the creative's format name — used to find a RUNNING
// ad of the SAME format on the page (matched against its data-adnm-fid) so we can auto-replace
// it. Site-agnostic: it reads Adnami's own format id, never slot names.
function formatKeyword(spec) {
  const s = ((spec && spec.formatName) || "").toLowerCase().replace(/\s+/g, "");
  const known = ["doublemidscroll", "midscroll", "topscroll", "interscroll", "understitial", "adnfilm", "skin", "wallpaper"];
  for (const k of known) if (s.includes(k)) return k === "wallpaper" ? "skin" : (k === "doublemidscroll" ? "midscroll" : k);
  return "";
}

// Non-destructive skin reveal: a skin paints a full-page background but the page's
// own opaque background hides it in the margins. We make html/body transparent with
// CSS only (NO node moving — that would trip the format's self-destruct watchdog),
// so the wallpaper shows in the left/right margins around the centered content.
async function revealSkinCss(page, contentWidth) {
  await page.evaluate((contentW) => {
    if (!document.getElementById("cx-skin-css")) {
      const st = document.createElement("style");
      st.id = "cx-skin-css";
      st.textContent = "html,body{background-color:transparent !important;background-image:none !important;}";
      (document.head || document.documentElement).appendChild(st);
    }
    const vw = window.innerWidth;
    const isAdnami = (el) =>
      /adnm|adsm/i.test(el.id || "") ||
      (typeof el.className === "string" && /adnm|adsm/i.test(el.className)) ||
      el.hasAttribute("data-cx-injected");
    const opaque = (cs) => {
      const c = cs.backgroundColor;
      const hasColor = c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent";
      const hasImg = cs.backgroundImage && cs.backgroundImage !== "none";
      return hasColor || hasImg;
    };
    // Constrain the site's OWN opaque full-width wrappers to a centered column so the
    // skin (a separate full-width layer behind them) shows in the margins. Descend
    // through transparent full-width containers to reach the real opaque wrappers.
    const constrain = (root, depth) => {
      if (depth > 5) return;
      for (const el of Array.from(root.children)) {
        if (el.nodeType !== 1) continue;
        if (isAdnami(el) || el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "LINK") continue;
        const r = el.getBoundingClientRect();
        if (r.width < vw * 0.9) continue; // not a full-width wrapper
        const cs = getComputedStyle(el);
        if (opaque(cs)) {
          el.style.setProperty("max-width", contentW + "px", "important");
          el.style.setProperty("margin-left", "auto", "important");
          el.style.setProperty("margin-right", "auto", "important");
        } else {
          constrain(el, depth + 1); // transparent container → look inside
        }
      }
    };
    constrain(document.body, 0);
  }, Math.max(600, parseInt(contentWidth, 10) || 1010)).catch(() => {});
  await page.waitForTimeout(400);
}

// Load the domain "macro" (adsm.macro.<domain>.js) and wait for window.adsm to
// initialise. Shared by the initial injection and by pick-placement (after reload).
async function loadAdnamiContext(page) {
  await page.evaluate(() => {
    // If the site's own Adnami engine is already up (it served ads), reuse it — don't
    // load a second macro (that risks double-init). Otherwise load the lite macro,
    // exactly like the extension's loadAdsv2() does before it injects a preview.
    try { const a = (window.top && window.top.adsm) || window.adsm; if (a && a.certifications) return; } catch (e) {}
    if (document.querySelector("script[data-adnm-macro]")) return;
    const h = window.location.host;
    const multiTld = /\.(co\.uk|gov\.uk|com\.uk|org\.uk|com\.vn|net\.vn|com\.ar|co\.jp|com\.au|org\.au|com\.cn|edu\.cn|gov\.cn|ac\.jp|co\.kr|or\.kr|go\.kr|com\.mx|org\.mx|co\.nz|org\.nz|gov\.nz|net\.nz|co\.il|com\.es|com\.br|com\.hk|com\.gr|com\.uy|info\.pl|com\.do|com\.tr|com\.ec)$/.test(h);
    const domain = multiTld ? h.split(".").slice(-3).join(".") : h.split(".").slice(-2).join(".");
    const macro = document.createElement("script");
    macro.async = true; macro.type = "text/javascript";
    macro.src = "https://functions.adnami.io/api/macro/adsm.macro." + domain + ".js";
    macro.setAttribute("adnm-lite", ""); macro.setAttribute("data-adnm-macro", "");
    (document.head || document.documentElement).appendChild(macro);
  }).catch(() => {});
  return await page.waitForFunction(() => {
    try { const a = (window.top && window.top.adsm) || window.adsm; return !!(a && a.certifications); }
    catch (e) { return !!(window.adsm && window.adsm.certifications); }
  }, { timeout: 9000 }).then(() => true).catch(() => false);
}

// Reveal a SKIN / wallpaper format: a skin renders as a full-page background on
// document.body, hidden on most sites by the page's own opaque backgrounds. We
// gather the site's real content into a centered column (leaving Adnami's own
// elements full-width behind) and make the page backgrounds transparent, so the
// skin shows through in the left/right margins. Best-effort — layout varies by site.
// Build the src for the PREVIEW iframe — a data: document containing the Adnami
// preview ins-tag, exactly like the "Adnami Tool" extension's inject(): note
// data-adnm-custom-adnm_preview="link" (the extension's preview flag) and that the
// engine <script> lives INSIDE the <ins>. Rendering the creative inside its own
// iframe (an isolated "ad slot") is what lets high-impact formats — including skins —
// attach to the page without tearing themselves down.
function adnamiPreviewSrc(creativeCode, type, w, h, ts) {
  const ins =
    `<ins style="display:inline-block;width:${w}px;height:${h}px" class="adnm-tag"` +
    ` data-adnm-cc="${creativeCode}" data-adnm-type="${type || ""}" data-adnm-click=""` +
    ` data-adnm-session="${ts}" data-adnm-unload="" data-adnm-custom-adnm_preview="link">` +
    `<script async src="${ADNAMI_ENGINE_SRC}"><\/script></ins>`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${ins}</body></html>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(doc);
}

// Build ONE clean *preview* ins-tag and load the Adnami render engine, then wait
// for the creative to mount. Two things make this work on an arbitrary page:
//   1. a single well-formed <ins> (not the ~20 DSP variants the endpoint lists), and
//   2. data-adnm-preview — Adnami's live tags only render on certified publisher
//      domains, but the preview flag lets the format render anywhere.
// This mirrors what the "Adnami Tool" browser extension does, server-side.
// `placement` is an optional CSS selector; when it matches an element the creative
// is appended there, otherwise it is placed at the top of <body>.
// Scroll the page to trigger the SITE'S OWN lazy-loaded Adnami ad slots, then wait
// for a real slot iframe (id "adsm-iframe-…") to appear. These are the "green boxes"
// the extension lets you click. Returns true if at least one real slot exists.
async function loadPageAds(page) {
  // Fast path: if the page already has a real Adnami slot, don't scroll at all.
  const already = await page.evaluate(() => !!document.querySelector('iframe[id^="adsm-iframe"]')).catch(() => false);
  if (already) return true;
  // Dwelling scroll so the ad auction runs and lazy Adnami slots fill — but stop AS SOON as
  // a real slot appears (don't keep scrolling for the full timeout). Faster load, same result.
  await page.evaluate(async () => {
    await new Promise((res) => {
      let y = 0, ticks = 0; const step = 600;
      const t = setInterval(() => {
        window.scrollBy(0, step); y += step; ticks++;
        if (document.querySelector('iframe[id^="adsm-iframe"]') && ticks > 3) { clearInterval(t); res(); return; }
        if (y >= document.body.scrollHeight - window.innerHeight || ticks > 40) { clearInterval(t); res(); }
      }, 250);
      setTimeout(() => { clearInterval(t); res(); }, 9000);
    });
    window.scrollTo(0, 0);
  }).catch(() => {});
  return await page.waitForFunction(
    () => !!document.querySelector('iframe[id^="adsm-iframe"]'),
    { timeout: 8000 }
  ).then(() => true).catch(() => false);
}

// Remove the site's OWN skin/topscroll takeover so OUR preview creative can become the
// page skin instead. This is the extension's settingOverrideAdnamiFormats. We keep any
// .adsm-sticky-wrapper whose wallpaper carries OUR creative code (that's our skin once
// it builds) and the slot we injected into; everything else (the site's live skin) is
// removed — and we keep removing for a few seconds in case the site rebuilds it.
// Remove ONLY the SAME format that our creative is — i.e. for a skin preview, remove the
// site's competing SKIN and put ours in its place. We deliberately leave every other
// format (topscroll, midscroll, banners) untouched so the page still shows its live ads.
async function clearSiteHighImpact(page, keepCc) {
  // Remove the competing SKIN ONCE. A repeating interval re-triggers Adnami's own
  // teardown (it rebuilds, we rip out, it tears everything down) — which wipes ALL
  // formats incl. topscroll/banners. The proven local recipe removes it a single time.
  await page.evaluate((keep) => {
    try {
      document.querySelectorAll(".adsm-sticky-wrapper").forEach((n) => {
        const wp = n.querySelector(".adsm-wallpaper[data-adnm-cc]");
        const cc = wp ? (wp.getAttribute("data-adnm-cc") || "").toLowerCase() : "";
        if (keep && cc && cc === keep) return;              // keep OUR skin
        if (n.querySelector("[data-cx-injected]")) return;  // keep the slot we injected into
        n.remove();                                          // drop the site's competing skin only
      });
    } catch (e) {}
  }, (keepCc || "").toLowerCase()).catch(() => {});
}

// Preview a creative on the page — the EXTENSION's method: let the site load its own
// Adnami ad slots, then anchor the preview in a REAL slot by cloning its iframe and
// pointing it at a data: document that carries the preview ins-tag. Running inside a
// real, fully-initialised Adnami placement is what lets high-impact formats (incl.
// skins) perform their full page takeover. Falls back to a synthetic tag if the page
// has no live Adnami slot.
// Navigate robustly through a flaky residential proxy: retry up to 4× and — crucially —
// verify the tab didn't land on chrome-error://chromewebdata/ (a failed/reset connection).
async function robustGoto(page, url, send) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }); }
    catch (e) { /* check the resulting URL below before deciding */ }
    let cur = ""; try { cur = page.url(); } catch (e) {}
    if (cur && !cur.startsWith("chrome-error") && cur !== "about:blank") return true;
    if (attempt < 3) {
      if (send) send({ t: "status", msg: "Forbindelsen fejlede — prøver igen (" + (attempt + 2) + "/4)…" });
      await page.waitForTimeout(900 + attempt * 900);
    }
  }
  return false;
}

// Is the page currently on a sign-in wall? (URL looks like login, or a password field is shown.)
async function needsLogin(page) {
  try {
    if (/\/login|\/signin|\/log-in|\/auth|\/logga-in|\/logind|\/sign-in/i.test(page.url())) return true;
    return await page.evaluate(() => !!document.querySelector('input[type="password"]')).catch(() => false);
  } catch (e) { return false; }
}
// Fill + submit the login form. Uses the config's selectors if given, else a generic heuristic
// (first text/email input = username, input[type=password] = password, a submit button / Enter).
async function autoLogin(page, cfg, send) {
  const passSel = cfg.passSel || 'input[type="password"]';
  // The login page can be slow through the residential proxy, and a consent wall can cover the
  // form. Retry a few times: accept consent, then wait (generously) for the password field.
  let passHandle = null;
  for (let attempt = 1; attempt <= 3 && !passHandle; attempt++) {
    await giveConsent(page).catch(() => {});
    if (send && attempt > 1) send({ t: "status", msg: `Venter på login-formular… (forsøg ${attempt}/3)` });
    try { passHandle = await page.waitForSelector(passSel, { timeout: 12000, state: "visible" }); } catch (e) { passHandle = null; }
  }
  if (!passHandle) { if (send) send({ t: "notice", msg: "Auto-login: adgangskodefeltet dukkede aldrig op (siden loadede måske for langsomt gennem proxyen). Tryk Genindlæs." }); return false; }
  try {
    if (send) send({ t: "status", msg: "Logger ind…" });
    // Username field: explicit selector if given, else the visible non-password input nearest
    // BEFORE the password in the same form (robust across almost any login layout).
    let userHandle = null;
    if (cfg.userSel) userHandle = await page.$(cfg.userSel).catch(() => null);
    if (!userHandle) {
      const js = await page.evaluateHandle((pass) => {
        const scope = pass.closest("form") || document;
        const all = Array.from(scope.querySelectorAll("input"));
        const bad = ["password", "hidden", "submit", "button", "checkbox", "radio", "file", "image", "reset"];
        const visible = (i) => !!(i.offsetParent || (i.getClientRects && i.getClientRects().length));
        const cand = all.filter((i) => visible(i) && !bad.includes((i.getAttribute("type") || "text").toLowerCase()));
        const pIdx = all.indexOf(pass);
        const before = cand.filter((i) => all.indexOf(i) < pIdx);
        return before.length ? before[before.length - 1] : (cand[0] || null);
      }, passHandle);
      userHandle = js && js.asElement ? js.asElement() : null;
    }
    if (!userHandle) { if (send) send({ t: "notice", msg: "Fandt ikke brugernavn-feltet — angiv 'userSel' i SITE_LOGINS." }); return false; }
    await userHandle.fill(String(cfg.user == null ? "" : cfg.user));
    await passHandle.fill(String(cfg.pass == null ? "" : cfg.pass));
    if (cfg.submitSel) {
      await page.click(cfg.submitSel, { timeout: 5000 }).catch(() => {});
    } else {
      const btn = page.locator('button[type="submit"], input[type="submit"], button:has-text("Log ind"), button:has-text("Logga in"), button:has-text("Logga"), button:has-text("Login"), button:has-text("Log in"), button:has-text("Sign in")').first();
      if (await btn.count().catch(() => 0)) await btn.click({ timeout: 5000 }).catch(() => {});
      else await passHandle.press("Enter").catch(() => {});
    }
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
    return true;
  } catch (e) { if (send) send({ t: "notice", msg: "Auto-login fejlede: " + String(e && e.message || e) }); return false; }
}
// Ensure the page is logged in for a configured site: reuse a cached session, else auto-login
// with the env-stored credentials and cache the resulting session. Returns true if we logged in.
async function ensureLoggedIn(page, url, context, send) {
  const cfg = getLogin(url);
  if (!cfg) return false;                          // domain not configured → do nothing
  // Cookie consent FIRST — the login wall often needs consent before the form works, and
  // accepting it can RELOAD the page (which would otherwise wipe a premature login).
  await giveConsent(page).catch(() => {});
  await page.waitForTimeout(600);
  // A deep page (e.g. /start/) often redirects to /login when logged out — give a late / JS
  // redirect a moment to land before we conclude that we're already signed in.
  let need = await needsLogin(page);
  if (!need) { await page.waitForTimeout(1500); need = await needsLogin(page); }
  if (!need) {                                     // already logged in (cached session worked)
    try { SESSION_CACHE.set(hostKey(url), await context.storageState()); } catch (e) {} // refresh cache (now incl. consent cookie)
    return false;
  }
  if (send) send({ t: "status", msg: "Login-side fundet — logger automatisk ind…" });
  const ok = await autoLogin(page, cfg, send);
  if (ok) {
    // autoLogin's submit already redirected us to the signed-in page. DON'T navigate back to
    // `url` — that URL is the /login page, so re-loading it would sign us straight back out.
    // Only if we somehow ended up back on a login page do we retry once.
    if (await needsLogin(page)) await robustGoto(page, url, send).catch(() => {});
    await giveConsent(page).catch(() => {});       // accept consent on the post-login page (for ads)
    try { SESSION_CACHE.set(hostKey(url), await context.storageState()); } catch (e) {} // cache cookies+consent so it's reused next time
    if (send) send({ t: "notice", msg: "Logget ind ✓" });
  }
  return ok;
}

async function injectAdnami(page, creativeCode, placement, preSpec) {
  let spec = preSpec || { width: 300, height: 240, type: "" };
  let fetchNote = "";
  if (!preSpec) {
    try { spec = parseAdnamiSpec(await fetchAdnamiInsTags(creativeCode)); }
    catch (e) { fetchNote = String(e.message || e); }
  }

  // Let the site load its own Adnami slots (incl. the high-impact skin/topscroll slot).
  // We then REPLACE that real slot with the preview — exactly what the Adnami extension
  // does. Running inside the site's real skin container is what lets the wings paint;
  // a detached top-level <ins> only ever gets the top band, never the side wings.
  // Load the site's ads first, THEN the Adnami macro context (sequential — loadAdnamiContext
  // self-skips if the site's own engine is already up). Reverted from a parallel version that
  // risked a double-init race with the site's own engine.
  const hasSlot = await loadPageAds(page);
  await loadAdnamiContext(page);

  // LIVE tool: "Vis format" for a SKIN with NO chosen placement.
  //  • If the site is ALREADY running a (foreign) skin → auto-replace it in its own slot
  //    (the user's rule: an existing skin gets replaced automatically). We compute the top-
  //    centre point of that running skin and reuse the proven placeAdnamiAt() flow.
  //  • If NO skin is running → do NOT auto-inject (injecting a skin at <body> is wrong and
  //    disturbs the page). Leave the real ads and let the user point the crosshair.
  if (!placement) {
    // AUTO-REPLACE: find a RUNNING ad of the SAME format as our creative and swap it in place.
    // Matched via Adnami's own format id (data-adnm-fid) — site-agnostic, no slot names.
    const kw = formatKeyword(spec);
    const info = await page.evaluate(({ ourCc, kw, isSkin }) => {
      const R = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) }; };
      const all = Array.from(document.querySelectorAll("[data-adnm-fid]"));
      const fids = all.map((el) => (el.getAttribute("data-adnm-fid") || "").toLowerCase()).filter(Boolean);
      // Broad diagnostics: what Adnami markup does a running (mid)scroll actually leave in the main doc?
      const marks = {
        fids,
        adsmIframes: Array.from(document.querySelectorAll('iframe[id^="adsm-iframe"], iframe[id*="adnm" i]')).slice(0, 8).map((f) => f.id + "(" + R(f).w + "x" + R(f).h + ")"),
        adnmClasses: ((document.documentElement.className || "") + " " + (document.body ? document.body.className : "")).split(/\s+/).filter((c) => /adnm|adsm|midscroll|interscroll|topscroll/i.test(c)).slice(0, 10),
        adnmEls: Array.from(document.querySelectorAll('[class*="midscroll" i],[id*="midscroll" i],[class*="adnm-html" i],[class*="adsm-" i]')).slice(0, 8).map((e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : "")),
      };
      let pt = null;
      // SKIN → use the running wallpaper (content-centre, top band of the skin position).
      if (isSkin) {
        const wraps = Array.from(document.querySelectorAll(".adsm-sticky-wrapper"));
        for (const wr of wraps) {
          const wp = wr.querySelector(".adsm-wallpaper[data-adnm-cc]");
          const cc = wp ? (wp.getAttribute("data-adnm-cc") || "").toLowerCase() : "";
          const served = wr.querySelector('iframe[id^="adsm-iframe"], iframe[src]');
          if (cc && cc !== ourCc && served) {
            const wl = wr.querySelector(".adsm-wallpaper-l"), wrr = wr.querySelector(".adsm-wallpaper-r");
            let cx = Math.round(window.innerWidth / 2);
            if (wl && wrr) { const a = wl.getBoundingClientRect(), b = wrr.getBoundingClientRect(); cx = Math.round((a.right + b.left) / 2); }
            pt = { x: cx, y: Math.round(wp.getBoundingClientRect().top + 20) }; break;
          }
        }
        return { pt, marks, kw };
      }
      // NON-SKIN → (1) match by fid keyword on any element carrying data-adnm-fid.
      const tryMatch = (el) => {
        const cc = (el.getAttribute("data-adnm-cc") || "").toLowerCase();
        if (cc === ourCc) return false;
        let r = el.getBoundingClientRect(); if (r.width < 20 || r.height < 20) return false;
        el.scrollIntoView({ block: "center" }); r = el.getBoundingClientRect();
        pt = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 150)) };
        return true;
      };
      if (kw) {
        for (const el of all) { const fid = (el.getAttribute("data-adnm-fid") || "").toLowerCase(); if (fid.includes(kw) && tryMatch(el)) break; }
        // (2) fallback: an element whose class/id mentions the format keyword (e.g. adnm-html-midscroll).
        if (!pt) {
          for (const el of Array.from(document.querySelectorAll('[class*="' + kw + '" i],[id*="' + kw + '" i]'))) { if (tryMatch(el)) break; }
        }
      }
      return { pt, marks, kw };
    }, { ourCc: (creativeCode || "").toLowerCase(), kw, isSkin: !!spec.isSkin }).catch(() => ({ pt: null, marks: {}, kw }));
    if (info && info.pt) {
      const rr = await placeAdnamiAt(page, creativeCode, info.pt.x, info.pt.y, true); // warmed: skip 2nd ad-load
      return { ok: true, mounted: !!(rr && rr.mounted), ours: !!(rr && rr.ours), auto: true, isSkin: !!spec.isSkin };
    }
    // No matching running ad → show the real ads and let the user point the crosshair.
    return { ok: true, mounted: false, needsPlacement: true, hasSlot, isSkin: !!spec.isSkin, kw, marks: (info && info.marks) || {}, formatName: spec.formatName };
  }

  // For a SKIN, clear the site's OWN competing skin first (once) — otherwise the site's
  // live campaign keeps the skin slot and OUR creative never becomes the page takeover.
  if (spec.isSkin) await clearSiteHighImpact(page, creativeCode);
  let result = null, method = "";

  // PRIMARY — the extension's autoIframe(), but anchored in the CHOSEN placement: create a
  // hidden 0×0 SAME-ORIGIN iframe INSIDE the ad slot the user pointed at (e.g. the skin
  // placement) and write our preview <ins> + engine into it. Proven locally: injecting into
  // the real SKIN placement makes the engine build the full seamless skin in full viewport
  // width with wings in the margins. Injecting at <body> or a topscroll slot does NOT.
  result = await page.evaluate(({ creativeCode, spec, engineSrc, placement, isSkin }) => {
    try {
      document.querySelectorAll("[data-cx-injected]").forEach((n) => n.remove());
      let host = null;
      if (placement) { try { host = document.querySelector(placement); } catch (e) { host = null; } }
      if (!host) host = document.body;
      const mkIns = (doc) => {
        const ins = doc.createElement("ins");
        ins.className = "adnm-tag";
        ins.style.cssText = `display:inline-block;width:${spec.width}px;height:${spec.height}px`;
        ins.setAttribute("data-adnm-cc", creativeCode);
        if (spec.type) ins.setAttribute("data-adnm-type", spec.type);
        ins.setAttribute("data-adnm-click", "");
        ins.setAttribute("data-adnm-session", String(Date.now()));
        ins.setAttribute("data-adnm-unload", "");
        ins.setAttribute("data-adnm-custom-adnm_preview", "link");
        const s = doc.createElement("script"); s.async = true; s.type = "text/javascript"; s.src = engineSrc; ins.appendChild(s);
        return ins;
      };
      if (isSkin) {
        const html = document.documentElement;
        Array.from(html.classList).forEach((k) => { if (/^adsm-skin/i.test(k)) html.classList.remove(k); });
        if (host !== document.body) host.querySelectorAll("iframe, div[id^='google_ads_iframe']").forEach((k) => k.remove());
        const ifr = document.createElement("iframe");
        ifr.width = "0"; ifr.height = "0"; ifr.style.cssText = "width:0;height:0;border:0;";
        ifr.setAttribute("data-cx-injected", ""); ifr.setAttribute("adnm-preview-adunit", "true");
        host.appendChild(ifr);
        const d = ifr.contentWindow && ifr.contentWindow.document;
        if (!d) return { ok: false, reason: "no-doc" };
        d.open(); d.write('<!doctype html><html><head></head><body style="margin:0"></body></html>'); d.close();
        const holder = d.createElement("div"); holder.appendChild(mkIns(d)); d.body.appendChild(holder);
        return { ok: true, mode: "skin-iframe", usedHost: host.id || host.tagName };
      }
      // In-content format: a real sized <ins> so it renders visibly.
      const wrap = document.createElement("div");
      wrap.setAttribute("data-cx-injected", ""); wrap.style.cssText = "display:block;max-width:100%";
      wrap.appendChild(mkIns(document));
      if (host === document.body && host.firstChild) host.insertBefore(wrap, host.firstChild); else host.appendChild(wrap);
      return { ok: true, mode: "sized-ins", usedHost: host.id || host.tagName };
    } catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
  }, { creativeCode, spec, engineSrc: ADNAMI_ENGINE_SRC, placement: placement || "", isSkin: !!spec.isSkin });
  method = "auto-iframe";

  // FALLBACK — if the hidden-iframe write failed, inject a plain top-level ins.
  if (!result || !result.ok) {
    result = await page.evaluate(({ creativeCode, spec, engineSrc }) => {
      try {
        document.querySelectorAll("[data-cx-injected]").forEach((n) => n.remove());
        const ins = document.createElement("ins");
        ins.className = "adnm-tag";
        ins.style.cssText = `display:inline-block;width:${spec.width}px;height:${spec.height}px`;
        ins.setAttribute("data-adnm-cc", creativeCode);
        if (spec.type) ins.setAttribute("data-adnm-type", spec.type);
        ins.setAttribute("data-adnm-custom-adnm_preview", "link");
        ins.setAttribute("data-cx-injected", "");
        if (document.body.firstChild) document.body.insertBefore(ins, document.body.firstChild); else document.body.appendChild(ins);
        const s = document.createElement("script"); s.async = true; s.type = "text/javascript"; s.src = engineSrc;
        ins.appendChild(s);
        return { ok: true };
      } catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
    }, { creativeCode, spec, engineSrc: ADNAMI_ENGINE_SRC });
    method = "fallback-ins";
  }

  if (!result || !result.ok) throw new Error("Kunne ikke forankre Adnami-preview på siden" + (fetchNote ? (" (" + fetchNote + ")") : ""));

  // Poll (max ~7s) — return AS SOON AS OUR creative renders (format-agnostic).
  let mounted = false, ours = false;
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(500);
    const d = await page.evaluate((cc) => {
      cc = (cc || "").toLowerCase();
      let present = false, rendered = false;
      document.querySelectorAll("[data-adnm-cc]").forEach((el) => {
        if ((el.getAttribute("data-adnm-cc") || "").toLowerCase() === cc) {
          present = true;
          if (el.classList.contains("adsm-wallpaper") || el.querySelector("iframe")) rendered = true;
        }
      });
      return { present, rendered };
    }, creativeCode).catch(() => ({ present: false, rendered: false }));
    mounted = d.rendered || d.present; ours = d.rendered;
    if (d.rendered) break;
  }
  return { ok: true, mounted, ours, method, hasSlot, fetchNote, isSkin: spec.isSkin };
}

// Re-place the creative at a clicked point (device CSS px). To guarantee the ad
// never shows in two places, we capture a selector for the clicked slot, RELOAD the
// page (wiping the previous render completely), then inject ONCE — replacing that slot.
async function placeAdnamiAt(page, creativeCode, x, y, warmed) {
  // 1) From the clicked point, resolve the SITE'S OWN slot — fully site-agnostic (no id or
  //    slot-name assumptions, works with or without Google GPT). Universal principle: an ad
  //    always sits in an IFRAME (or a GPT container "google_ads_iframe…", Google's universal
  //    naming), and that node is placed inside the site's own slot element. So the site slot
  //    is the PARENT of the HIGHEST ad node (iframe/GPT container) above the click.
  const selector = await page.evaluate(({ x, y }) => {
    function stableSelector(host) {
      if (host.id) return "#" + CSS.escape(host.id);
      const parts = []; let e = host;
      while (e && e.nodeType === 1 && e !== document.body && e !== document.documentElement && parts.length < 8) {
        if (e.id) { parts.unshift("#" + CSS.escape(e.id)); break; }
        let sel = e.tagName.toLowerCase();
        const p = e.parentElement;
        if (p) { const sibs = Array.from(p.children).filter((c) => c.tagName === e.tagName); if (sibs.length > 1) sel += ":nth-of-type(" + (sibs.indexOf(e) + 1) + ")"; }
        parts.unshift(sel); e = e.parentElement;
      }
      return parts.join(" > ");
    }
    let el = document.elementFromPoint(x, y);
    if (!el || el === document.documentElement || el === document.body) return "";
    // Find the highest ad node (cross-origin iframe OR GPT container) on the ancestor path.
    let highestAd = (el.tagName === "IFRAME") ? el : null;
    let n = el, guard = 0;
    while (n && n !== document.body && n.nodeType === 1 && guard++ < 12) {
      const isCrossFrame = n.tagName === "IFRAME";
      const isGpt = n.id && /^google_ads_iframe/i.test(n.id);
      if (isCrossFrame || isGpt) highestAd = n;
      n = n.parentElement;
    }
    // Site slot = parent of the highest ad node; if no ad node, use the clicked element.
    let host = highestAd ? highestAd.parentElement : el;
    if (!host || host === document.body || host === document.documentElement) return "";
    return stableSelector(host);
  }, { x: Math.round(x), y: Math.round(y) });

  // 2) Fetch spec + warm up the page's Adnami engine. No reload — keep the loaded page.
  //    `warmed` = the caller already ran loadPageAds/loadAdnamiContext (skip the slow
  //    scroll+wait again — this is the big latency saver in the auto-skin flow).
  let spec = { width: 300, height: 240, type: "" };
  try { spec = parseAdnamiSpec(await fetchAdnamiInsTags(creativeCode)); } catch (e) { /* defaults */ }
  if (!warmed) { await loadPageAds(page).catch(() => {}); await loadAdnamiContext(page).catch(() => {}); }
  // Remove ONLY a competing SKIN — topscroll / midscroll / other ads stay untouched.
  if (spec.isSkin) await clearSiteHighImpact(page, creativeCode);

  // 3) Inject INTO the site's own slot, branching by how the format renders:
  //     • SKIN → 0×0 same-origin iframe (the engine escapes it and paints the full-page
  //       takeover with wings). Strip only old skin classes; keep topscroll offset.
  //     • EVERY OTHER FORMAT (midscroll / interscroll / banner …) renders IN PLACE, so it
  //       needs a real SIZED <ins> in the slot — a 0×0 anchor would make it invisible.
  const result = await page.evaluate(({ creativeCode, spec, engineSrc, selector, isSkin }) => {
    try {
      document.querySelectorAll("[data-cx-injected]").forEach((n) => n.remove());
      let host = null;
      if (selector) { try { host = document.querySelector(selector); } catch (e) { host = null; } }
      if (!host) host = document.body;
      // Empty the clicked slot's old ad content so OUR creative replaces it in the same spot.
      if (host !== document.body) host.querySelectorAll("iframe, div[id^='google_ads_iframe']").forEach((k) => k.remove());

      const mkIns = (doc) => {
        const ins = doc.createElement("ins");
        ins.className = "adnm-tag";
        ins.style.cssText = `display:inline-block;width:${spec.width}px;height:${spec.height}px`;
        ins.setAttribute("data-adnm-cc", creativeCode);
        if (spec.type) ins.setAttribute("data-adnm-type", spec.type);
        ins.setAttribute("data-adnm-click", "");
        ins.setAttribute("data-adnm-session", String(Date.now()));
        ins.setAttribute("data-adnm-unload", "");
        ins.setAttribute("data-adnm-custom-adnm_preview", "link");
        const s = doc.createElement("script"); s.async = true; s.type = "text/javascript"; s.src = engineSrc; ins.appendChild(s);
        return ins;
      };

      if (isSkin) {
        const html = document.documentElement;
        Array.from(html.classList).forEach((k) => { if (/^adsm-skin/i.test(k)) html.classList.remove(k); });
        const ifr = document.createElement("iframe");
        ifr.width = "0"; ifr.height = "0"; ifr.style.cssText = "width:0;height:0;border:0;";
        ifr.setAttribute("data-cx-injected", ""); ifr.setAttribute("adnm-preview-adunit", "true");
        host.appendChild(ifr);
        const d = ifr.contentWindow && ifr.contentWindow.document;
        if (!d) return { ok: false, reason: "no-doc" };
        d.open(); d.write('<!doctype html><html><head></head><body style="margin:0"></body></html>'); d.close();
        const holder = d.createElement("div"); holder.appendChild(mkIns(d)); d.body.appendChild(holder);
        return { ok: true, mode: "skin-iframe", usedHost: host.id || host.tagName };
      }
      // In-content format: a real sized <ins> straight in the slot (visible).
      const wrap = document.createElement("div");
      wrap.setAttribute("data-cx-injected", "");
      wrap.style.cssText = "display:block;max-width:100%";
      wrap.appendChild(mkIns(document));
      host.appendChild(wrap);
      return { ok: true, mode: "sized-ins", usedHost: host.id || host.tagName };
    } catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
  }, { creativeCode, spec, engineSrc: ADNAMI_ENGINE_SRC, selector, isSkin: !!spec.isSkin });

  // 4) Poll (max ~7s) — return AS SOON AS OUR creative renders (format-agnostic: it either
  //    becomes a wallpaper, or its <ins> gets a rendered iframe child).
  let diag = { ours: false, present: false };
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(500);
    diag = await page.evaluate((cc) => {
      cc = (cc || "").toLowerCase();
      let present = false, rendered = false;
      document.querySelectorAll("[data-adnm-cc]").forEach((el) => {
        if ((el.getAttribute("data-adnm-cc") || "").toLowerCase() === cc) {
          present = true;
          if (el.classList.contains("adsm-wallpaper") || el.querySelector("iframe")) rendered = true;
        }
      });
      return { ours: rendered, present };
    }, creativeCode).catch(() => diag);
    if (diag.ours) break;
  }
  // Only a skin needs the viewport at the very top; in-content formats stay where placed.
  if (spec.isSkin) await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  return { ok: true, mounted: diag.ours || diag.present, ours: diag.ours, present: diag.present, selector, isSkin: !!spec.isSkin, usedHost: result && result.usedHost, injected: result };
}

/* ------------------------------------------------------------------ *
 * Render one screenshot                                               *
 * ------------------------------------------------------------------ */
async function renderShot({ url, device, landscape, fullPage, format, manualConsent, creative, placement }) {
  const dev = DEVICES[device] || DEVICES[DEFAULT_DEVICE];
  let vw = dev.w, vh = dev.h;
  if (dev.mobile && landscape) { vw = dev.h; vh = dev.w; }

  // Pre-fetch the creative spec up front (plain HTTP, no page needed) so we know BEFORE
  // loading the page whether this is a skin — that decision drives request filtering.
  let preSpec = null, skinPreview = false;
  if (creative) {
    try { preSpec = parseAdnamiSpec(await fetchAdnamiInsTags(creative)); skinPreview = !!preSpec.isSkin; }
    catch { /* injectAdnami will retry / use defaults */ }
  }

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: vw, height: vh },
    deviceScaleFactor: Math.min(dev.dsf, MAX_DSF), // cap ratio so tall pages don't produce huge bitmaps
    isMobile: dev.mobile,
    hasTouch: dev.mobile,
    userAgent: dev.ua,
    locale: LOCALE,
    timezoneId: TIMEZONE,
    ignoreHTTPSErrors: true,
  });

  // Drop heavy media (video/audio) to save memory — ad creatives still load. We do NOT
  // block the site's own ads: the preview REPLACES the site's real (skin) slot, so that
  // slot must load first. The site's other ads may coexist — that's intended.
  if (BLOCK_MEDIA) {
    await context.route("**/*", (route) => {
      if (route.request().resourceType() === "media") return route.abort();
      return route.continue();
    }).catch(() => {});
  }

  const page = await context.newPage();
  const type = format === "png" ? "png" : "jpeg";
  const quality = type === "jpeg" ? 82 : undefined;
  let adnamiError = null; // non-fatal: page is still returned even if injection fails

  const work = (async () => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    // Creative previews REPLACE the site's real ad slot, so we give full TCF consent and
    // let the site's auction serve its slots (incl. the skin/topscroll slot we hijack).
    if (!manualConsent) {
      if (creative) await giveConsent(page);
      else await dismissConsent(page);
    }
    // give ad tags a moment, then scroll to trigger lazy slots, then settle
    await page.waitForTimeout(1200);
    // Inject the chosen Adnami creative before scrolling so lazy formats mount.
    if (creative) {
      try {
        const r = await injectAdnami(page, creative, placement, preSpec);
        if (r && r.mounted === false) {
          adnamiError = "creative mountede ikke (ukendt ID, forkert format-type, eller Adnami afviste preview)"
            + (r.fetchNote ? " · " + r.fetchNote : "");
        }
      } catch (e) { adnamiError = String(e.message || e); }
    }
    // For skins, do NOT auto-scroll — the skin is already sticky over the full page and
    // scrolling only lets the site's own lazy ads load and overwrite it.
    if (!skinPreview) await autoScroll(page);
    await page.waitForLoadState("networkidle", { timeout: skinPreview ? 3000 : 8000 }).catch(() => {});
    await page.waitForTimeout(skinPreview ? 500 : 1500);

    // A SKIN is a viewport-height takeover with STICKY wings — it's meant to be seen as
    // ONE screen (just like the Adnami extension's own preview). Growing the viewport to
    // full page height flattens the sticky wings (they'd only show at the very top) and
    // can reflow/break the skin, so for skins we capture the viewport as-is.
    if (skinPreview) {
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await page.waitForTimeout(300);
      return await page.screenshot({ type, quality, fullPage: false });
    }

    // Grow the viewport to the (capped) page height so ALL content — including
    // below-the-fold ads — is laid out and captured. NOTE: a clip that extends
    // past the viewport does NOT capture below-fold content in Chromium, which
    // is why we resize instead. Height is capped so very long pages stay memory-safe.
    let pageH = vh;
    try {
      pageH = await page.evaluate(() =>
        Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, window.innerHeight));
    } catch { /* keep default */ }
    const capH = Math.max(vh, Math.min(pageH, adaptiveMaxHeight(dev)));

    try {
      await page.setViewportSize({ width: vw, height: capH });
      await page.waitForTimeout(600); // let reflow + lazy content settle
      return await page.screenshot({ type, quality });
    } catch {
      // Fallback: just the visible viewport (always small + safe).
      return await page.screenshot({ type, quality, fullPage: false });
    }
  })();

  // Hard timeout so a hanging page can't tie up a worker slot forever.
  const guard = new Promise((_, rej) =>
    setTimeout(() => rej(new Error("render timeout")), RENDER_TIMEOUT_MS));

  try {
    const buf = await Promise.race([work, guard]);
    return { buf, type, adnamiError };
  } finally {
    await context.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 * Routes                                                              *
 * ------------------------------------------------------------------ */
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.set("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    version: ENGINE_VERSION,
    proxy: proxyInfo(),
    devices: Object.keys(DEVICES),
    // --- instrumentation ("measure first") ---
    uptimeSec: Math.round((Date.now() - METRICS.startedAt) / 1000),
    nodeCpuPercentOneCore: METRICS.cpuPercent,      // just the Node relay process (usually tiny)
    containerCpuPercentOneCore: METRICS.containerCpuPercentOneCore, // WHOLE container incl. Chromium (right now)
    peakContainerCpuPercentOneCore: METRICS.peakContainerCpuPercentOneCore, // ← scroll ~20s, then read THIS (highest seen)
    peakContainerCpuPercentOfQuota: METRICS.peakContainerCpuPercentOfQuota, // ≈100 = container maxed its CPU allocation → CPU-bound
    containerCpuPercentOfQuota: METRICS.containerCpuPercentOfQuota, // ≈100 = container is maxing its CPU allocation (throttled)
    allocatedCores: METRICS.allocatedCores,         // CPU cores the plan actually gives this container
    hostCores: METRICS.cores,
    loadAvg1: Math.round((os.loadavg()[0] || 0) * 100) / 100,
    memory: { rssMB: Math.round(mem.rss / 1048576), heapUsedMB: Math.round(mem.heapUsed / 1048576) },
    renders: { active: METRICS.renders.active, queueDepth: queue.length, total: METRICS.renders.total },
    live: { active: METRICS.live.active, total: METRICS.live.total },
    stream: streamStats(),                          // "right now" (last ~12s): fps, avgFrameKB, dropRatePct, peakBufferedKB, lastSendMs, frameLatencyMs
    // CUMULATIVE over the whole session — read THESE after scrolling around; no timing needed.
    framesTotal: {
      sent: METRICS.frames.sent,
      dropped: METRICS.frames.dropped,
      dropRatePct: (METRICS.frames.sent + METRICS.frames.dropped) ? Math.round(METRICS.frames.dropped / (METRICS.frames.sent + METRICS.frames.dropped) * 100) : 0,
      avgFrameKB: METRICS.frames.sent ? Math.round(METRICS.frames.bytesSent / METRICS.frames.sent / 1024) : 0,
      peakBufferedKB: METRICS.frames.peakBufferedKB,
    },
  });
});

// Clear the cached session (cookies + consent) for one host — powers the frontend's
// "Ryd session". Consent is re-asked on the next preview; login sites simply auto-login again.
app.get("/clear-session", (req, res) => {
  if (RENDER_TOKEN && req.query.token !== RENDER_TOKEN) return res.status(401).json({ error: "Ugyldig token" });
  const host = hostKey(req.query.url || "") || String(req.query.host || "").toLowerCase().trim();
  if (!host) return res.status(400).json({ error: "Mangler url/host" });
  const cleared = SESSION_CACHE.delete(host);
  res.json({ ok: true, host, cleared });
});

// Confirm the OUTBOUND IP the browser actually uses. Open this (with ?token=…) after
// setting PROXY_URL to verify you now have a Danish IP: it loads an IP-echo service
// THROUGH the browser (so it reflects the proxy) and returns country/city/org.
app.get("/myip", async (req, res) => {
  if (RENDER_TOKEN && req.query.token !== RENDER_TOKEN) return res.status(401).json({ error: "Ugyldig token" });
  const context = await (await getBrowser()).newContext({ locale: LOCALE, timezoneId: TIMEZONE, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await page.goto("https://ipinfo.io/json", { waitUntil: "domcontentloaded", timeout: 20000 });
    const txt = await page.evaluate(() => document.body.innerText || "");
    let data; try { data = JSON.parse(txt); } catch { data = { raw: txt.slice(0, 500) }; }
    const danish = String(data.country || "").toUpperCase() === "DK";
    return res.json({ proxy: proxyInfo(), danishIp: danish, ip: data });
  } catch (e) {
    return res.status(502).json({ proxy: proxyInfo(), error: String(e.message || e) });
  } finally {
    await context.close().catch(() => {});
  }
});

// Debug: what does the engine actually get from Adnami for a creative, and what
// spec does it parse? Handy for diagnosing "the format won't show" without a browser.
app.get("/adnami-tag", async (req, res) => {
  if (RENDER_TOKEN && req.query.token !== RENDER_TOKEN) return res.status(401).json({ error: "Ugyldig token" });
  let creative;
  try { creative = normalizeCreative(req.query.creative); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (!creative) return res.status(400).json({ error: "Mangler ?creative" });
  try {
    const text = await fetchAdnamiInsTags(creative);
    res.json({ ok: true, creative, url: ADNAMI_INSTAGS_URL(creative), spec: parseAdnamiSpec(text), rawLength: text.length, rawSample: text.slice(0, 1400) });
  } catch (e) {
    res.status(502).json({ ok: false, creative, url: ADNAMI_INSTAGS_URL(creative), error: String(e.message || e) });
  }
});

// FAST check: does the page load its OWN Adnami ad slots in this (headless) engine?
// Returns quickly so it can be read remotely. Key question: are there real
// "adsm-iframe" slots (the extension's green boxes) after a brief scroll?
app.get("/adnm-slots", async (req, res) => {
  if (RENDER_TOKEN && req.query.token !== RENDER_TOKEN) return res.status(401).json({ error: "Ugyldig token" });
  const rawUrl = String(req.query.url || "").trim();
  if (!rawUrl) return res.status(400).json({ error: "Mangler ?url" });
  const device = String(req.query.device || DEFAULT_DEVICE);
  let safeUrl;
  try { safeUrl = await assertSafeUrl(rawUrl); } catch (e) { return res.status(400).json({ error: e.message }); }
  const dev = DEVICES[device] || DEVICES[DEFAULT_DEVICE];
  const context = await (await getBrowser()).newContext({
    viewport: { width: dev.w, height: dev.h }, deviceScaleFactor: 1,
    isMobile: dev.mobile, hasTouch: dev.mobile, userAgent: dev.ua,
    locale: LOCALE, timezoneId: TIMEZONE, ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  const out = { version: ENGINE_VERSION, url: safeUrl };
  try {
    try { await page.goto(safeUrl, { waitUntil: "domcontentloaded", timeout: 18000 }); } catch (e) { out.gotoNote = String(e.message || e); }
    await giveConsent(page);
    out.consent = await consentState(page);
    // Brief scroll to trigger above/mid-fold ad slots (kept short so this returns fast).
    await page.evaluate(() => new Promise((r) => { let y = 0; const t = setInterval(() => { window.scrollBy(0, 900); y += 900; if (y > 6000) { clearInterval(t); r(); } }, 180); setTimeout(() => { clearInterval(t); r(); }, 3500); })).catch(() => {});
    await page.waitForTimeout(1000);
    Object.assign(out, await page.evaluate(() => ({
      slotCount: document.querySelectorAll('iframe[id^="adsm-iframe"]').length,
      slotIds: Array.from(document.querySelectorAll('iframe[id^="adsm-iframe"]')).slice(0, 12).map((s) => s.id),
      insAdnmTags: document.querySelectorAll("ins.adnm-tag").length,
      anyAdIframes: document.querySelectorAll('iframe[id*="google_ads"], iframe[src*="doubleclick"], iframe[id*="adsm"], iframe[id*="adnm"]').length,
      adnamiScripts: Array.from(document.querySelectorAll('script[src*="adnami"]')).map((s) => s.src.slice(0, 130)).slice(0, 20),
      webdriver: navigator.webdriver === true,
    })));
    return res.json(out);
  } catch (e) {
    out.error = String(e.message || e);
    return res.status(502).json(out);
  } finally {
    await context.close().catch(() => {});
  }
});

// Deep debug: actually loads the page, injects the creative, and reports what
// Adnami's script does at runtime — did the render engine + host macro load, is
// window.adsm present with certifications, did the creative iframe mount, and any
// console errors (e.g. CSP violations or a blockedReason). Read this via the URL
// to see exactly why a format won't show, without needing a browser to watch it.
app.get(["/adnami-render-debug", "/adnm-inspect", "/adnm-inspect2"], async (req, res) => {
  if (RENDER_TOKEN && req.query.token !== RENDER_TOKEN) return res.status(401).json({ error: "Ugyldig token" });
  const rawUrl = String(req.query.url || "").trim();
  if (!rawUrl) return res.status(400).json({ error: "Mangler ?url" });
  let creative;
  try { creative = normalizeCreative(req.query.creative); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (!creative) return res.status(400).json({ error: "Mangler ?creative" });
  const device = String(req.query.device || DEFAULT_DEVICE);
  const manualConsent = req.query.consent === "manual";
  const wantShot = req.query.shot === "1" || req.query.shot === "true"; // return a screenshot instead of JSON
  let safeUrl;
  try { safeUrl = await assertSafeUrl(rawUrl); } catch (e) { return res.status(400).json({ error: e.message }); }

  const dev = DEVICES[device] || DEVICES[DEFAULT_DEVICE];
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: dev.w, height: dev.h }, deviceScaleFactor: 1,
    isMobile: dev.mobile, hasTouch: dev.mobile, userAgent: dev.ua,
    locale: LOCALE, timezoneId: TIMEZONE, ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  const consoleMsgs = [], adnamiReqs = [];
  page.on("console", (m) => { if (consoleMsgs.length < 120) consoleMsgs.push(m.type() + ": " + m.text()); });
  page.on("pageerror", (e) => { if (consoleMsgs.length < 120) consoleMsgs.push("pageerror: " + String(e.message || e)); });
  page.on("requestfailed", (r) => { const u = r.url(); if (/adnami|adsm/i.test(u) && adnamiReqs.length < 80) adnamiReqs.push({ url: u.slice(0, 160), failed: (r.failure() && r.failure().errorText) || "failed" }); });
  page.on("response", (r) => { const u = r.url(); if (/adnami|adsm/i.test(u) && adnamiReqs.length < 80) adnamiReqs.push({ url: u.slice(0, 160), status: r.status() }); });

  const out = { creative, url: safeUrl, device, version: ENGINE_VERSION };
  try {
    try { await page.goto(safeUrl, { waitUntil: "domcontentloaded", timeout: 22000 }); }
    catch (e) { out.gotoNote = String(e.message || e); } // continue even if slow — we still inject + observe
    // Use the SAME injection path as /render so the diagnostic matches production exactly.
    let spec = { width: 300, height: 240, type: "" };
    try { spec = parseAdnamiSpec(await fetchAdnamiInsTags(creative)); } catch (e) { out.injectError = String(e.message || e); }
    out.spec = spec;
    if (!manualConsent) { if (spec.isSkin) await giveConsent(page).catch(() => {}); else await dismissConsent(page).catch(() => {}); }
    try {
      const r = await injectAdnami(page, creative, "", spec);
      out.hasSlot = r.hasSlot; out.method = r.method; out.mounted = r.mounted;
      if (r.fetchNote) out.fetchNote = r.fetchNote;
    } catch (e) { out.injectError = (out.injectError || "") + " inject:" + String(e.message || e); }
    out.slotCount = await page.evaluate(() => document.querySelectorAll('iframe[id^="adsm-iframe"]').length).catch(() => 0);
    await page.waitForTimeout(4000); // let the format settle before reading the DOM
    out.dom = await page.evaluate(() => {
      let adsm = null;
      try { adsm = (window.top && window.top.adsm) || window.adsm || null; } catch (e) { adsm = window.adsm || null; }
      const fidEl = document.querySelector("[data-adnm-fid]");
      return {
        stickyWrapper: !!document.querySelector(".adsm-sticky-wrapper"),
        contentBackground: !!document.querySelector(".adsm-contentBackground"),
        wallpaper: !!document.querySelector(".adsm-wallpaper, [class*='adsm-wallpaper']"),
        fid: fidEl ? (fidEl.getAttribute("data-adnm-fid") || "") : "",
        adsmPresent: !!adsm,
        adsmHasCertifications: !!(adsm && adsm.certifications),
        adsmIframe: !!document.querySelector('iframe[id^="adsm-iframe"]'),
        anyAdnmIframe: !!document.querySelector('iframe[id*="adnm"], iframe[id*="adsm"]'),
        adnamiScripts: Array.from(document.querySelectorAll('script[src*="adnami"]')).map((s) => s.src.slice(0, 160)),
        bodyChildren: Array.from(document.body.children).slice(0, 30).map((c) => {
          const r = c.getBoundingClientRect(); const cs = getComputedStyle(c);
          return { tag: c.tagName, id: (c.id || "").slice(0, 30), cls: (typeof c.className === "string" ? c.className : "").slice(0, 45), pos: cs.position, z: cs.zIndex, bg: cs.backgroundColor, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left) };
        }),
      };
    });
    // Optional: return a SCREENSHOT of exactly this diagnostic state, so we can SEE
    // whether the "mounted" skin (DOM flags above) is actually visible with its wings.
    if (wantShot) {
      try {
        let pageH = dev.h;
        try { pageH = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, window.innerHeight)); } catch {}
        const capH = Math.max(dev.h, Math.min(pageH, adaptiveMaxHeight(dev)));
        await page.setViewportSize({ width: dev.w, height: capH });
        await page.waitForTimeout(600);
        const buf = await page.screenshot({ type: "jpeg", quality: 82 });
        res.set("Content-Type", "image/jpeg");
        res.set("X-Adnami-Skin", String(!!(out.dom && out.dom.wallpaper)));
        return res.end(buf);
      } catch (e) { out.shotError = String(e.message || e); }
    }
    out.consoleMsgs = consoleMsgs;
    out.adnamiReqs = adnamiReqs;
    return res.json(out);
  } catch (e) {
    out.error = String(e.message || e);
    out.consoleMsgs = consoleMsgs;
    out.adnamiReqs = adnamiReqs;
    return res.status(502).json(out);
  } finally {
    await context.close().catch(() => {});
  }
});

app.get("/render", async (req, res) => {
  if (RENDER_TOKEN && req.query.token !== RENDER_TOKEN) {
    return res.status(401).json({ error: "Ugyldig eller manglende token" });
  }
  const rawUrl = String(req.query.url || "").trim();
  if (!rawUrl) return res.status(400).json({ error: "Mangler ?url" });

  const device   = String(req.query.device || DEFAULT_DEVICE);
  const landscape = req.query.landscape === "1" || req.query.landscape === "true";
  const fullPage  = req.query.fullPage === undefined ? true : (req.query.fullPage === "1" || req.query.fullPage === "true");
  const format    = req.query.format === "png" ? "png" : "jpeg";
  const fresh     = req.query.fresh === "1" || req.query.fresh === "true";
  const manualConsent = req.query.consent === "manual";
  const placement = String(req.query.adplacement || "").trim();

  let creative;
  try { creative = normalizeCreative(req.query.creative); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  let safeUrl;
  try { safeUrl = await assertSafeUrl(rawUrl); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  registerFirstParty(safeUrl);

  const key = [normalizeCacheUrl(safeUrl), device, landscape, fullPage, format, manualConsent, creative, placement].join("|");
  if (!fresh) {
    const hit = cacheGet(key);
    if (hit) {
      res.set("Content-Type", `image/${hit.type}`);
      res.set("X-Cache", "HIT");
      res.set("Cache-Control", "public, max-age=120");
      return res.end(hit.buf);
    }
  }

  await acquire();
  try {
    const { buf, type, adnamiError } = await renderShot({ url: safeUrl, device, landscape, fullPage, format, manualConsent, creative, placement });
    // Only cache clean results — don't cache a page where the creative failed to mount.
    if (!adnamiError) cacheSet(key, buf, type);
    res.set("Content-Type", `image/${type}`);
    res.set("X-Cache", "MISS");
    if (creative) res.set("X-Adnami", adnamiError ? ("error: " + adnamiError) : "ok");
    res.set("Cache-Control", "public, max-age=120");
    return res.end(buf);
  } catch (e) {
    return res.status(502).json({ error: "Rendering fejlede", detail: String(e.message || e) });
  } finally {
    release();
  }
});

app.get("/", (_req, res) =>
  res.type("text/plain").send(
    "Concept X Render Engine kører.\n" +
    "Brug: /render?url=https://eksempel.dk&device=ip17&landscape=0&fullPage=1&format=jpeg\n" +
    "Enheder: " + Object.keys(DEVICES).join(", ")
  )
);

/* ------------------------------------------------------------------ *
 * LIVE / INTERACTIVE sessions (WebSocket)                             *
 * A real browser runs on the server; we stream its viewport as JPEG   *
 * frames and forward the client's mouse/scroll/keyboard in real time. *
 * ------------------------------------------------------------------ */
let liveCount = 0;

function setupLive(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: "/live" });

  wss.on("connection", async (ws, req) => {
    const params = new URL(req.url, "http://x").searchParams;
    if (RENDER_TOKEN && params.get("token") !== RENDER_TOKEN) {
      try { ws.send(JSON.stringify({ t: "error", msg: "Ugyldig token" })); } catch {}
      return ws.close();
    }
    if (liveCount >= MAX_LIVE) {
      try { ws.send(JSON.stringify({ t: "busy", msg: "Serveren har for mange samtidige live-sessioner lige nu. Prøv igen om lidt." })); } catch {}
      return ws.close();
    }

    liveCount++;
    METRICS.live.active++; METRICS.live.total++;
    let context = null, page = null, cdp = null, closed = false, started = false;
    let idleTimer = null;
    let manualConsent = false;
    let motionTimer = null;            // adaptive stream: revert-to-sharp timer
    let pingTimer = null;              // RTT probe (client echoes {t:"ping"} → {t:"pong"})
    let stateTimer = null;             // periodic cookies+consent snapshot → survives device/setting switch
    let enterMotion = () => {};        // set up once the screencast is running
    let liveCreative = "", livePlacement = ""; // Adnami creative kept for re-injection after nav/reload
    let liveUrl = ""; // last good URL, so "reload" recovers even from a chrome-error tab
    let q = Promise.resolve(); // serialises input events so they apply in order

    const send = (obj) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {} };
    // Inject (or re-inject) the session's Adnami creative into the current page.
    const doInject = async () => {
      if (!liveCreative || !page) return;
      send({ t: "notice", msg: "Indsætter Adnami-format…" });
      try {
        const r = await injectAdnami(page, liveCreative, livePlacement);
        let m;
        if (r && r.ours) m = "Dit format er vist ✓";
        else if (r && r.needsPlacement) {
          const mk = r.marks || {};
          m = "Ingen auto-match. format=\"" + (r.formatName || "?") + "\" nøgleord=\"" + (r.kw || "") + "\"" +
              " | fids:[" + ((mk.fids || []).join(", ") || "ingen") + "]" +
              " | adsm-iframes:[" + ((mk.adsmIframes || []).join(", ") || "ingen") + "]" +
              " | klasser:[" + ((mk.adnmClasses || []).join(", ") || "ingen") + "]" +
              " | els:[" + ((mk.adnmEls || []).join(", ") || "ingen") + "]" +
              ". Brug Vælg placering.";
        }
        else if (r && r.mounted) m = "Adnami-format indsat ✓";
        else m = "Adnami-tag indsat, men formatet mountede ikke (tjek ID/format-type).";
        send({ t: "notice", msg: m });
      }
      catch (e) { send({ t: "notice", msg: "Adnami: " + String(e.message || e) }); }
    };
    const bumpIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { send({ t: "error", msg: "Sessionen blev lukket pga. inaktivitet." }); cleanup(); }, LIVE_IDLE_MS);
    };
    // Persist this host's cookies+consent so a fresh context (device/setting switch) reuses it
    // instead of re-prompting the cookie box. Reset via /clear-session ("Ryd session").
    const saveSession = async () => {
      try { if (context && liveUrl) SESSION_CACHE.set(hostKey(liveUrl), await context.storageState()); } catch {}
    };
    const cleanup = async () => {
      if (closed) return; closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (motionTimer) clearTimeout(motionTimer);
      if (pingTimer) clearInterval(pingTimer);
      if (stateTimer) clearInterval(stateTimer);
      liveCount = Math.max(0, liveCount - 1);
      METRICS.live.active = Math.max(0, METRICS.live.active - 1);
      try { if (cdp) await cdp.detach(); } catch {}
      await saveSession();
      try { if (context) await context.close(); } catch {}
      try { ws.close(); } catch {}
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);

    ws.on("message", async (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      bumpIdle();
      // RTT probe: client echoes our {t:"ping",ts} back as {t:"pong",ts}. If the frontend
      // doesn't echo, frameLatencyMs on /health simply stays null (harmless).
      if (msg.t === "pong") { if (typeof msg.ts === "number") METRICS._rtt = Math.max(0, Date.now() - msg.ts); return; }
      try {
        if (msg.t === "start") {
          if (started) return; started = true;
          const dev = DEVICES[msg.device] || DEVICES[DEFAULT_DEVICE];
          let vw = dev.w, vh = dev.h;
          if (dev.mobile && msg.landscape) { vw = dev.h; vh = dev.w; }

          manualConsent = msg.consent === "manual";
          // Per-session quality/sharpness (client can trade smoothness ↔ sharpness).
          let liveDsf   = Math.max(1, Math.min(2, Number(msg.dsf) || LIVE_DSF));
          const liveQ   = Math.max(LIVE_QUALITY_MIN, Math.min(90, Number(msg.quality) || LIVE_QUALITY));
          // Big desktop viewports (e.g. 2560×1440) are heavy to encode+stream. Drop the
          // extra supersampling there so playback stays smooth (layout is unaffected).
          if (vw * vh > 1600 * 1000) liveDsf = 1;

          let url;
          try { url = await assertSafeUrl(msg.url); }
          catch (e) { send({ t: "error", msg: e.message }); return; }
          liveUrl = url; registerFirstParty(url);

          send({ t: "status", msg: "Åbner side…" });
          // Reuse a cached logged-in session for this host (if we have one) so refresh / device
          // switch keeps you signed in without re-entering anything.
          const cachedState = SESSION_CACHE.get(hostKey(url));
          context = await (await getBrowser()).newContext({
            viewport: { width: vw, height: vh },
            deviceScaleFactor: liveDsf,
            isMobile: dev.mobile, hasTouch: dev.mobile, userAgent: dev.ua,
            locale: LOCALE, timezoneId: TIMEZONE, ignoreHTTPSErrors: true,
            ...(cachedState ? { storageState: cachedState } : {}),
          });
          if (BLOCK_MEDIA) {
            await context.route("**/*", (r) =>
              r.request().resourceType() === "media" ? r.abort() : r.continue()).catch(() => {});
          }
          page = await context.newPage();

          // Fold "open in new tab" popups back into the main tab.
          context.on("page", async (pg) => {
            if (pg === page) return;
            try {
              await pg.waitForLoadState("domcontentloaded", { timeout: 6000 });
              const nu = pg.url();
              await pg.close();
              if (nu && nu !== "about:blank") { await page.goto(nu, { waitUntil: "domcontentloaded" }); if (!manualConsent) await dismissConsent(page); }
            } catch { try { await pg.close(); } catch {} }
          });
          page.on("framenavigated", (fr) => { if (fr === page.mainFrame()) { send({ t: "url", url: page.url() }); saveSession(); } });

          cdp = await context.newCDPSession(page);
          cdp.on("Page.screencastFrame", async (f) => {
            // Drop this frame if the socket is already backed up — always show the
            // freshest frame instead of building a growing delay on slow links.
            const bytes = f && f.data ? Math.floor(f.data.length * 0.75) : 0; // base64 → ~bytes
            const buffered = (ws.readyState === 1) ? ws.bufferedAmount : 0;
            let sent = false, sendMs = 0;
            try {
              if (ws.readyState === 1 && ws.bufferedAmount < 800000) {
                const t0 = performance.now();
                ws.send(Buffer.from(f.data, "base64"));
                sendMs = performance.now() - t0;
                sent = true;
              }
            } catch {}
            recordFrame({ bytes, sent, buffered, sendMs });
            try { await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }); } catch {}
          });
          // Cap the STREAMED frame size (page still renders at full viewport for correct
          // layout; only the transmitted image is downscaled). This is the big smoothness
          // lever on large desktop viewports — fewer pixels to encode+send per frame.
          const streamMaxW = Math.min(vw, LIVE_MAX_W);
          const streamMaxH = Math.min(vh, LIVE_MAX_H);
          const bigViewport = vw * vh > 1600 * 1000;
          // SINGLE, CONSISTENT profile — always sharp. (The earlier "adaptive" motion profile
          // dropped to low-res while scrolling → grainy, and could get stuck there; removed.)
          const streamEveryNth = bigViewport ? Math.max(1, LIVE_EVERYNTH_BIG) : 1;
          await cdp.send("Page.startScreencast", { format: "jpeg", quality: liveQ, everyNthFrame: streamEveryNth, maxWidth: streamMaxW, maxHeight: streamMaxH });
          send({ t: "ready", w: vw, h: vh, url });
          // Periodic RTT probe (client should echo {t:"ping"} back as {t:"pong"} with the same ts).
          pingTimer = setInterval(() => { try { if (ws.readyState === 1) ws.send(JSON.stringify({ t: "ping", ts: Date.now() })); } catch (e) {} }, 3000);
          if (pingTimer.unref) pingTimer.unref();
          // Snapshot cookies+consent every few seconds while surfing, so a device/setting switch
          // (which opens a brand-new context) reuses the consent instead of re-prompting.
          stateTimer = setInterval(saveSession, 4000);
          if (stateTimer.unref) stateTimer.unref();

          // Remember the creative for this session (validated) so we can re-inject after navigations.
          if (msg.creative) {
            try { liveCreative = normalizeCreative(msg.creative); livePlacement = String(msg.placement || "").trim(); }
            catch (e) { liveCreative = ""; send({ t: "notice", msg: e.message }); }
          }

          // Robust navigation (retries + verifies it didn't land on chrome-error).
          const navOk = await robustGoto(page, url, send);
          if (!navOk) send({ t: "notice", msg: "Kunne ikke hente siden gennem proxy'en efter flere forsøg. Tryk genindlæs, eller prøv igen om lidt." });
          // Auto sign-in for configured login sites (no-op for everything else).
          await ensureLoggedIn(page, url, context, send).catch(() => {});
          if (!manualConsent) { if (liveCreative) await giveConsent(page); else await dismissConsent(page); }
          await doInject();
        }
        else if (!page) { return; }
        else {
          // Any active input → briefly enter the lighter MOTION stream (adaptive quality).
          if (msg.t === "mouse" || msg.t === "wheel" || msg.t === "key") enterMotion();
          // Serialise all input so events (down→up, move→click) never reorder.
          q = q.then(async () => {
            if (msg.t === "mouse") {
              const x = +msg.x, y = +msg.y, button = msg.button || "left";
              if (msg.kind === "move") await page.mouse.move(x, y).catch(() => {});
              else if (msg.kind === "down") { await page.mouse.move(x, y).catch(() => {}); await page.mouse.down({ button }).catch(() => {}); }
              else if (msg.kind === "up") await page.mouse.up({ button }).catch(() => {});
              else if (msg.kind === "click") await page.mouse.click(x, y, { button }).catch(() => {});
            }
            else if (msg.t === "wheel") {
              await page.mouse.move(+msg.x, +msg.y).catch(() => {});
              await page.mouse.wheel(+msg.dx || 0, +msg.dy || 0).catch(() => {});
            }
            else if (msg.t === "key") {
              if (typeof msg.text === "string" && msg.text.length) await page.keyboard.type(msg.text).catch(() => {});
              else if (msg.key) await page.keyboard.press(msg.key).catch(() => {});
            }
            else if (msg.t === "nav") {
              if (msg.action === "back") await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
              else if (msg.action === "forward") await page.goForward({ waitUntil: "domcontentloaded" }).catch(() => {});
              else if (msg.action === "reload") {
                let target = page.url(); if (!target || target.startsWith("chrome-error") || target === "about:blank") target = liveUrl;
                if (target) { await robustGoto(page, target, send); await ensureLoggedIn(page, target, context, send).catch(() => {}); if (!manualConsent) { if (liveCreative) await giveConsent(page); else await dismissConsent(page); } await doInject(); }
              }
              else if (msg.action === "goto" && msg.url) {
                try { const su = await assertSafeUrl(msg.url); liveUrl = su; registerFirstParty(su); await robustGoto(page, su, send); await ensureLoggedIn(page, su, context, send).catch(() => {}); if (!manualConsent) await dismissConsent(page); await doInject(); }
                catch (e) { send({ t: "error", msg: e.message }); }
              }
            }
            else if (msg.t === "pick") {
              if (!liveCreative) { send({ t: "notice", msg: "Indsæt et creative-ID og tryk Vis format først." }); return; }
              send({ t: "notice", msg: "Placerer annoncen her…" });
              try {
                const r = await placeAdnamiAt(page, liveCreative, +msg.x, +msg.y);
                let m;
                if (r && r.ours) m = "Dit format er placeret ✓";
                else if (r && r.present) m = "Dit tag blev sat ind, men creativet renderede ikke (isSkin=" + (r && r.isSkin) + ") — proxy/auktion henter måske ikke dit creative.";
                else m = "Formatet mountede ikke (host=" + (r && r.usedHost || "?") + ", selector=" + (r && r.selector || "?") + ", isSkin=" + (r && r.isSkin) + ").";
                send({ t: "notice", msg: m });
              } catch (e) { send({ t: "notice", msg: "Placering fejlede: " + String(e.message || e) }); }
            }
          }).catch(() => {});
        }
      } catch (e) { send({ t: "error", msg: String(e.message || e) }); }
    });

    bumpIdle();
    send({ t: "hello", max: MAX_LIVE });
  });
}

const server = app.listen(PORT, () => console.log(`Render engine lytter på :${PORT}`));
setupLive(server);

// Pre-login configured sites at boot, so the FIRST user visit is instant: the (slow, through-
// the-proxy) sign-in happens here in the background and is cached, instead of costing you time
// when you enter the URL. Re-runs after every deploy/restart. Fire-and-forget; never blocks.
async function warmLogins() {
  for (const cfg of SITE_LOGINS) {
    if (!cfg || !cfg.domain) continue;
    const warmUrl = cfg.warmUrl || cfg.loginUrl || ("https://" + cfg.domain + "/");
    if (SESSION_CACHE.has(hostKey(warmUrl))) continue;   // already warm
    let ctx = null;
    try {
      ctx = await (await getBrowser()).newContext({ locale: LOCALE, timezoneId: TIMEZONE, ignoreHTTPSErrors: true });
      const pg = await ctx.newPage();
      await robustGoto(pg, warmUrl);
      const ok = await ensureLoggedIn(pg, warmUrl, ctx);   // caches the signed-in session on success
      console.log(`Warm-login ${cfg.domain}: ${ok ? "logget ind ✓ (cachet)" : "intet login udført (sæt evt. warmUrl til en beskyttet side)"}`);
    } catch (e) { console.log("Warm-login fejlede for", cfg.domain, "-", (e && e.message) || e); }
    finally { try { if (ctx) await ctx.close(); } catch {} }
  }
}
setTimeout(() => { warmLogins().catch(() => {}); }, 1500);

// Graceful shutdown
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    server.close();
    try { const b = await browserPromise; if (b) await b.close(); } catch {}
    try { if (relayServer) await relayServer.close(true); else if (relayUrl) await ProxyChain.closeAnonymizedProxy(relayUrl, true); } catch {}
    process.exit(0);
  });
}
