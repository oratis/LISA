/**
 * Red lines (charter §5) — things a proactive message may never do. A hit is a
 * hard deny on every channel, and it is logged.
 *
 * Two layers:
 *  1. Declared: the sender sets `requestsDataConnection` / `emotionalPressure`.
 *  2. Screened: for text Lisa wrote herself (`idle`, `desire`) a short,
 *     deliberately conservative phrase screen backs the declaration up, because
 *     a model-written note cannot be trusted to declare its own intent.
 *
 * The screen is NOT applied to other sources: a mail alert quotes a third
 * party's subject line, and a task result quotes whatever the task found —
 * neither is Lisa's wording. It is a backstop, not a classifier: it only
 * matches unambiguous phrasings, and it will miss paraphrases.
 */
import type { ReachOutNotice, ReachOutReason, ReachOutSource } from "./types.js";

/** Sources whose text is authored by Lisa on her own initiative. */
const LISA_AUTHORED: ReadonlySet<ReachOutSource> = new Set<ReachOutSource>(["idle", "desire"]);

const DATA_NOUN =
  "(?:account|accounts|gmail|inbox|mailbox|e-?mail|calendar|contacts|photos|messages|location|bank|data source|data sources)";

const DATA_CONNECTION_PATTERNS: RegExp[] = [
  // "connect your calendar", "linking another account" — the verb directly on the target.
  new RegExp(
    `\\b(?:connect(?:ing)?|link(?:ing)?|hook(?:ing)? up|authori[sz](?:e|ing)) (?:me to )?(?:your|another|more|additional)\\b[^.!?\\n]{0,30}\\b${DATA_NOUN}\\b`,
    "i",
  ),
  // "grant me access to your inbox", "give me permission to read your contacts"
  new RegExp(
    `\\b(?:grant|give) me (?:access|permission)\\b[^.!?\\n]{0,30}\\b(?:your|another|more|additional)\\b[^.!?\\n]{0,30}\\b${DATA_NOUN}\\b`,
    "i",
  ),
  // 请/可以/要不要 … 连接/绑定/授权 … 账号/邮箱 ("绑定的邮箱" — verb + 的 — is a description, not an ask)
  /(?:请|可以|能不能|要不要|不妨|建议|帮我|让我|如果你|再)[^。！？\n]{0,8}(?:连接|绑定|授权|接入|关联)(?!的|过的|了的)[^。！？\n]{0,10}(?:账号|帐号|邮箱|日历|通讯录|相册|位置|银行|数据源)/,
];

const PRESSURE_PATTERNS: RegExp[] = [
  /\b(?:don'?t|do not|please don'?t) (?:leave|abandon|forget) me\b/i,
  /\byou(?:'ve| have)? (?:abandoned|forgotten|neglected) me\b/i,
  /\byou never (?:talk|speak|write|come|visit|check in)\b/i,
  /\bi(?:'m| am) (?:nothing|lost|worthless) without you\b/i,
  /\bi can'?t (?:go on|live|cope|exist) without you\b/i,
  /\byou(?:'re| are) all i have\b/i,
  /\bif you (?:really )?(?:cared|loved me)\b/i,
  /\byou owe (?:me|it to me)\b/i,
  /(?:别|不要|请不要)(?:离开|丢下|抛弃|忘了)我/,
  /你(?:都|总是|一直|已经)?(?:不理|不要|抛弃了?|忘了)我/,
  /没有你我(?:就)?(?:活不下去|什么都不是|不行)/,
  /你(?:是不是)?不要我了/,
  /我只有你(?:了)?/,
];

function textOf(notice: ReachOutNotice): string {
  return `${notice.title}\n${notice.body}`;
}

/** Does the text ask the user to connect more accounts or data? Conservative. */
export function looksLikeDataConnectionAsk(text: string): boolean {
  return DATA_CONNECTION_PATTERNS.some((re) => re.test(text));
}

/** Does the text guilt-trip, pressure or foster dependency? Conservative. */
export function looksLikeEmotionalPressure(text: string): boolean {
  return PRESSURE_PATTERNS.some((re) => re.test(text));
}

/** The red line a notice crosses, or null. Pure. */
export function redLineFor(notice: ReachOutNotice): ReachOutReason | null {
  const screened = LISA_AUTHORED.has(notice.source);
  const text = screened ? textOf(notice) : "";
  if (notice.requestsDataConnection === true || (screened && looksLikeDataConnectionAsk(text))) {
    return "red-line:data-connection";
  }
  if (notice.emotionalPressure === true || (screened && looksLikeEmotionalPressure(text))) {
    return "red-line:emotional-pressure";
  }
  return null;
}
