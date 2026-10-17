const PDFDocument = require('pdfkit');
const { sign } = require('../sign');

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

class CheckoutError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function validateCheckout(input) {
  const fields = [];
  const add = field => fields.push(field);

  if (!isObject(input)) return { fields: ['body'] };
  if (!validId(input.order_id)) add('order_id');
  if (!validId(input.customer_id)) add('customer_id');

  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 10) {
    add('items');
  } else {
    const variantIds = new Set();
    input.items.forEach((item, index) => {
      if (!isObject(item)) {
        add(`items.${index}`);
        return;
      }
      if (!validId(item.variant_id)) add(`items.${index}.variant_id`);
      else if (variantIds.has(item.variant_id)) add(`items.${index}.variant_id`);
      else variantIds.add(item.variant_id);
      if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 10) {
        add(`items.${index}.quantity`);
      }
    });
  }

  if (!Object.hasOwn(input, 'discount_code') ||
      (input.discount_code !== null && typeof input.discount_code !== 'string')) {
    add('discount_code');
  }

  if (!isObject(input.payment) || typeof input.payment.token !== 'string') {
    add('payment.token');
  }

  if (fields.length > 0) return { fields: [...new Set(fields)] };

  return {
    fields: [],
    request: {
      order_id: input.order_id,
      customer_id: input.customer_id,
      items: input.items.map(item => ({
        variant_id: item.variant_id,
        quantity: item.quantity
      })),
      discount_code: input.discount_code,
      payment: { token: input.payment.token }
    }
  };
}

function calculateTotals(items, discountCode) {
  const subtotalMinor = items.reduce(
    (subtotal, item) => subtotal + item.quantity * item.unit_price_minor,
    0
  );
  const discountMinor = discountCode === 'WELCOME10'
    ? Math.floor(subtotalMinor * 10 / 100)
    : 0;
  return {
    subtotal_minor: subtotalMinor,
    discount_minor: discountMinor,
    total_minor: subtotalMinor - discountMinor
  };
}

function processGateway(token, paymentNumber) {
  if (token === 'tok_success') {
    return {
      succeeded: true,
      payment: {
        authorization_id: `auth_${paymentNumber}`,
        capture_id: `cap_${paymentNumber}`,
        state: 'captured'
      }
    };
  }
  if (token === 'tok_capture_fail') {
    return { succeeded: false, errorCode: 'PAYMENT_CAPTURE_FAILED', authorizationVoided: true };
  }
  return { succeeded: false, errorCode: 'PAYMENT_DECLINED' };
}

function formatPkr(minorUnits) {
  const whole = Math.floor(minorUnits / 100);
  const fraction = String(minorUnits % 100).padStart(2, '0');
  return `PKR ${whole}.${fraction}`;
}

function createReceiptPayload(request, items, totals, paidAt) {
  return {
    order_id: request.order_id,
    customer_id: request.customer_id,
    items,
    subtotal_minor: totals.subtotal_minor,
    discount_minor: totals.discount_minor,
    total_minor: totals.total_minor,
    currency: 'PKR',
    paid_at: paidAt
  };
}

function createReceiptSignature(orderId, payload) {
  return sign(orderId, payload);
}

function generateReceiptPdf(payload) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ compress: false });
    const chunks = [];
    document.on('data', chunk => chunks.push(chunk));
    document.on('error', reject);
    document.on('end', () => resolve(Buffer.concat(chunks)));

    document.fontSize(18).text('NaSCon Merchandise Receipt');
    document.moveDown();
    document.fontSize(12).text(`Order ID: ${payload.order_id}`);
    document.text(`Customer ID: ${payload.customer_id}`);
    document.moveDown();
    for (const item of payload.items) {
      document.text(
        `${item.variant_id} x ${item.quantity} - ${formatPkr(item.quantity * item.unit_price_minor)}`
      );
    }
    document.moveDown();
    document.text(`Subtotal: ${formatPkr(payload.subtotal_minor)}`);
    document.text(`Discount: ${formatPkr(payload.discount_minor)}`);
    document.fontSize(14).text(`Total: ${formatPkr(payload.total_minor)}`);
    document.end();
  });
}

function createCheckoutError(status, code, message, details = {}) {
  return new CheckoutError(status, code, message, details);
}

module.exports = {
  CheckoutError,
  calculateTotals,
  createCheckoutError,
  createReceiptPayload,
  createReceiptSignature,
  formatPkr,
  generateReceiptPdf,
  processGateway,
  validateCheckout
};
