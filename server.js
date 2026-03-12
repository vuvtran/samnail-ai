const express = require("express");
const cors = require("cors");

const app = express();

// Crash logging
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

// Basic request logging
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

app.use(express.json());

// Safer CORS
const allowedOrigins = new Set([
  "https://samnailsupply.com",
  "https://www.samnailsupply.com",
  "http://localhost:3000",
  "null"
]);

app.use(cors({
  origin(origin, callback) {
    // Allow requests with no origin (server-to-server, curl, some local file tests)
    if (!origin || allowedOrigins.has(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

// Health routes
app.get("/", (req, res) => {
  res.status(200).send("SamNail AI server is running");
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "SamNail AI server running" });
});

// Shopify search
async function searchShopifyProducts(query) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!store || !token) {
    console.warn("Shopify credentials missing. Returning empty product list.");
    return [];
  }

  // Pull a small batch and filter locally for now
  const url = `https://${store}/admin/api/2024-01/products.json?limit=20`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const products = Array.isArray(data.products) ? data.products : [];

  const q = String(query || "").toLowerCase().trim();
  if (!q) return [];

  return products.filter((p) => {
    const haystack = [
      p.title,
      p.vendor,
      p.product_type,
      p.body_html,
      ...(Array.isArray(p.tags) ? p.tags : String(p.tags || "").split(","))
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(q);
  });
}

function formatProducts(products) {
  if (!products.length) {
    return "I could not find matching products right now.";
  }

  return products.slice(0, 5).map((p, index) => {
    const firstVariant = Array.isArray(p.variants) && p.variants[0] ? p.variants[0] : null;
    const price = firstVariant?.price ? `$${firstVariant.price}` : "Price unavailable";
    return `${index + 1}. ${p.title} - ${price}`;
  }).join("\n");
}

// Chat route
app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body || {};

    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: "Message is required" });
    }

    const products = await searchShopifyProducts(message);

    if (!products.length) {
      return res.status(200).json({
        reply: `SamNail AI received: ${message}`,
        products: []
      });
    }

    return res.status(200).json({
      reply: formatProducts(products),
      products: products.slice(0, 5).map((p) => ({
        id: p.id,
        title: p.title,
        handle: p.handle,
        vendor: p.vendor,
        product_type: p.product_type,
        image: p.image?.src || null,
        price: Array.isArray(p.variants) && p.variants[0] ? p.variants[0].price : null,
        url: p.handle ? `https://samnailsupply.com/products/${p.handle}` : null
      }))
    });
  } catch (error) {
    console.error("Chat error:", error);
    return res.status(500).json({
      error: "Server error",
      detail: error.message
    });
  }
});

app.post("/ai-support", async (req, res) => {
  try {
    const { message } = req.body || {};
    return res.status(200).json({
      reply: `SamNail AI received: ${message || ""}`
    });
  } catch (error) {
    console.error("AI support error:", error);
    return res.status(500).json({ error: "Server error" });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

const PORT = Number(process.env.PORT) || 3000;

console.log("Starting SamNail AI...");
console.log("PORT =", PORT);
console.log("SHOPIFY_STORE set =", Boolean(process.env.SHOPIFY_STORE));
console.log("SHOPIFY_ACCESS_TOKEN set =", Boolean(process.env.SHOPIFY_ACCESS_TOKEN));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SamNail AI running on port ${PORT}`);
});