# SRV Electricals commerce

Three sibling folders on Desktop share one NestJS backend and PostgreSQL database.

## Docker setup (PowerShell)
Start Docker Desktop with Linux containers first.

    cd "$env:USERPROFILE/OneDrive/Desktop/electrical-backend"
    Copy-Item .env.example .env

Set POSTGRES_PASSWORD in .env (URL-safe for the local connection string), replace JWT_SECRET, and keep secrets out of version control. For local testing the provided password can be retained. DATABASE_URL for host commands must use the same password.

    docker compose up --build -d
    docker compose logs migrate
    docker compose ps

Open http://localhost:3000 (store), http://localhost:3001 (admin panel), http://localhost:4000/api/health (API). The one-shot migrate service applies migrations and idempotently seeds categories/settings before backend startup. No production credentials are seeded. The user-requested public SRV catalogue is imported into PostgreSQL by the seed step.

To enable product and product-category creation, set `ADMIN_EMAIL` and a private `ADMIN_PASSWORD` (at least 12 characters) in the backend `.env`, and set a strong `JWT_SECRET` (at least 32 characters). Restart the backend after changing environment values. Sign in from the Add product or Add product category form in the admin panel. Product saves publish the listing immediately, create a standard variant, and record the entered initial stock; tax and wholesale pricing remain unset.

## Native development
Run npm ci in each folder. Backend: copy .env.example to .env; start PostgreSQL via docker compose up -d db; run npm run prisma:generate, npm run db:migrate, npm run db:seed, then npm run dev. In separate terminals run npm run dev in frontend and admin-panel. Both default to the same API at localhost:4000/api. Copy .env.example to .env.local in each Next.js folder if overriding it.

## Checks
Backend: npm run prisma:generate; npx prisma validate; npm run build; npm test.
Frontend and admin: npm run typecheck; npm run build.
Database runtime check: docker compose up --build -d, then GET /api/health, /api/categories, /api/home. The storefront uses the captured SRV catalogue and falls back to a dated snapshot if the API is unavailable.

## Backups
Before live operations, schedule encrypted PostgreSQL dumps, set retention and test restoration to a separate database. Example inside container: pg_dump -U electrical -d electrical -Fc -f /tmp/electrical.dump; copy using docker compose cp db:/tmp/electrical.dump ./backups/electrical.dump. Backup scheduling and production hardening are Phase 6 work.

See docs/ARCHITECTURE.md, docs/SRV-IMPORT.md and docs/COMMERCE.md for scope, checkout configuration and operational gates. COD is enabled with GST-inclusive pricing and ₹50 shipping; Razorpay requires backend-only credentials. Orders remain blocked for variants without approved GST rates and confirmed stock. Do not treat this as a production-ready commerce deployment until the remaining operational gates are addressed.

## SRV source data

112 products, 312 variants, 30 collections and 260 product image references are captured. See docs/SRV-IMPORT.md for refresh/import commands. No live stock quantities or GST rates are inferred.

Current verification includes the backend commerce/payment suite, frontend tests and typecheck, and a successful storefront production build. See docs/COMMERCE.md for the payment-specific test scope and remaining test-mode/live blockers. Native builds omit standalone copying; Docker builds enable it.
