const express = require("express");

const app = express();

app.use(express.json());

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
  const { message } = req.body || {};
  res.status(200).json({
    reply: `SamNail AI received: ${message || ""}`
  });
});

const PORT = process.env.PORT || 3000;

console.log("Starting app...");
console.log("PORT =", PORT);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on ${PORT}`);
});