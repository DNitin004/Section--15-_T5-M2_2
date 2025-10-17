/*
Simple E-commerce API (Node.js + Express + MongoDB using Mongoose)
Single-file implementation for demo / starter purposes.

Features:
- View all products, view product by id
- Create orders, list orders, get order by id
- Update order status (cancel, mark as shipped/delivered)
- Track order status
- Basic stock checks when creating/cancelling orders

Environment:
- Node 18+ recommended
- MongoDB URI in env var MONGO_URI (e.g. mongodb://localhost:27017/ecommerce)
- PORT optional (default 3000)

How to run:
1. mkdir ecommerce && cd ecommerce
2. npm init -y
3. npm i express mongoose dotenv body-parser morgan
4. create a .env file with MONGO_URI and optional PORT
5. Save this file as server.js
6. node server.js

Notes:
- This file is intentionally compact for readability. For production, split into routes/controllers/models and add authentication, validation, tests, logging, rate-limiting.
*/

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const morgan = require('morgan');
const bodyParser = require('body-parser');

const app = express();
app.use(morgan('dev'));
app.use(bodyParser.json());

// --- Mongoose models ---
const { Schema } = mongoose;

const ProductSchema = new Schema({
  name: { type: String, required: true },
  description: String,
  price: { type: Number, required: true, min: 0 }, // store price in cents/paise for integer
  stock: { type: Number, default: 0, min: 0 },
  category: String,
}, { timestamps: true });

const OrderItemSchema = new Schema({
  product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  quantity: { type: Number, required: true, min: 1 },
  priceAtPurchase: { type: Number, required: true, min: 0 },
});

const OrderSchema = new Schema({
  customerId: { type: Number, required: true },
  items: [OrderItemSchema],
  totalAmount: { type: Number, required: true, min: 0 },
  shippingAddress: String,
  status: { type: String, enum: ['pending','confirmed','shipped','out_for_delivery','delivered','cancelled'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  estimatedDelivery: Date,
}, { timestamps: true });

const Product = mongoose.model('Product', ProductSchema);
const Order = mongoose.model('Order', OrderSchema);

// --- Helper functions ---
async function calculateTotalAndCheckStock(items) {
  // items: [{ productId, quantity }]
  const productIds = items.map(i => i.productId);
  const products = await Product.find({ _id: { $in: productIds } });
  if (products.length !== productIds.length) {
    throw { status: 400, message: 'One or more products not found' };
  }

  let total = 0;
  const enriched = items.map(item => {
    const p = products.find(pp => pp._id.equals(item.productId));
    if (!p) throw { status: 400, message: `Product ${item.productId} not found` };
    if (p.stock < item.quantity) throw { status: 400, message: `Insufficient stock for product ${p._id} (${p.name})` };
    total += p.price * item.quantity;
    return { product: p, quantity: item.quantity, priceAtPurchase: p.price };
  });

  return { total, enriched };
}

// reduce stock: atomic-ish by updating product docs one by one
async function reduceStock(enrichedItems) {
  const ops = enrichedItems.map(it =>
    Product.updateOne({ _id: it.product._id, stock: { $gte: it.quantity } }, { $inc: { stock: -it.quantity } })
  );
  const res = await Promise.all(ops);
  // check if any update failed (matchedCount === 0)
  for (let i = 0; i < res.length; i++) {
    if (res[i].modifiedCount === 0 && res[i].matchedCount === 0) {
      throw { status: 500, message: `Failed to reserve stock for product ${enrichedItems[i].product._id}` };
    }
  }
}

async function restoreStock(enrichedItems) {
  const ops = enrichedItems.map(it =>
    Product.updateOne({ _id: it.product }, { $inc: { stock: it.quantity } })
  );
  await Promise.all(ops);
}

// --- Routes ---

// Health
app.get('/v1/health', (req, res) => res.json({ ok: true, ts: new Date() }));

// --- Products ---
app.get('/v1/products', async (req, res, next) => {
  try {
    const products = await Product.find().select('-__v');
    res.json(products);
  } catch (err) { next(err); }
});

app.get('/v1/products/:id', async (req, res, next) => {
  try {
    const p = await Product.findById(req.params.id).select('-__v');
    if (!p) return res.status(404).json({ error: 'Product not found' });
    res.json(p);
  } catch (err) { next(err); }
});

// Admin-ish: create product (simple, no auth here)
app.post('/v1/products', async (req, res, next) => {
  try {
    const { name, description, price, stock, category } = req.body;
    const p = new Product({ name, description, price, stock, category });
    await p.save();
    res.status(201).json(p);
  } catch (err) { next(err); }
});

// --- Orders ---
// Create an order
app.post('/v1/orders', async (req, res, next) => {
  try {
    const { customer_id, items, shipping_address } = req.body;
    if (!customer_id || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'customer_id and items are required' });
    }

    // Normalize items
    const normalized = items.map(i => ({ productId: i.product_id || i.productId, quantity: i.quantity }));

    // 1. Check stock and compute total
    const { total, enriched } = await calculateTotalAndCheckStock(normalized);

    // 2. Reserve stock (decrement)
    await reduceStock(enriched);

    // 3. Create order document
    const orderItems = enriched.map(e => ({ product: e.product._id, quantity: e.quantity, priceAtPurchase: e.priceAtPurchase }));
    const order = new Order({
      customerId: customer_id,
      items: orderItems,
      totalAmount: total,
      shippingAddress: shipping_address,
      status: 'confirmed',
      estimatedDelivery: new Date(Date.now() + 5*24*60*60*1000) // +5 days default
    });
    await order.save();

    res.status(201).json({ order_id: order._id, status: order.status, total_amount: order.totalAmount });
  } catch (err) {
    // If we failed after reserving some stock, you'd normally rollback. For simplicity, this demo throws an error.
    next(err);
  }
});

// Get all orders for a customer (query param customer_id) - in real app require auth
app.get('/v1/orders', async (req, res, next) => {
  try {
    const { customer_id } = req.query;
    if (!customer_id) return res.status(400).json({ error: 'customer_id query parameter required' });
    const orders = await Order.find({ customerId: customer_id }).sort({ createdAt: -1 }).populate('items.product', 'name price');
    res.json(orders);
  } catch (err) { next(err); }
});

// Get order by id
app.get('/v1/orders/:id', async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id).populate('items.product', 'name description price');
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) { next(err); }
});

// Update order (e.g., cancel before shipped)
app.put('/v1/orders/:id', async (req, res, next) => {
  try {
    const { status, shipping_address } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Example: cancel order and restore stock if not shipped/delivered
    if (status === 'cancelled') {
      if (['shipped','out_for_delivery','delivered'].includes(order.status)) {
        return res.status(400).json({ error: 'Cannot cancel an order already shipped or delivered' });
      }
      // restore stock
      const enriched = order.items.map(it => ({ product: it.product, quantity: it.quantity }));
      await restoreStock(enriched);
      order.status = 'cancelled';
      order.updatedAt = new Date();
      await order.save();
      return res.json({ ok: true, order_id: order._id, status: order.status });
    }

    // Allow updating shipping address prior to shipping
    if (shipping_address) {
      if (['shipped','out_for_delivery','delivered'].includes(order.status)) {
        return res.status(400).json({ error: 'Cannot change address after shipping' });
      }
      order.shippingAddress = shipping_address;
      order.updatedAt = new Date();
      await order.save();
      return res.json({ ok: true, order_id: order._id, shipping_address: order.shippingAddress });
    }

    // Generic status update (admin-like)
    if (status) {
      order.status = status;
      order.updatedAt = new Date();
      await order.save();
      return res.json({ ok: true, order_id: order._id, status: order.status });
    }

    res.status(400).json({ error: 'No actionable fields provided' });
  } catch (err) { next(err); }
});

// Delete an order (soft-cancel)
app.delete('/v1/orders/:id', async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (['shipped','out_for_delivery','delivered'].includes(order.status)) return res.status(400).json({ error: 'Cannot delete an order already shipped/delivered' });
    // restore stock
    const enriched = order.items.map(it => ({ product: it.product, quantity: it.quantity }));
    await restoreStock(enriched);
    order.status = 'cancelled';
    await order.save();
    res.json({ ok: true, order_id: order._id, status: order.status });
  } catch (err) { next(err); }
});

// Order status endpoint
app.get('/v1/orders/:id/status', async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id).select('status estimatedDelivery createdAt updatedAt');
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ order_id: order._id, status: order.status, estimated_delivery: order.estimatedDelivery });
  } catch (err) { next(err); }
});

// --- Seed route for quick demo (creates few products) ---
app.post('/v1/seed', async (req, res, next) => {
  try {
    const sample = [
      { name: 'Wireless Headphones', description: 'Noise-cancelling over-ear', price: 249900, stock: 10, category: 'Electronics' },
      { name: 'T-Shirt', description: '100% cotton', price: 59900, stock: 30, category: 'Clothing' },
      { name: 'Coffee Mug', description: 'Ceramic 350ml', price: 19900, stock: 50, category: 'Home' },
      { name: 'USB-C Cable', description: '1m fast charging', price: 39900, stock: 100, category: 'Accessories' },
      { name: 'Notebook', description: '200 pages ruled', price: 12900, stock: 200, category: 'Stationery' },
    ];
    await Product.deleteMany({});
    const created = await Product.insertMany(sample);
    res.json({ created });
  } catch (err) { next(err); }
});

// --- Error handling ---
app.use((err, req, res, next) => {
  console.error(err);
  if (err && err.status && err.message) return res.status(err.status).json({ error: err.message });
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

// --- Start server & connect DB ---
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/ecommerce_demo';

mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => {
    console.log('Connected to MongoDB');
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
  });
