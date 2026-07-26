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
