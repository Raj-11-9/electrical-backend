> Commerce update: see [COMMERCE.md](COMMERCE.md). The account/cart/checkout/tracking implementation described there supersedes the earlier feature status below. Production activation still requires approved catalogue and payment settings.

# Backend and shared connection verification — 30 October 2026

The catalogue backend and the connections from both interfaces passed the checks below. The complete commerce application is not yet production ready.

## Verified

- Backend TypeScript build; frontend and admin production builds.
- 5 backend unit tests and 9 frontend unit tests.
- 8 isolated API checks: explicit read-only status, unavailable database health (503), catalogue completeness/provenance, categories/home, CORS allow/reject, unauthenticated admin-write rejection, rate limiting, and security headers.
- 16 isolated SQL/storage integration checks using PGlite (a PostgreSQL-compatible engine) with the actual Prisma PostgreSQL driver: all migrations, full import, idempotence, unknown inventory/tax preservation, SQL constraints, transaction rollback, admin authentication and persisted product/category writes, production interfaces reading shared database data, filesystem reopen, and test-engine backup restoration.
- Imported catalogue: 112 products, 312 variants, 260 image references and 30 source collections. Source availability is not a confirmed inventory quantity.
- 139 HTTP route checks passed (112 product pages, customer routes, admin routes and a genuine unknown-page 404). Browser verified compact SKU search in both interfaces and mobile admin navigation without horizontal overflow; no console errors in the checked admin session.
- Compose configuration validation with the installed official Docker Compose plugin.
- Backend production dependency audit: zero reported vulnerabilities at verification time.

## Docker limitation

The Docker client is installed, but this agent cannot access the Windows Docker engine named pipe (permission denied). Container builds, actual PostgreSQL 17 container startup, named-volume persistence and pg_dump/pg_restore have NOT been executed. SQL compatibility checks above are independent tests, not Docker verification.

Run from a normal PowerShell terminal with Docker Desktop running:

```powershell
cd "$env:USERPROFILE/OneDrive/Desktop/electrical-backend"
.\scripts\verify-docker.ps1
```

The script creates an isolated Compose project on ports 13000, 13001, 14000 and 15432; builds the stack; checks shared connections and named volumes; replaces containers without deleting volumes; backs up PostgreSQL and restores to a separate test database. Reports are in backend/work/srv-verify-*. It stops its own containers by default and retains volumes. It never deletes normal application volumes.

## Current local running mode

Storefront: http://127.0.0.1:3000
Admin catalogue: http://127.0.0.1:3001
API status: http://127.0.0.1:4000/api/status

The normal local backend may run in read-only catalogue snapshot mode when PostgreSQL is unavailable. Product and product-group creation require a connected database and valid ADMIN_EMAIL, ADMIN_PASSWORD and JWT_SECRET backend configuration.

## Start and test

After npm ci in each folder, generate Prisma and build all three applications. Copy each .env.example to .env and configure the required values. Never publish real secrets.

```powershell
# Backend
npm run prisma:generate
npm run build
npm test
npm run test:api
# Requires production builds of both Next.js apps:
npm run test:storage
# Starts production Next.js servers, explicit preview backend:
.\scripts\start-local.ps1
# For development Next.js servers:
.\scripts\start-local.ps1 -Development
# For an already migrated/seeded PostgreSQL DATABASE_URL:
.\scripts\start-local.ps1 -UseDatabase
# Full Docker stack, after setting POSTGRES_PASSWORD in .env:
docker compose up --build -d
```

Both interfaces use API_URL. In Docker this is http://backend:4000/api; native local mode uses http://127.0.0.1:4000/api. The public API allowlists fields and excludes restricted dealer pricing and private settings. Data is served from the imported catalogue snapshot record in PostgreSQL; future product CRUD must keep that projection synchronized or replace it with relational queries.

## Not implemented / cannot be marked passed

Customer JWT/password authentication and RBAC, remaining writable admin CRUD, real carts/checkout/orders, inventory reservation services, approved dealer pricing, coupons, Razorpay verification/webhooks, automatic SMTP/WhatsApp delivery queues/retries, Cloudinary uploads, shipping updates, production HTTPS and scheduled database backups remain future work. Schema models and environment placeholders do not constitute functioning integrations. Public enquiry forms only prepare explicit WhatsApp/email drafts; users must send them themselves. No external messages or payments were sent.

Before accepting real orders, implement these workflows, test authorization and concurrency, configure service credentials, run the Docker verification and establish production backup/restore monitoring.
