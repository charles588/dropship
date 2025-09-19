// backend.js
// Dropship backend with Stripe Connect (profit split), order saving, and email confirmation
// Usage:
// 1) npm init -y
// 2) npm install express axios cors dotenv stripe nodemailer body-parser
// 3) create a .env (example below)
// 4) node backend.js

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json());
app.use(bodyParser.raw({ type: 'application/json' })); // for webhook signature verification if needed

const PORT = process.env.PORT || 1000;
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// --- Configuration (from .env) ---
const SUPPLIER_STRIPE_ACCOUNT = process.env.SUPPLIER_STRIPE_ACCOUNT || null; // connected account id (acct_...)
const SUPPLIER_API_URL = process.env.SUPPLIER_API_URL || ''; // optional supplier API endpoint to forward orders to
const SUPPLIER_API_KEY = process.env.SUPPLIER_API_KEY || ''; // optional supplier API key for forwarding

// Email (Nodemailer SMTP)
const EMAIL_FROM = process.env.EMAIL_FROM || 'no-reply@yourdomain.com';
const EMAIL_TO_ADMIN = process.env.EMAIL_TO_ADMIN || 'you@yourdomain.com';
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT || '587', 10),
  secure: (process.env.EMAIL_SECURE === 'true'), // true for 465, false for other ports
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// utils: save orders locally
function saveOrderLocally(order) {
  const file = path.join(__dirname, 'orders.json');
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [];
  existing.push(order);
  fs.writeFileSync(file, JSON.stringify(existing, null, 2));
}

// --- Helpers ---
function cents(n) { // ensure integer
  return Math.round(n);
}

// Public: products (demo). In production you would read from DB.
const PRODUCTS = [
  { id: 'p1', title: 'Wireless Earbuds', price: 1999, supplierCost: 1500, supplier_sku: 'EB-001' },
  { id: 'p2', title: 'Portable Blender', price: 2950, supplierCost: 2200, supplier_sku: 'PB-07' },
  { id: 'p3', title: 'Fitness Band', price: 1475, supplierCost: 1000, supplier_sku: 'FB-21' }
];

app.get('/api/products', (req, res) => {
  res.json({ success: true, products: PRODUCTS });
});

// Create PaymentIntent with Stripe Connect profit split
// Expects: { cartItems: [{ id, title, price (cents), quantity, supplierCost (cents) }, ...], currency? }
// Returns: { clientSecret, amount, application_fee_amount, supplier_share }
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { cartItems, currency = 'usd' } = req.body;
    if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(400).json({ success: false, message: 'No cart items provided' });
    }

    // Calculate totals
    let total = 0;
    let supplierTotal = 0;
    for (const it of cartItems) {
      const price = parseInt(it.price, 10); // ensure cents (integer)
      const qty = parseInt(it.quantity || it.qty || 1, 10);
      const sup = parseInt(it.supplierCost || 0, 10); // supplier cost in cents
      total += price * qty;
      supplierTotal += sup * qty;
    }
    const profit = total - supplierTotal;
    if (profit < 0) {
      // prevent negative app fee
      return res.status(400).json({ success: false, message: 'Supplier cost exceeds customer price for items' });
    }

    // Build payment intent params
    const params = {
      amount: total,
      currency,
      automatic_payment_methods: { enabled: true }
    };

    // For Stripe Connect split: set application_fee_amount (your profit) and transfer_data.destination
    // NOTE: SUPPLIER_STRIPE_ACCOUNT must be a connected account ID (acct_...)
    if (SUPPLIER_STRIPE_ACCOUNT) {
      params.application_fee_amount = profit;
      params.transfer_data = { destination: SUPPLIER_STRIPE_ACCOUNT };
    } else {
      // If supplier account not configured, we still create the PaymentIntent (app fee disabled)
      console.warn('SUPPLIER_STRIPE_ACCOUNT not configured — PaymentIntent will not split funds.');
    }

    const paymentIntent = await stripe.paymentIntents.create(params);

    res.json({
      clientSecret: paymentIntent.client_secret,
      amount: total,
      application_fee_amount: params.application_fee_amount || 0,
      supplier_share: supplierTotal
    });
  } catch (err) {
    console.error('create-payment-intent error:', err);
    res.status(500).json({ success: false, message: err.message || 'Internal error' });
  }
});

// Place order (after payment confirmed on frontend)
// Expects: { cartItems, paymentIntentId, customer: { name, email, address } }
app.post('/api/place-order', async (req, res) => {
  try {
    const { cartItems, paymentIntentId, customer } = req.body;
    if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid order payload' });
    }
    if (!paymentIntentId) {
      return res.status(400).json({ success: false, message: 'Missing paymentIntentId' });
    }

    // Verify payment
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (!intent || intent.status !== 'succeeded') {
      return res.status(400).json({ success: false, message: 'Payment not completed' });
    }

    // Build supplier order payload (your supplier likely expects different fields — adapt as needed)
    const supplierOrder = {
      merchant_order_id: 'ds-' + Date.now(),
      customer: customer || {},
      items: cartItems.map(i => ({
        sku: i.supplier_sku || i.id || i.sku,
        qty: i.quantity || i.qty || 1,
        title: i.title || i.name,
        price: i.price
      })),
      payment: { stripe_payment_intent: paymentIntentId }
    };

    // Optionally forward order to supplier API (server-side)
    let supplierResponse = null;
    if (SUPPLIER_API_URL && SUPPLIER_API_KEY) {
      try {
        const supResp = await axios.post(SUPPLIER_API_URL, supplierOrder, {
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPPLIER_API_KEY}` },
          timeout: 15000
        });
        supplierResponse = supResp.data;
      } catch (err) {
        // Log and continue — you might want to retry or mark order 'pending'
        console.error('Supplier API call failed:', err.message || err);
        supplierResponse = { success: false, error: err.message || 'Supplier call failed' };
      }
    } else {
      // Simulated supplier response for development
      supplierResponse = { success: true, supplier_order_id: 'SIM-' + Math.floor(Math.random() * 1e6), tracking: 'https://tracking.example/' + Math.floor(Math.random() * 1e6) };
    }

    // Save order locally
    const savedOrder = {
      local_order_id: supplierOrder.merchant_order_id,
      payment_intent: paymentIntentId,
      supplier_response: supplierResponse,
      payload: supplierOrder,
      customer: customer || {},
      created_at: new Date().toISOString()
    };
    saveOrderLocally(savedOrder);

    // Send email confirmations
    try {
      // Customer email (if available)
      if (customer && customer.email) {
        const customerHtml = buildOrderEmailHtml(savedOrder, true);
        await transporter.sendMail({
          from: EMAIL_FROM,
          to: customer.email,
          subject: `Order confirmation — ${savedOrder.local_order_id}`,
          html: customerHtml
        });
      }

      // Admin email
      const adminHtml = buildOrderEmailHtml(savedOrder, false);
      await transporter.sendMail({
        from: EMAIL_FROM,
        to: EMAIL_TO_ADMIN,
        subject: `New order placed — ${savedOrder.local_order_id}`,
        html: adminHtml
      });
    } catch (emailErr) {
      console.error('Email send error:', emailErr);
      // do not fail the whole request for email error, but return info
    }

    res.json({ success: true, order: savedOrder });
  } catch (err) {
    console.error('place-order error:', err);
    res.status(500).json({ success: false, message: err.message || 'Internal error' });
  }
});

// Optional Stripe webhook endpoint (recommended in production)
// Use STRIPE_WEBHOOK_SECRET to verify signature
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.warn('No STRIPE_WEBHOOK_SECRET configured — webhook signature not verified. Proceeding with naive handling.');
    // naive handling: parse json body
    const event = JSON.parse(req.body.toString());
    handleStripeEvent(event).then(() => res.json({ received: true })).catch(e => { console.error(e); res.status(500).end(); });
    return;
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  handleStripeEvent(event).then(() => res.json({ received: true })).catch(e => { console.error(e); res.status(500).end(); });
});

async function handleStripeEvent(event) {
  // handle relevant events
  switch (event.type) {
    case 'payment_intent.succeeded':
      // optional: find local order and mark as paid, or trigger supplier placement here if you prefer webhooks
      console.log('PaymentIntent succeeded:', event.data.object.id);
      break;
    case 'payment_intent.payment_failed':
      console.log('Payment failed:', event.data.object.id);
      break;
    default:
      console.log('Unhandled event type:', event.type);
  }
}

// Helper to build an HTML email for order
function buildOrderEmailHtml(savedOrder, minimal = false) {
  const itemsHtml = savedOrder.payload.items.map(it => {
    const price = (it.price/100).toFixed(2);
    return `<li>${it.title} — qty: ${it.qty} — $${price}</li>`;
  }).join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;color:#111;">
      <h2>Order ${savedOrder.local_order_id}</h2>
      <p>Placed: ${savedOrder.created_at}</p>
      <h3>Customer</h3>
      <p>${savedOrder.customer.name || ''}<br/>${savedOrder.customer.email || ''}</p>
      <h3>Items</h3>
      <ul>${itemsHtml}</ul>
      ${minimal ? '' : `<pre>Supplier response: ${JSON.stringify(savedOrder.supplier_response, null, 2)}</pre>`}
      <p>Thanks — this is an automated message.</p>
    </div>
  `;
  return html;
}

app.get('/api/health', (req, res) => { res.json({ ok: true, time: new Date().toISOString() }); });

app.listen(PORT, () => {
  console.log(`Dropship backend listening on http://localhost:${PORT}`);
});
