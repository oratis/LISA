# Design: secret handles and inbound hygiene (W2b)

Status: shipped as library + CLI + mail wiring. Part of the Warden trust layer
in [PLAN_ALWAYS_ON_UPGRADE_2026-09-30.md](./PLAN_ALWAYS_ON_UPGRADE_2026-09-30.md) (W2,
"凭据代理" and "入站卫生"); the threats it answers are the *Credentials* and
*Mail connector* rows of [THREAT_MODEL.md](./THREAT_MODEL.md).

Two independent pieces live under `src/warden/`:

| Piece | Files | Invariant it serves |
| --- | --- | --- |
| Credential broker | `secrets.ts`, `secrets-file.ts`, `secrets-keychain.ts`, `secrets-open.ts`, `src/cli/secret.ts` | A credential appears in a model context only as a handle. |
| Inbound hygiene | `hygiene.ts`, `hygiene-mail.ts` | A one-time code or sign-in / reset link in inbound mail never reaches a model. |

## 1. Credential broker

### Handles

`secret://<name>` — `name` is `[a-z0-9][a-z0-9._-]{0,63}`, optionally namespaced
once (`gmail/work`). The model, the transcript and the logs only ever hold the
handle. A tool executor swaps it for the value at the last moment:

```ts
const store = openSecretStore();
const resolved = await resolveSecretRefs(toolInput, store, { allow });
const output = await run(resolved.value);      // the only place the value exists
return resolved.redact(output);                // before it goes back to the model
```

- `resolveSecretRefs` deep-copies strings, arrays and plain objects, replacing
  whole-string handles and handles embedded in a longer string
  (`"Bearer secret://github/token"`). Object keys are not resolved.
- It **fails closed**: an unknown handle, a malformed one (`secret://nameX`,
  `secret://a/b/c`) or one the `allow` gate refuses throws `SecretStoreError`.
  A tool never runs with a literal `secret://…` where a credential was meant.
- `allow(name)` is the seam for the Warden policy layer (which handles a given
  call may use). Without it, every stored handle is resolvable by the caller.
- `redactKnownSecrets(text, values)` replaces each value — raw, URL-encoded,
  JSON-escaped, base64 / base64url and hex — with `[redacted: secret]`. Values
  shorter than 4 characters are not redacted. It cannot catch a value that was
  transformed together with other data (`base64("user:" + value)`); that is why
  tool inputs are never logged in the first place.

No error thrown by these modules contains a value; errors carry a stable `code`
and name the handle only.

### Backends

`openSecretStore()` picks one:

| Where | Backend | Key |
| --- | --- | --- |
| macOS, default home (`~/.lisa`) | Keychain, via `/usr/bin/security` | the login keychain |
| Linux / Windows, or any `LISA_HOME` override | AES-256-GCM file `<home>/warden/secrets.enc.json` | random, in `<home>/warden/secret.key` (0600) |
| Cloud edition | AES-256-GCM file `<tenant home>/warden/secrets.enc.json` | HKDF-SHA256(server session secret, info = uid) |

`LISA_SECRETS_BACKEND=file|keychain` forces the local choice; it is ignored in
the cloud edition.

**Encrypted file.** Each entry has its own random 96-bit IV; the AAD binds the
ciphertext to the store's scope (`local` / `uid:<uid>`) and to the secret's
*name*, so an entry cannot be moved to another name or another tenant. A file
that does not parse, an entry that fails authentication, or a missing key is
`corrupt` — nothing is overwritten to "repair" it. Only "file does not exist"
initializes as empty.

**Cloud.** The key is derived, never stored: tenant A's key says nothing about
tenant B's. A request-scoped call can only open its own tenant's store. Two
consequences worth knowing: losing or rotating the session secret makes every
stored secret undecryptable (it fails closed), and there is no KMS in the path —
the plan's "KMS-encrypted vault" is, for now, the same key-derivation approach
`src/web/apple-authorization.ts` uses.

**Keychain.** The value must not appear in a process argument list, so the
`add-generic-password` command is written to the *stdin* of `security -i`
(interactive mode); the argv of the spawned process is only `["-i"]`. Measured
on macOS 26 with the harmless `help` command:

- `security -i` reads lines through a 4096-byte buffer and runs the overflow as
  a second command, echoing it to stderr. The command line is therefore kept
  under that size, which caps a Keychain-backed value at **2560 bytes**; larger
  values are refused with a pointer to the file backend.
- The exit status after an interactive session is not a reliable verdict, so
  every write is verified by reading the item back.
- stderr is never captured, and no error carries process output.

Values are stored as `v1.<base64url>` so no quoting is ever needed; Keychain
Access shows the encoded form. Names and timestamps live in a small index file
(`<home>/warden/secrets.index.json`, no values) because the Keychain cannot
cheaply enumerate "our" items.

### CLI

```
lisa secret set <name>     # hidden prompt, or pipe the value on stdin
lisa secret list [--json]  # names + timestamps
lisa secret rm <name>
```

There is no `get`, and `set` refuses a value passed as an argument (it would be
in shell history and visible through `ps`). There is no HTTP API for secrets.

### What the file backend is and is not

On a local install the key sits next to the ciphertext. That keeps values out
of backups that skip the key file, out of greps and accidental `cat`s, and makes
the store safe to copy without the key — it does not stop a process that can
read both files. The Keychain backend is the stronger local option.

## 2. Inbound hygiene

`stripSensitiveTokens(text, opts?)` → `{ text, removed: { otp, signInLinks, resetLinks } }`.
Deterministic (regular expressions and URL parsing — no model, no network),
idempotent, and it reports counts only.

### What is removed

- **One-time codes** → `[redacted: one-time code]`. A 4–8 digit code (also
  `123 456`, `123-456`, `48 29 13`, `G-123456`, full-width digits), or a 5–10 character
  letters-and-digits code, *near a keyword* (verification / security / login
  code, OTP, 2FA, passcode, 验证码, 校验码, 动态密码, 確認コード, 인증번호, …):
  after it within ~100 characters of prose, or before it joined by a linker
  (`123456 is your … code`, `482913（验证码）`). The bare words "code" / "PIN"
  count only when tied to the number (`code: 123456`, `Your code is 123456`,
  and for "code" also `WhatsApp code 123-456`). A letters-and-digits code with
  no keyword is removed in `Use code ABC-123 to sign in` (sign in / log in /
  verify / reset), not with any other verb.
- **Sign-in, magic and e-mail-verification links** → `[redacted: sign-in link]`.
- **Password-reset links** → `[redacted: password-reset link]`.

A link is removed when it carries a JWT, a credential-named parameter
(`token`, `oobCode`, `confirmation_token`, …), an auth / reset path
(`/magic`, `/verify-email`, `/reset-password`, `accounts.` hosts) together with
an opaque token, or when the surrounding words announce it ("reset your
password", "点击登录") and it carries an opaque token — which is what catches
click-tracker wrappers. Redirect wrappers are judged by the URL they wrap.

### Bias, and the known limits

Inside an "OTP sentence" the filter over-redacts on purpose: a lost order number
costs a slightly worse summary, a leaked code costs an account. Outside one it
leaves numbers and links alone. Both directions are pinned by tests
(`src/warden/hygiene.test.ts`, "known over-redaction" and "known misses").

Over-redaction (false positives):

- any code-shaped token in the same sentence as a real code
  (`Your verification code for iPhone15 is 482913` loses both);
- the first code-shaped number after an OTP keyword when the mail contains no
  code at all;
- click-tracking links that follow the words "sign in" / "log in" in marketing
  mail; OAuth authorization links; double opt-in and invitation links;
- a `the <word> code 1234` or `<word> code 1234` phrase whose word is not on
  the exclusion list (`Civil Code 1714` is kept; `Code 2026 conference` is not).

Misses (false negatives):

- a bare code with no keyword in the subject or snippet;
- all-letter codes (`abcd-efgh-ijkl`) and temporary *passwords*;
- a keyword fused to the code (`otp-482913`, `OTP482913`);
- links without a scheme (`example.com/reset?token=…`);
- tracker-wrapped links with no auth wording nearby;
- languages outside EN, ZH, JA, KO, ES, FR, DE, PT, IT;
- a code or token already split by the snippet cut.

Deliberately kept: booking-style `confirmation code` / `activation code` values
that contain letters, parcel pickup codes (取件码, `pickup code 4821`) and
order, return, shipment and reference codes — things the user asks Lisa to
read back.

### Where it is wired

Mail only, at the point messages leave the connector, and again wherever mail
text is handed to a model or shown:

| Path | Where |
| --- | --- |
| Daily sweep and intraday poll (everything downstream: prompt, items, digest, alerts) | `cleanInbound()` in `src/mail/service.ts` |
| Classification prompt and the `MailItem`s kept from it | `buildClassifyPrompt`, `parseClassification` in `src/mail/classify.ts` |
| Push alert + proactive chat message | `formatAlert` in `src/mail/alerts.ts` |
| Digests already on disk (written before hygiene existed) | `latestDigest()` in `src/mail/store.ts` |

Subject and snippet are cleaned together, because a code is often announced in
one and printed in the other. The log line is counts only:
`[mail] hygiene account=qq-3…9a1c: cleaned 4/5 message(s) — otp=3 signInLinks=1 resetLinks=1`.

Consequence: the digest the user sees also shows the placeholders. The code is
still in their mail client; Lisa simply never holds it.

## 3. Not done yet

- No tool executor calls `resolveSecretRefs` yet; the policy that decides which
  handle a call may use belongs to Warden core. Existing credentials (mail
  passwords and OAuth tokens in `~/.lisa/mail/secrets.json`, provider keys in
  `config.env`) have not been migrated into the store.
- Hygiene is not applied to web pages (`web_fetch`) or to channel messages —
  the plan asks for both.
- The Keychain backend has only been exercised through its injected command
  runner. It has never run against a real keychain; verify once by hand
  (`lisa secret set`, `list`, `rm` on a Mac) before relying on it.
- The cloud store has no way in yet: the CLI is local, and there is no HTTP API.
- No reader sub-context ("dual-model" summarisation of untrusted content).
