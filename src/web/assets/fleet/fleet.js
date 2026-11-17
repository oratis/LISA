"use strict";
(() => {
  const ft = window.LisaFleetLocale.text;
  window.LisaFleetLocale.apply(document);
  let visible = window.parent === window;
  window.addEventListener("message", (event) => {
    if (event.source === window.parent && event.origin === location.origin && event.data?.type === "lisa-fleet-visibility") {
      visible = event.data.visible === true;
      if (visible && !busy) guard(async () => { await discover(); await refreshRuns(); });
    }
  });
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
    sign_in_to_lisa_on_this_mac: ft("请先在这台 Mac 的 LISA 登录。"),
    workspace_grant_required: ft("请先在执行机上核对验证码并授权工作区。"),
    operation_generation_changed: ft("执行机已清理账本，旧操作不会重放。请刷新机器后重新发起任务。"),
    cleanup_preview_changed: ft("账本在预览后发生了变化，请重新预览清理。"),
    ledger_compaction_pending: ft("任务记录已删除，但存储压缩尚未完成。请关闭其他后端后重新执行清理。"),
    host_busy: ft("这台机器已有活动任务。"),
    claude_api_key_required: ft("在执行机的 LISA 后端配置 ANTHROPIC_API_KEY 后重启。"),
    claude_not_installed: ft("执行机未检测到 Claude Code。"),
    claude_native_binary_required:
      ft("此执行模式需要 macOS 原生 Claude Code。请在执行机上选择原生可执行文件。"),
    claude_binary_inside_project: ft("Claude Code 可执行文件须安装在授权工作区之外。"),
    agent_host_upgrade_required: ft("请在执行机上运行支持远程 Mac 控制的 LISA 版本。"),
    connection_interrupted: ft("连接中断。重新连接后可查询原操作收据。"),
    stale_approval: ft("审批已处理或已失效。"),
    workspace_replaced: ft("目录身份已变化，请在执行机上核对。"),
    git_worktree_unavailable: ft("请确认登记的是 Git 仓库根目录，且已有提交。"),
    codex_not_installed: ft("执行机未安装 Codex CLI。"),
    codex_native_binary_required: ft("执行机需要独立的原生 Codex CLI。"),
    codex_api_key_required: ft("请在执行机配置 OPENAI_API_KEY 后启动 Codex 复核。"),
    continuation_unavailable: ft("请先在执行机核实旧进程已退出，并确认原始上下文仍保留。"),
    continuation_preview_changed: ft("续接上下文或指令已变化，请重新预览。"),
    continuation_too_large: ft("续接上下文超过 96 KiB，请整理后新建任务。"),
    finish_source_first: ft("请先结束原任务，再预览交接。"),
    merge_source_changed: ft("原分支或提交已变化，请在执行机检查后手动合并。"),
    merge_source_dirty: ft("原仓库有未提交改动，请先在执行机处理。"),
    merge_hidden_index: ft("原仓库启用了隐藏索引项或稀疏检出，请先恢复完整工作区。"),
    merge_path_collision: ft("原仓库中有会被覆盖的忽略文件，已拒绝合并。"),
    merge_worktree_changed: ft("隔离工作区已变化，请选择与当前文件一致的检查点。"),
    merge_preview_changed: ft("合并内容或条件已变化，请重新预览。"),
    merge_origin_unavailable: ft("此工作区没有可验证的创建来源，不能自动合并。"),
    merge_no_changes: ft("此检查点与原分支没有差异。"),
    source_control_denied: ft("自动合并还需执行机所有者授权原仓库的控制权限。"),
    worktree_contains_ignored_files: ft("隔离工作区包含检查点未收录的忽略文件。请保留工作区，或在执行机手动处理这些文件。"),
    workspace_archived: ft("此工作区已经清理，仍可查看历史任务与改动。"),
    maintenance_pending: ft("上次文件操作的结果不确定，请执行机所有者核对后解除保留。"),
    maintenance_verification_required: ft("文件操作尚未结束，或尚未确认核对结果。"),
    restore_preview_changed: ft("文件、权限或目录身份已变化，请重新预览回退。"),
    restore_file_changed: ft("文件发生了并发改动，请检查内容后重新预览。"),
    unsafe_restore_path: ft("回退只支持原目录下的普通文件，不支持符号链接、硬链接或特殊文件。"),
    restore_regular_file_required: ft("检查点中的此项不是普通文件，请在执行机上手动处理。"),
    restore_file_limit: ft("文件超过 16 MiB 回退上限。"),
    preview_expired: ft("预览已过期，请重新预览。"),
    handoff_context_missing: ft("此历史任务未保存完整要求，不能生成交接包。"),
    handoff_too_large: ft("本轮交接内容超过上限（20 个文件 / 96 KiB），请选择范围更小的一轮。"),
    handoff_preview_changed: ft("交接内容已变化，请重新预览并确认。"),
    handoff_preview_expired: ft("交接预览已过期，请重新预览。"),
    checkpoint_unavailable: ft("检查点不完整或已清理，无法展示差异。"),
    secure_pocket_required: ft("请选择已通过安全配对的 Pocket；旧版配对需撤销后重新配对。"),
  };
  const phase = {
    running: ft("执行中"),
    approval: ft("等待审批"),
    waiting: ft("本轮已完成，可追加指令"),
    cancelling: ft("正在取消"),
    cancelled: ft("已取消"),
    completed: ft("已完成"),
    failed: ft("执行失败"),
    unknown: ft("上次中断，结果待核实"),
  };
  const outcome = {
    allowed: ft("已允许"),
    denied: ft("已拒绝"),
    expired: ft("超时未处理，按拒绝执行"),
    withdrawn: ft("智能体已撤回请求"),
    invalid: ft("批准时已过期或目标已变化，未执行"),
    cancelled: ft("任务已停止，未处理"),
  };
  const stopper = {
    controller: ft("控制端"),
    owner: ft("执行机所有者"),
    timeout: ft("一小时时限"),
    shutdown: ft("执行机后端退出"),
    revoked: ft("授权已撤销或收窄"),
    policy: ft("执行机关闭了远程控制"),
  };
  const reasons = {
    claude_exited: ft("Claude Code 进程异常退出"),
    claude_closed: ft("Claude Code 在本轮结束前退出"),
    claude_protocol_error: ft("Claude Code 的输出无法识别"),
    claude_input_closed: ft("Claude Code 的输入通道已关闭"),
    claude_launch_failed: ft("Claude Code 启动失败"),
  };
  // An entry type this page does not know yet is shown by name.
  function describe(e) {
    switch (e.type) {
      case "turn_started":
        return [ft("第 ") + e.turn + ft(" 轮开始"), e.prompt];
      case "approval_requested":
        return [ft("等待审批 · ") + e.tool + " " + e.target];
      case "approval_resolved":
        return [ft("审批结果 · ") + (outcome[e.outcome] || e.outcome)];
      case "tool_blocked":
        return [ft("工作区策略已拒绝 · ") + e.tool + " " + e.target];
      case "turn_completed":
        return [
          ft("第 ") + e.turn + ft(" 轮完成") + (e.blocked ? ft(" · 策略拒绝 ") + e.blocked + ft(" 次请求") : ""),
          (e.truncated ? "… " : "") + e.result,
        ];
      case "turn_failed":
        return [ft("第 ") + e.turn + ft(" 轮失败"), e.result];
      case "cancel_requested":
        return [ft("已请求取消 · ") + (stopper[e.by] || e.by)];
      case "run_ended":
        return [
          ft("任务结束 · ") +
            (phase[e.state] || e.state) +
            (e.reason ? " · " + (reasons[e.reason] || e.reason) : ""),
        ];
      case "outcome_unknown":
        return [ft("执行机后端曾重启，结果待核实。原操作不会重新执行。")];
      case "owner_released":
        return [ft("执行机所有者确认旧进程已退出，已释放执行位。")];
      case "orphan_released":
        return [
          e.process === "stopped"
            ? ft("执行机后端重启后停止了上一后端留下的 Claude 进程，已释放执行位。结果待核实。")
            : ft("执行机后端重启时旧 Claude 进程已退出，已释放执行位。结果待核实。"),
        ];
      case "continuation_started":
        return [ft("已从核实退出的任务创建独立续接会话；旧结果仍未核实。")];
      case "handoff_started":
        return [ft("第 ") + e.turn + ft(" 轮已交接给 ") + (e.agent || ft("新智能体")) + ft("；新任务独立授权。")];
      case "approval_decided":
        return [ft("Pocket 已发送审批决定 · ") + e.outcome];
      case "worktree_merged":
        return [ft("工作区已合并 · ") + e.commit + (e.cleaned ? ft(" · 隔离工作区已清理") : ft(" · 保留隔离工作区"))];
      case "file_restored":
        return [ft("已将 ") + e.target + ft(" 回退到第 ") + e.turn + ft(" 轮开始时的内容。")];
      case "checkpoints_cleared":
        return [ft("执行机所有者已清理此任务的改动检查点。")];
      case "history_started":
        return [ft("此任务早于任务经过功能，记录从「") + (phase[e.state] || e.state) + ft("」开始。")];
      default:
        return [e.type];
    }
  }
  // Cursors are kept per account, Mac and task, so one Mac's history never lands on another.
  const timelines = new Map();
  let changesKey = "", changesSeq = -1, changesVersion = 0;
  function clearRestore() { $("restore").replaceChildren(); $("restore").hidden = true; }
  function clearMerge() { $("merge").replaceChildren(); $("merge").hidden = true; }
  function clearChanges() {
    clearRestore(); clearMerge();
    changesVersion++;
    changesKey = ""; changesSeq = -1;
    $("changes").hidden = true;
    $("change-turns").replaceChildren();
    $("change-files").replaceChildren();
    $("change-note").textContent = "";
    $("change-patch").textContent = "";
    $("change-patch").hidden = true;
  }
  let shown = "";
  let hosts = [],
    scope = "",
    host = null,
    cap = null,
    runs = [],
    observations = [],
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
    observations = [];
    clearHandoff();
    $("observations").replaceChildren();
    runId = "";
    shown = "";
    timelines.clear();
    clearChanges();
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
      const err = Error(data.error || ft("请求失败"));
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
        document.body.classList.remove("has-target");
        $("step-device").setAttribute("aria-current", "step");
        $("step-workspace").removeAttribute("aria-current");
        $("step-task").removeAttribute("aria-current");
        $("target").hidden = true;
      }
      scope = d.scope;
      hosts = d.hosts;
      $("hosts").replaceChildren(
        ...hosts.map((h) => {
          const b = btn(h.name, async () => {
            await choose(h);
            if (host?.id === h.id) $("target").scrollIntoView({ block: "start", behavior: "instant" });
          });
          b.append(
            make(
              "small",
              (h.online ? ft("在线") : ft("离线")) +
                " · " +
                (h.paired ? ft("已配对") : ft("等待配对")),
            ),
          );
          b.dataset.online = String(h.online);
          b.setAttribute("aria-pressed", String(host?.id === h.id));
          return b;
        }),
      );
      if (!hosts.length) {
        const empty = make("div", ""); empty.className = "host-empty";
        empty.append(make("h3", ft("连接你的第一台 Mac")), make("p", ft("在另一台 Mac 上登录同一个 LISA 账号，启用账号连接，再回到这里刷新设备。")), btn(ft("查看本机设置"), openSetup));
        $("hosts").append(empty);
      }
      const selected = hosts.find((h) => h.id === host?.id);
      if (host && !selected) {
        clearWork();
        host = null;
        document.body.classList.remove("has-target");
        $("step-device").setAttribute("aria-current", "step");
        $("step-workspace").removeAttribute("aria-current");
        $("step-task").removeAttribute("aria-current");
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
    document.body.classList.add("has-target");
    notice("");
    $("target").hidden = false;
    $("pairing").replaceChildren();
    $("connection-action").replaceChildren();
    $("step-device").removeAttribute("aria-current");
    $("step-workspace").setAttribute("aria-current", "step");
    $("step-task").removeAttribute("aria-current");
    $("name").textContent = h.name;
    $("fingerprint").textContent = h.id;
    for (const [i, b] of [...$("hosts").children].entries())
      b.setAttribute("aria-pressed", String(hosts[i]?.id === h.id));
    if (h.paired)
      $("pairing").append(
        btn(ft("移除本机保存的配对"), async () => {
          if (!confirm(ft("移除这台 Mac 的配对？再次连接时需要重新核对验证码。"))) return;
          await api("/api/fleet/forget", { hostId: h.id });
          if (v !== version) return;
          await discover();
          const selected = hosts.find((x) => x.id === h.id);
          if (selected && host?.id === h.id) await choose(selected);
        }),
      );
    if (!h.online) {
      $("connection-action").append(make("p", ft("机器离线。恢复连接后可查询既有任务。")));
      return;
    }
    if (!h.paired) {
      $("connection-action").append(
        make("p", ft("首次连接需要在两台 Mac 上核对验证码，并选择允许访问的工作区。")),
        btn(ft("与这台 Mac 配对"), async () => {
          const p = await api("/api/fleet/pair", { hostId: h.id });
          if (v !== version) return;
          $("connection-action").replaceChildren(
            make("p", ft("在执行机的「配置这台 Mac 作为执行机」中核对 ") + p.code + ft(" 并授权。")),
            btn(ft("两端验证码一致，完成配对"), async () => {
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
    $("agent").replaceChildren(...(c.agents || [{ id: "claude-code" }]).map((a) => {
      const option = make("option", a.id === "codex" ? ft("Codex · 只读交接包复核") : a.id === "codex-workspace" ? ft("Codex · 目录读写（逐次审批）") : "Claude Code");
      option.value = a.id; return option;
    }));
    $("workspace").replaceChildren(
      ...c.workspaces.map((w) => {
        const o = make("option", w.name + (w.archived ? ft(" · 已归档") : ""));
        o.value = w.id;
        return o;
      }),
    );
    const saved = pending();
    if (saved && c.workspaces.some((w) => w.id === saved.payload.workspaceId))
      $("workspace").value = saved.payload.workspaceId;
    await refreshRuns(v);
  }
  async function refreshRuns(v = version) {
    if (!host || !cap) return;
    const d = await remote(host.id, scope, "/runs");
    if (v !== version) return;
    if (typeof d.operationGeneration === "string" && d.operationGeneration !== cap.operationGeneration) {
      if (cap.operationGeneration !== undefined) {
        timelines.clear(); shown = ""; clearChanges(); clearHandoff();
        notice(ft("执行机账本已清理。旧操作不会重放；新任务使用新的操作代次。"));
      }
      cap.operationGeneration = d.operationGeneration;
    }
    runs = d.runs;
    observations = d.observations || [];
    if (d.agents) cap.agents = d.agents;
    if (typeof d.control === "boolean") cap.control = d.control;
    render();
    $("work").hidden = false;
    await syncTimeline(v);
    await syncChanges(v);
  }
  async function syncChanges(v = version) {
    const run = runs.find((r) => r.id === runId);
    if (!host || !run || !cap?.features?.includes("turn-changes")) { clearChanges(); return; }
    const key = timelineKey(run.id);
    if (changesKey !== key) { clearChanges(); changesKey = key; }
    if (changesSeq === run.lastSeq) return;
    const cv = changesVersion, id = host.id, account = scope;
    const valid = () => v === version && cv === changesVersion && runId === run.id;
    const d = await remote(id, account, "/runs/" + run.id + "/changes");
    if (!valid()) return;
    changesSeq = run.lastSeq;
    if (d.turns.some((t) => t.state === "cleared")) {
      changesVersion++;
      $("change-files").replaceChildren();
      $("change-patch").textContent = ""; $("change-patch").hidden = true;
      $("change-note").textContent = ft("检查点已由执行机所有者清理。");
      clearRestore(); clearMerge();
    }
    $("changes").hidden = false;
    const reason = {
      managed_worktree_required: ft("仅 LISA 创建的隔离 Git 工作区提供检查点"),
      snapshot_limit: ft("超过快照上限（2000 文件 / 16 MiB）"),
      checkpoint_limit: ft("已达单任务 100 轮检查点上限"),
      checkpoint_quota: ft("检查点存储已达到本机总配额，任务仍继续执行"),
      snapshot_unavailable: ft("快照未完成（目录变化、子模块或 Git 不可用）"),
      workspace_replaced: ft("工作区已被替换"),
      checkpoints_cleared: ft("检查点已清理"),
      snapshot_interrupted: ft("快照曾被中断"),
    };
    $("change-turns").replaceChildren(...d.turns.map((t) => {
      if (!t.available) return make("p", ft("第 ") + t.turn + ft(" 轮 · ") +
        (reason[t.reason] || (t.state === "running" ? ft("本轮进行中") : ft("结束检查点缺失"))));
      return btn(ft("查看第 ") + t.turn + ft(" 轮改动") + (t.state === "interrupted" ? ft("（中断时）") : ""), async () => {
        const request = ++changesVersion;
        clearRestore();
        $("change-files").replaceChildren(); $("change-patch").hidden = true;
        const current = () => v === version && changesKey === key && runId === run.id && changesVersion === request;
        clearMerge();
        const route = "/runs/" + run.id + "/changes/" + t.turn;
        const files = await remote(id, account, route);
        if (!current()) return;
        $("change-note").textContent = ft("第 ") + t.turn + ft(" 轮 · ") +
          (files.concurrent ? ft("工作区同时变化（HEAD 或索引改变）。") : ft("工作区差异，无法单独归因于智能体。")) +
          (files.files.length ? "" : ft("本轮没有记录到文件差异。"));
        if (cap.control && cap.features.includes("worktree-merge") && !cap.workspaces.find((w) => w.id === run.workspaceId)?.archived && ["completed", "cancelled", "failed"].includes(run.state)) {
          const section = $("merge"), cleanup = document.createElement("input"), label = make("label", "");
          cleanup.type = "checkbox";
          label.append(cleanup, document.createTextNode(ft("合并后清理这个隔离工作区")));
          const content = make("div", ""); let revision = 0;
          cleanup.onchange = () => { revision++; content.replaceChildren(); };
          const prepare = btn(ft("预览合并到原分支"), async () => {
            if (!current() || busy || pending()) return;
            const selected = ++revision, remove = cleanup.checked;
            const packet = await remote(id, account, "/runs/" + run.id + "/merge-preview", "POST", {
              hostId: id, workspaceId: run.workspaceId, turn: t.turn, cleanup: remove, operationGeneration: cap.operationGeneration });
            if (!current() || selected !== revision) return;
            const send = btn(ft("确认合并到原分支"), async () => {
              if (!current() || selected !== revision || busy || pending()) return;
              if (!confirm(ft("将以下全部改动作为一个新提交合并到「") + packet.sourceName + ft("」的 ") + packet.branch + "？" + (remove ? ft("确认后将清理此隔离工作区。") : ft("将保留此隔离工作区。")))) return;
              if (!current() || selected !== revision) return;
              clearMerge();
              await mutate("/runs/" + run.id + "/merge", { turn: t.turn, cleanup: remove, previewToken: packet.previewToken, expiresAt: packet.expiresAt });
            });
            content.replaceChildren(make("h4", packet.sourceName + " · " + packet.branch),
              make("p", ft("包含此检查点相对原分支的全部改动。原仓库须干净，且仍处于创建工作区时的提交。")),
              make("p", ft("基准 ") + packet.base + ft(" · 目标树 ") + packet.tree),
              make("pre", packet.files.map((f) => f.status + " · " + f.path).join("\n")),
              make("pre", (packet.truncated ? ft("差异超过 64 KiB，仅显示开头；完整文件列表和目标树如上。\n") : "") + packet.patch), send);
          });
          section.replaceChildren(label, prepare, content); section.hidden = false;
        }
        $("change-files").replaceChildren(...files.files.map((f) => btn(
          ({ A: ft("新增"), M: ft("修改"), D: ft("删除"), T: ft("类型变化") }[f.status] || f.status) + " · " + f.path, async () => {
            const fileRequest = ++changesVersion;
            clearRestore(); clearMerge();
            $("change-patch").hidden = true;
            const diff = await remote(id, account, route + "/" + f.id);
            if (v !== version || changesKey !== key || runId !== run.id || changesVersion !== fileRequest) return;
            $("change-patch").textContent = (diff.truncated ? ft("差异超过 64 KiB，以下仅为开头。\n") : "") + diff.patch;
            $("change-patch").hidden = false;
            if (!cap.workspaces.find((w) => w.id === run.workspaceId)?.archived && cap?.control && cap.features.includes("file-restore") && ["completed", "cancelled", "failed"].includes(run.state)) {
              const section = $("restore");
              const validRestore = () => v === version && changesKey === key && runId === run.id && changesVersion === fileRequest;
              const prepare = btn(ft("预览回退此文件"), async () => {
                if (!validRestore() || busy || pending()) return;
                const packet = await remote(id, account, "/runs/" + run.id + "/restore-preview", "POST",
                  { hostId: id, workspaceId: run.workspaceId, turn: t.turn, file: f.id, operationGeneration: cap.operationGeneration });
                if (!validRestore()) return;
                const describe = (side) => !side.exists ? ft("文件不存在") :
                  side.bytes + ft(" bytes · 权限 ") + side.mode.toString(8) + " · SHA-256 " + side.sha256 +
                  (side.binary ? ft("\n二进制文件") : "\n" + side.text + (side.truncated ? ft("\n内容超过 64 KiB，仅显示开头。") : ""));
                const send = btn(ft("确认回退此文件"), async () => {
                  if (!validRestore() || busy || pending()) return;
                  if (!confirm(ft("将 ") + packet.path + ft(" 回退到第 ") + t.turn + ft(" 轮开始时？当前内容将被覆盖；预览后有改动会拒绝执行。"))) return;
                  if (!validRestore()) return;
                  clearRestore();
                  await mutate("/runs/" + run.id + "/restore", { turn: t.turn, file: f.id,
                    previewToken: packet.previewToken, expiresAt: packet.expiresAt });
                });
                section.replaceChildren(make("h4", packet.path + ft(" · 回退预览")),
                  make("p", ft("仅修改这个文件，不改变 Git 暂存区。预览有效至 ") + new Date(packet.expiresAt).toLocaleString(window.LisaFleetLocale.language)),
                  make("h4", ft("当前内容")), make("pre", describe(packet.current)),
                  make("h4", ft("回退后的内容")), make("pre", describe(packet.target)), send);
              });
              section.replaceChildren(prepare); section.hidden = false;
            }
          })));
      });
    }));
    if (!d.turns.length) $("change-turns").textContent = ft("此任务没有检查点记录。");
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
    if (!t) {
      shown = ""; $("timeline").hidden = true;
      $("timeline-list").replaceChildren(); $("timeline-note").textContent = "";
      return;
    }
    if (signature === shown) return;
    shown = signature;
    $("timeline").hidden = !t.events.length;
    $("timeline-note").textContent = first > 1
      ? ft("较早的记录已超出执行机的留存范围，以下从第 ") + first + ft(" 条开始。")
      : "";
    $("timeline-list").replaceChildren(
      ...t.events.map((e) => {
        const [label, detail] = describe(e),
          li = make("li", ""),
          time = make("time", new Date(e.at).toLocaleTimeString(window.LisaFleetLocale.language));
        time.dateTime = new Date(e.at).toISOString();
        li.append(time, make("span", label));
        if (detail) li.append(make("pre", detail));
        return li;
      }),
    );
  }
  function render(rebuild = true) {
    if (!host || !cap) return;
    const wid = $("workspace").value,
      rows = runs.filter((r) => r.workspaceId === wid),
      active = rows.find((r) => ["running", "waiting", "approval", "cancelling"].includes(r.state));
    if (!rows.some((r) => r.id === runId)) runId = (active || rows[0])?.id || "";
    renderTimeline();
    if (changesKey && changesKey !== timelineKey(runId)) clearChanges();
    if (handoffKey && (handoffKey !== timelineKey(runId) || handoffSeq !== rows.find((x) => x.id === runId)?.lastSeq || !(rows.find((x) => x.id === runId)?.capabilities?.handoff || rows.find((x) => x.id === runId)?.capabilities?.resume))) clearHandoff();
    $("observations").replaceChildren(...observations.filter((o) => o.workspaceId === wid && o.capabilities?.observe).map((o) =>
      make("p", o.agent + ft(" · 外部观察会话 · ") + o.state + ft(" · 仅观察"))));
    const r = rows.find((x) => x.id === runId),
      saved = pending(),
      blocked = busy || !!saved;
    $("step-workspace").toggleAttribute("aria-current", !wid);
    $("step-task").toggleAttribute("aria-current", !!wid);
    if (wid) $("step-task").setAttribute("aria-current", "step");
    else $("step-workspace").setAttribute("aria-current", "step");
    $("retry").hidden = !saved;
    const anotherWorkspace = saved && saved.payload.workspaceId !== wid;
    $("retry").disabled = busy || !!anotherWorkspace;
    $("retry").textContent = anotherWorkspace ? ft("请切回原工作区核对收据") : ft("核对收据并重试原操作");
    const actions = r?.capabilities || (cap.features?.includes("session-capabilities") ? {} : {
      append: cap.control && r?.state === "waiting", approve: cap.control && !!r?.approval,
      cancel: cap.control && ["running", "waiting", "approval"].includes(r?.state),
    });
    if (actions.append) $("agent").value = r.agent || "claude-code";
    const selectedAgent = $("agent").value;
    const provider = cap.agents?.find((a) => a.id === selectedAgent);
    const unavailable = provider ? provider.unavailable : cap.unavailable;
    $("capability").textContent = unavailable ? messages[unavailable] || unavailable
      : selectedAgent === "codex" ? ft("Codex 只读复核发送的文本与改动；不读取项目、不执行验证命令，不支持追加或审批；中断后可预览上下文并新建复核任务。内容使用执行机的 OpenAI API 配置发送。")
      : selectedAgent === "codex-workspace" ? ft("Codex · List / Read / Edit / Write 逐次审批，支持追加与取消；仅批准的目录内普通文件，不支持点文件、链接或执行命令。内容使用执行机的 OpenAI API 配置发送。")
      : ft("Claude Code · 文件操作逐次审批，可用工具取决于执行机上的版本。支持轮间追加与取消；确认旧进程退出后可创建续接任务。内容使用执行机的 Claude API 配置发送。");
    const activeRun = runs.find((x) => ["running", "waiting", "approval", "cancelling"].includes(x.state));
    $("start").disabled = blocked || !$("prompt").value.trim() || !wid || cap.workspaces.find((w) => w.id === wid)?.archived || !cap.control || !!unavailable ||
      (cap.agents && !provider?.start) || runs.some((x) => ["running", "waiting", "approval", "cancelling"].includes(x.state));
    $("follow").disabled = blocked || !actions.append || !$("prompt").value.trim();
    $("follow").hidden = !actions.append;
    $("start").hidden = !!actions.append;
    $("compose-title").textContent = actions.append ? ft("继续当前任务") : ft("新建任务");
    $("agent").disabled = !!actions.append || blocked;
    $("start-hint").textContent = saved ? ft("上次操作的结果尚待确认。请先核对收据，避免重复执行。")
      : !wid ? ft("尚未授权工作区。请在执行机上登记项目，并为此设备授权。")
      : !cap.control ? ft("当前设备只有查看权限。请在执行机上授予控制权限。")
      : cap.workspaces.find((w) => w.id === wid)?.archived ? ft("此工作区已归档，可查看历史任务。请选择其他工作区发起任务。")
      : unavailable ? messages[unavailable] || unavailable
      : activeRun && !actions.append ? (activeRun.workspaceId !== wid ? ft("这台 Mac 正在处理其他工作区的任务。完成或取消后可开始新任务。") : r?.state === "approval" ? ft("请先处理任务中的审批请求。") : ft("任务正在进行中，完成本轮后可追加指令。"))
      : "";
    if (!rebuild) return;
    const list = $("runs");
    list.replaceChildren();
    if (!rows.length) {
      list.append(make("p", ft("此工作区暂无任务。")));
      return;
    }
    const select = document.createElement("select");
    select.setAttribute("aria-label", ft("选择任务"));
    for (const x of rows) {
      const o = make(
        "option",
        new Date(x.createdAt).toLocaleString(window.LisaFleetLocale.language) +
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
      $("prompt").value = "";
      render();
      guard(async () => { await syncTimeline(); await syncChanges(); });
    };
    list.append(select);
    const card = make("article", "");
    card.dataset.state = r.state;
    card.append(make("strong", (r.agent || "claude-code") + " · " + (phase[r.state] || r.state)));
    if (r.updatedAt)
      card.append(make("small", ft(" · 最后更新 ") + new Date(r.updatedAt).toLocaleString(window.LisaFleetLocale.language)));
    if (r.result) card.append(make("pre", r.result));
    if (r.approval) {
      const a = r.approval;
      card.append(make("h3", ft("审批 ") + a.tool), make("pre", JSON.stringify(a.input, null, 2)));
      if (actions.approve) for (const [label, allow] of [
        [ft("允许这一次"), true],
        [ft("拒绝"), false],
      ]) {
        const b = btn(label, () =>
          mutate("/runs/" + r.id + "/decisions", { approvalId: a.id, allow }),
        );
        b.disabled = blocked;
        card.append(b);
      }
    }
    if (actions.cancel) {
      const b = btn(ft("取消此任务"), () => mutate("/runs/" + r.id + "/cancel", {}));
      b.disabled = blocked;
      card.append(b);
    }
    if (actions.resume && cap.features?.includes("task-continuation")) {
      const resume = btn(ft("从已保存上下文续接"), () => openContinuation(r));
      resume.disabled = blocked; card.append(resume);
    }
    if (actions.handoff && cap.features?.includes("agent-handoff")) {
      const handoff = btn(ft("预览智能体交接"), () => openHandoff(r));
      handoff.disabled = blocked; card.append(handoff);
    }
    list.append(card);
  }
  let handoffKey = "", handoffSeq = -1, handoffVersion = 0;
  function clearHandoff() {
    handoffVersion++; handoffKey = ""; handoffSeq = -1;
    $("handoff").hidden = true; $("handoff").replaceChildren();
  }
  function openContinuation(run) {
    clearHandoff();
    const v = version, request = handoffVersion, key = timelineKey(run.id), id = host.id, account = scope;
    handoffKey = key; handoffSeq = run.lastSeq;
    const section = $("handoff"), instruction = document.createElement("textarea"), preview = make("pre", "");
    instruction.maxLength = 16000; instruction.setAttribute("aria-label", ft("续接的新指令"));
    let generation = 0, packet = null, body = null;
    const valid = () => v === version && request === handoffVersion && handoffKey === key && runId === run.id;
    const send = btn(ft("确认开始新的续接任务"), async () => {
      if (!valid() || !packet || !body || busy || pending()) return;
      await mutate("/runs/" + run.id + "/continue", { ...body, previewToken: packet.previewToken, expiresAt: packet.expiresAt });
    });
    send.disabled = true;
    const prepare = btn(ft("预览续接上下文"), async () => {
      if (!valid() || !instruction.value.trim()) return;
      const expected = generation;
      const selected = { hostId: id, workspaceId: run.workspaceId, agent: run.agent, text: instruction.value };
      const result = await remote(id, account, "/runs/" + run.id + "/continue-preview", "POST", { ...selected, operationGeneration: cap.operationGeneration });
      if (!valid() || expected !== generation) return;
      packet = result; body = selected; preview.textContent = result.prompt; send.disabled = false;
    });
    prepare.disabled = true;
    instruction.oninput = () => { generation++; packet = null; body = null; preview.textContent = ""; send.disabled = true; prepare.disabled = !instruction.value.trim(); };
    section.replaceChildren(make("h3", ft("创建新的续接任务")),
      make("p", ft("旧进程已确认退出，但它的最后结果仍未核实。输入新的指令；预览只包含已保存的原始要求和最近结果摘要，不包含旧审批或工具调用。新会话需要独立审批。")),
      instruction, prepare, preview, send);
    section.hidden = false;
  }
  async function openHandoff(run) {
    clearHandoff();
    const v = version, request = ++handoffVersion, key = timelineKey(run.id), id = host.id, account = scope;
    const turns = await remote(id, account, "/runs/" + run.id + "/changes");
    if (v !== version || request !== handoffVersion || runId !== run.id) return;
    handoffKey = key; handoffSeq = run.lastSeq;
    const section = $("handoff"), agent = document.createElement("select"), turn = document.createElement("select");
    agent.setAttribute("aria-label", ft("交接接收方")); turn.setAttribute("aria-label", ft("交接轮次"));
    for (const a of cap.agents.filter((a) => a.id !== run.agent && a.start)) {
      const option = make("option", a.id + (a.mode === "packet-review" ? ft(" · 只读交接包复核") : ft(" · 独立审批的新任务")));
      option.value = a.id; agent.append(option);
    }
    for (const t of turns.turns.filter((t) => t.available)) {
      const option = make("option", ft("第 ") + t.turn + ft(" 轮") + (t.state === "interrupted" ? ft("（中断）") : ""));
      option.value = t.turn; turn.append(option);
    }
    const verification = document.createElement("textarea");
    verification.setAttribute("aria-label", ft("验证说明")); verification.maxLength = 4000;
    const preview = make("pre", ""), send = btn(ft("确认发送交接包"), async () => {});
    send.hidden = true;
    let generation = 0;
    const invalidate = () => { generation++; preview.textContent = ""; send.hidden = true; };
    agent.onchange = turn.onchange = verification.oninput = invalidate;
    const prepare = btn(ft("生成交接预览"), async () => {
      invalidate(); const expected = generation;
      const body = { hostId: id, workspaceId: run.workspaceId, agent: agent.value, turn: Number(turn.value), verification: verification.value };
      const packet = await remote(id, account, "/runs/" + run.id + "/handoff-preview", "POST", { ...body, operationGeneration: cap.operationGeneration });
      if (v !== version || handoffKey !== key || expected !== generation || request !== handoffVersion) return;
      preview.textContent = host.name + " · " + packet.recipient.agent + "\n\n" + packet.prompt;
      send.hidden = false;
      send.onclick = () => guard(async () => {
        if (expected !== generation || handoffKey !== key) return;
        await mutate("/runs/" + run.id + "/handoff", { ...body, previewToken: packet.previewToken, expiresAt: packet.expiresAt });
      });
    });
    prepare.disabled = !agent.value || !turn.value;
    section.replaceChildren(make("h3", ft("智能体交接")),
      make("p", ft("接收方位于当前 Mac。仅交接初始要求、选中轮次的要求、结果和改动；其他轮次不包含。旧审批不会转移。")),
      agent, turn, make("p", ft("验证说明（由你提供，原样发送，不代表平台验证）")), verification, prepare, preview, send);
    section.hidden = false;
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
        ...(cap.operationGeneration !== undefined ? { operationGeneration: cap.operationGeneration } : {}),
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
      if (reply.merge?.cleaned) { const w = cap.workspaces.find((w) => w.id === reply.run.workspaceId); if (w) w.archived = true; clearChanges(); }
      if (op.payload.text) $("prompt").value = "";
      notice(
        reply.status === "unknown"
          ? ft("已登记，但执行结果不确定。请核对任务；原操作不会再次执行。") + (reply.merge?.commit ? ft("候选提交：") + reply.merge.commit + ft("，需在执行机核对是否已合并。") : "")
          : ft("操作已接收。"),
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
    if (!$("follow").hidden) { $("follow").click(); return; }
    if (!$("start").disabled) guard(() => mutate("/runs", { text: $("prompt").value, ...(cap.agents ? { agent: $("agent").value } : {}) }));
  };
  $("follow").onclick = () => {
    if (!$("follow").disabled) guard(() => mutate("/runs/" + runId + "/messages", { text: $("prompt").value }));
  };
  $("prompt").addEventListener("input", () => render(false));
  $("agent").onchange = () => render();
  $("workspace").onchange = () => {
    runId = "";
    $("prompt").value = "";
    render();
    guard(async () => { await syncTimeline(); await syncChanges(); });
  };
  $("retry").onclick = () => guard(() => submit(pending(), true));
  $("refresh").onclick = () =>
    guard(async () => {
      await discover();
      const h = hosts.find((x) => x.id === host?.id);
      if (h && cap) await refreshRuns();
      else if (h) await choose(h);
    });
  let localConnectionKey = "", localPolling = false, localRequest = 0, localLoading = 0;
  function renderLocalConnection(l, workspaces) {
    const connecting = l.enabled && l.signedIn && !l.online && !l.error;
    $("link-status").textContent = l.online ? ft("已连接账号中继") : connecting ? ft("正在连接账号中继…") : ft("账号中继未连接");
    $("connect").hidden = l.online;
    $("connect").disabled = connecting;
    const key = JSON.stringify([l.pending, l.devices, workspaces.map((w) => [w.id, w.name, w.archived])]);
    if (key === localConnectionKey) return;
    localConnectionKey = key;
    const selected = new Set([...$("requests").querySelectorAll("input:checked")].map((input) => input.dataset.grant));
    $("requests").replaceChildren();
    for (const p of l.pending.filter((x) => x.fleet && !x.waiting)) {
      const box = make("article", "");
      box.append(make("h3", ft("核对配对码 ") + p.code));
      const check = (s, key) => {
        const label = make("label", ""),
          cb = document.createElement("input");
        cb.type = "checkbox";
        cb.dataset.grant = p.id + ":" + p.code + ":" + key;
        cb.checked = selected.has(cb.dataset.grant);
        label.append(cb, document.createTextNode(s));
        box.append(label);
        return cb;
      };
      const options = workspaces.filter((w) => !w.archived).map((w) => [w.id, check(w.name, w.id)]);
      const write = check(ft("允许在选定目录启动和控制 Claude Code"), "control");
      box.append(
        btn(ft("验证码一致，授权选中目录"), async () => {
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
            btn(ft("撤销设备"), async () => {
              await api("/api/remote/revoke", { id: x.id });
              await local();
            }),
          );
          return row;
        }),
    );
  }
  async function local() {
    const request = ++localRequest;
    let d;
    localLoading++;
    try { d = await api("/api/fleet/local"); } finally { localLoading--; }
    if (request !== localRequest) return;
    const l = d.link;
    renderLocalConnection(l, d.workspaces);
    $("maintenance").replaceChildren();
    if (d.maintenance) {
      const box = $("maintenance");
      box.append(make("p", ft("文件操作：") + d.maintenance.kind + " · " + d.maintenance.phase + (d.maintenance.commit ? ft(" · 候选提交 ") + d.maintenance.commit : "") + ft("。为保护文件，暂不接受新任务。")));
      if (d.maintenance.releasable) box.append(btn(ft("核对文件操作后解除保留"), async () => {
        if (!confirm(ft("请先确认执行机上的 Git / 文件操作已结束，检查原分支、工作区与操作收据。解除保留不会重试原操作。确认已经核对？"))) return;
        await api("/api/fleet/maintenance/release", { confirmed: true }); await local();
      }));
    }
    $("local-workspaces").replaceChildren(
      ...d.workspaces.map((w) => {
        const row = make("p", w.name + " · " + w.root + (w.checkpoints ? ft(" · 检查点已启用") : ""));
        if (w.archived) { row.append(make("span", ft(" · 已清理，保留历史"))); return row; }
        row.append(btn(ft("从当前提交创建隔离工作区"), async () => {
          await api("/api/fleet/worktrees", { workspaceId: w.id });
          await local();
          notice(ft("已创建独立工作区。请将新工作区授权给控制端；原目录未提交的内容不会带入。"));
        }));
        return row;
      }),
    );
    $("local-runs").replaceChildren(
      ...d.runs.map((r) => {
        const row = make("p", r.id + " · " + (phase[r.state] || r.state) + " ");
        row.append(
          btn(r.state === "unknown" ? ft("确认旧进程已退出，释放执行机") : ft("停止本机任务"), async () => {
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
    $("checkpoint-runs").replaceChildren(...(d.checkpointRuns || []).filter((r) =>
      !["running", "waiting", "approval", "cancelling"].includes(r.state)).map((r) => {
        const row = make("p", ft("任务 ") + r.id.slice(0, 8) + " · ");
        row.append(btn(ft("删除此任务的改动检查点"), async () => {
          if (!confirm(ft("删除该任务的所有检查点和改动？任务时间线和工作区文件会保留。"))) return;
          await api("/api/fleet/checkpoints/clear", { runId: r.id }); await local();
        })); return row;
      }));
    const storage = $("storage"); storage.hidden = !d.storage; storage.replaceChildren();
    if (d.storage) {
      const quota = document.createElement("input"), days = document.createElement("input");
      quota.type = days.type = "number"; quota.min = "1"; quota.max = "16384"; days.min = "0"; days.max = "3650";
      quota.value = String(d.storage.quotaMiB); days.value = String(d.storage.retentionDays);
      quota.setAttribute("aria-label", ft("检查点配额 MiB")); days.setAttribute("aria-label", ft("检查点保留天数"));
      const save = btn(ft("保存存储策略"), async () => {
        if (Number(days.value) > 0 && !confirm(ft("自动删除已结束任务超过保留天数的检查点？工作区文件与任务账本会保留。"))) return;
        await api("/api/fleet/storage", { quotaMiB: Number(quota.value), retentionDays: Number(days.value) }); await local();
      });
      const cleanupPreview = make("div", "");
      const preview = btn(ft("预览完整账本清理"), async () => {
        const packet = await api("/api/fleet/ledger/preview", {});
        const confirmClear = btn(ft("确认清理全部任务记录"), async () => {
          if (!confirm(ft("删除所有远程任务、要求、结果、时间线、分享、回执及检查点？工作区文件和设备授权会保留；旧操作将失效。"))) return;
          await api("/api/fleet/ledger/clear", { previewToken: packet.previewToken, expiresAt: packet.expiresAt }); await local();
        });
        cleanupPreview.replaceChildren(make("p", ft("清理预览：") + packet.runs + ft(" 个任务、") + packet.receipts + ft(" 个回执及 ") + packet.usedBytes + ft(" bytes 检查点。")), confirmClear);
      });
      storage.append(make("h3", ft("任务存储")), make("p", ft("检查点使用 ") + (d.storage.usedBytes / 1048576).toFixed(1) + ft(" MiB；总配额达到后仅停止新增检查点。保留天数 0 表示不自动清理。")),
        make("label", ft("检查点配额 MiB")), quota, make("label", ft("检查点保留天数")), days, save, preview, cleanupPreview);
    }
    const pockets = l.devices.filter((x) => x.secure && !x.fleet);
    $("shares").replaceChildren();
    if (!pockets.length) $("shares").append(make("p", ft("请先在本机设置中安全配对 Pocket。")));
    else if (!d.shares?.length) $("shares").append(make("p", ft("本机还没有可分享的远程任务。")));
    else for (const r of d.shares) {
      const row = make("article", "");
      row.append(make("h4", r.workspaceName + " · " + r.id.slice(0, 8) + " · " + (phase[r.state] || r.state)),
        make("small", ft("创建于 ") + new Date(r.createdAt).toLocaleString(window.LisaFleetLocale.language)));
      for (const p of pockets) {
        const shared = r.viewers.includes(p.id);
        row.append(btn((shared ? ft("撤销查看 · ") : ft("允许查看 · ")) + p.name + " · " + p.id.slice(0, 8), async () => {
          await api("/api/fleet/shares", { deviceId: p.id, runId: r.id, enabled: !shared });
          await local();
        }));
        if (shared) {
          const approved = r.approvers?.includes(p.id) === true;
          row.append(btn((approved ? ft("撤销审批 · ") : ft("允许审批 · ")) + p.name, async () => {
            if (!approved && !confirm(ft("允许此 Pocket 查看完整工具输入并审批此任务？每次审批仍需在手机上确认；查看权限本身不包含审批。"))) return;
            await api("/api/fleet/shares", { deviceId: p.id, runId: r.id, enabled: true, approve: !approved });
            await local();
          }));
        }
      }
      $("shares").append(row);
    }
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
  setInterval(async () => {
    if (!visible || document.hidden || !$("local").open || localPolling || localLoading) return;
    localPolling = true;
    const request = ++localRequest;
    try {
      const d = await api("/api/fleet/local");
      if (request === localRequest && visible && !document.hidden && $("local").open) renderLocalConnection(d.link, d.workspaces);
    } catch (e) {
      if (visible && $("local").open) notice(explain(e));
    } finally {
      localPolling = false;
    }
  }, 4000);
  setInterval(() => {
    if (visible && !document.hidden && !busy) guard(discover);
  }, 20000);
  setInterval(async () => {
    if (!visible || document.hidden || polling || busy || !cap) return;
    polling = true;
    try {
      await refreshRuns();
    } catch (e) {
      notice(explain(e));
    } finally {
      polling = false;
    }
  }, 4000);
  function openSetup() {
    $("local").open = true;
    $("local").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
    $("local").querySelector("summary").focus();
  }
  $("setup").onclick = openSetup;
  $("change-device").onclick = () => {
    document.querySelector(".device-section").scrollIntoView({ block: "start", behavior: "instant" });
    $("hosts").querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
  };
  window.parent.postMessage({ type: "lisa-fleet-ready" }, location.origin);
  guard(discover);
})();
