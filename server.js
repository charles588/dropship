// server.js (Stripe + Dropship + Admin + Customer Emails)

require('dotenv').config();
const express = require('express');
const path = require('path');
const Stripe = require('stripe');
const axios = require('axios');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const bodyParser = require('body-parser');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
const PORT = process.env.PORT || 3000;

// ========================================================
// 📦 DATABASE (SQLite)
let db;
(async () => {
  db = await open({ filename: path.join(__dirname, 'dropship.db'), driver: sqlite3.Database });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      local_order_id TEXT,
      payment_intent_id TEXT UNIQUE,
      status TEXT,
      customer_name TEXT,
      customer_email TEXT,
      customer_address TEXT,
      items_json TEXT,
      total_cents INTEGER,
      supplier_share_cents INTEGER,
      profit_cents INTEGER,
      supplier_response TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      processed_at TEXT
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      title TEXT,
      price INTEGER,
      supplierCost INTEGER,
      supplier_sku TEXT,
      img TEXT
    )
  `);
})();

// ========================================================
// 📧 EMAIL TRANSPORT
const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE || 'gmail',
  host: process.env.EMAIL_HOST || undefined,
  port: process.env.EMAIL_PORT ? parseInt(process.env.EMAIL_PORT) : undefined,
  secure: process.env.EMAIL_SECURE === 'true',
  auth: { user: process.env.MY_EMAIL, pass: process.env.MY_EMAIL_PASSWORD }
});

// ========================================================
// ⚙️ CONFIG
const DSERS_API_KEY = process.env.DSERS_API_KEY || null;
const DSERS_BASE = process.env.DSERS_BASE || 'https://openapi.dserspro.com';
const SUPPLIER_EMAIL = process.env.SUPPLIER_EMAIL || null;

// ========================================================
// ✅ MIDDLEWARE
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========================================================
// 🛒 PRODUCT ENDPOINTS
app.get('/api/products', async (req,res)=>{
  const products = await db.all('SELECT * FROM products');
  res.json({ success:true, products });
});

app.post('/api/add-product', async (req,res)=>{
  const { id, title, price, supplierCost, supplier_sku, img } = req.body;
  if(!title || !price) return res.json({ success:false, message:'Title & price required' });

  const productId = id || 'p' + Date.now();
  await db.run(`
    INSERT OR REPLACE INTO products (id,title,price,supplierCost,supplier_sku,img)
    VALUES (?,?,?,?,?,?)
  `, productId, title, Math.round(price*100), Math.round((supplierCost||0)*100), supplier_sku||'', img||'');

  const product = await db.get('SELECT * FROM products WHERE id=?', productId);
  res.json({ success:true, product });
});

// Mock fetch AliExpress product
app.post('/api/fetch-aliexpress', async (req,res)=>{
  const { url } = req.body;
  if(!url) return res.json({ success:false, message:'No URL provided' });

  const product = {
    title: 'AliExpress Sample Product',
    price: 2999,
    supplierCost: 1500,
    sku: 'ALX12345',
    img: 'https://via.placeholder.com/200'
  };
  res.json({ success:true, product });
});

// ========================================================
// 💳 PAYMENT ENDPOINTS
app.post('/api/create-payment-intent', async (req,res)=>{
  try{
    const { cartItems, customer, currency='usd' } = req.body;
    if(!Array.isArray(cartItems)||!cartItems.length) return res.status(400).json({ error:'cartItems required' });

    let total=0, supplierTotal=0;
    for(const it of cartItems){
      const price=parseInt(it.price,10);
      const qty=parseInt(it.quantity||1,10);
      const sup=parseInt(it.supplierCost||0,10);
      total += price*qty;
      supplierTotal += sup*qty;
    }
    const profit = total - supplierTotal;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: total,
      currency,
      automatic_payment_methods: { enabled:true },
      receipt_email: customer?.email,
      shipping: customer ? { name:customer.name, address:customer.address } : undefined
    });

    await createDraftOrder({ paymentIntentId: paymentIntent.id, cartItems, customer, total, supplierTotal, profit });

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      total,
      profit,
      supplierShare: supplierTotal
    });
  }catch(err){ console.error(err); res.status(500).json({ error:err.message }); }
});

// ========================================================
// 📝 PLACE ORDER
app.post('/api/place-order', async (req,res)=>{
  try{
    const { cartItems, customer, paymentIntentId } = req.body;
    if(!cartItems || !customer || !paymentIntentId) return res.status(400).json({ error:'Required fields missing' });

    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if(!intent || intent.status!=='succeeded') return res.status(400).json({ error:'Payment not succeeded' });

    let saved = await db.get('SELECT * FROM orders WHERE payment_intent_id=?', paymentIntentId);
    if(!saved){
      const total = cartItems.reduce((s,i)=>s+(i.price*i.quantity),0);
      const supplierTotal = cartItems.reduce((s,i)=>s+((i.supplierCost||0)*i.quantity),0);
      const local_order_id = await createDraftOrder({ paymentIntentId, cartItems, customer, total, supplierTotal, profit: total-supplierTotal });
      saved = await db.get('SELECT * FROM orders WHERE local_order_id=?', local_order_id);
    }

    if(saved.supplier_response) return res.json({ success:true, message:'Already processed', supplierResponse: JSON.parse(saved.supplier_response) });

    const supplierResponse = await placeOrderWithSupplier(cartItems, customer, paymentIntentId);
    await sendCustomerEmail(customer, cartItems, paymentIntentId, saved.total_cents);

    await db.run(`UPDATE orders SET supplier_response=?, status=?, processed_at=datetime("now") WHERE payment_intent_id=?`,
      JSON.stringify(supplierResponse), supplierResponse?.success?'processed':'failed', paymentIntentId);

    res.json({ success:true, supplierResponse });
  }catch(err){ console.error(err); res.status(500).json({ error:err.message }); }
});

// ========================================================
// 🔔 STRIPE WEBHOOK
app.post('/webhook', express.raw({ type:'application/json' }), async (req,res)=>{
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  if(!webhookSecret) event = JSON.parse(req.body.toString());
  else {
    try{ event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret); }
    catch(err){ return res.status(400).send(`Webhook Error: ${err.message}`); }
  }

  try{
    await handleStripeEvent(event);
    res.json({ received:true });
  }catch(err){ console.error(err); res.status(500).end(); }
});

// ========================================================
// 🔔 STRIPE EVENT HANDLER
async function handleStripeEvent(event){
  switch(event.type){
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      const paymentIntentId = pi.id;
      const row = await db.get('SELECT * FROM orders WHERE payment_intent_id=?', paymentIntentId);
      if(!row || row.supplier_response) return;

      const cartItems = JSON.parse(row.items_json||'[]');
      const customerAddress = JSON.parse(row.customer_address||'{}');
      const customer = { name: row.customer_name, email: row.customer_email, address: customerAddress };

      const supplierResponse = await placeOrderWithSupplier(cartItems, customer, paymentIntentId);
      await sendCustomerEmail(customer, cartItems, paymentIntentId, row.total_cents);

      await db.run(`UPDATE orders SET supplier_response=?, status=?, processed_at=datetime("now") WHERE payment_intent_id=?`,
        JSON.stringify(supplierResponse), supplierResponse?.success?'processed':'failed', paymentIntentId);
      break;
    }
    default: console.log(`Unhandled event type: ${event.type}`);
  }
}

// ========================================================
// 🏭 SUPPLIER ORDER
async function placeOrderWithSupplier(cartItems, customer, paymentIntentId){
  if(DSERS_API_KEY){
    try{
      const orderPayload = {
        orderList:[{
          orderInfo:{
            buyerName: customer.name,
            buyerPhone: customer.phone||'',
            buyerEmail: customer.email||'',
            buyerAddress: `${customer.address.line1||''} ${customer.address.city||''} ${customer.address.state||''} ${customer.address.postal_code||''}`,
            shippingCountry: customer.address.country||''
          },
          itemList: cartItems.map(it=>({ skuId: it.dserProductId||it.id, skuNum: it.quantity||1 }))
        }],
        referenceId: paymentIntentId
      };
      const resp = await axios.post(`${DSERS_BASE}/order/create`, orderPayload,{
        headers:{ Authorization:`Bearer ${DSERS_API_KEY}`, 'Content-Type':'application/json' }
      });
      return { success:true, method:'dsers', data:resp.data };
    }catch(err){ console.error('DSers error:', err.response?.data||err.message); }
  }

  if(SUPPLIER_EMAIL){
    try{
      const plain = buildSupplierText(cartItems, customer, paymentIntentId);
      await transporter.sendMail({
        from: process.env.MY_EMAIL,
        to: SUPPLIER_EMAIL,
        subject:`New Dropship Order - ${paymentIntentId}`,
        text: plain
      });
      return { success:true, method:'email', note:'sent to supplier email' };
    }catch(err){ console.error('Email error:', err.message); return { success:false, error:err.message }; }
  }

  return { success:false, error:'No DSERS_API_KEY or SUPPLIER_EMAIL configured' };
}

// ========================================================
// 📧 CUSTOMER EMAIL
async function sendCustomerEmail(customer, cartItems, paymentIntentId, totalCents){
  if(!customer?.email) return false;
  try{
    const total = (totalCents/100).toFixed(2);
    const itemsText = cartItems.map(i=>`${i.title} x${i.quantity} — $${((i.price*i.quantity)/100).toFixed(2)}`).join('\n');
    await transporter.sendMail({
      from: process.env.MY_EMAIL,
      to: customer.email,
      subject:`Your Order Confirmation - ${paymentIntentId}`,
      text: `
Hi ${customer.name},

Thank you for your order! Here are the details:

Payment ID: ${paymentIntentId}
Total: $${total}

Items:
${itemsText}

Your order will be processed and shipped soon.

Thanks,
${process.env.STORE_NAME || 'My Dropship Store'}
      `
    });
    console.log('✅ Customer email sent to', customer.email);
    return true;
  }catch(err){ console.error('❌ Error sending customer email:', err.message); return false; }
}

// ========================================================
// 📋 HELPER: SUPPLIER EMAIL TEXT
function buildSupplierText(cartItems, customer, paymentIntentId){
  const total = cartItems.reduce((s,i)=>s+(i.price*i.quantity),0);
  const supplierTotal = cartItems.reduce((s,i)=>s+((i.supplierCost||0)*i.quantity),0);
  return `
New Dropship Order
Payment ID: ${paymentIntentId}
Total: $${(total/100).toFixed(2)}
Supplier share: $${(supplierTotal/100).toFixed(2)}

Customer:
${customer.name}
${customer.email||''}
${customer.phone||''}
${customer.address.line1||''}, ${customer.address.city||''}, ${customer.address.state||''} ${customer.address.postal_code||''}, ${customer.address.country||''}

Items:
${cartItems.map(i=>`${i.title} x${i.quantity} — $${((i.price*i.quantity)/100).toFixed(2)} (supplierCost: $${(((i.supplierCost||0)*i.quantity)/100).toFixed(2)})`).join('\n')}
  `;
}

// ========================================================
// 🔎 ORDER LOOKUP
app.get('/api/order/:paymentIntentId', async (req,res)=>{
  const id = req.params.paymentIntentId;
  const row = await db.get('SELECT * FROM orders WHERE payment_intent_id=?',id);
  if(!row) return res.status(404).json({ error:'not found' });
  res.json({ order: row });
});

// ========================================================
// 🏠 FRONTEND
app.get('/', (req,res)=>res.sendFile(path.join(__dirname,'public','ship.html')));

// ========================================================
// CREATE DRAFT ORDER HELPER
async function createDraftOrder({ paymentIntentId, cartItems, customer, total, supplierTotal, profit }){
  const local_order_id = 'o'+Date.now();
  await db.run(`INSERT INTO orders 
    (local_order_id,payment_intent_id,status,customer_name,customer_email,customer_address,items_json,total_cents,supplier_share_cents,profit_cents)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
    local_order_id, paymentIntentId, 'pending', customer.name, customer.email, JSON.stringify(customer.address||{}),
    JSON.stringify(cartItems), total, supplierTotal, profit
  );
  return local_order_id;
}

// ========================================================
app.listen(PORT, ()=>console.log(`🚀 Server running at http://localhost:${PORT}`));
