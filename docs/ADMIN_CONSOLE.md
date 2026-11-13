# Lisa Console

The operator console is served at `https://meetlisa.ai/console` by the existing
Cloud service. The website nginx reverse proxy forwards only `/console` and
`/console/*`; the marketing site remains static. Console HTML, assets and API
responses are private/no-store and excluded from indexing.

## Access

Enable with `LISA_CONSOLE_ENABLED=1`, set `LISA_CONSOLE_ORIGIN=https://meetlisa.ai`
and configure the protected owner allowlist with `LISA_ADMIN_EMAILS`. Owner addresses are configured only in the deployment environment. No account is fabricated or marked
verified by this configuration: a verified email/Google account must prove
ownership via the existing mailed OTP or an existing password. Apple relay
addresses cannot claim operator privileges.

Console sessions use an independently derived signing key, eight-hour expiry,
HttpOnly/Secure/SameSite=Strict cookie scoped to `/console`, and current account
session-version and role checks on every request. App/shared/device tokens and
query tokens do not authorize console access. Writes require JSON, a custom
header and the configured Origin. There is no cross-origin CORS allowance.

Roles: admin (all operations), operator (read/export, ordinary user support,
credit grants and tickets), analyst (read/export only). Owners cannot be removed
or suspended from the UI; self-removal/suspension is prevented. Removing roles
and suspending accounts takes effect on subsequent requests, including existing
sessions (within 5 seconds on other instances). In-flight requests are not terminated. Session revocation signs the
account out of both the console and app.

## Modules

1. Overview: current accounts, registrations, active users, metered calls,
   tokens, face-value consumption, daily trend and usage sources.
2. Users: search/filter/pagination, account and balance detail, notes,
   suspend/restore, revoke sessions, and compensation grants.
3. Billing: authoritative transaction index, channel/status filters,
   Apple/Stripe, grants, sandbox, refunds, CSV export.
4. Usage: per-model and source aggregation, bounded recent usage records,
   token/media consumption and CSV.
5. Activity: session/knowledge/task counts and autonomy outcomes; no private
   conversation bodies, knowledge contents or memories are returned.
6. Models: active default/observed/disabled models and deployed prices;
   disable/restore future model requests by ID.
7. Features: inference pause and server-enforced cloud API switches. Enabling
   a switch never expands the underlying cloud capability profile or enables
   an integration missing its deployment configuration.
8. Support: internal tickets, account association, priority, assignee, status,
   processing notes. Does not send messages or notifications.
9. Access: grant/revoke admin, operator and analyst roles by verified email.
10. Audit: logins, exports, before/after configuration changes, grants and
    support changes; searchable and exportable.
11. System: service/version/provider presence, integration configuration,
    quota rules, deployed cost/rate caps and coverage limitations. No secrets.

The default model, prices, quota policy and infrastructure configuration remain
versioned deployment settings. Payment refunds are executed through the payment
provider and synchronized through the existing signed callback flow. Operators
cannot forge a refund or edit a past transaction.

## Accounting and data coverage

Amounts are integer micro-USD. Displayed consumption is the ledger's recorded
face price, not an estimated provider bill. Formal credit totals include credited
production Apple numeric IDs and Stripe transactions, exclude refunds, sandbox,
operator grants and unclassified legacy IDs. Credit-pack face value includes
bonuses and is **not cash revenue**. Platform fees, settlement receipts, App Store
downloads and marketing attribution are not connected; no simulated values are
shown. Local Mac usage is not uploaded and is not included.

Date windows are 7/30/90 UTC calendar days through now. Active means a distinct
account with a valid metered record in the window. Counts for stored sessions,
knowledge sources and tasks describe current cloud storage. Deleted accounts are
not resurrected. Usage files retain at most 5,000 rows per tenant; coverage
warnings identify truncation, invalid records and read failures. Reports read up
to 2,000 users, 10,000 Firestore payments and 16 MiB per ledger, with warnings.
Details/CSV usage are the newest 1,000 records; totals use all read records.

Compensation uses `admin:<UUID>` in the existing pending/credited payment state
machine and balance-level deduplication. Retries after any interrupted write do
not double-credit. Nobody can grant to their own account. Operators may grant up
to $50 per grant and $200 per rolling 24 hours; admins up to $1,000 per grant and
$5,000 per rolling 24 hours (constants at the top of `src/admin/http.ts`). The
24-hour total is counted per granting operator from the grant records; a retried
grant ID is never counted twice. A reason is required. It uses the existing
credit ledger's tier rules. Every operation has a durable intent and
completion record. Never issue a new UUID to retry an uncertain prior grant.

## Persistence, safeguards and operations

`<global home>/admin/state.json` in file mode; `lisa-global/admin` in Firestore
mode. Mutations serialize in-process in the existing single-instance file
configuration, and use CAS in Firestore mode. Configuration and audit changes
are saved atomically, with revision conflicts reported to the UI. Missing state
initializes an empty console; malformed or unavailable state fails closed in the
console.

Tenant requests read only a small derived policy (suspended accounts, pause,
feature switches, disabled models), cached in process for 5 seconds. A write by
the same process applies immediately; other instances pick it up within the
TTL. If the state cannot be read or parsed, the last good policy keeps serving
and the error is logged; before any good read, no console restrictions apply
(logged as an error) rather than signing every tenant out. Feature switches are
checked only after tenant authentication; the pause switch is enforced at
inference admission.
Account/password/Apple authorization material is never exposed by reports.
CSV cells are escaped against spreadsheet formula execution. CSP disallows
inline scripts, external resources, frames and object embeds.

Audit records are never silently truncated. At 4,000 audit entries, 2,000 grant
operation IDs, or 500 tickets, writes stop with an explicit archive-required
error. Archive under operator control before these limits (and, in Firestore,
before its document-size limit); this release targets the existing small,
single-instance service. Do not scale file mode to multiple instances.

## Validation and release

`src/admin/*.test.ts` cover real-server routing, denied paths, separate sessions,
CSRF, role/owner protection, stale revisions, corrupt storage, file concurrency,
credit retries/crash recovery, accounting classification and CSV safety.
Run the account, session, quota, IAP, admission, autonomy and server regression
suites alongside type checking and build. Browser verification covers all 11
modules, login, search/detail, ticket save and mobile layout.

Before promoting a console revision, verify that production traffic still
points to the baseline you inspected; never overwrite a concurrent production
release.

The website image derives from its currently deployed image and changes only
nginx proxy configuration. First deploy a zero-traffic revision; verify denied
and authorized read-only endpoints before promoting. Keep the previous cloud and
website revisions available for rollback.
