const express = require("express");
const cors = require("cors");

const app = express();

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

app.use(express.json());

app.use(cors({
  origin: [
    "https://samnailsupply.com",
    "https://www.samnailsupply.com",
    "http://localhost:3000"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.options(/.*/, cors());

app.get("/", (req, res) => {
  res.send("SamNail AI server is running");
});

app.get("/health", (req, res) => {
  res.json({ status: "SamNail AI server running" });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body || {};
    res.json({ reply: `SamNail AI received: ${message || ""}` });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/ai-support", async (req, res) => {
  try {
    const { message } = req.body || {};
    res.json({ reply: `SamNail AI received: ${message || ""}` });
  } catch (error) {
    console.error("AI support error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

const PORT = Number(process.env.PORT) || 3000;

console.log("Starting SamNail AI...");
console.log("PORT =", PORT);
console.log("NODE_ENV =", process.env.NODE_ENV);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SamNail AI running on port ${PORT}`);
});