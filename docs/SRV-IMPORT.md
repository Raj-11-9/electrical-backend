# SRV Electricals source import

The user requested SRV Electricals' logo and website data on 29 October 2026. The three Desktop applications now use SRV branding. Public catalogue data was retrieved from https://srvelectricals.com/ using its public Shopify endpoints and public company pages.

## Captured

- 112 products and 312 variants, with published supplier SKUs, prices, options and availability flags.
- 260 product-image references to the source Shopify CDN. The source logo is saved locally in both Next.js public folders.
- 30 collections and their explicit product membership, including best sellers and featured products.
- Six company/contact/policy pages, four source-site testimonials and public business contact details.
- Original product JSON and normalized descriptions, specification tables, source URLs, source hash and capture timestamp.

## Commands

From electrical-backend, with PostgreSQL running and DATABASE_URL configured:

    npm ci
    npm run prisma:generate
    npm run db:migrate
    npm run catalogue:import

For the Docker stack, the existing migrate service now runs seed + catalogue import automatically:

    docker compose up --build -d

To refresh public source data later, then import it explicitly:

    npm run catalogue:sync
    npm run catalogue:import

The sync script expects sibling electrical-frontend and electrical-admin-panel folders. FRONTEND_DIR and ADMIN_DIR may override those paths. It updates catalogue files, category navigation and local logo files. Rebuild Next.js after refreshing the snapshot. The import command updates source-mapped fields and source homepage settings; review it before rerunning after later admin edits.

## Storage and provenance

The PostgreSQL import is transactional and idempotent by source IDs. It populates Product, ProductVariant, ProductImage, ProductSpecification, Category, SiteSettings, CatalogueSnapshot and CatalogueImport. The backend's /api/catalogue endpoint reads the shared persisted snapshot. The storefront uses this endpoint when available, with the dated source snapshot as an explicitly labelled offline fallback.

Supplier SKUs are not globally unique and some variants lack them. Internal keys use SRV-P-<source product ID> and SRV-V-<source variant ID>; the exact supplier SKU remains in sourceSku and is what the storefront displays. Four products without public collection membership remain uncategorised rather than receiving guessed classifications.

GST rates, exact inventory quantities, wholesale prices, MOQ and missing MRP values are not invented. Missing GST, MOQ and MRP are nullable. Availability is stored separately from Inventory; the import creates no inventory counts. Imported products can be browsed, but checkout remains disabled until order validation, tax, inventory and payments are implemented.

Source specification tables are stored without reinterpreting ambiguous multi-variant columns. Source-site certification statements and testimonials are preserved as source content; they are not newly verified certifications or new customer reviews.

## HTML and images

Imported renderable HTML uses a restricted tag/attribute allowlist. Scripts, forms, event handlers and executable URLs are stripped. Product images retain their original source CDN URLs; no Cloudinary upload or invented Cloudinary identifier is claimed. Two malformed contact href values in the source were normalized to the business phone/email published in its footer.

## Verification limit

Docker's PostgreSQL engine is unavailable on this machine. Migration generation, schema validation, importer type checks and unit tests are verified, but no live PostgreSQL import is claimed. Import idempotency and unknown-value preservation are unit-tested with a transaction test double. Real database execution remains pending Docker startup.
