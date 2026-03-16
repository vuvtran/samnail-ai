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
  ssl: process.env.PGHOST && process.env.PGHOST !== "localhost"
    ? { rejectUnauthorized: false }
    : false
});

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
    res.status(200).json({ status: "ok" });
  } catch (error) {
    res.status(500).json({ status: "db_error", detail: error.message });
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

async function searchShopifyProducts(searchText) {
  const store = process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!store || !token) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN (or SHOPIFY_STORE) or SHOPIFY_ACCESS_TOKEN");
  }

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

async function syncProductsFromShopify(limit = 50) {
  const store = process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!store || !token) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN (or SHOPIFY_STORE) or SHOPIFY_ACCESS_TOKEN");
  }

  const graphqlQuery = `
    query SyncProducts {
      products(first: ${limit}) {
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

  const response = await fetch(`https://${store}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query: graphqlQuery })
  });

  const result = await response.json();

  if (!response.ok || result.errors) {
    throw new Error(JSON.stringify(result.errors || result));
  }

  const products = result?.data?.products?.edges || [];

  for (const edge of products) {
    await upsertProductAndVariants(edge.node);
  }

  return { synced_products: products.length };
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

app.get("/sync/products", async (req, res) => {
  try {
    const limit = Number(req.query.limit || 50);
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

app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body || {};

    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: "Message is required" });
    }

    let products = await searchProductsFromDb(message);

    if (!products.length) {
      console.log("DB returned no results, falling back to Shopify live search");
      products = await searchShopifyProducts(message);
    }

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

async function startServer() {
  try {
    console.log("Starting app...");
    console.log("PORT =", PORT);

    try {
  await initDb();
} catch (e) {
  console.log("Database not ready, continuing without DB");
}

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Listening on ${PORT}`);
    });
  } catch (error) {
    console.error("STARTUP ERROR:", error);
    process.exit(1);
  }
}

startServer();