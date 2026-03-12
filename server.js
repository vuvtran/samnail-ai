const express = require("express");
const cors = require("cors");

const app = express();

app.use(express.json());

// Allow local file chat.html, localhost, and Railway domain
app.use(cors({
  origin: ["null", "http://localhost:3000", "https://samnail-ai-production.up.railway.app"],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use((req, res, next) => {
  console.log("REQUEST:", req.method, req.url);
  next();
});

app.get("/", (req, res) => {
  res.status(200).send("SamNail AI server is running");
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/ping", (req, res) => {
  res.status(200).send("pong");
});

app.post("/api/chat", (req, res) => {
  try {
    const { message } = req.body || {};
    res.status(200).json({
      reply: `SamNail AI received: ${message || ""}`
    });
  } catch (error) {
    console.error("CHAT ERROR:", error);
    res.status(500).json({ error: "Server error" });
  }
});

const PORT = process.env.PORT || 3000;

console.log("Starting app...");
console.log("PORT =", PORT);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on ${PORT}`);
});