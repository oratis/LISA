import {
  pinnedTransport,
  resolvePublicAddresses,
  readResponseTextCapped,
  withDeadline,
  type SafeFetchDependencies,
} from "../tools/web_fetch.js";
import { ConnectorError } from "./types.js";
export const FEISHU_API = "https://open.feishu.cn";
export const FEISHU_ACCOUNTS = "https://accounts.feishu.cn";
export const FEISHU_SCOPES = ["docx:document:readonly", "offline_access"] as const;
export function assertFeishuScopes(value: unknown): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    new Set(value).size !== value.length ||
    !FEISHU_SCOPES.every((s) => value.includes(s)) ||
    value.some((s) => !FEISHU_SCOPES.includes(s) && s !== "user_profile")
  )
    throw new ConnectorError("feishu_read_scope_required");
}
export const feishuDocumentId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9]{15,100}$/.test(v);
export function feishuEndpointAllowed(url: URL, method: string) {
  if (
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.search ||
    url.protocol !== "https:"
  )
    return false;
  if (url.origin === FEISHU_ACCOUNTS)
    return method === "POST" && ["/oauth/v3/token", "/oauth/v1/revoke"].includes(url.pathname);
  if (url.origin !== FEISHU_API || method !== "GET") return false;
  return (
    url.pathname === "/open-apis/authen/v1/user_info" ||
    /^\/open-apis\/docx\/v1\/documents\/[A-Za-z0-9]{15,100}(?:\/raw_content)?$/.test(url.pathname)
  );
}
export type FeishuHttp = (
  url: string,
  signal: AbortSignal,
  init?: { token?: string; form?: Record<string, string> },
) => Promise<Record<string, unknown>>;
export function feishuHttp(
  network?: Pick<SafeFetchDependencies, "lookup" | "transport">,
): FeishuHttp {
  return async (raw, signal, init = {}) => {
    try {
      return await withDeadline(signal, 30000, async (deadline) => {
        const url = new URL(raw),
          method = init.form ? "POST" : "GET";
        if (!feishuEndpointAllowed(url, method))
          throw new ConnectorError("feishu_invalid_endpoint");
        const addresses = await resolvePublicAddresses(url.hostname, network?.lookup);
        deadline!.throwIfAborted();
        const response = await (network?.transport ?? pinnedTransport)(
          url.href,
          {
            method,
            redirect: "manual",
            signal: deadline,
            headers: {
              Accept: "application/json",
              "Content-Type": init.form
                ? "application/x-www-form-urlencoded"
                : "application/json; charset=utf-8",
              ...(init.token ? { Authorization: "Bearer " + init.token } : {}),
            },
            ...(init.form ? { body: new URLSearchParams(init.form).toString() } : {}),
          },
          addresses[0]!,
        );
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new ConnectorError("feishu_request_failed");
        }
        if (response.status === 429) {
          await response.body?.cancel();
          throw new ConnectorError("feishu_rate_limited");
        }
        const body = await readResponseTextCapped(response, 1_000_000);
        if (body.truncated) throw new ConnectorError("feishu_response_too_large");
        if (url.pathname === "/oauth/v1/revoke" && response.status === 200 && !body.text.trim())
          return {};
        const value: unknown = JSON.parse(body.text);
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new ConnectorError("feishu_invalid_response");
        const r = value as Record<string, unknown>;
        if (!response.ok || r.code !== 0) {
          const code = Number(r.code);
          throw new ConnectorError(
            [
              20003, 20004, 20005, 20008, 20021, 20022, 20023, 20026, 20037, 20064, 20065, 20066,
              20073,
            ].includes(code) || response.status === 401
              ? "feishu_reauthorization_required"
              : [20027, 20067, 20068, 99991679].includes(code)
                ? "feishu_read_scope_required"
                : [20009, 20010, 20069, 20074, 1770032].includes(code) || response.status === 403
                  ? "feishu_access_denied"
                  : [1770002, 1770003].includes(code) || response.status === 404
                    ? "feishu_document_unavailable"
                    : code === 1770033
                      ? "feishu_response_too_large"
                      : code === 99991400
                        ? "feishu_rate_limited"
                        : "feishu_request_failed",
          );
        }
        return r;
      });
    } catch (e) {
      if (e instanceof ConnectorError) throw e;
      throw new ConnectorError(signal.aborted ? "request_cancelled" : "feishu_unavailable");
    }
  };
}
