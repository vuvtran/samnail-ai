const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

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

const pool = new Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: Number(process.env.PGPORT || 5432),
  ssl: process.env.PGHOST && !String(process.env.PGHOST).includes("localhost")
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      title TEXT,
      handle TEXT,
      vendor TEXT,
      product_type TEXT,
      tags TEXT,
      image TEXT,
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

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ status: "ok", db: "connected" });
  } catch (error) {
    res.status(200).json({
      status: "ok",
      db: "disconnected",
      detail: error.message || "Database not connected"
    });
  }
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

function looksLikeOrderQuery(message) {
  const text = String(message || "").toLowerCase().trim();

  if (!text) return false;
  if (/\border\b/.test(text)) return true;
  if (/\bstatus\b/.test(text) && /#?\d{4,}/.test(text)) return true;
  if (/#\d{4,}/.test(text)) return true;
  if (/\b\d{4,}\b/.test(text) && /\b(check|find|lookup|track|status)\b/.test(text)) return true;

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
      products(first: 10, query: $query) {
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

      if (orderEmail !== String(email).toLowerCase().trim()) {
        continue;
      }

      const customerName = [
        order?.customer?.firstName || "",
        order?.customer?.lastName || ""
      ].join(" ").trim();

      const tracking = order?.fulfillments?.[0]?.trackingInfo?.[0] || null;

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
  await pool.query(
    `
    INSERT INTO products (id, title, handle, vendor, product_type, tags, image, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      handle = EXCLUDED.handle,
      vendor = EXCLUDED.vendor,
      product_type = EXCLUDED.product_type,
      tags = EXCLUDED.tags,
      image = EXCLUDED.image,
      updated_at = NOW()
    `,
    [
      product.id,
      product.title,
      product.handle,
      product.vendor,
      product.productType,
      Array.isArray(product.tags) ? product.tags.join(", ") : "",
      product.featuredImage?.url || null
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

  return result?.data?.products || { pageInfo: { hasNextPage: false, endCursor: null }, edges: [] };
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

    if (!products.length) {
      break;
    }
  }

  return {
    success: true,
    synced_products: totalSynced,
    pages_processed: pages,
    has_more: hasNextPage
  };
}

async function searchProductsFromDb(searchText) {
  const cleaned = String(searchText || "").trim();
  if (!cleaned) return [];

  const exact = cleaned.toLowerCase();
  const like = `%${exact}%`;

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
        WHEN LOWER(COALESCE(v.sku, '')) LIKE $2 THEN 80
        WHEN LOWER(COALESCE(p.title, '')) LIKE $2 THEN 60
        WHEN LOWER(COALESCE(v.title, '')) LIKE $2 THEN 40
        WHEN LOWER(COALESCE(p.vendor, '')) LIKE $2 THEN 20
        ELSE 0
      END AS score
    FROM products p
    LEFT JOIN variants v ON v.product_id = p.id
    WHERE
      LOWER(COALESCE(p.title, '')) LIKE $2
      OR LOWER(COALESCE(v.sku, '')) LIKE $2
      OR LOWER(COALESCE(v.title, '')) LIKE $2
      OR LOWER(COALESCE(p.vendor, '')) LIKE $2
    ORDER BY score DESC, COALESCE(v.inventory, 0) DESC, p.title ASC
    LIMIT 10
    `,
    [exact, like]
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

function formatReply(products, originalMessage) {
  if (!products.length) {
    return `I could not find matching products for "${originalMessage}".`;
  }

  return products
    .map((p, i) => {
      const priceText = p.price ? ` - $${p.price}` : "";
      const skuText = p.sku ? ` | SKU: ${p.sku}` : "";
      const stockText = p.inventory !== null && p.inventory !== undefined ? ` | Stock: ${p.inventory}` : "";
      return `${i + 1}. ${p.title}${priceText}${skuText}${stockText}`;
    })
    .join("\n");
}

function formatOrderReply(order, originalMessage) {
  if (!order) {
    return `I could not find an order matching "${originalMessage}". Please double-check your order number and email address.`;
  }

  const lines = [
    `Order ${order.order_number || ""}`,
    order.customer_name ? `Customer: ${order.customer_name}` : null,
    order.financial_status ? `Payment: ${order.financial_status}` : null,
    order.fulfillment_status ? `Fulfillment: ${order.fulfillment_status}` : null,
    order.total_amount ? `Total: ${order.total_amount} ${order.currency || ""}`.trim() : null,
    order.created_at ? `Placed: ${new Date(order.created_at).toLocaleString("en-US")}` : null,
    order.tracking_number ? `Tracking: ${order.tracking_number}` : null,
    order.tracking_company ? `Carrier: ${order.tracking_company}` : null,
    order.tracking_url ? `Tracking URL: ${order.tracking_url}` : null
  ].filter(Boolean);

  return lines.join("\n");
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

    if (looksLikeOrderQuery(message)) {
      const orderNumber = extractOrderNumber(message);
      const email = extractEmail(message);

      if (!orderNumber || !email) {
        return res.status(200).json({
          reply: "Please provide both your order number and email address. Example: order 12345 john@email.com",
          type: "order_lookup"
        });
      }

      const order = await searchShopifyOrderByNumberAndEmail(orderNumber, email);

      return res.status(200).json({
        reply: formatOrderReply(order, message),
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

    if (!products.length) {
      console.log("DB returned no results, falling back to Shopify live search");
      products = await searchShopifyProducts(message);
    }

    res.status(200).json({
      reply: formatReply(products, message),
      type: "product",
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