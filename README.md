# Concept X — Render + Live Engine (Playwright)  ·  v2.3 (Adnami)

En lille server, der åbner en rigtig Chrome-browser i den valgte enheds­størrelse (dansk sprog/tidszone), håndterer cookie-bokse, og giver to ting:

1. **Snapshot** (`/render`) — et server-renderet billede af siden med annoncer.
2. **Interaktiv / live** (`/live`, WebSocket) — en levende browser-session, der streames til frontenden, så man kan klikke, scrolle og se annonce-animationer i realtid.

**Nyt i v2.3:** man kan indsætte et **Adnami creative-ID** og få det pågældende high-impact-format renderet oven på den valgte side — både i snapshot og i den interaktive session.

Frontenden er `conceptx-device-preview-v2.html` (evt. omdøbt til `index.html`).

```
GET /render?url=https://eksempel.dk&device=ip17&landscape=0&fullPage=1&format=jpeg&consent=auto&creative=<GUID>&adplacement=<CSS>&token=HEMMELIG
GET /health                     (viser bl.a. "version")
WS  /live?token=HEMMELIG        (interaktiv session; creative sendes i "start"-beskeden)
```

### Adnami creative-injection (v2.3)

Når `creative=<GUID>` er sat, gør motoren følgende, efter siden er loadet:

1. Henter Adnamis offentlige ins-tag: `https://app.adnami.io/api/public/creatives/<GUID>/ins-tags`.
2. Indsætter `<ins>`-tagget på siden — øverst i `<body>` som standard, eller i det element `adplacement` (en CSS-selector) peger på.
3. Loader Adnamis render-motor `https://macro.adnami.io/macro/gen/adnm.ads.v2.js`.
4. Venter på, at formatet mounter (`<iframe id="adsm-iframe-…">`), og screenshotter/streamer.

Dette bruger udelukkende Adnamis **offentlige** endpoints (samme som Adnamis egen browser-udvidelse kalder) — der er ikke kopieret kode fra udvidelsen. Et `GUID` er på formen `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`. Fejler injektionen (ukendt ID, netværk), returneres siden stadig, og `/render` sætter headeren `X-Adnami: error: …`.

> **Brug:** teknikken er fri, men vis kun creatives, du (eller din kunde) har rettighed til — eller efter aftale med Adnami. Afhænger af, at Adnami holder endpointsne offentlige.

---

## 1) Kør lokalt (test på din egen maskine)

Kræver Node 18+.

```bash
cd conceptx-render-engine
npm install
npx playwright install chromium   # henter browseren (kun lokalt; Docker-billedet har den med)
npm start
```

Åbn så: `http://localhost:8080/render?url=https://dr.dk&device=ip17`

---

## 2) Deploy med Docker (den nemme, holdbare vej)

Alt er sat op til Docker. Vælg én udbyder — **Render** er nemmest at starte med.

### A) Render.com  (anbefalet, ~$7/md)
1. Læg denne mappe i et Git-repo (GitHub/GitLab).
2. På render.com: **New + → Blueprint** og peg på repoet (det bruger `render.yaml`).
   - Eller **New + → Web Service → Docker** og peg på mappen manuelt.
3. Vælg region **Frankfurt** (EU → europæisk annonce-målretning).
4. Render sætter automatisk en `RENDER_TOKEN`. Kopiér den — den skal ind i frontenden.
5. Efter deploy får du en adresse som `https://conceptx-render-engine.onrender.com`.

### B) Railway.app
1. **New Project → Deploy from Repo** (Railway opdager Dockerfile selv).
2. Under **Variables**: sæt `RENDER_TOKEN`, `LOCALE=da-DK`, `TIMEZONE=Europe/Copenhagen`.
3. Under **Settings → Networking**: **Generate Domain**.

### C) Fly.io
```bash
fly launch --no-deploy        # vælg region ams (Amsterdam) eller arn (Stockholm) for Norden
fly secrets set RENDER_TOKEN=din-hemmelige-vaerdi LOCALE=da-DK TIMEZONE=Europe/Copenhagen
fly deploy
```

---

## 3) Kobl frontenden på

Åbn `conceptx-device-preview.html`, find `CONFIG` øverst i `<script>`, og udfyld:

```js
const CONFIG = {
  engineUrl:   "https://conceptx-render-engine.onrender.com", // din server-adresse
  engineToken: "DEN_RENDER_TOKEN_DU_FIK"                       // samme som RENDER_TOKEN
};
```

Læg herefter HTML-filen på **Netlify** (drag-and-drop af filen, eller connect repo). Frontend på Netlify + motor på Render — det er hele arkitekturen.

Når `engineUrl` er sat, henter **Snapshot**-knappen billedet fra din egen motor (med annoncer). Er den tom, falder Snapshot tilbage til en gratis, annoncefri forhåndsvisning (WordPress mShots).

---

## Miljøvariabler

| Variabel | Standard | Beskrivelse |
|---|---|---|
| `PORT` | `8080` | Port serveren lytter på |
| `RENDER_TOKEN` | (tom) | Er den sat, skal kald indeholde `?token=…`. **Sæt den** ved offentlig hosting |
| `LOCALE` | `da-DK` | Browser-sprog / Accept-Language |
| `TIMEZONE` | `Europe/Copenhagen` | Tidszone |
| `MAX_CONCURRENCY` | `2` | Hvor mange sider renderes samtidig (hæv med mere RAM) |
| `CACHE_TTL_MS` | `300000` | Cache-levetid pr. billede (5 min) |
| `NAV_TIMEOUT_MS` | `45000` | Timeout for sideindlæsning |
| `ALLOW_ORIGIN` | `*` | CORS. Sæt evt. til din Netlify-adresse |
| `MAX_LIVE_SESSIONS` | `2` | Antal samtidige interaktive (live) sessioner. Hæv med mere CPU/RAM |
| `LIVE_DSF` | `1` | Opløsning på live-streamen (1 = mest flydende, 2 = skarpere/tungere) |
| `LIVE_QUALITY` | `40` | JPEG-kvalitet på live-frames (fx `65` = mindre grynet) |
| `MAX_SHOT_HEIGHT` | `6000` | Maks. højde (px) på snapshot |
| `BLOCK_MEDIA` | `true` | Dropper video/lyd for at spare hukommelse |

Tip: skru på **skarphed/flydning** i live-visningen uden kodeændring ved at sætte `LIVE_QUALITY` (og evt. `LIVE_DSF`) som miljøvariabler i Render.

---

## Vigtigt om cookies / samtykke
For at annoncer overhovedet loader, skal cookie-/samtykke-boksen på den previewede side **accepteres**. Motoren forsøger automatisk at trykke "Accepter alle" — også når boksen ligger i en iframe (OneTrust, Didomi, Sourcepoint, Cookiebot, Usercentrics, Google Funding Choices m.fl.). Kan en bestemt sides samtykke ikke genkendes/accepteres automatisk, vil dens annoncer typisk ikke blive vist. Nye CMP'er kan tilføjes i `CONSENT_TEXT` / `CONSENT_SELECTORS` i `server.js`.

## Vigtigt om annoncer og geo-målretning

- **Annoncerne kommer fra det land, serveren står i.** Vil du se *danske* annoncer, skal motoren hostes i EU (Frankfurt/Amsterdam/Stockholm) — det er derfor regionen er valgt sådan ovenfor. Skal det være en dansk IP helt præcist, kan vi lægge en dansk proxy ind (kan tilføjes senere).
- Nogle annoncer vises **ikke** for automatiserede browsere (svindel-filtre), og personaliserede annoncer kræver cookies/samtykke, som en frisk browser ikke har. Du vil se de fleste kontekstuelle/programmatiske annoncer, men ikke nødvendigvis 100 %.
- Motoren venter og scroller for at få flest mulige annoncer med. Timing kan altid finjusteres.

## Sikkerhed
Serveren afviser interne/private adresser (localhost, 10.x, 192.168.x, cloud-metadata osv.), så den ikke kan misbruges til at kigge ind i private netværk. Brug altid `RENDER_TOKEN` ved offentlig hosting.

## Ressourceforbrug
En browser fylder RAM. Starter-plan (512 MB) klarer mobil + de fleste desktop-sider med `MAX_CONCURRENCY=2`. Renderer du mange store desktop-sider samtidig, så vælg en plan med 1–2 GB RAM.
