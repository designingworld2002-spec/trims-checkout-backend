/**
 * Local micro-backend — Shopify Draft Order checkout (custom pricing).
 *
 * ⚠️ PARALLEL / EXPERIMENTAL. This is a *test* path that runs ALONGSIDE the
 *    existing storefront "₹1-hack" cart flow. It does not replace or touch it.
 *
 *   POST /api/create-draft-order
 *     body: { title, quantity, price, properties, whatsappNumber, totalDiscount }
 *            — OR multi-item: { items: [{ title, quantity, totalPrice, properties }],
 *              whatsappNumber, totalDiscount }
 *       - price / totalPrice = TOTAL price per line (server derives unit price)
 *       - totalDiscount = OPTIONAL cart-level discount in rupees; applied as an
 *         order-level fixed_amount discount on the draft order
 *       - properties = object { name: value } OR array [{ name, value }]
 *     → creates a Shopify draft order with custom line item(s) priced at
 *       (total / quantity) per unit, and returns { invoice_url }.
 *
 * Credentials come from environment variables (.env) — never hardcode a live
 * token in source.  See .env.example.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// Permissive CORS — LOCAL TESTING ONLY. Lock this down to your storefront
// origin before anything resembling this ships to production.
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN || 'YOUR_SHOPIFY_DOMAIN';
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || 'YOUR_ACCESS_TOKEN';
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-01';
const PORT = process.env.PORT || 3000;

/**
 * Normalise `properties` (an object OR an array) into Shopify's line-item
 * shape: [{ name, value }]. Blank names are dropped.
 */
function toLineItemProperties(properties) {
  if (!properties) return [];
  if (Array.isArray(properties)) {
    return properties
      .map((p) => ({
        name: String((p && (p.name != null ? p.name : p.key)) || '').trim(),
        value: String(p && p.value != null ? p.value : ''),
      }))
      .filter((p) => p.name);
  }
  return Object.keys(properties).map((k) => ({
    name: String(k),
    value: String(properties[k] == null ? '' : properties[k]),
  }));
}

/**
 * Build ONE Shopify custom line item from a cart item:
 *   { title, quantity, totalPrice (or legacy `price`), properties }
 *
 * - unit price = totalPrice / quantity, to 2 decimals (Shopify wants a string)
 * - properties object → [{ name, value }]
 *
 * NOTE on the property field: the REST draft_orders endpoint uses `properties`
 * ([{name,value}]). `custom_attributes` ([{key,value}]) is the GraphQL naming
 * and is IGNORED by REST — using it would silently drop every design detail
 * from the order. So we map to `properties`, which is verified to appear on
 * the created draft order.
 */
function buildLineItem(raw) {
  const title = String((raw && raw.title) || '').trim();
  const quantity = parseInt(raw && raw.quantity, 10);
  // Accept `totalPrice` (multi-item cart shape) OR `price` (legacy single item).
  const total = Number(
    raw && (raw.totalPrice != null ? raw.totalPrice : raw.price)
  );

  if (!title) throw new Error('Each item needs a non-empty `title`.');
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Each item `quantity` must be a positive number.');
  }
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error('Each item `totalPrice` must be a positive number.');
  }

  const unitPrice = (total / quantity).toFixed(2);
  return {
    total: total,
    unitPrice: unitPrice,
    lineItem: {
      title: title,
      quantity: quantity,
      price: unitPrice, // per-unit price on a custom line item
      requires_shipping: true,
      taxable: true,
      properties: toLineItemProperties(raw && raw.properties),
    },
  };
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'draft-order-backend',
    domain: SHOPIFY_DOMAIN,
    apiVersion: API_VERSION,
    configured:
      SHOPIFY_DOMAIN !== 'YOUR_SHOPIFY_DOMAIN' &&
      ACCESS_TOKEN !== 'YOUR_ACCESS_TOKEN',
  });
});

app.post('/api/create-draft-order', async (req, res) => {
  try {
    const body = req.body || {};

    if (
      SHOPIFY_DOMAIN === 'YOUR_SHOPIFY_DOMAIN' ||
      ACCESS_TOKEN === 'YOUR_ACCESS_TOKEN'
    ) {
      return res.status(500).json({
        error:
          'Server not configured. Set SHOPIFY_DOMAIN and SHOPIFY_ACCESS_TOKEN in draft-order-backend/.env',
      });
    }

    // Accept a MULTI-ITEM cart ({ items: [...] }) — the new Cart Interceptor
    // flow — OR fall back to the original SINGLE-ITEM shape
    // ({ title, quantity, price, properties }) so the existing finalize-page
    // beta button keeps working unchanged.
    const rawItems =
      Array.isArray(body.items) && body.items.length
        ? body.items
        : [
            {
              title: body.title,
              quantity: body.quantity,
              price: body.price,
              totalPrice: body.totalPrice,
              properties: body.properties,
            },
          ];

    // ── Build one Shopify line item per cart item ─────────────────────
    // Every line item keeps the TRUE customer quantity and a 2-decimal unit
    // price (total / qty) — so packing slips, factory orders and invoices show
    // the real item count. Because Shopify caps unit prices at 2 dp, the summed
    // (unitPrice × qty) can drift a little from the intended whole-rupee cart
    // total; that gap is reconciled below with one "Rounding Adjustment".
    let lineItems;
    let sum = 0;         // Σ (2-dp unitPrice × qty) — what Shopify will actually bill
    let targetTotal = 0; // Σ whole-rupee item totals — the clean total we want
    try {
      lineItems = rawItems.map(function (it) {
        const built = buildLineItem(it);
        sum += Number(built.lineItem.price) * built.lineItem.quantity;
        targetTotal += Math.round(built.total);
        return built.lineItem;
      });
    } catch (validationErr) {
      return res.status(400).json({ error: validationErr.message });
    }
    if (!lineItems.length) {
      return res.status(400).json({ error: 'No line items to create.' });
    }

    // Snap both sides to whole paise to kill binary-float noise before diffing.
    sum = Math.round(sum * 100) / 100;
    targetTotal = Math.round(targetTotal);

    // ── Rounding Adjustment ───────────────────────────────────────────
    // diff = the sub-rupee gap between the clean whole-rupee target and the
    // 2-dp line sum. A POSITIVE gap is added back as a tiny "Rounding
    // Adjustment" line item (Shopify allows positive custom lines). A NEGATIVE
    // gap can't be a line item (Shopify forbids negative prices), so it is
    // folded into the order-level discount below. Either way the reconciled
    // merchandise total lands on an exact whole rupee — zero stray paise.
    const diff = Math.round((targetTotal - sum) * 100) / 100;
    let roundingDiscount = 0;
    if (diff > 0) {
      lineItems.push({
        title: 'Rounding Adjustment',
        quantity: 1,
        price: diff.toFixed(2),
        requires_shipping: false,
        taxable: true,
        properties: [{ name: 'Note', value: 'Whole-rupee rounding' }],
      });
    } else if (diff < 0) {
      roundingDiscount = Math.abs(diff);
    }

    // ── Cart-level discount (+ any negative rounding correction) ───────
    // Draft Orders bypass the native checkout, so the storefront collects the
    // code on the Cart page and forwards the resolved amount (in rupees) as
    // `totalDiscount`. A draft order supports only ONE order-level
    // `applied_discount`, so a negative rounding gap (when it occurs) is merged
    // into the same fixed-amount discount rather than a second discount object.
    const totalDiscount = Number(req.body.totalDiscount);
    const cartDiscount =
      Number.isFinite(totalDiscount) && totalDiscount > 0 ? totalDiscount : 0;

    let appliedDiscount;
    const orderDiscount = Math.round((cartDiscount + roundingDiscount) * 100) / 100;
    if (orderDiscount > 0) {
      let description;
      if (cartDiscount > 0 && roundingDiscount > 0) {
        description = 'Cart Discount + Rounding Adjustment';
      } else if (cartDiscount > 0) {
        description = 'Cart Discount';
      } else {
        description = 'Rounding Adjustment';
      }
      appliedDiscount = {
        description: description,
        value_type: 'fixed_amount',
        value: orderDiscount.toFixed(2),
      };
    }

    const noteParts = [];
    if (body.whatsappNumber) noteParts.push('WhatsApp: ' + body.whatsappNumber);

    const draftPayload = {
      draft_order: {
        line_items: lineItems,
        applied_discount: appliedDiscount || undefined,
        note: noteParts.join(' | ') || undefined,
        tags: 'draft-order-api-test',
      },
    };

    const url =
      'https://' +
      SHOPIFY_DOMAIN +
      '/admin/api/' +
      API_VERSION +
      '/draft_orders.json';

    const shopifyRes = await axios.post(url, draftPayload, {
      headers: {
        'X-Shopify-Access-Token': ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    });

    const draft = shopifyRes.data && shopifyRes.data.draft_order;
    if (!draft || !draft.invoice_url) {
      return res
        .status(502)
        .json({ error: 'Shopify did not return an invoice_url.', raw: shopifyRes.data });
    }

    return res.json({
      ok: true,
      invoice_url: draft.invoice_url, // direct checkout link for the frontend
      draft_order_id: draft.id,
      line_item_count: lineItems.length,
      order_total: targetTotal,                 // clean whole-rupee cart total
      rounding_adjustment: diff,                // +ve → line item · -ve → discount · 0
      cart_discount: cartDiscount,              // forwarded cart-level discount
      applied_discount: appliedDiscount ? Number(appliedDiscount.value) : 0,
      shopify_subtotal: draft.subtotal_price,   // Shopify's computed subtotal
      shopify_total: draft.total_price,         // subtotal − discount + any tax
    });
  } catch (err) {
    const status = (err.response && err.response.status) || 500;
    const detail = (err.response && err.response.data) || { message: err.message };
    console.error(
      '[create-draft-order] failed:',
      status,
      JSON.stringify(detail).slice(0, 500)
    );
    // Surface auth errors verbatim; everything else is a bad-gateway to Shopify.
    const outStatus = status === 401 || status === 403 ? status : 502;
    return res.status(outStatus).json({
      error: 'Failed to create draft order.',
      shopify_status: status,
      detail: detail,
    });
  }
});

app.listen(PORT, () => {
  console.log('▶ draft-order-backend on http://localhost:' + PORT);
  console.log('  Shopify:', SHOPIFY_DOMAIN, '| Admin API', API_VERSION);
  if (
    SHOPIFY_DOMAIN === 'YOUR_SHOPIFY_DOMAIN' ||
    ACCESS_TOKEN === 'YOUR_ACCESS_TOKEN'
  ) {
    console.log('  ⚠ Not configured yet — edit .env (SHOPIFY_DOMAIN, SHOPIFY_ACCESS_TOKEN).');
  }
});
module.exports = app;