const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || "ys-pdf-secret-key-2026";

// Accept large HTML payloads
app.use(express.json({ limit: "5mb" }));
app.use(express.text({ limit: "5mb", type: "text/html" }));

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "youngscoring-pdf-service" });
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
