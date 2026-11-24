/**
 * Tasks view (`#viewTasks`) — durable routines, watchers, goals, and one-off
 * tasks backed by `/api/client-capabilities` + `/api/tasks*` (A01, A02, A04, B04).
 *
 * All user/task strings are escaped or rendered via textContent. File artifacts
 * are previewed and downloaded strictly through the authorized artifact route,
 * never via raw host filesystem paths.
 */
(function initLisaTasks() {
  var root = null;
  var state = {
    capabilities: null,
    tasks: [],
    selectedId: null,
    runs: [],
    selectedRunId: null,
    selectedRun: null,
    filter: 'all',
    loading: false,
    error: null,
    creating: false,
    preview: null,
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fetchJSON(url, opts) {
    return fetch(url, opts).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    }).catch(function () {
      return { ok: false, status: 0, data: null };
    });
  }

  function formatTime(ms) {
    if (!ms || typeof ms !== 'number') return '—';
    try {
      return new Date(ms).toLocaleString();
    } catch (e) {
      return String(ms);
    }
  }

  function scheduleSummary(task) {
    if (task.schedule && task.schedule.expr) {
      var tz = task.schedule.tz ? ' (' + task.schedule.tz + ')' : ' (local)';
      return task.schedule.expr + tz;
    }
    if (task.trigger && task.trigger.kind) {
      return 'watch:' + task.trigger.kind + (task.trigger.every ? ' · ' + task.trigger.every : '');
    }
    return task.kind === 'goal' ? 'Goal' : 'One-off';
  }

  function loadCapabilitiesAndTasks() {
    state.loading = true;
    state.error = null;
    render();
    return fetchJSON('/api/client-capabilities').then(function (capRes) {
      if (capRes.ok && capRes.data) {
        state.capabilities = capRes.data;
      } else {
        // Older servers without /api/client-capabilities degrade conservatively.
        state.capabilities = {
          edition: 'mac',
          location: 'mac',
          canApprove: false,
          tasks: { status: 'available', supportedKinds: ['oneoff', 'routine', 'watcher', 'goal'] },
          artifacts: { status: 'available' },
        };
      }
      if (state.capabilities.tasks && state.capabilities.tasks.status !== 'available') {
        state.tasks = [];
        state.loading = false;
        render();
        return;
      }
      return fetchJSON('/api/tasks').then(function (res) {
        state.loading = false;
        if (!res.ok || !res.data || !Array.isArray(res.data.tasks)) {
          state.error = (res.data && res.data.message) || 'Could not load tasks.';
          render();
          return;
        }
        state.tasks = res.data.tasks;
        if (state.selectedId && !state.tasks.some(function (t) { return t.id === state.selectedId; })) {
          state.selectedId = null;
          state.runs = [];
          state.selectedRun = null;
        }
        render();
        if (state.selectedId) void loadRunsFor(state.selectedId);
      });
    });
  }

  function loadRunsFor(taskId) {
    return fetchJSON('/api/tasks/' + encodeURIComponent(taskId) + '/runs').then(function (res) {
      if (state.selectedId !== taskId) return;
      state.runs = (res.ok && res.data && Array.isArray(res.data.runs)) ? res.data.runs : [];
      if (state.runs.length && (!state.selectedRunId || !state.runs.some(function (r) { return r.id === state.selectedRunId; }))) {
        state.selectedRunId = state.runs[0].id;
        state.selectedRun = state.runs[0];
      } else if (!state.runs.length) {
        state.selectedRunId = null;
        state.selectedRun = null;
      }
      render();
    });
  }

  function openArtifactPreview(artifact) {
    state.preview = { loading: true, title: artifact.title || artifact.filename || artifact.id, downloadUrl: artifact.downloadUrl, content: '', error: null, kind: artifact.kind };
    render();
    if (artifact.kind === 'link') {
      fetchJSON(artifact.previewUrl).then(function (res) {
        if (!state.preview) return;
        state.preview.loading = false;
        if (res.ok && res.data && res.data.url) {
          state.preview.url = res.data.url;
        } else {
          state.preview.error = 'This link artifact could not be verified.';
        }
        render();
      });
      return;
    }
    fetch(artifact.previewUrl).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var ctype = (res.headers.get('content-type') || '').toLowerCase();
      if (ctype.indexOf('text/') === 0 || ctype.indexOf('application/json') === 0) {
        return res.text().then(function (txt) {
          if (!state.preview) return;
          state.preview.loading = false;
          state.preview.content = txt;
          render();
        });
      }
      if (!state.preview) return;
      state.preview.loading = false;
      state.preview.content = 'Binary artifact (' + (ctype || 'application/octet-stream') + '). Use Download to inspect it locally.';
      render();
    }).catch(function () {
      if (!state.preview) return;
      state.preview.loading = false;
      state.preview.error = 'Could not load artifact preview.';
      render();
    });
  }

  function render() {
    if (!root) return;
    var cap = state.capabilities;
    var tasksCap = cap && cap.tasks;
    var supportedKinds = (tasksCap && Array.isArray(tasksCap.supportedKinds)) ? tasksCap.supportedKinds : [];
    var tasksAvailable = !tasksCap || tasksCap.status === 'available';

    var html =
      '<div class="view-head"><div><h2>Tasks</h2><div class="vh-sub">Routines, watchers, goals and deliverables</div></div>' +
      '<div class="tasks-head-actions">' +
      (cap ? '<span class="tasks-loc-pill">' + esc(cap.location === 'cloud' ? 'Cloud' : 'This Mac') + '</span>' : '') +
      (tasksAvailable ? '<button type="button" class="view-act" id="tasksNewToggle">' + (state.creating ? 'Close form' : '+ New task') + '</button>' : '') +
      '<button type="button" class="btn-secondary" id="tasksRefresh">Refresh</button>' +
      '</div></div>';

    html += '<div class="view-scroll tasks-scroll"><div class="tasks-inner">';

    if (!tasksAvailable) {
      html +=
        '<div class="lisa-empty-state" id="tasksUnavailable">' +
        '<img src="/assets/visuals/soft-ink-v1/stickers/lisa-make-a-plan.png" alt="">' +
        '<h3>Tasks are not enabled here</h3>' +
        '<p>' + esc((tasksCap && tasksCap.reason) || 'This server does not currently run background tasks.') + '</p>' +
        '</div></div></div>';
      root.innerHTML = html;
      bindEvents();
      return;
    }

    if (state.creating) {
      var defaultTz = '';
      try { defaultTz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
      html +=
        '<form class="tasks-create-card" id="tasksCreateForm">' +
        '<div class="tasks-form-row"><label for="taskTitleInput">Title</label><input id="taskTitleInput" required maxlength="200" placeholder="Morning briefing"></div>' +
        '<div class="tasks-form-row"><label for="taskKindInput">Kind</label><select id="taskKindInput">' +
        supportedKinds.map(function (k) { return '<option value="' + esc(k) + '">' + esc(k) + '</option>'; }).join('') +
        '</select></div>' +
        '<div class="tasks-form-row"><label for="taskScheduleInput">Schedule (optional)</label><input id="taskScheduleInput" placeholder="weekdays:09:00 or every:1h"></div>' +
        '<div class="tasks-form-row"><label for="taskTzInput">IANA Timezone</label><input id="taskTzInput" value="' + esc(defaultTz) + '" placeholder="America/Los_Angeles"></div>' +
        '<div class="tasks-form-row"><label for="taskInstructionInput">Instruction</label><textarea id="taskInstructionInput" rows="3" required placeholder="What should Lisa check or produce?"></textarea></div>' +
        '<div class="tasks-form-row"><label for="taskMilestonesInput">Goal milestones (one per line, optional)</label><textarea id="taskMilestonesInput" rows="2" placeholder="Collect references&#10;Draft summary"></textarea></div>' +
        '<div class="tasks-form-actions"><button type="submit" class="view-act">Create draft</button><span class="tasks-form-err" id="tasksFormErr"></span></div>' +
        '</form>';
    }

    html += '<div class="tasks-filters" role="tablist" aria-label="Filter tasks">' +
      ['all', 'routine', 'watcher', 'goal', 'oneoff'].map(function (k) {
        var label = k === 'all' ? 'All' : k === 'oneoff' ? 'One-off' : (k.charAt(0).toUpperCase() + k.slice(1));
        return '<button type="button" class="tasks-filter' + (state.filter === k ? ' active' : '') + '" data-task-filter="' + esc(k) + '">' + esc(label) + '</button>';
      }).join('') + '</div>';

    if (state.error) {
      html += '<div class="tasks-error" role="alert">' + esc(state.error) + '</div>';
    }

    var visible = state.tasks.filter(function (t) {
      return state.filter === 'all' || t.kind === state.filter;
    });

    if (state.loading && !state.tasks.length) {
      html += '<div class="view-empty">Loading tasks…</div>';
    } else if (!visible.length) {
      html +=
        '<div class="lisa-empty-state"><img src="/assets/visuals/soft-ink-v1/stickers/lisa-make-a-plan.png" alt="">' +
        '<h3>No tasks yet</h3><p>Create a routine, watcher, goal, or one-off deliverable to track runs and artifacts here.</p></div>';
    } else {
      html += '<div class="tasks-layout"><div class="tasks-list">';
      for (var i = 0; i < visible.length; i++) {
        var t = visible[i];
        var sel = t.id === state.selectedId;
        html +=
          '<button type="button" class="task-card' + (sel ? ' selected' : '') + '" data-task-select="' + esc(t.id) + '">' +
          '<div class="task-card-top"><span class="task-kind-badge">' + esc(t.kind) + '</span>' +
          '<span class="task-state-badge state-' + esc(t.state) + '">' + esc(t.state) + '</span></div>' +
          '<div class="task-card-title">' + esc(t.title) + '</div>' +
          '<div class="task-card-meta">' + esc(scheduleSummary(t)) + (t.nextRunAt ? ' · next ' + esc(formatTime(t.nextRunAt)) : '') + '</div>' +
          '</button>';
      }
      html += '</div><div class="tasks-detail" id="tasksDetailPane">';
      var selected = visible.find(function (t) { return t.id === state.selectedId; }) || null;
      if (!selected) {
        html += '<div class="view-empty">Select a task to inspect schedule, milestones, runs, and artifacts.</div>';
      } else {
        html += renderTaskDetail(selected);
      }
      html += '</div></div>';
    }

    if (state.preview) {
      html +=
        '<div class="tasks-preview-backdrop" id="tasksPreviewModal" role="dialog" aria-modal="true">' +
        '<div class="tasks-preview-card">' +
        '<div class="tasks-preview-head"><strong>' + esc(state.preview.title) + '</strong>' +
        '<div class="tasks-preview-acts">' +
        (state.preview.downloadUrl ? '<a class="btn-secondary" href="' + esc(state.preview.downloadUrl) + '" download>Download</a>' : '') +
        '<button type="button" class="btn-secondary" id="tasksPreviewClose">Close</button></div></div>' +
        '<div class="tasks-preview-body">' +
        (state.preview.loading ? '<div class="view-empty">Loading preview…</div>'
          : state.preview.error ? '<div class="tasks-error">' + esc(state.preview.error) + '</div>'
          : state.preview.url ? '<p><a href="' + esc(state.preview.url) + '" target="_blank" rel="noopener noreferrer">' + esc(state.preview.url) + '</a></p>'
          : '<pre class="tasks-preview-pre">' + esc(state.preview.content || '') + '</pre>') +
        '</div></div></div>';
    }

    html += '</div></div>';
    root.innerHTML = html;
    bindEvents();
  }

  function renderTaskDetail(task) {
    var html =
      '<div class="task-detail-head"><div><h3>' + esc(task.title) + '</h3>' +
      '<div class="task-detail-sub">' + esc(scheduleSummary(task)) + ' · host: ' + esc(task.host || 'any') + ' · state: ' + esc(task.state) + '</div></div>' +
      '<div class="task-detail-actions">' +
      '<button type="button" class="view-act" data-task-action="run" data-task-id="' + esc(task.id) + '">Run now</button>' +
      '<button type="button" class="btn-secondary" data-task-action="toggle" data-task-id="' + esc(task.id) + '" data-enabled="' + (task.enabled ? '1' : '0') + '">' + (task.enabled ? 'Pause' : 'Enable') + '</button>' +
      (task.activeRunId ? '<button type="button" class="btn-secondary" data-task-action="cancel" data-task-id="' + esc(task.id) + '">Stop run</button>' : '') +
      '<button type="button" class="btn-secondary" data-task-action="delete" data-task-id="' + esc(task.id) + '">Delete</button>' +
      '</div></div>';

    html += '<p class="task-instruction">' + esc(task.instruction) + '</p>';
    if (task.lastSummary) {
      html += '<div class="task-summary-box"><strong>Last summary</strong><p>' + esc(task.lastSummary) + '</p></div>';
    }

    if (Array.isArray(task.goalMilestones) && task.goalMilestones.length) {
      html += '<div class="task-section"><h4>Goal milestones</h4><ul class="goal-milestones">';
      for (var m = 0; m < task.goalMilestones.length; m++) {
        var ms = task.goalMilestones[m];
        html +=
          '<li class="goal-milestone' + (ms.done ? ' done' : '') + '">' +
          '<span class="gm-check" aria-hidden="true">' + (ms.done ? '✓' : '○') + '</span>' +
          '<div class="gm-body"><div class="gm-title">' + esc(ms.title) + '</div>' +
          (ms.evidence ? '<div class="gm-evidence">' + esc(ms.evidence) + '</div>' : '') +
          '</div></li>';
      }
      html += '</ul></div>';
    }

    html += '<div class="task-section"><h4>Recent runs</h4>';
    if (!state.runs.length) {
      html += '<div class="view-empty">No runs recorded yet.</div>';
    } else {
      html += '<div class="task-runs-list">';
      for (var r = 0; r < state.runs.length; r++) {
        var run = state.runs[r];
        var arts = Array.isArray(run.artifacts) ? run.artifacts : [];
        html +=
          '<div class="task-run-item">' +
          '<div class="task-run-meta"><strong>' + esc(run.state) + '</strong> · ' + esc(formatTime(run.startedAt)) +
          (run.error ? ' · <span class="task-run-err">' + esc(run.error) + '</span>' : '') + '</div>' +
          (run.summary ? '<div class="task-run-summary">' + esc(run.summary) + '</div>' : '');
        if (arts.length) {
          html += '<div class="task-artifacts">';
          for (var a = 0; a < arts.length; a++) {
            var art = arts[a];
            html +=
              '<div class="task-artifact-row">' +
              '<span class="task-artifact-kind">' + esc(art.kind) + '</span>' +
              '<span class="task-artifact-title">' + esc(art.title || art.filename || art.id) + '</span>' +
              '<button type="button" class="btn-secondary" data-art-run="' + esc(run.id) + '" data-art-id="' + esc(art.id) + '">Preview</button>' +
              '<a class="btn-secondary" href="' + esc(art.downloadUrl) + '" download>Download</a>' +
              '</div>';
          }
          html += '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function bindEvents() {
    if (!root) return;
    var refresh = root.querySelector('#tasksRefresh');
    if (refresh) refresh.addEventListener('click', function () { void loadCapabilitiesAndTasks(); });
    var newBtn = root.querySelector('#tasksNewToggle');
    if (newBtn) newBtn.addEventListener('click', function () { state.creating = !state.creating; render(); });

    var form = root.querySelector('#tasksCreateForm');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var title = /** @type {HTMLInputElement} */ (root.querySelector('#taskTitleInput')).value.trim();
        var kind = /** @type {HTMLSelectElement} */ (root.querySelector('#taskKindInput')).value;
        var scheduleExpr = /** @type {HTMLInputElement} */ (root.querySelector('#taskScheduleInput')).value.trim();
        var tz = /** @type {HTMLInputElement} */ (root.querySelector('#taskTzInput')).value.trim();
        var instruction = /** @type {HTMLTextAreaElement} */ (root.querySelector('#taskInstructionInput')).value.trim();
        var msRaw = /** @type {HTMLTextAreaElement} */ (root.querySelector('#taskMilestonesInput')).value.trim();
        var body = { title: title, kind: kind, instruction: instruction };
        if (scheduleExpr) body.schedule = tz ? { expr: scheduleExpr, tz: tz } : { expr: scheduleExpr };
        if (msRaw) {
          body.goalMilestones = msRaw.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).map(function (line, idx) {
            return { id: 'm' + (idx + 1), title: line, done: false };
          });
        }
        fetchJSON('/api/tasks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).then(function (res) {
          if (!res.ok) {
            var errEl = root.querySelector('#tasksFormErr');
            if (errEl) errEl.textContent = (res.data && (res.data.message || res.data.error)) || 'Could not create task.';
            return;
          }
          state.creating = false;
          if (res.data && res.data.task) state.selectedId = res.data.task.id;
          void loadCapabilitiesAndTasks();
        });
      });
    }

    root.querySelectorAll('[data-task-filter]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.filter = btn.getAttribute('data-task-filter') || 'all';
        render();
      });
    });

    root.querySelectorAll('[data-task-select]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-task-select');
        if (!id) return;
        state.selectedId = id;
        state.runs = [];
        state.selectedRun = null;
        render();
        void loadRunsFor(id);
      });
    });

    root.querySelectorAll('[data-task-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var action = btn.getAttribute('data-task-action');
        var id = btn.getAttribute('data-task-id');
        if (!action || !id) return;
        var req = null;
        if (action === 'run') {
          req = fetchJSON('/api/tasks/' + encodeURIComponent(id) + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        } else if (action === 'cancel') {
          req = fetchJSON('/api/tasks/' + encodeURIComponent(id) + '/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        } else if (action === 'toggle') {
          var enabled = btn.getAttribute('data-enabled') === '1';
          req = fetchJSON('/api/tasks/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !enabled }) });
        } else if (action === 'delete') {
          req = fetchJSON('/api/tasks/' + encodeURIComponent(id), { method: 'DELETE' });
        }
        if (req) req.then(function () { void loadCapabilitiesAndTasks(); });
      });
    });

    root.querySelectorAll('[data-art-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var runId = btn.getAttribute('data-art-run');
        var artId = btn.getAttribute('data-art-id');
        var run = state.runs.find(function (r) { return r.id === runId; });
        var art = run && Array.isArray(run.artifacts) && run.artifacts.find(function (a) { return a.id === artId; });
        if (art) openArtifactPreview(art);
      });
    });

    var closePreview = root.querySelector('#tasksPreviewClose');
    if (closePreview) closePreview.addEventListener('click', function () { state.preview = null; render(); });
  }

  window.LisaTasks = {
    mount: function (el) {
      root = el;
      void loadCapabilitiesAndTasks();
    },
    refresh: function () {
      if (root) void loadCapabilitiesAndTasks();
    },
    onEvent: function (ev) {
      if (!root || !ev || !ev.type) return;
      if (ev.type === 'task_updated' || ev.type === 'task_deleted' || ev.type === 'task_run_started' || ev.type === 'task_run_finished' || ev.type === 'task_result') {
        void loadCapabilitiesAndTasks();
      }
    },
  };
})();
