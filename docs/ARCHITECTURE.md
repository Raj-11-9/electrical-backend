# SRV Electricals commerce architecture

Desktop contains three independent packages: electrical-frontend (Next.js port 3000), electrical-backend (NestJS port 4000), electrical-admin-panel (Next.js port 3001). Only the backend accesses PostgreSQL. Both interfaces use the same REST API. Phase 1 is a working storefront foundation, not a completed production commerce system.

## Implemented
- Responsive original homepage, accessible navigation, category dropdown, mobile menu, source catalogue search, category browsing, price/newest sorting and pagination, all required customer routes and admin route shells.
- Reusable shadcn-style Button with Radix Slot, Tailwind 4, Lucide, Framer Motion reduced-motion support.
- Public /api/catalogue, /api/home and /api/categories expose allowlisted store data. Admins can sign in with backend-configured credentials and create product groups and published products through authenticated endpoints. The admin app stores the short-lived session in an HTTP-only cookie.
- PostgreSQL Prisma schema, initial migration, category/settings seed and sibling-folder Docker Compose.
- SRV branding and the public catalogue are imported at the user’s request. Read docs/SRV-IMPORT.md for provenance, scripts and limits. Product cards and details use source product imagery and source specification tables.

## Phase gates
2: source catalogue import, product details, variant selection, basic search, collection filters, price sorting and pagination are implemented. Extended specification/stock filters and full administrative catalogue editing remain pending.
3: Argon2 password hashing, JWT refresh rotation, HTTP-only secure cookies, role guards, guest tokens, cart calculation, checkout validation and inventory transactions.
4: transactional order + notification outbox; email and official WhatsApp template workers; success pages and quotations.
5: Remaining authenticated admin CRUD, content editing, dealer approval and per-dealer pricing, inventory, reports and exports. Product and product-group creation are implemented.
6: Razorpay server-side verification, webhook deduplication, payments, operational tests, HTTPS, backups and launch review.

Each later phase must be implemented and tested before claiming it complete. Admin sign-in and product/product-group creation are implemented. Customer JWT sessions, payments, messaging and remaining admin management are not implemented in Phase 1. Configure ADMIN_EMAIL and ADMIN_PASSWORD alongside a strong JWT_SECRET in the backend environment before using the admin forms. No secrets are used by either frontend. Do not expose wholesalePrice from public APIs (public /api/home must select public fields only).

## Order transaction design (pending implementation)
Use SERIALIZABLE with bounded retries; lock inventory rows in consistent ID order, validate approved dealer/MOQ, calculate Decimal line totals and GST on server, allocate inventory, write immutable customer/address/line snapshots and three notification outbox entries in one transaction. An idempotency key binds to a request hash and returns the same result. Unique order numbers never depend on count(). Confirm tax-inclusive/exclusive policy before implementation.

## Reliability (pending implementation)
Workers claim rows using FOR UPDATE SKIP LOCKED with lease timeout, exponential backoff, bounded attempts and dead-letter review. Unique dedupe keys prevent duplicate enqueueing; provider network timeouts may still require reconciliation. Notifications never roll back committed orders. Store delivery attempts without access tokens. WhatsApp requires configured official templates and permission; wa.me is user-sent only.

Payments use HMAC verification against raw webhook bytes, provider event IDs, amount/currency/order verification and an atomic state transition. Frontend responses never mark an order paid. Manual UPI remains pending until an audited staff verification.

## Security and operations before launch
Implement CSRF protection for cookie-authenticated writes, JWT roles and approved-dealer guards, per-route throttles, DTO validation, redacted structured logs, CSP, allowlisted image/PDF uploads with MIME/size checks, Cloudinary signed server uploads, audit logs and order ownership checks. Do not put SMTP or payment secrets in SiteSettings. Run HTTPS behind a reverse proxy; keep PostgreSQL private. Add scheduled pg_dump, encryption, retention and restore drills. Configure verified business identity, contact details and approved policies. Docker is a local development foundation; no production deployment is claimed.

## Reference analysis
Reviewed https://srvelectricals.com/ and /collections/modular-box and /collections/mcb-distribution-box. Category/range navigation, variants, best sellers and featured ranges inform the information architecture. No checkout transaction was submitted; checkout was not fully verified. The original layout now uses SRV’s logo, public product data, source testimonials and company/policy content as explicitly requested by the user. No stock quantities, GST rates, wholesale prices or missing technical specifications are inferred.
