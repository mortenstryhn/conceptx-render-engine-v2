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
const MAX_SHOT_HEIGHT = parseInt(process.env.MAX_SHOT_HEIGHT || "6000", 10); // CSS px
const MAX_DSF         = parseFloat(process.env.MAX_DSF || "2");              // cap pixel ratio for screenshots
const RENDER_TIMEOUT_MS = parseInt(process.env.RENDER_TIMEOUT_MS || "75000", 10);
const BLOCK_MEDIA     = (process.env.BLOCK_MEDIA || "true") === "true";      // drop video/audio streams (heavy, not needed for a screenshot)
const MAX_LIVE        = parseInt(process.env.MAX_LIVE_SESSIONS || "2", 10);  // concurrent live/interactive sessions (each holds a browser tab open)
const LIVE_IDLE_MS    = parseInt(process.env.LIVE_IDLE_MS || "180000", 10);  // auto-close a live session after this much inactivity
const LIVE_DSF        = parseFloat(process.env.LIVE_DSF || "1");             // pixel ratio for LIVE streaming (1 = smoothest; 2 = sharper but heavier)
const LIVE_QUALITY    = parseInt(process.env.LIVE_QUALITY || "40", 10);      // JPEG quality of streamed frames (lower = smoother)
const ENGINE_VERSION  = "2.22-skin-toplevel";                                    // bump when deploying; visible at /health

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
let relayUrl = null; // local auth-less proxy URL once the relay is up
const proxyInfo = () => PROXY
  ? { enabled: true, server: PROXY.server, auth: !!PROXY.username, relay: !!relayUrl }
  : { enabled: false };
if (PROXY) console.log(`Proxy aktiv → ${PROXY.server}${PROXY.username ? " (login via lokal relay)" : ""}`);

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
        relayUrl = await ProxyChain.anonymizeProxy({ url: upstream, port: 0 });
        launchProxy = { server: relayUrl }; // auth-less local URL → no per-request 407s
        console.log("Proxy-relay klar (login håndteres lokalt) → " + relayUrl);
      } catch (e) {
        // Fall back to letting Chromium handle the upstream login directly.
        launchProxy = PROXY;
        console.log("Proxy-relay kunne ikke starte, bruger direkte proxy-login: " + (e && e.message || e));
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
        // Share one process across cross-origin iframes (ad slots) → big memory saving on ad-heavy pages.
        "--disable-features=IsolateOrigins,site-per-process",
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
  if (active < MAX_CONCURRENCY) { active++; return Promise.resolve(); }
  return new Promise((res) => queue.push(res));
}
function release() {
  active--;
  const next = queue.shift();
  if (next) { active++; next(); }
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
  "Accepter alle", "Accepter alle cookies", "Tillad alle", "Accepter alle og luk",
  "Accepter", "Godkend alle", "Jeg accepterer", "Enig", "Accepter og luk",
  "Accept all", "Accept All", "Allow all", "I accept", "Agree", "Accept & close",
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
  // Slow, dwelling scroll so the ad auction runs and lazy Adnami slots fill.
  await page.evaluate(async () => {
    await new Promise((res) => {
      let y = 0, ticks = 0; const step = 500;
      const t = setInterval(() => {
        window.scrollBy(0, step); y += step; ticks++;
        if (document.querySelector('iframe[id^="adsm-iframe"]') && ticks > 6) { clearInterval(t); res(); return; }
        if (y >= document.body.scrollHeight - window.innerHeight || ticks > 60) { clearInterval(t); res(); }
      }, 300);
      setTimeout(() => { clearInterval(t); res(); }, 16000);
    });
    window.scrollTo(0, 0);
  }).catch(() => {});
  return await page.waitForFunction(
    () => !!document.querySelector('iframe[id^="adsm-iframe"]'),
    { timeout: 12000 }
  ).then(() => true).catch(() => false);
}

// Preview a creative on the page — the EXTENSION's method: let the site load its own
// Adnami ad slots, then anchor the preview in a REAL slot by cloning its iframe and
// pointing it at a data: document that carries the preview ins-tag. Running inside a
// real, fully-initialised Adnami placement is what lets high-impact formats (incl.
// skins) perform their full page takeover. Falls back to a synthetic tag if the page
// has no live Adnami slot.
async function injectAdnami(page, creativeCode, placement) {
  let spec = { width: 300, height: 240, type: "" };
  let fetchNote = "";
  try { spec = parseAdnamiSpec(await fetchAdnamiInsTags(creativeCode)); }
  catch (e) { fetchNote = String(e.message || e); }

  // Skins take over the TOP document (wings painted in the page's left/right margins);
  // a sandboxed real-slot iframe can't reach out and do that. So for skins we skip the
  // site's own slots and inject the preview ins at top level — proven to load the wing
  // assets (overlay_left/right.png) and mount adsm-sticky-wrapper. Non-skins keep the
  // real-slot-first behaviour (best for midscroll etc.).
  const forceTopLevel = !!spec.isSkin;
  const hasSlot = forceTopLevel ? false : await loadPageAds(page); // let the site's own real Adnami slots load
  const dataUrl = adnamiPreviewSrc(creativeCode, spec.type, spec.width, spec.height, Date.now());
  let result = null, method = "";

  if (hasSlot) {
    // PRIMARY — replace a REAL Adnami slot's iframe with the preview (extension inject()).
    result = await page.evaluate(({ dataUrl, placement }) => {
      document.querySelectorAll("[data-cx-injected]").forEach((n) => n.remove());
      let target = null;
      if (placement) {
        try {
          const host = document.querySelector(placement);
          if (host) target = (host.tagName === "IFRAME" && /^adsm-iframe/.test(host.id)) ? host : host.querySelector('iframe[id^="adsm-iframe"]');
        } catch (e) {}
      }
      if (!target) target = document.querySelector('iframe[id^="adsm-iframe"]');
      if (!target) return { ok: false, reason: "no-slot" };
      const clone = target.cloneNode();
      clone.setAttribute("src", dataUrl);
      clone.setAttribute("adnm-preview-adunit", "true");
      clone.setAttribute("data-cx-injected", "");
      target.replaceWith(clone);
      return { ok: true };
    }, { dataUrl, placement: placement || "" });
    method = "real-slot";
  }

  if (!hasSlot || !result || !result.ok) {
    // FALLBACK — no live slot: load the domain macro + a synthetic preview ins-tag.
    await loadAdnamiContext(page);
    await page.waitForTimeout(300);
    result = await page.evaluate(({ creativeCode, spec, engineSrc, placement }) => {
      document.querySelectorAll("[data-cx-injected]").forEach((n) => n.remove());
      const ins = document.createElement("ins");
      ins.className = "adnm-tag";
      ins.style.cssText = `display:inline-block;width:${spec.width}px;height:${spec.height}px`;
      ins.setAttribute("data-adnm-cc", creativeCode);
      if (spec.type) ins.setAttribute("data-adnm-type", spec.type);
      ins.setAttribute("data-adnm-click", "");
      ins.setAttribute("data-adnm-session", String(Date.now()));
      ins.setAttribute("data-adnm-unload", "");
      ins.setAttribute("data-adnm-custom-adnm_preview", "link");
      ins.setAttribute("data-cx-injected", "");
      let host = null, prepend = false;
      if (placement) { try { host = document.querySelector(placement); } catch (e) { host = null; } }
      if (!host) { host = document.body; prepend = true; }
      if (prepend && host.firstChild) host.insertBefore(ins, host.firstChild); else host.appendChild(ins);
      const s = document.createElement("script"); s.async = true; s.type = "text/javascript"; s.src = engineSrc;
      ins.appendChild(s);
      return { ok: true };
    }, { creativeCode, spec, engineSrc: ADNAMI_ENGINE_SRC, placement: placement || "" });
    method = "fallback-ins";
  }

  if (!result || !result.ok) throw new Error("Kunne ikke forankre Adnami-preview på siden" + (fetchNote ? (" (" + fetchNote + ")") : ""));

  // Let the format take over — do NOT touch the DOM.
  await page.waitForTimeout(8000);
  const mounted = await page.evaluate(
    () => !!document.querySelector('.adsm-sticky-wrapper, [class*="adsm-wallpaper"], [data-adnm-fid]')
  ).catch(() => false);
  return { ok: true, mounted, method, hasSlot, fetchNote, isSkin: spec.isSkin };
}

// Re-place the creative at a clicked point (device CSS px). To guarantee the ad
// never shows in two places, we capture a selector for the clicked slot, RELOAD the
// page (wiping the previous render completely), then inject ONCE — replacing that slot.
async function placeAdnamiAt(page, creativeCode, x, y) {
  // 1) Capture a stable selector for the clicked slot before touching anything.
  const selector = await page.evaluate(({ x, y }) => {
    function cssPath(el) {
      const parts = [];
      while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement && parts.length < 7) {
        if (el.id) { parts.unshift("#" + CSS.escape(el.id)); return parts.join(" > "); }
        let sel = el.tagName.toLowerCase();
        const parent = el.parentElement;
        if (parent) {
          const sibs = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
          if (sibs.length > 1) sel += ":nth-of-type(" + (sibs.indexOf(el) + 1) + ")";
        }
        parts.unshift(sel);
        el = el.parentElement;
      }
      return parts.join(" > ");
    }
    let node = document.elementFromPoint(x, y);
    if (!node || node === document.documentElement) node = document.body;
    let slot = node, guard = 0;
    while (slot.parentElement && slot.parentElement !== document.body &&
           slot.parentElement !== document.documentElement && guard++ < 8) {
      const ps = slot.parentElement.getBoundingClientRect();
      const ss = slot.getBoundingClientRect();
      if (ps.height > ss.height * 1.6 + 60) break; // parent is a big container → stop
      slot = slot.parentElement;
    }
    return slot === document.body ? "" : cssPath(slot);
  }, { x: Math.round(x), y: Math.round(y) });

  // 2) Clean slate: reload so the previous preview leaves nothing behind.
  await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});
  await dismissConsent(page).catch(() => {});
  await page.waitForTimeout(800);

  // 3) Fetch spec, then let the site's own Adnami slots load (skipped for skins,
  //    which always inject at top level so their wings can paint the page margins).
  let spec = { width: 300, height: 240, type: "" };
  try { spec = parseAdnamiSpec(await fetchAdnamiInsTags(creativeCode)); } catch (e) { /* defaults */ }
  const forceTopLevel = !!spec.isSkin;
  const hasSlot = forceTopLevel ? false : await loadPageAds(page);
  const dataUrl = adnamiPreviewSrc(creativeCode, spec.type, spec.width, spec.height, Date.now());

  // 4) Replace the REAL Adnami slot nearest the clicked spot (extension method).
  let result = null;
  if (hasSlot) {
    result = await page.evaluate(({ dataUrl, selector }) => {
      document.querySelectorAll("[data-cx-injected]").forEach((n) => n.remove());
      const slots = Array.from(document.querySelectorAll('iframe[id^="adsm-iframe"]'));
      if (!slots.length) return { ok: false, reason: "no-slot" };
      let target = slots[0];
      if (selector) {
        try {
          const host = document.querySelector(selector);
          if (host) {
            const hc = host.getBoundingClientRect(); const hy = (hc.top + hc.bottom) / 2;
            let best = null, bestD = Infinity;
            for (const s of slots) { const r = s.getBoundingClientRect(); const d = Math.abs((r.top + r.bottom) / 2 - hy); if (d < bestD) { bestD = d; best = s; } }
            if (best) target = best;
          }
        } catch (e) {}
      }
      const clone = target.cloneNode();
      clone.setAttribute("src", dataUrl);
      clone.setAttribute("adnm-preview-adunit", "true");
      clone.setAttribute("data-cx-injected", "");
      target.replaceWith(clone);
      return { ok: true };
    }, { dataUrl, selector });
  }
  if (!hasSlot || !result || !result.ok) {
    await loadAdnamiContext(page);
    await page.waitForTimeout(300);
    result = await page.evaluate(({ creativeCode, spec, engineSrc, selector }) => {
      document.querySelectorAll("[data-cx-injected]").forEach((n) => n.remove());
      let slot = null;
      if (selector) { try { slot = document.querySelector(selector); } catch (e) { slot = null; } }
      const ins = document.createElement("ins");
      ins.className = "adnm-tag";
      ins.style.cssText = `display:inline-block;width:${spec.width}px;height:${spec.height}px`;
      ins.setAttribute("data-adnm-cc", creativeCode);
      if (spec.type) ins.setAttribute("data-adnm-type", spec.type);
      ins.setAttribute("data-adnm-click", ""); ins.setAttribute("data-adnm-session", String(Date.now()));
      ins.setAttribute("data-adnm-unload", ""); ins.setAttribute("data-adnm-custom-adnm_preview", "link");
      ins.setAttribute("data-cx-injected", "");
      if (!slot || slot === document.body || !slot.parentNode) document.body.insertBefore(ins, document.body.firstChild);
      else if (slot.tagName === "IFRAME" || slot.tagName === "IMG" || slot.tagName === "VIDEO") slot.replaceWith(ins);
      else slot.replaceChildren(ins);
      const s = document.createElement("script"); s.async = true; s.type = "text/javascript"; s.src = engineSrc;
      ins.appendChild(s);
      return { ok: true };
    }, { creativeCode, spec, engineSrc: ADNAMI_ENGINE_SRC, selector });
  }

  // 5) Let it load / take over, then scroll it into view.
  await page.waitForTimeout(8000);
  const mounted = await page.evaluate(
    () => !!document.querySelector('.adsm-sticky-wrapper, [class*="adsm-wallpaper"], [data-adnm-fid]')
  ).catch(() => false);
  await page.evaluate(() => {
    const i = document.querySelector("[data-cx-injected]");
    if (i && i.scrollIntoView) i.scrollIntoView({ block: "center" });
  }).catch(() => {});
  return { ok: true, mounted, hasSlot, selector };
}

/* ------------------------------------------------------------------ *
 * Render one screenshot                                               *
 * ------------------------------------------------------------------ */
async function renderShot({ url, device, landscape, fullPage, format, manualConsent, creative, placement }) {
  const dev = DEVICES[device] || DEVICES[DEFAULT_DEVICE];
  let vw = dev.w, vh = dev.h;
  if (dev.mobile && landscape) { vw = dev.h; vh = dev.w; }

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

  // Abort heavy media (video/audio) to save memory — ads' banner/image creatives still load.
  if (BLOCK_MEDIA) {
    await context.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "media") return route.abort();
      return route.continue();
    }).catch(() => {});
  }

  const page = await context.newPage();
  const type = format === "png" ? "png" : "jpeg";
  const quality = type === "jpeg" ? 82 : undefined;
  let adnamiError = null; // non-fatal: page is still returned even if injection fails

  const work = (async () => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    // For creative previews we need REAL ads → give proper TCF consent; else just dismiss.
    if (!manualConsent) { if (creative) await giveConsent(page); else await dismissConsent(page); }
    // give ad tags a moment, then scroll to trigger lazy slots, then settle
    await page.waitForTimeout(1200);
    // Inject the chosen Adnami creative before scrolling so lazy formats mount.
    if (creative) {
      try {
        const r = await injectAdnami(page, creative, placement);
        if (r && r.mounted === false) {
          adnamiError = "creative mountede ikke (ukendt ID, forkert format-type, eller Adnami afviste preview)"
            + (r.fetchNote ? " · " + r.fetchNote : "");
        }
      } catch (e) { adnamiError = String(e.message || e); }
    }
    await autoScroll(page);
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // Grow the viewport to the (capped) page height so ALL content — including
    // below-the-fold ads — is laid out and captured. NOTE: a clip that extends
    // past the viewport does NOT capture below-fold content in Chromium, which
    // is why we resize instead. Height is capped so very long pages stay memory-safe.
    let pageH = vh;
    try {
      pageH = await page.evaluate(() =>
        Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, window.innerHeight));
    } catch { /* keep default */ }
    const capH = Math.max(vh, Math.min(pageH, MAX_SHOT_HEIGHT));

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

app.get("/health", (_req, res) => res.json({ ok: true, version: ENGINE_VERSION, proxy: proxyInfo(), devices: Object.keys(DEVICES) }));

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
    if (!manualConsent) await dismissConsent(page).catch(() => {});
    // Fast inline injection (no long mount-wait) so this endpoint returns quickly.
    let spec = { width: 300, height: 240, type: "" };
    try { spec = parseAdnamiSpec(await fetchAdnamiInsTags(creative)); } catch (e) { out.injectError = String(e.message || e); }
    out.spec = spec;
    // Let the site's own Adnami slots load, then anchor the preview in a real slot.
    out.hasSlot = await loadPageAds(page);
    out.slotCount = await page.evaluate(() => document.querySelectorAll('iframe[id^="adsm-iframe"]').length).catch(() => 0);
    const dataUrl = adnamiPreviewSrc(creative, spec.type, spec.width, spec.height, Date.now());
    if (out.hasSlot) {
      out.method = "real-slot";
      await page.evaluate(({ dataUrl }) => {
        document.querySelectorAll("[data-cx-injected]").forEach((n) => n.remove());
        const target = document.querySelector('iframe[id^="adsm-iframe"]');
        if (!target) return;
        const clone = target.cloneNode();
        clone.setAttribute("src", dataUrl);
        clone.setAttribute("adnm-preview-adunit", "true");
        clone.setAttribute("data-cx-injected", "");
        target.replaceWith(clone);
      }, { dataUrl }).catch((e) => { out.injectError = (out.injectError || "") + " eval:" + String(e.message || e); });
    } else {
      out.method = "fallback-ins";
      out.ctxReady = await loadAdnamiContext(page);
      await page.evaluate(({ creativeCode, spec, engineSrc }) => {
        const ins = document.createElement("ins");
        ins.className = "adnm-tag";
        ins.style.cssText = `display:inline-block;width:${spec.width}px;height:${spec.height}px`;
        ins.setAttribute("data-adnm-cc", creativeCode);
        if (spec.type) ins.setAttribute("data-adnm-type", spec.type);
        ins.setAttribute("data-adnm-custom-adnm_preview", "link");
        ins.setAttribute("data-cx-injected", "");
        document.body.insertBefore(ins, document.body.firstChild);
        const s = document.createElement("script"); s.async = true; s.type = "text/javascript"; s.src = engineSrc;
        ins.appendChild(s);
      }, { creativeCode: creative, spec, engineSrc: ADNAMI_ENGINE_SRC }).catch(() => {});
    }
    await page.waitForTimeout(8000); // let the format take over — do NOT touch the DOM
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

  const key = [safeUrl, device, landscape, fullPage, format, manualConsent, creative, placement].join("|");
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
    let context = null, page = null, cdp = null, closed = false, started = false;
    let idleTimer = null;
    let manualConsent = false;
    let liveCreative = "", livePlacement = ""; // Adnami creative kept for re-injection after nav/reload
    let q = Promise.resolve(); // serialises input events so they apply in order

    const send = (obj) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {} };
    // Inject (or re-inject) the session's Adnami creative into the current page.
    const doInject = async () => {
      if (!liveCreative || !page) return;
      send({ t: "notice", msg: "Indsætter Adnami-format…" });
      try {
        const r = await injectAdnami(page, liveCreative, livePlacement);
        send({ t: "notice", msg: (r && r.mounted)
          ? "Adnami-format indsat ✓"
          : "Adnami-tag indsat, men formatet mountede ikke (tjek ID/format-type)." });
      }
      catch (e) { send({ t: "notice", msg: "Adnami: " + String(e.message || e) }); }
    };
    const bumpIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { send({ t: "error", msg: "Sessionen blev lukket pga. inaktivitet." }); cleanup(); }, LIVE_IDLE_MS);
    };
    const cleanup = async () => {
      if (closed) return; closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      liveCount = Math.max(0, liveCount - 1);
      try { if (cdp) await cdp.detach(); } catch {}
      try { if (context) await context.close(); } catch {}
      try { ws.close(); } catch {}
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);

    ws.on("message", async (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      bumpIdle();
      try {
        if (msg.t === "start") {
          if (started) return; started = true;
          const dev = DEVICES[msg.device] || DEVICES[DEFAULT_DEVICE];
          let vw = dev.w, vh = dev.h;
          if (dev.mobile && msg.landscape) { vw = dev.h; vh = dev.w; }

          manualConsent = msg.consent === "manual";
          // Per-session quality/sharpness (client can trade smoothness ↔ sharpness).
          const liveDsf = Math.max(1, Math.min(2, Number(msg.dsf) || LIVE_DSF));
          const liveQ   = Math.max(20, Math.min(90, Number(msg.quality) || LIVE_QUALITY));

          let url;
          try { url = await assertSafeUrl(msg.url); }
          catch (e) { send({ t: "error", msg: e.message }); return; }

          send({ t: "status", msg: "Åbner side…" });
          context = await (await getBrowser()).newContext({
            viewport: { width: vw, height: vh },
            deviceScaleFactor: liveDsf,
            isMobile: dev.mobile, hasTouch: dev.mobile, userAgent: dev.ua,
            locale: LOCALE, timezoneId: TIMEZONE, ignoreHTTPSErrors: true,
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
          page.on("framenavigated", (fr) => { if (fr === page.mainFrame()) send({ t: "url", url: page.url() }); });

          cdp = await context.newCDPSession(page);
          cdp.on("Page.screencastFrame", async (f) => {
            // Drop this frame if the socket is already backed up — always show the
            // freshest frame instead of building a growing delay on slow links.
            try { if (ws.readyState === 1 && ws.bufferedAmount < 800000) ws.send(Buffer.from(f.data, "base64")); } catch {}
            try { await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }); } catch {}
          });
          // NOTE: screencast frames are always the device CSS width; dsf>1 renders the
          // page at higher density and downscales (supersampling) → crisper text/edges.
          await cdp.send("Page.startScreencast", { format: "jpeg", quality: liveQ, everyNthFrame: 1 });
          send({ t: "ready", w: vw, h: vh, url });

          // Remember the creative for this session (validated) so we can re-inject after navigations.
          if (msg.creative) {
            try { liveCreative = normalizeCreative(msg.creative); livePlacement = String(msg.placement || "").trim(); }
            catch (e) { liveCreative = ""; send({ t: "notice", msg: e.message }); }
          }

          await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});
          if (!manualConsent) { if (liveCreative) await giveConsent(page); else await dismissConsent(page); }
          await doInject();
        }
        else if (!page) { return; }
        else {
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
              else if (msg.action === "reload") { await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {}); await doInject(); }
              else if (msg.action === "goto" && msg.url) {
                try { const su = await assertSafeUrl(msg.url); await page.goto(su, { waitUntil: "domcontentloaded" }); if (!manualConsent) await dismissConsent(page); await doInject(); }
                catch (e) { send({ t: "error", msg: e.message }); }
              }
            }
            else if (msg.t === "pick") {
              if (!liveCreative) { send({ t: "notice", msg: "Indsæt et creative-ID og tryk Vis format først." }); return; }
              send({ t: "notice", msg: "Placerer annoncen her…" });
              try {
                const r = await placeAdnamiAt(page, liveCreative, +msg.x, +msg.y);
                send({ t: "notice", msg: (r && r.mounted) ? "Annonce placeret her ✓" : "Placeret, men formatet mountede ikke — prøv et andet sted på siden." });
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

// Graceful shutdown
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    server.close();
    try { const b = await browserPromise; if (b) await b.close(); } catch {}
    try { if (relayUrl) await ProxyChain.closeAnonymizedProxy(relayUrl, true); } catch {}
    process.exit(0);
  });
}
