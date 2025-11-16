const skuMap = require("./sku-map.json");

const express = require("express");
const app = express();

const DELIV_AUTH_URL =
  "https://auth-sandbox.developers.deliveroo.com/oauth2/token";

// In-memory store for Deliveroo orders (simple first version)
let pendingDeliverooOrders = [];

// ----- Deliveroo auth helper -----
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

// ----- Health check -----
app.get("/", (req, res) => {
  res.json({ message: "Deliveroo–Linnworks integration is running" });
});

// ----- Linnworks required endpoints (stubs for now) -----
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

// ----- Linnworks Orders endpoint (now returns pending Deliveroo orders) -----
app.post("/linnworks/orders", (req, res) => {
  console.log(
    "Linnworks requested orders. Pending Deliveroo orders:",
    pendingDeliverooOrders.length
  );

  // Basic, channel-agnostic shape for now.
  // We will later adjust this to match Linnworks' exact order schema.
  const ordersToSend = pendingDeliverooOrders.map((o) => ({
    OrderId: o.orderId, // external/channel order ID
    ReferenceNumber: o.orderId,
    Source: "Deliveroo",
    ReceivedAt: o.receivedAt,
    // Raw payload from Deliveroo - useful while we’re developing the mapping
    RawJson: o.raw,
  }));

  // Clear the queue once sent (Linnworks has "picked them up")
  pendingDeliverooOrders = [];

  res.json({
    hasMoreOrders: false,
    orders: ordersToSend,
  });
});

// ----- Linnworks Inventory Update endpoint -----
app.post("/linnworks/inventory-update", async (req, res) => {
  const body = req.body;

  console.log("Inventory update received:", JSON.stringify(body, null, 2));

  if (!body.items || !Array.isArray(body.items)) {
    return res
      .status(400)
      .json({ success: false, message: "Missing items array" });
  }

  try {
    const accessToken = await getDeliverooAccessToken();

    // Build the list of items to send to Deliveroo using SKU mapping
    const itemsForDeliveroo = body.items
      .map((item) => {
        const sku = item.sku || item.channelSKU || "UNKNOWN";
        const stockLevel = item.stockLevel ?? item.stock ?? 0;
        const available = stockLevel > 0;

        const itemId = skuMap[sku];

        if (!itemId) {
          console.warn(
            `⚠️ No Deliveroo item mapping found for SKU '${sku}'. Skipping.`
          );
          return null;
        }

        console.log(
          `Preparing Deliveroo update for SKU ${sku}: ` +
            `mapped Deliveroo itemId=${itemId}, stockLevel=${stockLevel}, available=${available}`
        );

        return { itemId, available, sku, stockLevel };
      })
      .filter((it) => it !== null);

    console.log(
      `With token ${accessToken.slice(
        0,
        10
      )}... would update Deliveroo items:`,
      JSON.stringify(itemsForDeliveroo, null, 2)
    );

    // Later we will call the actual Deliveroo Catalogue/Menu API here
    // using itemsForDeliveroo and your Brand/Catalogue/Site IDs.

    res.json({ success: true });
  } catch (err) {
    console.error("Error in inventory-update handler:", err.message);
    res
      .status(500)
      .json({ success: false, message: "Error talking to Deliveroo" });
  }
});

// ----- Deliveroo webhook endpoint (orders) -----
app.post("/deliveroo/order-webhook", (req, res) => {
  const order = req.body || {};

  // Try to find some kind of ID in the payload
  const orderId =
    order.id ||
    order.order_id ||
    order.orderId ||
    order.orderReference ||
    `unknown-${Date.now()}`;

  const receivedAt = new Date().toISOString();

  console.log(
    "Deliveroo webhook received for order",
    orderId,
    JSON.stringify(order, null, 2)
  );

  // Store in memory for Linnworks to fetch later
  pendingDeliverooOrders.push({
    orderId,
    receivedAt,
    raw: order,
  });

  res.status(200).send("OK");
});

// ----- Start app -----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
