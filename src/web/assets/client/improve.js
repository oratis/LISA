/**
 * Improve LISA M0/M1 view (`#viewImprove`) — fixed sidebar entry for creating
 * dedicated improvement sessions, previewing/applying/rolling back personal
 * capabilities, and preparing de-privatized community contributions.
 */
(function initLisaImprove() {
  var root = null;
  var state = {
    tab: 'new',
    profileVersion: 0,
    items: [],
    activeCapabilities: [],
    loading: false,
    error: null,
    notice: null,
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function safeHttpUrl(u) {
    var s = String(u == null ? '' : u).trim();
    return /^https?:\/\//i.test(s) ? s : '';
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

  function refresh() {
    state.loading = true;
    state.error = null;
    render();
    return fetchJSON('/api/improve').then(function (res) {
      state.loading = false;
      if (!res.ok || !res.data) {
        state.error = (res.data && (res.data.message || res.data.error)) || 'Could not load improvements.';
        render();
        return;
      }
      state.profileVersion = res.data.profileVersion || 0;
      state.items = Array.isArray(res.data.items) ? res.data.items : [];
      state.activeCapabilities = Array.isArray(res.data.activeCapabilities) ? res.data.activeCapabilities : [];
      render();
    });
  }

  function render() {
    if (!root) return;
    var html =
      '<div class="view-head"><div><h2>Improve LISA</h2>' +
      '<div class="vh-sub">Personal capabilities · safe rollback · optional community PRs (profile v' + esc(state.profileVersion) + ')</div></div>' +
      '<div class="improve-head-acts"><button type="button" class="btn-secondary" id="improveRefreshBtn">Refresh</button></div></div>' +
      '<div class="view-scroll improve-scroll"><div class="improve-inner">';

    html += '<div class="improve-tabs" role="tablist" aria-label="Improve LISA sections">' +
      [
        { id: 'new', label: 'New improvement' },
        { id: 'capabilities', label: 'My capabilities (' + state.activeCapabilities.length + ')' },
        { id: 'history', label: 'Improvement log (' + state.items.length + ')' },
      ].map(function (t) {
        return '<button type="button" class="improve-tab' + (state.tab === t.id ? ' active' : '') + '" data-imp-tab="' + esc(t.id) + '">' + esc(t.label) + '</button>';
      }).join('') + '</div>';

    if (state.error) html += '<div class="improve-error" role="alert">' + esc(state.error) + '</div>';
    if (state.notice) html += '<div class="improve-notice" role="status">' + esc(state.notice) + '</div>';

    if (state.tab === 'new') {
      html +=
        '<form class="improve-card" id="improveCreateForm">' +
        '<div class="improve-field"><label for="impTitle">What should Lisa do better?</label><input id="impTitle" required maxlength="120" placeholder="Weekly GitHub brief"></div>' +
        '<div class="improve-field"><label for="impKind">Capability type</label><select id="impKind">' +
        '<option value="skill">Personal skill (SKILL.md)</option>' +
        '<option value="preference">Behavior preference (JSON)</option>' +
        '<option value="workflow">Workflow template</option>' +
        '</select></div>' +
        '<div class="improve-field"><label for="impGoal">Goal and expected behavior</label><textarea id="impGoal" rows="3" required placeholder="Describe the behavior change, format, or constraint."></textarea></div>' +
        '<div class="improve-field"><label for="impContent">Draft capability content (optional)</label><textarea id="impContent" rows="4" placeholder="Leave blank to generate a clean starter template."></textarea></div>' +
        '<div class="improve-form-acts"><button type="submit" class="view-act">Create improvement draft</button></div>' +
        '</form>';
    }

    if (state.tab === 'capabilities') {
      if (!state.activeCapabilities.length) {
        html +=
          '<div class="lisa-empty-state"><img src="/assets/visuals/soft-ink-v1/stickers/lisa-make-a-plan.png" alt="">' +
          '<h3>No personal capabilities active yet</h3>' +
          '<p>Create and preview an improvement first. Personal capabilities stay in your Home and never require GitHub.</p></div>';
      } else {
        for (var c = 0; c < state.activeCapabilities.length; c++) {
          var cap = state.activeCapabilities[c];
          html +=
            '<div class="improve-card"><div class="improve-row-head"><strong>' + esc(cap.packageId) + '</strong>' +
            '<span class="improve-pill active">v' + esc(cap.version) + ' · ' + esc(cap.kind) + '</span></div>' +
            '<div class="improve-meta">Digest: <code>' + esc(cap.digest.slice(0, 12)) + '</code> · Permissions: ' + esc((cap.permissions || []).join(', ')) + '</div></div>';
        }
      }
    }

    if (state.tab === 'history') {
      if (!state.items.length) {
        html += '<div class="view-empty">No improvement records yet.</div>';
      } else {
        for (var i = 0; i < state.items.length; i++) {
          var item = state.items[i];
          var cs = item.changeSet;
          html +=
            '<div class="improve-card" data-imp-card="' + esc(item.id) + '">' +
            '<div class="improve-row-head"><div><strong>' + esc(item.title) + '</strong>' +
            '<div class="improve-meta">' + esc(item.packageId) + ' · ' + esc(item.kind) + '</div></div>' +
            '<div class="improve-badges">' +
            '<span class="improve-pill">work: ' + esc(item.workStatus) + '</span>' +
            '<span class="improve-pill ' + esc(item.activationStatus) + '">apply: ' + esc(item.activationStatus) + '</span>' +
            '<span class="improve-pill">pr: ' + esc(item.contributionStatus) + '</span>' +
            '</div></div>' +
            '<p class="improve-goal">' + esc(item.goal) + '</p>';
          if (cs && Array.isArray(cs.acceptanceCases) && cs.acceptanceCases.length) {
            html += '<ul class="improve-checks">' + cs.acceptanceCases.map(function (ch) {
              return '<li class="' + (ch.passed ? 'ok' : 'fail') + '">' + (ch.passed ? '✓ ' : '✗ ') + esc(ch.name) + ' — ' + esc(ch.detail) + '</li>';
            }).join('') + '</ul>';
          }
          html += '<div class="improve-actions">' +
            '<button type="button" class="btn-secondary" data-imp-act="preview" data-imp-id="' + esc(item.id) + '">Preview & check</button>' +
            (item.workStatus === 'preview_ready' && cs
              ? '<button type="button" class="view-act" data-imp-act="apply" data-imp-id="' + esc(item.id) + '" data-imp-digest="' + esc(cs.digest) + '">Apply to my LISA</button>'
              : '') +
            (item.activationStatus === 'active'
              ? '<button type="button" class="btn-secondary" data-imp-act="rollback" data-imp-id="' + esc(item.id) + '">Rollback</button>'
              : '') +
            '<button type="button" class="btn-secondary" data-imp-act="export" data-imp-id="' + esc(item.id) + '">Prepare community PR</button>' +
            '</div>';
          if (item.contribution) {
            var compareHref = safeHttpUrl(item.contribution.compareUrl);
            html +=
              '<div class="improve-contrib">' +
              '<div><strong>Community export ready</strong> · digest <code>' + esc(item.contribution.exportDigest.slice(0, 12)) + '</code></div>' +
              '<div>Branch: <code>' + esc(item.contribution.branchName) + '</code>' +
              (compareHref ? ' · <a href="' + esc(compareHref) + '" target="_blank" rel="noopener noreferrer">Open GitHub compare</a>' : '') +
              '</div></div>';
          }
          html += '</div>';
        }
      }
    }

    html += '</div></div>';
    root.innerHTML = html;
    bindEvents();
  }

  function bindEvents() {
    if (!root) return;
    var ref = root.querySelector('#improveRefreshBtn');
    if (ref) ref.addEventListener('click', function () { void refresh(); });

    root.querySelectorAll('[data-imp-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.tab = btn.getAttribute('data-imp-tab') || 'new';
        render();
      });
    });

    var form = root.querySelector('#improveCreateForm');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        state.error = null;
        state.notice = null;
        var title = /** @type {HTMLInputElement} */ (root.querySelector('#impTitle')).value.trim();
        var kind = /** @type {HTMLSelectElement} */ (root.querySelector('#impKind')).value;
        var goal = /** @type {HTMLTextAreaElement} */ (root.querySelector('#impGoal')).value.trim();
        var content = /** @type {HTMLTextAreaElement} */ (root.querySelector('#impContent')).value;
        /** @type {Record<string, unknown>} */
        var body = { title: title, kind: kind, goal: goal };
        if (content.trim()) {
          body.files = [{ path: kind === 'preference' ? 'preferences.json' : 'SKILL.md', content: content }];
        }
        fetchJSON('/api/improve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).then(function (res) {
          if (!res.ok) {
            state.error = (res.data && (res.data.message || res.data.error)) || 'Could not create improvement.';
            render();
            return;
          }
          state.notice = 'Created improvement draft. Run Preview & check before applying.';
          state.tab = 'history';
          void refresh();
        });
      });
    }

    root.querySelectorAll('[data-imp-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var act = btn.getAttribute('data-imp-act');
        var id = btn.getAttribute('data-imp-id');
        if (!act || !id) return;
        state.error = null;
        state.notice = null;
        /** @type {Record<string, unknown>} */
        var payload = {};
        if (act === 'apply') payload.digest = btn.getAttribute('data-imp-digest') || '';
        if (act === 'preview') payload.rebaseToCurrentProfile = true;
        fetchJSON('/api/improve/' + encodeURIComponent(id) + '/' + encodeURIComponent(act), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(function (res) {
          if (!res.ok) {
            state.error = (res.data && (res.data.message || res.data.error)) || ('Action failed: ' + act);
            render();
            return;
          }
          state.notice = act === 'apply' ? 'Applied to your LISA.' : act === 'rollback' ? 'Rolled back cleanly.' : act === 'export' ? 'Prepared de-privatized community export.' : 'Preview checks completed.';
          void refresh();
        });
      });
    });
  }

  window.LisaImprove = {
    mount: function (el) {
      root = el;
      void refresh();
    },
    refresh: function () {
      if (root) void refresh();
    },
  };
})();
