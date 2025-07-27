const mongoose = require('mongoose');

const FillsSchema = new mongoose.Schema({
  hash: String,
  status: { type: String, enum: ['OPEN','PLACED', 'VALID', 'INVALID', 'COMPLETED', 'REFUNDED'], required: true },
  secret: String, // CAUTION: Don't expose this in APIs!
  srcEscrowDeployContractHash: String,
  dstEscrowDeployContractHash: String,
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  takerSourceChainAddress: String,
  takerDestChainAddress: String,
  safetyDeposit: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Fills', FillsSchema);
