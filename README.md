# drop.cv backend

Fastify API for authentication, CV/site uploads, previews, deployment, analytics, subscriptions, and ZarinPal payments.

## Local setup

1. Copy `.env.example` to `.env.local` and replace every placeholder.
2. Start PostgreSQL, Redis, and MinIO with `docker compose up -d`.
3. Run `npm install`, `npm run migrate`, and `npm start`.
4. Verify with `npm run test:health`, `npm run test:auth`, and `npm run test:revenue`.

Docker Compose can run the complete stack with `npm run dev:docker` after `.env.docker` is configured.

## Production requirements

Configure `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`, all `MINIO_*` values, `FRONTEND_URL`, `TRUSTED_FRONTEND_ORIGINS`, `BACKEND_URL`, `PUBLIC_SITE_URL_TEMPLATE`, and `PUBLIC_SITE_PATH_PREFIX` in Vercel. `ANTHROPIC_API_KEY` (or `SITE_GENERATION_API_KEY`) is optional; without it CV generation uses the deterministic fallback. Payments require `ZARINPAL_MERCHANT_ID`; payment actions remain disabled while it is empty, and `ZARINPAL_SANDBOX=false` must only be used for the real gateway. Verified email changes and lifecycle notifications require the optional `SMTP_*` values.

Apply migrations before deploying application code. Migrations are recorded in `schema_migrations` and run transactionally through `npm run migrate`.

Never commit `.env`, `.env.local`, Vercel pull files, database URLs, merchant IDs, storage keys, JWT secrets, or SMTP credentials.
