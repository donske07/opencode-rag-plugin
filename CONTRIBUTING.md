# Contributing

## Setup

1. Install Node.js 22 or newer and Docker.
2. Run `npm ci`.
3. Start pgvector with `docker compose up -d`.
4. Copy `.env.example` to `.env` and adjust local paths.

## Validation

Run the complete local quality gate before opening a pull request:

```bash
npm run check
npm test
npm run build
```

Database integration tests run when `RAG_TEST_POSTGRES_URL` is set.

Do not commit model weights, credentials, indexed content, generated build output, or dependency directories.
