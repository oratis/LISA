// Shared connection card. Provider data is always text; login URLs are verified again here.
const githubCards = new Map();
const githubSelections = new Map();
let githubRefreshing = false;
let githubHistoryDirty = false;
let githubLastSession = '';
const workspaceCards = new Map();
function workspaceLoginUrl(url, vendor) {
  if (new Set(url.searchParams.keys()).size !== url.searchParams.size || url.username || url.password || url.hash || url.searchParams.get('redirect_uri') !== 'http://localhost:4870/oauth/' + vendor) return false;
  if (vendor === 'microsoft') return url.origin === 'https://login.microsoftonline.com' && /^\/(?:[a-f\d-]{36}|consumers)\/oauth2\/v2\.0\/authorize$/i.test(url.pathname);
  const paths = { atlassian: 'https://auth.atlassian.com/authorize', dropbox: 'https://www.dropbox.com/oauth2/authorize', todoist: 'https://app.todoist.com/oauth/authorize', figma: 'https://www.figma.com/oauth' };
  return paths[vendor] === url.origin + url.pathname;
}

const githubStatus = {
  waiting: tr('github.status.waiting'), authorizing: tr('github.status.authorizing'), selecting: tr('github.status.selecting'),
  ready: tr('github.status.ready'), resuming: tr('github.status.resuming'), completed: tr('github.status.completed'),
  cancelled: tr('github.status.cancelled'), failed: tr('github.status.failed'), expired: tr('github.status.expired')
};
const githubErrors = {
  workspace_client_not_configured: tr('workspace.config'),
  workspace_inaccessible: tr('workspace.access'),
  workspace_eventkit_platform: tr('workspace.platform'),
  workspace_eventkit_build: tr('workspace.build'),
  workspace_eventkit_access: tr('workspace.systemAccess'),
  slack_client_not_configured: tr('connector.error.slack_client_not_configured'),
  slack_reauthorization_required: tr('connector.error.slack_reauthorization_required'),
  slack_read_scope_required: tr('connector.error.slack_read_scope_required'),
  slack_channel_unavailable: tr('connector.error.slack_channel_unavailable'),
  slack_resource_mismatch: tr('connector.error.slack_resource_mismatch'),
  slack_access_denied: tr('connector.error.slack_access_denied'),
  slack_rate_limited: tr('connector.error.slack_rate_limited'),
  slack_callback_port_in_use: tr('connector.error.slack_callback_port_in_use'),
  slack_request_failed: tr('connector.error.slack_request_failed'),
  slack_response_too_large: tr('connector.error.slack_response_too_large'),
  slack_invalid_time_range: tr('connector.error.slack_invalid_time_range'),
  slack_invalid_thread: tr('connector.error.slack_invalid_thread'),
  slack_invalid_response: tr('connector.error.slack_invalid_response'),
  slack_unavailable: tr('connector.error.slack_unavailable'),
  notion_client_not_configured: tr('connector.error.notion_client_not_configured'),
  notion_reauthorization_required: tr('connector.error.notion_reauthorization_required'),
  notion_read_scope_required: tr('connector.error.notion_read_scope_required'),
  notion_page_unavailable: tr('connector.error.notion_page_unavailable'),
  notion_resource_mismatch: tr('connector.error.notion_resource_mismatch'),
  notion_access_denied: tr('connector.error.notion_access_denied'),
  notion_rate_limited: tr('connector.error.notion_rate_limited'),
  notion_callback_port_in_use: tr('connector.error.notion_callback_port_in_use'),
  notion_request_failed: tr('connector.error.notion_request_failed'),
  notion_response_too_large: tr('connector.error.notion_response_too_large'),
  notion_invalid_response: tr('connector.error.notion_invalid_response'),
  notion_unavailable: tr('connector.error.notion_unavailable'),
  drive_selection_required: tr('connector.error.drive_selection_required'),
  drive_selection_limit_exceeded: tr('connector.error.drive_selection_limit_exceeded'),
  drive_access_denied: tr('connector.error.drive_access_denied'),
  drive_rate_limited: tr('connector.error.drive_rate_limited'),
  drive_unavailable: tr('connector.error.drive_unavailable'),
  drive_request_failed: tr('connector.error.drive_request_failed'),
  drive_file_unavailable: tr('connector.error.drive_file_unavailable'),
  drive_file_type_unsupported: tr('connector.error.drive_file_type_unsupported'),
  drive_file_type_changed: tr('connector.error.drive_file_type_changed'),
  drive_download_denied: tr('connector.error.drive_download_denied'),
  drive_content_too_large: tr('connector.error.drive_content_too_large'),

  linear_reauthorization_required: tr('connector.error.linear_reauthorization_required'),
  linear_read_scope_required: tr('connector.error.linear_read_scope_required'),
  linear_resource_mismatch: tr('connector.error.linear_resource_mismatch'),
  mcp_tools_changed: tr('connector.error.mcp_tools_changed'),
  mcp_metadata_mismatch: tr('connector.error.mcp_metadata_mismatch'),
  mcp_access_denied: tr('connector.error.mcp_access_denied'),
  mcp_unavailable: tr('connector.error.mcp_unavailable'),
  mcp_tool_failed: tr('connector.error.mcp_tool_failed'),
  mcp_rate_limited: tr('connector.error.mcp_rate_limited'),

  google_client_not_configured: tr('connector.error.google_client_not_configured'),
  google_desktop_client_required: tr('connector.error.google_desktop_client_required'),
  google_reauthorization_required: tr('connector.error.google_reauthorization_required'),
  google_access_denied: tr('connector.error.google_access_denied'),
  google_scope_required: tr('connector.error.google_scope_required'),
  google_rate_limited: tr('connector.error.google_rate_limited'),
  authorization_cancelled: tr('connector.error.authorization_cancelled'),
  google_time_range_required: tr('connector.error.google_time_range_required'),

  github_cli_unavailable: tr('github.error.github_cli_unavailable'),
  github_login_required: tr('github.error.github_login_required'),
  github_secure_storage_required: tr('github.error.github_secure_storage_required'),
  github_reauthorization_required: tr('github.error.github_reauthorization_required'),
  github_access_denied_or_rate_limited: tr('github.error.github_access_denied_or_rate_limited'),
  authorization_expired: tr('github.error.authorization_expired'),
  request_cannot_retry: tr('github.error.request_cannot_retry'),
  github_repository_unavailable: tr('github.error.github_repository_unavailable'),
  connector_state_corrupt: tr('github.error.connector_state_corrupt'),
};
function githubNode(tag, text, cls) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
function githubErrorText(error) {
  return githubErrors[error] || tr('github.error.unknown', { code: String(error || 'connector_unavailable') });
}
async function githubAction(id, action, body, provider = "github") {
  const route = action === 'disconnect' ? '/api/connectors/' + provider + '/disconnect'
    : '/api/connectors/' + provider + '/requests/' + encodeURIComponent(id) + '/' + action;
  const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  await githubRefresh();
}
function githubButton(card, label, action, kind) {
  const button = githubNode('button', label, kind || 'github-button');
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    card.querySelectorAll('.github-error').forEach(node => node.remove());
    try { await action(); }
    catch (error) { card.appendChild(githubNode('p', githubErrorText(error.message), 'github-error')); }
    finally { button.disabled = false; }
  });
  card.appendChild(button);
  return button;
}
function githubRender(request, provider) {
  const app = workspaceCards.get(provider);
  const native = app?.workspace.vendor === "apple";
  const isGitHub = provider === "github";
  const isLinear = provider === "linear";
  const isDrive = provider === "google-drive";
  const isNotion = provider === "notion";
  const isSlack = provider === "slack";
  const name = app ? app.name : isSlack ? "Slack" : isDrive ? "Google Drive" : isNotion ? "Notion" : isLinear ? "Linear" : provider === "google-calendar" ? "Google Calendar" : provider === "gmail" ? "Gmail" : "GitHub";
  const resources = isGitHub ? request.repositories : request.resources;
  const action = (operation, body) => githubAction(request.id, operation, body, provider);
  const key = provider + ":" + request.id;
  const card = githubNode('section', '', 'github-connection-card');
  card.dataset.connectorKey = key;
  if (isGitHub) card.dataset.githubRequest = request.id;
  card.setAttribute('aria-label', isGitHub ? tr('github.label') : tr('connector.label', { name }));
  const header = githubNode('div', '', 'github-card-header');
  header.appendChild(githubNode('strong', name));
  header.appendChild(githubNode('span', tr('github.readonly'), 'github-readonly'));
  card.appendChild(header);
  const status = githubNode('p', !isGitHub && request.status === 'selecting' ? tr('connector.selectStatus') : githubStatus[request.status] || request.status, 'github-status');
  status.setAttribute('role', 'status');
  card.appendChild(status);
  if (request.account) card.appendChild(githubNode('p', app ? request.account.name : isGitHub ? '@' + request.account.login : ((isNotion || isSlack) ? request.account.workspaceName + " · " + request.account.name : isLinear ? request.account.name + (request.account.email ? " · " + request.account.email : "") : request.account.email), 'github-account'));
  if (resources.length) card.appendChild(githubNode('p', resources.map(r => isGitHub ? r.fullName : r.name).join(' · '), 'github-repositories'));
  if (request.error) card.appendChild(githubNode('p', githubErrorText(request.error), 'github-error'));
  if (['waiting', 'failed'].includes(request.status)) {
    card.appendChild(githubNode('p', app ? (native ? tr('workspace.nativeScope', {name}) : tr('workspace.scope', {name, scope:app.workspace.scope})) : isGitHub ? tr('github.detail') : tr(isSlack ? 'connector.slackDetail' : isDrive ? 'connector.driveDetail' : isNotion ? 'connector.notionDetail' : isLinear ? 'connector.linearDetail' : provider === 'gmail' ? 'connector.gmailDetail' : 'connector.calendarDetail'), 'github-detail'));
    if (isGitHub) card.appendChild(githubNode('p', tr('github.preview'), 'github-detail'));
    if (request.connected) githubButton(card, tr('github.retry'), () => action('retry'));
    addLoginActions();
  }
  function addLoginActions() {
    const modes = app ? ['login'] : isGitHub ? ['existing', 'login'] : (isSlack || isLinear || isDrive || isNotion || provider === 'gmail') ? ['login'] : ['freebusy', 'events'];
    for (const mode of modes) {
      const label = app ? tr(native ? 'workspace.allow' : 'workspace.login', {name}) : isGitHub ? tr(mode === 'existing' ? 'github.existing' : 'github.login')
        : tr('connector.auth.' + (isSlack ? 'slack' : isDrive ? 'drive' : isNotion ? 'notion' : isLinear ? 'linear' : provider === 'gmail' ? 'gmail' : mode));
      githubButton(card, label, async () => { githubSelections.delete(key); await action('authorize', { mode }); });
    }
  }
  if (request.status === 'authorizing') {
    card.appendChild(githubNode('p', app ? tr(native ? 'workspace.system' : 'workspace.return', {name}) : isGitHub ? tr('github.authorizeDetail') : tr(isSlack ? 'connector.slackAuthorize' : isDrive ? 'connector.driveAuthorize' : isNotion ? 'connector.notionAuthorize' : isLinear ? 'connector.linearAuthorize' : 'connector.authorizeDetail'), 'github-detail'));
    if (!isGitHub && request.authorizationUrl) {
      try {
        const url = new URL(request.authorizationUrl);
        if ((app ? workspaceLoginUrl(url, app.workspace.vendor) : isSlack ? url.origin === 'https://slack.com' && url.pathname === '/oauth/v2/authorize' && !url.searchParams.get('scope') && url.searchParams.get('user_scope') === 'channels:read,channels:history,groups:read,groups:history' && url.searchParams.get('code_challenge_method') === 'S256' : isNotion ? url.origin === 'https://api.notion.com' && url.pathname === '/v1/oauth/authorize' && url.searchParams.get('owner') === 'user' && url.searchParams.get('response_type') === 'code' : isLinear ? url.origin === 'https://mcp.linear.app' && url.pathname === '/authorize' && url.searchParams.get('scope') === 'read' && url.searchParams.get('resource') === 'https://mcp.linear.app/mcp/readonly' : url.origin === 'https://accounts.google.com' && url.pathname === '/o/oauth2/v2/auth') && !url.username && !url.password) {
          const link = githubNode('a', app ? tr('workspace.open', {name}) : tr(isSlack ? 'connector.openSlack' : isNotion ? 'connector.openNotion' : isLinear ? 'connector.openLinear' : 'connector.openGoogle'), 'github-login-link');
          link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.appendChild(link);
        }
      } catch { /* Never render an untrusted authorization URL. */ }
    }
    if (request.userCode) {
      card.appendChild(githubNode('code', request.userCode, 'github-user-code'));
      const link = githubNode('a', tr('github.openDevice'), 'github-login-link');
      link.href = 'https://github.com/login/device'; link.target = '_blank'; link.rel = 'noopener noreferrer';
      card.appendChild(link);
    }
  }
  if (request.status === 'selecting') {
    let selected = githubSelections.get(key);
    if (!selected) { selected = new Set(); githubSelections.set(key, selected); }
    card.appendChild(githubNode('p', app ? tr('workspace.select', {name}) : isGitHub ? tr('github.selectDetail') : tr(isSlack ? 'connector.slackSelect' : isDrive ? 'connector.driveSelect' : isNotion ? 'connector.notionSelect' : isLinear ? 'connector.linearSelect' : 'connector.selectDetail'), 'github-detail'));
    addLoginActions();
    const list = githubNode('div', '', 'github-repo-list');
    const count = githubNode('p', tr(isGitHub ? 'github.selected' : 'connector.selected', { n: selected.size }), 'github-detail');
    const seen = new Set();
    function addRepo(name, isPrivate, label = name) {
      if (seen.has(name)) return;
      seen.add(name);
      const row = githubNode('label', '', 'github-repo-option');
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
      checkbox.value = name; checkbox.checked = selected.has(name);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(name); else selected.delete(name);
        count.textContent = tr(isGitHub ? 'github.selected' : 'connector.selected', { n: selected.size }); confirm.disabled = selected.size === 0 || selected.size > 30;
      });
      row.append(checkbox, githubNode('span', label + (isPrivate ? tr('github.private') : ''))); list.appendChild(row);
    }
    card.appendChild(list);
    let page = 1;
    const load = async () => {
      const response = await fetch('/api/connectors/' + provider + '/requests/' + request.id + (isGitHub ? '/repositories?page=' : '/resources?page=') + page);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      const items = isGitHub ? data.repositories : data.resources;
      items.forEach(r => addRepo(isGitHub ? r.fullName : r.id, isGitHub && r.private, isGitHub ? r.fullName : r.name));
      page++;
      more.hidden = items.length < 30;
    };
    const more = githubButton(card, isGitHub ? tr('github.load') : tr('connector.load'), load);
    if (app && !native) {
      const field = document.createElement('input'); field.className = 'github-repo-input';
      field.placeholder = app.workspace.hint; field.setAttribute('aria-label', tr('workspace.id', {name})); card.appendChild(field);
      githubButton(card, tr('workspace.add'), async () => {
        let id = field.value.trim();
        if (provider === 'figma' && /^https:\/\//i.test(id)) {
          const link = new URL(id);
          const match = /^\/(?:design|file|proto)\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(link.pathname);
          if (!match || !['www.figma.com','figma.com'].includes(link.hostname) || link.port || link.username || link.password) throw new Error('invalid_resource');
          const node = link.searchParams.get('node-id');
          if (node && !/^\d+[:-]\d+$/.test(node)) throw new Error('invalid_resource');
          id = match[1] + (node ? '|' + node.replace('-',':') : '');
        }
        if (!id || id.length > 700 || selected.size >= 30) throw new Error('invalid_resources');
        selected.add(id);
        addRepo(id, false);
        for (const checkbox of list.querySelectorAll('input')) if (checkbox.value === id) checkbox.checked = true;
        field.value = ''; count.textContent = tr('connector.selected', {n:selected.size}); confirm.disabled = false;
      });
    }
    if (isGitHub) {
    const custom = document.createElement('input'); custom.placeholder = tr('github.repoPlaceholder'); custom.setAttribute('aria-label', tr('github.repoLabel'));
    custom.className = 'github-repo-input'; card.appendChild(custom);
    githubButton(card, tr('github.add'), async () => {
      const name = custom.value.trim();
      if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(name)) throw new Error('github_repository_unavailable');
      selected.add(name); addRepo(name, false); custom.value = '';
      count.textContent = tr(isGitHub ? 'github.selected' : 'connector.selected', { n: selected.size }); confirm.disabled = selected.size > 30;
    });
    }
    card.appendChild(count);
    const confirm = githubButton(card, tr('github.confirm'), () => action('confirm', isGitHub ? { repositories: Array.from(selected) } : { resources: Array.from(selected) }));
    confirm.disabled = selected.size === 0;
    void load().catch(error => card.appendChild(githubNode('p', githubErrorText(error.message), 'github-error')));
  }
  if (!['completed', 'cancelled', 'expired'].includes(request.status))
    githubButton(card, tr('github.cancel'), () => action('cancel'), 'github-button github-secondary');
  if (request.connected) githubButton(card, tr('github.disconnect'), () => action('disconnect'), 'github-button github-secondary');
  return card;
}
async function githubRefresh() {
  const sid = window.lisaActiveSessionId;
  if (!sid || githubRefreshing) return;
  githubRefreshing = true;
  try {
    const [github, catalog] = await Promise.all([
      fetch('/api/connectors/github/requests?sessionId=' + encodeURIComponent(sid)),
      fetch('/api/connectors?sessionId=' + encodeURIComponent(sid)),
    ]);
    const data = catalog.ok ? await catalog.json() : {connectors:[], requests:[]};
    for (const app of data.connectors) if (app.workspace) workspaceCards.set(app.id,app);
    const entries = github.ok ? (await github.json()).requests.map(request => ({request,provider:'github'})) : [];
    entries.push(...(data.requests || []));
    if (sid !== window.lisaActiveSessionId) return;
    if (githubLastSession !== sid) { githubCards.clear(); githubSelections.clear(); githubLastSession = sid; }
    for (const { request, provider } of entries) {
      const key = provider + ':' + request.id;
      const prior = githubCards.get(key);
      if (prior?.status !== 'completed' && request.status === 'completed') githubHistoryDirty = true;
      const fingerprint = JSON.stringify(request);
      const current = document.querySelector('[data-connector-key="' + key + '"]');
      if (!current || prior?.fingerprint !== fingerprint) {
        const next = githubRender(request, provider);
        if (current) current.replaceWith(next); else { removeChatEmpty(); log.appendChild(next); }
      }
      githubCards.set(key, { status: request.status, fingerprint });
    }
    if (githubHistoryDirty && !sendBtn.disabled) {
      githubHistoryDirty = false;
      window.lisaResetChatLog();
    }
  } catch { /* Offline: keep the last server-confirmed card, retry on reconnect. */ }
  finally { githubRefreshing = false; }
}
// Poll while a card is active: SSE loss/reconnect must not lose a continuation result.
setInterval(() => {
  if (!document.hidden && [...githubCards.values()].some(r => !['completed', 'cancelled', 'expired'].includes(r.status))) void githubRefresh();
}, 3000);
