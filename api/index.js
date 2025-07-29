const mongoose = require('mongoose');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const serverless = require('serverless-http');
require('dotenv').config();

const Order = require('../model/order');
const Fills = require('../model/fills');

const app = express();

// DB Connection (Singleton pattern for Vercel)
let isConnected = false;
async function connectDB() {
  if (!isConnected) {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    isConnected = true;
    console.log('MongoDB connected');
  }
}

app.use(cors());
app.use(express.json());


// Root health‑check route
app.get('/', (req, res) => {
  console.log('🏓 received GET /');
  res.json({ ok: true, message: 'pong' });
});

app.get('/healthz', (req, res) => {
  console.log('🏓 healthz ping');
  res.send('OK');
});

//Orders API

//Get Cross Chain Swap Active Orders
app.get('/fusion-plus/orders/v1.0/order/active', async (req, res) => {
  console.log('🏓 received GET /fusion-plus/orders/v1.0/order/active');
  // Fetch from DB all orders with status 'active'
  console.log('⏳ Trying DB connect…');
  try {
    await connectDB();
    console.log('✅ DB connect successful');
  } catch (err) {
    console.error('❌ DB connect failed', err);
    return res.status(500).send('DB error');
  }
  console.log('🔗 Mongo connected');
  try {
    const orders = await Order.find({ status: 'ACTIVE' }).populate('fillIds');
    res.json(orders);
  } catch (err) {
    console.error('❌ Error in handler:', err);
    res.status(500).json({ error: err.message });
  }
});


app.post('/relayer/v1.0/submit', async (req, res) => {
  // Create a new order
  await connectDB(); // Ensure DB connection
  const newOrder = new Order(req.body);
  console.log('Received new order:', newOrder);
  newOrder.save().then(doc => {
    console.log('Dummy active order saved:', doc);
  })
    .catch(err => {
      console.error('Failed to save dummy order:', err);
    });

  res.status(200).json(newOrder);
});

//Create a list of orders
app.post('/relayer/v1.0/submit/many', async (req, res) => {
  // Create multiple orders from the request <body>
  await connectDB(); // Ensure DB connection
  const ordersData = req.body.orders; // Expecting an array of order objects
  if (!Array.isArray(ordersData) || ordersData.length === 0) {
    return res.status(400).json({ error: 'Invalid orders data' });
  }
  try {
    const orders = await Order.insertMany(ordersData);
    console.log('Orders created:', orders);
    res.status(201).json(orders);
  } catch (err) {
    console.error('Error creating orders:', err);
    res.status(500).json({ error: 'Failed to create orders' });
  }
});


// 6884f0220fac7bda096dae2b

// Create a fill for an order
app.post('/relayer/v1.0/submit/secret', async (req, res) => {
  await connectDB(); // Ensure DB connection
  const orderId = req.params.orderId;
  const fillData = req.body; // Assuming fill data is sent in the request body
  fillData.orderId = orderId; // Associate fill with the order
  const newFill = new Fills(fillData);
  try {
    const savedFill = await newFill.save();
    // Update the order with the new fill ID
    await Order.findByIdAndUpdate(orderId, { $push: { fillIds: savedFill._id } });
    res.status(201).json(savedFill);
  } catch (err) {
    console.error('Error creating fill:', err);
    res.status(500).json({ error: 'Failed to create fill' });
  }
});

// Get Actual Escrow Factory Contract Address
app.get('/fusion-plus/orders/v1.0/order/escrow', (req, res) => {

  res.json({ contractAddress: process.env.TEZOS_ESCROW_FACTORY_ADDRESS });
});

// Get Orders by Maker Address
app.get('/fusion-plus/orders/v1.0/order/maker/:makerAddress', async (req, res) => {
  console.log('Fetching orders for maker address:', req.params.makerAddress);
  try {
    await connectDB(); // Ensure DB connection
    const orders = await Order.find({
      makerDestinationChainAddress: req.params.makerAddress
    }).populate('fillIds');
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Get All Data to Perform Withdrawal and Cancellation
app.get('/tezos/orders/:orderId/withdrawal-cancellation-data', async (req, res) => {
  // Collate all necessary information for withdrawal/cancellation.
  await connectDB(); // Ensure DB connection
  try {
    const order = await Order.findById(req.params.orderId).populate('fillIds');
    if (!order) return res.status(404).json({ error: 'Order not found' });
    // Include related (Fills) info as needed for withdrawal/cancellation logic
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Secret (Fill) Submission Indexes for an Order
app.get('/tezos/orders/:orderId/secrets-ready', async (req, res) => {
  // check which secrets are revealed and which are pending for order
  await connectDB(); // Ensure DB connection
  try {
    const fills = await Fills.find({ orderId: req.params.orderId });
    res.json(fills.map(f => ({
      id: f._id, status: f.status, hash: f.hash
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get All Orders with Fills Ready for Submission (status: PLACED/OPEN)
app.get('/tezos/orders/secrets-ready', async (req, res) => {
  // Get all orders with secrets ready for submission
  await connectDB(); // Ensure DB connection
  try {
    const fills = await Fills.find({ status: { $in: ['OPEN', 'PLACED'] } });
    // Optionally, include their orders:
    // const orders = await Order.find({ _id: { $in: fills.map(f => f.orderId) } });
    res.json(fills);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Get idx of each secret that is ready for submission for all orders
app.get('/v1.0/order/ready-to-accept-secret-fills/:orderHash', async (req, res) => {
  await connectDB(); // Ensure DB connection
  try {
    const order = await Order.findOne({ orderHash: req.params.orderHash }).populate({
      path: 'fillIds',
      match: { status: { $in: ['PLACED', 'VALID'] } }
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    res.json(order.fillIds); // Only ready fills
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});


// GET /v1.0/order/status/:orderHash
app.get('/v1.0/order/status/:orderHash', async (req, res) => {
  await connectDB(); // Ensure DB connection
  try {
    const order = await Order.findOne({ orderHash: req.params.orderHash });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    res.json({ status: order.status });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /v1.0/order/status
app.post('/v1.0/order/status', async (req, res) => {
  await connectDB(); // Ensure DB connection
  try {
    const hashes = req.body.orderHashes; // Expect array of hashes
    const statuses = await Order.find({ orderHash: { $in: hashes } }, { orderHash: 1, status: 1 });
    res.json(statuses);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

//Quoter API

//Get quote details based on input data
app.get('/v1.0/quote/receive', async (req, res) => {
  await connectDB(); // Ensure DB connection
  try {
    const {
      srcChain, dstChain,
      srcTokenAddress, dstTokenAddress,
      amount, walletAddress,
      enableEstimate = 'false',
      fee = '0', isPermit2, permit
    } = req.query;

    // Validate required
    if (!srcChain || !dstChain || !srcTokenAddress || !dstTokenAddress || !amount || !walletAddress) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const feeBps = parseInt(fee);
    const toQty = simulateReceiveAmount(amount, feeBps);

    const response = {
      srcChain: Number(srcChain),
      dstChain: Number(dstChain),
      srcTokenAddress,
      dstTokenAddress,
      amount,
      walletAddress,
      feeBps,
      toQty: toQty.toString()
    };

    if (enableEstimate === 'true') {
      const quoteId = crypto.createHash('sha256')
        .update(JSON.stringify({ srcChain, dstChain, srcTokenAddress, dstTokenAddress, amount, walletAddress, fee, date: Date.now() }))
        .digest('hex');
      response.quoteId = quoteId;
      response.estimatedAt = Date.now();
    }

    // include optional permit/permit2 fields if provided
    if (isPermit2) response.isPermit2 = isPermit2;
    if (permit) response.permit = permit;

    res.json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});


function simulateToQty(amount, feeBps) {
  const netFactor = BigInt(10_000 - feeBps);
  return (BigInt(amount) * netFactor) / 10_000n;
}

function generateQuoteId(params) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(params) + Date.now()).digest('hex');
}

app.post('/v1.0/quote/receive', async (req, res) => {
  await connectDB(); // Ensure DB connection
  const body = req.body;
  if (!(body.srcChain && body.dstChain && body.srcTokenAddress && body.dstTokenAddress && body.amount && body.walletAddress)) {
    return res.status(400).json({ error: 'Missing required field(s)' });
  }

  const feeBps = parseInt(body.fee || '0');
  const toQty = simulateToQty(body.amount, feeBps);

  const response = {
    srcChain: Number(body.srcChain),
    dstChain: Number(body.dstChain),
    srcTokenAddress: body.srcTokenAddress,
    dstTokenAddress: body.dstTokenAddress,
    amount: body.amount,
    walletAddress: body.walletAddress,
    feeBps,
    toQty: toQty.toString()
  };

  if (body.enableEstimate) {
    response.quoteId = generateQuoteId(body);
    response.estimatedAt = new Date().toISOString();
  }

  if (body.isPermit2) response.isPermit2 = body.isPermit2;
  if (body.permit) response.permit = body.permit;

  res.json(response);
});


app.post('/v1.0/quote/build', async (req, res) => {
  await connectDB(); // Ensure DB connection
  const body = req.body;
  if (!(body.srcChain && body.dstChain && body.srcTokenAddress && body.dstTokenAddress && body.amount && body.walletAddress)) {
    return res.status(400).json({ error: 'Missing required field(s)' });
  }

  const feeBps = parseInt(body.fee || '0');
  const toQty = simulateToQty(body.amount, feeBps);
  const quoteId = generateQuoteId(body);

  res.json({
    quoteId,
    srcChain: Number(body.srcChain),
    dstChain: Number(body.dstChain),
    srcTokenAddress: body.srcTokenAddress,
    dstTokenAddress: body.dstTokenAddress,
    amount: body.amount,
    walletAddress: body.walletAddress,
    feeBps,
    toQty: toQty.toString(),
    auctionPreset: {
      startAmount: body.priceStart || body.amount,
      minReturn: body.priceEnd || toQty.toString(),
      expirationTime: body.expiration || Date.now() + 600_000
    }
  });
});

// Start the server
module.exports = serverless(app);