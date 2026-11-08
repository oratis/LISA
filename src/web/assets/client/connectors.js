// Shared connection card. Provider data is always text; login URLs are verified again here.
const githubCards = new Map();
const githubSelections = new Map();
let githubRefreshing = false;
let githubHistoryDirty = false;
let githubLastSession = '';

const githubStatus = {
  waiting: tr('github.status.waiting'), authorizing: tr('github.status.authorizing'), selecting: tr('github.status.selecting'),
  ready: tr('github.status.ready'), resuming: tr('github.status.resuming'), completed: tr('github.status.completed'),
  cancelled: tr('github.status.cancelled'), failed: tr('github.status.failed'), expired: tr('github.status.expired')
};
const githubErrors = {
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
function githubButton(parent, label, action, kind) {
  const button = githubNode('button', label, kind || 'github-button');
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    const card = button.closest('.github-connection-card');
    card.querySelectorAll('.github-error').forEach(node => node.remove());
    try { await action(); }
    catch (error) { card.appendChild(githubNode('p', githubErrorText(error.message), 'github-error')); }
    finally { button.disabled = false; }
  });
  parent.appendChild(button);
  return button;
}
// Match the shell's outline icons. All paths are local constants.
const connectorIconPaths = {
  gmail: 'M3 5h18v14H3z M3 6l9 7 9-7',
  'google-calendar': 'M3 5h18v16H3z M3 10h18 M8 3v4 M16 3v4 M8 14h2 M14 14h2',
  'google-drive': 'M9 3h6l8 14-3 5H4l-3-5z M9 3l8 14h6 M1 17h16 M15 3L4 22',
  github: 'M6 8v8 M8 16c6 0 10-2 10-8 M6 3a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z M6 16a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z M18 3a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  slack: 'M10 3L7 21 M17 3l-3 18 M4 9h17 M3 15h17',
  notion: 'M5 3h10l4 4v14H5z M14 3v5h5 M8 12h8 M8 16h6',
  linear: 'M4 17l3 3 M3 12l9 9 M5 7l12 12 M8 5a9 9 0 0 1 12 12z',
  lock: 'M5 10h14v11H5z M8 10V7a4 4 0 0 1 8 0v3',
};
function connectorIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', connectorIconPaths[name]);
  svg.appendChild(path);
  return svg;
}

function renderResourcePicker(card, footer, request, provider) {
  const limit = 30; // ConnectorService.confirm grant limit and resource page size.
  const isGitHub = provider === 'github';
  const key = card.dataset.connectorKey;
  const account = JSON.stringify(request.account);
  let draft = githubSelections.get(key);
  if (!draft || draft.account !== account) {
    draft = { account, choices: new Map(), selected: new Set(), page: 1, hasMore: true };
    githubSelections.set(key, draft);
  }
  const { choices, selected } = draft;
  const inputs = new Map();
  const picker = githubNode('fieldset', '', 'connector-picker');
  picker.setAttribute('aria-label', tr('connector.selectStatus'));
  const toolbar = githubNode('div', '', 'connector-toolbar');
  const count = githubNode('span', '', 'connector-count');
  count.setAttribute('role', 'status');
  const clear = githubNode('button', tr('connector.clear'), 'connector-text-button');
  const bulk = githubNode('button', '', 'connector-text-button');
  clear.type = bulk.type = 'button';
  toolbar.append(count, clear, bulk);
  const list = githubNode('div', '', 'github-repo-list');
  const notice = githubNode('p', '', 'connector-list-notice');
  notice.setAttribute('role', 'status');
  picker.append(toolbar, list, notice);
  card.appendChild(picker);

  const confirm = githubButton(footer, tr('github.confirm'), async () => {
    picker.disabled = true;
    confirm.textContent = tr('connector.connecting');
    try {
      const ids = Array.from(selected);
      await githubAction(request.id, 'confirm', isGitHub ? { repositories: ids } : { resources: ids }, provider);
    } finally {
      picker.disabled = false;
      confirm.textContent = tr('github.confirm');
    }
  }, 'github-button connector-primary');

  let customAdd;
  function syncSelection() {
    const full = selected.size >= limit;
    for (const [id, input] of inputs) {
      input.checked = selected.has(id);
      input.disabled = full && !input.checked;
    }
    const capped = choices.size > limit;
    count.textContent = tr(capped ? 'connector.countLimited' : 'connector.count', {
      n: selected.size, total: capped ? limit : choices.size,
    });
    const selectAllKey = draft.hasMore && choices.size ? 'connector.selectLoaded' : 'connector.selectAll';
    bulk.textContent = tr(capped ? 'connector.fillSelection' : selectAllKey, { n: limit });
    bulk.disabled = full || selected.size === choices.size;
    clear.disabled = !selected.size;
    confirm.disabled = !selected.size || picker.disabled;
    if (customAdd) customAdd.disabled = full;
  }
  function addChoice(id, label) {
    if (inputs.has(id)) return;
    choices.set(id, label);
    const row = githubNode('label', '', 'github-repo-option');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => {
      if (input.checked) selected.add(id); else selected.delete(id);
      syncSelection();
    });
    inputs.set(id, input);
    row.append(input, githubNode('span', label));
    list.appendChild(row);
  }
  choices.forEach((label, id) => addChoice(id, label));
  bulk.addEventListener('click', () => {
    for (const id of choices.keys()) {
      if (selected.size >= limit) break;
      selected.add(id);
    }
    syncSelection();
  });
  clear.addEventListener('click', () => { selected.clear(); syncSelection(); });

  const more = githubNode('button', tr('connector.load'), 'github-button connector-more');
  more.type = 'button';
  picker.appendChild(more);
  async function load() {
    more.disabled = true;
    notice.textContent = tr('connector.loading');
    list.setAttribute('aria-busy', 'true');
    try {
      const base = '/api/connectors/' + provider + '/requests/' + encodeURIComponent(request.id);
      const response = await fetch(base + (isGitHub ? '/repositories?page=' : '/resources?page=') + draft.page);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (!card.isConnected) return;
      const items = isGitHub ? data.repositories : data.resources;
      for (const item of items) {
        addChoice(isGitHub ? item.fullName : item.id, isGitHub ? item.fullName + (item.private ? tr('github.private') : '') : item.name);
      }
      draft.hasMore = items.length === limit && draft.page < (isGitHub ? 100 : 10);
      draft.page++;
      more.textContent = tr('connector.load');
      notice.textContent = choices.size ? '' : tr('connector.empty');
    } catch (error) {
      notice.textContent = githubErrorText(error.message);
      more.textContent = tr('connector.retryLoad');
    } finally {
      list.removeAttribute('aria-busy');
      more.disabled = false;
      more.hidden = !draft.hasMore;
      syncSelection();
    }
  }
  more.addEventListener('click', load);
  more.hidden = !draft.hasMore || draft.page === 1;

  if (isGitHub) {
    const form = githubNode('form', '', 'connector-custom');
    const customInput = document.createElement('input');
    customInput.className = 'github-repo-input';
    customInput.placeholder = tr('github.repoPlaceholder');
    customInput.setAttribute('aria-label', tr('github.repoLabel'));
    customInput.required = true;
    customAdd = githubNode('button', tr('github.add'), 'github-button');
    customAdd.type = 'submit';
    form.append(customInput, customAdd);
    picker.appendChild(form);
    customInput.addEventListener('input', () => customInput.setCustomValidity(''));
    form.addEventListener('submit', event => {
      event.preventDefault();
      const id = customInput.value.trim();
      if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(id)) {
        customInput.setCustomValidity(githubErrorText('github_repository_unavailable'));
        customInput.reportValidity();
        return;
      }
      if (selected.size >= limit) return;
      addChoice(id, id);
      selected.add(id);
      customInput.value = '';
      if (!draft.hasMore) notice.textContent = '';
      syncSelection();
    });
  }
  syncSelection();
  if (draft.page === 1) void load();
  else if (!choices.size) notice.textContent = tr('connector.empty');
}

function githubRender(request, provider) {
  const selecting = request.status === 'selecting';
  const isGitHub = provider === "github";
  const isLinear = provider === "linear";
  const isDrive = provider === "google-drive";
  const isNotion = provider === "notion";
  const isSlack = provider === "slack";
  const name = isSlack ? "Slack" : isDrive ? "Google Drive" : isNotion ? "Notion" : isLinear ? "Linear" : provider === "google-calendar" ? "Google Calendar" : provider === "gmail" ? "Gmail" : "GitHub";
  const resources = isGitHub ? request.repositories : request.resources;
  const action = (operation, body) => githubAction(request.id, operation, body, provider);
  const key = provider + ":" + request.id;
  const card = githubNode('section', '', 'github-connection-card');
  card.dataset.connectorKey = key;
  if (isGitHub) card.dataset.githubRequest = request.id;
  card.setAttribute('aria-label', isGitHub ? tr('github.label') : tr('connector.label', { name }));
  const header = githubNode('div', '', 'github-card-header');
  const mark = githubNode('span', '', 'connector-mark');
  mark.appendChild(connectorIcon(provider));
  const identity = githubNode('div', '', 'connector-identity');
  identity.appendChild(githubNode('strong', name));
  let accountName = '';
  if (request.account) {
    const account = request.account;
    accountName = isGitHub ? '@' + account.login : isNotion || isSlack ? account.workspaceName + ' · ' + account.name :
      isLinear ? [account.name, account.email].filter(Boolean).join(' · ') : account.email;
  }
  if (!selecting && accountName) identity.appendChild(githubNode('span', accountName, 'github-account'));
  const badge = githubNode('span', tr('github.readonly'), 'github-readonly');
  badge.prepend(connectorIcon('lock'));
  header.append(mark, identity, badge);
  card.appendChild(header);
  const status = githubNode('p', selecting ? tr('connector.choose.' + provider) : githubStatus[request.status] || request.status, 'github-status');
  status.setAttribute('role', 'status');
  card.appendChild(status);
  const footer = githubNode('div', '', 'connector-footer');
  if (!selecting) githubSelections.delete(key);
  if (resources.length) card.appendChild(githubNode('p', resources.map(r => isGitHub ? r.fullName : r.name).join(' · '), 'github-repositories'));
  if (request.error) card.appendChild(githubNode('p', githubErrorText(request.error), 'github-error'));
  if (['waiting', 'failed'].includes(request.status)) {
    card.appendChild(githubNode('p', isGitHub ? tr('github.detail') : tr(isSlack ? 'connector.slackDetail' : isDrive ? 'connector.driveDetail' : isNotion ? 'connector.notionDetail' : isLinear ? 'connector.linearDetail' : provider === 'gmail' ? 'connector.gmailDetail' : 'connector.calendarDetail'), 'github-detail'));
    if (isGitHub) card.appendChild(githubNode('p', tr('github.preview'), 'github-detail'));
    if (request.connected) githubButton(card, tr('github.retry'), () => action('retry'));
    addLoginActions(card);
  }
  function addLoginActions(target) {
    const modes = isGitHub ? ['existing', 'login'] : (isSlack || isLinear || isDrive || isNotion || provider === 'gmail') ? ['login'] : ['freebusy', 'events'];
    for (const mode of modes) {
      if (selecting && mode === 'existing') continue;
      const label = isGitHub ? tr(mode === 'existing' ? 'github.existing' : 'github.login')
        : tr('connector.auth.' + (isSlack ? 'slack' : isDrive ? 'drive' : isNotion ? 'notion' : isLinear ? 'linear' : provider === 'gmail' ? 'gmail' : mode));
      githubButton(target, label, async () => { githubSelections.delete(key); await action('authorize', { mode }); });
    }
  }
  if (request.status === 'authorizing') {
    card.appendChild(githubNode('p', isGitHub ? tr('github.authorizeDetail') : tr(isSlack ? 'connector.slackAuthorize' : isDrive ? 'connector.driveAuthorize' : isNotion ? 'connector.notionAuthorize' : isLinear ? 'connector.linearAuthorize' : 'connector.authorizeDetail'), 'github-detail'));
    if (!isGitHub && request.authorizationUrl) {
      try {
        const url = new URL(request.authorizationUrl);
        if ((isSlack ? url.origin === 'https://slack.com' && url.pathname === '/oauth/v2/authorize' && !url.searchParams.get('scope') && url.searchParams.get('user_scope') === 'channels:read,channels:history,groups:read,groups:history' && url.searchParams.get('code_challenge_method') === 'S256' : isNotion ? url.origin === 'https://api.notion.com' && url.pathname === '/v1/oauth/authorize' && url.searchParams.get('owner') === 'user' && url.searchParams.get('response_type') === 'code' : isLinear ? url.origin === 'https://mcp.linear.app' && url.pathname === '/authorize' && url.searchParams.get('scope') === 'read' && url.searchParams.get('resource') === 'https://mcp.linear.app/mcp/readonly' : url.origin === 'https://accounts.google.com' && url.pathname === '/o/oauth2/v2/auth') && !url.username && !url.password) {
          const link = githubNode('a', tr(isSlack ? 'connector.openSlack' : isNotion ? 'connector.openNotion' : isLinear ? 'connector.openLinear' : 'connector.openGoogle'), 'github-login-link');
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
  if (selecting) {
    const settings = githubNode('details', '', 'connector-account-options');
    const summary = githubNode('summary', accountName || tr('connector.accountOptions'), 'github-account');
    summary.title = tr('connector.accountOptions');
    summary.setAttribute('aria-label', [summary.title, accountName].filter(Boolean).join(' · '));
    settings.appendChild(summary);
    addLoginActions(settings);
    identity.appendChild(settings);
    card.appendChild(githubNode('p', tr('connector.scope.' + provider), 'github-detail'));
  }
  if (!['completed', 'cancelled', 'expired'].includes(request.status))
    githubButton(footer, tr('github.cancel'), () => action('cancel'), 'github-button github-secondary');
  if (request.connected) githubButton(footer, tr('github.disconnect'), () => action('disconnect'), 'github-button github-secondary');
  if (selecting) renderResourcePicker(card, footer, request, provider);
  if (footer.childElementCount) card.appendChild(footer);
  return card;
}
async function githubRefresh() {
  const sid = window.lisaActiveSessionId;
  if (!sid || githubRefreshing) return;
  githubRefreshing = true;
  try {
    const batches = await Promise.all(['github', 'google-calendar', 'gmail', 'linear', 'google-drive', 'notion', 'slack'].map(async provider => {
      const response = await fetch('/api/connectors/' + provider + '/requests?sessionId=' + encodeURIComponent(sid));
      if (!response.ok) return [];
      const data = await response.json();
      return data.requests.map(request => ({ request, provider }));
    }));
    if (sid !== window.lisaActiveSessionId) return;
    if (githubLastSession !== sid) { githubCards.clear(); githubSelections.clear(); githubLastSession = sid; }
    for (const { request, provider } of batches.flat()) {
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
