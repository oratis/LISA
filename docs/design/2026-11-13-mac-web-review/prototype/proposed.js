/*
 * Design-review prototype — NOT shipped code.
 *
 * DOM tweaks that pair with proposed.css. capture.mjs injects this file into a
 * running shell and calls LisaProposals.<name>() to produce each "after" shot.
 * Every function only rearranges or relabels what the shell already renders.
 */
window.LisaProposals = (function () {
  var ICON = {
    clip: '<path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
    camera:
      '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
    apps: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14v7M14 17.5h7"/>',
    monitor: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  };
  function svg(inner) {
    return (
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      inner +
      "</svg>"
    );
  }
  function on(cls) {
    document.body.classList.add(cls);
  }
  function emptyState(img, title, body, actions) {
    var acts = (actions || [])
      .map(function (a) {
        return (
          '<button type="button" class="' +
          (a.primary ? "view-act" : "p-btn-secondary") +
          '">' +
          a.label +
          "</button>"
        );
      })
      .join("");
    return (
      '<div class="p-empty-state"><img src="/assets/visuals/soft-ink-v1/stickers/' +
      img +
      '" alt="">' +
      "<h3>" +
      title +
      "</h3><p>" +
      body +
      "</p>" +
      (acts ? '<div class="acts">' + acts + "</div>" : "") +
      "</div>"
    );
  }

  return {
    /* D-1 — compact sidebar; the Remote Macs entry moves into Control. */
    sidebar: function () {
      on("p-sidebar");
      var tag = document.getElementById("navAgentCount");
      if (tag && tag.textContent.trim() === "0") tag.setAttribute("data-zero", "");
    },
    /* D-2 — Control's header carries the Remote Macs entry. */
    controlHeader: function () {
      var head = document.querySelector("#viewControl .view-head");
      if (!head || head.querySelector(".p-head-acts")) return;
      var act = head.querySelector(".view-act");
      var wrap = document.createElement("div");
      wrap.className = "p-head-acts";
      wrap.style.cssText = "display:flex;gap:8px;align-items:center";
      var macs = document.createElement("a");
      macs.className = "p-btn-secondary";
      macs.href = "/fleet";
      macs.style.cssText = "display:inline-flex;align-items:center;gap:7px;text-decoration:none";
      macs.innerHTML =
        '<span style="display:inline-flex;width:16px;height:16px">' +
        svg(ICON.monitor) +
        "</span>Remote Macs";
      wrap.appendChild(macs);
      if (act) {
        head.replaceChild(wrap, act);
        wrap.appendChild(act);
      } else head.appendChild(wrap);
    },
    /* D-3 */
    kb: function () {
      on("p-kb");
    },
    /* D-6 */
    buttons: function () {
      on("p-buttons");
    },
    /* D-7 — Settings: expressions become two labelled rows under an outside label. */
    settingsControls: function () {
      on("p-controls");
      var box = document.querySelector("#viewSettings .expression-settings");
      if (!box || box.dataset.proposed) return;
      box.dataset.proposed = "1";
      var title = box.querySelector("h3");
      var display = box.querySelector("#expressionDisplay");
      var frequency = box.querySelector("#expressionFrequency");
      var note = box.querySelector("p");
      var label = document.createElement("div");
      label.className = "view-sec-label";
      label.textContent = title ? title.textContent : "Conversation expressions";
      box.parentNode.insertBefore(label, box);
      if (title) title.remove();
      box.className = "set-card expression-settings";
      function row(name, sub, control) {
        var r = document.createElement("div");
        r.className = "set-row";
        r.innerHTML =
          '<div class="set-main"><div class="set-name">' +
          name +
          "</div>" +
          (sub ? '<div class="set-sub">' + sub + "</div>" : "") +
          "</div>";
        // .set-theme is the shell's "auto-width select at the end of a row" rule.
        control.classList.add("set-input", "set-theme");
        r.appendChild(control);
        return r;
      }
      var noteText = note ? note.textContent : "";
      if (note) note.remove();
      box.prepend(row("How often", "Fewer, or more lively", frequency));
      box.prepend(row("Stickers in replies", noteText, display));
    },
    /* D-7 — Sense: consent uses the same switch as Settings. */
    senseControls: function () {
      on("p-controls");
      document.querySelectorAll("#viewSense .v-toggle[data-signal]").forEach(function (b) {
        b.classList.add("as-switch");
        b.setAttribute("role", "switch");
        var name = b.parentNode.querySelector(".v-name");
        if (name) name.classList.add("consent-name");
      });
    },
    /* D-8 — plus menu and Memory rows use the shell's line icons. */
    plusIcons: function () {
      on("p-icons");
      var m = document.getElementById("plusMenu");
      if (!m) return;
      var set = function (id, icon) {
        var b = document.getElementById(id);
        if (!b) return;
        var g = b.querySelector(".g");
        if (!g) {
          g = document.createElement("span");
          g.className = "g";
          b.prepend(g);
          b.insertBefore(document.createTextNode(" "), g.nextSibling);
        }
        g.innerHTML = svg(icon);
      };
      set("pmAttach", ICON.clip);
      set("pmConnectors", ICON.apps);
      set("pmShot", ICON.camera);
    },
    memoryIcons: function () {
      on("p-icons");
      var src = {
        soul: '.fbtn[data-panel="soul"] svg',
        skills: '.fbtn[data-panel="skills"] svg',
        memory: '#navList [data-view="memory"] svg',
        tools: '.fbtn[data-panel="tools"] svg',
        plans: '.fbtn[data-panel="plans"] svg',
      };
      document.querySelectorAll("#viewMemory .mem-btn").forEach(function (b) {
        var from = document.querySelector(src[b.getAttribute("data-mem")] || "");
        var ico = b.querySelector(".mem-ico");
        if (from && ico) {
          ico.innerHTML = "";
          ico.appendChild(from.cloneNode(true));
        }
      });
    },
    /* D-11 — empty states. */
    emptyControl: function () {
      var e = document.querySelector("#viewControl .view-empty");
      if (e)
        e.outerHTML = emptyState(
          "lisa-make-a-plan.png",
          "No agents running",
          "Delegate a task, or start Claude Code or Codex in a terminal — live sessions show up here.",
          [{ label: "+ Delegate a task", primary: true }, { label: "Remote Macs" }],
        );
    },
    emptyMail: function () {
      var card = document.querySelector("#viewMail .v-card");
      if (card)
        card.outerHTML = emptyState(
          "lisa-tea-break.png",
          "No mailbox connected",
          "Connect one and Lisa sorts it into a daily digest. Read-only, stored on this Mac.",
          [{ label: "+ Connect mailbox", primary: true }],
        );
      var sweep = document.getElementById("mailSweepBtn");
      if (sweep && sweep.parentNode) sweep.parentNode.style.display = "none";
      var headAct = document.querySelector("#viewMail .view-head .view-act");
      if (headAct) headAct.style.display = "none";
    },
    emptyKb: function () {
      var e = document.querySelector("#kbList .view-empty");
      if (!e) return;
      e.parentNode.classList.add("is-empty");
      e.outerHTML = emptyState(
        "lisa-thinking.png",
        "Nothing saved yet",
        "Paste a link above, or select messages in Chat and choose Add to KB.",
        [],
      );
    },
    /* D-12 — plain-language seed line. The typewriter writes one text node per
       character and then appends a cursor span, so replace the text in place. */
    birth: function () {
      on("p-birth");
      var today = new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      document.querySelectorAll("#birthSteps .step-detail").forEach(function (d) {
        if (!/^born \d{4}-\d\d-\d\dT/.test(d.textContent)) return;
        var cursor = d.querySelector(".step-cursor");
        d.textContent = "born " + today + ", on this Mac";
        if (cursor) d.appendChild(cursor);
      });
      // What the typewriter does after every character, once the list can scroll.
      var steps = document.getElementById("birthSteps");
      if (steps) steps.scrollTop = steps.scrollHeight;
    },
    /* D-4 — a placeholder that fits every width; the key hint moves to the
       tooltip and the shortcuts sheet, where it costs no chat height. */
    composer: function () {
      var input = document.getElementById("input");
      if (!input) return;
      input.setAttribute("placeholder", "Message Lisa…");
      input.setAttribute("title", "Enter to send · Shift+Enter for a new line");
    },
    /* D-5 / D-15 — function bar in four groups; rail toggle highlights when open. */
    fnbar: function () {
      on("p-fnbar");
      var bar = document.getElementById("fnbar");
      if (!bar || bar.dataset.proposed) return;
      bar.dataset.proposed = "1";
      var q = function (s) {
        return bar.querySelector(s);
      };
      var groups = [
        [q("#fnFind"), q("#fnSearchBtn"), q("#fnKbSelect")],
        [
          q('[data-panel="soul"]'),
          q('[data-panel="skills"]'),
          q('[data-panel="tools"]'),
          q('[data-panel="plans"]'),
        ],
        [q("#fnMail"), q('[data-panel="pair"]')],
        [q("#fnPanel"), q("#fnTheme")],
      ];
      var tail = q("#mobileToolsBtn");
      groups.forEach(function (g, i) {
        if (i) {
          var sep = document.createElement("span");
          sep.className = "fbar-sep";
          bar.insertBefore(sep, tail);
        }
        g.forEach(function (n) {
          if (n) bar.insertBefore(n, tail);
        });
      });
    },
  };
})();
