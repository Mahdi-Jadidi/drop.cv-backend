const { randomInt } = require('node:crypto');

// The public annual price is displayed separately. Card-transfer payments use
// this base plus a private three-digit marker so the bank statement identifies
// the account without asking the customer to type an identifier.
const CARD_TRANSFER_BASE_AMOUNT = 700000;
const PAYMENT_CODE_MIN = 100;
const PAYMENT_CODE_MAX = 999;
const MANUAL_PAYMENT_VALIDITY_MS = 3 * 60 * 60 * 1000;

function createPaymentCode() {
  return randomInt(PAYMENT_CODE_MIN, PAYMENT_CODE_MAX + 1);
}

function paymentAmountForCode(code) {
  const numericCode = Number(code);
  if (!Number.isInteger(numericCode) || numericCode < PAYMENT_CODE_MIN || numericCode > PAYMENT_CODE_MAX) {
    throw new Error('Payment code must be a three-digit number');
  }
  return CARD_TRANSFER_BASE_AMOUNT + numericCode;
}

function paymentExpiresAt(createdAt) {
  return new Date(new Date(createdAt).getTime() + MANUAL_PAYMENT_VALIDITY_MS).toISOString();
}

module.exports = {
  CARD_TRANSFER_BASE_AMOUNT,
  PAYMENT_CODE_MIN,
  PAYMENT_CODE_MAX,
  MANUAL_PAYMENT_VALIDITY_MS,
  createPaymentCode,
  paymentAmountForCode,
  paymentExpiresAt,
};
