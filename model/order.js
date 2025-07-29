// models/order.js
const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema({
  status: { type: String, enum: [
        'ACTIVE', 'PARTIAL_DEPOSITED', 'COMPLETE_DEPOSITED', 'PARTIAL_CANCELLED', 'CANCELLED', 'REFUNDED', 'COMPLETED'
  ], required: true },
  makerDestinationChainAddress: String,
  makerSourceChainAddress: String,
  srcChain: String,
  destinationChain: String,
  fillIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Fills' }],
  timelock: Number,
  hashlock: String,
  srcTokenAddress: String,
  dstTokenAddress: String,
  srcQty: String,
  dstQty: String,
  orderHash: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Order', OrderSchema);
