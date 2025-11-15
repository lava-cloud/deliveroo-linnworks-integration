const express = require("express");
const app = express();

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
    orders: []
  });
});

// Inventory update endpoint (real logic added later)
app.post("/linnworks/inventory-update", (req, res) => {
  const body = req.body;

  console.log("Inventory update received:", JSON.stringify(body, null, 2));

  if (!body.items || !Array.isArray(body.items)) {
    return res.status(400).json({ success: false, message: "Missing items array" });
  }

  // Loop through each item and decide availability
  body.items.forEach(item => {
    const sku = item.sku || item.channelSKU || "UNKNOWN";
    const stockLevel = item.stockLevel ?? item.stock ?? 0;

    const available = stockLevel > 0;

    // This is where we will later call Deliveroo's API.
    // For now we just log what we WOULD do.
    console.log(
      `Would update Deliveroo item for SKU ${sku}: ` +
      `stockLevel=${stockLevel}, available=${available}`
    );
  });

  res.json({ success: true });
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
