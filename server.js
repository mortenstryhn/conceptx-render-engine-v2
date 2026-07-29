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

import express from "express";
import dns from "node:dns/promises";
import net from "node:net";
import { WebSocketServer } from "ws";
import { chromium } from "playwright";
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
const ENGINE_VERSION  = "2.3-adnami";                                        // bump when deploying; visible at /health

const app = express();
app.disable("x-powered-by");

/* ------------------------------------------------------------------ *
 * Shared browser (launched once, reused across requests)             *
 * ------------------------------------------------------------------ */
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined, // optional override (local dev); unset in production
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
  "button[data-testid='uc-accept-all-button']",             // Usercentrics
  "button[mode='primary']",
];

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
async function fetchAdnamiInsTags(creativeCode) {
  const url = ADNAMI_INSTAGS_URL(creativeCode);
  const opts = { headers: { accept: "text/html,application/xhtml+xml,*/*" } };
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) opts.signal = AbortSignal.timeout(12000);
  let res;
  try { res = await fetch(url, opts); }
  catch (e) { throw new Error("Kunne ikke nå Adnami (ins-tags): " + (e.message || e)); }
  if (!res.ok) throw new Error(`Adnami svarede ${res.status} for creative ${creativeCode} (findes det ID?)`);
  const html = ((await res.text()) || "").trim();
  if (!html || !/<ins[\s>]/i.test(html)) throw new Error("Adnami returnerede ingen ins-tag for dette creative-ID");
  return html;
}

// Insert the ins-tag(s) into the page and load the render engine, then wait
// for the creative to mount. `placement` is an optional CSS selector; when it
// matches an element the creative is appended there, otherwise it is placed at
// the top of <body> (correct for top-anchored high-impact formats).
async function injectAdnami(page, creativeCode, placement) {
  const served = await fetchAdnamiInsTags(creativeCode);
  const result = await page.evaluate(({ served, fallbackEngine, placement }) => {
    const tmp = document.createElement("div");
    tmp.innerHTML = served;
    const inses = Array.from(tmp.querySelectorAll("ins"));
    if (!inses.length) return { ok: false, reason: "no-ins" };
    const scriptSrcs = Array.from(tmp.querySelectorAll("script[src]"))
      .map((s) => s.getAttribute("src")).filter(Boolean);

    // Where to place the creative.
    let host = null, prepend = false;
    if (placement) { try { host = document.querySelector(placement); } catch (e) { host = null; } }
    if (!host) { host = document.body; prepend = true; }

    for (const ins of inses) {
      if (prepend && host.firstChild) host.insertBefore(ins, host.firstChild);
      else host.appendChild(ins);
    }

    // Load whatever script(s) the tag references; make sure the gen engine is present.
    const srcs = scriptSrcs.slice();
    if (!srcs.some((s) => s && s.includes("adnm.ads.v2.js"))) srcs.push(fallbackEngine);
    for (const src of srcs) {
      const s = document.createElement("script");
      s.async = true; s.type = "text/javascript"; s.src = src;
      (document.head || document.documentElement).appendChild(s);
    }
    return { ok: true, count: inses.length };
  }, { served, fallbackEngine: ADNAMI_ENGINE_SRC, placement: placement || "" });

  if (!result || !result.ok) throw new Error("Kunne ikke indsætte Adnami-creative på siden");

  // Adnami mounts the creative inside an <iframe id="adsm-iframe-…">.
  await page.waitForFunction(
    () => !!document.querySelector('iframe[id^="adsm-iframe"], iframe[id*="adnm"], [data-adnm-rendered]'),
    { timeout: 9000 }
  ).catch(() => {});
  await page.waitForTimeout(1800); // let expansion / animation settle
  return result;
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
    if (!manualConsent) await dismissConsent(page);
    // give ad tags a moment, then scroll to trigger lazy slots, then settle
    await page.waitForTimeout(1200);
    // Inject the chosen Adnami creative before scrolling so lazy formats mount.
    if (creative) {
      try { await injectAdnami(page, creative, placement); }
      catch (e) { adnamiError = String(e.message || e); }
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

app.get("/health", (_req, res) => res.json({ ok: true, version: ENGINE_VERSION, devices: Object.keys(DEVICES) }));

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
      try { await injectAdnami(page, liveCreative, livePlacement); send({ t: "notice", msg: "Adnami-format indsat ✓" }); }
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
          if (!manualConsent) await dismissConsent(page);
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
    process.exit(0);
  });
}
