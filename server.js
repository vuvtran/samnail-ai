const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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

const pool = new Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: Number(process.env.PGPORT || 5432),
  ssl:
    process.env.PGHOST && !String(process.env.PGHOST).includes("localhost")
      ? { rejectUnauthorized: false }
      : false
});

function getShopifyStore() {
  return process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_STORE;
}

function getShopifyToken() {
  return process.env.SHOPIFY_ACCESS_TOKEN;
}

async function initDb() {
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
    console.log("pgvector extension ready");
  } catch (error) {
    console.warn("Could not enable pgvector extension:", error.message);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      title TEXT,
      handle TEXT,
      vendor TEXT,
      product_type TEXT,
      tags TEXT,
      image TEXT,
      embedding_text TEXT,
      embedding VECTOR(1536),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS variants (
      id TEXT PRIMARY KEY,
      product_id TEXT,
      title TEXT,
      sku TEXT,
      price NUMERIC,
      inventory INTEGER,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_products_title ON products USING btree (title);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_products_vendor ON products USING btree (vendor);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_variants_sku ON variants USING btree (sku);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_variants_product_id ON variants USING btree (product_id);
  `);

  console.log("Database initialized");
}

app.get("/", (req, res) => {
  res.status(200).send("SamNail AI server is running");
});

app.get("/ping", (req, res) => {
  res.status(200).send("pong");
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({
      status: "ok",
      db: "connected",
      openai: process.env.OPENAI_API_KEY ? "configured" : "missing"
    });
  } catch (error) {
    res.status(200).json({
      status: "ok",
      db: "disconnected",
      detail: error.message || "Database not connected",
      openai: process.env.OPENAI_API_KEY ? "configured" : "missing"
    });
  }
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

function looksLikeOrderQuery(message) {
  const text = String(message || "").toLowerCase().trim();

  if (!text) return false;
  if (/\border\b/.test(text)) return true;
  if (/\bstatus\b/.test(text) && /#?\d{4,}/.test(text)) return true;
  if (/#\d{4,}/.test(text)) return true;
  if (/\b\d{4,}\b/.test(text) && /\b(check|find|lookup|track|status|where)\b/.test(text)) {
    return true;
  }

  return false;
}

function extractOrderNumber(message) {
  const text = String(message || "");

  const hashMatch = text.match(/#(\d{4,})/);
  if (hashMatch) return hashMatch[1];

  const orderMatch = text.match(/\border\s*#?\s*(\d{4,})/i);
  if (orderMatch) return orderMatch[1];

  const anyNumberMatch = text.match(/\b(\d{4,})\b/);
  if (anyNumberMatch) return anyNumberMatch[1];

  return null;
}

function extractEmail(message) {
  const text = String(message || "");
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : null;
}

function looksLikeOnlyEmail(message) {
  const email = extractEmail(message);
  if (!email) return false;

  const cleaned = String(message || "").replace(email, "").trim();
  return cleaned.length === 0;
}

function formatMoney(price) {
  if (price === null || price === undefined || price === "") return "";
  const num = Number(price);
  if (Number.isNaN(num)) return `$${price}`;
  return `$${num.toFixed(2)}`;
}

function isLowStock(inventory) {
  return inventory !== null && inventory !== undefined && Number(inventory) > 0 && Number(inventory) <= 5;
}

function detectBudget(message) {
  const text = String(message || "").toLowerCase();

  let match = text.match(/under\s*\$?\s*(\d+(?:\.\d+)?)/i);
  if (match) return { type: "max", value: Number(match[1]) };

  match = text.match(/less than\s*\$?\s*(\d+(?:\.\d+)?)/i);
  if (match) return { type: "max", value: Number(match[1]) };

  match = text.match(/below\s*\$?\s*(\d+(?:\.\d+)?)/i);
  if (match) return { type: "max", value: Number(match[1]) };

  match = text.match(/between\s*\$?\s*(\d+(?:\.\d+)?)\s*(?:and|-)\s*\$?\s*(\d+(?:\.\d+)?)/i);
  if (match) {
    return {
      type: "range",
      min: Number(match[1]),
      max: Number(match[2])
    };
  }

  return null;
}

function applyBudgetFilter(products, message) {
  const budget = detectBudget(message);
  if (!budget || !products?.length) return products;

  return products.filter((p) => {
    const price = Number(p.price);
    if (Number.isNaN(price)) return false;

    if (budget.type === "max") return price <= budget.value;
    if (budget.type === "range") return price >= budget.min && price <= budget.max;

    return true;
  });
}

function detectBrand(message) {
  const text = String(message || "").toLowerCase();
  const brands = [
    "opi",
    "kiara sky",
    "dnd",
    "gelish",
    "cnd",
    "essie",
    "chaun legend",
    "chaun",
    "cre8tion",
    "lechat",
    "apres",
    "kupa",
    "sns",
    "notpolish"
  ];

  return brands.find((b) => text.includes(b)) || null;
}

function detectProductType(message) {
  const text = String(message || "").toLowerCase();

  if (text.includes("dip powder")) return "dip";
  if (text.includes("dipping powder")) return "dip";
  if (text.includes("dip")) return "dip";
  if (text.includes("gel polish")) return "gel";
  if (text.includes("gel color")) return "gel";
  if (text.includes("builder gel")) return "gel";
  if (text.includes("gel")) return "gel";
  if (text.includes("acrylic")) return "acrylic";
  if (text.includes("polish")) return "polish";
  if (text.includes("top coat")) return "top coat";
  if (text.includes("base coat")) return "base coat";
  if (text.includes("primer")) return "primer";
  if (text.includes("monomer")) return "monomer";
  if (text.includes("brush")) return "brush";

  return null;
}

function detectColorFamily(message) {
  const text = String(message || "").toLowerCase();
  const colors = [
    "nude", "pink", "red", "white", "black", "blue", "purple",
    "orange", "brown", "beige", "glitter", "pastel", "neon",
    "coral", "peach", "lavender", "clear", "green", "yellow",
    "silver", "gold", "gray", "grey"
  ];

  return colors.find((c) => text.includes(c)) || null;
}

function detectProfessionalIntent(message) {
  const text = String(message || "").toLowerCase();
  const proWords = [
    "salon",
    "technician",
    "tech",
    "professional",
    "wholesale",
    "bulk",
    "case",
    "dozen",
    "supply"
  ];

  return proWords.some((w) => text.includes(w));
}

function extractSearchKeywords(message) {
  const text = String(message || "").toLowerCase();

  const stopWords = [
    "find", "show", "need", "want", "looking", "for",
    "i", "me", "my", "the", "a", "an", "please",
    "under", "below", "cheap", "best", "good", "option",
    "can", "you", "help", "with", "use"
  ];

  return text
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.includes(w))
    .slice(0, 6);
}

function expandKeywords(words) {
  const expanded = [...words];

  words.forEach((w) => {
    if (w === "dip") expanded.push("dipping");
    if (w === "dipping") expanded.push("dip");

    if (w === "gel") {
      expanded.push("gel polish");
      expanded.push("gel color");
    }

    if (w === "polish") expanded.push("nail lacquer");

    if (w === "nude") {
      expanded.push("natural");
      expanded.push("beige");
    }

    if (w === "pink") expanded.push("rose");
  });

  return [...new Set(expanded)];
}

function scoreProductMatch(product, message) {
  const text = String(message || "").toLowerCase();
  let score = 0;

  const title = String(product.title || "").toLowerCase();
  const vendor = String(product.vendor || "").toLowerCase();
  const type = String(product.product_type || "").toLowerCase();
  const sku = String(product.sku || "").toLowerCase();
  const variantTitle = String(product.variant_title || "").toLowerCase();

  const brand = detectBrand(message);
  const productType = detectProductType(message);
  const color = detectColorFamily(message);

  if (sku && text.includes(sku)) score += 120;

  if (brand && vendor.includes(brand)) score += 40;
  if (brand && title.includes(brand)) score += 25;

  if (productType && (title.includes(productType) || type.includes(productType) || variantTitle.includes(productType))) {
    score += 30;
  }

  if (color && (title.includes(color) || variantTitle.includes(color))) {
    score += 25;
  }

  if (title.includes(text)) score += 20;

  if (product.inventory !== null && product.inventory !== undefined) {
    if (Number(product.inventory) > 0) score += 10;
    if (Number(product.inventory) <= 5 && Number(product.inventory) > 0) score += 4;
  }

  return score;
}

function rankProducts(products, message) {
  return [...products].sort((a, b) => scoreProductMatch(b, message) - scoreProductMatch(a, message));
}

function getBundleSuggestions(message, bestProduct) {
  const text = String(message || "").toLowerCase();
  const title = String(bestProduct?.title || "").toLowerCase();
  const type = String(bestProduct?.product_type || "").toLowerCase();

  if (text.includes("dip") || title.includes("dip") || type.includes("dip")) {
    return ["base coat", "activator", "top coat"];
  }

  if (text.includes("acrylic") || title.includes("acrylic") || type.includes("acrylic")) {
    return ["monomer", "primer", "acrylic brush"];
  }

  if (text.includes("gel") || title.includes("gel") || type.includes("gel")) {
    return ["base coat", "top coat", "UV/LED lamp"];
  }

  if (text.includes("polish") || title.includes("polish") || type.includes("polish")) {
    return ["base coat", "top coat", "cuticle oil"];
  }

  return [];
}

function buildPopularityHint(product, message) {
  const title = String(product?.title || "").toLowerCase();
  const brand = detectBrand(message);

  if (brand && title.includes(brand)) {
    return " This is a strong match for the brand you asked for.";
  }

  if (product?.inventory !== null && product?.inventory !== undefined && Number(product.inventory) > 20) {
    return " This one is well stocked and a solid choice if you want something ready to ship.";
  }

  return "";
}

function buildSalesClosing(message, products) {
  const best = products?.[0];
  if (!best) return "";

  const bundle = getBundleSuggestions(message, best);
  const isPro = detectProfessionalIntent(message);
  const popularityHint = buildPopularityHint(best, message);

  let closing = popularityHint;

  if (bundle.length && isPro) {
    closing += ` If you're buying for salon use, I can also show the matching ${bundle.join(", ")} to complete the set.`;
    return closing;
  }

  if (bundle.length) {
    closing += ` I can also show matching ${bundle.join(" and ")} if you want the full set.`;
    return closing;
  }

  closing += " If you want, I can also show similar options, best sellers, or the best value choice.";
  return closing;
}

function buildBetterFollowUp(message, products) {
  const type = detectProductType(message);
  const color = detectColorFamily(message);
  const brand = detectBrand(message);
  const isPro = detectProfessionalIntent(message);

  if (!type) {
    return "Do you want gel, dip, acrylic, or regular polish?";
  }

  if (!color && ["gel", "dip", "polish"].includes(type)) {
    return "Do you want a nude, pink, red, glitter, pastel, or another color family?";
  }

  if (products.length > 1 && isPro) {
    return "Would you like the best value option, the best salon-use option, or the top 3 to compare?";
  }

  if (products.length > 1) {
    return "Would you like the closest match, the best value option, or the top 3 to compare?";
  }

  if (brand) {
    return `Would you like me to show more ${brand.toUpperCase()} options like this one?`;
  }

  return "Would you like similar options or matching add-ons too?";
}

function buildBeautySalesReplyV2(products, originalMessage) {
  if (!products || !products.length) {
    return "I couldn’t find an exact match yet. Send me the brand, product type, color, SKU, or budget you want, and I’ll narrow it down for you.";
  }

  const best = products[0];
  const alternatives = products.slice(1, 3);
  const bestPrice = best.price ? formatMoney(best.price) : "";
  const lowStock = isLowStock(best.inventory);

  let reply = `I found ${products.length === 1 ? "a great option" : "some strong options"} for you. `;
  reply += `My best match is ${best.title}`;

  if (bestPrice) {
    reply += ` at ${bestPrice}`;
  }

  if (best.inventory !== null && best.inventory !== undefined) {
    if (Number(best.inventory) > 0) {
      reply += lowStock ? ", and it’s low in stock right now" : ", and it’s in stock now";
    } else {
      reply += ", but it looks out of stock";
    }
  }

  reply += ".";

  if (alternatives.length) {
    reply += ` I also found ${alternatives.length === 1 ? "1 close alternative" : `${alternatives.length} similar options`} if you’d like to compare.`;
  }

  reply += buildSalesClosing(originalMessage, products);
  reply += ` ${buildBetterFollowUp(originalMessage, products)}`;

  return reply;
}

function buildSmartOrderLookupPrompt() {
  return "I can help check that for you. Please send both your order number and the email used on the order. Example: order 12345 john@email.com";
}

function buildSmartOrderReply(order, originalMessage) {
  if (!order) {
    return `I couldn’t verify an order for "${originalMessage}". Please double-check the order number and the email used at checkout, and send both together.`;
  }

  let reply = `I found your order ${order.order_number}.`;

  if (order.financial_status) {
    reply += ` Payment status: ${String(order.financial_status).toLowerCase()}.`;
  }

  if (order.fulfillment_status) {
    reply += ` Fulfillment status: ${String(order.fulfillment_status).toLowerCase()}.`;
  }

  if (order.tracking_number) {
    reply += ` Your tracking number is ${order.tracking_number}.`;
  }

  if (order.tracking_url) {
    reply += ` I also included a tracking link below.`;
  }

  reply += " Let me know if you want help with shipping, delivery timing, or finding another product while you wait.";
  return reply;
}

function buildEmbeddingText(product, variant = null) {
  const parts = [
    product.title || "",
    product.vendor || "",
    product.productType || "",
    Array.isArray(product.tags) ? product.tags.join(", ") : "",
    variant?.title || "",
    variant?.sku || ""
  ];

  return parts.filter(Boolean).join(" | ");
}

async function createEmbedding(text) {
  const input = String(text || "").trim();
  if (!input) return null;
  if (!process.env.OPENAI_API_KEY) return null;

  const result = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input
  });

  return result.data[0].embedding;
}

async function shopifyGraphQL(query, variables = {}) {
  const store = getShopifyStore();
  const token = getShopifyToken();

  if (!store || !token) {
    throw new Error("Missing SHOPIFY_STORE (or SHOPIFY_STORE_DOMAIN) or SHOPIFY_ACCESS_TOKEN");
  }

  const response = await fetch(`https://${store}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query, variables })
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

  return result;
}

async function searchShopifyProducts(searchText) {
  const cleaned = escapeShopifySearch(searchText);
  if (!cleaned) return [];

  const queryString = buildShopifyQuery(cleaned);

  const graphqlQuery = `
    query SearchProducts($query: String!) {
      products(first: 12, query: $query) {
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

  const result = await shopifyGraphQL(graphqlQuery, { query: queryString });
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
      type: "product",
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

async function searchShopifyOrderByNumberAndEmail(orderNumber, email) {
  if (!orderNumber || !email) return null;

  const graphqlQuery = `
    query SearchOrders($query: String!) {
      orders(first: 10, query: $query, sortKey: PROCESSED_AT, reverse: true) {
        edges {
          node {
            id
            name
            displayFinancialStatus
            displayFulfillmentStatus
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            createdAt
            customer {
              firstName
              lastName
              email
              phone
            }
            fulfillments(first: 5) {
              trackingInfo {
                company
                number
                url
              }
            }
            lineItems(first: 5) {
              edges {
                node {
                  title
                  quantity
                }
              }
            }
          }
        }
      }
    }
  `;

  const queriesToTry = [
    `name:#${orderNumber}`,
    `name:${orderNumber}`,
    `#${orderNumber}`,
    `${orderNumber}`
  ];

  for (const q of queriesToTry) {
    const result = await shopifyGraphQL(graphqlQuery, { query: q });
    const edges = result?.data?.orders?.edges || [];

    for (const edge of edges) {
      const order = edge.node;
      const orderEmail = String(order?.customer?.email || "").toLowerCase().trim();

      if (orderEmail !== String(email).toLowerCase().trim()) continue;

      const customerName = [
        order?.customer?.firstName || "",
        order?.customer?.lastName || ""
      ].join(" ").trim();

      const fulfillments = Array.isArray(order?.fulfillments) ? order.fulfillments : [];
      const trackingInfo = fulfillments[0]?.trackingInfo || [];
      const tracking = trackingInfo[0] || null;

      return {
        type: "order",
        id: order.id,
        order_number: order.name,
        financial_status: order.displayFinancialStatus || null,
        fulfillment_status: order.displayFulfillmentStatus || null,
        total_amount: order?.totalPriceSet?.shopMoney?.amount || null,
        currency: order?.totalPriceSet?.shopMoney?.currencyCode || null,
        created_at: order.createdAt || null,
        customer_name: customerName || null,
        customer_email: order?.customer?.email || null,
        customer_phone: order?.customer?.phone || null,
        tracking_company: tracking?.company || null,
        tracking_number: tracking?.number || null,
        tracking_url: tracking?.url || null,
        line_items: (order?.lineItems?.edges || []).map((itemEdge) => ({
          title: itemEdge.node.title,
          quantity: itemEdge.node.quantity
        }))
      };
    }
  }

  return null;
}

async function upsertProductAndVariants(product) {
  const firstVariant = product?.variants?.edges?.[0]?.node || null;
  const embeddingText = buildEmbeddingText(product, firstVariant);

  let embedding = null;
  try {
    embedding = await createEmbedding(embeddingText);
  } catch (error) {
    console.warn("Embedding creation failed for product", product?.id, error.message);
  }

  await pool.query(
    `
    INSERT INTO products (id, title, handle, vendor, product_type, tags, image, embedding_text, embedding, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,NOW())
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      handle = EXCLUDED.handle,
      vendor = EXCLUDED.vendor,
      product_type = EXCLUDED.product_type,
      tags = EXCLUDED.tags,
      image = EXCLUDED.image,
      embedding_text = EXCLUDED.embedding_text,
      embedding = EXCLUDED.embedding,
      updated_at = NOW()
    `,
    [
      product.id,
      product.title,
      product.handle,
      product.vendor,
      product.productType,
      Array.isArray(product.tags) ? product.tags.join(", ") : "",
      product.featuredImage?.url || null,
      embeddingText,
      embedding ? `[${embedding.join(",")}]` : null
    ]
  );

  for (const vEdge of (product.variants?.edges || [])) {
    const v = vEdge.node;

    await pool.query(
      `
      INSERT INTO variants (id, product_id, title, sku, price, inventory, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT (id) DO UPDATE SET
        product_id = EXCLUDED.product_id,
        title = EXCLUDED.title,
        sku = EXCLUDED.sku,
        price = EXCLUDED.price,
        inventory = EXCLUDED.inventory,
        updated_at = NOW()
      `,
      [
        v.id,
        product.id,
        v.title,
        v.sku || null,
        v.price ? Number(v.price) : null,
        v.inventoryQuantity ?? 0
      ]
    );
  }
}

async function fetchShopifyProductsPage(limit = 50, afterCursor = null) {
  const graphqlQuery = `
    query FetchProductsPage($first: Int!, $after: String) {
      products(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
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
            variants(first: 50) {
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

  const result = await shopifyGraphQL(graphqlQuery, {
    first: limit,
    after: afterCursor
  });

  return result?.data?.products || {
    pageInfo: { hasNextPage: false, endCursor: null },
    edges: []
  };
}

async function syncProductsFromShopify(limit = 50) {
  const page = await fetchShopifyProductsPage(limit, null);
  const products = page.edges || [];

  for (const edge of products) {
    await upsertProductAndVariants(edge.node);
  }

  return { synced_products: products.length };
}

async function syncAllProductsFromShopify(batchSize = 250, maxPages = 500) {
  let after = null;
  let hasNextPage = true;
  let totalSynced = 0;
  let pages = 0;

  while (hasNextPage && pages < maxPages) {
    const page = await fetchShopifyProductsPage(batchSize, after);
    const products = page.edges || [];

    for (const edge of products) {
      await upsertProductAndVariants(edge.node);
      totalSynced += 1;
    }

    hasNextPage = Boolean(page?.pageInfo?.hasNextPage);
    after = page?.pageInfo?.endCursor || null;
    pages += 1;

    console.log(`Synced page ${pages}, batch ${products.length}, total ${totalSynced}`);

    if (!products.length) break;
  }

  return {
    success: true,
    synced_products: totalSynced,
    pages_processed: pages,
    has_more: hasNextPage
  };
}

async function searchProductsFromDb(searchText) {
  let keywords = extractSearchKeywords(searchText);
  keywords = expandKeywords(keywords);

  if (!keywords.length) return [];

  const likeTerms = keywords.map((k) => `%${k}%`);

  const result = await pool.query(
    `
    SELECT
      p.id,
      p.title,
      p.handle,
      p.vendor,
      p.product_type,
      p.image,
      v.id AS variant_id,
      v.title AS variant_title,
      v.sku,
      v.price,
      v.inventory,
      CASE
        WHEN LOWER(COALESCE(v.sku, '')) = $1 THEN 100
        WHEN LOWER(COALESCE(v.sku, '')) LIKE ANY($2) THEN 80
        WHEN LOWER(COALESCE(p.title, '')) LIKE ANY($2) THEN 60
        WHEN LOWER(COALESCE(v.title, '')) LIKE ANY($2) THEN 40
        WHEN LOWER(COALESCE(p.vendor, '')) LIKE ANY($2) THEN 20
        ELSE 0
      END AS score
    FROM products p
    LEFT JOIN variants v ON v.product_id = p.id
    WHERE
      LOWER(COALESCE(p.title, '')) LIKE ANY($2)
      OR LOWER(COALESCE(v.title, '')) LIKE ANY($2)
      OR LOWER(COALESCE(v.sku, '')) LIKE ANY($2)
      OR LOWER(COALESCE(p.vendor, '')) LIKE ANY($2)
    ORDER BY score DESC, COALESCE(v.inventory, 0) DESC, p.title ASC
    LIMIT 12
    `,
    [keywords[0], likeTerms]
  );

  return result.rows.map((row) => ({
    type: "product",
    id: row.id,
    title: row.title,
    handle: row.handle,
    vendor: row.vendor,
    product_type: row.product_type,
    image: row.image,
    variant_id: row.variant_id,
    variant_title: row.variant_title,
    sku: row.sku,
    price: row.price,
    inventory: row.inventory,
    url: `https://samnailsupply.com/products/${row.handle}`
  }));
}

async function semanticSearchProducts(searchText, limit = 10) {
  if (!process.env.OPENAI_API_KEY) return [];

  const embedding = await createEmbedding(searchText);
  if (!embedding) return [];

  const vectorLiteral = `[${embedding.join(",")}]`;

  const result = await pool.query(
    `
    SELECT
      p.id,
      p.title,
      p.handle,
      p.vendor,
      p.product_type,
      p.image,
      v.id AS variant_id,
      v.title AS variant_title,
      v.sku,
      v.price,
      v.inventory,
      p.embedding_text,
      (p.embedding <=> $1::vector) AS distance
    FROM products p
    LEFT JOIN variants v ON v.product_id = p.id
    WHERE p.embedding IS NOT NULL
    ORDER BY p.embedding <=> $1::vector ASC
    LIMIT $2
    `,
    [vectorLiteral, limit]
  );

  return result.rows.map((row) => ({
    type: "product",
    id: row.id,
    title: row.title,
    handle: row.handle,
    vendor: row.vendor,
    product_type: row.product_type,
    image: row.image,
    variant_id: row.variant_id,
    variant_title: row.variant_title,
    sku: row.sku,
    price: row.price,
    inventory: row.inventory,
    url: `https://samnailsupply.com/products/${row.handle}`,
    semantic_distance: row.distance
  }));
}

app.get("/sync/products", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 250);
    const result = await syncProductsFromShopify(limit);

    res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error("SYNC PRODUCTS ERROR:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/sync/products/all", async (req, res) => {
  try {
    const batchSize = Math.min(Number(req.query.batch || 250), 250);
    const maxPages = Number(req.query.max_pages || 500);

    const result = await syncAllProductsFromShopify(batchSize, maxPages);
    res.status(200).json(result);
  } catch (error) {
    console.error("SYNC ALL PRODUCTS ERROR:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body || {};

    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: "Message is required" });
    }

    if (looksLikeOnlyEmail(message)) {
      return res.status(200).json({
        reply: "Please include your order number with your email so I can check the order. Example: order 12345 john@email.com",
        type: "order_lookup"
      });
    }

    if (looksLikeOrderQuery(message)) {
      const orderNumber = extractOrderNumber(message);
      const email = extractEmail(message);

      if (!orderNumber || !email) {
        return res.status(200).json({
          reply: buildSmartOrderLookupPrompt(),
          type: "order_lookup"
        });
      }

      const order = await searchShopifyOrderByNumberAndEmail(orderNumber, email);

      return res.status(200).json({
        reply: buildSmartOrderReply(order, message),
        type: "order",
        order
      });
    }

    let products = [];

    try {
      products = await searchProductsFromDb(message);
    } catch (dbError) {
      console.error("DB SEARCH ERROR:", dbError.message);
    }

    products = applyBudgetFilter(products, message);
    products = rankProducts(products, message);

    if (!products.length) {
      try {
        products = await semanticSearchProducts(message, 10);
        products = applyBudgetFilter(products, message);
        products = rankProducts(products, message);
      } catch (semanticError) {
        console.error("SEMANTIC SEARCH ERROR:", semanticError.message);
      }
    }

    if (!products.length) {
      try {
        console.log("No DB or semantic match, falling back to Shopify live search");
        products = await searchShopifyProducts(message);
        products = applyBudgetFilter(products, message);
        products = rankProducts(products, message);
      } catch (shopifyError) {
        console.error("SHOPIFY FALLBACK ERROR:", shopifyError.message);
      }
    }

    return res.status(200).json({
      reply: buildBeautySalesReplyV2(products, message),
      type: "product",
      products
    });
  } catch (error) {
    console.error("CHAT ERROR:", error);
    return res.status(500).json({
      error: "Server error",
      detail: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

async function startServer() {
  console.log("Starting app...");
  console.log("PORT =", PORT);

  app.listen(PORT, "0.0.0.0", async () => {
    console.log(`Listening on ${PORT}`);

    try {
      await initDb();
      console.log("Database ready");
    } catch (error) {
      console.error("Database init skipped:", error.message);
    }
  });
}

startServer();