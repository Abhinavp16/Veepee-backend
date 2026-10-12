const mongoose = require('mongoose');

const deletionEventSchema = new mongoose.Schema({
  action: {
    type: String,
    enum: ['requested', 'cancelled', 'in_review', 'rejected', 'completed'],
    required: true,
  },
  byUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  note: {
    type: String,
    default: null,
    maxlength: 1000,
  },
  at: {
    type: Date,
    default: Date.now,
  },
}, { _id: false });

const accountDeletionRequestSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  source: {
    type: String,
    enum: ['app', 'website'],
    required: true,
  },
  status: {
    type: String,
    enum: ['pending', 'in_review', 'completed', 'rejected', 'cancelled'],
    default: 'pending',
    index: true,
  },
  requestedAt: {
    type: Date,
    default: Date.now,
  },
  dueAt: {
    type: Date,
    required: true,
    index: true,
  },
  completedAt: {
    type: Date,
    default: null,
  },
  processedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  identityVerification: {
    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    method: { type: String, default: null, maxlength: 100 },
  },
  staffNote: {
    type: String,
    default: null,
    maxlength: 1000,
  },
  // When admins were reminded that this request is due soon / overdue.
  reminders: {
    dueSoonAt: { type: Date, default: null },
    overdueAt: { type: Date, default: null },
  },
  events: [deletionEventSchema],
}, {
  timestamps: true,
});

accountDeletionRequestSchema.index({ status: 1, dueAt: 1 });
accountDeletionRequestSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('AccountDeletionRequest', accountDeletionRequestSchema);
