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
    // Map each incoming item straight through: the TRUE customer quantity and a
    // 2-decimal unit price (total / qty), courtesy of buildLineItem(). NO
    // rounding reconciliation and NO "Rounding Adjustment" line — Shopify
    // computes the subtotal natively from these raw lines, even if that leaves
    // sub-rupee decimals.
    let lineItems;
    let subtotal = 0;   // merchandise total (sum of line totals) — drives shipping
    let pincode = '';   // buyer's delivery pincode (repeated on every line item)
    try {
      lineItems = rawItems.map(function (it) {
        const built = buildLineItem(it);
        subtotal += built.total;
        // Pincode is a cart-wide value present on each item — grab the first.
        if (!pincode) {
          const p = it.properties && it.properties['Delivery Pincode'];
          if (p) pincode = String(p).trim();
        }
        return built.lineItem;
      });
    } catch (validationErr) {
      return res.status(400).json({ error: validationErr.message });
    }
    if (!lineItems.length) {
      return res.status(400).json({ error: 'No line items to create.' });
    }

    // ── Cart-level discount ───────────────────────────────────────────
    // Draft Orders bypass the native checkout, so the storefront collects the
    // code on the Cart page and forwards the resolved amount (in rupees) as
    // `totalDiscount`. Re-apply it here as a single order-level fixed-amount
    // discount.
    const totalDiscount = Number(req.body.totalDiscount);
    const cartDiscount =
      Number.isFinite(totalDiscount) && totalDiscount > 0 ? totalDiscount : 0;

    let appliedDiscount;
    if (cartDiscount > 0) {
      appliedDiscount = {
        description: 'Cart Discount',
        value_type: 'fixed_amount',
        value: cartDiscount.toFixed(2),
      };
    }

    // ── Shipping by delivery pincode ──────────────────────────────────
    // The storefront collects the buyer's pincode on the Finalize page and
    // forwards it on every line item. Classify it into a zone and bill a
    // percentage of the merchandise subtotal. Default (incl. empty/unknown) is
    // PAN India (6%); Delhi NCR (2.5%) and Northern India (4%) are cheaper.
    let shippingRate = 0.06;
    let shippingZone = 'PAN India';
    if (/^(110|121|122|2013|2010)/.test(pincode)) {
      shippingRate = 0.025;
      shippingZone = 'Delhi NCR';
    } else if (/^(12|13|14|15|16|17|18|19|2[0-8]|3[0-4])/.test(pincode)) {
      shippingRate = 0.04;
      shippingZone = 'Northern India';
    }
    const shippingAmount = subtotal * shippingRate;

    const noteParts = [];
    if (body.whatsappNumber) noteParts.push('WhatsApp: ' + body.whatsappNumber);
    // Anti-cheat: the pincode entered on the Finalize page only ESTIMATES
    // shipping — flag it so staff verify it against the real address.
    if (pincode) {
      noteParts.push(
        'Customer entered Pincode on Finalize Page: ' + pincode +
        '. Please verify this matches the final shipping address.'
      );
    }

    const draftPayload = {
      draft_order: {
        line_items: lineItems,
        applied_discount: appliedDiscount || undefined,
        shipping_line: {
          title: 'Shipping (' + shippingZone + ')',
          price: shippingAmount.toFixed(2),
        },
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
      cart_discount: cartDiscount,              // forwarded cart-level discount
      applied_discount: appliedDiscount ? Number(appliedDiscount.value) : 0,
      pincode: pincode || null,                 // buyer-entered delivery pincode
      shipping_zone: shippingZone,              // resolved shipping zone
      shipping_amount: Number(shippingAmount.toFixed(2)), // charged shipping
      shopify_subtotal: draft.subtotal_price,   // Shopify's natively-computed subtotal
      shopify_total: draft.total_price,         // subtotal − discount + shipping + tax
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