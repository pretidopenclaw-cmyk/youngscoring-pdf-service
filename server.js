const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || "ys-pdf-secret-key-2026";

// Accept large HTML payloads
app.use(express.json({ limit: "5mb" }));
app.use(express.text({ limit: "5mb", type: "text/html" }));

// Health check léger — réponse instantanée, ping monitoring
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "youngscoring-pdf-service" });
});

// Health check profond — lance un vrai render Puppeteer minimal pour vérifier
// que la chaîne complète fonctionne. Plus lent (~1-3s). À pinger toutes les
// 15-30 min depuis UptimeRobot/équivalent, pas toutes les 5 min.
app.get("/healthz", async (req, res) => {
  const t0 = Date.now();
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
    });
    const page = await browser.newPage();
    await page.setContent(
      "<!doctype html><html><body><p>healthz ping</p></body></html>",
      { waitUntil: "load", timeout: 10000 },
    );
    const pdf = await page.pdf({ format: "A4", printBackground: false });
    await browser.close();
    browser = null;

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
    if (browser) await browser.close().catch(() => {});
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

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });

    const pdf = await page.pdf({
      format: "A4",
      landscape: landscape || false,
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });

    await browser.close();
    browser = null;

    const pdfBuffer = Buffer.from(pdf);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Length": pdfBuffer.length,
    });
    res.end(pdfBuffer);
  } catch (err) {
    console.error("[PDF] Error:", err.message);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: "PDF generation failed", details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🖨️  PDF service running on port ${PORT}`);
});
