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
  const isGitHub = provider === "github";
  const isLinear = provider === "linear";
  const name = isLinear ? "Linear" : provider === "google-calendar" ? "Google Calendar" : provider === "gmail" ? "Gmail" : "GitHub";
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
  if (request.account) card.appendChild(githubNode('p', isGitHub ? '@' + request.account.login : (isLinear ? request.account.name + (request.account.email ? " · " + request.account.email : "") : request.account.email), 'github-account'));
  if (resources.length) card.appendChild(githubNode('p', resources.map(r => isGitHub ? r.fullName : r.name).join(' · '), 'github-repositories'));
  if (request.error) card.appendChild(githubNode('p', githubErrorText(request.error), 'github-error'));
  if (['waiting', 'failed'].includes(request.status)) {
    card.appendChild(githubNode('p', isGitHub ? tr('github.detail') : tr(isLinear ? 'connector.linearDetail' : provider === 'gmail' ? 'connector.gmailDetail' : 'connector.calendarDetail'), 'github-detail'));
    if (isGitHub) card.appendChild(githubNode('p', tr('github.preview'), 'github-detail'));
    if (request.connected) githubButton(card, tr('github.retry'), () => action('retry'));
    addLoginActions();
  }
  function addLoginActions() {
    const modes = isGitHub ? ['existing', 'login'] : (isLinear || provider === 'gmail') ? ['login'] : ['freebusy', 'events'];
    for (const mode of modes) {
      const label = isGitHub ? tr(mode === 'existing' ? 'github.existing' : 'github.login')
        : tr('connector.auth.' + (isLinear ? 'linear' : provider === 'gmail' ? 'gmail' : mode));
      githubButton(card, label, async () => { githubSelections.delete(key); await action('authorize', { mode }); });
    }
  }
  if (request.status === 'authorizing') {
    card.appendChild(githubNode('p', isGitHub ? tr('github.authorizeDetail') : tr(isLinear ? 'connector.linearAuthorize' : 'connector.authorizeDetail'), 'github-detail'));
    if (!isGitHub && request.authorizationUrl) {
      try {
        const url = new URL(request.authorizationUrl);
        if ((isLinear ? url.origin === 'https://mcp.linear.app' && url.pathname === '/authorize' && url.searchParams.get('scope') === 'read' && url.searchParams.get('resource') === 'https://mcp.linear.app/mcp/readonly' : url.origin === 'https://accounts.google.com' && url.pathname === '/o/oauth2/v2/auth') && !url.username && !url.password) {
          const link = githubNode('a', tr(isLinear ? 'connector.openLinear' : 'connector.openGoogle'), 'github-login-link');
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
    card.appendChild(githubNode('p', isGitHub ? tr('github.selectDetail') : tr(isLinear ? 'connector.linearSelect' : 'connector.selectDetail'), 'github-detail'));
    addLoginActions();
    const list = githubNode('div', '', 'github-repo-list');
    const count = githubNode('p', tr(isGitHub ? 'github.selected' : 'connector.selected', { n: selected.size }), 'github-detail');
    const seen = new Set();
    function addRepo(name, isPrivate, label = name) {
      if (seen.has(name)) return;
      seen.add(name);
      const row = githubNode('label', '', 'github-repo-option');
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
      checkbox.checked = selected.has(name);
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
    const batches = await Promise.all(['github', 'google-calendar', 'gmail', 'linear'].map(async provider => {
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
