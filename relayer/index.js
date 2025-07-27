const express = require('express');
const Order = require('./model/order'); // Adjust the path as necessary
const Fills = require('./model/fills'); // Adjust the path as necessary
// const { MongoClient } = require('mongodb');
const app = express();
const port = 3000;
// const uri = 'mongodb://localhost:27017'; // Update with your MongoDB connection string

const mongoose = require('mongoose');
mongoose.connect('mongodb+srv://ananyabarticles:WGVkRBCGmSEhSvnc@relayerinfo.klkh4rx.mongodb.net/', {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
  .then(() => console.log('MongoDB connected!'))
  .catch(err => console.error('MongoDB connection error:', err));
// const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });
app.use(express.json());

app.get('/', async (req, res) => {
  res.json({ status: 'success', message: 'Hello!' });
});


//Orders API

//Get Cross Chain Swap Active Orders
app.get('/fusion-plus/orders/v1.0/order/active', async (req, res) => {
  // Fetch from DB all orders with status 'active'
  try {
    const orders = await Order.find({ status: 'ACTIVE' }).populate('fillIds');
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.post('/tezos/orders/create', async (req, res) => {
  // Create a new order
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

// 6884f0220fac7bda096dae2b

// Create a fill for an order
app.post('/tezos/orders/:orderId/fills/create', async (req, res) => {
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
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});