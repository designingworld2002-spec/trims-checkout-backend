/**
 * Local micro-backend — Shopify Draft Order checkout (custom pricing).
 *
 * ⚠️ PARALLEL / EXPERIMENTAL. This is a *test* path that runs ALONGSIDE the
 *    existing storefront "₹1-hack" cart flow. It does not replace or touch it.
 *
 *   POST /api/create-draft-order
 *     body: { title, quantity, price, properties, variant_id, whatsappNumber, totalDiscount }
 *            — OR multi-item: { items: [{ title, quantity, totalPrice, properties, variant_id }],
 *              whatsappNumber, totalDiscount }
 *       - price / totalPrice = TOTAL price per line (server derives unit price)
 *       - variant_id        = the REAL catalog ProductVariant id (numeric or gid).
 *         When present, the draft-order line is LINKED to that catalog product
 *         so Shopify applies its collection tax override (GST 5% vs 18%) and
 *         shows the real product image at checkout — the whole point of this
 *         migration. Its catalog price is overridden with our exact price via
 *         `priceOverride`.
 *       - totalDiscount = OPTIONAL cart-level discount in rupees; applied as an
 *         order-level fixed_amount discount on the draft order
 *       - properties = object { name: value } OR array [{ name, value }]
 *     → creates a Shopify draft order (GraphQL `draftOrderCreate`) with the
 *       custom line item(s) and returns { invoice_url }.
 *
 * WHY GraphQL (not REST): the REST Draft Orders endpoint only accepts a
 * `variant_id` on a line item if you let Shopify use the catalog price — the
 * moment you pass a custom `price`, REST turns the line into a *custom* item
 * with NO product link, so every Product/Collection tax override is bypassed
 * and the order falls back to the default 18% GST. GraphQL's
 * `DraftOrderLineItemInput` solves this: `variantId` + `priceOverride` keep
 * the catalog link (correct tax + image) AND our exact price simultaneously.
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
const PORT = process.env.PORT || 3000;

// Presentment + money currency. India store → INR. Set
// SHOPIFY_PRESENTMENT_CURRENCY='' to OMIT presentmentCurrencyCode entirely
// (do this only if Shopify rejects it because INR isn't an enabled
// presentment currency for the shop).
const CURRENCY = process.env.SHOPIFY_CURRENCY || 'INR';
const PRESENTMENT_CURRENCY =
  process.env.SHOPIFY_PRESENTMENT_CURRENCY != null
    ? process.env.SHOPIFY_PRESENTMENT_CURRENCY.trim()
    : 'INR';

// ── Admin GraphQL API version ────────────────────────────────────────────
// `priceOverride` on DraftOrderLineItemInput needs a recent version. We
// respect SHOPIFY_API_VERSION when it's new enough, but AUTO-UPGRADE a stale
// value (e.g. the old default 2024-01, which predates priceOverride) to a
// modern default so the migration can't silently fall back to the broken
// 18%-GST behaviour.
const DEFAULT_API_VERSION = '2026-04';
const MIN_API_VERSION_NUM = 2025 * 100 + 1; // 2025-01

function resolveApiVersion(envVal, fallback) {
  const v = String(envVal || '').trim();
  const m = /^(\d{4})-(\d{2})$/.exec(v);
  if (!m) return fallback;
  const num = parseInt(m[1], 10) * 100 + parseInt(m[2], 10);
  if (num < MIN_API_VERSION_NUM) return fallback; // too old for priceOverride
  return v;
}

const API_VERSION = resolveApiVersion(
  process.env.SHOPIFY_API_VERSION,
  DEFAULT_API_VERSION
);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Normalise `properties` (an object OR an array of {name,value}/{key,value})
 * into GraphQL `customAttributes`: [{ key, value }]. Blank keys AND
 * null/empty values are dropped cleanly (a literal "0" is KEPT — only
 * null / undefined / empty-string are skipped).
 */
function toCustomAttributes(properties) {
  if (!properties) return [];
  let pairs;
  if (Array.isArray(properties)) {
    pairs = properties.map((p) => ({
      key: String((p && (p.name != null ? p.name : p.key)) || '').trim(),
      value: p && p.value != null ? p.value : '',
    }));
  } else {
    pairs = Object.keys(properties).map((k) => ({
      key: String(k).trim(),
      value: properties[k],
    }));
  }
  return pairs
    .map((p) => ({ key: p.key, value: p.value == null ? '' : String(p.value) }))
    .filter((p) => p.key && p.value !== '');
}

/**
 * Extract the buyer's Delivery Pincode from an item's properties (object OR
 * array form), returning '' when absent.
 */
function pincodeFromProperties(properties) {
  if (!properties) return '';
  if (Array.isArray(properties)) {
    const hit = properties.find(
      (p) => p && (p.name === 'Delivery Pincode' || p.key === 'Delivery Pincode')
    );
    return hit && hit.value != null ? String(hit.value).trim() : '';
  }
  return properties['Delivery Pincode']
    ? String(properties['Delivery Pincode']).trim()
    : '';
}

/**
 * Normalise a variant id (numeric, numeric-string, or already a gid) into a
 * ProductVariant gid. Returns null when genuinely absent.
 */
function toVariantGid(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(s)) return s;
  const num = s.replace(/\D/g, '');
  return num ? 'gid://shopify/ProductVariant/' + num : null;
}

/**
 * Decide quantity + per-unit price so the line total is ALWAYS exact.
 *
 * - Per-unit (preferred): quantity = the real customer quantity and
 *   unitPrice = total / quantity rounded to 2 dp — used ONLY when that
 *   reconstructs the total exactly (e.g. ribbons 2 × ₹600 = ₹1,200, or any
 *   cleanly-divisible run). The real quantity shows on the checkout line.
 * - Lump-sum (exact fallback): when total/quantity doesn't divide to a clean
 *   2-dp unit price (e.g. ₹5,426.36 ÷ 2000 = 2.71318, which as 2.71 × 2000
 *   would LOSE ₹6.36), bill quantity = 1 at the full total so the customer is
 *   charged the exact amount. The true quantity stays visible in the
 *   `Actual Quantity` custom attribute. Never loses or invents a paisa.
 */
function resolveQtyAndUnit(total, quantity) {
  const t = Number(Number(total).toFixed(2));
  const q = parseInt(quantity, 10);
  if (!Number.isFinite(q) || q <= 1) {
    return { quantity: 1, unitPrice: t, strategy: 'lump-sum' };
  }
  const unit2 = Number((t / q).toFixed(2));
  if (Math.abs(unit2 * q - t) < 0.005) {
    return { quantity: q, unitPrice: unit2, strategy: 'per-unit' };
  }
  return { quantity: 1, unitPrice: t, strategy: 'lump-sum' };
}

/**
 * Build ONE GraphQL DraftOrderLineItemInput from a cart item:
 *   { title, quantity, totalPrice (or legacy `price`), properties, variant_id }
 *
 * Primary path (variant_id present): link to the catalog variant and
 * override its price. Fallback (variant_id missing): a custom line item with
 * originalUnitPriceWithCurrency — checkout never crashes, but logs a warning
 * because that line will NOT get the collection tax override.
 */
function buildLineItem(raw) {
  const title = String((raw && raw.title) || '').trim();
  const rawQty = parseInt(raw && raw.quantity, 10);
  const total = Number(
    raw && (raw.totalPrice != null ? raw.totalPrice : raw.price)
  );

  if (!Number.isFinite(rawQty) || rawQty <= 0) {
    throw new Error('Each item `quantity` must be a positive number.');
  }
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error('Each item `totalPrice` must be a positive number.');
  }

  const variantGid = toVariantGid(
    raw && (raw.variant_id != null ? raw.variant_id : raw.variantId != null ? raw.variantId : raw.id)
  );
  const { quantity, unitPrice, strategy } = resolveQtyAndUnit(total, rawQty);
  const customAttributes = toCustomAttributes(raw && raw.properties);
  const amount = unitPrice.toFixed(2);

  let lineItem;
  if (variantGid) {
    // PRIMARY — linked to the catalog variant. priceOverride overrides the
    // catalog price; we deliberately DO NOT pass originalUnitPrice* (ignored
    // alongside variantId) and DO NOT touch `taxable` (let the variant + its
    // collection tax override govern GST).
    lineItem = {
      variantId: variantGid,
      quantity: quantity,
      priceOverride: { amount: amount, currencyCode: CURRENCY },
      customAttributes: customAttributes,
    };
  } else {
    // FALLBACK — unlinked custom line. No collection tax override will apply.
    if (!title) throw new Error('A line item without a variant_id needs a non-empty `title`.');
    console.warn(
      '[create-draft-order] No variant_id for item "' + title +
        '" — falling back to a CUSTOM line item. This line will NOT get the ' +
        'collection tax override (GST may default to 18%). Ensure the cart ' +
        'interceptor forwards each item\'s variant_id.'
    );
    lineItem = {
      title: title,
      quantity: quantity,
      originalUnitPriceWithCurrency: { amount: amount, currencyCode: CURRENCY },
      taxable: true,
      requiresShipping: true,
      customAttributes: customAttributes,
    };
  }

  return { total: total, linked: !!variantGid, strategy: strategy, lineItem: lineItem };
}

const DRAFT_ORDER_MUTATION = [
  'mutation CreateDraftOrder($input: DraftOrderInput!) {',
  '  draftOrderCreate(input: $input) {',
  '    draftOrder {',
  '      id',
  '      legacyResourceId',
  '      name',
  '      invoiceUrl',
  '      subtotalPriceSet { shopMoney { amount currencyCode } }',
  '      totalTaxSet { shopMoney { amount currencyCode } }',
  '      totalPriceSet { shopMoney { amount currencyCode } }',
  // `custom` (Boolean) tells linked vs custom lines and needs only
  // read_draft_orders. We deliberately AVOID `variant`/`product` here —
  // those require the read_products scope the checkout token lacks and
  // return ACCESS_DENIED.
  '      lineItems(first: 50) {',
  '        edges { node { id title quantity custom } }',
  '      }',
  '    }',
  '    userErrors { field message }',
  '  }',
  '}',
].join('\n');

/* ------------------------------------------------------------------ */
/* Routes                                                             */
/* ------------------------------------------------------------------ */

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'draft-order-backend',
    domain: SHOPIFY_DOMAIN,
    apiVersion: API_VERSION,
    transport: 'graphql',
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

    // Accept a MULTI-ITEM cart ({ items: [...] }) — the Cart Interceptor flow
    // — OR fall back to the original SINGLE-ITEM shape so the existing
    // finalize-page beta button keeps working unchanged.
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
              variant_id: body.variant_id,
            },
          ];

    // ── Build one GraphQL line item per cart item ─────────────────────
    let lineItems;
    let subtotal = 0; // merchandise total (sum of line totals) — drives shipping
    let pincode = ''; // buyer's delivery pincode (first one wins)
    let linkedCount = 0;
    let fallbackCount = 0;
    try {
      lineItems = rawItems.map(function (it) {
        const built = buildLineItem(it);
        subtotal += built.total;
        if (built.linked) linkedCount++;
        else fallbackCount++;
        if (!pincode) pincode = pincodeFromProperties(it.properties);
        return built.lineItem;
      });
    } catch (validationErr) {
      return res.status(400).json({ error: validationErr.message });
    }
    if (!lineItems.length) {
      return res.status(400).json({ error: 'No line items to create.' });
    }

    // ── Cart-level discount ───────────────────────────────────────────
    const totalDiscount = Number(req.body.totalDiscount);
    const cartDiscount =
      Number.isFinite(totalDiscount) && totalDiscount > 0 ? totalDiscount : 0;

    let appliedDiscount;
    if (cartDiscount > 0) {
      appliedDiscount = {
        title: 'Cart Discount',
        description: 'Cart Discount',
        value: cartDiscount,
        valueType: 'FIXED_AMOUNT',
        amountWithCurrency: {
          amount: cartDiscount.toFixed(2),
          currencyCode: CURRENCY,
        },
      };
    }

    // ── Shipping by delivery pincode ──────────────────────────────────
    // Default (incl. empty/unknown) is PAN India (6%); Delhi NCR (2.5%) and
    // Northern India (4%) are cheaper. (Unchanged from the REST version.)
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

    // ── Note (anti-cheat pincode verification + WhatsApp) ─────────────
    const noteParts = [];
    if (body.whatsappNumber) noteParts.push('WhatsApp: ' + body.whatsappNumber);
    if (pincode) {
      noteParts.push(
        'Customer entered Pincode on Finalize Page: ' + pincode +
        '. Please verify this matches the final shipping address.'
      );
    }

    // ── Assemble the DraftOrderInput ──────────────────────────────────
    const input = {
      lineItems: lineItems,
      shippingLine: {
        title: 'Shipping (' + shippingZone + ')',
        priceWithCurrency: {
          amount: shippingAmount.toFixed(2),
          currencyCode: CURRENCY,
        },
      },
      tags: ['draft-order-api-test'],
    };
    if (appliedDiscount) input.appliedDiscount = appliedDiscount;
    if (noteParts.length) input.note = noteParts.join(' | ');
    if (PRESENTMENT_CURRENCY) input.presentmentCurrencyCode = PRESENTMENT_CURRENCY;

    // ── Call the Admin GraphQL API ────────────────────────────────────
    const url =
      'https://' + SHOPIFY_DOMAIN + '/admin/api/' + API_VERSION + '/graphql.json';

    const shopifyRes = await axios.post(
      url,
      { query: DRAFT_ORDER_MUTATION, variables: { input: input } },
      {
        headers: {
          'X-Shopify-Access-Token': ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );

    const payload = shopifyRes.data || {};

    // Top-level GraphQL errors (bad query, throttling, auth-scope, …).
    // Surface the actual Shopify message(s) in `error` so the cause is
    // readable client-side, while keeping the raw array in `detail`.
    if (Array.isArray(payload.errors) && payload.errors.length) {
      console.error(
        '[create-draft-order] GraphQL errors:',
        JSON.stringify(payload.errors).slice(0, 500)
      );
      const msg =
        payload.errors
          .map((e) => e && e.message)
          .filter(Boolean)
          .join('; ') || 'Unknown GraphQL error.';
      return res.status(502).json({
        error: 'Shopify GraphQL error: ' + msg,
        detail: payload.errors,
      });
    }

    const result = payload.data && payload.data.draftOrderCreate;
    const userErrors = (result && result.userErrors) || [];
    if (userErrors.length) {
      console.error(
        '[create-draft-order] userErrors:',
        JSON.stringify(userErrors).slice(0, 500)
      );
      const msg =
        userErrors
          .map((e) => e && e.message)
          .filter(Boolean)
          .join('; ') || 'Draft order rejected.';
      return res.status(400).json({
        error: 'Draft order rejected by Shopify: ' + msg,
        user_errors: userErrors,
      });
    }

    const draft = result && result.draftOrder;
    if (!draft || !draft.invoiceUrl) {
      return res
        .status(502)
        .json({ error: 'Shopify did not return an invoice_url.', raw: payload });
    }

    // Linked vs custom lines, read from the returned `custom` flag
    // (custom === false → linked to a catalog variant; true → custom
    // line). Falls back to the build-time counters if the selection
    // returned nothing.
    const liNodes = (draft.lineItems && draft.lineItems.edges
      ? draft.lineItems.edges
      : []
    )
      .map((e) => e && e.node)
      .filter(Boolean);
    const linkedFromResp = liNodes.filter((n) => n.custom === false).length;
    const fallbackFromResp = liNodes.filter((n) => n.custom === true).length;

    const subtotalAmt =
      draft.subtotalPriceSet && draft.subtotalPriceSet.shopMoney
        ? draft.subtotalPriceSet.shopMoney.amount
        : null;
    const totalAmt =
      draft.totalPriceSet && draft.totalPriceSet.shopMoney
        ? draft.totalPriceSet.shopMoney.amount
        : null;
    const taxAmt =
      draft.totalTaxSet && draft.totalTaxSet.shopMoney
        ? draft.totalTaxSet.shopMoney.amount
        : null;

    // ── Response — SAME shape the storefront interceptor already expects ──
    // (invoice_url + error are all the interceptor reads; the extra keys are
    // kept from the REST version and a few debug fields are ADDED.)
    return res.json({
      ok: true,
      invoice_url: draft.invoiceUrl,
      draft_order_id: draft.legacyResourceId
        ? Number(draft.legacyResourceId)
        : draft.id,
      draft_order_name: draft.name,
      line_item_count: lineItems.length,
      cart_discount: cartDiscount,
      applied_discount: appliedDiscount ? cartDiscount : 0,
      pincode: pincode || null,
      shipping_zone: shippingZone,
      shipping_amount: Number(shippingAmount.toFixed(2)),
      shopify_subtotal: subtotalAmt,
      shopify_total: totalAmt,
      // ── debug / observability ──
      shopify_tax: taxAmt,
      items_linked_to_variant: liNodes.length ? linkedFromResp : linkedCount,
      items_fallback_custom: liNodes.length ? fallbackFromResp : fallbackCount,
      api_version: API_VERSION,
    });
  } catch (err) {
    const status = (err.response && err.response.status) || 500;
    const detail = (err.response && err.response.data) || { message: err.message };
    console.error(
      '[create-draft-order] failed:',
      status,
      JSON.stringify(detail).slice(0, 500)
    );
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
  console.log('  Shopify:', SHOPIFY_DOMAIN, '| Admin GraphQL', API_VERSION);
  if (
    String(process.env.SHOPIFY_API_VERSION || '').trim() &&
    API_VERSION !== String(process.env.SHOPIFY_API_VERSION || '').trim()
  ) {
    console.log(
      '  ⚠ SHOPIFY_API_VERSION=' + process.env.SHOPIFY_API_VERSION +
        ' is too old for priceOverride — using ' + API_VERSION +
        ' instead. Update .env to silence this.'
    );
  }
  if (
    SHOPIFY_DOMAIN === 'YOUR_SHOPIFY_DOMAIN' ||
    ACCESS_TOKEN === 'YOUR_ACCESS_TOKEN'
  ) {
    console.log('  ⚠ Not configured yet — edit .env (SHOPIFY_DOMAIN, SHOPIFY_ACCESS_TOKEN).');
  }
});
module.exports = app;
