const mongoose = require("mongoose");

const auditSchema = new mongoose.Schema({
  pdfId: { type: String, required: true },
  originalHash: { type: String, required: true },
  finalHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Audit", auditSchema);
