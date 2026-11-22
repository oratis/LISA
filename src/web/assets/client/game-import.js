// A local preview. The browser sends only checked rows and checked field names to its loopback host.
const GAME_FILE_MAX_BYTES = 4 * 1024 * 1024;
const gameImportHeaders = new Map(Object.entries({
  name: 'title', title: 'title', gamename: 'title', 名称: 'title', 游戏名称: 'title', 标题: 'title',
  source: 'source', sources: 'source', 来源: 'source', 商店: 'source',
  platform: 'platform', platforms: 'platform', 平台: 'platform',
  version: 'version', edition: 'version', 版本: 'version',
  gameid: 'sourceId', sourceid: 'sourceId', 游戏id: 'sourceId',
  timeplayed: 'playtimeSeconds', playtime: 'playtimeSeconds', playtimeseconds: 'playtimeSeconds',
  游玩时间: 'playtimeSeconds', 游玩秒数: 'playtimeSeconds',
  exportedat: 'exportedAt', 导出时间: 'exportedAt',
}));
const gameImportCopy = {
  en: {
    template: 'Download CSV template', headers: 'Title,Source,Platform,Version,PlaytimeSeconds,Game Id,ExportedAt',
    manual: 'For Epic, PlayStation, Xbox, Nintendo, GOG or another library, copy the records you choose into this template. Only Title is required. PDF and Excel account exports need platform-specific sample validation.',
    file: 'Choose a game library CSV', select: 'Save selected games on this device', search: 'Find a game in this file',
    previous: 'Previous', next: 'Next', fields: 'Fields to save', title: 'Title', source: 'Source', platform: 'Platform',
    version: 'Version', sourceId: 'Source game ID', playtimeSeconds: 'Playtime (seconds)', exportedAt: 'Export time',
    summary: '{total} games · {selected} selected · page {page}/{pages}',
    privacy: 'Save up to 30 games locally. The next step lets you confirm which games your configured model can read and include in chat history. Disconnect to remove the local snapshot.',
    format: 'Choose a UTF-8 or UTF-16 CSV or TSV with a Name or Title column. Playnite’s Time Played column uses seconds. Other columns such as notes and account details stay in the file.',
    invalid: 'Could not read this table. Check the title header, columns and quoted cells. Optional Playtime values must be whole seconds and ExportedAt values must include a date, time and time zone.',
    size: 'Choose a file up to 4 MiB, with at most 10,000 games and 64 columns.',
    none: 'No games found.', missing: 'Export time is unknown unless the file supplies an ExportedAt column. The local import time is recorded separately.',
  },
  'zh-CN': {
    template: '下载 CSV 模板', headers: '标题,来源,平台,版本,游玩秒数,游戏 ID,导出时间',
    manual: '使用 Epic、PlayStation、Xbox、Nintendo、GOG 等平台时，可将自选记录填入模板。仅标题必填。原始 PDF 和 Excel 账号导出需先用对应平台的样本验证格式。',
    file: '选择游戏库 CSV', select: '将所选游戏保存在本机', search: '在此文件中查找游戏',
    previous: '上一页', next: '下一页', fields: '要保存的字段', title: '游戏名称', source: '来源', platform: '平台',
    version: '版本', sourceId: '来源游戏 ID', playtimeSeconds: '游玩时长（秒）', exportedAt: '导出时间',
    summary: '共 {total} 款 · 已选 {selected} 款 · 第 {page}/{pages} 页',
    privacy: '最多选 30 款保存在本机。下一步可确认哪些游戏能交给已配置的模型并进入对话记录。断开连接可清除此本机快照。',
    format: '选择 UTF-8 或 UTF-16 的 CSV 或 TSV，至少含“名称”或“标题”列。Playnite 的“游玩时间”以秒计。备注、账号资料等其他列仅留在文件中。',
    invalid: '无法读取此表格。请检查标题列、列数和引号。可选的游玩时间须为整数秒，导出时间须包括日期、时间和时区。',
    size: '文件大小上限为 4 MiB，最多可包含 10,000 款游戏和 64 列。',
    none: '未找到游戏。', missing: '仅当文件提供“导出时间”列时才记录该时间。本机导入时间会另行记录。',
  },
};

// Exporter Advanced uses localized headers, CSV quoting, and raw Playnite Game.Playtime seconds.
// Parse once with hard bounds before constructing the preview; never interpret formula cells.
function parseGameImportFile(data) {
  const fail = (reason = 'invalid') => { throw new Error(reason); };
  const bytes = new Uint8Array(data);
  if (bytes.byteLength > GAME_FILE_MAX_BYTES) fail('size');
  let text;
  const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le'
    : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
  try { text = new TextDecoder(encoding, {fatal: true}).decode(bytes); }
  catch { fail(); }
  if (!text || text.includes('\0')) fail();
  const directive = /^sep=([,;\t])\r?\n/i.exec(text);
  if (directive) text = text.slice(directive[0].length);
  const headerLine = text.split(/[\r\n]/, 1)[0];
  // Pick a delimiter seen between header fields rather than inside a quoted column name.
  const header = headerLine.replace(/"(?:[^"]|"")*"/g, '');
  const delimiter = directive ? directive[1] : [',', ';', '\t'].sort((a, b) => header.split(b).length - header.split(a).length)[0];
  const games = [];
  let fields, row = [], cell = '', quoted = false, afterQuote = false;
  function addCell() {
    if (row.length >= 64) fail('size');
    row.push(cell); cell = ''; afterQuote = false;
  }
  function finishRow() {
    addCell();
    const cells = row; row = [];
    if (cells.every(value => !value.trim())) return;
    if (!fields) {
      fields = cells.map(v => gameImportHeaders.get(v.trim().toLowerCase().replace(/[\s_-]+/g, '')));
      const known = fields.filter(Boolean);
      if (!known.includes('title') || new Set(known).size !== known.length) fail();
      return;
    }
    if (cells.length !== fields.length) fail();
    if (games.length >= 10000) fail('size');
    const game = {};
    fields.forEach((key, i) => {
      const value = cells[i].trim();
      if (!key || !value) return;
      if (key === 'playtimeSeconds') {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail();
        game[key] = Number(value);
      } else if (key === 'sourceId') {
        // Some local plugins use an absolute installation/ROM path as GameId.
        // Only portable opaque IDs are shown or copied.
        if (/^[a-zA-Z0-9._-]{1,128}$/.test(value)) game[key] = value;
      } else if (key === 'exportedAt') {
        if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/i.test(value) || !Number.isFinite(Date.parse(value))) fail();
        const day = value.slice(0, 10);
        if (new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) !== day) fail();
        game[key] = new Date(value).toISOString();
      } else {
        const max = {title: 200, source: 80, platform: 80, version: 64}[key];
        if (value.length > max || /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value)) fail();
        game[key] = value;
      }
    });
    if (!game.title) fail();
    games.push(game);
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else { quoted = false; afterQuote = true; }
    } else if (ch === delimiter) addCell();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      finishRow();
    } else if (ch === '"' && !cell && !afterQuote) quoted = true;
    else {
      if (afterQuote || ch === '"') fail();
      cell += ch;
    }
  }
  if (quoted) fail();
  if (row.length || cell || afterQuote) finishRow();
  if (!fields || !games.length) fail('none');
  return games;
}

function renderGameImport(parent, save) {
  const copy = gameImportCopy[LISA_LOCALE];
  const picker = document.createElement('fieldset');
  picker.className = 'connector-picker';
  const fileLabel = document.createElement('label');
  fileLabel.textContent = copy.file;
  const file = document.createElement('input');
  file.type = 'file'; file.accept = '.csv,.tsv'; file.className = 'github-repo-input';
  fileLabel.appendChild(file);
  const preview = document.createElement('div');
  const error = document.createElement('p');
  error.className = 'github-error'; error.setAttribute('role', 'status');
  const format = githubNode('p', copy.format, 'github-detail');
  const template = document.createElement('a');
  template.textContent = copy.template; template.className = 'github-login-link';
  template.download = 'lisa-game-library-template.csv';
  template.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent('\uFEFF' + copy.headers + '\r\n');
  template.addEventListener('click', event => {
    const bridge = window.webkit?.messageHandlers?.lisaGameTemplate;
    if (bridge) {
      bridge.postMessage(LISA_LOCALE);
      event.preventDefault();
    }
  });
  picker.append(fileLabel, format, template, githubNode('p', copy.manual, 'github-detail'), error, preview);
  parent.appendChild(picker);
  let revision = 0;
  file.addEventListener('change', async () => {
    const attempt = ++revision;
    error.textContent = ''; preview.replaceChildren();
    const chosen = file.files[0];
    if (!chosen) return;
    try {
      if (chosen.size > GAME_FILE_MAX_BYTES) throw new Error('size');
      if (!/\.(csv|tsv)$/i.test(chosen.name)) throw new Error('invalid');
      const games = parseGameImportFile(await chosen.arrayBuffer());
      if (attempt === revision && picker.isConnected) show(games);
    } catch (e) {
      if (attempt === revision) error.textContent = copy[e.message] || copy.invalid;
    }
  });
  function show(games) {
    const selected = new Set();
    const columns = [...new Set(games.flatMap(game => Object.keys(game)))];
    const enabled = new Set(columns);
    const options = document.createElement('fieldset');
    options.className = 'connector-picker'; options.appendChild(githubNode('legend', copy.fields));
    columns.filter(k => k !== 'title').forEach(key => {
      const label = document.createElement('label');
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = true;
      input.addEventListener('change', () => { if (input.checked) enabled.add(key); else enabled.delete(key); draw(); });
      label.append(input, copy[key]); options.append(label, ' ');
    });
    const search = document.createElement('input'); search.type = 'search'; search.className = 'github-repo-input';
    search.placeholder = copy.search; search.setAttribute('aria-label', copy.search);
    const count = githubNode('p', '', 'connector-count'); count.setAttribute('role', 'status');
    const list = githubNode('div', '', 'github-repo-list');
    const nav = githubNode('div', '', 'connector-toolbar');
    function navigation(label, move) {
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'github-button'; btn.textContent = label;
      btn.addEventListener('click', () => { page += move; draw(); });
      nav.appendChild(btn); return btn;
    }
    let page = 0;
    const previous = navigation(copy.previous, -1), next = navigation(copy.next, 1);
    const submit = document.createElement('button'); submit.type = 'button'; submit.className = 'github-button'; submit.textContent = copy.select;
    const extract = game => Object.fromEntries(Object.entries(game).filter(([key]) => enabled.has(key)));
    submit.addEventListener('click', async () => {
      picker.disabled = true;
      try { await save(Array.from(selected, i => extract(games[i]))); }
      catch (e) { error.textContent = githubErrorText(e.message); }
      finally { picker.disabled = false; }
    });
    search.addEventListener('input', () => { page = 0; draw(); });
    if (columns.length > 1) preview.appendChild(options);
    preview.append(search, count, list, nav, githubNode('p', copy.missing, 'github-detail'), githubNode('p', copy.privacy, 'github-detail'), submit);
    function draw() {
      const term = search.value.trim().toLowerCase();
      const matches = games.map((game, i) => ({game, i})).filter(({game}) => game.title.toLowerCase().includes(term));
      const pages = Math.max(1, Math.ceil(matches.length / 30));
      page = Math.max(0, Math.min(pages - 1, page));
      previous.disabled = page === 0; next.disabled = page + 1 >= pages;
      nav.hidden = pages === 1;
      list.replaceChildren();
      const inputs = [];
      const sync = () => {
        for (const input of inputs) input.disabled = selected.size >= 30 && !input.checked;
        count.textContent = copy.summary.replace('{total}', String(games.length)).replace('{selected}', String(selected.size)).replace('{page}', String(page + 1)).replace('{pages}', String(pages));
        submit.disabled = !selected.size;
      };
      for (const {game, i} of matches.slice(page * 30, (page + 1) * 30)) {
        const label = document.createElement('label'); label.className = 'github-repo-option';
        const box = document.createElement('input'); box.type = 'checkbox'; box.checked = selected.has(i); inputs.push(box);
        box.addEventListener('change', () => { if (box.checked) selected.add(i); else selected.delete(i); sync(); });
        const properties = Object.entries(extract(game)).filter(([key]) => key !== 'title').map(([key, value]) => copy[key] + ' · ' + value);
        label.append(box, githubNode('span', ['#' + (i + 1), game.title, ...properties].join(' · ')));
        list.appendChild(label);
      }
      if (!matches.length) list.appendChild(githubNode('p', copy.none, 'github-detail'));
      sync();
    }
    draw();
  }
}
