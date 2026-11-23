// Shared connection card. Provider data is always text; login URLs are verified again here.
const githubCards = new Map();
const githubSelections = new Map();
let githubRefreshing = false;
let githubHistoryDirty = false;
let githubLastSession = '';
const workspaceCards = new Map();
let gamingModelName = "";
const gameNames = {itch: "itch.io", steam: "Steam", "game-library": "Game Library · Playnite"};
function workspaceLoginUrl(url, vendor) {
  if (new Set(url.searchParams.keys()).size !== url.searchParams.size || url.username || url.password || url.hash || url.searchParams.get('redirect_uri') !== 'http://localhost:4870/oauth/' + vendor) return false;
  if (vendor === 'microsoft') return url.origin === 'https://login.microsoftonline.com' && /^\/(?:[a-f\d-]{36}|consumers)\/oauth2\/v2\.0\/authorize$/i.test(url.pathname);
  const paths = { box: 'https://account.box.com/api/oauth2/authorize', atlassian: 'https://auth.atlassian.com/authorize', dropbox: 'https://www.dropbox.com/oauth2/authorize', todoist: 'https://app.todoist.com/oauth/authorize', figma: 'https://www.figma.com/oauth' };
  return paths[vendor] === url.origin + url.pathname;
}

const githubStatus = {
  waiting: tr('github.status.waiting'), authorizing: tr('github.status.authorizing'), selecting: tr('github.status.selecting'),
  ready: tr('github.status.ready'), resuming: tr('github.status.resuming'), completed: tr('github.status.completed'),
  cancelled: tr('github.status.cancelled'), failed: tr('github.status.failed'), expired: tr('github.status.expired')
};
const githubErrors = {
  connector_recipient_changed: tr('game.recipientChanged'),
  game_library_unavailable: tr('game.unavailable'), game_library_incomplete: tr('game.incomplete'),
  game_provider_unconfigured: tr('game.unconfigured'), game_import_required: tr('game.importInvalid'),
  game_import_invalid: tr('game.importInvalid'), game_import_scope: tr('game.scope'),
  t3_endpoint_not_configured: tr('connector.error.t3_endpoint_not_configured'),
  t3_reauthorization_required: tr('connector.error.t3_reauthorization_required'),
  t3_read_scope_required: tr('connector.error.t3_read_scope_required'),
  t3_invalid_response: tr('connector.error.t3_invalid_response'),
  t3_project_unavailable: tr('connector.error.t3_project_unavailable'),
  t3_resource_mismatch: tr('connector.error.t3_resource_mismatch'),
  feishu_client_not_configured: tr('connector.error.feishu_client_not_configured'),
  feishu_reauthorization_required: tr('connector.error.feishu_reauthorization_required'),
  feishu_read_scope_required: tr('connector.error.feishu_read_scope_required'),
  feishu_document_unavailable: tr('connector.error.feishu_document_unavailable'),
  feishu_resource_mismatch: tr('connector.error.feishu_resource_mismatch'),
  feishu_access_denied: tr('connector.error.feishu_access_denied'),
  feishu_rate_limited: tr('connector.error.feishu_rate_limited'),
  feishu_callback_port_in_use: tr('connector.error.feishu_callback_port_in_use'),
  feishu_request_failed: tr('connector.error.feishu_request_failed'),
  feishu_response_too_large: tr('connector.error.feishu_response_too_large'),
  feishu_invalid_response: tr('connector.error.feishu_invalid_response'),
  feishu_unavailable: tr('connector.error.feishu_unavailable'),
  feishu_document_changed: tr('connector.error.feishu_document_changed'),
  feishu_invalid_link: tr('connector.error.feishu_invalid_link'),
  obsidian_no_vaults: tr('obsidian.noVaults'),
  obsidian_invalid_config: tr('obsidian.config'),
  obsidian_inaccessible: tr('obsidian.access'),
  obsidian_reauthorize: tr('obsidian.renew'),
  obsidian_note_unavailable: tr('obsidian.note'),
  obsidian_invalid_path: tr('obsidian.path'),
  workspace_reauthorize: tr('workspace.renew'),
  workspace_scope_mismatch: tr('workspace.mismatch'),
  workspace_invalid_period: tr('workspace.period'),
  workspace_content_unavailable: tr('workspace.type'),
  workspace_resource_changed: tr('workspace.changed'),
  workspace_rate_limited: tr('workspace.rate'),
  oauth_callback_port_in_use: tr('workspace.busy'),
  workspace_client_not_configured: tr('workspace.config'),
  workspace_inaccessible: tr('workspace.access'),
  workspace_eventkit_platform: tr('workspace.platform'),
  workspace_eventkit_build: tr('workspace.build'),
  workspace_eventkit_unavailable: tr('workspace.unavailable'),
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
  gmail_legacy_client: tr('connector.error.gmail_legacy_client'),
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
// The symbol sheet is bundled with the owner page. Only local symbol IDs can be referenced.
function connectorGlyph(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  const symbol = document.getElementById(id);
  use.setAttribute('href', symbol?.localName === 'symbol' ? '#' + id : '#product-unknown');
  svg.appendChild(use);
  return svg;
}
function connectorMark(provider) {
  const mark = githubNode('span', '', 'connector-mark');
  mark.appendChild(connectorGlyph('product-' + provider));
  return mark;
}

// Per-provider card copy, login modes and authorization-link checks. Workspace providers
// come from the server catalog and share one shape (workspaceCard), so a new source is
// one catalog entry rather than another branch in every ternary below.
const googleLoginUrl = url => url.origin === 'https://accounts.google.com' && url.pathname === '/o/oauth2/v2/auth';
const connectorCards = {
  feishu: {
    name: tr('connector.feishuName'), detail: tr('connector.feishuDetail'), authorizeDetail: tr('connector.feishuAuthorize'),
    modes: { login: tr('connector.auth.feishu') }, account: a => a.workspaceName + ' · ' + a.name,
    open: tr('connector.openFeishu'),
    loginUrl: url => url.origin === 'https://accounts.feishu.cn' && url.pathname === '/open-apis/authen/v1/authorize' && url.searchParams.get('response_type') === 'code' && url.searchParams.get('scope') === 'docx:document:readonly offline_access' && url.searchParams.get('code_challenge_method') === 'S256' && url.searchParams.getAll('prompt').every(p => p === 'consent'),
    custom: {
      placeholder: tr('connector.feishuPlaceholder'), label: tr('connector.feishuDocument'), add: tr('connector.feishuAdd'),
      invalid: tr('connector.error.feishu_invalid_link'),
      parse: value => {
        if (/^[A-Za-z0-9]{15,100}$/.test(value)) return value;
        try {
          const url = new URL(value), match = /^\/docx\/([A-Za-z0-9]{15,100})\/?$/.exec(url.pathname);
          return url.protocol === 'https:' && !url.username && !url.password && !url.port && (url.hostname === 'feishu.cn' || url.hostname.endsWith('.feishu.cn')) && match ? match[1] : '';
        } catch { return ''; }
      },
    },
  },
  github: {
    name: 'GitHub', detail: tr('github.detail'), authorizeDetail: tr('github.authorizeDetail'),
    modes: { existing: tr('github.existing'), login: tr('github.login') },
    account: a => '@' + a.login,
    custom: {
      placeholder: tr('github.repoPlaceholder'), label: tr('github.repoLabel'), add: tr('github.add'),
      invalid: githubErrorText('github_repository_unavailable'),
      parse: value => /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(value) ? value : '',
    },
  },
  'google-calendar': {
    name: 'Google Calendar', detail: tr('connector.calendarDetail'), authorizeDetail: tr('connector.authorizeDetail'),
    modes: { freebusy: tr('connector.auth.freebusy'), events: tr('connector.auth.events') },
    account: a => a.email, open: tr('connector.openGoogle'), loginUrl: googleLoginUrl,
  },
  gmail: {
    name: 'Gmail', detail: tr('connector.gmailDetail'), authorizeDetail: tr('connector.gmailAuthorize'),
    modes: { login: tr('connector.auth.gmail') },
    account: a => a.email, open: tr('connector.openGoogle'), loginUrl: googleLoginUrl,
  },
  'google-drive': {
    name: 'Google Drive', detail: tr('connector.driveDetail'), authorizeDetail: tr('connector.driveAuthorize'),
    modes: { login: tr('connector.auth.drive') },
    account: a => a.email, open: tr('connector.openGoogle'), loginUrl: googleLoginUrl,
  },
  t3: {
    name: 'T3 Code', detail: tr('connector.t3Detail'), authorizeDetail: tr('connector.t3Authorize'),
    modes: { login: tr('connector.auth.t3') }, account: a => a.name + ' · ' + new URL(a.endpoint).host, open: tr('connector.openT3'),
    loginUrl: u => ((u.protocol === 'https:' && !u.port) || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) && !u.hash && u.pathname === '/oauth/mcp/authorize' && u.searchParams.get('scope') === 'orchestration:read' && u.searchParams.get('resource') === u.origin + '/mcp' && u.searchParams.get('code_challenge_method') === 'S256',
  },
  linear: {
    name: 'Linear', detail: tr('connector.linearDetail'), authorizeDetail: tr('connector.linearAuthorize'),
    modes: { login: tr('connector.auth.linear') },
    account: a => [a.name, a.email].filter(Boolean).join(' · '), open: tr('connector.openLinear'),
    loginUrl: url => url.origin === 'https://mcp.linear.app' && url.pathname === '/authorize' && url.searchParams.get('scope') === 'read' && url.searchParams.get('resource') === 'https://mcp.linear.app/mcp/readonly',
  },
  notion: {
    name: 'Notion', detail: tr('connector.notionDetail'), authorizeDetail: tr('connector.notionAuthorize'),
    modes: { login: tr('connector.auth.notion') },
    account: a => a.workspaceName + ' · ' + a.name, open: tr('connector.openNotion'),
    loginUrl: url => url.origin === 'https://api.notion.com' && url.pathname === '/v1/oauth/authorize' && url.searchParams.get('owner') === 'user' && url.searchParams.get('response_type') === 'code',
  },
  slack: {
    name: 'Slack', detail: tr('connector.slackDetail'), authorizeDetail: tr('connector.slackAuthorize'),
    modes: { login: tr('connector.auth.slack') },
    account: a => a.workspaceName + ' · ' + a.name, open: tr('connector.openSlack'),
    loginUrl: url => url.origin === 'https://slack.com' && url.pathname === '/oauth/v2/authorize' && !url.searchParams.get('scope') && url.searchParams.get('user_scope') === 'channels:read,channels:history,groups:read,groups:history' && url.searchParams.get('code_challenge_method') === 'S256',
  },
};
// A typed resource ID; a Figma link becomes fileKey or fileKey|nodeId.
function workspaceResourceId(provider, value) {
  let id = value;
  if (provider === 'figma' && /^https:\/\//i.test(id)) {
    try {
      const link = new URL(id);
      const match = /^\/(?:design|file|proto)\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(link.pathname);
      const node = link.searchParams.get('node-id');
      if (!match || !['www.figma.com', 'figma.com'].includes(link.hostname) || link.port || link.username || link.password || (node && !/^\d+[:-]\d+$/.test(node))) return '';
      id = match[1] + (node ? '|' + node.replace('-', ':') : '');
    } catch { return ''; }
  }
  return id.length <= 700 && !/[\u0000-\u001f\u007f]/.test(id) ? id : '';
}
function workspaceCard(app) {
  const name = app.name;
  const local = app.workspace.vendor === 'local';
  const native = app.workspace.vendor === 'apple' || local;
  return {
    name,
    detail: local ? tr('obsidian.scope') : native ? tr('workspace.nativeScope', { name }) : tr('workspace.scope', { name, scope: app.workspace.scope }),
    authorizeDetail: local ? tr('obsidian.authorize') : tr(native ? 'workspace.system' : 'workspace.return', { name }),
    modes: { login: local ? tr('obsidian.allow') : tr(native ? 'workspace.allow' : 'workspace.login', { name }) },
    account: a => a.name,
    open: tr('workspace.open', { name }),
    loginUrl: native ? undefined : url => workspaceLoginUrl(url, app.workspace.vendor),
    // Apple calendars and lists are only offered by the local EventKit reader.
    custom: native ? undefined : {
      placeholder: app.workspace.hint, label: tr('workspace.id', { name }), add: tr('workspace.add'),
      invalid: tr('workspace.invalidId'), parse: value => workspaceResourceId(app.id, value),
    },
  };
}
function connectorCard(provider) {
  if (Object.hasOwn(gameNames, provider)) {
    const name = gameNames[provider];
    return {
      name, detail: tr('game.' + provider + '.detail'), account: a => a.name,
      authorizeDetail: tr('game.authorize', {name}), open: tr('game.open', {name}),
      modes: {login: tr('workspace.login', {name})}, custom: undefined,
      loginUrl: url => !url.hash && (provider === 'itch'
        ? url.origin === 'https://itch.io' && url.pathname === '/user/oauth' && url.searchParams.get('code_challenge_method') === 'S256'
        : provider === 'steam' && url.origin === 'https://steamcommunity.com' && url.pathname === '/openid/login'),
    };
  }
  const app = workspaceCards.get(provider);
  return app ? workspaceCard(app) : connectorCards[provider] || connectorCards.github;
}
function renderResourcePicker(card, footer, request, provider, custom) {
  const recipient = Object.hasOwn(gameNames, provider) ? gamingModelName : undefined;
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
      await githubAction(request.id, 'confirm', isGitHub ? { repositories: ids } : { resources: ids, recipient }, provider);
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
      const limited = Object.hasOwn(gameNames, provider) && items.length === limit && !draft.hasMore;
      draft.page++;
      more.textContent = tr('connector.load');
      notice.textContent = limited ? tr('game.pickerLimit') : choices.size ? '' : tr('connector.empty');
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

  if (custom) {
    const form = githubNode('form', '', 'connector-custom');
    const customInput = document.createElement('input');
    customInput.className = 'github-repo-input';
    customInput.placeholder = custom.placeholder;
    customInput.setAttribute('aria-label', custom.label);
    customInput.required = true;
    customAdd = githubNode('button', custom.add, 'github-button');
    customAdd.type = 'submit';
    form.append(customInput, customAdd);
    picker.appendChild(form);
    customInput.addEventListener('input', () => customInput.setCustomValidity(''));
    form.addEventListener('submit', event => {
      event.preventDefault();
      const id = custom.parse(customInput.value.trim());
      if (!id) {
        customInput.setCustomValidity(custom.invalid);
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
  const info = connectorCard(provider);
  const name = info.name;
  const resources = isGitHub ? request.repositories : request.resources;
  const action = (operation, body) => githubAction(request.id, operation, body, provider);
  const key = provider + ":" + request.id;
  const card = githubNode('section', '', 'github-connection-card');
  card.dataset.connectorKey = key;
  if (isGitHub) card.dataset.githubRequest = request.id;
  card.setAttribute('aria-label', isGitHub ? tr('github.label') : tr('connector.label', { name }));
  const header = githubNode('div', '', 'github-card-header');
  const mark = connectorMark(provider);
  const identity = githubNode('div', '', 'connector-identity');
  identity.appendChild(githubNode('strong', name));
  const accountName = request.account ? info.account(request.account) : '';
  if (!selecting && accountName) identity.appendChild(githubNode('span', accountName, 'github-account'));
  const badge = githubNode('span', tr('github.readonly'), 'github-readonly');
  badge.prepend(connectorGlyph('connector-ui-lock'));
  header.append(mark, identity, badge);
  card.appendChild(header);
  const status = githubNode('p', selecting ? tr(Object.hasOwn(gameNames, provider) ? 'game.choose' : 'connector.choose.' + provider) : githubStatus[request.status] || request.status, 'github-status');
  status.setAttribute('role', 'status');
  card.appendChild(status);
  const footer = githubNode('div', '', 'connector-footer');
  if (!selecting) githubSelections.delete(key);
  if (resources.length) card.appendChild(githubNode('p', resources.map(r => isGitHub ? r.fullName : r.name).join(' · '), 'github-repositories'));
  if (request.error) card.appendChild(githubNode('p', githubErrorText(request.error), 'github-error'));
  if (['waiting', 'failed'].includes(request.status)) {
    card.appendChild(githubNode('p', info.detail, 'github-detail'));
    if (isGitHub) card.appendChild(githubNode('p', tr('github.preview'), 'github-detail'));
    if (request.connected) githubButton(card, tr('github.retry'), () => action('retry'));
    addLoginActions(card);
  }
  function addLoginActions(target) {
    if (provider === 'game-library') {
      renderGameImport(target, games => action('authorize', {mode: 'import', games}));
      return;
    }
    for (const [mode, label] of Object.entries(info.modes)) {
      if (selecting && mode === 'existing') continue;
      githubButton(target, label, async () => { githubSelections.delete(key); await action('authorize', { mode }); });
    }
  }
  if (request.status === 'authorizing') {
    card.appendChild(githubNode('p', info.authorizeDetail, 'github-detail'));
    if (info.loginUrl && request.authorizationUrl) {
      try {
        const url = new URL(request.authorizationUrl);
        if (info.loginUrl(url) && !url.username && !url.password) {
          const link = githubNode('a', info.open, 'github-login-link');
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
    card.appendChild(githubNode('p', Object.hasOwn(gameNames, provider) ? tr('game.confirmScope', {model: gamingModelName || tr('game.model')}) : tr('connector.scope.' + provider), 'github-detail'));
  }
  if (!['completed', 'cancelled', 'expired'].includes(request.status))
    githubButton(footer, tr('github.cancel'), () => action('cancel'), 'github-button github-secondary');
  if (request.connected) githubButton(footer, tr('github.disconnect'), () => action('disconnect'), 'github-button github-secondary');
  if (selecting) renderResourcePicker(card, footer, request, provider, info.custom);
  if (footer.childElementCount) card.appendChild(footer);
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
    gamingModelName = data.gameModel || '';
    for (const app of data.connectors) if (app.workspace) workspaceCards.set(app.id,app);
    const entries = github.ok ? (await github.json()).requests.map(request => ({request,provider:'github'})) : [];
    entries.push(...(data.requests || []));
    if (sid !== window.lisaActiveSessionId) return;
    if (githubLastSession !== sid) { githubCards.clear(); githubSelections.clear(); githubLastSession = sid; }
    for (const { request, provider } of entries) {
      const key = provider + ':' + request.id;
      const prior = githubCards.get(key);
      if (prior?.status !== 'completed' && request.status === 'completed') githubHistoryDirty = true;
      const fingerprint = JSON.stringify(request) + (Object.hasOwn(gameNames, provider) ? gamingModelName : "");
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

// Browsing the catalog does not start authorization or change the active task.
const browseConnectors = document.getElementById('pmConnectors');
if (browseConnectors) {
  browseConnectors.textContent = tr('connector.browse');
  browseConnectors.addEventListener('click', () => {
    closePlusMenu();
    void showConnectorCatalog();
  });
}

function showConnectorCatalog() {
  return loadPanel(tr('connector.browse'), '/api/connectors', data => {
    modalBody.replaceChildren(githubNode('p', tr('connector.readExamples')));
    // A source this install cannot serve (no OAuth client, no EventKit reader)
    // is not offered: its example would never reach a connection card.
    for (const app of data.connectors.filter(a => a.available !== false)) {
      const example = app.example[LISA_LOCALE];
      const row = githubNode('div', '', 'connector-example');
      const copy = githubNode('div', '', 'connector-example-copy');
      copy.append(githubNode('strong', app.name), githubNode('p', example, 'desc'));
      row.append(connectorMark(app.id), copy);
      const pick = githubNode('button', tr('connector.pick'), 'github-button');
      pick.type = 'button';
      pick.setAttribute('aria-label', app.name + ' · ' + tr('connector.pick'));
      pick.addEventListener('click', () => {
        closeModal();
        window.lisaPrefillComposer(input.value.trim() ? input.value + '\n' + example : example);
      });
      copy.appendChild(pick);
      modalBody.appendChild(row);
    }
  }, showConnectorCatalog);
}

// A complete inventory lives in Dashboard, including sources awaiting host configuration.
// Fetching it observes saved grants only; it never signs in or reads remote documents.
let dashboardConnectorQuery = '';
let dashboardConnectorFilter = 'all';
async function loadDashboardConnectors() {
  const root = document.getElementById('dashboardConnectors');
  if (!root) return;
  root.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/connectors');
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    if (!root.isConnected) return;
    const apps = data.connectors;
    root.replaceChildren();
    const heading = githubNode('div', '', 'dc-heading');
    const title = githubNode('div');
    title.append(githubNode('h3', tr('dashboard.connectors.title')),
      githubNode('p', tr('dashboard.connectors.all.connectors.saved.authorization.status.read.only.access'), 'dc-caption'));
    const refreshLabel = tr('dashboard.connectors.refresh.status');
    const refresh = githubNode('button', '', 'github-button dc-refresh');
    refresh.title = refreshLabel;
    refresh.setAttribute('aria-label', refreshLabel);
    refresh.appendChild(connectorGlyph('connector-ui-refresh'));
    refresh.append(githubNode('span', refreshLabel));
    refresh.type = 'button'; refresh.addEventListener('click', loadDashboardConnectors);
    heading.append(title, refresh); root.append(heading);
    const authorized = apps.filter(a => a.connection?.status === 'authorized').length;
    const totals = githubNode('div', '', 'dc-totals');
    for (const [number, label] of [[apps.length, tr('dashboard.connectors.available.integrations')], [authorized, tr('dashboard.connectors.authorized')], [apps.filter(a => a.connection?.status === 'unavailable').length, tr('dashboard.connectors.need.setup')]]) {
      const tile = githubNode('div'); tile.append(githubNode('strong', String(number)), githubNode('span', label)); totals.append(tile);
    }
    root.append(totals);
    const toolbar = githubNode('div', '', 'dc-toolbar');
    const search = document.createElement('input'); search.type = 'search'; search.value = dashboardConnectorQuery;
    search.placeholder = tr('dashboard.connectors.search'); search.setAttribute('aria-label', tr('dashboard.connectors.find.an.app.or.capability'));
    const filter = document.createElement('select'); filter.setAttribute('aria-label', tr('dashboard.connectors.filter.connectors'));
    for (const [value, label] of [['all', tr('dashboard.connectors.all.connectors')], ['authorized', tr('dashboard.connectors.authorized')], ['ready', tr('dashboard.connectors.ready.to.connect')], ['unavailable', tr('dashboard.connectors.need.setup')], ['attention', tr('dashboard.connectors.needs.attention')]]) {
      const option = document.createElement('option'); option.value = value; option.textContent = label; filter.append(option);
    }
    filter.value = dashboardConnectorFilter;
    toolbar.append(search, filter); root.append(toolbar);
    const gameLookup = githubNode('button', tr('game.lookup'), 'connector-text-button dc-game-lookup');
    gameLookup.type = 'button';
    gameLookup.addEventListener('click', () => window.lisaOpenPublicGames());
    root.appendChild(gameLookup);
    const list = githubNode('div', '', 'dc-grid'); root.append(list);
    const labels = { authorized: tr('dashboard.connectors.authorized'), disconnected: tr('dashboard.connectors.not.connected'), pending: tr('dashboard.connectors.awaiting.confirmation'), unavailable: tr('dashboard.connectors.needs.setup'), error: tr('dashboard.connectors.status.unavailable') };
    function renderList() {
      list.replaceChildren();
      const query = dashboardConnectorQuery.trim().toLowerCase();
      const visible = apps.filter(app => {
        const state = app.connection?.status || 'error';
        const matches = !query || [app.name, app.id, app.example.en, app.example['zh-CN']].some(v => v.toLowerCase().includes(query)) || app.importSources?.some(source => source.toLowerCase().startsWith(query));
        const kind = dashboardConnectorFilter;
        return matches && (kind === 'all' || (kind === 'ready' ? app.available && state === 'disconnected' : kind === 'attention' ? ['pending', 'error'].includes(state) || !!app.connection?.lastError : state === kind));
      });
      for (const app of visible) {
        const state = app.connection?.status || 'error';
        const canConnect = app.available && state !== 'unavailable';
        const card = githubNode('article', '', 'dc-card'); card.dataset.provider = app.id; card.dataset.status = state;
        const top = githubNode('div', '', 'dc-card-head');
        const identity = githubNode('div', '', 'dc-identity');
        identity.append(githubNode('h4', app.name), githubNode('span', labels[state] || labels.error, 'dc-state ' + state));
        top.append(connectorMark(app.id), identity);
        card.append(top, githubNode('p', app.example[LISA_LOCALE], 'dc-description'));
        const scope = state === 'authorized'
          ? tr('dashboard.connectors.scope', { n: app.connection.resourceCount })
          : app.id === 'obsidian' ? tr('dashboard.connectors.local.markdown.choose.vaults.before.reading')
          : !canConnect ? tr('dashboard.connectors.sign.in.is.not.configured.on.this.installation')
          : tr('dashboard.connectors.choose.your.account.and.reading.scope.in.chat');
        card.append(githubNode('p', scope, 'dc-caption'));
        if (app.connection?.lastError) card.append(githubNode('p', githubErrorText(app.connection.lastError), 'dc-error'));
        const action = githubNode('button', canConnect ? tr(state === 'authorized' ? 'dashboard.connectors.use' : 'dashboard.connectors.connect') : tr('dashboard.connectors.setup.details'), 'github-button');
        action.type = 'button';
        action.addEventListener('click', () => {
          if (canConnect) {
            window.lisaShowView('chat');
            const example = app.example[LISA_LOCALE];
            window.lisaPrefillComposer(input.value.trim() ? input.value + '\n' + example : example);
          } else {
            openModal(app.name, '');
            modalBody.append(githubNode('p', tr('dashboard.connectors.this.connector.is.included.but.sign.in.is.not.configured.on.this.mac.an.administrator.must.configure.its.oauth.application.and.restart.lisa.before.you.can.connect')));
            if (app.workspace?.vendor === 'apple') modalBody.replaceChildren(githubNode('p', tr('dashboard.connectors.use.the.lisa.macos.app.with.its.calendar.and.reminders.reader.installed')));
            if (app.id === 'itch' || app.id === 'steam') modalBody.replaceChildren(githubNode('p', tr('game.' + app.id + '.setup')));
            if (app.id === 'box') {
              modalBody.append(githubNode('p', tr('dashboard.connectors.box.requires.an.oauth.2.0.app.with.the.read.only.scope.root.readonly.and.callback.http.localhost.4870.oauth.box.store.its.client.id.and.secret.in.the.protected.workspace.client.configuration.on.this.mac')));
            }
          }
        });
        card.append(action); list.append(card);
      }
      if (!visible.length) list.append(githubNode('p', tr('dashboard.connectors.no.matching.connectors'), 'dc-caption'));
    }
    search.addEventListener('input', () => { dashboardConnectorQuery = search.value; renderList(); });
    filter.addEventListener('change', () => { dashboardConnectorFilter = filter.value; renderList(); });
    renderList();
  } catch {
    if (!root.isConnected) return;
    root.replaceChildren(githubNode('p', tr('dashboard.connectors.could.not.load.connector.status'), 'dc-error'));
    const retry = githubNode('button', tr('dashboard.connectors.retry'), 'github-button'); retry.type = 'button'; retry.addEventListener('click', loadDashboardConnectors); root.append(retry);
  } finally { root.removeAttribute('aria-busy'); }
}
