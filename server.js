const express = require("express");
const cors = require("cors");

const app = express();

app.use(express.json());

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

async function searchShopifyProducts(searchText) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!store || !token) {
    throw new Error("Missing SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN");
  }

  // Simple Shopify Admin GraphQL search string
  const cleaned = String(searchText || "").trim();
  const queryString = cleaned
    ? `title:*${cleaned}* OR tag:*${cleaned}* OR product_type:*${cleaned}*`
    : "";

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
            featuredImage {
              url
            }
            variants(first: 1) {
              edges {
                node {
                  price
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

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify GraphQL error ${response.status}: ${text}`);
  }

  const result = await response.json();

  if (result.errors) {
    throw new Error(JSON.stringify(result.errors));
  }

  return result.data.products.edges.map(edge => {
    const p = edge.node;
    const firstVariant = p.variants?.edges?.[0]?.node || null;

    return {
      id: p.id,
      title: p.title,
      handle: p.handle,
      vendor: p.vendor,
      product_type: p.productType,
      image: p.featuredImage?.url || null,
      price: firstVariant?.price || null,
      url: `https://samnailsupply.com/products/${p.handle}`
    };
  });
}

function formatReply(products, originalMessage) {
  if (!products.length) {
    return `I could not find matching products for "${originalMessage}".`;
  }

  return products
    .map((p, i) => `${i + 1}. ${p.title}${p.price ? ` - $${p.price}` : ""}`)
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