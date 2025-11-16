const skuMap = require("./sku-map.json");

const express = require("express");
const app = express();

const DELIV_AUTH_URL =
  "https://auth-sandbox.developers.deliveroo.com/oauth2/token";

async function getDeliverooAccessToken() {
  const clientId = process.env.DELIV_CLIENT_ID;
  const clientSecret = process.env.DELIV_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("Missing Deliveroo credentials in environment variables");
    throw new Error("Deliveroo credentials not configured");
  }

  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  params.append("client_id", clientId);
  params.append("client_secret", clientSecret);

  const response = await fetch(DELIV_AUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params,
  });

  if (!response.ok) {
    const text = await response.text();
    console.error("Failed to get Deliveroo token:", response.status, text);
    throw new Error("Deliveroo auth failed");
  }

  const data = await response.json();
  console.log(
    "Got Deliveroo access token (expires_in:",
    data.expires_in,
    "seconds)"
  );
  return data.access_token;
}

app.use(express.json());

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ message: "Deliveroo–Linnworks integration is running" });
});

// Linnworks required endpoints (stub versions)
app.post("/linnworks/add-new-user", (req, res) => {
  res.json({ success: true, message: "Add new user stub" });
});

app.post("/linnworks/user-config", (req, res) => {
  res.json({ success: true, config: {} });
});

app.post("/linnworks/save-config", (req, res) => {
  res.json({ success: true });
});

app.post("/linnworks/shipping-tags", (req, res) => {
  res.json({ success: true, tags: [] });
});

app.post("/linnworks/payment-tags", (req, res) => {
  res.json({ success: true, tags: [] });
});

app.post("/linnworks/config-deleted", (req, res) => {
  res.json({ success: true });
});

app.post("/linnworks/config-test", (req, res) => {
  res.json({ success: true, message: "Config test OK" });
});

// Order endpoint (real logic will be added later)
app.post("/linnworks/orders", (req, res) => {
  res.json({
    hasMoreOrders: false,
    orders: [],
  });
});

// Inventory update endpoint (now using sku-map.json + Deliveroo token)
app.post("/linnworks/inventory-update", async (req, res) => {
  const body = req.body;

  console.log("Inventory update received:", JSON.stringify(body, null, 2));

  if (!body.items || !Array.isArray(body.items)) {
    return res
      .status(400)
      .json({ success: false, message: "Missing items array" });
  }

  try {
    // 1) Get a Deliveroo token for this batch of updates
    const accessToken = await getDeliverooAccessToken();

    // 2) Build list of items to send to Deliveroo using mapping
    const itemsForDeliveroo = body.items
      .map((item) => {
        const sku = item.sku || item.channelSKU || "UNKNOWN";
        const stockLevel = item.stockLevel ?? item.stock ?? 0;
        const available = stockLevel > 0;

        // Look up Deliveroo item ID from sku-map.json
        const itemId = skuMap[sku];

        if (!itemId) {
          console.warn(
            `⚠️ No Deliveroo item mapping found for SKU '${sku}'. Skipping.`
          );
          return null; // item skipped
        }

        console.log(
          `Preparing Deliveroo update for SKU ${sku}: ` +
            `mapped Deliveroo itemId=${itemId}, stockLevel=${stockLevel}, available=${available}`
        );

        return { itemId, available, sku, stockLevel };
      })
      .filter((it) => it !== null); // remove skipped items

    console.log(
      `With token ${accessToken.slice(
        0,
        10
      )}... would update Deliveroo items:`,
      JSON.stringify(itemsForDeliveroo, null, 2)
    );

    // Later we'll call the real Deliveroo Catalogue API here using itemsForDeliveroo

    res.json({ success: true });
  } catch (err) {
    console.error("Error in inventory-update handler:", err.message);
    res
      .status(500)
      .json({ success: false, message: "Error talking to Deliveroo" });
  }
});

// Deliveroo webhook endpoint (orders)
app.post("/deliveroo/order-webhook", (req, res) => {
  console.log("Deliveroo webhook received:", req.body);
  res.status(200).send("OK");
});

// Start app on Render-assigned port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
