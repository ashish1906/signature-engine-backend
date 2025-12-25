const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { PDFDocument, rgb } = require("pdf-lib");
const Audit = require("./models/Audit");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

/* ===================== ENV CHECK ===================== */
if (!process.env.MONGODB_URI) {
  throw new Error("❌ MONGODB_URI not set");
}

if (!process.env.BASE_URL) {
  throw new Error("❌ BASE_URL not set");
}

const BASE_URL = process.env.BASE_URL;

/* ===================== MONGODB ===================== */
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  });

/* ===================== MIDDLEWARE ===================== */
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://signature-engine-frontend-theta.vercel.app",
      "https://signature-engine-frontend-4djgs54ek.vercel.app",
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json({ limit: "25mb" }));

/* ===================== DIRECTORIES ===================== */
const UPLOAD_DIR = path.join(__dirname, "uploads");
const ORIGINAL_DIR = path.join(UPLOAD_DIR, "original");
const SIGNED_DIR = path.join(UPLOAD_DIR, "signed");

[UPLOAD_DIR, ORIGINAL_DIR, SIGNED_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

app.use("/files", express.static(UPLOAD_DIR));

/* ===================== UTILS ===================== */
function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/* ===================== ROUTES ===================== */

/* ---------- UPLOAD PDF ---------- */
app.post("/upload-pdf", upload.single("pdf"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No PDF uploaded" });
    }

    const pdfId = Date.now().toString();
    const filePath = path.join(ORIGINAL_DIR, `${pdfId}.pdf`);

    fs.writeFileSync(filePath, req.file.buffer);

    res.json({
      pdfId,
      url: `${BASE_URL}/files/original/${pdfId}.pdf`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "PDF upload failed" });
  }
});

/* ---------- FINALIZE PDF + AUDIT ---------- */
app.post("/finalize-pdf", async (req, res) => {
  try {
    const { pdfId, fields } = req.body;

    const originalPath = path.join(ORIGINAL_DIR, `${pdfId}.pdf`);
    if (!fs.existsSync(originalPath)) {
      return res.status(404).json({ error: "PDF not found" });
    }

    /* ----- HASH BEFORE ----- */
    const originalBytes = fs.readFileSync(originalPath);
    const originalHash = sha256(originalBytes);

    const pdfDoc = await PDFDocument.load(originalBytes);
    const pages = pdfDoc.getPages();

    for (const field of fields) {
      const page = pages[field.page - 1];
      if (!page) continue;

      const { width, height } = page.getSize();

      const x = field.xRatio * width;
      const y = height - field.yRatio * height - field.hRatio * height;
      const w = field.wRatio * width;
      const h = field.hRatio * height;

      /* ----- TEXT / DATE ----- */
      if ((field.type === "text" || field.type === "date") && field.value) {
        page.drawText(field.value, {
          x,
          y: y + h * 0.35,
          size: 11,
          color: rgb(0, 0, 0),
        });
      }

      /* ----- SIGNATURE ----- */
      if (field.type === "signature" && field.value) {
        const imgBytes = Buffer.from(
          field.value.replace(/^data:image\/\w+;base64,/, ""),
          "base64"
        );

        const img = field.value.includes("jpeg")
          ? await pdfDoc.embedJpg(imgBytes)
          : await pdfDoc.embedPng(imgBytes);

        const scale = Math.min(w / img.width, h / img.height);
        const drawW = img.width * scale;
        const drawH = img.height * scale;

        page.drawImage(img, {
          x: x + (w - drawW) / 2,
          y: y + (h - drawH) / 2,
          width: drawW,
          height: drawH,
        });
      }
    }

    /* ----- HASH AFTER ----- */
    const finalPdf = await pdfDoc.save();
    const finalHash = sha256(finalPdf);

    const outputPath = path.join(SIGNED_DIR, `${pdfId}-final.pdf`);
    fs.writeFileSync(outputPath, finalPdf);

    /* ----- AUDIT STORE ----- */
    await Audit.create({
      pdfId,
      originalHash,
      finalHash,
      createdAt: new Date(),
    });

    res.json({
      url: `${BASE_URL}/files/signed/${pdfId}-final.pdf`,
      audit: {
        originalHash,
        finalHash,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "PDF finalization failed" });
  }
});

/* ===================== START SERVER ===================== */
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
});
