const mongoose = require('mongoose');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const serverless = require('serverless-http');
require('dotenv').config();

const { TezosToolkit } = require('@taquito/taquito');
const { InMemorySigner } = require('@taquito/signer');

const Order = require('../model/order');
const Fills = require('../model/fills');

const app = express();

const tezos = new TezosToolkit('https://rpc.ghostnet.teztnets.com');

// DB Connection 
let isConnected = false;
async function connectDBAndTezos() {
  console.log('⏳ Trying DB connect…');
  if (!isConnected) {

    try {
      await mongoose.connect(process.env.MONGODB_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true
      });
      console.log('✅ DB connect successful');
    } catch (err) {
      console.error('❌ DB connect failed', err);
      return res.status(500).send('DB error');
    }
    isConnected = true;
    console.log('🔗 Mongo connected');
  }
  console.log('⏳ Trying to set provider…');
  tezos.setProvider({ signer: new InMemorySigner(process.env.IN_MEMORY_PRIVATE_KEY) });


}

app.use(cors());
app.use(express.json());


// Root health‑check routes
app.get('/', (req, res) => {
  console.log('🏓 received GET /');
  res.json({ ok: true, message: 'pong' });
});

app.get('/health-check', (req, res) => {
  res.json({ healthy: true, message: 'API is healthy' });
});



//Orders API

//Get Cross Chain Swap Active Orders

app.get('/fusion-plus/orders/v1.0/order/active', async (req, res) => {
  await connectDBAndTezos();
  const { srcChain, dstChain } = req.query;
  if (!srcChain || !dstChain) {
    return res.status(400).json({ error: 'srcChain and dstChain are required' });
  }
  try {
    const orders = await Order.find({
      srcChain: srcChain,
      destinationChain: dstChain,
      status: 'ACTIVE'
    }).populate('fillIds');
    res.json(orders);
  } catch (err) {
    console.error('❌ Error in handler:', err);
    res.status(500).json({ error: err.message });
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
    await connectDBAndTezos(); // Ensure DB connection
    // Build dynamic filter based on query params
    const filter = {
      makerSourceChainAddress: req.params.makerAddress
    };

    // Optional filters
    if (req.query.timestampFrom || req.query.timestampTo) {
      filter.createdAt = {};
      if (req.query.timestampFrom) {
        filter.createdAt.$gte = new Date(Number(req.query.timestampFrom));
      }
      if (req.query.timestampTo) {
        filter.createdAt.$lt = new Date(Number(req.query.timestampTo));
      }
    }
    if (req.query.srcToken) {
      filter.srcTokenAddress = req.query.srcToken;
    }
    if (req.query.dstToken) {
      filter.dstTokenAddress = req.query.dstToken;
    }
    if (req.query.withToken) {
      filter.$or = [
        { srcTokenAddress: req.query.withToken },
        { dstTokenAddress: req.query.withToken }
      ];
    }
    if (req.query.dstChainId) {
      filter.destinationChain = Number(req.query.dstChainId);
    }
    if (req.query.srcChainId) {
      filter.srcChain = Number(req.query.srcChainId);
    }

    const orders = await Order.find(filter).populate('fillIds');
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get All Data to Perform Withdrawal and Cancellation
app.get('/fusion-plus/orders/v1.0/order/secrets/:orderHash', async (req, res) => {
  // Collate all necessary information for withdrawal/cancellation.
  await connectDBAndTezos(); // Ensure DB connection
  try {
    const order = await Order.findOne({ orderHash: req.params.orderHash }).populate('fillIds');
    if (!order) return res.status(404).json({ error: 'Order not found' });
    // Include related (Fills) info as needed for withdrawal/cancellation logic
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get idx of each secret that is ready for submission for all orders
app.get('/fusion-plus/orders/v1.0/order/ready-to-accept-secret-fills/:orderHash', async (req, res) => {
  await connectDBAndTezos(); // Ensure DB connection
  try {
    const order = await Order.findOne({ orderHash: req.params.orderHash, status: { $in: ['ACTIVE', 'PARTIAL_DEPOSITED', 'COMPLETE_DEPOSITED'] } }).populate({
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
app.get('/fusion-plus/orders/v1.0/order/status/:orderId', async (req, res) => {
  await connectDBAndTezos(); // Ensure DB connection
  try {
    const order = await Order.findById(req.params.orderId).populate('fillIds');
    if (!order) return res.status(404).json({ error: 'Order not found' });

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /v1.0/order/status
app.post('/fusion-plus/orders/v1.0/order/status', async (req, res) => {
  await connectDBAndTezos(); // Ensure DB connection
  try {
    const hashes = req.body.orderHashes; // Expect array of hashes
    const statuses = await Order.find({ orderHash: { $in: hashes } });
    res.json(statuses);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});




// Get Secret (Fill) Submission Indexes for an Order
app.get('/tezos/orders/:orderId/secrets-ready', async (req, res) => {
  // check which secrets are revealed and which are pending for order
  await connectDBAndTezos(); // Ensure DB connection
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
  await connectDBAndTezos(); // Ensure DB connection
  try {
    const fills = await Fills.find({ status: { $in: ['OPEN', 'PLACED'] } });
    // Optionally, include their orders:
    // const orders = await Order.find({ _id: { $in: fills.map(f => f.orderId) } });
    res.json(fills);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});







//Quoter API

//Get quote details based on input data
app.get('/fusion-plus/quoter/v1.0/quote/receive', async (req, res) => {
  await connectDBAndTezos(); // Ensure DB connection
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

app.post('/fusion-plus/quoter/v1.0/quote/receive', async (req, res) => {
  await connectDBAndTezos(); // Ensure DB connection
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


app.post('/fusion-plus/quoter/v1.0/quote/build', async (req, res) => {
  await connectDBAndTezos(); // Ensure DB connection
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


//Relayer Endpoints

app.post('/fusion-plus/relayer/v1.0/submit', async (req, res) => {
  // Create a new order
  await connectDBAndTezos(); // Ensure DB connection
  const newOrder = new Order(req.body);
  let orderObject = {};
  console.log('Received new order:', newOrder);
  await newOrder.save().then(doc => {
    console.log('Dummy active order saved:', doc);
    orderObject = doc.toObject();
  })
    .catch(err => {
      console.error('Failed to save dummy order:', err);
    });

  console.log('Calling Dutch Auction contract to create auction…');

  const contract = await tezos.contract.at(
    process.env.DUTCH_AUCTION_CONTRACT_ADDRESS
  );

  // Build times as JS Date objects
  const now = new Date();
  const start_time = new Date(now.getTime() + 1000 * 60); // Add 1 minute to current time
  const end_time = new Date(start_time.getTime() + 1000 * 60 * (req.body.time));

  // Convert to hex
  const auctionIdHex = Buffer
    .from(orderObject._id.toString())
    .toString('hex');

  const required_taker_toke_per_maker = (req.body.dstQty) / req.body.srcQty;  //8
  // Use ISO strings for timestamps
  const args = [
    `0x${auctionIdHex}`,     // bytes
    1000,                    // base_gas_price
    Math.floor(required_taker_toke_per_maker * 0.98 * 1e6),       // end_price (integer)
    end_time.toISOString(),   // end_time (Date)
    500,                    // gas_adjustment_factor
    req.body.srcQty * 1e6,                  // maker_amount
    Math.floor(required_taker_toke_per_maker * 1.05 * 1e6),   // start_price (integer)
    start_time.toISOString()      // start_time (Date)
  ];

  // And now send!
  const op = await contract.methods
    .create_auction(...args)
    .send();
  await op.confirmation();
  console.log('✔️ Operation hash:', op.opHash);


  res.status(200).json(newOrder);
});

//Create a list of orders
app.post('/fusion-plus/relayer/v1.0/submit/many', async (req, res) => {
  // Create multiple orders from the request <body>
  await connectDBAndTezos(); // Ensure DB connection
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

// Create a fill for an order
app.post('/fusion-plus/relayer/v1.0/submit/secret', async (req, res) => {
  await connectDBAndTezos(); // Ensure DB connection
  const fillData = req.body; // Assuming fill data is sent in the request body
  const orderId = fillData.orderId; // Associate fill with the order
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

// Start the server
module.exports = async (req, res) => {
  await connectDBAndTezos();
  return app(req, res);
};