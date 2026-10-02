/**
 * Warden inbound hygiene (plan W2b, "入站卫生").
 *
 * Untrusted inbound text — mail first — is passed through `stripSensitiveTokens`
 * before it can enter a model context. It removes the three things in a message
 * that are credentials in their own right:
 *
 *  - one-time codes (OTP / 2FA / 验证码);
 *  - sign-in, magic and e-mail-verification links;
 *  - password-reset links.
 *
 * A model that never sees them cannot be talked into relaying them, and they do
 * not end up in transcripts, digests or logs. Only counts are reported.
 *
 * This is a deterministic filter, not a classifier: plain regular expressions
 * and URL parsing, no model, no network. It is deliberately biased — inside an
 * "OTP sentence" or next to "reset your password" it over-redacts, because a
 * lost order number costs a slightly worse summary and a leaked code costs an
 * account. Outside those contexts it leaves numbers and links alone. The known
 * misses and over-matches are listed in docs/DESIGN_SECRETS_AND_HYGIENE.md and
 * pinned by hygiene.test.ts.
 *
 * Idempotent: `strip(strip(x).text)` changes nothing and counts nothing.
 */
import { SECRET_REDACTION } from "./secrets.js";

export const REDACTED_OTP = "[redacted: one-time code]";
export const REDACTED_SIGN_IN_LINK = "[redacted: sign-in link]";
export const REDACTED_RESET_LINK = "[redacted: password-reset link]";

export interface HygieneCounts {
  otp: number;
  signInLinks: number;
  resetLinks: number;
}

export interface HygieneResult {
  text: string;
  /** How many of each kind were removed. Counts only — never the values. */
  removed: HygieneCounts;
}

export interface HygieneOptions {
  /**
   * BCP-47 hint for the text's language. Reserved: every keyword set (EN, ZH,
   * JA, KO, ES, FR, DE, PT, IT) is always applied, because mail is routinely
   * mixed-language and narrowing by locale could only add false negatives.
   */
  locale?: string;
  /**
   * The text was cut to a length (a mail snippet). A link that runs into the
   * very end may have lost its token to the cut, so there it is judged on its
   * path and surrounding words alone.
   */
  truncated?: boolean;
}

export function emptyHygieneCounts(): HygieneCounts {
  return { otp: 0, signInLinks: 0, resetLinks: 0 };
}

export function addHygieneCounts(a: HygieneCounts, b: HygieneCounts): HygieneCounts {
  return {
    otp: a.otp + b.otp,
    signInLinks: a.signInLinks + b.signInLinks,
    resetLinks: a.resetLinks + b.resetLinks,
  };
}

export function hygieneTotal(c: HygieneCounts): number {
  return c.otp + c.signInLinks + c.resetLinks;
}

/** Anything this module (or the secret redactor) has already put in place. */
const PLACEHOLDERS = [REDACTED_OTP, REDACTED_SIGN_IN_LINK, REDACTED_RESET_LINK, SECRET_REDACTION];

interface Span {
  start: number;
  end: number;
}

function findAll(text: string, needle: string): Span[] {
  const out: Span[] = [];
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) {
    out.push({ start: i, end: i + needle.length });
  }
  return out;
}

function placeholderSpans(text: string): Span[] {
  if (!text.includes("[redacted: ")) return [];
  return PLACEHOLDERS.flatMap((p) => findAll(text, p)).sort((a, b) => a.start - b.start);
}

// ════════════════════════════════════════════════════════════════════════
// Links
// ════════════════════════════════════════════════════════════════════════

/**
 * A URL with any scheme (`https://`, `slack://`, …). It ends at whitespace,
 * quotes, angle brackets, or the first CJK / full-width character — mail in
 * Chinese or Japanese routinely runs prose straight on after a link.
 */
const URL_RE = (() => {
  // Built from code points so the source carries no invisible characters.
  const range = (from: number, to: number): string =>
    `${String.fromCharCode(from)}-${String.fromCharCode(to)}`;
  const stop =
    "\\s<>\"'`\\\\^{}|" +
    String.fromCharCode(0x00a0) + // no-break space
    range(0x2000, 0x206f) + // general punctuation, incl. curly quotes and zero-width spaces
    range(0x3000, 0x30ff) + // CJK punctuation, hiragana, katakana
    range(0x3400, 0x9fff) + // CJK ideographs
    range(0xac00, 0xd7af) + // hangul
    range(0xff00, 0xffef); // full-width forms
  return new RegExp(`(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{1,24}://[^${stop}]+`, "g");
})();

/** Sentence punctuation and unbalanced closers are prose, not part of the link. */
function trimUrl(raw: string): string {
  let open = 0; // "(" minus ")"
  let square = 0; // "[" minus "]"
  for (const ch of raw) {
    if (ch === "(") open++;
    else if (ch === ")") open--;
    else if (ch === "[") square++;
    else if (ch === "]") square--;
  }
  let end = raw.length;
  while (end > 0) {
    const last = raw[end - 1]!;
    if (".,;:!?*_~".includes(last)) {
      end--;
    } else if (last === ")" && open < 0) {
      open++;
      end--;
    } else if (last === "]" && square < 0) {
      square++;
      end--;
    } else {
      break;
    }
  }
  return raw.slice(0, end);
}

function findUrls(text: string): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    // "secret://name" is a LISA handle, not a link.
    if (url.length > 0 && !/^secret:\/\//i.test(url)) {
      out.push({ start: m.index, end: m.index + url.length });
    }
  }
  return out;
}

const JWT_RE = /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/;

/** Path words that say "this endpoint signs you in / verifies you". */
const AUTH_WORD_RE =
  /^(?:log[io]n|logon|signin|signon|signup|sso|saml|magic|passwordless|otp|onetime|2fa|mfa|verif(?:y|ied|ication)|confirm(?:ation|ed)?|activat(?:e|ion)|validat(?:e|ion)|auth(?!or)|oauth2?|token|callback|invit(?:e|ation)|accept|session|register|registration|enroll|unlock)/;
/** Path words that say "this endpoint resets a password". */
const RESET_WORD_RE = /^(?:reset|recover|forgot|password|passwd|pwd$)/;
/** Host labels that mark an identity service (`login.example.com`). */
const AUTH_HOST_RE = /^(?:login|signin|auth|oauth|sso|idp|accounts?|identity|passport)$/;
/** Mailing-list plumbing: carries a token, but not one that signs anyone in. */
const LIST_WORD_RE = /^(?:unsubscribe|unsub|optout|preferences|subscriptions?|pixel)$/;

/** Parameter names that are a credential whatever the endpoint is called. */
const STRONG_PARAM_RE =
  /(?:token|otp|passcode|password|passwd|secret|jwt|oobcode|magiclink|credential|assertion|samlresponse)$|^(?:magic|authcode|logincode|verificationcode|verifycode|confirmationcode|activationcode|activationkey|resetcode|recoverycode|loginkey|accesskey|apikey|signinkey|tokenhash|tokenid)$/;
/** Parameter names that are a credential only on an auth / reset endpoint. */
const WEAK_PARAM_RE =
  /^(?:code|key|k|h|hash|sig|signature|t|tk|c|ticket|session|sessionid|sid|auth|link|pwd)$/;

const RESET_CONTEXT_RE =
  /reset (?:your |my |the )?(?:password|passcode|pin)|password reset|forgot(?:ten)? (?:your )?password|change (?:your )?password|set (?:a |your )?(?:new )?password|recover (?:your )?account|account recovery|重置(?:您的|你的)?密码|重設(?:您的|你的)?密碼|找回密码|找回密碼|修改密码|修改密碼|设置新密码|設定新密碼|パスワード(?:の|を)?(?:再設定|リセット|変更)|비밀번호\s?(?:재설정|변경)/gi;
const SIGN_IN_CONTEXT_RE =
  /sign[- ]?in|log[- ]?in|magic link|verify (?:your |this )?(?:e-?mail|account|address|identity|device)|confirm (?:your |this )?(?:e-?mail|account|address|subscription|registration)|activate (?:your )?account|verification link|confirmation link|登录|登入|登錄|验证(?:您的|你的)?(?:邮箱|电子邮件|邮件地址)|驗證(?:您的|你的)?(?:信箱|電子郵件|郵箱)|激活(?:您的|你的)?(?:账号|账户|帳號|帳戶)|确认(?:您的|你的)?(?:邮箱|注册)|メールアドレス(?:の|を)確認|ログイン|로그인|이메일\s?인증/gi;

type LinkKind = "signin" | "reset";

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** `resetPassword/verify-email` → `["reset","password","verify","email", "resetpassword", …]`. */
function words(s: string): string[] {
  const parts = s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  // Adjacent pairs catch "sign-in" → "signin", "one_time" → "onetime".
  const pairs = parts.slice(1).map((p, i) => parts[i]! + p);
  return [...parts, ...pairs];
}

/**
 * Does `s` look like a random token rather than a readable slug? Long enough,
 * URL-token alphabet, and not mostly dictionary-shaped pieces — so
 * `3f2a9c1b7d4e5a6b7c8d` and a UUID are opaque, `how-to-reset-your-password`
 * and `getting-started-with-oauth2` are not.
 */
function isOpaque(s: string): boolean {
  if (s.length < 16 || !/^[A-Za-z0-9_\-.~=+%]+$/.test(s)) return false;
  const pieces = s.split(/[-_.~=+%]+/).filter(Boolean);
  if (pieces.length === 0) return false;
  const wordy = pieces.filter(
    (p) => /^[a-z]{1,14}$/.test(p) || /^[A-Z][a-z]{1,13}$/.test(p) || /^\d{1,4}$/.test(p),
  ).length;
  return wordy / pieces.length < 0.6;
}

function lastMatchIndex(text: string, re: RegExp): number {
  let last = -1;
  for (const m of text.matchAll(re)) last = m.index;
  return last;
}

/** Which kind of link do the words just before it announce, if any? */
function contextKind(before: string): LinkKind | null {
  const reset = lastMatchIndex(before, RESET_CONTEXT_RE);
  const signIn = lastMatchIndex(before, SIGN_IN_CONTEXT_RE);
  if (reset < 0 && signIn < 0) return null;
  return reset >= signIn ? "reset" : "signin";
}

/**
 * Decide whether one URL is a credential-bearing link.
 * `before` is the prose leading up to it; `tail` is true when the URL runs into
 * the end of a truncated text.
 */
function classifyUrl(raw: string, before: string, tail: boolean, depth = 0): LinkKind | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const web = url.protocol === "http:" || url.protocol === "https:";

  const params: Array<[string, string]> = [...url.searchParams];
  let hashPath = "";
  const hash = url.hash.slice(1);
  if (hash) {
    // "#access_token=…" and "#/reset?token=…" both carry parameters.
    const q = hash.indexOf("?");
    if (q >= 0) {
      hashPath = hash.slice(0, q);
      params.push(...new URLSearchParams(hash.slice(q + 1)));
    } else if (hash.includes("=")) {
      params.push(...new URLSearchParams(hash));
    } else {
      hashPath = hash;
    }
  }
  // A custom scheme keeps its first path word in the "host": slack://magic-login/…
  const pathText = (web ? "" : url.hostname + "/") + safeDecode(url.pathname) + "/" + hashPath;
  const pathWords = words(pathText);
  const segments = pathText.split("/").filter(Boolean);
  const hostLabels = web ? url.hostname.toLowerCase().split(".").slice(0, -2) : [];

  const names = params.map(([name]) => name.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const authPath = pathWords.some((w) => AUTH_WORD_RE.test(w));
  const resetPath = pathWords.some((w) => RESET_WORD_RE.test(w));
  const authHost = hostLabels.some((l) => AUTH_HOST_RE.test(l));
  const keyworded = authPath || resetPath || authHost;
  const context = contextKind(before);

  // A redirect wrapper is as sensitive as what it wraps.
  let nested: LinkKind | null = null;
  if (depth < 2) {
    for (const [, value] of params) {
      if (/^https?:\/\//i.test(value)) nested ??= classifyUrl(value, before, false, depth + 1);
    }
  }

  // Mailing-list plumbing (unsubscribe, preferences) carries tokens too, but
  // not ones that sign anyone in — GitHub's "unsubscribe-auth/<token>" included.
  if (!resetPath && !nested && pathWords.some((w) => LIST_WORD_RE.test(w))) return null;

  const strongParam = params.some(
    ([, value], i) => value.length >= 4 && STRONG_PARAM_RE.test(names[i]!),
  );
  const weakParam = params.some(
    ([, value], i) => value.length >= 4 && WEAK_PARAM_RE.test(names[i]!),
  );
  const opaque =
    segments.some((s) => isOpaque(s)) ||
    params.some(([, value]) => !/^https?:\/\//i.test(value) && isOpaque(value));

  const sensitive =
    JWT_RE.test(raw) ||
    strongParam ||
    nested !== null ||
    (keyworded && (opaque || weakParam)) ||
    (context !== null && opaque) ||
    (tail && (authPath || resetPath || context !== null));
  if (!sensitive) return null;

  const resetParam =
    names.some((n) => /reset|recover|password|passwd/.test(n)) ||
    params.some(
      ([name, value]) =>
        (/^mode$/i.test(name) && /resetpassword|recoveremail/i.test(value)) ||
        (/^type$/i.test(name) && /^recovery$/i.test(value)),
    );
  if (resetPath || resetParam || nested === "reset" || context === "reset") return "reset";
  return "signin";
}

/** How much prose before a link is consulted for "reset your password"-style wording. */
const LINK_CONTEXT_CHARS = 120;

function stripLinks(text: string, opts: HygieneOptions, counts: HygieneCounts): string {
  if (!text.includes("://")) return text;
  const urls = findUrls(text);
  if (urls.length === 0) return text;
  // Context is measured over prose only: links and placeholders are cut out, so
  // the same words are consulted on a second pass (idempotence).
  const skip = [...urls, ...placeholderSpans(text)].sort((a, b) => a.start - b.start);
  const indexOf = new Map(skip.map((s, i) => [s, i]));
  const proseBefore = (url: Span): string => {
    let out = "";
    let cursor = url.start;
    for (let i = indexOf.get(url)! - 1; i >= 0 && out.length < LINK_CONTEXT_CHARS; i--) {
      const s = skip[i]!;
      out = text.slice(s.end, cursor) + out;
      cursor = s.start;
    }
    if (out.length < LINK_CONTEXT_CHARS) {
      out = text.slice(Math.max(0, cursor - LINK_CONTEXT_CHARS), cursor) + out;
    }
    return out.slice(-LINK_CONTEXT_CHARS);
  };

  let out = "";
  let last = 0;
  for (const u of urls) {
    const tail = opts.truncated === true && u.end === text.length;
    const kind = classifyUrl(text.slice(u.start, u.end), proseBefore(u), tail);
    if (!kind) continue;
    if (kind === "reset") counts.resetLinks++;
    else counts.signInLinks++;
    out +=
      text.slice(last, u.start) + (kind === "reset" ? REDACTED_RESET_LINK : REDACTED_SIGN_IN_LINK);
    last = u.end;
  }
  return out + text.slice(last);
}

// ════════════════════════════════════════════════════════════════════════
// One-time codes
// ════════════════════════════════════════════════════════════════════════

/** Words that announce a one-time code. A code near one of these is removed. */
const STRONG_KEYWORD_RE = new RegExp(
  [
    "(?<![a-z])(?:" +
      [
        // English
        "verification (?:code|pin|number)",
        "verify code",
        "security code",
        "confirmation code",
        "authentication code",
        "auth code",
        "log-?in code",
        "sign-?in code",
        "access code",
        "validation code",
        "activation code",
        "approval code",
        "temporary code",
        "single-use code",
        "sms code",
        "one[- ]time (?:pass)?(?:code|password|passcode|pin)",
        "otp",
        "2fa",
        "two[- ]factor",
        "two[- ]step",
        "2[- ]step",
        "pass ?code",
        "pin code",
        "code to (?:sign|log) in",
        "(?:enter|use|type|input|provide) (?:this|the|the following|your|that) code",
        "following code",
        "code below",
        // ES / PT / FR / IT / DE
        "c[oó]digo de (?:verificaci[oó]n|seguridad|confirmaci[oó]n|acceso|verifica[cç][aã]o|seguran[cç]a|confirma[cç][aã]o)",
        "code de (?:v[eé]rification|s[eé]curit[eé]|confirmation|validation)",
        "codice di (?:verifica|sicurezza|conferma)",
        "(?:best[aä]tigungs|sicherheits|verifizierungs|einmal)code",
        "einmalpasswort",
      ].join("|") +
      ")(?![a-z])",
    // Chinese
    "验证码|驗證碼|校验码|校驗碼|动态码|動態碼|动态密码|動態密碼|认证码|認證碼|确认码|確認碼",
    "安全码|安全碼|登录码|登錄碼|登入碼|授权码|授權碼|激活码|激活碼|短信码|验证代码|驗證代碼",
    "一次性密码|一次性密碼",
    // Japanese
    "確認コード|認証コード|検証コード|セキュリティコード|ワンタイムパスワード|ワンタイムコード",
    "認証番号|確認番号|暗証番号",
    // Korean
    "인증\\s?번호|인증\\s?코드|보안\\s?코드|확인\\s?코드",
  ].join("|"),
  "gi",
);

/**
 * Keywords that also name things which are NOT one-time codes — a flight or
 * booking "confirmation code", a product "activation code", a door "access
 * code". Next to these only an all-digit code is removed; a letters-and-digits
 * token (a booking reference) is left for the model to read.
 */
const DIGITS_ONLY_KEYWORD_RE =
  /confirm|activation|access|approval|^(?:enter|use|type|input|provide) |following code|code below|确认码|確認碼|確認コード|確認番号|激活|확인/i;

/**
 * The bare word "code" / "PIN" announces a one-time code only when it is glued
 * to the number: `code: 123456`, `Your code is 123456`, `コード：123456`.
 */
const WEAK_FORWARD_RE =
  /(?<![a-z])(?:code|pin|c[oó]digo|codice|kode)(?![a-z])\s*(?:is|are|:|=)\s*["'“‘]?$|(?:代码|コード|코드)\s*(?:为|為|是|は|:|=)?\s*["'“‘「]?$/i;
/** …unless it is a kind of code that is not a credential. */
const NOT_A_SECRET_CODE_RE =
  /(?:promo(?:tion(?:al)?)?|discount|coupon|voucher|referral|invite|gift|zip|postal|area|country|dial(?:ing)?|error|status|exit|response|http|product|item|tracking|source|color|colour|qr|bar|优惠|折扣|兑换|兌換|邀请|邀請|邮政|郵政|邮编|区号|區號|错误|錯誤|状态|狀態)\s*$/i;
/** `123456 is your Uber code`. */
const WEAK_BACKWARD_RE =
  /^\s+(?:is|as)\s+(?:your|the)\s+[^.!?\d\n]{0,30}?(?<![a-z])(?:code|pin)(?![a-z])/i;

/**
 * What may sit between a code and the keyword that follows it: a linking word
 * or mark and a short clause (`123456 is your Facebook confirmation code`,
 * `482913（验证码）`), or nothing but a space or a quote (`123456 验证码`).
 */
const BACK_LINK_RE =
  /^\s*(?:(?:is|are|was|as|为|為|是|就是|が|は)(?![a-z])|[—–\-:(（,，])\s*[^.!?。！？\d\n]{0,32}$|^[\s"'”’」)）]{0,3}$/i;

const SENTENCE_END_RE = /[.!?;](?:\s|$)|[。！？；]|\n\s*\n/g;

/** Prose characters scanned after a keyword for its code. */
const FORWARD_BUDGET = 100;
/** How far back from a keyword a "123456 is your …" code may sit. */
const BACKWARD_CHARS = 48;

/**
 * Mask characters for the shadow copy (Unicode private use — they cannot be
 * typed as a digit, a letter or a keyword). DONE marks an existing OTP
 * placeholder, i.e. a code already removed; INERT blanks URLs, e-mail
 * addresses and other placeholders so nothing inside them is matched.
 */
const MASK_DONE = String.fromCharCode(0xe000);
const MASK_INERT = String.fromCharCode(0xe001);

/** Bounded on both sides so a long token run cannot make matching quadratic. */
const EMAIL_RE =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g;

function maskSpans(chars: string[], spans: Span[], mask: string): void {
  for (const s of spans) for (let i = s.start; i < s.end; i++) chars[i] = mask;
}

/**
 * A same-length copy of `text` to match against: full-width digits, letters and
 * colon folded to ASCII, existing placeholders marked, and URLs / e-mail
 * addresses blanked so their digits are never taken for a code. Indices into
 * the shadow are indices into `text`.
 */
function shadowOf(text: string): string {
  const chars = text.split("");
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!.charCodeAt(0);
    if (c < 0xff10 || c > 0xff5a) continue;
    // U+FF10–FF19 digits, U+FF21–FF3A / U+FF41–FF5A letters, U+FF1A colon.
    if (c <= 0xff19 || c === 0xff1a || (c >= 0xff21 && c <= 0xff3a) || c >= 0xff41) {
      chars[i] = String.fromCharCode(c - 0xfee0);
    }
  }
  maskSpans(chars, findUrls(text), MASK_INERT);
  maskSpans(
    chars,
    [...text.matchAll(EMAIL_RE)].map((m) => ({ start: m.index, end: m.index + m[0].length })),
    MASK_INERT,
  );
  for (const s of placeholderSpans(text)) {
    maskSpans(chars, [s], text.startsWith(REDACTED_OTP, s.start) ? MASK_DONE : MASK_INERT);
  }
  return chars.join("");
}

interface Run extends Span {
  /**
   * - `digits`: shaped like a numeric one-time code — removed near any keyword;
   * - `alnum`:  letters and digits — removed only near an unambiguous keyword;
   * - `done`:   an OTP placeholder, i.e. a code already removed;
   * - `text`:   anything else.
   */
  kind: "digits" | "alnum" | "done" | "text";
}

const RUN_RE = new RegExp(`${MASK_DONE}+|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*`, "g");

const MONEY_BEFORE_RE =
  /(?:[$€£¥₹₩]|(?<![a-z])(?:usd|cny|rmb|eur|gbp|jpy|hkd|sgd|aud|cad|inr|rs\.?))\s?$/i;
/** Amounts, durations and years. Kept short on purpose: every entry is a way to miss a code. */
const UNIT_AFTER_RE =
  /^\s?(?:元|圆|円|块钱|美元|美金|欧元|港币|分钟|分鐘|小时|小時|秒|年|%|％|(?:dollars?|usd|cny|rmb|eur|gbp|inr|yuan|minutes?|mins?|hours?|hrs?|seconds?|secs?|days?|weeks?|months?|years?|digits?|characters?|chars?|times|items?|people|points?|px|kb|mb|gb|ms)(?![a-z]))/i;
/** "Order #12345678", "card ending in 1234", "尾号1234" — a reference, not a code. */
const REFERENCE_BEFORE_RE =
  /(?:#|(?<![a-z])(?:order|invoice|receipt|ref(?:erence)?|ticket|case|tracking|booking|account|acct|card|ending(?: in| with)?|ext|extension)\.?\s*(?:number|no\.?|id)?\s*[#:]?\s*|订单号?|訂單號?|单号|單號|编号|編號|尾号|尾號|账号|帳號|卡号|卡號|工号|流水号)$/i;
const MONTH_BEFORE_RE =
  /(?:(?<![a-z])(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+(?:\d{1,2}(?:st|nd|rd|th)?,?\s+)?|©\s?|\(c\)\s?|copyright\s+)$/i;

function tokenShape(token: string): "digits" | "alnum" | null {
  if (/^\d{4,8}$/.test(token)) return "digits";
  // "123-456", "1234-5678", and prefixed codes such as Google's "G-123456".
  if (/^(?:\d{3}-\d{3}|\d{4}-\d{4}|[A-Z]{1,3}-\d{4,8})$/.test(token)) return "digits";
  const letters = /[A-Za-z]/.test(token);
  const digits = token.match(/\d/g)?.length ?? 0;
  if (letters && digits >= 2 && /^[A-Za-z0-9]{6,10}$/.test(token)) return "alnum";
  if (letters && digits >= 1 && /^[A-Z0-9]{3,5}-[A-Z0-9]{3,5}$/.test(token)) return "alnum";
  return null;
}

/** Does the text around [start,end) say this number is something other than a code? */
function looksLikeSomethingElse(shadow: string, start: number, end: number): boolean {
  const before = shadow.slice(Math.max(0, start - 40), start);
  const after = shadow.slice(end, end + 12);
  // Part of a decimal, a date, a time, a phone number, an IP or a version.
  if (/\d[.,/:]$/.test(before) || /^[.,/:]\d/.test(after)) return true;
  if (before.endsWith("@") || before.endsWith(MASK_INERT) || after.startsWith("@")) return true;
  if (MONEY_BEFORE_RE.test(before) || UNIT_AFTER_RE.test(after)) return true;
  if (REFERENCE_BEFORE_RE.test(before)) return true;
  return /^(?:19|20)\d\d$/.test(shadow.slice(start, end)) && MONTH_BEFORE_RE.test(before);
}

/** Every alphanumeric run of the shadow, in order, tagged with what it could be. */
function scanRuns(shadow: string): Run[] {
  const out: Run[] = [];
  for (const m of shadow.matchAll(RUN_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (m[0].startsWith(MASK_DONE)) {
      out.push({ start, end, kind: "done" });
      continue;
    }
    const shape = tokenShape(m[0]);
    out.push({
      start,
      end,
      kind: shape && !looksLikeSomethingElse(shadow, start, end) ? shape : "text",
    });
  }
  // "123 456" / "1234 5678": two equal groups written with one space are one
  // code. Three or more groups is a phone or card number, not a split code.
  const isDigits = (r: Run | undefined, n?: number): boolean => {
    if (!r) return false;
    const t = shadow.slice(r.start, r.end);
    return n === undefined ? /^\d+$/.test(t) : t.length === n && /^\d+$/.test(t);
  };
  const adjacent = (a: Run | undefined, b: Run | undefined): boolean =>
    !!a && !!b && b.start - a.end === 1 && shadow[a.end] === " ";
  for (let i = 0; i + 1 < out.length; i++) {
    const a = out[i]!;
    const b = out[i + 1]!;
    if (!adjacent(a, b)) continue;
    const pair = (isDigits(a, 3) && isDigits(b, 3)) || (isDigits(a, 4) && isDigits(b, 4));
    if (!pair) continue;
    const prev = out[i - 1];
    const next = out[i + 2];
    const longer = (adjacent(b, next) && isDigits(next)) || (adjacent(prev, a) && isDigits(prev));
    if (!longer && !looksLikeSomethingElse(shadow, a.start, b.end)) {
      out.splice(i, 2, { start: a.start, end: b.end, kind: "digits" });
    }
  }
  return out;
}

/** Index of the first run that starts at or after `pos`. */
function firstRunFrom(runs: Run[], pos: number): number {
  let lo = 0;
  let hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid]!.start < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function sentenceEnds(text: string): number {
  return text.match(SENTENCE_END_RE)?.length ?? 0;
}

function stripCodes(text: string, counts: HygieneCounts): string {
  const shadow = shadowOf(text);
  const runs = scanRuns(shadow);
  if (runs.length === 0) return text;
  const taken = new Set<Run>();

  for (const kw of shadow.matchAll(STRONG_KEYWORD_RE)) {
    const kwStart = kw.index;
    const kwEnd = kwStart + kw[0].length;
    const allowAlnum = !DIGITS_ONLY_KEYWORD_RE.test(kw[0]);
    const isCode = (r: Run): boolean => r.kind === "digits" || (allowAlnum && r.kind === "alnum");
    const first = firstRunFrom(runs, kwEnd);

    // "123456 is your verification code" — the code comes first. Walk back to
    // the nearest code within reach and check what joins it to the keyword.
    // The reach is measured from the code's END, so it is the same whether the
    // code is still there or already a (longer) placeholder.
    let prior: Run | undefined;
    for (let p = first - 1; p >= 0; p--) {
      const run = runs[p]!;
      if (run.end > kwStart) continue; // the keyword's own words
      if (kwStart - run.end > BACKWARD_CHARS) break;
      if (run.kind === "done" || isCode(run)) {
        prior = run;
        break;
      }
    }
    if (prior && BACK_LINK_RE.test(shadow.slice(prior.end, kwStart))) {
      if (prior.kind !== "done") taken.add(prior);
      continue;
    }

    // "Your verification code is 123456" — scan forward on a budget of PROSE
    // characters. Codes and placeholders cost nothing, so a second pass over
    // already-cleaned text sees exactly the same window.
    let budget = FORWARD_BUDGET;
    let cursor = kwEnd;
    let found = false;
    let endsBeforeFirst = 0;
    for (let i = first; i < runs.length; i++) {
      const run = runs[i]!;
      const gap = shadow.slice(cursor, run.start);
      budget -= gap.length;
      if (budget < 0) break;
      const ends = sentenceEnds(gap);
      if (found && ends > 0) break; // the code's own sentence is over
      if (!found && (endsBeforeFirst += ends) > 1) break; // "…code. Blah. 1234" is not it
      if (run.kind === "done" || isCode(run)) {
        if (run.kind !== "done") taken.add(run);
        found = true;
      } else {
        budget -= run.end - run.start;
      }
      cursor = run.end;
    }
  }

  // The bare word "code" / "PIN", glued to digits.
  for (const run of runs) {
    if (run.kind !== "digits" || taken.has(run)) continue;
    const before = shadow.slice(Math.max(0, run.start - 40), run.start);
    const weak = WEAK_FORWARD_RE.exec(before);
    if (weak && !NOT_A_SECRET_CODE_RE.test(before.slice(0, weak.index))) taken.add(run);
    else if (WEAK_BACKWARD_RE.test(shadow.slice(run.end, run.end + 60))) taken.add(run);
  }

  if (taken.size === 0) return text;
  let out = "";
  let last = 0;
  for (const run of runs) {
    if (!taken.has(run)) continue;
    out += text.slice(last, run.start) + REDACTED_OTP;
    last = run.end;
    counts.otp++;
  }
  return out + text.slice(last);
}

/**
 * Remove one-time codes and sign-in / password-reset links from untrusted text.
 * Returns the cleaned text and how many of each were removed (never the values).
 */
export function stripSensitiveTokens(text: string, opts: HygieneOptions = {}): HygieneResult {
  const removed = emptyHygieneCounts();
  if (typeof text !== "string" || text.length === 0) return { text: "", removed };
  const withoutLinks = stripLinks(text, opts, removed);
  return { text: stripCodes(withoutLinks, removed), removed };
}
