const express = require("express");
const cors = require("cors");

const app = express();

app.use(express.json());

const allowedOrigins = [
  "http://localhost:3000",
  "https://samnail-ai-production.up.railway.app",
  "https://samnailsupply.com",
  "https://www.samnailsupply.com"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || origin === "null" || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Not allowed by CORS: " + origin));
  },
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

app.get("/api/chat", (req, res) => {
  res.status(200).send("API chat route is live. Use POST to send a message.");
});

function escapeShopifySearch(text) {
  return String(text || "")
    .trim()
    .replace(/["\\]/g, " ")
    .replace(/\s+/g, " ");
}

function buildShopifyQuery(cleaned) {
  return [
    `title:*${cleaned}*`,
    `tag:*${cleaned}*`,
    `product_type:*${cleaned}*`,
    `sku:*${cleaned}*`,
    `vendor:*${cleaned}*`
  ].join(" OR ");
}

function scoreVariantMatch(variant, searchText) {
  const q = String(searchText || "").toLowerCase();
  const sku = String(variant?.sku || "").toLowerCase();
  const title = String(variant?.title || "").toLowerCase();

  let score = 0;

  if (!q) return score;

  if (sku === q) score += 100;
  if (sku.includes(q)) score += 60;
  if (title.includes(q)) score += 30;

  return score;
}

async function searchShopifyProducts(searchText) {
  const store = process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!store || !token) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN (or SHOPIFY_STORE) or SHOPIFY_ACCESS_TOKEN");
  }

  const cleaned = escapeShopifySearch(searchText);

  if (!cleaned) {
    return [];
  }

  const queryString = buildShopifyQuery(cleaned);

  const graphqlQuery = `
    query SearchProducts($query: String!) {
      products(first: 5, query: $query) {
        edges {
          node {
            id
            title
            handle
            vendor
            productType
            tags
            featuredImage {
              url
            }
            variants(first: 10) {
              edges {
                node {
                  id
                  title
                  sku
                  price
                  inventoryQuantity
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch(`https://${store}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({
      query: graphqlQuery,
      variables: { query: queryString }
    })
  });

  const rawText = await response.text();

  if (!response.ok) {
    throw new Error(`Shopify GraphQL error ${response.status}: ${rawText}`);
  }

  let result;
  try {
    result = JSON.parse(rawText);
  } catch {
    throw new Error(`Invalid JSON from Shopify: ${rawText}`);
  }

  if (result.errors) {
    throw new Error(`Shopify GraphQL returned errors: ${JSON.stringify(result.errors)}`);
  }

  const edges = result?.data?.products?.edges || [];

  return edges.map((edge) => {
    const p = edge.node;
    const variants = (p?.variants?.edges || []).map((v) => v.node);

    let bestVariant = variants[0] || null;

    if (variants.length > 1) {
      bestVariant = variants
        .map((variant) => ({
          ...variant,
          _score: scoreVariantMatch(variant, cleaned)
        }))
        .sort((a, b) => b._score - a._score)[0];
    }

    return {
      id: p.id,
      title: p.title,
      handle: p.handle,
      vendor: p.vendor,
      product_type: p.productType,
      tags: p.tags || [],
      image: p.featuredImage?.url || null,
      variant_id: bestVariant?.id || null,
      variant_title: bestVariant?.title || null,
      sku: bestVariant?.sku || null,
      price: bestVariant?.price || null,
      inventory: bestVariant?.inventoryQuantity ?? null,
      url: `https://samnailsupply.com/products/${p.handle}`
    };
  });
}

function formatReply(products, originalMessage) {
  if (!products.length) {
    return `I could not find matching products for "${originalMessage}".`;
  }

  return products
    .map((p, i) => {
      const priceText = p.price ? ` - $${p.price}` : "";
      const skuText = p.sku ? ` | SKU: ${p.sku}` : "";
      const stockText = p.inventory !== null ? ` | Stock: ${p.inventory}` : "";
      return `${i + 1}. ${p.title}${priceText}${skuText}${stockText}`;
    })
    .join("\n");
}

app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body || {};

    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: "Message is required" });
    }

    const products = await searchShopifyProducts(message);

    res.status(200).json({
      reply: formatReply(products, message),
      products
    });
  } catch (error) {
    console.error("CHAT ERROR:", error);
    res.status(500).json({
      error: "Server error",
      detail: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

console.log("Starting app...");
console.log("PORT =", PORT);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on ${PORT}`);
});