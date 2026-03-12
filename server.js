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
    "http://localhost:3000",
    "null"
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

async function searchShopifyProducts(query) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!store || !token) {
    throw new Error("Missing SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN");
  }

  const url = `https://${store}/admin/api/2024-01/products.json?limit=8&title=${encodeURIComponent(query)}`;

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
  return data.products || [];
}

function formatProducts(products) {
  if (!products.length) {
    return "I could not find matching products right now.";
  }

  return products.slice(0, 5).map((p, index) => {
    const firstVariant = p.variants && p.variants[0];
    const price = firstVariant ? `$${firstVariant.price}` : "Price unavailable";
    return `${index + 1}. ${p.title} - ${price}`;
  }).join("\n");
}

app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body || {};

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    const products = await searchShopifyProducts(message);

    return res.json({
      reply: formatProducts(products),
      products: products.slice(0, 5).map((p) => ({
        id: p.id,
        title: p.title,
        handle: p.handle,
        vendor: p.vendor,
        product_type: p.product_type,
        image: p.image ? p.image.src : null,
        price: p.variants && p.variants[0] ? p.variants[0].price : null,
        url: `https://samnailsupply.com/products/${p.handle}`
      }))
    });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({
      error: "Server error",
      detail: error.message
    });
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SamNail AI running on port ${PORT}`);
});