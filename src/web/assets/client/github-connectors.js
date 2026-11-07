// Same inline script as main.js. Account/repository text is always rendered as text.
const githubCards = new Map();
const githubSelections = new Map();
let githubRefreshing = false;
let githubHistoryDirty = false;
let githubLastSession = '';

const githubStatus = {
  waiting: '等待连接', authorizing: '正在授权', selecting: '选择可读取的仓库',
  ready: '已连接，等待继续', resuming: '已连接，正在继续原任务', completed: '原任务已完成',
  cancelled: '任务已取消', failed: '需要处理', expired: '连接请求已过期'
};
const githubErrors = {
  github_cli_unavailable: '未找到 GitHub CLI。请先安装 gh，再重试连接。',
  github_login_required: '本机还没有可用的 GitHub 登录，请选择“登录 GitHub”。',
  github_secure_storage_required: 'GitHub 凭据未存入系统钥匙串。请修复 gh 的安全存储后重试。',
  github_reauthorization_required: 'GitHub 登录已失效，请重新连接。',
  github_access_denied_or_rate_limited: 'GitHub 暂时拒绝访问，请检查仓库权限或稍后重试。',
  authorization_expired: '授权已超时，请重新登录。',
  request_cannot_retry: '本次任务无法再重试，请重新发送任务。',
  github_repository_unavailable: '无法读取这个仓库，请检查仓库名称和账号权限。',
  connector_state_corrupt: '连接记录无法读取，当前连接已停止。',
};
function githubNode(tag, text, cls) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
function githubErrorText(error) {
  return githubErrors[error] || '操作未完成，请稍后重试（' + String(error || 'connector_unavailable') + '）。';
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
  card.setAttribute('aria-label', 'GitHub 只读连接');
  const header = githubNode('div', '', 'github-card-header');
  header.appendChild(githubNode('strong', 'GitHub'));
  header.appendChild(githubNode('span', '只读', 'github-readonly'));
  card.appendChild(header);
  const status = githubNode('p', githubStatus[request.status] || request.status, 'github-status');
  status.setAttribute('role', 'status');
  card.appendChild(status);
  if (request.account) card.appendChild(githubNode('p', '@' + request.account.login, 'github-account'));
  if (request.repositories.length) card.appendChild(githubNode('p', request.repositories.map(r => r.fullName).join(' · '), 'github-repositories'));
  if (request.error) card.appendChild(githubNode('p', githubErrorText(request.error), 'github-error'));
  if (['waiting', 'failed'].includes(request.status)) {
    card.appendChild(githubNode('p', '仅在你选定的仓库中读取项目、提交、Issue、PR 和运行记录。连接完成后自动继续本条任务；发送新消息会取消尚未完成的任务。', 'github-detail'));
    card.appendChild(githubNode('p', '预览版使用 GitHub CLI 登录。GitHub 授予该登录的权限可能包含写入；LISA 此流程只开放读取。', 'github-detail'));
    if (request.connected) githubButton(card, '重试原任务', () => githubAction(request.id, 'retry'));
    githubButton(card, request.connected ? '重新连接账号' : '使用本机 GitHub 登录', () => githubAction(request.id, 'authorize', { mode: 'existing' }));
    githubButton(card, '登录 GitHub', () => githubAction(request.id, 'authorize', { mode: 'login' }));
  }
  if (request.status === 'authorizing') {
    card.appendChild(githubNode('p', '请在 GitHub 页面完成授权；取消后不会继续任务。', 'github-detail'));
    if (request.userCode) {
      card.appendChild(githubNode('code', request.userCode, 'github-user-code'));
      const link = githubNode('a', '打开 GitHub，输入上方代码', 'github-login-link');
      link.href = 'https://github.com/login/device'; link.target = '_blank'; link.rel = 'noopener noreferrer';
      card.appendChild(link);
    }
  }
  if (request.status === 'selecting') {
    let selected = githubSelections.get(request.id);
    if (!selected) { selected = new Set(); githubSelections.set(request.id, selected); }
    card.appendChild(githubNode('p', '确认账号后，选择允许 LISA 读取的仓库。默认不选择任何仓库；后续只读任务沿用此范围，直到断开连接。', 'github-detail'));
    githubButton(card, '更换账号登录', () => githubAction(request.id, 'authorize', { mode: 'login' }), 'github-button github-secondary');
    const list = githubNode('div', '', 'github-repo-list');
    const count = githubNode('p', '已选 ' + selected.size + ' 个仓库', 'github-detail');
    const seen = new Set();
    function addRepo(name, isPrivate) {
      if (seen.has(name)) return;
      seen.add(name);
      const row = githubNode('label', '', 'github-repo-option');
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
      checkbox.checked = selected.has(name);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(name); else selected.delete(name);
        count.textContent = '已选 ' + selected.size + ' 个仓库'; confirm.disabled = selected.size === 0 || selected.size > 30;
      });
      row.append(checkbox, githubNode('span', name + (isPrivate ? ' · 私有' : ''))); list.appendChild(row);
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
    const more = githubButton(card, '加载仓库', load);
    const custom = document.createElement('input'); custom.placeholder = '也可输入 owner/repo'; custom.setAttribute('aria-label', '仓库名称');
    custom.className = 'github-repo-input'; card.appendChild(custom);
    githubButton(card, '添加仓库', async () => {
      const name = custom.value.trim();
      if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(name)) throw new Error('github_repository_unavailable');
      selected.add(name); addRepo(name, false); custom.value = '';
      count.textContent = '已选 ' + selected.size + ' 个仓库'; confirm.disabled = selected.size > 30;
    });
    card.appendChild(count);
    const confirm = githubButton(card, '只读连接并继续', () => githubAction(request.id, 'confirm', { repositories: Array.from(selected) }));
    confirm.disabled = selected.size === 0;
    void load().catch(error => card.appendChild(githubNode('p', githubErrorText(error.message), 'github-error')));
  }
  if (!['completed', 'cancelled', 'expired'].includes(request.status))
    githubButton(card, '取消此任务', () => githubAction(request.id, 'cancel'), 'github-button github-secondary');
  if (request.connected) githubButton(card, '断开 LISA 连接', () => githubAction(request.id, 'disconnect'), 'github-button github-secondary');
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
