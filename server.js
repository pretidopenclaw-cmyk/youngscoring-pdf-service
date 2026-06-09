const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || "ys-pdf-secret-key-2026";

// Accept large HTML payloads
app.use(express.json({ limit: "5mb" }));
app.use(express.text({ limit: "5mb", type: "text/html" }));

// --- Browser singleton ----------------------------------------------------
// On garde UNE instance Chrome vivante et on la réutilise entre les requêtes.
// Lancer un browser par requête épuise les PID/threads du conteneur (EAGAIN
// sur posix_spawn). On ne ferme que les pages ; le browser reste chaud.
const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  // PAS de --single-process : provoque des SIGABRT et l'échec de spawn du
  // crashpad_handler en conteneur (cf. pptr.dev/troubleshooting).
];

let browserPromise = null;

// --- Limite de concurrence ------------------------------------------------
// Chaque render = un onglet Chrome (process renderer + RAM). Sous pic
// (plusieurs utilisateurs qui génèrent en même temps), on borne le nombre de
// rendus simultanés pour éviter l'OOM / l'épuisement de process. Les requêtes
// au-delà de la limite attendent leur tour (FIFO), elles ne sont pas rejetées.
// Ajuste MAX_CONCURRENT_RENDERS selon la RAM du conteneur Railway.
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_RENDERS || 3);
let active = 0;
const waiters = [];

function acquire() {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function release() {
  const next = waiters.shift();
  if (next) {
    next(); // le slot reste pris, transmis au suivant
  } else {
    active--;
  }
}

async function getBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (b.connected) return b;
    } catch {
      // launch précédent a échoué → on relance ci-dessous
    }
    browserPromise = null;
  }
  browserPromise = puppeteer.launch({ headless: true, args: LAUNCH_ARGS });
  return browserPromise;
}

// Rend un PDF : browser réutilisé, un onglet par appel, concurrence bornée.
async function renderPdf(html, options) {
  await acquire();
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      // waitUntil "load" et PAS "networkidle0" : avec setContent, networkidle*
      // ne se résout jamais sur Chrome récent (timeout garanti). On attend
      // ensuite explicitement les polices pour un rendu fidèle.
      await page.setContent(html, options.setContent);
      await page.evaluate(() => document.fonts.ready).catch(() => {});
      return await page.pdf(options.pdf);
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    release();
  }
}

// Health check léger — réponse instantanée. C'est CELUI-CI que doit pinger
// le healthcheck Railway (voir railway.toml : healthcheckPath = "/").
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "youngscoring-pdf-service" });
});

// Health check profond — render Puppeteer réel (~1-3 s). À pinger à la main
// ou depuis UptimeRobot toutes les 15-30 min, JAMAIS comme healthcheck Railway.
app.get("/healthz", async (req, res) => {
  const t0 = Date.now();
  try {
    const pdf = await renderPdf(
      "<!doctype html><html><body><p>healthz ping</p></body></html>",
      {
        setContent: { waitUntil: "load", timeout: 10000 },
        pdf: { format: "A4", printBackground: false },
      },
    );

    if (!pdf || pdf.length < 500) {
      return res.status(503).json({
        status: "degraded",
        reason: "pdf_too_small",
        size: pdf?.length || 0,
        latency_ms: Date.now() - t0,
      });
    }
    res.json({
      status: "ok",
      service: "youngscoring-pdf-service",
      check: "deep",
      pdf_size: pdf.length,
      latency_ms: Date.now() - t0,
    });
  } catch (err) {
    console.error("[healthz] Error:", err.message);
    res.status(503).json({
      status: "degraded",
      reason: "render_failed",
      detail: err.message,
      latency_ms: Date.now() - t0,
    });
  }
});

// Generate PDF from HTML
app.post("/generate", async (req, res) => {
  // Auth check
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { html, landscape } = req.body;
  if (!html) {
    return res.status(400).json({ error: "html is required" });
  }

  try {
    const pdf = await renderPdf(html, {
      setContent: { waitUntil: "load", timeout: 30000 },
      pdf: {
        format: "A4",
        landscape: landscape || false,
        printBackground: true,
        margin: { top: "0", right: "0", bottom: "0", left: "0" },
      },
    });

    const pdfBuffer = Buffer.from(pdf);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Length": pdfBuffer.length,
    });
    res.end(pdfBuffer);
  } catch (err) {
    console.error("[PDF] Error:", err.message);
    res.status(500).json({ error: "PDF generation failed", details: err.message });
  }
});

// Ferme proprement le browser au shutdown (SIGTERM Railway au redéploiement).
async function shutdown() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      await b.close().catch(() => {});
    } catch {
      /* noop */
    }
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

app.listen(PORT, () => {
  console.log(`🖨️  PDF service running on port ${PORT}`);
});
