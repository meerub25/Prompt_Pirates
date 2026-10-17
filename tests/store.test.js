const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateTotals,
  createReceiptPayload,
  createReceiptSignature,
  formatPkr,
  generateReceiptPdf,
  processGateway,
  validateCheckout
} = require('../backend/store/checkout');

function checkoutRequest() {
  return {
    order_id: 'ord-1',
    customer_id: 'cust-1',
    items: [{ variant_id: 'var-1', quantity: 1 }],
    discount_code: null,
    payment: { token: 'tok_success' }
  };
}

test('validates checkout identifiers, quantities, unique variants, and payment token', () => {
  const valid = validateCheckout(checkoutRequest());
  assert.deepEqual(valid.fields, []);
  assert.deepEqual(valid.request.items, [{ variant_id: 'var-1', quantity: 1 }]);

  const invalid = checkoutRequest();
  invalid.order_id = 'bad|id';
  invalid.items = [
    { variant_id: 'var-1', quantity: 11 },
    { variant_id: 'var-1', quantity: 1 }
  ];
  invalid.payment.token = null;
  const result = validateCheckout(invalid);
  assert.ok(result.fields.includes('order_id'));
  assert.ok(result.fields.includes('items.0.quantity'));
  assert.ok(result.fields.includes('items.1.variant_id'));
  assert.ok(result.fields.includes('payment.token'));
});

test('calculates minor-unit totals and floors the WELCOME10 discount', () => {
  const items = [
    { variant_id: 'var-a', quantity: 1, unit_price_minor: 450001 },
    { variant_id: 'var-b', quantity: 2, unit_price_minor: 100 }
  ];
  assert.deepEqual(calculateTotals(items, 'WELCOME10'), {
    subtotal_minor: 450201,
    discount_minor: 45020,
    total_minor: 405181
  });
  assert.deepEqual(calculateTotals(items, null), {
    subtotal_minor: 450201,
    discount_minor: 0,
    total_minor: 450201
  });
  assert.equal(formatPkr(450000), 'PKR 4500.00');
});

test('models gateway success, decline, capture failure, and unknown-token decline', () => {
  assert.deepEqual(processGateway('tok_success', 7), {
    succeeded: true,
    payment: {
      authorization_id: 'auth_7',
      capture_id: 'cap_7',
      state: 'captured'
    }
  });
  assert.deepEqual(processGateway('tok_declined', null), {
    succeeded: false,
    errorCode: 'PAYMENT_DECLINED'
  });
  assert.deepEqual(processGateway('tok_capture_fail', 8), {
    succeeded: false,
    errorCode: 'PAYMENT_CAPTURE_FAILED',
    authorizationVoided: true
  });
  assert.equal(processGateway('unexpected', null).errorCode, 'PAYMENT_DECLINED');
});

test('signs the exact receipt payload returned to the caller', () => {
  const originalSalt = process.env.DAY1_SALT;
  process.env.DAY1_SALT = 'demo-salt';
  try {
    const request = checkoutRequest();
    const items = [{ variant_id: 'var-1', quantity: 1, unit_price_minor: 450000 }];
    const payload = createReceiptPayload(
      request,
      items,
      { subtotal_minor: 450000, discount_minor: 0, total_minor: 450000 },
      '2026-10-17T11:20:05Z'
    );
    assert.equal(
      createReceiptSignature(request.order_id, payload),
      'c5ee41c7ac5a01bfacffc0f67a614089c8ce587093b62e73e523e878720da04b'
    );
    assert.deepEqual(Object.keys(payload), [
      'order_id',
      'customer_id',
      'items',
      'subtotal_minor',
      'discount_minor',
      'total_minor',
      'currency',
      'paid_at'
    ]);
  } finally {
    if (originalSalt === undefined) delete process.env.DAY1_SALT;
    else process.env.DAY1_SALT = originalSalt;
  }
});

test('generates a valid uncompressed PDF receipt containing the order and total text', async () => {
  const payload = {
    order_id: 'ord-pdf',
    customer_id: 'cust-pdf',
    items: [{ variant_id: 'var-1', quantity: 1, unit_price_minor: 450000 }],
    subtotal_minor: 450000,
    discount_minor: 0,
    total_minor: 450000,
    currency: 'PKR',
    paid_at: '2026-10-17T11:20:05Z'
  };
  const pdf = await generateReceiptPdf(payload);
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  const text = pdf.toString('latin1');
  assert.ok(text.includes(Buffer.from('ord-pdf').toString('hex')));
  assert.ok(text.includes(Buffer.from('PKR 4500.00').toString('hex')));
});
