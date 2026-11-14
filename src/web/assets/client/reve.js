(function () {
  "use strict";
  const zh = () => (document.documentElement.lang || navigator.language || "").startsWith("zh");
  const esc = (value) =>
    String(value == null ? "" : value).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  const number = (n) => Number(n || 0).toLocaleString(zh() ? "zh-CN" : "en-US");
  const when = (at) => {
    const date = new Date(at);
    return Number.isFinite(date.getTime())
      ? date.toLocaleString(zh() ? "zh-CN" : "en-US", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "—";
  };
  let root,
    data,
    days = "7",
    generation = 0,
    reflecting = false;
  const pendingRestores = new Set();
  async function request(url, options) {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "request_failed");
    return body;
  }
  function status(message, error) {
    const node = root && root.querySelector("#reveStatus");
    if (node) {
      node.textContent = message;
      node.classList.toggle("rv-error", !!error);
    }
  }
  const empty = (text) => '<p class="rv-empty">' + esc(text) + "</p>";
  const kind = (value) =>
    ({
      reflect: tr("reve.conversation.reflection"),
      idle: tr("reve.quiet.time.work"),
      heartbeat: tr("reve.scheduled.work"),
      desire: tr("reve.a.personal.pursuit"),
      "desire-review": tr("reve.reviewing.priorities"),
      examen: tr("reve.weekly.reflection"),
    })[value] || value;
  const outcome = (value) =>
    ({
      done: tr("reve.completed"),
      "no-update": tr("reve.no.change.needed"),
      blocked: tr("reve.paused.by.a.limit"),
      error: tr("reve.needs.attention"),
    })[value] || value;
  function meter(label, store) {
    if (!store || store.bytes === null)
      return '<div class="rv-meter"><span>' + esc(label) + "</span><span>—</span></div>";
    return (
      '<div class="rv-meter"><div><span>' +
      esc(label) +
      "</span><span>" +
      number(store.bytes) +
      " / " +
      number(store.limit) +
      ' B</span></div><progress max="' +
      store.limit +
      '" value="' +
      Math.min(store.bytes, store.limit) +
      '" aria-label="' +
      esc(label) +
      '"></progress></div>'
    );
  }
  const label = (key, vars) => esc(tr("reve." + key, vars));
  const jsonPost = (body) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const dreamRoute = (id) => "/api/reve/dreams/" + encodeURIComponent(id);

  function dreamSection() {
    return (
      '<section class="rv-card rv-dreams"><details data-dream-log><summary>' +
      label("dreamLog") +
      '</summary><div class="rv-dream-list"></div></details></section>'
    );
  }

  async function loadDreamList(details) {
    if (!details.open || details.dataset.loaded) return;
    const target = details.querySelector(".rv-dream-list");
    target.innerHTML = empty(tr("reve.loading"));
    details.dataset.loaded = "loading";
    try {
      const listing = await request("/api/reve/dreams?limit=20");
      if (!details.isConnected) return;
      const cutoff = Date.parse(data.generatedAt) - Number(days) * 86400000;
      const dreams = listing.dreams.filter((dream) => Date.parse(dream.windowEnd) >= cutoff);
      target.innerHTML =
        (listing.pendingReconsider
          ? "<p>" + label("pendingNotes", { n: listing.pendingReconsider }) + "</p>"
          : "") +
        (listing.corrupt.length ? '<p class="rv-notice">' + label("corruptDreams") + "</p>" : "") +
        (dreams
          .map(
            (dream) =>
              '<details class="rv-dream-record" data-dream="' +
              esc(dream.id) +
              '"><summary>' +
              esc(kind(dream.trigger)) +
              " · " +
              esc(when(dream.windowEnd)) +
              "</summary><p>" +
              esc(dream.summary) +
              '</p><div class="rv-dream-detail"></div></details>',
          )
          .join("") || empty(tr("reve.noDreams")));
      details.dataset.loaded = "true";
    } catch (_) {
      delete details.dataset.loaded;
      target.innerHTML = empty(tr("reve.detail.loadError"));
    }
  }

  async function loadDreamDetail(details) {
    if (!details.open || details.dataset.loaded) return;
    const target = details.querySelector(".rv-dream-detail");
    target.innerHTML = empty(tr("reve.loading"));
    details.dataset.loaded = "loading";
    try {
      const { dream, reconsider } = await request(dreamRoute(details.dataset.dream));
      if (!details.isConnected) return;
      const changes = dream.changes
        .map(
          (change) =>
            "<details><summary>" +
            esc(change.path) +
            "</summary><pre>" +
            esc(change.diff) +
            "</pre></details>",
        )
        .join("");
      const commits = dream.soulCommits
        .map(
          (commit) =>
            "<details><summary>" +
            esc(commit.subject) +
            "</summary><pre>" +
            esc(commit.diff) +
            "</pre></details>",
        )
        .join("");
      const parts = new Set(
        dream.changes
          .filter((change) => change.revertible && change.part !== "soul")
          .map((change) => change.part),
      );
      const revertButtons = ["memory", "kb", "skills"]
        .filter((part) => parts.has(part))
        .map(
          (part) =>
            '<button type="button" class="rv-button" data-dream-revert="' +
            part +
            '">' +
            label("revert." + part) +
            "</button>",
        )
        .join(" ");
      const canReconsider = commits || dream.changes.some((change) => change.part === "soul");
      const notes = reconsider
        .map((note) => "<p>" + label("note." + note.status) + " · " + esc(note.note) + "</p>")
        .join("");
      const form =
        '<form class="rv-reconsider"><label>' +
        label("reconsiderLabel") +
        '<textarea required maxlength="2000" rows="2"></textarea></label><button type="submit" class="rv-button">' +
        label("sendNote") +
        "</button></form>";
      target.innerHTML =
        changes +
        commits +
        (data.canRestore ? '<div class="rv-dream-actions">' + revertButtons + "</div>" : "") +
        (dream.reverts.length
          ? "<p>" + label("revertsRecorded", { n: dream.reverts.length }) + "</p>"
          : "") +
        notes +
        (data.canRestore && canReconsider ? form : "");
      details.dataset.loaded = "true";
    } catch (_) {
      delete details.dataset.loaded;
      target.innerHTML = empty(tr("reve.detail.loadError"));
    }
  }

  async function actOnDream(details, action, body, button) {
    if (button.disabled) return;
    button.disabled = true;
    try {
      await request(dreamRoute(details.dataset.dream) + "/" + action, jsonPost(body));
      await refresh();
      status(tr(action === "revert" ? "reve.dreamRestored" : "reve.noteQueued"), false);
    } catch (error) {
      const messages = {
        revert_conflict: "dreamConflict",
        queue_full: "queueFull",
        dreams_disabled: "dreamsDisabled",
      };
      status(tr("reve." + (messages[error.message] || "dreamActionError")), true);
      button.disabled = false;
    }
  }

  function agentRecapSection() {
    return (
      '<section class="rv-card"><details data-agent-recap><summary>' +
      label("agentRecap") +
      '</summary><select class="v-sel" aria-label="' +
      label("period") +
      '" data-recap-window>' +
      [2, 8, 24]
        .map(
          (hours) =>
            '<option value="' + hours * 60 + '">' + label("recapHours", { n: hours }) + "</option>",
        )
        .join("") +
      '</select><pre class="rv-recap"></pre></details></section>'
    );
  }

  async function loadAgentRecap(details) {
    if (!details.open) return;
    const select = details.querySelector("[data-recap-window]");
    const minutes = select.value;
    const target = details.querySelector(".rv-recap");
    target.textContent = tr("reve.loading");
    try {
      const recap = await request("/api/agents/recap?sinceMinutes=" + encodeURIComponent(minutes));
      if (details.isConnected && select.value === minutes)
        target.textContent = recap.text || tr("reve.noRecap");
    } catch (_) {
      if (details.isConnected && select.value === minutes)
        target.textContent = tr("reve.recapUnavailable");
    }
  }

  function revisionRows() {
    return data.revisions
      .map(
        (r) =>
          '<details class="rv-revision" data-revision="' +
          esc(r.id) +
          '"><summary><span class="rv-record-icon" aria-hidden="true">' +
          (r.restores ? "↶" : "↗") +
          '</span><span class="rv-record-body"><span class="rv-record-title">' +
          esc(
            r.restores
              ? tr("reve.previous.memory.restored")
              : r.reason || tr("reve.memory.updated"),
          ) +
          '</span><span class="rv-meta">' +
          esc(r.store === "user" ? tr("reve.about.you") : tr("reve.working.memory")) +
          " · " +
          esc(when(r.at)) +
          " · " +
          esc(
            r.status === "prepared"
              ? tr("reve.write.not.confirmed")
              : tr("reve.revision.changeCount", { n: r.changeCount }),
          ) +
          '</span></span><span class="rv-chevron" aria-hidden="true">⌄</span></summary><div class="rv-revision-detail"></div></details>',
      )
      .join("");
  }

  function reflectionRows() {
    return data.reflections
      .slice(0, 4)
      .map(
        (r) =>
          '<article class="rv-reflection"><div class="rv-meta">' +
          esc(when(r.at)) +
          " · " +
          esc(tr("reve.count.updates", { n: r.appliedCount })) +
          "</div><p>" +
          esc(r.summary) +
          "</p>" +
          (r.skipped.length
            ? '<details class="rv-skipped"><summary>' +
              esc(tr("reve.some.updates.were.not.applied")) +
              "</summary><ul>" +
              r.skipped.map((s) => "<li>" + esc(s) + "</li>").join("") +
              "</ul></details>"
            : "") +
          '<button type="button" class="rv-link" data-session="' +
          esc(r.sessionId) +
          '">' +
          esc(tr("reve.open.conversation")) +
          "</button></article>",
      )
      .join("");
  }

  function knowledgePanel() {
    const knowledge = data.knowledge;
    return !knowledge
      ? empty(tr("reve.knowledge.base.information.is.unavailable"))
      : '<div class="rv-kb-counts"><span><b>' +
          number(knowledge.sources) +
          "</b>" +
          esc(tr("reve.sources")) +
          "</span><span><b>" +
          number(knowledge.pages) +
          "</b>" +
          esc(tr("reve.wiki.pages")) +
          "</span></div>" +
          (knowledge.brokenCount || knowledge.orphanCount
            ? '<div class="rv-maintenance"><h4>' +
              esc(tr("reve.worth.tending")) +
              "</h4><p>" +
              esc(
                tr("reve.knowledge.issues", {
                  n: knowledge.brokenCount,
                  n1: knowledge.orphanCount,
                }),
              ) +
              "</p><ul>" +
              knowledge.broken
                .slice(0, 3)
                .map(
                  (b) =>
                    "<li>" +
                    esc(b.from) +
                    ' <span aria-hidden="true">→</span> ' +
                    esc(b.target) +
                    "</li>",
                )
                .join("") +
              knowledge.orphans
                .slice(0, 2)
                .map((o) => "<li>" + esc(o.title) + "</li>")
                .join("") +
              "</ul></div>"
            : empty(knowledge.pages ? tr("reve.knowledge.healthy") : tr("reve.knowledge.empty"))) +
          '<button type="button" class="rv-link" data-view="kb">' +
          esc(tr("reve.explore.knowledge.base")) +
          "</button>";
  }

  function pursuitRows() {
    return data.desires
      .map(
        (d) =>
          '<li><span class="rv-tag">' +
          esc(
            d.needsUser
              ? tr("reve.needs.you")
              : d.actionable
                ? tr("reve.in.progress")
                : tr("reve.exploring"),
          ) +
          "</span><strong>" +
          esc(d.what) +
          "</strong><p>" +
          esc(d.why) +
          "</p></li>",
      )
      .join("");
  }

  function activityRows() {
    return data.runs
      .map(
        (r) =>
          "<li><div><strong>" +
          esc(kind(r.kind)) +
          '</strong><span class="rv-meta">' +
          esc(when(r.at)) +
          '</span></div><div><span class="rv-outcome rv-' +
          esc(r.outcome) +
          '">' +
          esc(outcome(r.outcome)) +
          '</span><span class="rv-meta">' +
          number(r.inputTokens) +
          " " +
          esc(tr("reve.in")) +
          " / " +
          number(r.outputTokens) +
          " " +
          esc(tr("reve.out")) +
          "</span></div>" +
          (r.note ? "<p>" + esc(r.note) + "</p>" : "") +
          "</li>",
      )
      .join("");
  }

  function render() {
    const stats = data.stats,
      usage = stats.usage;
    const cards = [
      [stats.changes, tr("reve.memory.updates")],
      [stats.corrections, tr("reve.corrections.removals")],
      [stats.runs, tr("reve.background.runs")],
      [usage.outputTokens, tr("reve.output.tokens")],
    ];
    const revisions = revisionRows(),
      reflections = reflectionRows();
    const knowledgeHtml = knowledgePanel(),
      desires = pursuitRows(),
      runs = activityRows();
    root.querySelector("#reveContent").innerHTML =
      '<div class="rv-hero"><div><div class="rv-eyebrow">' +
      esc(tr("reve.hero.eyebrow")) +
      "</div><h3>" +
      esc(tr("reve.hero.title")) +
      "</h3><p>" +
      esc(tr("reve.hero.description")) +
      '</p><span class="rv-state ' +
      (data.enabled ? "is-on" : "") +
      '"><i></i>' +
      esc(data.enabled ? tr("reve.proactive.mode.is.on") : tr("reve.proactive.mode.is.paused")) +
      '</span></div><svg class="rv-orbit" viewBox="0 0 180 150" aria-hidden="true"><ellipse cx="90" cy="80" rx="69" ry="37"/><ellipse cx="90" cy="80" rx="48" ry="60" transform="rotate(35 90 80)"/><path d="M107 35a39 39 0 1 0 24 63 34 34 0 0 1-24-63Z"/><circle cx="26" cy="68" r="5"/><circle cx="143" cy="102" r="4"/><circle cx="122" cy="24" r="3"/><path d="m48 23 2 7 7 2-7 2-2 7-2-7-7-2 7-2Z"/></svg></div>' +
      '<div class="rv-stats">' +
      cards
        .map(
          (c) => "<div><strong>" + number(c[0]) + "</strong><span>" + esc(c[1]) + "</span></div>",
        )
        .join("") +
      "</div>" +
      (data.partial.length
        ? '<p class="rv-notice" role="status">' + esc(tr("reve.overview.partial")) + "</p>"
        : "") +
      (data.lastIdleMessage
        ? '<section class="rv-card rv-away"><h3>' +
          esc(tr("reve.while.you.were.away")) +
          "</h3><p>" +
          esc(data.lastIdleMessage) +
          "</p></section>"
        : "") +
      '<div class="rv-grid"><div class="rv-main-column"><section class="rv-card"><div class="rv-card-head"><h3>' +
      esc(tr("reve.memory.refined")) +
      '</h3><button type="button" class="rv-link" data-view="memory">' +
      esc(tr("reve.all.memory")) +
      '</button></div><p class="rv-caption">' +
      esc(tr("reve.revisions.caption")) +
      "</p>" +
      (revisions || empty(tr("reve.revisions.empty"))) +
      "</section>" +
      '<section class="rv-card"><div class="rv-card-head"><h3>' +
      esc(tr("reve.from.recent.conversations")) +
      '</h3><button type="button" class="rv-link" id="reveReflect" ' +
      (!data.reflectionEnabled || reflecting ? "disabled" : "") +
      ">" +
      esc(reflecting ? tr("reve.reflecting") : tr("reve.reflect.on.this.conversation")) +
      "</button></div>" +
      (reflections || empty(tr("reve.reflections.empty"))) +
      (!data.reflectionEnabled
        ? '<p class="rv-caption">' +
          esc(tr("reve.conversation.reflection.is.disabled.for.this.session")) +
          "</p>"
        : "") +
      "</section>" +
      dreamSection() +
      "</div>" +
      '<aside class="rv-side-column"><section class="rv-card"><h3>' +
      esc(tr("reve.connected.knowledge")) +
      "</h3>" +
      knowledgeHtml +
      "</section>" +
      '<section class="rv-card"><h3>' +
      esc(tr("reve.on.her.mind")) +
      "</h3>" +
      (desires
        ? '<ul class="rv-desires">' + desires + "</ul>"
        : empty(tr("reve.no.active.pursuits.right.now"))) +
      "</section>" +
      '<section class="rv-card"><h3>' +
      esc(tr("reve.kept.close")) +
      '</h3><p class="rv-caption">' +
      esc(tr("reve.memory.capacityCaption")) +
      "</p>" +
      meter(tr("reve.about.you"), data.memory.user) +
      meter(tr("reve.working.memory"), data.memory.memory) +
      "</section></aside></div>" +
      '<section class="rv-card rv-activity"><div class="rv-card-head"><h3>' +
      esc(tr("reve.activity.usage")) +
      '</h3><span class="rv-meta">' +
      esc(tr("reve.latest.20.runs")) +
      '</span></div><div class="rv-usage"><span>' +
      esc(tr("reve.input")) +
      " <b>" +
      number(usage.inputTokens) +
      "</b></span><span>" +
      esc(tr("reve.output")) +
      " <b>" +
      number(usage.outputTokens) +
      "</b></span><span>" +
      esc(tr("reve.cache.read")) +
      " <b>" +
      number(usage.cacheReadTokens) +
      "</b></span><span>" +
      esc(tr("reve.cache.write")) +
      " <b>" +
      number(usage.cacheWriteTokens) +
      "</b></span></div>" +
      (usage.incompleteCacheRuns
        ? '<p class="rv-caption">' +
          esc(tr("reve.usage.incomplete", { n: usage.incompleteCacheRuns })) +
          "</p>"
        : "") +
      "<details><summary>" +
      esc(tr("reve.view.run.history")) +
      "</summary>" +
      (runs
        ? '<ul class="rv-runs">' + runs + "</ul>"
        : empty(tr("reve.no.background.runs.recorded.in.this.period"))) +
      "</details></section>" +
      (data.agentRecapEnabled ? agentRecapSection() : "") +
      '<p class="rv-footnote">' +
      esc(tr("reve.history.limits")) +
      "</p>";
    status(tr("reve.updated") + when(data.generatedAt), false);
  }
  async function refresh() {
    if (!root) return;
    const ticket = ++generation;
    root.setAttribute("aria-busy", "true");
    try {
      const [next, ping] = await Promise.all([
        request("/api/reve?days=" + encodeURIComponent(days)),
        request("/api/island/ping").catch(() => null),
      ]);
      if (ping && typeof ping.last_idle_message_text === "string")
        next.lastIdleMessage = ping.last_idle_message_text.slice(0, 2000);
      if (ticket !== generation || !root.isConnected) return;
      data = next;
      render();
    } catch (_) {
      if (ticket !== generation) return;
      status(tr("reve.overview.loadError"), true);
      if (!data)
        root.querySelector("#reveContent").innerHTML = empty(tr("reve.overview.unavailable"));
    } finally {
      if (ticket === generation) root.setAttribute("aria-busy", "false");
    }
  }
  async function loadRevision(details) {
    if (details.dataset.loaded === "true" || !details.open) return;
    const target = details.querySelector(".rv-revision-detail");
    target.innerHTML = empty(tr("reve.loading.evidence"));
    try {
      const revision = await request(
        "/api/reve/revisions/" + encodeURIComponent(details.dataset.revision),
      );
      if (!details.isConnected) return;
      target.innerHTML =
        '<div class="rv-diff"><div><h4>' +
        esc(tr("reve.before")) +
        "</h4><pre>" +
        esc(revision.before || tr("reve.empty")) +
        "</pre></div><div><h4>" +
        esc(tr("reve.after")) +
        "</h4><pre>" +
        esc(revision.after || tr("reve.empty")) +
        "</pre></div></div>" +
        revision.changes
          .map(
            (c) =>
              '<div class="rv-evidence"><p>' +
              esc(c.reason) +
              "</p>" +
              c.evidence
                .map((e) => {
                  const source = revision.sources.find((s) => s.id === e.id);
                  return (
                    "<blockquote>" +
                    esc(e.quote) +
                    "</blockquote>" +
                    (source
                      ? '<div class="rv-meta">' +
                        esc(
                          source.role === "user"
                            ? tr("reve.user.statement")
                            : source.role === "tool"
                              ? tr("reve.tool.observation")
                              : tr("reve.assistant.message"),
                        ) +
                        (source.at ? " · " + esc(when(source.at)) : "") +
                        ' <button class="rv-link" type="button" data-session="' +
                        esc(source.sessionId) +
                        '">' +
                        esc(tr("reve.open.source.conversation")) +
                        "</button></div>"
                      : "")
                  );
                })
                .join("") +
              "</div>",
          )
          .join("") +
        (revision.canRestore
          ? '<button type="button" class="rv-button rv-restore" data-restore="' +
            esc(revision.id) +
            '">' +
            esc(tr("reve.restore.the.previous.version")) +
            "</button>"
          : '<p class="rv-caption">' + esc(tr("reve.restore.unavailable")) + "</p>");
      details.dataset.loaded = "true";
    } catch (_) {
      target.innerHTML = empty(tr("reve.detail.loadError"));
    }
  }
  async function click(event) {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.dreamRevert) {
      await actOnDream(
        button.closest("[data-dream]"),
        "revert",
        { parts: [button.dataset.dreamRevert] },
        button,
      );
      return;
    }
    if (button.dataset.view) {
      window.lisaShowView(button.dataset.view);
      return;
    }
    if (button.dataset.session) {
      try {
        await window.lisaSwitchSession(button.dataset.session);
        if (window.lisaActiveSessionId !== button.dataset.session)
          throw new Error("session_unavailable");
        window.lisaShowView("chat");
      } catch (_) {
        status(tr("reve.source.openError"), true);
      }
      return;
    }
    if (button.id === "reveRefresh") {
      await refresh();
      return;
    }
    if (button.id === "reveReflect") {
      if (reflecting) return;
      reflecting = true;
      button.disabled = true;
      status(tr("reve.reflecting.on.the.current.conversation"), false);
      try {
        const sessionId = window.lisaActiveSessionId;
        if (!sessionId) throw new Error("session_changed");
        const result = await request("/reflect", {
          method: "POST",
          headers: { "content-type": "application/json", "x-lisa-session-id": sessionId },
          body: "{}",
        });
        await refresh();
        status(
          result.duplicate
            ? tr("reve.this.conversation.has.already.been.reviewed")
            : result.malformed
              ? tr("reve.reflection.invalid")
              : tr("reve.reflection.complete"),
          !!result.malformed,
        );
      } catch (error) {
        status(
          tr(error.message === "session_changed" ? "reve.sessionChanged" : "reve.reflection.error"),
          true,
        );
      } finally {
        reflecting = false;
        const current = root.querySelector("#reveReflect");
        if (current) {
          current.disabled = !data?.reflectionEnabled;
          current.textContent = tr("reve.reflect.on.this.conversation");
        }
      }
    }
    if (button.dataset.restore) {
      const id = button.dataset.restore;
      if (pendingRestores.has(id)) return;
      pendingRestores.add(id);
      button.disabled = true;
      try {
        await request("/api/reve/revisions/" + encodeURIComponent(id) + "/restore", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        await refresh();
        status(tr("reve.restore.success"), false);
      } catch (e) {
        status(
          e.message === "memory_changed"
            ? tr("reve.restore.conflict")
            : tr("reve.could.not.restore.this.version"),
          true,
        );
        button.disabled = false;
      } finally {
        pendingRestores.delete(id);
      }
    }
  }
  function mount(element) {
    root = element;
    data = null;
    root.classList.add("reve-view");
    root.innerHTML =
      '<div class="view-head rv-header"><div><h2>Rêve</h2><div class="vh-sub">' +
      esc(tr("reve.memory.reflection")) +
      '</div></div><div class="rv-toolbar"><label class="rv-period-label" for="reveWindow">' +
      esc(tr("reve.period")) +
      '</label><select class="v-sel" id="reveWindow"><option value="1">' +
      esc(tr("reve.last.24.hours")) +
      '</option><option value="7" selected>' +
      esc(tr("reve.last.7.days")) +
      '</option><option value="30">' +
      esc(tr("reve.last.30.days")) +
      '</option></select><button class="rv-button" type="button" id="reveRefresh">' +
      esc(tr("reve.refresh")) +
      '</button></div></div><div class="rv-status" id="reveStatus" role="status" aria-live="polite">' +
      esc(tr("reve.loading")) +
      '</div><div class="view-scroll rv-scroll" id="reveContent"></div>';
    root.querySelector("#reveWindow").value = days;
    root.querySelector("#reveWindow").addEventListener("change", (event) => {
      days = event.target.value;
      data = null;
      root.querySelector("#reveContent").innerHTML = empty(tr("reve.loading"));
      void refresh();
    });
    root.addEventListener("click", (event) => {
      void click(event);
    });
    root.addEventListener(
      "toggle",
      (event) => {
        const target = event.target;
        if (target.matches(".rv-revision")) void loadRevision(target);
        if (target.matches("[data-dream-log]")) void loadDreamList(target);
        if (target.matches("[data-dream]")) void loadDreamDetail(target);
        if (target.matches("[data-agent-recap]")) void loadAgentRecap(target);
      },
      true,
    );
    root.addEventListener("submit", (event) => {
      const form = event.target.closest(".rv-reconsider");
      if (!form) return;
      event.preventDefault();
      const note = form.querySelector("textarea").value.trim();
      if (note)
        void actOnDream(
          form.closest("[data-dream]"),
          "reconsider",
          { note },
          form.querySelector("button"),
        );
    });
    root.addEventListener("change", (event) => {
      if (event.target.matches("[data-recap-window]"))
        void loadAgentRecap(event.target.closest("details"));
    });
    void refresh();
  }
  window.LisaReve = { mount, refresh };
})();
