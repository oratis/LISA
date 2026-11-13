"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const make = (tag, text) => {
    const el = document.createElement(tag);
    el.textContent = text;
    return el;
  };
  const btn = (text, fn) => {
    const b = make("button", text);
    b.type = "button";
    b.onclick = () => guard(fn);
    return b;
  };
  const messages = {
    sign_in_to_lisa_on_this_mac: "请先在这台 Mac 的 LISA 登录。",
    workspace_grant_required: "请先在 mini 上核对验证码并授权工作区。",
    host_busy: "这台机器已有活动任务。",
    claude_api_key_required: "在 mini 的 LISA 后端配置 ANTHROPIC_API_KEY 后重启。",
    claude_not_installed: "mini 未检测到 Claude Code。",
    claude_native_binary_required:
      "此执行模式需要 macOS 原生 Claude Code。请在 mini 上选择原生可执行文件。",
    claude_binary_inside_project: "Claude Code 可执行文件须安装在授权工作区之外。",
    agent_host_upgrade_required: "请在这台 mini 上运行支持远程 Mac 控制的 LISA 版本。",
    connection_interrupted: "连接中断。重新连接后可查询原操作收据。",
    stale_approval: "审批已处理或已失效。",
    workspace_replaced: "目录身份已变化，请在 mini 上核对。",
  };
  const phase = {
    running: "执行中",
    approval: "等待审批",
    waiting: "本轮已完成，可追加指令",
    cancelling: "正在取消",
    cancelled: "已取消",
    completed: "已完成",
    failed: "执行失败",
    unknown: "上次中断，结果待核实",
  };
  const outcome = {
    allowed: "已允许",
    denied: "已拒绝",
    expired: "超时未处理，按拒绝执行",
    withdrawn: "agent 已撤回请求",
    invalid: "批准时已过期或目标已变化，未执行",
    cancelled: "任务已停止，未处理",
  };
  const stopper = {
    controller: "控制端",
    owner: "执行机所有者",
    timeout: "一小时时限",
    shutdown: "执行机后端退出",
    revoked: "授权已撤销或收窄",
    policy: "执行机关闭了远程控制",
  };
  const reasons = {
    claude_exited: "Claude Code 进程异常退出",
    claude_closed: "Claude Code 在本轮结束前退出",
    claude_protocol_error: "Claude Code 的输出无法识别",
    claude_input_closed: "Claude Code 的输入通道已关闭",
    claude_launch_failed: "Claude Code 启动失败",
  };
  // An entry type this page does not know yet is shown by name.
  function describe(e) {
    switch (e.type) {
      case "turn_started":
        return ["第 " + e.turn + " 轮开始", e.prompt];
      case "approval_requested":
        return ["等待审批 · " + e.tool + " " + e.target];
      case "approval_resolved":
        return ["审批结果 · " + (outcome[e.outcome] || e.outcome)];
      case "tool_blocked":
        return ["工作区策略已拒绝 · " + e.tool + " " + e.target];
      case "turn_completed":
        return [
          "第 " + e.turn + " 轮完成" + (e.blocked ? " · 策略拒绝 " + e.blocked + " 次请求" : ""),
          (e.truncated ? "… " : "") + e.result,
        ];
      case "turn_failed":
        return ["第 " + e.turn + " 轮失败", e.result];
      case "cancel_requested":
        return ["已请求取消 · " + (stopper[e.by] || e.by)];
      case "run_ended":
        return [
          "任务结束 · " +
            (phase[e.state] || e.state) +
            (e.reason ? " · " + (reasons[e.reason] || e.reason) : ""),
        ];
      case "outcome_unknown":
        return ["执行机后端曾重启，结果待核实。原操作不会重新执行。"];
      case "owner_released":
        return ["执行机所有者确认旧进程已退出，已释放执行位。"];
      case "orphan_released":
        return [
          e.process === "stopped"
            ? "执行机后端重启后停止了上一后端留下的 Claude 进程，已释放执行位。结果待核实。"
            : "执行机后端重启时旧 Claude 进程已退出，已释放执行位。结果待核实。",
        ];
      case "history_started":
        return ["此任务早于任务经过功能，记录从「" + (phase[e.state] || e.state) + "」开始。"];
      default:
        return [e.type];
    }
  }
  // Cursors are kept per account, Mac and task, so one Mac's history never lands on another.
  const timelines = new Map();
  let shown = "";
  let hosts = [],
    scope = "",
    host = null,
    cap = null,
    runs = [],
    runId = "",
    version = 0,
    busy = false,
    polling = false,
    listing = false;
  const notice = (text) => {
    $("notice").textContent = text;
  };
  const explain = (err) => messages[err.message] || err.message;
  function clearWork() {
    version++;
    cap = null;
    runs = [];
    runId = "";
    shown = "";
    timelines.clear();
    $("work").hidden = true;
    $("runs").replaceChildren();
    $("timeline").hidden = true;
    $("timeline-list").replaceChildren();
    $("timeline-note").textContent = "";
    $("prompt").value = "";
  }
  async function guard(fn) {
    try {
      await fn();
    } catch (e) {
      notice(explain(e));
    }
  }
  async function api(url, body) {
    const v = version;
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      cache: "no-store",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json();
    if (!res.ok) {
      const err = Error(data.error || "请求失败");
      err.status = res.status;
      if (
        v === version &&
        (url === "/api/fleet/request" || url === "/api/fleet/hosts") &&
        (res.status === 401 || res.status === 403)
      ) {
        clearWork();
        notice(explain(err));
      }
      throw err;
    }
    return data;
  }
  function remote(id, account, path, method = "GET", payload) {
    return api("/api/fleet/request", { hostId: id, scope: account, path, method, payload });
  }
  function key() {
    return "lisa.fleet.op." + scope + "." + host?.id;
  }
  function pending() {
    const value = sessionStorage.getItem(key());
    return value ? JSON.parse(value) : null;
  }
  async function discover() {
    if (listing) return;
    listing = true;
    try {
      const d = await api("/api/fleet/hosts");
      if (scope && d.scope !== scope) {
        clearWork();
        host = null;
        $("target").hidden = true;
      }
      scope = d.scope;
      hosts = d.hosts;
      $("hosts").replaceChildren(
        ...hosts.map((h) => {
          const b = btn(h.name, () => choose(h));
          b.append(
            make(
              "small",
              (h.online ? "在线" : "离线") +
                " · " +
                h.id.slice(0, 8) +
                (h.paired ? " · 已配对" : ""),
            ),
          );
          b.setAttribute("aria-pressed", String(host?.id === h.id));
          return b;
        }),
      );
      if (!hosts.length) $("hosts").textContent = "尚未发现机器。请在 mini 上启用 LISA 账号连接。";
      const selected = hosts.find((h) => h.id === host?.id);
      if (host && !selected) {
        clearWork();
        host = null;
        $("target").hidden = true;
      } else if (selected && (selected.online !== host.online || selected.paired !== host.paired)) {
        await choose(selected);
      }
    } finally {
      listing = false;
    }
  }
  async function choose(h) {
    clearWork();
    const v = version;
    host = h;
    notice("");
    $("target").hidden = false;
    $("pairing").replaceChildren();
    $("name").textContent = h.name;
    $("fingerprint").textContent = h.id;
    for (const [i, b] of [...$("hosts").children].entries())
      b.setAttribute("aria-pressed", String(hosts[i]?.id === h.id));
    if (h.paired)
      $("pairing").append(
        btn("移除本机保存的配对", async () => {
          await api("/api/fleet/forget", { hostId: h.id });
          if (v !== version) return;
          await discover();
          const selected = hosts.find((x) => x.id === h.id);
          if (selected && host?.id === h.id) await choose(selected);
        }),
      );
    if (!h.online) {
      $("pairing").append(make("p", "机器离线。恢复连接后可查询既有任务。"));
      return;
    }
    if (!h.paired) {
      $("pairing").append(
        btn("与这台 Mac 配对", async () => {
          const p = await api("/api/fleet/pair", { hostId: h.id });
          if (v !== version) return;
          $("pairing").replaceChildren(
            make("p", "在 mini 的「配置这台 Mac 作为执行机」中核对 " + p.code + " 并授权。"),
            btn("两端验证码一致，完成配对", async () => {
              await api("/api/fleet/pair", { hostId: h.id, code: p.code });
              if (v !== version) return;
              await discover();
              const selected = hosts.find((x) => x.id === h.id);
              if (v === version && selected) await choose(selected);
            }),
          );
        }),
      );
      return;
    }
    const c = await remote(h.id, scope, "/capabilities");
    if (v !== version) return;
    cap = c;
    $("workspace").replaceChildren(
      ...c.workspaces.map((w) => {
        const o = make("option", w.name);
        o.value = w.id;
        return o;
      }),
    );
    const saved = pending();
    if (saved && c.workspaces.some((w) => w.id === saved.payload.workspaceId))
      $("workspace").value = saved.payload.workspaceId;
    $("capability").textContent = c.unavailable
      ? messages[c.unavailable] || c.unavailable
      : c.control
        ? "Claude Code · Read / Edit / Write 逐次审批。指令和获准读取的内容会发往这台 mini 配置的 Claude API。"
        : "已授予观察权限";
    await refreshRuns(v);
  }
  async function refreshRuns(v = version) {
    if (!host || !cap) return;
    const d = await remote(host.id, scope, "/runs");
    if (v !== version) return;
    runs = d.runs;
    render();
    $("work").hidden = false;
    await syncTimeline(v);
  }
  function timelineKey(id) {
    return scope + "|" + host.id + "|" + id;
  }
  async function syncTimeline(v = version) {
    const r = runs.find((x) => x.id === runId);
    if (!host || !r || !cap?.features?.includes("run-events")) return;
    const account = scope,
      id = host.id,
      k = timelineKey(r.id);
    let t = timelines.get(k);
    if (!t) timelines.set(k, (t = { events: [], last: 0, busy: false }));
    if (t.busy || t.last === r.lastSeq) return;
    t.busy = true;
    try {
      for (let page = 0, more = true; more && page < 6; page++) {
        const d = await remote(
          id,
          account,
          "/runs/" + r.id + "/events?after=" + t.last + "&limit=100",
        );
        if (v !== version) return;
        if (d.reset) {
          t.events = [];
          t.last = 0;
        } else if (t.events.length && t.events[0].seq < d.firstSeq) {
          t.events = t.events.filter((e) => e.seq >= d.firstSeq);
        }
        for (const e of d.events)
          if (e.seq > t.last) {
            t.events.push(e);
            t.last = e.seq;
          }
        more = d.more;
      }
    } finally {
      t.busy = false;
    }
    if (v === version) renderTimeline();
  }
  function renderTimeline() {
    const r = cap?.features?.includes("run-events") ? runs.find((x) => x.id === runId) : null,
      t = r && timelines.get(timelineKey(r.id)),
      first = t?.events[0]?.seq,
      signature = t ? timelineKey(r.id) + "|" + t.last + "|" + first : "";
    if (signature === shown) return;
    shown = signature;
    $("timeline").hidden = !t || !t.events.length;
    if (!t) return;
    $("timeline-note").textContent = first > 1
      ? "较早的记录已超出执行机的留存范围，以下从第 " + first + " 条开始。"
      : "";
    $("timeline-list").replaceChildren(
      ...t.events.map((e) => {
        const [label, detail] = describe(e),
          li = make("li", ""),
          time = make("time", new Date(e.at).toLocaleTimeString());
        time.dateTime = new Date(e.at).toISOString();
        li.append(time, make("span", label));
        if (detail) li.append(make("pre", detail));
        return li;
      }),
    );
  }
  function render() {
    if (!host || !cap) return;
    const wid = $("workspace").value,
      rows = runs.filter((r) => r.workspaceId === wid),
      active = rows.find((r) => ["running", "waiting", "approval", "cancelling"].includes(r.state));
    if (!rows.some((r) => r.id === runId)) runId = (active || rows[0])?.id || "";
    renderTimeline();
    const r = rows.find((x) => x.id === runId),
      saved = pending(),
      blocked = busy || !!saved;
    $("retry").hidden = !saved;
    const anotherWorkspace = saved && saved.payload.workspaceId !== wid;
    $("retry").disabled = busy || !!anotherWorkspace;
    $("retry").textContent = anotherWorkspace ? "请切回原工作区核对收据" : "核对收据并重试原操作";
    $("start").disabled =
      blocked ||
      !wid ||
      !cap.control ||
      !!cap.unavailable ||
      runs.some((x) => ["running", "waiting", "approval", "cancelling"].includes(x.state));
    $("follow").disabled = blocked || !cap.control || r?.state !== "waiting";
    const list = $("runs");
    list.replaceChildren();
    if (!rows.length) {
      list.append(make("p", "此工作区暂无任务。"));
      return;
    }
    const select = document.createElement("select");
    select.setAttribute("aria-label", "选择任务");
    for (const x of rows) {
      const o = make(
        "option",
        new Date(x.createdAt).toLocaleString() +
          " · " +
          (phase[x.state] || x.state) +
          " · " +
          x.id.slice(0, 8),
      );
      o.value = x.id;
      select.append(o);
    }
    select.value = runId;
    select.onchange = () => {
      runId = select.value;
      render();
      guard(syncTimeline);
    };
    list.append(select);
    const card = make("article", "");
    card.append(make("strong", phase[r.state] || r.state));
    if (r.updatedAt)
      card.append(make("small", " · 最后更新 " + new Date(r.updatedAt).toLocaleString()));
    if (r.result) card.append(make("pre", r.result));
    if (r.approval) {
      const a = r.approval;
      card.append(make("h3", "审批 " + a.tool), make("pre", JSON.stringify(a.input, null, 2)));
      for (const [label, allow] of [
        ["允许这一次", true],
        ["拒绝", false],
      ]) {
        const b = btn(label, () =>
          mutate("/runs/" + r.id + "/decisions", { approvalId: a.id, allow }),
        );
        b.disabled = blocked || !cap.control;
        card.append(b);
      }
    }
    if (["running", "waiting", "approval"].includes(r.state)) {
      const b = btn("取消此任务", () => mutate("/runs/" + r.id + "/cancel", {}));
      b.disabled = blocked || !cap.control;
      card.append(b);
    }
    list.append(card);
  }
  async function mutate(path, values) {
    if (busy || pending()) return;
    const op = {
      path,
      account: scope,
      id: host.id,
      payload: {
        ...values,
        workspaceId: $("workspace").value,
        hostId: host.id,
        operationId: crypto.randomUUID(),
      },
    };
    sessionStorage.setItem(key(), JSON.stringify(op));
    await submit(op, false);
  }
  async function submit(op, reconcile) {
    if (
      busy ||
      !op ||
      op.id !== host?.id ||
      op.account !== scope ||
      op.payload.workspaceId !== $("workspace").value
    )
      return;
    const savedKey = key(),
      v = version;
    busy = true;
    render();
    try {
      let reply;
      if (reconcile) {
        try {
          reply = await remote(op.id, op.account, "/operations/" + op.payload.operationId);
        } catch (e) {
          if (e.status !== 404) throw e;
        }
      }
      if (v !== version) return;
      if (!reply) reply = await remote(op.id, op.account, op.path, "POST", op.payload);
      sessionStorage.removeItem(savedKey);
      if (v !== version) return;
      runId = reply.run.id;
      if (op.payload.text) $("prompt").value = "";
      notice(
        reply.status === "unknown"
          ? "已登记，但执行结果不确定。请核对任务；原操作不会再次执行。"
          : "操作已接收。",
      );
      await refreshRuns(v);
    } catch (e) {
      if ([400, 403, 404, 409, 413, 415, 422, 507].includes(e.status))
        sessionStorage.removeItem(savedKey);
      if (v === version) notice(explain(e));
    } finally {
      busy = false;
      render();
    }
  }
  $("task-form").onsubmit = (e) => {
    e.preventDefault();
    if (!$("start").disabled) guard(() => mutate("/runs", { text: $("prompt").value }));
  };
  $("follow").onclick = () =>
    guard(() => mutate("/runs/" + runId + "/messages", { text: $("prompt").value }));
  $("workspace").onchange = () => {
    runId = "";
    $("prompt").value = "";
    render();
    guard(syncTimeline);
  };
  $("retry").onclick = () => guard(() => submit(pending(), true));
  $("refresh").onclick = () =>
    guard(async () => {
      await discover();
      const h = hosts.find((x) => x.id === host?.id);
      if (h) await choose(h);
    });
  async function local() {
    const d = await api("/api/fleet/local"),
      l = d.link;
    $("link-status").textContent = l.online ? "已连接账号中继" : "账号中继未连接";
    $("connect").hidden = l.online;
    $("local-workspaces").replaceChildren(
      ...d.workspaces.map((w) => make("p", w.name + " · " + w.root)),
    );
    $("requests").replaceChildren();
    for (const p of l.pending.filter((x) => x.fleet && !x.waiting)) {
      const box = make("article", "");
      box.append(make("h3", "核对配对码 " + p.code));
      const check = (s) => {
        const label = make("label", ""),
          cb = document.createElement("input");
        cb.type = "checkbox";
        label.append(cb, document.createTextNode(s));
        box.append(label);
        return cb;
      };
      const options = d.workspaces.map((w) => [w.id, check(w.name)]);
      const write = check("允许在选定目录启动和控制 Claude Code");
      box.append(
        btn("验证码一致，授权选中目录", async () => {
          await api("/api/fleet/grants", {
            deviceId: p.id,
            code: p.code,
            workspaces: options.filter((x) => x[1].checked).map((x) => x[0]),
            control: write.checked,
          });
          await local();
        }),
      );
      $("requests").append(box);
    }
    $("devices").replaceChildren(
      ...l.devices
        .filter((x) => x.fleet)
        .map((x) => {
          const row = make("p", x.name + " · " + x.id.slice(0, 8) + " ");
          row.append(
            btn("撤销设备", async () => {
              await api("/api/remote/revoke", { id: x.id });
              await local();
            }),
          );
          return row;
        }),
    );
    $("local-runs").replaceChildren(
      ...d.runs.map((r) => {
        const row = make("p", r.id + " · " + (phase[r.state] || r.state) + " ");
        row.append(
          btn(r.state === "unknown" ? "确认旧进程已退出，释放执行机" : "停止本机任务", async () => {
            await api("/api/fleet/local-stop", {
              runId: r.id,
              confirmUnknown: r.state === "unknown",
            });
            await local();
          }),
        );
        return row;
      }),
    );
  }
  $("local").ontoggle = () => {
    if ($("local").open) guard(local);
  };
  $("local-refresh").onclick = () => guard(local);
  $("register").onsubmit = (e) => {
    e.preventDefault();
    guard(async () => {
      await api("/api/fleet/workspaces", {
        name: $("alias").value,
        directory: $("directory").value,
      });
      $("register").reset();
      await local();
    });
  };
  $("connect").onclick = () =>
    guard(async () => {
      await api("/api/remote/connect", {});
      await local();
    });
  setInterval(() => {
    if (!document.hidden && !busy) guard(discover);
  }, 20000);
  setInterval(async () => {
    if (document.hidden || polling || busy || !cap) return;
    polling = true;
    try {
      await refreshRuns();
    } catch (e) {
      notice(explain(e));
    } finally {
      polling = false;
    }
  }, 4000);
  guard(discover);
})();
