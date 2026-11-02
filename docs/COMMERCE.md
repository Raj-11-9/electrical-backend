# Checkout, accounts and order tracking — 30 October 2026

Implemented in the shared NestJS backend and storefront:

- Product Buy Now (selected variant and quantity) and Add to Cart.
- Browser-persistent cart with quantity updates, removal and catalogue-based display prices. Cart data is untrusted; no customer-supplied price is used to create an order.
- PostgreSQL customer accounts with bcrypt password hashing and scoped, expiring JWTs. The storefront keeps the session in a SameSite HttpOnly cookie through a same-origin API proxy. Guest orders are never assigned to an account merely because email addresses match.
- Guest or signed-in checkout. The backend loads actual ProductVariant prices and GST, checks confirmed inventory, reserves stock and saves Order/OrderItem/Payment in one serializable transaction. Unique request keys prevent duplicate orders and reservations. Customer order history is restricted by user ID.
- Order tracking requires the order number and a private, signed tracking code. Only non-address order status, item and shipment information is returned. Save that code after guest checkout; it expires after 90 days.
- Razorpay Orders API integration, checkout script, server-side signature verification and captured-payment lookup with amount/currency/order checks. The public webhook validates the signature against raw request bytes. Repeated captured callbacks update the same payment; they do not create orders or reserve stock again.

## Checkout configuration

Normal PostgreSQL is reachable. A private random JWT secret was generated locally because the previous value was a placeholder. It is not included in source archives.

Listed catalogue prices are GST-inclusive. The backend quote derives the GST component from each product's configured GST rate and charges ₹50 shipping per order. COD is enabled. The quote only enables Razorpay when all three backend credentials are configured. The imported catalogue does not contain approved GST rates or confirmed stock counts. Do not invent these. Supply business-approved values in Product.gstRate and Inventory.quantity/reserved for each sellable variant; variants without both are rejected at checkout.

Backend .env must also contain:

```dotenv
CHECKOUT_TAX_MODE=INCLUSIVE
CHECKOUT_SHIPPING_PAISE=5000
ENABLE_COD=true
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
```

Shipping is integer paise; 5000 means INR 50. Razorpay remains unavailable until its key ID, key secret, and webhook secret are configured.

Configure Razorpay in test mode first. Set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET` privately in the backend's ignored `.env` file or the deployment's secret manager. Never put these values in frontend environment variables, source control, logs, screenshots, or support messages. In the Razorpay dashboard, enable automatic payment capture and register the publicly reachable HTTPS webhook for `payment.captured`:

`https://YOUR-BACKEND/api/commerce/payments/webhook`

The frontend receives only the public `RAZORPAY_KEY_ID`; the key secret and webhook secret remain backend-only. Keep HTTPS enabled for production. Webhook and checkout callbacks are separate paths; the backend verifies the checkout signature and then checks Razorpay's payment record for captured status, amount, currency, and order. The webhook signature is verified against the raw request body. No real payment was made during verification.

## Verification

`npm run test:commerce` in backend runs isolated SQL/Prisma integration checks and mock-provider payment checks. It uses disposable, clearly labelled QA products and stock in PGlite; it does not seed fake stock or orders into the real database. Checks cover authentication, authorization, quotes, order persistence, idempotency, reservation rollback, guest orders, private tracking and forged/unavailable payment rejection. These tests do not contact Razorpay or verify test/live credentials.

Frontend typecheck, all 11 frontend tests, and a production build pass. Browser verification confirmed the storefront quote and COD order flow against the isolated backend, and that both payment choices can be selected when the quote advertises them. Razorpay UI availability is credential-gated; no real Razorpay payment was made.

## Remaining operational work

Live Razorpay test-mode end-to-end validation requires credentials. Writable admin order/shipment management, payment reconciliation/retry tooling for abandoned online payments, inventory reservation expiration/cancellation, notification delivery workers, email verification/password recovery and production monitoring remain additional work. Until those are completed and the approved catalogue configured, do not treat this as a production-ready commerce deployment. Existing admin order screens remain read-only placeholders; database models alone do not implement management workflows.

Run backend with `npm run dev` and storefront with `npm run dev` in their separate folders; avoid starting a second copy on an occupied port. Restart backend after editing .env.
