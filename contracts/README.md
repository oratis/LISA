# LISA API contracts

`lisa-api-v1.openapi.json` is the language-neutral source for the external REST
and SSE protocol shared by the TypeScript server, web clients, and Lisa Pocket.

Version 1 deliberately preserves the existing JSON response bodies. Every
`/api/*`, `/chat`, and `/events` response advertises
`X-Lisa-API-Version: 1`. Compatibility rules are:

- no version header: accept as a legacy v1 server;
- same major: accept additive fields and unknown SSE event types;
- higher major: require a client upgrade;
- breaking field/type/meaning changes require a new major or a versioned route.

Run `npm run generate:api-contract` after changing the OpenAPI major or header.
CI runs `npm run check:api-contract` to ensure the generated TypeScript and
Swift constants were committed. `src/web/api-contract.test.ts` validates the
actual server DTO builders and representative endpoint/event fixtures against
the OpenAPI schemas.

The initial schema covers the cross-client orchestration spine and shared error
shape. Add endpoints to v1 as they gain contract tests; do not claim an
undocumented route is stable merely because it happens to return JSON.

## Errors

`lisa-error-codes.json` is the table of error codes. Every non-2xx response
on `/api/*`, `/chat` and `/events` is JSON:

```json
{ "error": "quota_exhausted", "message": "You've used your free allowance for now. …", "resetAt": 1763000000000 }
```

- `error` is a stable snake_case code. A route with no specific code uses
  the generic code for its status (`fallbackByStatus`, e.g. `not_found`).
- `message` is one sentence for the person using the app. Don't parse it.
- Route-specific fields such as `reason`, `retryAfterSec`, `resetAt`, `tier`
  and `ok: false` sit next to them.
- A chat turn that fails mid-stream sends
  `{"type":"error","code":"provider_error","message":"…"}`. LISA Cloud never
  forwards the model provider's raw error.

The generator writes the table to `src/web/error-codes.generated.ts` and to
the Swift `enum LisaErrorCode: String` in
`packaging/ios-companion/Sources/APIContract.generated.swift`. Clients map
codes they don't know to `.unknown` and fall back to the status and message.
Adding a code is additive; renaming or removing one is a breaking change.

## Account sessions

A Bearer client whose account session is past half its lifetime gets a fresh
one in the `x-lisa-session` response header; store it in place of the old
one. `POST /api/auth/refresh` mints one on demand, `GET /api/auth/me` reports
`sessionExpiresAt`, `POST /api/auth/logout` revokes only the presented session
and `POST /api/auth/logout-all` revokes every session of the account.
