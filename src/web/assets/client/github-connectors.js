// Same inline script as main.js. Account/repository text is always rendered as text.
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
async function githubAction(id, action, body) {
  const route = action === 'disconnect' ? '/api/connectors/github/disconnect'
    : '/api/connectors/github/requests/' + encodeURIComponent(id) + '/' + action;
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
function githubRender(request) {
  const card = githubNode('section', '', 'github-connection-card');
  card.dataset.githubRequest = request.id;
  card.setAttribute('aria-label', tr('github.label'));
  const header = githubNode('div', '', 'github-card-header');
  header.appendChild(githubNode('strong', 'GitHub'));
  header.appendChild(githubNode('span', tr('github.readonly'), 'github-readonly'));
  card.appendChild(header);
  const status = githubNode('p', githubStatus[request.status] || request.status, 'github-status');
  status.setAttribute('role', 'status');
  card.appendChild(status);
  if (request.account) card.appendChild(githubNode('p', '@' + request.account.login, 'github-account'));
  if (request.repositories.length) card.appendChild(githubNode('p', request.repositories.map(r => r.fullName).join(' · '), 'github-repositories'));
  if (request.error) card.appendChild(githubNode('p', githubErrorText(request.error), 'github-error'));
  if (['waiting', 'failed'].includes(request.status)) {
    card.appendChild(githubNode('p', tr('github.detail'), 'github-detail'));
    card.appendChild(githubNode('p', tr('github.preview'), 'github-detail'));
    if (request.connected) githubButton(card, tr('github.retry'), () => githubAction(request.id, 'retry'));
    githubButton(card, request.connected ? tr('github.reconnect') : tr('github.existing'), () => githubAction(request.id, 'authorize', { mode: 'existing' }));
    githubButton(card, tr('github.login'), () => githubAction(request.id, 'authorize', { mode: 'login' }));
  }
  if (request.status === 'authorizing') {
    card.appendChild(githubNode('p', tr('github.authorizeDetail'), 'github-detail'));
    if (request.userCode) {
      card.appendChild(githubNode('code', request.userCode, 'github-user-code'));
      const link = githubNode('a', tr('github.openDevice'), 'github-login-link');
      link.href = 'https://github.com/login/device'; link.target = '_blank'; link.rel = 'noopener noreferrer';
      card.appendChild(link);
    }
  }
  if (request.status === 'selecting') {
    let selected = githubSelections.get(request.id);
    if (!selected) { selected = new Set(); githubSelections.set(request.id, selected); }
    card.appendChild(githubNode('p', tr('github.selectDetail'), 'github-detail'));
    githubButton(card, tr('github.switchAccount'), () => githubAction(request.id, 'authorize', { mode: 'login' }), 'github-button github-secondary');
    const list = githubNode('div', '', 'github-repo-list');
    const count = githubNode('p', tr('github.selected', { n: selected.size }), 'github-detail');
    const seen = new Set();
    function addRepo(name, isPrivate) {
      if (seen.has(name)) return;
      seen.add(name);
      const row = githubNode('label', '', 'github-repo-option');
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
      checkbox.checked = selected.has(name);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(name); else selected.delete(name);
        count.textContent = tr('github.selected', { n: selected.size }); confirm.disabled = selected.size === 0 || selected.size > 30;
      });
      row.append(checkbox, githubNode('span', name + (isPrivate ? tr('github.private') : ''))); list.appendChild(row);
    }
    card.appendChild(list);
    let page = 1;
    const load = async () => {
      const response = await fetch('/api/connectors/github/requests/' + request.id + '/repositories?page=' + page);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      data.repositories.forEach(r => addRepo(r.fullName, r.private));
      page++;
      more.hidden = data.repositories.length < 30;
    };
    const more = githubButton(card, tr('github.load'), load);
    const custom = document.createElement('input'); custom.placeholder = tr('github.repoPlaceholder'); custom.setAttribute('aria-label', tr('github.repoLabel'));
    custom.className = 'github-repo-input'; card.appendChild(custom);
    githubButton(card, tr('github.add'), async () => {
      const name = custom.value.trim();
      if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(name)) throw new Error('github_repository_unavailable');
      selected.add(name); addRepo(name, false); custom.value = '';
      count.textContent = tr('github.selected', { n: selected.size }); confirm.disabled = selected.size > 30;
    });
    card.appendChild(count);
    const confirm = githubButton(card, tr('github.confirm'), () => githubAction(request.id, 'confirm', { repositories: Array.from(selected) }));
    confirm.disabled = selected.size === 0;
    void load().catch(error => card.appendChild(githubNode('p', githubErrorText(error.message), 'github-error')));
  }
  if (!['completed', 'cancelled', 'expired'].includes(request.status))
    githubButton(card, tr('github.cancel'), () => githubAction(request.id, 'cancel'), 'github-button github-secondary');
  if (request.connected) githubButton(card, tr('github.disconnect'), () => githubAction(request.id, 'disconnect'), 'github-button github-secondary');
  return card;
}
async function githubRefresh() {
  const sid = window.lisaActiveSessionId;
  if (!sid || githubRefreshing) return;
  githubRefreshing = true;
  try {
    const response = await fetch('/api/connectors/github/requests?sessionId=' + encodeURIComponent(sid));
    if (!response.ok) return;
    const data = await response.json();
    if (sid !== window.lisaActiveSessionId) return;
    if (githubLastSession !== sid) { githubCards.clear(); githubSelections.clear(); githubLastSession = sid; }
    for (const request of data.requests) {
      const prior = githubCards.get(request.id);
      if (prior?.status !== 'completed' && request.status === 'completed') githubHistoryDirty = true;
      const fingerprint = JSON.stringify(request);
      const current = document.querySelector('[data-github-request="' + request.id + '"]');
      if (!current || prior?.fingerprint !== fingerprint) {
        const next = githubRender(request);
        if (current) current.replaceWith(next); else { removeChatEmpty(); log.appendChild(next); }
      }
      githubCards.set(request.id, { status: request.status, fingerprint });
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
