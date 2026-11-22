// Owner-initiated public lookups. This panel never reads the chat, account, or personal game library.
window.lisaOpenPublicGames = async function () {
  const t = (en, zh) => (LISA_LOCALE === "zh-CN" ? zh : en);
  const title = t("Game information and prices", "游戏资料与价格");
  openModal(title, "");
  const revision = modalRevision;
  const node = githubNode;
  const form = document.createElement("form");
  form.className = "skill-form";
  const source = document.createElement("select");
  function option(select, value, text) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    select.append(opt);
  }
  option(source, "igdb", t("Game information · IGDB", "游戏资料 · IGDB"));
  option(source, "itad", t("Store prices · IsThereAnyDeal", "商店价格 · IsThereAnyDeal"));
  const query = document.createElement("input");
  query.required = true;
  query.maxLength = 140;
  query.autocomplete = "off";
  const country = document.createElement("input");
  country.placeholder = t("Two-letter code, e.g. US", "两位国家或地区代码，例如 CN");
  country.maxLength = 2;
  country.pattern = "[A-Za-z]{2}";
  country.autocomplete = "off";
  function field(text, control) {
    const label = document.createElement("label");
    label.append(node("span", text), control);
    return label;
  }
  const regionField = field(t("Price region", "查价地区"), country);
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "github-button primary";
  submit.textContent = t("Search", "搜索");
  const configNote = node("p", "", "dc-caption");
  const status = node("p", "", "dc-caption");
  status.setAttribute("role", "status");
  const results = node("div");
  const attribution = document.createElement("a");
  attribution.target = "_blank";
  attribution.rel = "noopener noreferrer";
  form.append(
    field(t("Source", "数据来源"), source),
    field(t("Game title or Steam App ID", "游戏名称或 Steam App ID"), query),
    regionField,
    configNote,
    submit,
  );
  modalBody.append(form, status, results, attribution);
  let config = { igdb: false, itad: false };
  let action;
  let candidates;
  let configurationRequest;
  let loaded = false;
  let chosenSource = false;
  const retryConfiguration = button(
    t("Retry loading sources", "重新加载数据源"),
    () => void loadConfig(),
  );
  function cancel() {
    action?.abort();
    action = undefined;
  }
  const observer = new MutationObserver(() => {
    if (revision !== modalRevision || !modalBg.classList.contains("open") || !form.isConnected) {
      cancel();
      configurationRequest?.abort();
      observer.disconnect();
    }
  });
  observer.observe(modalBg, { attributes: true, attributeFilter: ["class"] });
  observer.observe(modalBody, { childList: true });
  function reset() {
    cancel();
    status.textContent = "";
    candidates = undefined;
    results.replaceChildren();
  }
  function renderControls() {
    const prices = source.value === "itad";
    if (prices) form.insertBefore(regionField, configNote);
    else regionField.remove();
    country.disabled = !prices;
    country.required = false;
    submit.disabled = !config[source.value];
    attribution.href = prices ? "https://isthereanydeal.com/" : "https://www.igdb.com/";
    attribution.textContent = prices ? "IsThereAnyDeal" : "IGDB";
    if (!loaded) {
      configNote.textContent = tr("panel.loading");
    } else if (config[source.value]) {
      configNote.textContent = t(
        "Only the entered title or public game ID goes to this source. Quotes also use your price region.",
        "仅向所选来源发送输入的名称或公开游戏 ID。查价时还会发送所选地区。",
      );
    } else {
      configNote.textContent = prices
        ? t(
            "Set LISA_ITAD_API_KEY on this host to look up prices.",
            "请在本机配置 LISA_ITAD_API_KEY 以查询报价。",
          )
        : t(
            "Set LISA_IGDB_CLIENT_ID and LISA_IGDB_CLIENT_SECRET on this host to search IGDB.",
            "请在本机配置 LISA_IGDB_CLIENT_ID 和 LISA_IGDB_CLIENT_SECRET 以查询 IGDB。",
          );
    }
  }
  const messages = {
    public_games_rate_limited: t(
      "The source has reached its rate limit. Try again later.",
      "数据源已达请求配额，请稍后重试。",
    ),
    public_games_access_denied: t(
      "The source rejected the application credentials. Check the host configuration.",
      "数据源拒绝了应用凭据，请检查本机配置。",
    ),
    public_games_not_configured: t(
      "Configure the selected source on this host.",
      "请先在本机配置所选来源。",
    ),
    public_games_invalid_input: t(
      "Check the game name, ID, and two-letter price region.",
      "请检查游戏名称、ID 和两位地区代码。",
    ),
    public_games_not_found: t(
      "This game is no longer available from this source.",
      "数据源已无法提供这款游戏的信息。",
    ),
  };
  async function request(body, render) {
    cancel();
    const current = new AbortController();
    action = current;
    status.textContent = tr("panel.loading");
    try {
      const response = await fetch("/api/games/public", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: current.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (current.signal.aborted || revision !== modalRevision) return;
      status.textContent = "";
      render(data);
    } catch (error) {
      if (current.signal.aborted || revision !== modalRevision) return;
      status.textContent =
        messages[error.message] ||
        t("The source could not complete this lookup. Try again.", "数据源未能完成查询，请重试。");
    }
  }
  function button(text, click) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.className = "github-button";
    b.addEventListener("click", click);
    return b;
  }
  function link(text, url) {
    const a = document.createElement("a");
    a.textContent = text;
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }
  function details(game) {
    return [game.version, game.type, game.releaseDate, ...(game.platforms || [])]
      .filter(Boolean)
      .join(" · ");
  }
  const cash = (price) => price.amount + " " + price.currency;
  function renderPrices(data, game) {
    results.replaceChildren(
      button(t("Back to matches", "返回匹配结果"), () => {
        cancel();
        status.textContent = "";
        if (candidates) matches(candidates);
      }),
      node("h3", game.title),
    );
    results.append(
      node(
        "p",
        data.country +
          " · " +
          t("Retrieved ", "获取时间 ") +
          new Date(data.retrievedAt).toLocaleString(LISA_LOCALE),
        "dc-caption",
      ),
    );
    // Compare offers within each currency. ITAD has already scoped these shops to the chosen country.
    const lowest = new Map();
    for (const offer of data.offers) {
      const best = lowest.get(offer.price.currency);
      if (!best || offer.price.amount < best.price.amount)
        lowest.set(offer.price.currency, { price: offer.price, shops: new Set([offer.shop]) });
      else if (offer.price.amount === best.price.amount) best.shops.add(offer.shop);
    }
    for (const best of lowest.values())
      results.append(
        node(
          "p",
          t("Current low across covered stores", "已覆盖商店的当前最低价") +
            " · " +
            cash(best.price) +
            " · " +
            [...best.shops].join(", "),
        ),
      );
    if (data.historicalLow)
      results.append(
        node(
          "p",
          t("Historical low across covered stores", "已覆盖商店的历史最低价") +
            " · " +
            cash(data.historicalLow),
        ),
      );
    if (!data.offers.length)
      results.append(node("p", t("No current offers for this region.", "此地区暂无报价。")));
    for (const offer of data.offers) {
      const row = node("div", "", "item");
      row.append(
        link(offer.shop + " · " + cash(offer.price), offer.url),
        node(
          "p",
          t("Regular price", "原价") +
            " " +
            cash(offer.regular) +
            " · " +
            t("Updated", "更新时间") +
            " " +
            new Date(offer.updatedAt).toLocaleString(LISA_LOCALE),
          "desc",
        ),
      );
      if (offer.platforms.length) row.append(node("p", offer.platforms.join(" · "), "desc"));
      if (offer.voucher)
        row.append(node("p", t("Voucher", "优惠券") + " · " + offer.voucher, "desc"));
      results.append(row);
    }
    const history = node("div");
    const show = button(t("Show recent price changes", "查看近期价格变动"), () => {
      void request(
        { provider: "itad", action: "history", country: data.country, id: data.id },
        (rows) => {
          history.replaceChildren();
          show.remove();
          history.append(node("h4", t("Price changes · last 3 months", "近三个月价格变动")));
          if (rows.truncated)
            history.append(
              node("p", t("Showing the latest 20 changes.", "显示最近 20 条记录。"), "desc"),
            );
          if (!rows.history.length)
            history.append(node("p", t("No changes recorded.", "暂无变动记录。")));
          for (const event of rows.history)
            history.append(
              node(
                "p",
                new Date(event.timestamp).toLocaleDateString(LISA_LOCALE) +
                  " · " +
                  event.shop +
                  " · " +
                  (event.price ? cash(event.price) : t("Offer ended", "报价结束")),
              ),
            );
        },
      );
    });
    results.append(show, history);
  }
  function matches(data) {
    candidates = data;
    results.replaceChildren();
    if (!data.games.length) {
      status.textContent = t("No matching games.", "未找到匹配的游戏。");
      return;
    }
    for (const game of data.games) {
      const row = node("div", "", "item");
      if (data.provider === "igdb") {
        row.append(game.url ? link(game.title, game.url) : node("strong", game.title));
      } else {
        row.append(
          button(game.title, () => {
            country.setCustomValidity(
              country.value.trim()
                ? ""
                : t("Enter a two-letter price region.", "请输入两位地区代码。"),
            );
            if (!country.reportValidity()) {
              country.focus();
              return;
            }
            void request(
              {
                provider: "itad",
                action: "details",
                id: game.id,
                country: country.value.trim().toUpperCase(),
              },
              (data) => renderPrices(data, game),
            );
          }),
        );
      }
      const duplicate = data.games.some(
        (other) => other.id !== game.id && other.title === game.title,
      );
      const extra = [details(game), duplicate && (game.slug || game.id)]
        .filter(Boolean)
        .join(" · ");
      if (extra) row.append(node("p", extra, "desc"));
      results.append(row);
    }
  }
  source.addEventListener("change", () => {
    chosenSource = true;
    reset();
    country.setCustomValidity("");
    renderControls();
  });
  query.addEventListener("input", reset);
  country.addEventListener("input", () => {
    cancel();
    country.setCustomValidity("");
    status.textContent = "";
    if (candidates) matches(candidates);
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (submit.disabled || !form.reportValidity()) return;
    reset();
    const term = query.value.trim();
    // Explicit steam: prefix distinguishes public App IDs from titles such as "1984".
    const app = /^steam:\s*(\d+)$/i.exec(term);
    void request(
      app
        ? { provider: source.value, action: "steam", appId: app[1] }
        : { provider: source.value, action: "search", title: term },
      matches,
    );
  });
  query.placeholder = t("Game title or steam:440", "游戏名称或 steam:440");
  renderControls();
  async function loadConfig() {
    configurationRequest?.abort();
    const current = new AbortController();
    configurationRequest = current;
    retryConfiguration.remove();
    configNote.textContent = tr("panel.loading");
    try {
      const response = await fetch("/api/games/public", { signal: current.signal });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (typeof data.igdb !== "boolean" || typeof data.itad !== "boolean") throw new Error();
      if (current.signal.aborted || revision !== modalRevision) return;
      config = data;
      loaded = true;
      if (!chosenSource && !data.igdb && data.itad) source.value = "itad";
      renderControls();
    } catch {
      if (current.signal.aborted || revision !== modalRevision) return;
      configNote.textContent = t(
        "Could not load the configured sources.",
        "未能加载本机数据源配置。",
      );
      configNote.after(retryConfiguration);
    }
  }
  query.focus();
  await loadConfig();
};
