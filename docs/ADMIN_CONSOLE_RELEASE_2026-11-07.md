# Console production release — 2026-11-07

The console is live at https://meetlisa.ai/console. The existing verified Google
account `wangharp@gmail.com` is the protected administrator, configured through
`LISA_ADMIN_EMAILS`. Login uses the account's email verification code or an
existing password. No password was created or changed during deployment.

## Deployed artifacts

| Service | Revision receiving 100% traffic | Image tag |
| --- | --- | --- |
| Cloud | `lisa-cloud-console-1107` | `lisa-cloud:console-20261107-v3` |
| Website | `lisa-web-console-1107b` | `lisa-web:console-20261107-v2` |

Images are in `us-central1-docker.pkg.dev/oratis-491316/cloud-run-source-deploy`.
The cloud image digest is
`sha256:50a862ce89fec898eae3aa278cb5a9d30b67df63a687a8994779dc7ca7971968`.
The website image digest is
`sha256:8d6671b7d64d166b954ae1ab7c4fe7425b585b2bae07bc4837831e06f5ef463e`.

Cloud source is branch `codex/admin-console-current-20261107`, commit `7cfada9`,
based on the already-live `349e53c` release. It preserves the concurrent
expression and hosted-account changes. The website retains the previously live
static site and adds only the TLS-verified console reverse proxy. The mainline
implementation is tracked in https://github.com/oratis/LISA/pull/457; it must
be retained when preparing later cloud or website releases.

## Verification

- Type checking, application build and 144 relevant regression tests passed on
  the final cloud source.
- All 11 modules, sign-in, account search/detail, internal ticket creation and
  desktop/mobile layouts were checked using disposable local fixtures.
- Zero-traffic cloud and website revisions passed read-only live verification
  before promotion; the public `meetlisa.ai` path then passed the same checks.
- The verified owner returned role `admin`; the real operational snapshot
  returned successfully with no data-coverage warnings. An unauthenticated
  request returned 401, an ordinary account returned 403, and an app-purpose
  session token returned 401.
- Console responses carry `private, no-store` and a restrictive CSP. The
  website proxy validates the upstream TLS certificate.
- The normal homepage, install page, privacy page, cloud health endpoint and
  app authentication configuration all returned 200 after promotion.
- No ERROR-level logs were found for the deployed console revisions during the
  final 20-minute check. Live verification did not change balances, suspend
  users, create tickets or send verification emails.

## Subsequent releases and recovery

Before changing traffic, inspect current production revisions and preserve any
newer release. Independent `ui-0301` preview tags were left intact. Deploying a
cloud build without the console patches would remove the console routes and
their enforcement hooks; deploying an older website nginx configuration would
remove the public `/console` proxy.

Previous production revisions retained for emergency recovery are
`lisa-cloud-expr-349e53c` and `lisa-web-00029-gej`. Rolling back to those versions
also removes console functionality. Admin state remains in the existing
persistent data store; never discard it when rolling back or redeploying.

See [ADMIN_CONSOLE.md](ADMIN_CONSOLE.md) for controls, accounting definitions,
data coverage, limits and operational safeguards.
