/**
 * WeChat Official Account articles (mp.weixin.qq.com/s…).
 *
 * The article body lives in `<div id="js_content">`; images are lazy-loaded
 * with the real URL in `data-src` (the converter already prefers it). Title
 * comes from og:title, the account name from `#js_name` / og:article:author.
 *
 * WeChat serves a human-verification interstitial to datacenter IPs and cold
 * clients. That page has NO js_content — it must produce a loud, actionable
 * error, not a silently-captured blank entry (handoff hard rule).
 */
import type { IngestAdapter, IngestContext, IngestedContent } from "../types.js";
import { parseHtml, elementToMarkdown, type HtmlElement, type HtmlNode } from "../html-to-md.js";
import { extractProvenance } from "../provenance.js";

function isElement(n: HtmlNode): n is HtmlElement {
  return typeof n !== "string";
}

export function findById(el: HtmlElement, id: string): HtmlElement | null {
  for (const n of el.children) {
    if (!isElement(n)) continue;
    if (n.attrs.id === id) return n;
    const found = findById(n, id);
    if (found) return found;
  }
  return null;
}

function textOf(el: HtmlElement): string {
  let out = "";
  for (const n of el.children) out += isElement(n) ? textOf(n) : n;
  return out.replace(/\s+/g, " ").trim();
}

const VERIFY_MARKERS = /环境异常|完成验证|访问过于频繁|去验证|weui-msg|js_verify/;

async function fetchWechat(url: URL, ctx: IngestContext): Promise<IngestedContent> {
  const res = await ctx.fetchImpl(url.toString());
  if (!res.ok) throw new Error(`WeChat fetch failed: HTTP ${res.status}`);
  const html = await res.text();
  const root = parseHtml(html);
  const content = findById(root, "js_content");

  if (!content) {
    if (VERIFY_MARKERS.test(html)) {
      throw new Error(
        "微信返回了验证页（环境异常），没有拿到正文。请在手机上打开这条分享链接、" +
          "全选复制正文，然后用 kb_add 粘贴保存 —— 标题和链接我可以帮你补上。",
      );
    }
    throw new Error(
      "这个公众号页面里没有找到正文（js_content）——可能已被删除或需要登录。" +
        "可以把正文粘贴给我用 kb_add 保存。",
    );
  }

  const prov = extractProvenance(html);
  const account =
    (() => {
      const el = findById(root, "js_name");
      return el ? textOf(el) : undefined;
    })() ?? prov.author;

  // Epoch publish time lives in inline JS when the meta tag is absent.
  const published =
    prov.published ??
    (() => {
      const m = /var\s+ct\s*=\s*["'](\d{9,11})["']/.exec(html);
      return m ? new Date(Number(m[1]) * 1000).toISOString() : undefined;
    })();

  const extra: Record<string, string> = { site: "微信公众号" };
  if (account) extra.author = account;
  if (published) extra.published = published;

  return { body: elementToMarkdown(content), title: prov.title, extra };
}

export const wechatAdapter: IngestAdapter = {
  name: "wechat",
  match: (url) => url.hostname === "mp.weixin.qq.com" && url.pathname.startsWith("/s"),
  fetch: fetchWechat,
};
