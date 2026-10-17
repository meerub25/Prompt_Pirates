const express = require('express');
const { canonical } = require('../sign');
const { pool } = require('../db');
const { fail } = require('../util');
const {
  calculateTotals,
  CheckoutError,
  createReceiptPayload,
  createReceiptSignature,
  generateReceiptPdf,
  processGateway,
  validateCheckout
} = require('../store/checkout');

const router = express.Router();

function respondError(res, error) {
  return fail(res, error.status, error.code, error.message, error.details);
}

function variantNotFound(variantId) {
  return new CheckoutError(
    404,
    'VARIANT_NOT_FOUND',
    `Variant ${variantId} does not exist.`,
    { variant_id: variantId }
  );
}

router.post('/checkout', async (req, res, next) => {
  const validation = validateCheckout(req.body);
  if (validation.fields.length > 0) {
    return fail(
      res,
      400,
      'VALIDATION_ERROR',
      'Checkout request is invalid.',
      { fields: validation.fields }
    );
  }

  const request = validation.request;
  let client;
  let transactionOpen = false;
  let committedResponse = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionOpen = true;

    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`order:${request.order_id}`]
    );

    const existing = await client.query(
      'SELECT request, response FROM orders WHERE order_id = $1',
      [request.order_id]
    );
    if (existing.rowCount > 0) {
      if (canonical(existing.rows[0].request) !== canonical(request)) {
        throw new CheckoutError(
          409,
          'DUPLICATE_ORDER_ID',
          'Order id was already used with a different request.'
        );
      }
      await client.query('COMMIT');
      transactionOpen = false;
      return res.status(200).json(existing.rows[0].response);
    }

    const variantIds = request.items.map(item => item.variant_id);
    const variantResult = await client.query(
      `SELECT variant_id, price_minor, stock, reserved
       FROM variants
       WHERE variant_id = ANY($1::text[])
       ORDER BY variant_id
       FOR UPDATE`,
      [variantIds]
    );
    const variants = new Map(variantResult.rows.map(row => [row.variant_id, row]));
    for (const item of request.items) {
      if (!variants.has(item.variant_id)) throw variantNotFound(item.variant_id);
    }

    if (request.discount_code !== null && request.discount_code !== 'WELCOME10') {
      throw new CheckoutError(
        400,
        'INVALID_DISCOUNT_CODE',
        'The discount code is not valid.',
        { discount_code: request.discount_code }
      );
    }

    const items = request.items.map(item => {
      const variant = variants.get(item.variant_id);
      return {
        variant_id: item.variant_id,
        quantity: item.quantity,
        unit_price_minor: variant.price_minor
      };
    });
    const totals = calculateTotals(items, request.discount_code);

    for (const item of request.items) {
      if (variants.get(item.variant_id).stock < item.quantity) {
        throw new CheckoutError(
          409,
          'OUT_OF_STOCK',
          `Variant ${item.variant_id} has no stock left.`,
          { variant_id: item.variant_id }
        );
      }
    }

    for (const item of request.items) {
      const reservation = await client.query(
        `UPDATE variants
         SET stock = stock - $1, reserved = reserved + $1
         WHERE variant_id = $2 AND stock >= $1
         RETURNING variant_id`,
        [item.quantity, item.variant_id]
      );
      if (reservation.rowCount === 0) {
        throw new CheckoutError(
          409,
          'OUT_OF_STOCK',
          `Variant ${item.variant_id} has no stock left.`,
          { variant_id: item.variant_id }
        );
      }
    }

    const token = request.payment.token;
    let paymentNumber = null;
    if (token === 'tok_success' || token === 'tok_capture_fail') {
      const sequenceResult = await client.query(
        "SELECT nextval('payment_id_seq')::int AS payment_number"
      );
      paymentNumber = sequenceResult.rows[0].payment_number;
    }
    const gateway = processGateway(token, paymentNumber);
    if (!gateway.succeeded) {
      for (const item of request.items) {
        await client.query(
          `UPDATE variants
           SET stock = stock + $1, reserved = reserved - $1
           WHERE variant_id = $2`,
          [item.quantity, item.variant_id]
        );
      }
      await client.query('COMMIT');
      transactionOpen = false;
      const message = gateway.errorCode === 'PAYMENT_DECLINED'
        ? 'Payment authorization was declined.'
        : 'Payment capture failed; the authorization was voided.';
      return fail(res, 402, gateway.errorCode, message);
    }

    const paidAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const receiptPayload = createReceiptPayload(request, items, totals, paidAt);
    const receiptSignature = createReceiptSignature(request.order_id, receiptPayload);
    const pdf = await generateReceiptPdf(receiptPayload);
    const response = {
      order_id: request.order_id,
      status: 'paid',
      currency: 'PKR',
      items,
      subtotal_minor: totals.subtotal_minor,
      discount_minor: totals.discount_minor,
      total_minor: totals.total_minor,
      payment: gateway.payment,
      receipt: {
        payload: receiptPayload,
        signature: receiptSignature,
        pdf_base64: pdf.toString('base64')
      }
    };

    await client.query(
      `INSERT INTO orders (order_id, customer_id, request, response, status)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, 'paid')`,
      [request.order_id, request.customer_id, JSON.stringify(request), JSON.stringify(response)]
    );
    for (const item of items) {
      await client.query(
        `INSERT INTO order_items (order_id, variant_id, quantity, unit_price_minor)
         VALUES ($1, $2, $3, $4)`,
        [request.order_id, item.variant_id, item.quantity, item.unit_price_minor]
      );
      await client.query(
        'UPDATE variants SET reserved = reserved - $1 WHERE variant_id = $2',
        [item.quantity, item.variant_id]
      );
    }

    await client.query('COMMIT');
    transactionOpen = false;
    committedResponse = response;
  } catch (error) {
    if (client && transactionOpen) {
      await client.query('ROLLBACK');
      transactionOpen = false;
    }
    if (error instanceof CheckoutError) return respondError(res, error);
    return next(error);
  } finally {
    if (client) client.release();
  }

  try {
    await pool.query(
      `INSERT INTO domain_events (event_type, aggregate_id, payload)
       VALUES ($1, $2, $3::jsonb)`,
      [
        'order.paid',
        request.order_id,
        JSON.stringify({
          order_id: request.order_id,
          customer_id: request.customer_id,
          total_minor: committedResponse.total_minor,
          currency: 'PKR'
        })
      ]
    );
  } catch (error) {
    console.error('Failed to emit order.paid domain event:', error);
  }

  return res.status(201).json(committedResponse);
});

router.get('/inventory/:variant_id', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT variant_id, stock, reserved FROM variants WHERE variant_id = $1',
      [req.params.variant_id]
    );
    if (result.rowCount === 0) {
      return fail(
        res,
        404,
        'VARIANT_NOT_FOUND',
        `Variant ${req.params.variant_id} does not exist.`,
        { variant_id: req.params.variant_id }
      );
    }
    const variant = result.rows[0];
    return res.json({
      variant_id: variant.variant_id,
      stock: variant.stock,
      reserved: variant.reserved
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
