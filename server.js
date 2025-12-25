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

/* -------------------- MONGODB -------------------- */
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/pdf_audit";

mongoose
  .connect(MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  });

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use("/files", express.static(path.join(__dirname, "uploads")));

/* -------------------- DIRECTORIES -------------------- */
const ORIGINAL_DIR = path.join(__dirname, "uploads", "original");
const SIGNED_DIR = path.join(__dirname, "uploads", "signed");

[ORIGINAL_DIR, SIGNED_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

/* -------------------- HASH FUNCTION -------------------- */
function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

[ORIGINAL_DIR, SIGNED_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

/* -------------------- UPLOAD PDF -------------------- */
app.post("/upload-pdf", upload.single("pdf"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const pdfId = Date.now().toString();
    const filePath = path.join(ORIGINAL_DIR, `${pdfId}.pdf`);

    fs.writeFileSync(filePath, req.file.buffer);

    res.json({
      pdfId,
      url: `http://localhost:5000/files/original/${pdfId}.pdf`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "PDF upload failed" });
  }
});

/* -------------------- FINALIZE PDF + AUDIT -------------------- */
app.post("/finalize-pdf", async (req, res) => {
  try {
    const { pdfId, fields } = req.body;

    const originalPath = path.join(ORIGINAL_DIR, `${pdfId}.pdf`);
    if (!fs.existsSync(originalPath)) {
      return res.status(404).json({ error: "PDF not found" });
    }

    /* ---------- HASH BEFORE ---------- */
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

      if ((field.type === "text" || field.type === "date") && field.value) {
        page.drawText(field.value, {
          x,
          y: y + h * 0.35,
          size: 11,
          color: rgb(0, 0, 0),
        });
      }

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

    /* ---------- HASH AFTER ---------- */
    const finalPdf = await pdfDoc.save();
    const finalHash = sha256(finalPdf);

    const outputPath = path.join(SIGNED_DIR, `${pdfId}-final.pdf`);
    fs.writeFileSync(outputPath, finalPdf);

    /* ---------- STORE AUDIT ---------- */
    await Audit.create({
      pdfId,
      originalHash,
      finalHash,
    });

    res.json({
      url: `http://localhost:5000/files/signed/${pdfId}-final.pdf`,
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

app.listen(5000, () => {
  console.log("✅ Backend running at http://localhost:5000");
});
