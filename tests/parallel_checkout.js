const assert = require('node:assert/strict');

const baseUrl = process.env.API_BASE_URL || 'http://localhost:8080';
const variantId = 'var-jersey-001-M';

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function main() {
  const reset = await post('/audit/v1/reset', {
    stock: { [variantId]: 1 }
  });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      post('/audit/v1/checkout', {
        order_id: `parallel-${index}`,
        customer_id: `customer-${index}`,
        items: [{ variant_id: variantId, quantity: 1 }],
        discount_code: null,
        payment: { token: 'tok_success' }
      })
    )
  );

  assert.equal(results.filter(result => result.status === 201).length, 1);
  const conflicts = results.filter(result => result.status === 409);
  assert.equal(conflicts.length, 19);
  assert.ok(conflicts.every(result => result.body.error.code === 'OUT_OF_STOCK'));
  for (const result of results) {
    assert.ok([201, 409].includes(result.status), JSON.stringify(result));
  }

  const inventoryResponse = await fetch(`${baseUrl}/audit/v1/inventory/${variantId}`);
  assert.equal(inventoryResponse.status, 200);
  const inventory = await inventoryResponse.json();
  assert.deepEqual(inventory, { variant_id: variantId, stock: 0, reserved: 0 });
  console.log('20-way checkout: one 201, nineteen OUT_OF_STOCK, stock 0, reserved 0');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
