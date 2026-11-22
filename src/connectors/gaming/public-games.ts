import { readResponseTextCapped } from "../../tools/web_fetch.js";
import { ConnectorError } from "../types.js";

type Provider = "igdb" | "itad";
const igdbFields = ["name", "url", "version_title", "platforms.name", "first_release_date"];
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const numericId = /^[1-9]\d{0,9}$/;
const itad = "https://api.isthereanydeal.com";
const igdb = "https://api.igdb.com/v4";

function fail(code: string, status: number): never {
  throw new ConnectorError(code, status);
}
function invalid(): never {
  return fail("public_games_invalid_input", 400);
}
function badResponse(): never {
  return fail("public_games_invalid_response", 502);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return badResponse();
  return value as Record<string, unknown>;
}
function list(value: unknown) {
  if (!Array.isArray(value)) return badResponse();
  return value.map(object);
}
function label(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 700 || /\p{Cc}/u.test(value))
    return badResponse();
  return value;
}
function httpsLink(value: unknown, domains?: readonly string[]) {
  if (typeof value !== "string" || value.length > 4096 || /[\s\\]/u.test(value))
    return badResponse();
  const url = URL.canParse(value) ? new URL(value) : undefined;
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    (domains && !domains.includes(url.hostname))
  )
    return badResponse();
  // The price provider requires its original tracking/affiliate link and query.
  return value;
}

interface Money {
  amount: number;
  currency: string;
}
function money(raw: unknown): Money {
  const { amount, currency } = object(raw);
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    typeof currency !== "string" ||
    !/^[A-Z]{3}$/.test(currency)
  )
    return badResponse();
  return { amount, currency };
}
// ISO 3166-1 alpha-2 codes from the public-domain tzdata iso3166.tab. The API expects
// a country, while Intl.DisplayNames also accepts territories such as EU and unknown regions.
const countries = new Set(
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(
    " ",
  ),
);
function region(country: unknown) {
  if (typeof country !== "string" || !countries.has(country.toUpperCase())) return invalid();
  return country.toUpperCase();
}
function isoDate(raw: unknown) {
  if (typeof raw !== "string" || !Number.isFinite(Date.parse(raw))) return badResponse();
  return raw;
}
function igdbGame(raw: Record<string, unknown>) {
  if (!Number.isSafeInteger(raw.id) || !numericId.test(String(raw.id))) return badResponse();
  let releaseDate: string | undefined;
  if (raw.first_release_date !== undefined) {
    if (
      typeof raw.first_release_date !== "number" ||
      !Number.isSafeInteger(raw.first_release_date) ||
      Math.abs(raw.first_release_date) > 253402300799
    )
      return badResponse();
    releaseDate = new Date(raw.first_release_date * 1000).toISOString().slice(0, 10);
  }
  return {
    id: String(raw.id),
    title: label(raw.name),
    version: raw.version_title ? label(raw.version_title) : undefined,
    platforms: list(raw.platforms ?? []).map((p) => label(p.name)),
    releaseDate,
    url: raw.url ? httpsLink(raw.url, ["www.igdb.com", "igdb.com"]) : undefined,
  };
}
function itadGame(raw: Record<string, unknown>) {
  if (typeof raw.id !== "string" || !uuid.test(raw.id)) return badResponse();
  return {
    id: raw.id,
    title: label(raw.title),
    slug: label(raw.slug),
    type: raw.type ? label(raw.type) : undefined,
  };
}
function offer(row: Record<string, unknown>) {
  return {
    shop: label(object(row.shop).name),
    price: money(row.price),
    regular: money(row.regular),
    updatedAt: isoDate(row.timestamp),
    url: httpsLink(row.url),
    voucher: row.voucher ? label(row.voucher) : undefined,
    platforms: list(row.platforms ?? []).map((platform) => label(platform.name)),
  };
}
type Query =
  | { provider: Provider; action: "search"; title: string }
  | { provider: Provider; action: "steam"; appId: string }
  | { provider: "igdb"; action: "details"; id: string }
  | { provider: "itad"; action: "details" | "history"; id: string; country: string };
function parse(raw: unknown): Query {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
  const o = raw as Record<string, unknown>;
  const { provider, action, id } = o;
  if (provider !== "igdb" && provider !== "itad") return invalid();
  const fields =
    action === "search"
      ? ["title"]
      : action === "steam"
        ? ["appId"]
        : provider === "igdb"
          ? ["id"]
          : ["id", "country"];
  if (Object.keys(o).some((key) => !["provider", "action", ...fields].includes(key)))
    return invalid();
  if (action === "search") {
    if (
      typeof o.title !== "string" ||
      !o.title.trim() ||
      o.title.length > 140 ||
      /\p{Cc}/u.test(o.title)
    )
      return invalid();
    return { provider, action, title: o.title.trim() };
  }
  if (action === "steam") {
    if (typeof o.appId !== "string" || !numericId.test(o.appId) || Number(o.appId) > 4294967295)
      return invalid();
    return { provider, action, appId: o.appId };
  }
  if (typeof id !== "string") return invalid();
  if (provider === "itad" && (action === "details" || action === "history") && uuid.test(id))
    return { provider, action, id: id.toLowerCase(), country: region(o.country) };
  if (provider === "igdb" && action === "details" && numericId.test(id))
    return { provider, action, id };
  return invalid();
}

function retryUntil(value: string | null, now: number) {
  if (value && /^\d+$/.test(value)) return now + Number(value) * 1000;
  const date = Date.parse(value ?? "");
  return Number.isFinite(date) && date > now ? date : now + 1000;
}

/** Public catalog and price lookup. Only explicit selections/query strings go upstream. */
export class PublicGames {
  private appToken?: { value: string; until: number };
  private refreshing?: Promise<string>;
  private igdbStarts: number[] = [];
  private active = 0;
  private retryAfter = { igdb: 0, itad: 0 };
  private prices = new Map<
    string,
    { until: number; data: Awaited<ReturnType<PublicGames["quotes"]>> }
  >();

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}
  configured() {
    return {
      igdb: Boolean(
        this.env.LISA_IGDB_CLIENT_ID?.trim() && this.env.LISA_IGDB_CLIENT_SECRET?.trim(),
      ),
      itad: Boolean(this.env.LISA_ITAD_API_KEY?.trim()),
    };
  }

  private async json(
    provider: Provider,
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (this.retryAfter[provider] > this.now()) return fail("public_games_rate_limited", 429);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
    try {
      const res = await this.request(url, { ...init, redirect: "error", signal: deadline });
      if (!res.ok) {
        await res.body?.cancel();
        if (res.status === 429) {
          this.retryAfter[provider] = Math.max(
            this.retryAfter[provider],
            retryUntil(res.headers.get("retry-after"), this.now()),
          );
          return fail("public_games_rate_limited", 429);
        }
        if ([401, 403].includes(res.status)) return fail("public_games_access_denied", 403);
        if (res.status === 404) return fail("public_games_not_found", 404);
        return fail("public_games_unavailable", 502);
      }
      const data = await readResponseTextCapped(res, 512_000);
      if (data.truncated) return badResponse();
      try {
        return JSON.parse(data.text) as unknown;
      } catch {
        return badResponse();
      }
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      return fail(
        signal.aborted ? "request_cancelled" : "public_games_unavailable",
        signal.aborted ? 409 : 502,
      );
    }
  }

  private async token(signal: AbortSignal) {
    if (this.appToken && this.appToken.until > this.now()) return this.appToken.value;
    if (!this.refreshing) {
      // A shared refresh has its own deadline. Cancelling one lookup must not break the others.
      this.refreshing = this.json(
        "igdb",
        "https://id.twitch.tv/oauth2/token",
        {
          method: "POST",
          body: new URLSearchParams({
            client_id: this.env.LISA_IGDB_CLIENT_ID!,
            client_secret: this.env.LISA_IGDB_CLIENT_SECRET!,
            grant_type: "client_credentials",
          }),
        },
        AbortSignal.timeout(12_000),
      )
        .then((raw) => {
          const row = object(raw);
          if (
            typeof row.access_token !== "string" ||
            !/^[\w.~-]{1,4096}$/.test(row.access_token) ||
            typeof row.expires_in !== "number" ||
            !Number.isFinite(row.expires_in) ||
            row.expires_in <= 0 ||
            row.token_type !== "bearer"
          )
            return badResponse();
          this.appToken = {
            value: row.access_token,
            until: this.now() + Math.max(0, row.expires_in - 60) * 1000,
          };
          return row.access_token;
        })
        .finally(() => {
          this.refreshing = undefined;
        });
    }
    const token = await this.refreshing;
    if (signal.aborted) return fail("request_cancelled", 409);
    return token;
  }

  private async metadata(
    query: Extract<Query, { provider: "igdb" }> | Extract<Query, { action: "search" | "steam" }>,
    signal: AbortSignal,
  ) {
    const token = await this.token(signal);
    const now = this.now();
    this.igdbStarts = this.igdbStarts.filter((t) => now - t < 1000);
    if (this.active >= 8 || this.igdbStarts.length >= 4)
      return fail("public_games_rate_limited", 429);
    this.igdbStarts.push(now);
    this.active++;
    try {
      let path = "games",
        body: string;
      if (query.action === "steam") {
        path = "external_games";
        body =
          "fields " +
          igdbFields.map((f) => "game." + f).join(",") +
          '; where external_game_source.name = "Steam" & uid = "' +
          query.appId +
          '"; limit 15;';
      } else {
        // Double quotes and backslashes are query-language delimiters. Search the remaining title words.
        const title =
          query.action === "search" ? query.title.replace(/["\\]/g, " ").trim() : undefined;
        if (title === "") return invalid();
        const filter =
          query.action === "details" ? "where id = " + query.id : 'search "' + title + '"';
        body =
          "fields " +
          igdbFields.join(",") +
          "; " +
          filter +
          "; limit " +
          (query.action === "details" ? 1 : 15) +
          ";";
      }
      const raw = await this.json(
        "igdb",
        igdb + "/" + path,
        {
          method: "POST",
          headers: {
            "Client-ID": this.env.LISA_IGDB_CLIENT_ID!,
            Authorization: "Bearer " + token,
            Accept: "application/json",
          },
          body,
        },
        signal,
      );
      const games = list(raw).map((r) => igdbGame(query.action === "steam" ? object(r.game) : r));
      if (query.action === "details" && (games.length !== 1 || games[0]?.id !== query.id))
        return fail("public_games_not_found", 404);
      return {
        provider: "igdb" as const,
        source: "https://www.igdb.com/",
        games,
        retrievedAt: new Date(this.now()).toISOString(),
      };
    } catch (error) {
      if (
        error instanceof ConnectorError &&
        error.code === "public_games_access_denied" &&
        this.appToken?.value === token
      )
        this.appToken = undefined;
      throw error;
    } finally {
      this.active--;
    }
  }

  private itadRequest(
    path: string,
    params: Record<string, string>,
    signal: AbortSignal,
    ids?: string[],
  ) {
    const headers: Record<string, string> = {
      "ITAD-API-Key": this.env.LISA_ITAD_API_KEY!,
      Accept: "application/json",
    };
    if (ids) headers["Content-Type"] = "application/json";
    return this.json(
      "itad",
      itad + path + "?" + new URLSearchParams(params),
      { method: ids ? "POST" : "GET", headers, body: ids ? JSON.stringify(ids) : undefined },
      signal,
    );
  }
  private async quotes(id: string, country: string, signal: AbortSignal) {
    const data = list(
      await this.itadRequest("/games/prices/v3", { country, vouchers: "false" }, signal, [id]),
    );
    if (data.length > 1 || (data.length === 1 && data[0]!.id !== id)) return badResponse();
    const row = data[0];
    const low = row ? object(row.historyLow).all : null;
    return {
      provider: "itad" as const,
      source: "https://isthereanydeal.com/",
      id,
      country,
      offers: row ? list(row.deals).map(offer) : [],
      historicalLow: low == null ? null : money(low),
      retrievedAt: new Date(this.now()).toISOString(),
    };
  }

  async query(input: unknown, signal: AbortSignal) {
    const q = parse(input);
    if (signal.aborted) return fail("request_cancelled", 409);
    if (!this.configured()[q.provider]) return fail("public_games_not_configured", 503);
    if (q.provider === "igdb") return this.metadata(q, signal);
    const source = "https://isthereanydeal.com/";
    if (q.action === "search" || q.action === "steam") {
      let games;
      if (q.action === "search") {
        const rows = list(
          await this.itadRequest("/games/search/v1", { title: q.title, results: "15" }, signal),
        );
        games = rows.map(itadGame);
      } else {
        const result = object(
          await this.itadRequest("/games/lookup/v1", { appid: q.appId }, signal),
        );
        if (typeof result.found !== "boolean") return badResponse();
        games = result.found ? [itadGame(object(result.game))] : [];
      }
      return {
        provider: "itad" as const,
        source,
        games,
        retrievedAt: new Date(this.now()).toISOString(),
      };
    }
    if (q.action === "history") {
      const events = list(
        await this.itadRequest("/games/history/v2", { id: q.id, country: q.country }, signal),
      )
        .map((row) => {
          const deal = row.deal === null ? null : object(row.deal);
          return {
            timestamp: isoDate(row.timestamp),
            shop: label(object(row.shop).name),
            price: deal ? money(deal.price) : null,
          };
        })
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
      return {
        provider: "itad" as const,
        source,
        id: q.id,
        country: q.country,
        history: events.slice(0, 20),
        truncated: events.length > 20,
        retrievedAt: new Date(this.now()).toISOString(),
      };
    }
    const key = q.country + "/" + q.id;
    const cached = this.prices.get(key);
    if (cached && cached.until > this.now()) return cached.data;
    const data = await this.quotes(q.id, q.country, signal);
    if (this.prices.size >= 64) this.prices.delete(this.prices.keys().next().value!);
    this.prices.set(key, { data, until: this.now() + 60_000 });
    return data;
  }
}
