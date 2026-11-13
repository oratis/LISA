// ── First-run safety net: never leave the user with a silent dead UI. Any
// uncaught error / unreachable backend surfaces as a status toast instead of
// nothing.
//
// Styled from main.css (#lisaBanner) rather than inline, so it follows the
// active theme, and anchored to the BOTTOM: the old top:12px slab covered the
// Mac window's title bar and the entire top function bar — the first thing a
// user saw when the backend was down was a message covering the UI it was
// describing.
//   lisaBanner(msg, opts) — opts.tone: 'info' (a wait we expect to resolve)
//   or 'error' (default); opts.cmd: a shell command shown as a copy-on-click
//   chip under the message.
function lisaBanner(msg, opts) {
  var o = opts || {};
  var el = document.getElementById('lisaBanner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'lisaBanner';
    el.setAttribute('role', 'status');
    var dot = document.createElement('span');
    dot.className = 'lt-dot';
    var body = document.createElement('span');
    body.className = 'lt-body';
    var msgEl = document.createElement('span');
    msgEl.className = 'lt-msg';
    var cmdEl = document.createElement('code');
    cmdEl.className = 'lt-cmd';
    cmdEl.title = 'Click to copy';
    cmdEl.hidden = true;
    cmdEl.addEventListener('click', function () { lisaCopyCmd(cmdEl); });
    body.appendChild(msgEl);
    body.appendChild(cmdEl);
    el.appendChild(dot);
    el.appendChild(body);
    document.body.appendChild(el);
  }
  el.dataset.tone = (o.tone === 'info') ? 'info' : 'error';
  el.querySelector('.lt-msg').textContent = msg;
  var cmd = el.querySelector('.lt-cmd');
  cmd.textContent = o.cmd || '';
  cmd.hidden = !o.cmd;
  // Ride just above the composer while the chat view is up; hug the window
  // edge on views that have none. Re-measured on every call, so a textarea
  // that grew while the user typed never ends up covering the toast.
  var composer = document.getElementById('form');
  var lift = (composer && composer.offsetParent)
    ? Math.round(window.innerHeight - composer.getBoundingClientRect().top) + 14
    : 18;
  el.style.bottom = lift + 'px';
  el.hidden = false;
}
function lisaCopyCmd(el) {
  // clipboard API needs a secure context AND a focused document; when either is
  // missing (http:// from the phone, an unfocused window) fall back to selecting
  // the chip so the command is one Cmd-C away either way.
  var selectIt = function () {
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {}
  };
  var flash = function () {
    el.classList.add('copied');
    setTimeout(function () { el.classList.remove('copied'); }, 1400);
  };
  if (!navigator.clipboard) { selectIt(); return; }
  navigator.clipboard.writeText(el.textContent).then(flash, selectIt);
}
function lisaClearBanner() { var el = document.getElementById('lisaBanner'); if (el) el.hidden = true; }
function lisaSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
window.addEventListener('error', function (e) {
  if (e && e.message) lisaBanner('Interface error — reload the page to recover. (' + e.message + ')');
});
window.addEventListener('unhandledrejection', function (e) {
  var r = e && e.reason;
  lisaBanner('That request failed: ' + ((r && r.message) ? r.message : String(r)));
});

// ── Interface language (UX-8) ────────────────────────────────────
// The shell was English with ~30 Chinese literals mixed into it (the KB
// button, the error block, the chat status). One table, two locales, picked
// from navigator.language; anything missing falls back to English rather than
// rendering a key. Only the strings this pass touches are in here — it is a
// seam for the rest, not a claim that the whole UI is translated.
const LISA_STRINGS = {
  en: {
    "reve.sessionChanged": "The active conversation changed. Select the conversation again to reflect on it.",
    "reve.dreamLog": "Dream records",
    "reve.pendingNotes": "{n} reconsideration notes waiting",
    "reve.corruptDreams": "Some dream records could not be read.",
    "reve.noDreams": "No recent dream records in this period.",
    "reve.revert.memory": "Undo memory changes",
    "reve.revert.kb": "Undo knowledge changes",
    "reve.revert.skills": "Undo skill changes",
    "reve.reconsiderLabel": "Ask Lisa to reconsider a change to her own notes",
    "reve.sendNote": "Send note",
    "reve.note.pending": "Waiting",
    "reve.note.claimed": "In review",
    "reve.note.delivered": "Reviewed",
    "reve.revertsRecorded": "Recorded undo operations: {n}",
    "reve.dreamRestored": "Dream changes were reverted.",
    "reve.noteQueued": "Lisa will see your note during her next reflection.",
    "reve.dreamConflict": "Later edits prevent this undo. Review the current content.",
    "reve.queueFull": "Too many notes are waiting. Try again after Lisa has reviewed them.",
    "reve.dreamsDisabled": "Dream recording is disabled.",
    "reve.dreamActionError": "Could not apply this action.",
    "reve.agentRecap": "Agent activity recap",
    "reve.recapHours": "Last {n} hours",
    "reve.noRecap": "No agent activity in this period.",
    "reve.recapUnavailable": "Agent activity is unavailable.",
    "reve.conversation.reflection": "Conversation reflection",
    "reve.quiet.time.work": "Quiet-time work",
    "reve.scheduled.work": "Scheduled work",
    "reve.a.personal.pursuit": "A personal pursuit",
    "reve.reviewing.priorities": "Reviewing priorities",
    "reve.weekly.reflection": "Weekly reflection",
    "reve.completed": "Completed",
    "reve.no.change.needed": "No change needed",
    "reve.paused.by.a.limit": "Paused by a limit",
    "reve.needs.attention": "Needs attention",
    "reve.memory.updates": "Memory updates",
    "reve.corrections.removals": "Corrections & removals",
    "reve.background.runs": "Background runs",
    "reve.output.tokens": "Output tokens",
    "reve.previous.memory.restored": "Previous memory restored",
    "reve.memory.updated": "Memory updated",
    "reve.about.you": "About you",
    "reve.working.memory": "Working memory",
    "reve.write.not.confirmed": "Write not confirmed",
    "reve.revision.changeCount": "{n} change(s)",
    "reve.count.updates": "{n} updates",
    "reve.some.updates.were.not.applied": "Some updates were not applied",
    "reve.open.conversation": "Open conversation →",
    "reve.knowledge.base.information.is.unavailable": "Knowledge base information is unavailable.",
    "reve.sources": "sources",
    "reve.wiki.pages": "wiki pages",
    "reve.worth.tending": "Worth tending",
    "reve.knowledge.issues": "{n} broken links · {n1} unlinked pages",
    "reve.knowledge.healthy": "No broken links or unlinked pages in the index.",
    "reve.knowledge.empty": "Add sources to start building connected knowledge.",
    "reve.explore.knowledge.base": "Explore knowledge base →",
    "reve.needs.you": "Needs you",
    "reve.in.progress": "In progress",
    "reve.exploring": "Exploring",
    "reve.in": "in",
    "reve.out": "out",
    "reve.hero.eyebrow": "CONTINUITY, WITH CARE",
    "reve.hero.title": "A little reflection. Better memory.",
    "reve.hero.description": "See what Lisa learned, what changed, and the conversations behind it.",
    "reve.proactive.mode.is.on": "Proactive mode is on",
    "reve.proactive.mode.is.paused": "Proactive mode is paused",
    "reve.overview.partial": "Some sections could not be loaded. Refresh to try again.",
    "reve.while.you.were.away": "While you were away",
    "reve.memory.refined": "Memory, refined",
    "reve.all.memory": "All memory →",
    "reve.revisions.caption": "Recent changes with source evidence and a recoverable previous version.",
    "reve.revisions.empty": "No memory changes in this period. Useful changes will appear here with their sources.",
    "reve.from.recent.conversations": "From recent conversations",
    "reve.reflecting": "Reflecting…",
    "reve.reflect.on.this.conversation": "Reflect on this conversation",
    "reve.reflections.empty": "Conversation reflections will appear after Lisa has something worth keeping.",
    "reve.conversation.reflection.is.disabled.for.this.session": "Conversation reflection is disabled for this session.",
    "reve.connected.knowledge": "Connected knowledge",
    "reve.on.her.mind": "On her mind",
    "reve.no.active.pursuits.right.now": "No active pursuits right now.",
    "reve.kept.close": "Kept close",
    "reve.memory.capacityCaption": "A small set of useful facts. Details stay in the knowledge base.",
    "reve.activity.usage": "Activity & usage",
    "reve.latest.20.runs": "Latest 20 runs",
    "reve.input": "Input",
    "reve.output": "Output",
    "reve.cache.read": "Cache read",
    "reve.cache.write": "Cache write",
    "reve.usage.incomplete": "Cache usage was not recorded for {n} runs.",
    "reve.view.run.history": "View run history",
    "reve.no.background.runs.recorded.in.this.period": "No background runs recorded in this period.",
    "reve.history.limits": "Source conversations → reviewed notes → connected knowledge → context for next time. Totals cover up to 2,000 runs and 100 revisions per store; lists show the latest 20 records. Original conversations are preserved.",
    "reve.updated": "Updated ",
    "reve.overview.loadError": "Could not load Rêve. Please refresh.",
    "reve.overview.unavailable": "Your data could not be loaded.",
    "reve.loading.evidence": "Loading evidence…",
    "reve.before": "Before",
    "reve.empty": "(empty)",
    "reve.after": "After",
    "reve.user.statement": "User statement",
    "reve.tool.observation": "Tool observation",
    "reve.assistant.message": "Assistant message",
    "reve.open.source.conversation": "Open source conversation",
    "reve.restore.the.previous.version": "Restore the previous version",
    "reve.restore.unavailable": "Restore is unavailable if memory has changed since this version, or this device has read-only access.",
    "reve.detail.loadError": "Could not load this change. Close and reopen to retry.",
    "reve.source.openError": "The source conversation could not be opened.",
    "reve.reflecting.on.the.current.conversation": "Reflecting on the current conversation…",
    "reve.this.conversation.has.already.been.reviewed": "This conversation has already been reviewed.",
    "reve.reflection.invalid": "The reflection could not be completed. Please try again.",
    "reve.reflection.complete": "Reflection complete.",
    "reve.reflection.error": "Reflection is unavailable. Check your model or try again.",
    "reve.restore.success": "Previous memory restored. The undo is recorded in history.",
    "reve.restore.conflict": "Memory has newer changes. Refresh before restoring.",
    "reve.could.not.restore.this.version": "Could not restore this version.",
    "reve.memory.reflection": "Memory & reflection",
    "reve.period": "Period",
    "reve.last.24.hours": "Last 24 hours",
    "reve.last.7.days": "Last 7 days",
    "reve.last.30.days": "Last 30 days",
    "reve.refresh": "Refresh",
    "reve.loading": "Loading…",
    "expressions.replay": "Replay",
    "expressions.title": "Conversation expressions",
    "expressions.frequency": "Expression frequency",
    "expressions.note": "History stays still. Animations pause offscreen and follow Reduce Motion.",
    "expressions.saved": "Saved",
    "expressions.error": "Could not save. Try again.",
    "expressions.auto": "Automatic",
    "expressions.static": "Still stickers",
    "expressions.emoji": "Emoji only",
    "expressions.off": "Off",
    "expressions.restrained": "Occasionally",
    "expressions.lively": "More often",
    'pty.disabled': 'Interactive CLI agents are turned off on this Mac. Managed tasks remain available.',
    'pty.missing': 'This installation does not include interactive CLI support. Update Lisa to enable it.',
    "panel.loading": "Loading…",
    "panel.failed": "Could not load this panel. Please try again.",
    "panel.retry": "Retry",
    "panel.refresh": "Refresh",
    "skills.active": "Available to Lisa",
    "skills.empty": "No personal or project skills yet. Create one, or import a workflow below.",
    "skills.home": "Personal",
    "skills.project": "Project",
    "skills.create": "Create skill",
    "skills.imports": "Import from your other apps",
    "skills.importNote": "Choose a skill to copy into Lisa. Supporting files are included; required tools and services still need to be configured in Lisa.",
    "skills.noImports": "No compatible skills found in your Codex or Claude skill folders.",
    "skills.import": "Import {name} from {source}",
    "skills.imported": "Imported {name}. It is now available to Lisa.",
    "skills.exists": "Already added",
    "skills.name": "Name (lowercase letters, digits and hyphens)",
    "skills.description": "Description",
    "skills.instructions": "Instructions",
    "skills.saved": "Skill saved. It is now available to Lisa.",
    "skills.actionFailed": "Could not save the skill: {error}",
    "plans.refresh": "Recheck installed tools",
    'session.rename': 'Rename session',
    'session.name': 'Session name',
    'session.renameHint': 'Right-click to rename',
    'session.save': 'Save',
    'session.cancel': 'Cancel',
    'session.invalidName': 'Enter a name of 1–120 characters.',
    'session.renameFailed': 'Could not save the name. Please try again.',
    'attachment.preview': 'Preview {name}',
    'attachment.remove': 'Remove {name}',
    'attachment.close': 'Close preview',

    "connector.label": "{name} read-only connection",
    "connector.selectStatus": "Choose what LISA may read",
    "connector.gmailDetail": "Read headers and bounded snippets in your selected labels, without full bodies or attachments. This task continues after connecting; a new message cancels unfinished work.",
    "connector.calendarDetail": "Choose primary-calendar availability or event details in selected calendars. No events are created or changed. This task continues after connecting; a new message cancels unfinished work.",
    "connector.driveDetail": "Google grants access to files you pick (including write permission); LISA only reads the files you confirm here. Supports text, Docs, Slides and the first sheet of Sheets. No folders, PDFs or attachments. Connecting automatically continues this task.",
    "workspace.renew": "Sign in again to continue this task.",
    "workspace.mismatch": "The provider returned different permissions. Check this application’s read scopes and sign in again.",
    "workspace.period": "Choose a period of up to 31 days.",
    "workspace.type": "Choose a supported text file under 1 MB, or a folder.",
    "workspace.changed": "The resource changed during the read. Retry the original task.",
    "workspace.rate": "The service rate-limited this request. Retry later.",
    "workspace.busy": "Another local sign-in is using the callback. Complete or cancel it, then retry.",
    "workspace.add": "Add resource",
    "workspace.scope": "{name} requests {scope}. LISA reads only the resources you confirm here.",
    "workspace.nativeScope": "macOS grants full access to {name}. LISA reads only the calendars or lists you select.",
    "workspace.login": "Sign in to {name}",
    "workspace.allow": "Allow {name} on this Mac",
    "workspace.open": "Open {name} sign-in",
    "workspace.system": "Complete the macOS permission dialog, then return here.",
    "workspace.return": "Return here after signing in to {name}.",
    "workspace.invalidId": "Enter a valid resource ID or link.",
    "workspace.id": "{name} resource ID",
    "workspace.config": "Configure this application in the private file named by LISA_WORKSPACE_CLIENTS_FILE.",
    "workspace.access": "This account cannot access the selected resource. Check its ID and permissions.",
    "workspace.systemAccess": "Allow LISA access in macOS Privacy & Security, then reconnect.",
    "workspace.platform": "Apple connectors require macOS 14 or later.",
    "workspace.build": "Install Xcode Command Line Tools to build the local EventKit reader.",
    "workspace.unavailable": "Apple Calendar and Reminders are not available in this build of LISA.",
    "connector.slackDetail": "Slack grants access to channel names and history. LISA reads only channels you confirm here. No DMs, shared channels, files or sending messages. Connecting continues the original task.",
    "connector.slackAuthorize": "Authorize LISA read-only in Slack, then return here to choose channels.",
    "connector.browse": "Browse app connectors",
    "connector.pick": "Add example to draft",
    "connector.readExamples": "Choose a read-only task to add to your message. You can edit it before sending.",
    "connector.scope.slack": "LISA can read history in the selected channels until you disconnect.",
    "connector.auth.slack": "Sign in to Slack (read only)",
    "connector.openSlack": "Open Slack authorization",
    "connector.error.slack_client_not_configured": "Configure a Slack app with PKCE and channel read permissions.",
    "connector.error.slack_reauthorization_required": "Slack authorization expired or was removed. Reconnect to continue.",
    "connector.error.slack_read_scope_required": "Slack must grant only the requested channel read permissions.",
    "connector.error.slack_channel_unavailable": "This channel is unavailable, shared, archived, or you are no longer a member.",
    "connector.error.slack_resource_mismatch": "Slack returned content outside the selected channel or thread. The result was blocked.",
    "connector.error.slack_access_denied": "Slack denied access. Check workspace approval and channel membership.",
    "connector.error.slack_rate_limited": "Slack is limiting requests. Try again later.",
    "connector.error.slack_callback_port_in_use": "Another Slack sign-in is using the callback port. Finish or cancel it before retrying.",
    "connector.error.slack_request_failed": "Slack could not complete this request. Retry this task.",
    "connector.error.slack_response_too_large": "The Slack response exceeds the read limit.",
    "connector.error.slack_invalid_time_range": "Choose a valid time range of at most 31 days.",
    "connector.error.slack_invalid_thread": "Choose a valid thread timestamp in the selected channel.",
    "connector.error.slack_invalid_response": "Slack returned an unexpected response. Retry or reconnect.",
    "connector.error.slack_unavailable": "Slack is temporarily unavailable. Retry this task.",
    "connector.notionDetail": "Use a Notion connection with Read content only, then choose pages here. LISA reads ordinary blocks in those pages; child pages, databases, synced blocks and attachments are not followed. Connecting automatically continues this task.",
    "connector.driveAuthorize": "Sign in to Google and pick up to 30 supported files, then return here to confirm them.",
    "connector.notionAuthorize": "Authorize LISA read-only on Notion, then return here to choose pages.",
    "connector.scope.google-drive": "LISA can read the files you confirm here until you disconnect. Open the account menu to pick different files in Google.",
    "connector.scope.notion": "LISA can read content in the selected pages until you disconnect.",
    "connector.auth.drive": "Sign in to Google and choose files",
    "connector.auth.notion": "Sign in to Notion, read-only",
    "connector.openNotion": "Open Notion authorization",
    "connector.error.notion_client_not_configured": "Configure a Notion OAuth client with Read content only.",
    "connector.error.notion_reauthorization_required": "Notion authorization expired. Please reconnect.",
    "connector.error.notion_read_scope_required": "Notion must grant Read content only. Check the app capabilities.",
    "connector.error.notion_page_unavailable": "The page is unavailable or no longer shared with this connection.",
    "connector.error.notion_resource_mismatch": "The page content moved or its access changed. Please retry.",
    "connector.error.notion_access_denied": "Notion denied access. Check page sharing and app capabilities.",
    "connector.error.notion_rate_limited": "Notion is limiting requests. Try again later.",
    "connector.error.notion_callback_port_in_use": "The Notion sign-in callback port is already in use. Finish or cancel the other Notion sign-in, or free the port in the Notion redirect URI, then try again.",
    "connector.error.notion_request_failed": "Notion could not complete this request. Retry this task.",
    "connector.error.notion_response_too_large": "The Notion response exceeds LISA's read limit.",
    "connector.error.notion_invalid_response": "Notion returned an unexpected response. Retry or reconnect.",
    "connector.error.notion_unavailable": "Notion is temporarily unavailable. Retry this task.",
    "connector.error.drive_selection_required": "Select supported files in the Google picker.",
    "connector.error.drive_selection_limit_exceeded": "More than 30 files were selected. Sign in again and choose up to 30 files.",
    "connector.error.drive_access_denied": "Google Drive denied access to this file. Check its sharing and download settings.",
    "connector.error.drive_rate_limited": "Google Drive is limiting requests. Try again later.",
    "connector.error.drive_unavailable": "Google Drive is temporarily unavailable. Retry this task.",
    "connector.error.drive_request_failed": "Google Drive could not complete this read. Retry or reconnect.",
    "connector.error.drive_file_unavailable": "The selected Drive file is unavailable.",
    "connector.error.drive_file_type_unsupported": "This file type is not supported. Choose text, Docs, Sheets or Slides.",
    "connector.error.drive_file_type_changed": "The file type changed. Reconnect and confirm it again.",
    "connector.error.drive_download_denied": "The file owner does not allow content downloads.",
    "connector.error.drive_content_too_large": "The file exceeds the 1 MB read limit.",
    "connector.linearDetail": "Linear grants read access to the chosen workspace; LISA limits reads to the teams you select. No creation, edits, comments or assignments. Connecting continues this task; a new message cancels unfinished work.",
    "connector.auth.linear": "Sign in to Linear (read only)",
    "connector.linearAuthorize": "Authorize read-only access on Linear, then return here to choose teams.",
    "connector.openLinear": "Open Linear authorization",
    "connector.scope.linear": "LISA can read issues in the selected teams until you disconnect.",
    "connector.error.linear_reauthorization_required": "Linear authorization expired or was removed. Reconnect to continue.",
    "connector.error.linear_read_scope_required": "Only read permission is supported. Reconnect with read-only access.",
    "connector.error.linear_resource_mismatch": "Linear returned data outside the selected team. The result was blocked.",
    "connector.error.mcp_tools_changed": "The remote tools changed. This connector needs a compatibility update.",
    "connector.error.mcp_metadata_mismatch": "The authorization service changed. Connection was stopped.",
    "connector.error.mcp_access_denied": "Linear denied access to this resource. Check the account and selected teams.",
    "connector.error.mcp_unavailable": "Linear is temporarily unavailable. Retry this task.",
    "connector.error.mcp_tool_failed": "Linear could not complete this read. Retry or reconnect.",
    "connector.error.mcp_rate_limited": "Linear is rate limited. Retry later.",
    "connector.auth.gmail": "Sign in to Google for Gmail",
    "connector.auth.freebusy": "Connect primary calendar availability",
    "connector.auth.events": "Connect calendar event details",
    "connector.authorizeDetail": "Sign in and authorize on Google, then return here to select the read scope. Cancelling stops this task.",
    "connector.openGoogle": "Open Google authorization",
    "connector.choose.gmail": "Choose mail labels",
    "connector.choose.google-calendar": "Choose calendars",
    "connector.choose.github": "Choose repositories",
    "connector.choose.google-drive": "Choose files",
    "connector.choose.notion": "Choose pages",
    "connector.choose.slack": "Choose channels",
    "connector.choose.linear": "Choose teams",
    "connector.scope.gmail": "LISA can read message headers and short snippets in the selected labels until you disconnect.",
    "connector.scope.google-calendar": "LISA can read the selected calendars at the access level you granted until you disconnect.",
    "connector.choose.todoist": "Choose projects",
    "connector.choose.outlook-mail": "Choose mail folders",
    "connector.choose.outlook-calendar": "Choose calendars",
    "connector.choose.onedrive": "Choose files and folders",
    "connector.choose.sharepoint": "Choose site files",
    "connector.choose.jira": "Choose projects",
    "connector.choose.confluence": "Choose pages",
    "connector.choose.figma": "Choose designs",
    "connector.choose.dropbox": "Choose files and folders",
    "connector.choose.apple-calendar": "Choose calendars",
    "connector.choose.apple-reminders": "Choose reminder lists",
    "connector.scope.todoist": "LISA can read tasks in the selected projects until you disconnect.",
    "connector.scope.outlook-mail": "LISA can read message subjects and dates in the selected folders until you disconnect.",
    "connector.scope.outlook-calendar": "LISA can read event titles and times in the selected calendars until you disconnect.",
    "connector.scope.onedrive": "LISA can read the selected files and folders until you disconnect.",
    "connector.scope.sharepoint": "LISA can read the selected site files until you disconnect.",
    "connector.scope.jira": "LISA can read issues in the selected projects until you disconnect.",
    "connector.scope.confluence": "LISA can read the selected pages until you disconnect.",
    "connector.scope.figma": "LISA can read layer names and text in the selected designs until you disconnect.",
    "connector.scope.dropbox": "LISA can read the selected files and folders until you disconnect.",
    "connector.scope.apple-calendar": "LISA can read events in the selected calendars until you disconnect.",
    "connector.scope.apple-reminders": "LISA can read reminders in the selected lists until you disconnect.",
    "connector.accountOptions": "Account options",
    "connector.connecting": "Connecting…",
    "connector.selectAll": "Select all",
    "connector.selectLoaded": "Select all loaded",
    "connector.fillSelection": "Fill to {n}",
    "connector.clear": "Clear selection",
    "connector.count": "{n} of {total} selected",
    "connector.countLimited": "{n} selected · limit {total}",
    "connector.loading": "Loading resources…",
    "connector.empty": "No resources available for this account.",
    "connector.retryLoad": "Retry loading",
    "connector.load": "Load more",
    "connector.error.google_client_not_configured": "Google desktop sign-in is not configured. Complete local Google connector setup first.",
    "connector.error.google_desktop_client_required": "Google sign-in configuration is unavailable. Use an OAuth client of type Desktop app.",
    "connector.error.google_reauthorization_required": "Google authorization has expired. Reconnect to continue.",
    "connector.error.google_access_denied": "Google denied access. Check the selected resources, application permissions and enabled APIs.",
    "connector.error.google_scope_required": "This authorization cannot read the requested data. Reconnect with the corresponding read-only access.",
    "connector.error.google_rate_limited": "Google has temporarily limited requests. Try again later.",
    "connector.error.authorization_cancelled": "Authorization was cancelled. You can connect again.",
    "connector.error.google_time_range_required": "Use a date range with a timezone, no longer than 31 days.",
    "github.status.waiting": "Waiting to connect",
    "github.status.authorizing": "Authorizing",
    "github.status.selecting": "Choose repositories to read",
    "github.status.ready": "Connected, waiting to continue",
    "github.status.resuming": "Connected, continuing your task",
    "github.status.completed": "Original task completed",
    "github.status.cancelled": "Task cancelled",
    "github.status.failed": "Needs attention",
    "github.status.expired": "Connection request expired",
    "github.error.github_cli_unavailable": "GitHub CLI was not found. Install gh, then try connecting again.",
    "github.error.github_login_required": "No GitHub login is available on this machine. Choose Sign in to GitHub.",
    "github.error.github_secure_storage_required": "GitHub credentials are not in the system keychain. Fix secure storage for gh, then retry.",
    "github.error.github_reauthorization_required": "Your GitHub login has expired. Please reconnect.",
    "github.error.github_access_denied_or_rate_limited": "GitHub denied access. Check repository permissions or try again later.",
    "github.error.authorization_expired": "Authorization timed out. Please sign in again.",
    "github.error.request_cannot_retry": "This task cannot be retried again. Please send a new request.",
    "github.error.github_repository_unavailable": "This repository could not be read. Check its name and account permissions.",
    "github.error.connector_state_corrupt": "Connection records could not be read. This connection has been stopped.",
    "github.label": "GitHub read-only connection",
    "github.readonly": "Read only",
    "github.detail": "Read projects, commits, issues, pull requests and runs only in your selected repositories. This task continues automatically after connecting; a new message cancels any unfinished task.",
    "github.preview": "This preview uses GitHub CLI login. GitHub may grant that login write access; LISA only allows reads in this flow.",
    "github.retry": "Retry original task",
    "github.reconnect": "Reconnect account",
    "github.existing": "Use local GitHub login",
    "github.login": "Sign in to GitHub",
    "github.authorizeDetail": "Complete authorization on GitHub. Cancelling stops this task from continuing.",
    "github.openDevice": "Open GitHub and enter the code above",
    "connector.scope.github": "LISA can read the selected repositories until you disconnect.",
    "github.switchAccount": "Sign in with another account",
    "github.private": " · Private",
    "github.load": "Load repositories",
    "github.repoPlaceholder": "Or enter owner/repo",
    "github.repoLabel": "Repository name",
    "github.add": "Add repository",
    "github.confirm": "Connect read-only and continue",
    "github.cancel": "Cancel this task",
    "github.disconnect": "Disconnect from LISA",
    "github.selected": "Selected repositories: {n}",
    "github.error.unknown": "The operation did not finish. Please try again later ({code}).",
    'session.new': 'New session',
    'chat.thinking': 'Lisa is thinking',
    'chat.replying': 'Lisa is replying',
    'chat.done': 'Lisa finished replying',
    'chat.failed': 'The request failed',
    'idle.header': 'WHILE YOU WERE AWAY',
    'empty.lead': 'Say anything — or start here:',
    'empty.starter.desire': 'How is "{desire}" going?',
    'empty.starter.open': 'What is on your mind right now?',
    'empty.starter.memory': 'What do you remember about me?',
    'empty.starter.today': 'What should we work on today?',
    'empty.can.tools.k': 'Tools',
    'empty.can.tools.v': 'ask her to read a file, run a command, or look something up on the web.',
    'empty.can.kb.k': 'Knowledge',
    'empty.can.kb.v': 'select any message and save it — she will recall it in later sessions.',
    'empty.can.mail.k': 'Mail',
    'empty.can.mail.v': 'connect a mailbox in the right rail and she triages it for you daily.',
    'rail.toggle': 'Collapse / expand the right panel',
    'rail.toggleAria': 'Toggle right panel',
    'rail.needs.one': '1 agent needs you',
    'rail.needs.many': '{n} agents need you',
    'rail.needs.unit.one': 'agent needs you',
    'rail.needs.unit.many': 'agents need you',
    'rail.needs.open': '{noun} — open the right panel',
    'rail.needs.openAria': '{noun}, open the right panel',
    'birth.err.auth': 'That API key was rejected by the provider. Enter a different one and Lisa will try again.',
    'birth.err.timeout': 'The provider took too long to answer. Nothing was lost — try again.',
    'birth.err.network': 'Could not reach the provider. Check the network on this machine, then try again.',
    'birth.err.rate_limit': 'The provider is rate-limiting this key right now. Wait a minute, then try again.',
    'birth.err.unknown': 'Something went wrong while she was waking up.',
    'birth.cancel': 'Cancel',
    'birth.cancelled': 'Cancelled. Set a key and Lisa will start again.',
    'birth.changeKey': 'Change key',
    'birth.retry': 'Try again',
    'gate.title.set': 'SET · API · KEY',
    'gate.title.change': 'CHANGE · API · KEY',
    'gate.pickProvider': 'Pick a provider.',
    'gate.keyRequired': '{env} is required.',
    'gate.baseUrlRequired': 'A custom endpoint needs its base URL.',
    'gate.saveFailed': 'Save failed: ',
    'gate.alreadySet': ' (configured — a new value replaces it)',
    'gate.getKey': 'Get a key for {label} ↗',
    'gate.providerDefault': 'provider default',
    'gate.unsupported': 'This Lisa did not keep the {label} key — it only accepts Anthropic and OpenAI keys. Update Lisa (npm i -g @oratis/lisa), or add {env}=... to ~/.lisa/config.env and restart.',
    'kb.save': '💾 Save to knowledge base',
    'kb.saving': 'Saving…',
    'kb.saved': 'Saved to knowledge base ✓',
    'kb.exists': 'Already in the knowledge base ✓',
    'kb.failed': 'Save failed',
    'err.request': '⚠ Request failed',
    'err.retry': '↻ Retry',
    'conn.reconnecting': 'reconnecting…',
    'chat.waiting': '⋯ waiting for the backend',
    'copy': 'Copy',
    'copied': 'Copied',
    'copyPath': 'Copy the full path',
    'pair.noExpiry': 'This pairing link carries a device token that does not expire — anyone who gets it can reach this Lisa. Revoke the device in Settings when you are done with it.',
    'control.tools': '{n} tool calls',
    'control.upgrade': 'Show conversations',
    'control.metadata': 'Only session metadata is enabled. Open Control and choose Show conversations to read messages here.',
    'control.enable': 'Show Codex sessions',
    'control.disable': 'Stop showing Codex sessions',
    'control.found': 'Show recent sessions and read their conversations on this computer.',
    'control.window': 'Shows up to 10 Codex sessions updated in the last 30 minutes.',
    'control.missing': 'Start a local Codex session to see it here.',
    'control.empty': 'No recent agent sessions.',
    'control.loadError': 'Could not load sessions. Reopen Control to retry.',
    'control.saveError': 'Could not save the setting. Check agents.json and its permissions, then try again.',
    'sense.noConnector': 'Nothing is published — no social connector is installed.',
    'kbd.switchPlaceholder': 'Switch session…',
    'kbd.noSessions': 'No sessions match.',
    'kbd.title': 'KEYBOARD',
    'kbd.switch': 'Switch session',
    'kbd.focus': 'Focus the composer',
    'kbd.find': 'Find in this conversation',
    'kbd.close': 'Close the switcher, find bar or a panel',
    'kbd.send': 'Send · newline',
    'kbd.help': 'This list',
  },
  'zh-CN': {
    "reve.sessionChanged": "当前会话已切换，请重新选择要回顾的会话。",
    "reve.dreamLog": "梦境记录",
    "reve.pendingNotes": "{n} 条重新考虑请求待处理",
    "reve.corruptDreams": "部分梦境记录暂时无法读取。",
    "reve.noDreams": "这段时间没有近期梦境记录。",
    "reve.revert.memory": "撤销记忆修改",
    "reve.revert.kb": "撤销知识库修改",
    "reve.revert.skills": "撤销技能修改",
    "reve.reconsiderLabel": "请 Lisa 重新考虑对自身记录的修改",
    "reve.sendNote": "提交意见",
    "reve.note.pending": "待处理",
    "reve.note.claimed": "正在考虑",
    "reve.note.delivered": "已回顾",
    "reve.revertsRecorded": "已记录 {n} 次撤销",
    "reve.dreamRestored": "已撤销梦境中的选定修改。",
    "reve.noteQueued": "Lisa 会在下次反思时看到你的意见。",
    "reve.dreamConflict": "后续修改与本次撤销冲突，请检查当前内容。",
    "reve.queueFull": "待处理意见已满，请在 Lisa 回顾后重试。",
    "reve.dreamsDisabled": "当前未启用梦境记录。",
    "reve.dreamActionError": "暂时无法完成此操作。",
    "reve.agentRecap": "Agent 活动回顾",
    "reve.recapHours": "最近 {n} 小时",
    "reve.noRecap": "这段时间没有 Agent 活动。",
    "reve.recapUnavailable": "暂时无法读取 Agent 活动。",
    "reve.conversation.reflection": "会话反思",
    "reve.quiet.time.work": "空闲整理",
    "reve.scheduled.work": "定时工作",
    "reve.a.personal.pursuit": "心愿推进",
    "reve.reviewing.priorities": "心愿回顾",
    "reve.weekly.reflection": "每周回顾",
    "reve.completed": "已完成",
    "reve.no.change.needed": "无需更新",
    "reve.paused.by.a.limit": "达到运行限制",
    "reve.needs.attention": "需要检查",
    "reve.memory.updates": "记忆更新",
    "reve.corrections.removals": "纠正与移除",
    "reve.background.runs": "自主运行",
    "reve.output.tokens": "输出 token",
    "reve.previous.memory.restored": "已恢复先前记忆",
    "reve.memory.updated": "已更新记忆",
    "reve.about.you": "关于你",
    "reve.working.memory": "工作记忆",
    "reve.write.not.confirmed": "写入尚未确认",
    "reve.revision.changeCount": "{n} 项修改",
    "reve.count.updates": "{n} 项更新",
    "reve.some.updates.were.not.applied": "部分修改未写入",
    "reve.open.conversation": "查看会话 →",
    "reve.knowledge.base.information.is.unavailable": "暂时无法读取知识库。",
    "reve.sources": "份来源",
    "reve.wiki.pages": "页知识",
    "reve.worth.tending": "待整理",
    "reve.knowledge.issues": "{n} 个断链 · {n1} 个未关联页面",
    "reve.knowledge.healthy": "索引中没有断链或未关联页面。",
    "reve.knowledge.empty": "添加资料，让知识逐步连成网络。",
    "reve.explore.knowledge.base": "打开知识库 →",
    "reve.needs.you": "需你协助",
    "reve.in.progress": "可自主推进",
    "reve.exploring": "正在关注",
    "reve.in": "输入",
    "reve.out": "输出",
    "reve.hero.eyebrow": "记忆 · 反思 · 生长",
    "reve.hero.title": "让记忆保持准确",
    "reve.hero.description": "看看 Lisa 学到了什么、修正了什么，以及这些记忆从何而来。",
    "reve.proactive.mode.is.on": "自主模式已开启",
    "reve.proactive.mode.is.paused": "自主模式已暂停",
    "reve.overview.partial": "部分内容读取失败，可刷新重试。",
    "reve.while.you.were.away": "你离开时",
    "reve.memory.refined": "记忆的变化",
    "reve.all.memory": "全部记忆 →",
    "reve.revisions.caption": "查看近期修改、原文依据和可恢复的旧版本。",
    "reve.revisions.empty": "这段时间还没有记忆修改。有用的更新会连同来源一起出现在这里。",
    "reve.from.recent.conversations": "对话之后的思考",
    "reve.reflecting": "回顾中…",
    "reve.reflect.on.this.conversation": "回顾当前对话",
    "reve.reflections.empty": "会话反思会记录值得保留的收获。",
    "reve.conversation.reflection.is.disabled.for.this.session": "当前运行未启用会话反思。",
    "reve.connected.knowledge": "知识的连接",
    "reve.on.her.mind": "正在关注",
    "reve.no.active.pursuits.right.now": "暂时没有正在推进的心愿。",
    "reve.kept.close": "带入下次对话",
    "reve.memory.capacityCaption": "精简的事实与偏好随对话载入，详细资料留在知识库。",
    "reve.activity.usage": "运行与消耗",
    "reve.latest.20.runs": "最近 20 次运行",
    "reve.input": "输入",
    "reve.output": "输出",
    "reve.cache.read": "缓存读取",
    "reve.cache.write": "缓存写入",
    "reve.usage.incomplete": "{n} 次记录没有缓存用量，未计入缓存统计。",
    "reve.view.run.history": "查看运行记录",
    "reve.no.background.runs.recorded.in.this.period": "这段时间没有自主运行记录。",
    "reve.history.limits": "原始对话 → 核对记忆 → 连接知识 → 带入下次对话。统计最多覆盖 2,000 次运行、每类记忆 100 个版本；列表显示最近 20 项。原始会话保留。",
    "reve.updated": "更新于 ",
    "reve.overview.loadError": "无法加载 Rêve，请刷新重试。",
    "reve.overview.unavailable": "暂时无法读取内容。",
    "reve.loading.evidence": "正在读取依据…",
    "reve.before": "修改前",
    "reve.empty": "（空）",
    "reve.after": "修改后",
    "reve.user.statement": "用户原话",
    "reve.tool.observation": "工具观察",
    "reve.assistant.message": "助手消息",
    "reve.open.source.conversation": "查看来源会话",
    "reve.restore.the.previous.version": "恢复修改前的版本",
    "reve.restore.unavailable": "后续已有修改，或当前设备只有查看权限，无法恢复此版本。",
    "reve.detail.loadError": "无法读取这次修改，收起后重新展开可重试。",
    "reve.source.openError": "无法打开来源会话。",
    "reve.reflecting.on.the.current.conversation": "正在回顾当前对话…",
    "reve.this.conversation.has.already.been.reviewed": "这段对话已经回顾过。",
    "reve.reflection.invalid": "这次反思未能完成，请重试。",
    "reve.reflection.complete": "回顾完成。",
    "reve.reflection.error": "暂时无法完成反思，请检查模型设置或稍后重试。",
    "reve.restore.success": "已恢复先前记忆，撤销操作也已保存记录。",
    "reve.restore.conflict": "记忆已有新修改，请刷新后再检查。",
    "reve.could.not.restore.this.version": "暂时无法恢复此版本。",
    "reve.memory.reflection": "记忆与反思",
    "reve.period": "时间范围",
    "reve.last.24.hours": "最近 24 小时",
    "reve.last.7.days": "最近 7 天",
    "reve.last.30.days": "最近 30 天",
    "reve.refresh": "刷新",
    "reve.loading": "加载中…",
    "expressions.replay": "重播",
    "expressions.title": "对话表情",
    "expressions.frequency": "表情频率",
    "expressions.note": "历史表情默认静态；切页、离屏会暂停，并遵循减少动态效果设置。",
    "expressions.saved": "已保存",
    "expressions.error": "保存失败，请重试。",
    "expressions.auto": "自动",
    "expressions.static": "仅静态",
    "expressions.emoji": "仅 emoji",
    "expressions.off": "关闭",
    "expressions.restrained": "克制",
    "expressions.lively": "活泼",
    'pty.disabled': '此 Mac 尚未开启交互式 CLI 代理，可以使用内置任务。',
    'pty.missing': '当前安装缺少交互式 CLI 支持，请更新 Lisa。',
    "panel.loading": "正在加载…",
    "panel.failed": "加载失败，请重试。",
    "panel.retry": "重试",
    "panel.refresh": "重新检测",
    "skills.active": "Lisa 可用的技能",
    "skills.empty": "还没有个人或项目技能。可以创建一个，或从下面导入已有工作流。",
    "skills.home": "个人",
    "skills.project": "项目",
    "skills.create": "创建技能",
    "skills.imports": "从其他应用导入",
    "skills.importNote": "选择要复制到 Lisa 的技能，同时保留附带文件。所需工具和服务仍需在 Lisa 中配置。",
    "skills.noImports": "Codex 和 Claude 的技能目录中没有找到兼容技能。",
    "skills.import": "从 {source} 导入 {name}",
    "skills.imported": "已导入 {name}，Lisa 现在可以使用它。",
    "skills.exists": "已添加",
    "skills.name": "名称（小写字母、数字和连字符）",
    "skills.description": "用途说明",
    "skills.instructions": "执行说明",
    "skills.saved": "技能已保存，Lisa 现在可以使用它。",
    "skills.actionFailed": "技能保存失败：{error}",
    "plans.refresh": "重新检测已安装工具",
    'session.rename': '重命名会话',
    'session.name': '会话名称',
    'session.renameHint': '右键重命名',
    'session.save': '保存',
    'session.cancel': '取消',
    'session.invalidName': '请输入 1–120 个字符的名称。',
    'session.renameFailed': '名称保存失败，请重试。',
    'attachment.preview': '预览 {name}',
    'attachment.remove': '移除 {name}',
    'attachment.close': '关闭预览',

    "connector.label": "{name} 只读连接",
    "connector.selectStatus": "选择可读取的范围",
    "connector.gmailDetail": "仅读取你选定标签中的邮件头与有限摘要，不读取完整正文或附件。连接完成后自动继续本条任务；发送新消息会取消未完成的任务。",
    "connector.calendarDetail": "选择仅查看主日历忙闲，或读取选定日历的日程详情。不会创建或修改日程。连接完成后自动继续本条任务；发送新消息会取消未完成的任务。",
    "connector.driveDetail": "Google 授权可读写你选择的文件；LISA 只提供读取，并限制为此卡确认的文件。支持文本、Docs、Slides 和 Sheets 首个工作表，不读取文件夹、PDF 或附件。连接后自动继续原任务。",
    "workspace.renew": "请重新登录以继续这项任务。",
    "workspace.mismatch": "供应商返回的权限与请求不符。请检查此应用的只读权限并重新登录。",
    "workspace.period": "请选择最多 31 天的时间范围。",
    "workspace.type": "请选择小于等于 1 MB 的支持文本文件或一个文件夹。",
    "workspace.changed": "读取期间资源有变化，请重试原任务。",
    "workspace.rate": "服务触发限流，请稍后重试。",
    "workspace.busy": "本机回调端口正在使用。请先完成或取消另一个登录，再重试。",
    "workspace.add": "添加资源",
    "workspace.scope": "{name} 申请 {scope} 权限。LISA 只读取你在此卡确认的资源。",
    "workspace.nativeScope": "macOS 会请求对 {name} 的完全访问。LISA 仅读取你选中的日历或列表。",
    "workspace.login": "登录 {name}",
    "workspace.allow": "在这台 Mac 上授权 {name}",
    "workspace.open": "打开 {name} 授权页",
    "workspace.system": "请在 macOS 系统权限窗口中确认，然后返回此卡。",
    "workspace.return": "完成 {name} 登录后返回此卡。",
    "workspace.invalidId": "请输入有效的资源 ID 或链接。",
    "workspace.id": "{name} 资源 ID",
    "workspace.config": "请在 LISA_WORKSPACE_CLIENTS_FILE 指向的本机私有文件中配置此应用。",
    "workspace.access": "当前账号无法访问所选资源，请检查资源 ID 和权限。",
    "workspace.systemAccess": "请在 macOS「隐私与安全性」中允许访问，然后重新连接。",
    "workspace.platform": "Apple 连接器需要 macOS 14 或更新版本。",
    "workspace.build": "请安装 Xcode 命令行工具以构建本机 EventKit 读取程序。",
    "workspace.unavailable": "此版本的 LISA 不支持 Apple 日历和提醒事项。",
    "connector.slackDetail": "Slack 授予频道名称和历史读取权限；LISA 仅读取你在此确认的频道。不读取私信、共享频道或附件，不发送消息。连接后自动继续原任务。",
    "connector.slackAuthorize": "请在 Slack 授权 LISA read-only，然后返回此卡选择频道。",
    "connector.browse": "浏览应用连接器",
    "connector.pick": "将示例加入草稿",
    "connector.readExamples": "选一个只读任务加入消息，编辑后即可发送。",
    "connector.scope.slack": "LISA 可读取勾选频道内的历史消息，直到你断开连接。",
    "connector.auth.slack": "登录 Slack，只读连接",
    "connector.openSlack": "打开 Slack 授权页面",
    "connector.error.slack_client_not_configured": "请先配置启用 PKCE 和频道读取权限的 Slack 应用。",
    "connector.error.slack_reauthorization_required": "Slack 授权已失效或移除，请重新连接。",
    "connector.error.slack_read_scope_required": "Slack 必须仅授予请求的频道读取权限。",
    "connector.error.slack_channel_unavailable": "频道不可用、已共享、已归档，或你已退出该频道。",
    "connector.error.slack_resource_mismatch": "Slack 返回的内容不属于所选频道或讨论串，已停止返回结果。",
    "connector.error.slack_access_denied": "Slack 拒绝访问，请检查工作区审批和频道成员身份。",
    "connector.error.slack_rate_limited": "Slack 请求过于频繁，请稍后重试。",
    "connector.error.slack_callback_port_in_use": "另一次 Slack 登录正在使用回调端口，请完成或取消后重试。",
    "connector.error.slack_request_failed": "Slack 未能完成此请求，请重试本条任务。",
    "connector.error.slack_response_too_large": "Slack 返回的内容超过读取上限。",
    "connector.error.slack_invalid_time_range": "请选择不超过 31 天的有效时间范围。",
    "connector.error.slack_invalid_thread": "请提供所选频道中的有效讨论串时间戳。",
    "connector.error.slack_invalid_response": "Slack 返回了无法识别的响应，请重试或重新连接。",
    "connector.error.slack_unavailable": "Slack 暂时不可用，请重试本条任务。",
    "connector.notionDetail": "请使用仅有“读取内容”权限的 Notion 连接，再在此卡选择页面。LISA 读取所选页面的普通内容块，不展开子页面、数据库、同步块或附件。连接后自动继续原任务。",
    "connector.driveAuthorize": "请登录 Google 并选择最多 30 个支持的文件，再返回此卡确认。",
    "connector.notionAuthorize": "请在 Notion 授权 LISA read-only，然后返回此卡选择页面。",
    "connector.scope.google-drive": "LISA 可读取勾选的文件，直到你断开连接。展开账号菜单可在 Google 中重新挑选文件。",
    "connector.scope.notion": "LISA 可读取勾选页面内的内容，直到你断开连接。",
    "connector.auth.drive": "登录 Google 并选择文件",
    "connector.auth.notion": "登录 Notion，只读连接",
    "connector.openNotion": "打开 Notion 授权页面",
    "connector.error.notion_client_not_configured": "请先配置仅有“读取内容”权限的 Notion OAuth 应用。",
    "connector.error.notion_reauthorization_required": "Notion 授权已失效，请重新连接。",
    "connector.error.notion_read_scope_required": "Notion 必须仅授予“读取内容”权限，请检查应用能力。",
    "connector.error.notion_page_unavailable": "页面不可用，或已取消对连接的授权。",
    "connector.error.notion_resource_mismatch": "页面内容已移动或权限已变化，请重试。",
    "connector.error.notion_access_denied": "Notion 拒绝访问，请检查页面分享范围及应用权限。",
    "connector.error.notion_rate_limited": "Notion 请求过于频繁，请稍后重试。",
    "connector.error.notion_callback_port_in_use": "Notion 登录回调端口已被占用。请完成或取消另一个 Notion 登录，或释放 Notion 回调地址中的端口后重试。",
    "connector.error.notion_request_failed": "Notion 未能完成此请求，请重试本条任务。",
    "connector.error.notion_response_too_large": "Notion 返回的内容超过 LISA 的读取上限。",
    "connector.error.notion_invalid_response": "Notion 返回了无法识别的响应，请重试或重新连接。",
    "connector.error.notion_unavailable": "Notion 暂时不可用，请重试本条任务。",
    "connector.error.drive_selection_required": "请在 Google 文件选择器中选择支持的文件。",
    "connector.error.drive_selection_limit_exceeded": "所选文件超过 30 个。请重新登录并最多选择 30 个文件。",
    "connector.error.drive_access_denied": "Google Drive 拒绝读取此文件，请检查共享与下载设置。",
    "connector.error.drive_rate_limited": "Google Drive 请求过于频繁，请稍后重试。",
    "connector.error.drive_unavailable": "Google Drive 暂时不可用，请重试本条任务。",
    "connector.error.drive_request_failed": "Google Drive 未能完成此次读取，请重试或重新连接。",
    "connector.error.drive_file_unavailable": "所选 Drive 文件已不可用。",
    "connector.error.drive_file_type_unsupported": "暂不支持此文件类型，请选择文本、Docs、Sheets 或 Slides。",
    "connector.error.drive_file_type_changed": "文件类型已变化，请重新连接并确认。",
    "connector.error.drive_download_denied": "文件所有者不允许下载内容。",
    "connector.error.drive_content_too_large": "文件超过 1 MB 的读取上限。",
    "connector.linearDetail": "Linear 授权覆盖所选工作区，LISA 将读取限制在你选定的团队。不创建、修改、评论或分配任务。连接后自动继续此任务；发送新消息会取消未完成的任务。",
    "connector.auth.linear": "登录 Linear，只读连接",
    "connector.linearAuthorize": "在 Linear 页面授权只读访问，然后返回这里选择团队。",
    "connector.openLinear": "打开 Linear 授权页面",
    "connector.scope.linear": "LISA 可读取勾选团队的工作事项，直到你断开连接。",
    "connector.error.linear_reauthorization_required": "Linear 授权已失效或移除，请重新连接。",
    "connector.error.linear_read_scope_required": "仅支持读取权限，请以只读权限重新授权。",
    "connector.error.linear_resource_mismatch": "Linear 返回的资料不属于所选团队，已停止返回结果。",
    "connector.error.mcp_tools_changed": "远程工具发生变化，需要更新连接器适配。",
    "connector.error.mcp_metadata_mismatch": "授权服务信息发生变化，已停止连接。",
    "connector.error.mcp_access_denied": "Linear 拒绝读取此范围，请检查账号与所选团队。",
    "connector.error.mcp_unavailable": "暂时无法连接 Linear，请重试此任务。",
    "connector.error.mcp_tool_failed": "Linear 未能完成读取，请重试或重新连接。",
    "connector.error.mcp_rate_limited": "Linear 请求过于频繁，请稍后重试。",
    "connector.auth.gmail": "登录 Google，连接 Gmail",
    "connector.auth.freebusy": "连接主日历，只看忙闲",
    "connector.auth.events": "连接日历，读取日程详情",
    "connector.authorizeDetail": "在 Google 页面登录并授权，然后回到这里选择读取范围。取消后不会继续任务。",
    "connector.openGoogle": "打开 Google 授权页面",
    "connector.choose.gmail": "选择可读取的邮件标签",
    "connector.choose.google-calendar": "选择可读取的日历",
    "connector.choose.github": "选择可读取的仓库",
    "connector.choose.google-drive": "选择可读取的文件",
    "connector.choose.notion": "选择可读取的页面",
    "connector.choose.slack": "选择可读取的频道",
    "connector.choose.linear": "选择可读取的团队",
    "connector.scope.gmail": "LISA 可读取勾选标签内的邮件头和摘要，直到你断开连接。",
    "connector.scope.google-calendar": "LISA 将按你授予的权限读取勾选的日历，直到你断开连接。",
    "connector.choose.todoist": "选择可读取的项目",
    "connector.choose.outlook-mail": "选择可读取的邮件文件夹",
    "connector.choose.outlook-calendar": "选择可读取的日历",
    "connector.choose.onedrive": "选择可读取的文件和文件夹",
    "connector.choose.sharepoint": "选择可读取的站点文件",
    "connector.choose.jira": "选择可读取的项目",
    "connector.choose.confluence": "选择可读取的页面",
    "connector.choose.figma": "选择可读取的设计稿",
    "connector.choose.dropbox": "选择可读取的文件和文件夹",
    "connector.choose.apple-calendar": "选择可读取的日历",
    "connector.choose.apple-reminders": "选择可读取的提醒事项列表",
    "connector.scope.todoist": "LISA 可读取勾选项目内的任务，直到你断开连接。",
    "connector.scope.outlook-mail": "LISA 可读取勾选文件夹内邮件的主题和时间，直到你断开连接。",
    "connector.scope.outlook-calendar": "LISA 可读取勾选日历内日程的标题和时间，直到你断开连接。",
    "connector.scope.onedrive": "LISA 可读取勾选的文件和文件夹，直到你断开连接。",
    "connector.scope.sharepoint": "LISA 可读取勾选的站点文件，直到你断开连接。",
    "connector.scope.jira": "LISA 可读取勾选项目内的事务，直到你断开连接。",
    "connector.scope.confluence": "LISA 可读取勾选的页面，直到你断开连接。",
    "connector.scope.figma": "LISA 可读取勾选设计稿中的图层名称和文字，直到你断开连接。",
    "connector.scope.dropbox": "LISA 可读取勾选的文件和文件夹，直到你断开连接。",
    "connector.scope.apple-calendar": "LISA 可读取勾选日历内的日程，直到你断开连接。",
    "connector.scope.apple-reminders": "LISA 可读取勾选列表内的提醒事项，直到你断开连接。",
    "connector.accountOptions": "账号选项",
    "connector.connecting": "正在连接…",
    "connector.selectAll": "全选",
    "connector.selectLoaded": "全选已加载项",
    "connector.fillSelection": "选满 {n} 项",
    "connector.clear": "清空选择",
    "connector.count": "已选 {n} / {total} 项",
    "connector.countLimited": "已选 {n} 项 · 最多 {total} 项",
    "connector.loading": "正在加载…",
    "connector.empty": "此账号暂无可选资源。",
    "connector.retryLoad": "重新加载",
    "connector.load": "加载更多",
    "connector.error.google_client_not_configured": "尚未配置 Google 桌面应用登录，请先完成本机 Google 连接设置。",
    "connector.error.google_desktop_client_required": "Google 登录配置无法使用。请使用桌面应用类型的 OAuth 配置。",
    "connector.error.google_reauthorization_required": "Google 登录已失效，请重新连接。",
    "connector.error.google_access_denied": "Google 拒绝访问，请检查所选范围、应用权限和 API 是否已启用。",
    "connector.error.google_scope_required": "当前授权不足以读取这些内容，请选择相应的只读授权重新连接。",
    "connector.error.google_rate_limited": "Google 暂时限制了请求频率，请稍后重试。",
    "connector.error.authorization_cancelled": "授权已取消，可以重新连接。",
    "connector.error.google_time_range_required": "请使用带时区且不超过 31 天的日期范围。",
    "github.status.waiting": "等待连接",
    "github.status.authorizing": "正在授权",
    "github.status.selecting": "选择可读取的仓库",
    "github.status.ready": "已连接，等待继续",
    "github.status.resuming": "已连接，正在继续原任务",
    "github.status.completed": "原任务已完成",
    "github.status.cancelled": "任务已取消",
    "github.status.failed": "需要处理",
    "github.status.expired": "连接请求已过期",
    "github.error.github_cli_unavailable": "未找到 GitHub CLI。请先安装 gh，再重试连接。",
    "github.error.github_login_required": "本机还没有可用的 GitHub 登录，请选择“登录 GitHub”。",
    "github.error.github_secure_storage_required": "GitHub 凭据未存入系统钥匙串。请修复 gh 的安全存储后重试。",
    "github.error.github_reauthorization_required": "GitHub 登录已失效，请重新连接。",
    "github.error.github_access_denied_or_rate_limited": "GitHub 暂时拒绝访问，请检查仓库权限或稍后重试。",
    "github.error.authorization_expired": "授权已超时，请重新登录。",
    "github.error.request_cannot_retry": "本次任务无法再重试，请重新发送任务。",
    "github.error.github_repository_unavailable": "无法读取这个仓库，请检查仓库名称和账号权限。",
    "github.error.connector_state_corrupt": "连接记录无法读取，当前连接已停止。",
    "github.label": "GitHub 只读连接",
    "github.readonly": "只读",
    "github.detail": "仅在你选定的仓库中读取项目、提交、Issue、PR 和运行记录。连接完成后自动继续本条任务；发送新消息会取消尚未完成的任务。",
    "github.preview": "预览版使用 GitHub CLI 登录。GitHub 授予该登录的权限可能包含写入；LISA 此流程只开放读取。",
    "github.retry": "重试原任务",
    "github.reconnect": "重新连接账号",
    "github.existing": "使用本机 GitHub 登录",
    "github.login": "登录 GitHub",
    "github.authorizeDetail": "请在 GitHub 页面完成授权；取消后不会继续任务。",
    "github.openDevice": "打开 GitHub，输入上方代码",
    "connector.scope.github": "LISA 可读取勾选的仓库，直到你断开连接。",
    "github.switchAccount": "更换账号登录",
    "github.private": " · 私有",
    "github.load": "加载仓库",
    "github.repoPlaceholder": "也可输入 owner/repo",
    "github.repoLabel": "仓库名称",
    "github.add": "添加仓库",
    "github.confirm": "只读连接并继续",
    "github.cancel": "取消此任务",
    "github.disconnect": "断开 LISA 连接",
    "github.selected": "已选 {n} 个仓库",
    "github.error.unknown": "操作未完成，请稍后重试（{code}）。",
    'session.new': '新会话',
    'chat.thinking': 'Lisa 正在思考',
    'chat.replying': 'Lisa 正在回复',
    'chat.done': 'Lisa 回复完成',
    'chat.failed': '请求失败',
    'idle.header': '你不在的时候',
    'empty.lead': '随便说点什么 —— 或者从这里开始：',
    'empty.starter.desire': '“{desire}”进展如何？',
    'empty.starter.open': '你现在在想什么？',
    'empty.starter.memory': '你还记得我的什么？',
    'empty.starter.today': '我们今天做点什么？',
    'empty.can.tools.k': '工具',
    'empty.can.tools.v': '可以让她读文件、执行命令，或者上网查东西。',
    'empty.can.kb.k': '知识库',
    'empty.can.kb.v': '选中任意消息存进去，之后的会话她还会记得。',
    'empty.can.mail.k': '邮件',
    'empty.can.mail.v': '在右栏连接一个邮箱，她每天帮你分拣。',
    'rail.toggle': '收起 / 展开右侧面板',
    'rail.toggleAria': '切换右侧面板',
    'rail.needs.one': '1 个 agent 在等你',
    'rail.needs.many': '{n} 个 agent 在等你',
    'rail.needs.unit.one': '个 agent 在等你',
    'rail.needs.unit.many': '个 agent 在等你',
    'rail.needs.open': '{noun} —— 打开右侧面板',
    'rail.needs.openAria': '{noun}，打开右侧面板',
    'birth.err.auth': '这个 API key 被服务商拒绝了。换一个再试一次。',
    'birth.err.timeout': '服务商响应太慢。什么都没丢，再试一次。',
    'birth.err.network': '连不上服务商。检查这台机器的网络后再试。',
    'birth.err.rate_limit': '这个 key 正在被限流。等一分钟再试。',
    'birth.err.unknown': '她醒来的过程中出了点问题。',
    'birth.cancel': '取消',
    'birth.cancelled': '已取消。填一个 key，Lisa 会重新开始。',
    'birth.changeKey': '更换 key',
    'birth.retry': '重试',
    'gate.title.set': '设 · 置 · KEY',
    'gate.title.change': '更 · 换 · KEY',
    'gate.pickProvider': '先选一个服务商。',
    'gate.keyRequired': '需要填写 {env}。',
    'gate.baseUrlRequired': '自定义端点需要填 base URL。',
    'gate.saveFailed': '保存失败：',
    'gate.alreadySet': '（已配置 —— 填新值会覆盖）',
    'gate.getKey': '去申请 {label} 的 key ↗',
    'gate.providerDefault': '服务商默认',
    'gate.unsupported': '这个 Lisa 没有保存 {label} 的 key —— 它只接受 Anthropic 和 OpenAI 的 key。请升级 Lisa（npm i -g @oratis/lisa），或者把 {env}=... 写进 ~/.lisa/config.env 后重启。',
    'kb.save': '💾 存入知识库',
    'kb.saving': '保存中…',
    'kb.saved': '已存入知识库 ✓',
    'kb.exists': '已在知识库 ✓',
    'kb.failed': '保存失败',
    'err.request': '⚠ 请求出错',
    'err.retry': '↻ 重试',
    'conn.reconnecting': '重新连接…',
    'chat.waiting': '⋯ 正在等待后端',
    'copy': '复制',
    'copied': '已复制',
    'copyPath': '复制完整路径',
    'pair.noExpiry': '这个配对链接里的设备令牌不会过期 —— 拿到它的人就能连上这个 Lisa。用完之后请在 Settings 里吊销该设备。',
    'control.tools': '{n} 次工具调用',
    'control.upgrade': '显示对话内容',
    'control.metadata': '当前只显示会话信息。打开 Control，选择「显示对话内容」即可查看消息。',
    'control.enable': '显示 Codex 会话',
    'control.disable': '停止显示 Codex 会话',
    'control.found': '已检测到本机 Codex 会话，开启后可在此查看近期对话。',
    'control.window': '显示最近 30 分钟内更新的 Codex 会话，最多 10 个。',
    'control.missing': '在本机启动一个 Codex 会话后，即可在这里连接。',
    'control.empty': '暂无近期的智能体会话。',
    'control.loadError': '会话加载失败，请重新打开 Control 重试。',
    'control.saveError': '保存失败。请检查 agents.json 的格式和文件权限，再试一次。',
    'sense.noConnector': '没有发布任何内容 —— 尚未安装社交连接器。',
    'kbd.switchPlaceholder': '切换会话…',
    'kbd.noSessions': '没有匹配的会话。',
    'kbd.title': '快捷键',
    'kbd.switch': '切换会话',
    'kbd.focus': '聚焦输入框',
    'kbd.find': '在当前对话中查找',
    'kbd.close': '关闭切换器、查找栏或面板',
    'kbd.send': '发送 · 换行',
    'kbd.help': '这个列表',
  },
};
const LISA_LOCALE = (function () {
  var l = String((navigator && navigator.language) || 'en').toLowerCase();
  return l.indexOf('zh') === 0 ? 'zh-CN' : 'en';
})();
// The document ships as lang="en"; correct it so screen readers and hyphenation
// follow the language actually rendered.
try { document.documentElement.lang = LISA_LOCALE; } catch (e) {}
// Named tr(), not t(): "t" is already a local variable in twenty places in
// this file (const t = e.target, const t = await res.text(), …) and one of
// them — sessionLabel — shadowed the helper into a string.
function tr(key, vars) {
  var table = LISA_STRINGS[LISA_LOCALE] || LISA_STRINGS.en;
  var s = table[key];
  if (s == null) s = LISA_STRINGS.en[key];
  if (s == null) return key;
  if (vars) {
    for (var k in vars) s = s.split('{' + k + '}').join(String(vars[k]));
  }
  return s;
}

const log = document.getElementById('log');
const input = document.getElementById('input');
const form = document.getElementById('form');
const sendBtn = document.getElementById('sendBtn');
const sessionEl = document.getElementById('sessionId');
const fileInput = document.getElementById('fileInput');
const attachPreview = document.getElementById('attachPreview');

// ── Attached files state ──────────────────────────────────────────
let pendingFiles = []; // Array of {name, mediaType, data (base64)}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // readAsDataURL always yields a string; FileReader.result is typed
      // string|ArrayBuffer because readAsArrayBuffer shares the field.
      const dataUrl = String(reader.result);
      const base64 = dataUrl.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function inferMediaType(file) {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop().toLowerCase();
  // Only the image types the model accepts as image blocks; anything else
  // would turn a send into a provider error.
  const map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain', md: 'text/plain', csv: 'text/csv', json: 'application/json' };
  return map[ext] || 'application/octet-stream';
}

// ── Vision: screenshot → composer ──────────────────────────────────
// lisaAttachImage adds an already-encoded {name,mediaType,data} object to
// the pending attachments — used by both the in-page 📷 button and the
// native global hotkey (Lisa.app calls lisaCaptureAndAttach via JS bridge).
window.lisaAttachImage = function (file) {
  if (!file || !file.data) return;
  pendingFiles.push({
    name: file.name || 'screenshot.png',
    mediaType: file.mediaType || 'image/png',
    data: file.data,
  });
  renderAttachPreview();
  try { input.focus(); } catch (_) {}
};

// lisaPrefillComposer drops text into the composer WITHOUT sending — the user
// reads it and hits Enter to send (that send is the confirmation). Used by the
// island's screen-advisor "Optimize ▸" card (via the Swift bridge) and by the
// ?prefill= URL param (plain browser tabs).
window.lisaPrefillComposer = function (text) {
  if (!text || !input) return;
  input.value = String(text);
  try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
  try { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } catch (_) {}
};

// On load, honour ?prefill=… (the island opens /?prefill=<task> in a browser
// tab). Strip it from the URL afterwards so a refresh doesn't re-fill.
try {
  var _pf = new URLSearchParams(location.search).get('prefill');
  if (_pf) {
    window.lisaPrefillComposer(_pf);
    history.replaceState(null, '', location.pathname);
  }
} catch (_) {}

// Room (#viewRoom iframe) → parent GUI actions. Keeps every room interaction
// in-client (this WKWebView) — never a browser window. Same-origin guarded so
// only our own room frame can drive view switches / composer prefill.
window.addEventListener('message', function (e) {
  if (e.origin !== location.origin) return;
  var d = e && e.data;
  if (!d || d.type !== 'lisa-room') return;
  switch (d.action) {
    case 'open-chat':
      if (d.prefill) { try { window.lisaPrefillComposer(d.prefill); } catch (_) {} }
      try { window.lisaShowView('chat'); } catch (_) {}
      break;
    case 'switch-view':
      if (d.view) { try { window.lisaShowView(d.view); } catch (_) {} }
      break;
  }
});

// lisaCaptureAndAttach asks the server to run a screen capture, then
// attaches the result. mode: 'interactive' (crosshair, default) | 'full'.
// Returns true if an image was attached, false if cancelled/failed.
// Exposed on window so the native app's global hotkey can invoke it.
let capturing = false;
window.lisaCaptureAndAttach = async function (mode) {
  if (capturing) return false;
  capturing = true;
  const btn = document.getElementById('plusBtn');
  if (btn) btn.classList.add('flash');
  try {
    const res = await fetch('/api/vision/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: mode || 'interactive' }),
    });
    if (!res.ok) {
      console.warn('[vision] capture failed: HTTP ' + res.status);
      return false;
    }
    const data = await res.json();
    if (data.cancelled || !data.file) return false;
    window.lisaAttachImage(data.file);
    return true;
  } catch (err) {
    console.warn('[vision] capture error:', err);
    return false;
  } finally {
    capturing = false;
    if (btn) setTimeout(() => btn.classList.remove('flash'), 200);
  }
};

// One object URL per pending image, shared by its thumbnail and the viewer and
// released once the file leaves the composer: re-rendering the chips never
// decodes the base64 again, and a removed or sent image is not kept alive.
const attachmentUrls = new Map();
// The chat request itself is capped at 20 MiB, so a larger image can never be
// sent; it gets a plain chip instead of being decoded for a thumbnail.
const ATTACHMENT_PREVIEW_MAX_BASE64 = 20 * 1024 * 1024;
function attachmentPreviewUrl(f) {
  const known = attachmentUrls.get(f);
  if (known) return known;
  if (typeof f.data !== 'string' || f.data.length > ATTACHMENT_PREVIEW_MAX_BASE64) return '';
  let url;
  try {
    const binary = atob(f.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    url = URL.createObjectURL(new Blob([bytes], { type: f.mediaType }));
  } catch (e) { return ''; }
  attachmentUrls.set(f, url);
  return url;
}
function releaseAttachmentPreviews() {
  for (const [f, url] of attachmentUrls) {
    if (pendingFiles.includes(f)) continue;
    URL.revokeObjectURL(url);
    attachmentUrls.delete(f);
  }
}
function renderAttachPreview() {
  releaseAttachmentPreviews();
  attachPreview.innerHTML = '';
  pendingFiles.forEach((f, i) => {
    const chip = document.createElement('span');
    chip.className = 'attach-chip';
    chip.title = f.name;
    const previewUrl = /^image\/[a-z0-9.+-]+$/i.test(f.mediaType) ? attachmentPreviewUrl(f) : '';
    if (previewUrl) {
      chip.classList.add('attach-image');
      const preview = document.createElement('button');
      preview.type = 'button';
      preview.className = 'attach-open';
      preview.setAttribute('aria-label', tr('attachment.preview', { name: f.name }));
      const img = document.createElement('img');
      img.src = previewUrl;
      img.alt = f.name;
      img.onerror = () => { chip.classList.add('image-unavailable'); };
      preview.appendChild(img);
      preview.onclick = () => showAttachmentImage(f);
      chip.appendChild(preview);
    }
    const name = document.createElement('span');
    name.className = 'attach-name';
    name.textContent = f.name;
    chip.appendChild(name);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'attach-rm';
    rm.textContent = '×';
    rm.setAttribute('aria-label', tr('attachment.remove', { name: f.name }));
    rm.title = tr('attachment.remove', { name: f.name });
    rm.onclick = () => {
      pendingFiles.splice(i, 1);
      renderAttachPreview();
      const buttons = attachPreview.querySelectorAll('.attach-rm');
      if (buttons.length) buttons[Math.min(i, buttons.length - 1)].focus();
      // On a phone, focusing the composer would summon the keyboard.
      else if (!window.matchMedia('(max-width: 720px)').matches) input.focus();
    };
    chip.appendChild(rm);
    attachPreview.appendChild(chip);
  });
}

function showAttachmentImage(file) {
  const src = attachmentPreviewUrl(file);
  if (!src) return;
  const viewer = document.createElement('dialog');
  viewer.className = 'attachment-viewer';
  viewer.setAttribute('aria-label', tr('attachment.preview', { name: file.name }));
  const header = document.createElement('div');
  header.className = 'attachment-viewer-head';
  const name = document.createElement('span');
  name.textContent = file.name;
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', tr('attachment.close'));
  close.onclick = () => viewer.close();
  header.append(name, close);
  const img = document.createElement('img');
  img.src = src;
  img.alt = file.name;
  viewer.append(header, img);
  viewer.addEventListener('click', (event) => { if (event.target === viewer) viewer.close(); });
  viewer.addEventListener('close', () => viewer.remove());
  document.body.appendChild(viewer);
  viewer.showModal();
}

fileInput.addEventListener('change', async () => {
  for (const file of fileInput.files) {
    const data = await readFileAsBase64(file);
    pendingFiles.push({ name: file.name, mediaType: inferMediaType(file), data });
  }
  fileInput.value = '';
  renderAttachPreview();
});

// The natural <label>→<input type=file> click-forwarding is supposed
// to open the picker without any JS. But in WKWebView under our
// layout it never reaches runOpenPanel. We add an explicit click
// listener that forwards the click synchronously (preserving the
// user-gesture context) and logs to console so we can verify in the
// inspector if it ever silently no-ops again.
// ── ＋ composer menu: merges 📎 attach + 📷 screenshot into one button ──
const plusBtnEl = document.getElementById('plusBtn');
const plusMenuEl = document.getElementById('plusMenu');
function closePlusMenu() { if (plusMenuEl) plusMenuEl.classList.remove('open'); }
if (plusBtnEl && plusMenuEl) {
  plusBtnEl.addEventListener('click', (e) => { e.stopPropagation(); plusMenuEl.classList.toggle('open'); });
  document.addEventListener('click', (e) => {
    if (plusMenuEl.classList.contains('open') && !plusMenuEl.contains(e.target) && e.target !== plusBtnEl) closePlusMenu();
  });
}
const pmAttachEl = document.getElementById('pmAttach');
if (pmAttachEl) {
  pmAttachEl.addEventListener('click', () => {
    closePlusMenu();
    try { fileInput.click(); } catch (err) { console.error('[attach] fileInput.click failed:', err); }
  });
}
const pmShotEl = document.getElementById('pmShot');
if (pmShotEl) {
  pmShotEl.addEventListener('click', () => { closePlusMenu(); void window.lisaCaptureAndAttach('interactive'); });
}

// ── Audio recording → transcribe → Lisa summarizes ─────────────────
// 🎙 toggles a MediaRecorder. On stop: POST the clip to /api/voice/transcribe
// (server-side Whisper), then send the transcript into the normal chat with a
// "summarize this" framing — so Lisa produces the summary in her own voice and
// it's persisted + discussable like any turn. First click prompts mic
// permission (browser-native).
const recordBtnEl = document.getElementById('recordBtn');
let mediaRecorder = null;
let recordedChunks = [];
let recordStream = null;
// 'dictation' (default): polish speech → composer for you to edit + send.
// 'summary' (long-press 🎙): the original record→Lisa-summarizes flow.
let recordMode = 'dictation';

function pickAudioMime() {
  const prefs = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const m of prefs) {
    try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; } catch (_) {}
  }
  return '';
}

async function startRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    el('div', 'err', '[voice] recording not supported in this browser');
    return;
  }
  try {
    recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    el('div', 'err', '[voice] microphone access denied or unavailable');
    return;
  }
  const mimeType = pickAudioMime();
  recordedChunks = [];
  mediaRecorder = mimeType ? new MediaRecorder(recordStream, { mimeType }) : new MediaRecorder(recordStream);
  mediaRecorder.addEventListener('dataavailable', (e) => { if (e.data && e.data.size > 0) recordedChunks.push(e.data); });
  mediaRecorder.addEventListener('stop', () => { void finishRecording(); });
  mediaRecorder.start();
  if (recordBtnEl) { recordBtnEl.classList.add('recording'); recordBtnEl.textContent = '⏹'; recordBtnEl.title = 'Stop recording'; }
}

function stopRecordingTracks() {
  if (recordStream) { recordStream.getTracks().forEach((t) => t.stop()); recordStream = null; }
  if (recordBtnEl) { recordBtnEl.classList.remove('recording'); recordBtnEl.textContent = '🎙'; recordBtnEl.title = 'Dictate — speak and Lisa drops polished text in the box (hold to record a summary)'; }
}

async function finishRecording() {
  const mime = (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm';
  stopRecordingTracks();
  const mode = recordMode;
  const blob = new Blob(recordedChunks, { type: mime });
  recordedChunks = [];
  if (blob.size === 0) return;
  // Transient status line: dictation polishes; summary transcribes.
  const pending = el('div', 'thinking', mode === 'dictation' ? '⋯ transcribing + polishing' : '⋯ transcribing recording');
  try {
    const data = await blobToBase64(blob);
    const res = await fetch('/api/voice/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data, mediaType: mime, mode }),
    });
    const out = await res.json();
    if (pending) pending.remove();
    if (!res.ok || out.error) {
      el('div', 'err', '[voice] ' + (out.error || ('HTTP ' + res.status)));
      return;
    }
    if (mode === 'dictation') {
      // Typeless-style: drop the polished text into the composer (cursor at end)
      // for you to review and send. Never auto-sends. Appends if you'd already
      // started typing.
      const text = (out.text || out.transcript || '').trim();
      if (!text) { el('div', 'err', '[voice] (nothing dictated)'); return; }
      const existing = input.value.trimEnd();
      input.value = existing ? existing + '\n' + text : text;
      try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
      try { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } catch (_) {}
      return;
    }
    // summary mode: hand the transcript to Lisa with a summarize framing.
    const transcript = (out.transcript || '').trim();
    if (!transcript) { el('div', 'err', '[voice] (empty transcript)'); return; }
    const framed =
      "I just recorded some audio. Here's the transcript — please give me a clear, " +
      "useful summary (key points, decisions, action items if any), then I might ask follow-ups.\n\n" +
      "--- transcript ---\n" + transcript;
    send(framed);
  } catch (err) {
    if (pending) pending.remove();
    el('div', 'err', '[voice] ' + (err && err.message ? err.message : 'transcription failed'));
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

if (recordBtnEl) {
  // Short click → dictation (polished text into the composer). Press-and-hold
  // (≥500ms) → summary (record → Lisa summarizes). A click always follows
  // pointerup, so we just flag long-presses and read the flag on click.
  let longPress = false;
  let holdTimer = null;
  const clearHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };
  recordBtnEl.addEventListener('pointerdown', () => {
    longPress = false;
    clearHold();
    holdTimer = setTimeout(() => { longPress = true; }, 500);
  });
  recordBtnEl.addEventListener('pointerup', clearHold);
  recordBtnEl.addEventListener('pointercancel', clearHold);
  recordBtnEl.addEventListener('pointerleave', clearHold);
  recordBtnEl.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      longPress = false;
      return;
    }
    recordMode = longPress ? 'summary' : 'dictation';
    longPress = false;
    if (recordBtnEl) recordBtnEl.title = recordMode === 'summary' ? 'Recording for summary — click to stop' : 'Dictating — click to stop';
    void startRecording();
  });
}

// (📎 attach is now an item in the ＋ composer menu — see pmAttach above.)

// Paste-to-attach: when the user has copied an image (screenshot,
// image from a webpage, etc.) and presses ⌘V, pull the image off the
// clipboard and add it to pendingFiles — same path the file picker
// uses. Plain-text paste falls through to default behavior.
//
// We listen at the DOCUMENT level so paste works whether the textarea
// is focused, the chat log is focused, or focus is on a tool-block.
// (Some users press ⌘V right after launching the app, before clicking
// anywhere — element-scoped handlers miss that.)
//
// For text paste we MUST NOT preventDefault — let the browser route
// it to the focused element. Only intercept when we detect image
// items.
async function handlePastedClipboard(ev) {
  const cb = ev.clipboardData;
  if (!cb) return;

  // Two clipboard surfaces — items (modern, exposes pasteboard files)
  // and files (older, doesn't include MIME type for some types). We
  // dedupe via the underlying File reference.
  const fileMap = new Map();  // File → mediaType (string)
  if (cb.items && cb.items.length) {
    for (const item of cb.items) {
      if (item.kind !== 'file') continue;
      if (!item.type || !item.type.startsWith('image/')) continue;
      const f = item.getAsFile();
      if (f) fileMap.set(f, item.type);
    }
  }
  if (cb.files && cb.files.length) {
    for (const f of cb.files) {
      if (f.type && f.type.startsWith('image/')) {
        if (!fileMap.has(f)) fileMap.set(f, f.type || 'image/png');
      }
    }
  }

  if (fileMap.size === 0) return; // text paste — leave default behavior alone

  ev.preventDefault();
  // Keep focus on the textarea so the user can keep typing right after.
  try { input.focus(); } catch (_) {}

  for (const [file, mediaType] of fileMap) {
    try {
      const data = await readFileAsBase64(file);
      const ext = (mediaType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const name = file.name && file.name !== 'image.png'
        ? file.name
        : 'pasted-' + ts + '.' + ext;
      pendingFiles.push({ name, mediaType, data });
    } catch (err) {
      console.warn('[paste] failed to read image:', err);
    }
  }
  renderAttachPreview();
}

input.addEventListener('paste',  (ev) => { void handlePastedClipboard(ev); });
// Document-level fallback. If focus is somewhere other than the
// textarea (e.g. just-launched, no focus yet), the textarea-level
// paste listener never fires; this one catches it.
document.addEventListener('paste', (ev) => {
  // Avoid double-firing when the textarea ALREADY handled it: if
  // ev.defaultPrevented is set, the textarea listener already
  // consumed the paste and added the file.
  if (ev.defaultPrevented) return;
  void handlePastedClipboard(ev);
});

// Surface session id from server header on first request. The titlebar
// shows the same id with a leading "·" separator after the "Lisa" label.
// Session switching (PLAN_UI_SESSION_SHELL_v1.0): the active id is tracked
// here; lisaSetActiveSession is the one entry point every switch path uses —
// tree clicks, tab clicks, ＋New, and the session_switched SSE frame from
// another window — so they all converge on the same reload behavior.
let activeSessionId = null;
function setActiveSessionUI(id) {
  activeSessionId = id;
  window.lisaActiveSessionId = id;
  sessionEl.textContent = id;
  updateTitlebarSession();
  void githubRefresh();
}
// UX-4: the title bar used to read "Lisa · 20260905-220846-9f7d58". It shows
// the session's human label now ("New session · just now" until the first
// message names it) and keeps the id in the tooltip, so the id is still one
// hover away for anyone matching it against ~/.lisa/sessions.
function updateTitlebarSession() {
  const tag = document.getElementById('titlebarSession');
  if (!tag) return;
  const id = window.lisaActiveSessionId;
  if (!id) { tag.textContent = ''; tag.title = ''; return; }
  const label = (typeof window.lisaSessionLabel === 'function' && window.lisaSessionLabel(id)) || id;
  tag.textContent = '· ' + label;
  tag.title = id;
}
window.lisaUpdateTitlebar = updateTitlebarSession;
window.lisaSetActiveSession = function (id) {
  if (!id || id === activeSessionId) return;
  setActiveSessionUI(id);
  if (typeof window.lisaClearUnread === 'function') window.lisaClearUnread(id);
  if (typeof window.lisaResetChatLog === 'function') window.lisaResetChatLog();
  if (typeof window.lisaRenderSessionTree === 'function') window.lisaRenderSessionTree();
};
fetch('/session').then(r => r.json()).then(s => {
  setActiveSessionUI(s.id);
  if (typeof window.lisaRenderSessionTree === 'function') window.lisaRenderSessionTree();
});

// ── While-you-were-away idle note: shared card builder + localized label ──
// Idle reflections render as a distinct card — never a plain Lisa bubble — so
// they don't blend into her actual replies, both live (SSE) and on history
// reload. The label follows the UI language; the note body is already written
// in the user's language by the idle runner.
function idleHeaderLabel() {
  // ja/ko are not in the string table (this pass only added en + zh-CN) but
  // the idle card already had them — keep them rather than regress.
  var l = String((navigator && navigator.language) || 'en').toLowerCase();
  if (l.indexOf('ja') === 0) return '不在のあいだに';
  if (l.indexOf('ko') === 0) return '자리를 비운 사이';
  return tr('idle.header');
}
function buildIdleBlock(text, at) {
  const block = document.createElement('div');
  block.className = 'idle-block';
  const head = document.createElement('div');
  head.className = 'idle-head';
  head.textContent = '★ ' + idleHeaderLabel();
  if (at) {
    const time = document.createElement('span');
    time.className = 'idle-time';
    try { time.textContent = new Date(at).toLocaleTimeString(); } catch (e) {}
    head.appendChild(time);
  }
  block.appendChild(head);
  const bodyEl = document.createElement('div');
  // Idle notes are Lisa's own reflections → render their Markdown too.
  bodyEl.innerHTML = renderMarkdown(text);
  block.appendChild(bodyEl);
  return block;
}

// ── Connection state (UX-10) ──────────────────────────────────────
// A slow or wedged backend used to be completely invisible: the UI only said
// anything once a request failed outright, so the in-between (5s+ stalls seen
// on the daily driver) looked like nothing happening. This surfaces it.
//
// Note on the heartbeat contract: the server sends ": ping" SSE comments, and
// EventSource does NOT surface comments to JS at all — they keep the socket
// warm but fire no event. So liveness here is: readyState (authoritative for
// a closed/reconnecting stream) plus, for the half-open case where the socket
// still claims OPEN but nothing has arrived for 45s, one direct /health probe
// rather than a guess.
const CONN_QUIET_MS = 45_000;
let connLastBytesAt = Date.now();
let connProbeAt = 0;
let connCurrentEs = null;
function setConnPill(on) {
  const pill = document.getElementById('connPill');
  if (!pill) return;
  if (on && pill.hidden) pill.textContent = tr('conn.reconnecting');
  pill.hidden = !on;
}
function noteEventBytes() {
  connLastBytesAt = Date.now();
  setConnPill(false);
}
async function checkConnection() {
  const es = connCurrentEs;
  // 0 = CONNECTING (the browser is retrying), 2 = CLOSED.
  if (!es || es.readyState !== 1) { setConnPill(true); return; }
  if (Date.now() - connLastBytesAt < CONN_QUIET_MS) return;
  if (Date.now() - connProbeAt < 30_000) return;
  connProbeAt = Date.now();
  try {
    const ctl = new AbortController();
    const to = setTimeout(function () { ctl.abort(); }, 4000);
    const r = await fetch('/health', { signal: ctl.signal });
    clearTimeout(to);
    if (r && r.ok) { noteEventBytes(); return; }
  } catch (e) {}
  setConnPill(true);
}
setInterval(checkConnection, 5000);

// ── Persistent /events SSE: mood updates + idle messages + Claude
// activity, lifetime of page.
function connectEvents() {
  const es = new EventSource('/events');
  connCurrentEs = es;
  es.addEventListener('open', noteEventBytes);
  let idlePulseEl = null;
  es.addEventListener('message', (e) => {
    noteEventBytes();
    const ev = JSON.parse(e.data);
    if (ev.type === 'github_connection_changed' || ev.type === 'connector_connection_changed') {
      if (ev.sessionId === window.lisaActiveSessionId) void githubRefresh();
      else if (typeof window.lisaMarkUnread === 'function') window.lisaMarkUnread(ev.sessionId);
    } else if (ev.type === 'mood') {
      setMood(ev.slug);
    } else if (ev.type === 'idle_start') {
      if (!idlePulseEl) {
        idlePulseEl = document.createElement('div');
        idlePulseEl.className = 'idle-pulse';
        idlePulseEl.textContent = '⋯ Lisa is thinking on her own time ⋯';
        removeChatEmpty();
        log.appendChild(idlePulseEl);
        log.scrollTop = log.scrollHeight;
      }
    } else if (ev.type === 'idle_message') {
      if (idlePulseEl) { idlePulseEl.remove(); idlePulseEl = null; }
      removeChatEmpty();
      log.appendChild(buildIdleBlock(ev.text, ev.at));
      log.scrollTop = log.scrollHeight;
      // sidebar reflection card mirrors the latest while-you-were-away
      if (typeof updateReflection === 'function') updateReflection(ev.text);
    } else if (ev.type === 'idle_done') {
      if (idlePulseEl) { idlePulseEl.remove(); idlePulseEl = null; }
    } else if (ev.type === 'idle_error') {
      if (idlePulseEl) { idlePulseEl.remove(); idlePulseEl = null; }
      const e2 = document.createElement('div');
      e2.className = 'err';
      e2.textContent = '[idle error] ' + ev.message;
      removeChatEmpty();
      log.appendChild(e2);
    } else if (ev.type === 'agent_session_update') {
      // D4a — sidebar multi-agent monitor refresh (defined later in the
      // "sidebar live wiring" block). Generalized from claude_session_update
      // so codex / opencode / git / … sessions update the sidebar too.
      if (typeof refreshClaudeSessions === 'function') refreshClaudeSessions();
    } else if (ev.type === 'session_renamed') {
      if (typeof window.lisaSessionRenamed === 'function') window.lisaSessionRenamed(ev);
    } else if (ev.type === 'session_switched') {
      // Another window (or this one) moved the active web session — converge.
      if (typeof window.lisaSetActiveSession === 'function') window.lisaSetActiveSession(ev.session);
    } else if (ev.type === 'focus_session') {
      // F5 island deep link — select an agent session in the tree/inspector.
      if (typeof window.lisaFocusAgent === 'function') window.lisaFocusAgent(ev.agent, ev.session);
    } else if (ev.type === 'chat_end') {
      // A turn just finished (any window/session) — the ledger moved.
      if (typeof window.refreshTokens === 'function') window.refreshTokens();
    } else if (ev.type === 'mail_digest_update' || ev.type === 'mail_accounts_update') {
      if (typeof window.refreshMail === 'function') window.refreshMail();
    } else if (ev.type === 'approval_requested') {
      // Warden (W2a): a tool call is waiting for the user's answer.
      if (typeof window.lisaApprovalRequested === 'function') window.lisaApprovalRequested(ev);
    } else if (ev.type === 'approval_resolved') {
      if (typeof window.lisaApprovalResolved === 'function') window.lisaApprovalResolved(ev);
    }
  });
  es.onerror = () => {
    es.close();
    setConnPill(true);
    setTimeout(connectEvents, 3000); // reconnect
  };
}
connectEvents();

// ── Providers ────────────────────────────────────────────────────
// The gate and the Settings view both drive off one table. A new server
// reports it on /api/config/status as
//   providers: [{id, envKey, label, modelPrefixes, configured}]
// plus a top-level "model"; this list is the fallback for servers that do not,
// and it also supplies the parts the server has no opinion on (placeholder,
// console link, a suggested model). Entries mirror src/providers/registry.ts.
const LISA_PROVIDER_FALLBACK = [
  { id: 'anthropic', envKey: 'ANTHROPIC_API_KEY', label: 'Anthropic (Claude)',
    placeholder: 'sk-ant-...', model: 'claude-sonnet-4-6',
    consoleUrl: 'https://console.anthropic.com/' },
  { id: 'openai', envKey: 'OPENAI_API_KEY', label: 'OpenAI (GPT)',
    placeholder: 'sk-...', model: 'gpt-4o',
    consoleUrl: 'https://platform.openai.com/api-keys' },
  { id: 'deepseek', envKey: 'DEEPSEEK_API_KEY', label: 'DeepSeek',
    placeholder: 'sk-...', model: 'deepseek-chat',
    consoleUrl: 'https://platform.deepseek.com/api_keys', needsModel: true },
  { id: 'zhipu', envKey: 'ZHIPU_API_KEY', label: 'Zhipu GLM',
    placeholder: 'key...', model: 'glm-4-plus',
    consoleUrl: 'https://open.bigmodel.cn/usercenter/apikeys', needsModel: true },
  { id: 'dashscope', envKey: 'DASHSCOPE_API_KEY', label: 'Aliyun Qwen',
    placeholder: 'sk-...', model: 'qwen-plus',
    consoleUrl: 'https://bailian.console.aliyun.com/', needsModel: true },
  { id: 'moonshot', envKey: 'MOONSHOT_API_KEY', label: 'Moonshot Kimi',
    placeholder: 'sk-...', model: 'moonshot-v1-32k',
    consoleUrl: 'https://platform.moonshot.cn/console/api-keys', needsModel: true },
  { id: 'gemini', envKey: 'GEMINI_API_KEY', label: 'Google Gemini',
    placeholder: 'AIza...', model: 'gemini-2.5-pro',
    consoleUrl: 'https://aistudio.google.com/apikey', needsModel: true },
  { id: 'custom', envKey: 'LISA_API_KEY', label: 'Custom (OpenAI-compatible)',
    placeholder: 'key...', model: '', custom: true, consoleUrl: '', needsModel: true },
];
// Merge what the server knows (which keys exist, which are configured) with
// the local presentation hints. Matching on envKey first: ids are the server's
// to choose, the environment variable name is the stable identity.
// Shape of a fallback-table row, for providers the server reports that this
// client has no hints for. Spelling the keys out (rather than {}) keeps the
// merge below readable and type-checkable.
const EMPTY_PROVIDER_HINT = {
  id: '', envKey: '', label: '', placeholder: '', model: '',
  consoleUrl: '', custom: false, needsModel: false,
};
function lisaProviderList(status) {
  const hintOf = function (envKey, id) {
    for (let i = 0; i < LISA_PROVIDER_FALLBACK.length; i++) {
      const h = LISA_PROVIDER_FALLBACK[i];
      if (h.envKey === envKey || (id && h.id === id)) return h;
    }
    return null;
  };
  const served = status && Array.isArray(status.providers) ? status.providers : null;
  if (!served || !served.length) {
    // No providers block: an older server. Mark configured from the two
    // booleans it does report.
    return LISA_PROVIDER_FALLBACK.map(function (h) {
      const conf = h.envKey === 'ANTHROPIC_API_KEY' ? !!(status && status.anthropic)
        : h.envKey === 'OPENAI_API_KEY' ? !!(status && status.openai) : false;
      return { id: h.id, envKey: h.envKey, label: h.label, placeholder: h.placeholder,
               model: h.model, consoleUrl: h.consoleUrl, custom: !!h.custom,
               needsModel: !!h.needsModel, configured: conf, served: false };
    });
  }
  const merged = served.map(function (p) {
    const h = hintOf(p.envKey, p.id) || EMPTY_PROVIDER_HINT;
    // needsModel comes from the SERVED row, not the hint table. Deriving it
    // from local hints meant every provider this client has no hint for (Grok,
    // Mistral, Perplexity, Ark, MiniMax, Hunyuan…) silently reported
    // needsModel:false: the gate then saved a key with no LISA_MODEL, the
    // server kept routing to Claude, and the user was told they were
    // configured. Anything that is not Anthropic or OpenAI is reached by model
    // prefix, so it needs a pinned model — and the server already tells us a
    // usable default in modelPrefixes[0].
    const prefixes = Array.isArray(p.modelPrefixes) ? p.modelPrefixes : [];
    const builtIn = p.envKey === 'ANTHROPIC_API_KEY' || p.envKey === 'OPENAI_API_KEY';
    return {
      id: p.id || h.id || p.envKey,
      envKey: p.envKey || h.envKey || '',
      label: p.label || h.label || p.id || p.envKey,
      placeholder: h.placeholder || 'key...',
      model: h.model || prefixes[0] || '',
      consoleUrl: h.consoleUrl || '',
      custom: !!h.custom,
      needsModel: h.needsModel !== undefined && h.envKey ? !!h.needsModel : !builtIn,
      configured: !!p.configured,
      served: true,
    };
  });
  // The served list stays authoritative for NAMED providers: one the server
  // does not enumerate is one /api/config/save would reject, so offering it
  // would just produce a 400. The exception is the client-only custom row —
  // "Custom (OpenAI-compatible)" writes LISA_API_KEY + LISA_BASE_URL rather
  // than a named provider's key, so providerConfigList() has nothing to report
  // for it even though both keys ARE writable. Dropping it with the wholesale
  // replace made Ollama, LM Studio and every self-hosted endpoint unreachable
  // from the GUI, with the BASE URL field permanently hidden.
  const seen = {};
  for (let i = 0; i < merged.length; i++) seen[merged[i].envKey] = true;
  for (let i = 0; i < LISA_PROVIDER_FALLBACK.length; i++) {
    const h = LISA_PROVIDER_FALLBACK[i];
    if (!h.custom || seen[h.envKey]) continue;
    merged.push({
      id: h.id, envKey: h.envKey, label: h.label, placeholder: h.placeholder,
      model: h.model, consoleUrl: h.consoleUrl, custom: true,
      needsModel: !!h.needsModel, configured: false, served: false,
    });
  }
  return merged;
}
// One body understood by both generations of the endpoint: the new
// {keys, model, baseUrl} shape plus every legacy field name.
function lisaProviderSaveBody(provider, key, model, baseUrl) {
  const body = { keys: {} };
  if (key && provider.envKey) body.keys[provider.envKey] = key;
  if (model) body.model = model;
  if (baseUrl) body.baseUrl = baseUrl;
  if (key && provider.envKey === 'ANTHROPIC_API_KEY') { body.anthropicKey = key; body.anthropic = key; }
  if (key && provider.envKey === 'OPENAI_API_KEY') { body.openaiKey = key; body.openai = key; }
  return body;
}
// After a save: did this server actually keep the key? true / false / null
// when there is no way to tell. An older server silently drops anything that
// is not an Anthropic or OpenAI key, which is exactly the case worth naming.
function lisaProviderConfirm(provider, status) {
  const served = status && Array.isArray(status.providers) ? status.providers : null;
  if (served && served.length) {
    for (let i = 0; i < served.length; i++) {
      if (served[i].envKey === provider.envKey) return !!served[i].configured;
    }
    return null;
  }
  if (provider.envKey === 'ANTHROPIC_API_KEY') return !!(status && status.anthropic);
  if (provider.envKey === 'OPENAI_API_KEY') return !!(status && status.openai);
  return false;
}
function lisaProviderUnsupportedNote(provider) {
  return tr('gate.unsupported', { label: provider.label, env: provider.envKey });
}
// The Settings view lives in the console closure at the bottom of this file.
window.lisaProviderList = lisaProviderList;
window.lisaProviderSaveBody = lisaProviderSaveBody;
window.lisaProviderConfirm = lisaProviderConfirm;
window.lisaProviderUnsupportedNote = lisaProviderUnsupportedNote;

// ── API key config gate: show overlay if no key is configured ─────
const cfgOverlay = document.getElementById('cfgOverlay');
const cfgForm = document.getElementById('cfgForm');
const cfgProvider = document.getElementById('cfgProvider');
const cfgKey = document.getElementById('cfgKey');
const cfgKeyLabel = document.getElementById('cfgKeyLabel');
const cfgModel = document.getElementById('cfgModel');
const cfgBaseUrl = document.getElementById('cfgBaseUrl');
const cfgBaseUrlField = document.getElementById('cfgBaseUrlField');
const cfgConsole = document.getElementById('cfgConsole');
const cfgSaveBtn = document.getElementById('cfgSave');
const cfgError = document.getElementById('cfgError');

// Populated by startupGate / openKeyGate from /api/config/status.
let cfgProviders = lisaProviderList(null);
let cfgStatus = null;
function cfgSelected() {
  for (let i = 0; i < cfgProviders.length; i++) {
    if (cfgProviders[i].id === cfgProvider.value) return cfgProviders[i];
  }
  return cfgProviders[0];
}
function cfgSyncProvider() {
  const p = cfgSelected();
  if (!p) return;
  cfgKeyLabel.textContent = p.envKey + (p.configured ? tr('gate.alreadySet') : '');
  cfgKey.placeholder = p.placeholder;
  cfgModel.placeholder = p.model || tr('gate.providerDefault');
  // Only the custom endpoint needs a base URL, and it needs a model too.
  cfgBaseUrlField.style.display = p.custom ? '' : 'none';
  if (cfgConsole) {
    if (p.consoleUrl) {
      cfgConsole.href = p.consoleUrl;
      cfgConsole.textContent = tr('gate.getKey', { label: p.label });
      cfgConsole.style.display = '';
    } else {
      cfgConsole.textContent = '';
      cfgConsole.style.display = 'none';
    }
  }
}
function cfgRenderProviders(status) {
  cfgStatus = status || cfgStatus;
  cfgProviders = lisaProviderList(cfgStatus);
  const keep = cfgProvider.value;
  cfgProvider.innerHTML = '';
  cfgProviders.forEach(function (p) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.label + (p.configured ? ' · configured' : '');
    cfgProvider.appendChild(o);
  });
  // Preselect: whatever is already picked (so a repair keeps the provider
  // that just failed), else the one this Lisa is actually configured with,
  // else Anthropic.
  let firstConfigured = '';
  for (let i = 0; i < cfgProviders.length && !firstConfigured; i++) {
    if (cfgProviders[i].configured) firstConfigured = cfgProviders[i].id;
  }
  const wanted = keep || firstConfigured || 'anthropic';
  cfgProvider.value = wanted;
  if (!cfgProvider.value) cfgProvider.value = cfgProviders[0] ? cfgProviders[0].id : '';
  cfgSyncProvider();
}
cfgProvider.addEventListener('change', cfgSyncProvider);

// UX-1: the gate used to be one-shot. Once a key was written to config.env
// /api/config/status reported "configured" forever, so a REJECTED key left no
// way back — the form never returned and the Settings view sat behind the
// birth overlay. It is reopenable now, and remembers whether this visit is the
// first run or a repair, so the copy and the post-save path can differ.
let cfgReconfigure = false;
function openKeyGate(opts) {
  cfgReconfigure = !!(opts && opts.reconfigure);
  const title = document.getElementById('cfgTitle');
  if (title) title.textContent = tr(cfgReconfigure ? 'gate.title.change' : 'gate.title.set');
  const reason = document.getElementById('cfgReason');
  if (reason) {
    reason.textContent = (opts && opts.reason) ? opts.reason : '';
    reason.style.display = reason.textContent ? '' : 'none';
  }
  // Never prefill the rejected key — retyping is the point. The PROVIDER is
  // preselected (opts.provider, else whatever is already chosen), so a repair
  // starts on the provider that just failed rather than back at Anthropic.
  cfgKey.value = '';
  cfgError.textContent = '';
  cfgSaveBtn.disabled = false;
  if (opts && opts.provider) cfgProvider.value = opts.provider;
  cfgRenderProviders(cfgStatus);
  birthOverlay.classList.remove('open');
  cfgOverlay.classList.add('open');
  setTimeout(() => cfgKey.focus(), 50);
}

cfgForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  cfgError.textContent = '';
  const provider = cfgSelected();
  const key = cfgKey.value.trim();
  // Anthropic and OpenAI are auto-detected server-side from the key alone;
  // every other provider must pin LISA_MODEL or the run falls back to Claude.
  const model = cfgModel.value.trim() ||
    (provider && provider.needsModel && provider.model ? provider.model : '');
  const baseUrl = provider && provider.custom ? cfgBaseUrl.value.trim() : '';
  if (!provider) { cfgError.textContent = tr('gate.pickProvider'); return; }
  if (!key) { cfgError.textContent = tr('gate.keyRequired', { env: provider.envKey }); return; }
  if (provider.custom && !baseUrl) { cfgError.textContent = tr('gate.baseUrlRequired'); return; }
  cfgSaveBtn.disabled = true;
  try {
    const res = await fetch('/api/config/save', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(lisaProviderSaveBody(provider, key, model, baseUrl)),
    });
    if (!res.ok) {
      const txt = errorText(await res.text().catch(() => ''));
      cfgError.textContent = tr('gate.saveFailed') + 'HTTP ' + res.status + (txt ? ' — ' + txt.slice(0, 120) : '');
      cfgSaveBtn.disabled = false;
      return;
    }
    // Confirm the server actually kept it. An older backend silently drops
    // anything that is not an Anthropic/OpenAI key, which would otherwise send
    // the user into a ritual that cannot possibly succeed.
    const after = await fetch('/api/config/status').then(r => r.json()).catch(() => null);
    if (after) { cfgStatus = after; cfgRenderProviders(after); }
    if (after && lisaProviderConfirm(provider, after) === false) {
      cfgError.textContent = lisaProviderUnsupportedNote(provider);
      cfgSaveBtn.disabled = false;
      return;
    }
    cfgKey.value = '';
    cfgOverlay.classList.remove('open');
    // A repair restarts the ritual in place — no location.reload(), so the
    // page keeps its SSE connection, its log and its scroll position.
    if (cfgReconfigure) { cfgReconfigure = false; beginBirth(); }
    else maybeBirth();
  } catch (err) {
    cfgError.textContent = tr('gate.saveFailed') + err.message;
    cfgSaveBtn.disabled = false;
  }
});

// ── Birth ritual: show overlay if Lisa hasn't been born yet ───────
const birthOverlay = document.getElementById('birthOverlay');
const birthStepsEl = document.getElementById('birthSteps');
const birthFinalEl = document.getElementById('birthFinal');
const birthEnterBtn = document.getElementById('birthEnter');
const birthErrorEl = document.getElementById('birthError');
const birthActionsEl = document.getElementById('birthActions');

birthEnterBtn.addEventListener('click', () => {
  birthOverlay.classList.remove('open');
  setTimeout(() => location.reload(), 300);
});

// The ritual can now run more than once per page load (a repaired key, a
// retry after a timeout), so its UI needs a clean slate between runs.
function resetBirthUI() {
  birthStepsEl.innerHTML = '';
  birthFinalEl.textContent = '';
  birthFinalEl.classList.remove('shown');
  birthEnterBtn.classList.remove('shown');
  birthErrorEl.textContent = '';
  birthErrorEl.title = '';
  clearBirthActions();
}
function clearBirthActions() {
  birthActionsEl.innerHTML = '';
  birthActionsEl.style.display = 'none';
}
function birthAction(label, onClick, primary) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'birth-action' + (primary ? ' primary' : '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  birthActionsEl.appendChild(b);
  birthActionsEl.style.display = '';
  return b;
}
function beginBirth() {
  resetBirthUI();
  birthOverlay.classList.add('open');
  startBirthStream();
}

// Live stream control (UX-1): the ritual is a long POST that used to be
// un-cancellable — closing the tab was the only exit, and the server kept
// inferring. Cancel aborts the fetch and hands the user back to the gate.
let birthAbort = null;
function abortBirth() {
  if (!birthAbort) return;
  try { birthAbort.abort(); } catch (e) {}
  birthAbort = null;
}

// Human text for every failure class. The old client printed the provider's
// raw payload — users saw  401 {"type":"error","error":{"type":
// "authentication_error",...}}  and had nothing to do about it.
const BIRTH_ERROR_TEXT = {
  auth: tr('birth.err.auth'),
  timeout: tr('birth.err.timeout'),
  network: tr('birth.err.network'),
  rate_limit: tr('birth.err.rate_limit'),
  unknown: tr('birth.err.unknown'),
};
// New servers send {kind:"error", code, message, retryable}. Older ones send
// {kind:"error", message} with the raw provider text — classify those by hand
// so the same human copy shows either way. Substring tests, not regexes: this
// file is a template literal and every backslash here would need doubling.
function birthErrorCode(ev) {
  const code = ev && typeof ev.code === 'string' ? ev.code : '';
  if (code && BIRTH_ERROR_TEXT[code]) return code;
  const raw = String((ev && ev.message) || '');
  const low = raw.toLowerCase();
  if (raw.indexOf('401') === 0 || raw.indexOf('403') === 0 ||
      low.indexOf('authentication_error') >= 0 || low.indexOf('invalid_api_key') >= 0 ||
      low.indexOf('invalid api key') >= 0 || low.indexOf('unauthorized') >= 0) return 'auth';
  if (raw.indexOf('429') === 0 || low.indexOf('rate_limit') >= 0 || low.indexOf('rate limit') >= 0) return 'rate_limit';
  if (low.indexOf('timeout') >= 0 || low.indexOf('timed out') >= 0 || low.indexOf('etimedout') >= 0) return 'timeout';
  if (low.indexOf('enotfound') >= 0 || low.indexOf('econnrefused') >= 0 ||
      low.indexOf('econnreset') >= 0 || low.indexOf('eai_again') >= 0 ||
      low.indexOf('fetch failed') >= 0 || low.indexOf('network') >= 0) return 'network';
  return 'unknown';
}
function showBirthError(ev) {
  abortBirth();
  const code = birthErrorCode(ev);
  birthErrorEl.textContent = BIRTH_ERROR_TEXT[code] || BIRTH_ERROR_TEXT.unknown;
  // The provider payload is diagnostics, not copy — reachable on hover and in
  // the DOM for a bug report, never rendered as the message.
  birthErrorEl.title = String((ev && ev.message) || '');
  clearBirthActions();
  const changeKey = function () {
    openKeyGate({ reconfigure: true, reason: BIRTH_ERROR_TEXT[code] || BIRTH_ERROR_TEXT.unknown });
  };
  if (code === 'auth') {
    birthAction(tr('birth.changeKey'), changeKey, true);
    return;
  }
  // Anything the server marks non-retryable gets the key path instead.
  if (ev && ev.retryable === false) { birthAction(tr('birth.changeKey'), changeKey, true); return; }
  birthAction(tr('birth.retry'), beginBirth, true);
  birthAction(tr('birth.changeKey'), changeKey);
}

async function maybeBirth() {
  const status = await fetch('/api/soul').then(r => r.json());
  if (status.born) return;
  beginBirth();
}

function appendBirthStep(step) {
  const prevActive = birthStepsEl.querySelector('.birth-step.active');
  if (prevActive) {
    prevActive.classList.remove('active');
    prevActive.classList.add('done');
  }
  const div = document.createElement('div');
  div.className = 'birth-step active';
  const name = document.createElement('div');
  name.className = 'step-name';
  name.textContent = step;
  div.appendChild(name);
  const detail = document.createElement('div');
  detail.className = 'step-detail';
  const cursor = document.createElement('span');
  cursor.className = 'step-cursor';
  detail.appendChild(cursor);
  div.appendChild(detail);
  birthStepsEl.appendChild(div);
  setTimeout(() => div.classList.add('shown'), 50);
  return detail;
}

function typewriter(el, text, done) {
  const cursor = el.querySelector('.step-cursor');
  if (cursor) cursor.remove();
  let i = 0;
  const speed = Math.max(8, Math.min(28, 600 / text.length));
  function tick() {
    if (i >= text.length) {
      const c = document.createElement('span');
      c.className = 'step-cursor';
      el.appendChild(c);
      done && done();
      return;
    }
    el.appendChild(document.createTextNode(text[i]));
    i++;
    el.parentElement.parentElement.scrollTop = el.parentElement.parentElement.scrollHeight;
    setTimeout(tick, speed);
  }
  tick();
}

async function startBirthStream() {
  birthErrorEl.textContent = '';
  let currentDetail = null;
  let queue = [];
  let processing = false;

  function processQueue() {
    if (processing) return;
    if (queue.length === 0) return;
    processing = true;
    const ev = queue.shift();
    if (ev.kind === 'step') {
      currentDetail = appendBirthStep(ev.name);
      typewriter(currentDetail, ev.detail || '', () => {
        processing = false;
        processQueue();
      });
    } else if (ev.kind === 'done') {
      const last = birthStepsEl.querySelector('.birth-step.active');
      if (last) { last.classList.remove('active'); last.classList.add('done'); }
      birthFinalEl.textContent = ev.message;
      birthFinalEl.classList.add('shown');
      birthEnterBtn.classList.add('shown');
      processing = false;
    } else if (ev.kind === 'error') {
      showBirthError(ev);
      processing = false;
    }
  }

  // Cancel is offered for the whole run and withdrawn the moment the stream
  // ends — it aborts the fetch and returns to the gate rather than leaving the
  // user staring at a ritual they cannot stop.
  abortBirth();
  const ctrl = new AbortController();
  birthAbort = ctrl;
  let cancelled = false;
  birthAction(tr('birth.cancel'), function () {
    cancelled = true;
    abortBirth();
    clearBirthActions();
    openKeyGate({ reconfigure: true, reason: tr('birth.cancelled') });
  });

  try {
    const res = await fetch('/api/birth', { method: 'POST', signal: ctrl.signal });
    if (res.status === 409) {
      // 409 = she is already born. Reaching this is not a failure: the soul was
      // written and the SSE stream was cut before the `done` frame (a laptop
      // that slept, a proxy reset, a second tab that finished the ceremony
      // first). Showing the error card here offered a "Try again" that could
      // only ever 409 again — a dead end in front of a Lisa that exists. Close
      // the ritual and let the normal startup path pick her up.
      clearBirthActions();
      birthOverlay.classList.remove('open');
      location.reload();
      return;
    }
    if (!res.ok) {
      // An HTTP-level refusal carries no SSE frame — classify it the same way.
      showBirthError({ code: res.status === 401 || res.status === 403 ? 'auth' : 'unknown',
                       message: 'HTTP ' + res.status });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const m = event.match(/^data: (.*)$/m);
        if (!m) continue;
        const ev = JSON.parse(m[1]);
        queue.push(ev);
        processQueue();
      }
    }
    // The stream ended without an error frame: the run is over, drop Cancel
    // (processQueue has already revealed ENTER on a 'done' frame).
    if (birthAbort === ctrl) { birthAbort = null; clearBirthActions(); }
  } catch (err) {
    // An abort is the user's own Cancel — the gate is already up, say nothing.
    if (cancelled || (err && err.name === 'AbortError')) return;
    showBirthError({ message: (err && err.message) ? err.message : String(err) });
  }
}

let startupTries = 0;
async function startupGate() {
  // Retry: the page can render a hair before the backend's API routes answer,
  // and a transient miss must not silently skip onboarding (the old bug — a
  // bare catch+return left a dead UI with no key prompt, no birth, no message).
  let cfg = null;
  for (let i = 0; i < 6 && !cfg; i++) {
    try {
      // Hosted accounts use the service's model. Its operator configuration
      // is deliberately inaccessible to cloud-chat; a 403 is not a missing key.
      const edition = await fetch('/api/edition').then(r => r.ok ? r.json() : null);
      if (edition && edition.edition === 'cloud') cfg = { configured: true };
      else {
        const response = await fetch('/api/config/status');
        if (!response.ok) throw new Error('Configuration status unavailable');
        cfg = await response.json();
      }
    }
    catch (e) { if (i < 5) await lisaSleep(700); }
  }
  if (!cfg) {
    // The desktop app starts the backend for us on launch, so the first few
    // seconds of silence are normal — say so calmly, and only escalate to an
    // error (with the manual command) once the wait stops looking routine.
    startupTries++;
    if (startupTries <= 2) {
      lisaBanner('Waking Lisa up…', { tone: 'info' });
    } else {
      lisaBanner('Lisa is not answering yet — still retrying. You can start her backend yourself:', { cmd: 'lisa serve --web' });
    }
    setTimeout(startupGate, 3000);
    return;
  }
  startupTries = 0;
  lisaClearBanner();
  cfgStatus = cfg;
  cfgRenderProviders(cfg);
  if (!cfg.configured) {
    openKeyGate();
    return;
  }
  try {
    await maybeBirth();
  } catch (e) {
    lisaBanner('Birth check failed: ' + ((e && e.message) ? e.message : e) + ' — reload to retry.');
  }
}
startupGate();

// ── history load & infinite-scroll ──────────────────────────────────
let historyPage = 0;
let historyLoading = false;
let historyExhausted = false;
// The empty-state card may only be drawn once we KNOW the log is empty — i.e.
// after the first /api/history answer. Before that an empty #log just means
// the fetch is still in flight.
let historyFetched = false;

function textOfMessage(msg) {
  if (typeof msg.content === 'string') return msg.content.trim();
  if (!Array.isArray(msg.content)) return '';
  return msg.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();
}

function prependHistoryMessages(messages) {
  const fragment = document.createDocumentFragment();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.expression) { fragment.appendChild(window.LisaExpressions.create(msg.expression, false)); continue; }
    const text = textOfMessage(msg);
    if (!text) continue;
    // Idle "while you were away" notes are persisted as assistant messages with
    // a [while you were away] sentinel — render them as the distinct idle card
    // (not a plain Lisa bubble) so they don't blend into her real replies.
    if (msg.role !== 'user' && /^\[while you were away\]\s*/i.test(text)) {
      const clean = text.replace(/^\[while you were away\]\s*/i, '');
      fragment.appendChild(buildIdleBlock(clean, msg.at || msg.ts || null));
      continue;
    }
    const roleDiv = document.createElement('div');
    roleDiv.className = 'role ' + (msg.role === 'user' ? 'you' : 'lisa');
    roleDiv.textContent = msg.role === 'user' ? 'YOU' : 'LISA';
    const span = document.createElement('span');
    span.className = 'msg';
    // Lisa's replies are Markdown → render; the user's own text is shown as-is.
    if (msg.role === 'user') span.textContent = text;
    else span.innerHTML = renderMarkdown(text);
    fragment.appendChild(roleDiv);
    fragment.appendChild(span);
  }
  removeChatEmpty();
  log.insertBefore(fragment, log.firstChild);
}

async function loadHistoryPage() {
  if (historyLoading || historyExhausted) return;
  historyLoading = true;
  const prevScrollHeight = log.scrollHeight;
  try {
    // F6 — pin the read to the session this log is showing, so a reply
    // streaming in another session's ctx can never bleed into this page.
    const sidQ = window.lisaActiveSessionId
      ? '&sessionId=' + encodeURIComponent(window.lisaActiveSessionId)
      : '';
    const res = await fetch('/api/history?page=' + historyPage + sidQ);
    const data = await res.json();
    if (data.messages && data.messages.length) {
      prependHistoryMessages(data.messages);
      log.scrollTop = log.scrollHeight - prevScrollHeight;
      historyPage++;
    }
    if (!data.hasMore) {
      historyExhausted = true;
      if (historyPage > 1) {
        const marker = document.createElement('div');
        marker.style.cssText = 'text-align:center;color:var(--fg-3);font-size:11.5px;padding:8px 0;letter-spacing:0.06em;';
        marker.textContent = '— end of history —';
        log.insertBefore(marker, log.firstChild);
      }
    }
  } finally {
    historyLoading = false;
    historyFetched = true;
    renderChatEmpty();
    void githubRefresh();
  }
}

loadHistoryPage();
log.addEventListener('scroll', () => {
  if (log.scrollTop < 80) loadHistoryPage();
});

// Session switch support: wipe the log and reload page 0 for the (new) active
// session. Bumps the chat generation so an in-flight reply stream from the
// previous session stops touching the DOM (it keeps draining silently and the
// server persists it into the session it started in).
window.lisaResetChatLog = function () {
  chatGeneration++;
  historyPage = 0;
  historyLoading = false;
  historyExhausted = false;
  currentLisaSpan = null;
  pendingTools.clear();
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  log.innerHTML = '';
  historyFetched = false;
  loadHistoryPage();
};

// ── Empty chat: who she is · three ways to start · three things she does ──
// UX-4: straight out of the birth ritual #log had zero children and the only
// hint was the composer placeholder "Talk to Lisa…". This card is the first
// screen a new user actually sees. It reuses what the sidebar already
// fetched (identity line, current desire) rather than issuing its own calls,
// and it disappears the moment the log holds anything real.
function chatLogHasContent() {
  for (let i = 0; i < log.children.length; i++) {
    if (log.children[i].id !== 'chatEmpty') return true;
  }
  return false;
}
function removeChatEmpty() {
  const card = document.getElementById('chatEmpty');
  if (card) card.remove();
}
// Three openers. The first one names what she is actually pursuing when the
// soul has a desire, so the card is about THIS Lisa and not a generic tour.
function chatStarters() {
  let desire = '';
  const d = document.getElementById('sbDesire');
  if (d && d.title) desire = d.title.trim();
  if (desire.length > 64) desire = desire.slice(0, 64).trim() + '…';
  return [
    desire ? tr('empty.starter.desire', { desire: desire }) : tr('empty.starter.open'),
    tr('empty.starter.memory'),
    tr('empty.starter.today'),
  ];
}
const CHAT_ABILITY_KEYS = ['tools', 'kb', 'mail'];
function renderChatEmpty() {
  if (!historyFetched || chatLogHasContent()) { removeChatEmpty(); return; }
  let card = document.getElementById('chatEmpty');
  if (!card) {
    card = document.createElement('div');
    card.id = 'chatEmpty';
    card.className = 'chat-empty';
  }
  card.innerHTML = '';
  const art = document.createElement('img');
  art.className = 'ce-art';
  art.alt = '';
  art.width = 112; art.height = 112;
  art.src = '/assets/visuals/soft-ink-v1/welcome.webp';
  card.appendChild(art);
  const who = document.createElement('div');
  who.className = 'ce-who';
  const sub = document.getElementById('identitySub');
  const subTxt = sub && sub.textContent && sub.textContent !== '—' ? sub.textContent : '';
  who.textContent = subTxt ? 'Lisa · ' + subTxt : 'Lisa';
  card.appendChild(who);
  const lead = document.createElement('div');
  lead.className = 'ce-lead';
  lead.textContent = tr('empty.lead');
  card.appendChild(lead);
  const starters = document.createElement('div');
  starters.className = 'ce-starters';
  chatStarters().forEach(function (text) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ce-starter';
    b.textContent = text;
    // Fill, don't send: the user still edits and presses Enter, so a
    // mis-click never spends a model call.
    b.addEventListener('click', function () {
      input.value = text;
      input.focus();
      try { input.setSelectionRange(text.length, text.length); } catch (e) {}
      // Let the composer's own 'input' listener re-measure its height.
      input.dispatchEvent(new Event('input'));
    });
    starters.appendChild(b);
  });
  card.appendChild(starters);
  const can = document.createElement('ul');
  can.className = 'ce-can';
  CHAT_ABILITY_KEYS.forEach(function (k) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = tr('empty.can.' + k + '.k');
    li.appendChild(b);
    li.appendChild(document.createTextNode(' — ' + tr('empty.can.' + k + '.v')));
    can.appendChild(li);
  });
  card.appendChild(can);
  if (!card.parentNode) log.appendChild(card);
}
window.lisaRenderChatEmpty = renderChatEmpty;

// ── Soft Ink portrait: one atlas, latest request wins, preserve last image on failure. ──
const mascotEl = document.getElementById('mascot');
const mascotTagEl = document.getElementById('mascotTag');
let portraitRequest = 0;
function setMood(slug) {
  if (!slug) return;
  const request = ++portraitRequest;
  window.LisaArt.portrait(mascotEl, slug).then(function (loaded) {
    if (!loaded || request !== portraitRequest) return;
    mascotTagEl.textContent = slug.replace(/-/g, ' ');
    mascotEl.alt = 'Lisa · ' + slug.replace(/-/g, ' ');
  });
}
setMood('neutral');

// ── modal panel: SOUL / SKILLS / MEMORY / TOOLS ──────────────────────
const modalBg = document.getElementById('modalBg');
const modalTitle = document.getElementById('modalTitle');
const modalBody = document.getElementById('modalBody');
const modalClose = document.getElementById('modalClose');

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
// Error bodies are {error, message} JSON (contracts/lisa-error-codes.json);
// show the message. Plain text from an older server passes through as is.
function errorText(t) {
  try {
    const j = JSON.parse(t);
    if (j && typeof j.message === 'string' && j.message) return j.message;
    if (j && typeof j.error === 'string') return j.error;
  } catch (_) { /* plain text */ }
  return t;
}
let modalRevision = 0;
function openModal(title, html) {
  modalRevision++;
  modalTitle.textContent = title;
  modalBody.innerHTML = html;
  modalBg.classList.add('open');
}
function closeModal() { modalRevision++; modalBg.classList.remove('open'); }
modalClose.addEventListener('click', closeModal);
modalBg.addEventListener('click', (e) => { if (e.target === modalBg) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

async function panelRequest(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    if (!response.ok) throw new Error(tr('panel.failed'));
    return await response.json();
  } finally { clearTimeout(timer); }
}
async function loadPanel(title, url, render, retry) {
  openModal(title, '<div class="empty">' + escapeHtml(tr('panel.loading')) + '</div>');
  const revision = modalRevision;
  try {
    const data = await panelRequest(url, undefined);
    if (revision !== modalRevision) return;
    render(data);
  } catch (error) {
    if (revision !== modalRevision) return;
    modalBody.innerHTML = '<div role="alert" class="empty">' + escapeHtml(tr('panel.failed')) + '</div><button id="panelRetry">' + escapeHtml(tr('panel.retry')) + '</button>';
    document.getElementById('panelRetry').addEventListener('click', retry);
  }
}
async function showSkills() {
  return loadPanel('SKILLS', '/api/skills', function (data) {
    if (!Array.isArray(data.skills)) throw new Error('Invalid skills response');
    const names = new Set(data.skills.filter(s => s.scope !== 'project').map(s => s.name));
    modalBody.innerHTML = '<div class="skills-actions"><button id="skillsRefresh">' + escapeHtml(tr('panel.refresh')) + '</button>' +
      (data.canManage ? '<button id="skillsCreate">' + escapeHtml(tr('skills.create')) + '</button>' : '') + '</div>' +
      '<h3>' + escapeHtml(tr('skills.active')) + '</h3>' +
      (data.skills.length ? data.skills.map(s => '<div class="item"><div class="name">' + escapeHtml(s.name) +
        ' <span class="skill-scope">' + escapeHtml(tr(s.scope === 'project' ? 'skills.project' : 'skills.home')) + '</span></div><div class="desc">' + escapeHtml(s.description) + '</div></div>').join('') : '<div class="empty">' + escapeHtml(tr('skills.empty')) + '</div>');
    document.getElementById('skillsRefresh').addEventListener('click', showSkills);
    if (!data.canManage) return;
    document.getElementById('skillsCreate').addEventListener('click', showSkillCreate);
    modalBody.insertAdjacentHTML('beforeend', '<h3>' + escapeHtml(tr('skills.imports')) + '</h3><p class="empty">' + escapeHtml(tr('skills.importNote')) + '</p>');
    const candidates = Array.isArray(data.imports) ? data.imports : [];
    if (!candidates.length) modalBody.insertAdjacentHTML('beforeend', '<div class="empty">' + escapeHtml(tr('skills.noImports')) + '</div>');
    candidates.forEach(function (skill) {
      const row = document.createElement('div'); row.className = 'item';
      row.innerHTML = '<div class="name">' + escapeHtml(skill.name) + ' <span class="skill-scope">' + escapeHtml(skill.source) + '</span></div><div class="desc">' + escapeHtml(skill.description) + '</div>';
      const button = document.createElement('button');
      button.textContent = names.has(skill.name) ? tr('skills.exists') : tr('skills.import', skill);
      button.disabled = names.has(skill.name);
      button.addEventListener('click', async function () {
        button.disabled = true;
        const revision = modalRevision;
        try {
          await saveSkill('/api/skills/import', { name: skill.name, source: skill.source });
          if (revision !== modalRevision) return;
          await showSkills(); lisaBanner(tr('skills.imported', skill), { tone: 'info' });
        } catch (error) { button.disabled = false; lisaBanner(tr('skills.actionFailed', { error: error.message })); }
      });
      row.appendChild(button); modalBody.appendChild(row);
    });
  }, showSkills);
}
async function saveSkill(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || tr('panel.failed'));
}
function showSkillCreate() {
  openModal(tr('skills.create'), '<form id="skillForm" class="skill-form">' +
    '<label>' + escapeHtml(tr('skills.name')) + '<input name="name" required pattern="[a-z0-9][a-z0-9-]{0,62}" maxlength="63"></label>' +
    '<label>' + escapeHtml(tr('skills.description')) + '<input name="description" required maxlength="1024"></label>' +
    '<label>' + escapeHtml(tr('skills.instructions')) + '<textarea name="body" required maxlength="100000" rows="7"></textarea></label>' +
    '<div role="alert" id="skillError"></div><button type="submit">' + escapeHtml(tr('session.save')) + '</button> <button type="button" id="skillCancel">' + escapeHtml(tr('session.cancel')) + '</button></form>');
  document.getElementById('skillCancel').addEventListener('click', showSkills);
  document.getElementById('skillForm').addEventListener('submit', async function (event) {
    event.preventDefault();
    const form = /** @type {HTMLFormElement} */ (event.currentTarget);
    const button = form.querySelector('button[type="submit"]'); button.disabled = true;
    const revision = modalRevision;
    try {
      await saveSkill('/api/skills', Object.fromEntries(new FormData(form)));
      if (revision !== modalRevision) return;
      await showSkills(); lisaBanner(tr('skills.saved'), { tone: 'info' });
    } catch (error) { if (revision !== modalRevision) return; document.getElementById('skillError').textContent = tr('skills.actionFailed', { error: error.message }); button.disabled = false; }
  });
}
async function showMemoryReadOnly() {
  return loadPanel('MEMORY', '/api/memory', function (data) {
    if (typeof data.user !== 'string' || typeof data.memory !== 'string') throw new Error('Invalid memory response');
    modalBody.innerHTML =
      '<h3>USER.md — what Lisa remembers about you</h3>' +
      '<pre>' + escapeHtml(data.user || '(empty)') + '</pre>' +
      '<h3>MEMORY.md — Lisa\'s working notes</h3>' +
      '<pre>' + escapeHtml(data.memory || '(empty)') + '</pre>';
  }, showMemory);
}

// Memory sovereignty: view / edit / delete entries, forget a topic, export.
// Falls back to the read-only view when the caller may not edit (403).
async function memoryApi(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || json.error || ('HTTP ' + res.status));
  return json;
}

async function showMemory() {
  openModal('MEMORY', '<div class="empty">' + escapeHtml(tr('panel.loading')) + '</div>');
  const revision = modalRevision;
  let data;
  try { data = await memoryApi('GET', '/api/memory/entries'); }
  catch (e) { return revision === modalRevision ? showMemoryReadOnly() : undefined; }
  if (revision !== modalRevision) return;
  const labels = { user: 'USER.md — what Lisa remembers about you', memory: 'MEMORY.md — Lisa\'s working notes' };
  let html =
    '<div class="item"><div class="name">Forget a topic</div>' +
    '<div class="desc">Erases it from memory, the knowledge base, past conversations and search. Lisa\'s journal gets literal redactions only, and she is told you used Forget.</div>' +
    '<input id="memForgetQ" type="text" maxlength="200" placeholder="topic, name, project…"> ' +
    '<button id="memForgetBtn">preview</button><div id="memForgetOut" class="desc"></div></div>' +
    '<div class="item"><a href="/api/export" download>Export my Lisa (.tar.gz)</a> · ' +
    '<a href="/api/export?sessions=1" download>with conversations</a>' +
    '<div class="desc">Never includes secrets, keys, account or device records.</div></div>';
  for (const store of ['user', 'memory']) {
    const s = (data.stores || []).find(x => x.store === store);
    if (!s) continue;
    html += '<h3>' + escapeHtml(labels[store]) + ' <span class="desc">' + s.bytes + ' / ' + s.maxBytes + ' bytes</span></h3>';
    if (s.corrupt) html += '<div class="empty">This file is not clean text — repair it by hand before editing here.</div>';
    if (!s.entries.length) html += '<div class="empty">(empty)</div>';
    for (const e of s.entries) {
      html += '<div class="item" data-mem-id="' + escapeHtml(e.id) + '"><div class="desc mem-text">' + escapeHtml(e.text) + '</div>' +
        (s.corrupt ? '' : '<button class="mem-edit">edit</button> <button class="mem-del">delete</button>') + '</div>';
    }
    if (!s.corrupt) {
      html += '<div class="item"><input class="mem-new" data-store="' + store + '" type="text" placeholder="add an entry…"> <button class="mem-add" data-store="' + store + '">add</button></div>';
    }
  }
  modalBody.innerHTML = html;
  const fail = (e) => window.alert('Could not save: ' + (e && e.message ? e.message : e));
  modalBody.querySelectorAll('.mem-del').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.parentElement.getAttribute('data-mem-id');
    if (!window.confirm('Delete this memory entry?')) return;
    try { await memoryApi('DELETE', '/api/memory/entries/' + encodeURIComponent(id)); showMemory(); } catch (e) { fail(e); }
  }));
  modalBody.querySelectorAll('.mem-edit').forEach(btn => btn.addEventListener('click', () => {
    const row = btn.parentElement;
    const id = row.getAttribute('data-mem-id');
    const textEl = row.querySelector('.mem-text');
    const ta = document.createElement('textarea');
    ta.value = textEl.textContent;
    ta.rows = 3;
    ta.style.width = '100%';
    const save = document.createElement('button');
    save.textContent = 'save';
    save.addEventListener('click', async () => {
      try { await memoryApi('PUT', '/api/memory/entries/' + encodeURIComponent(id), { text: ta.value }); showMemory(); } catch (e) { fail(e); }
    });
    row.replaceChildren(ta, save);
    ta.focus();
  }));
  modalBody.querySelectorAll('.mem-add').forEach(btn => btn.addEventListener('click', async () => {
    const store = btn.getAttribute('data-store');
    const input = btn.parentElement.querySelector('.mem-new');
    if (!input.value.trim()) return;
    try { await memoryApi('POST', '/api/memory/entries', { store, text: input.value }); showMemory(); } catch (e) { fail(e); }
  }));
  const fq = document.getElementById('memForgetQ');
  const fout = document.getElementById('memForgetOut');
  document.getElementById('memForgetBtn').addEventListener('click', async () => {
    const query = fq.value.trim();
    if (!query) return;
    try {
      const { report } = await memoryApi('POST', '/api/memory/forget', { query, dryRun: true });
      const parts = Object.keys(report.counts).filter(k => report.counts[k] > 0).map(k => k + ' ' + report.counts[k]);
      if (!parts.length) { fout.textContent = 'Nothing mentions that.'; return; }
      // Every item that will change, with the text around the match.
      const items = (report.locations || []).filter(l => l.layer !== 'search_index').map(l =>
        '<li><b>' + escapeHtml(l.action) + '</b> ' + escapeHtml(l.location) + (l.why ? ' (' + escapeHtml(l.why) + ')' : '') +
        (l.snippet ? '<br><span class="desc">“' + escapeHtml(l.snippet) + '”</span>' : '') + '</li>').join('');
      const untouched = (report.untouched || []).map(u => '<li>' + escapeHtml(u.location) + (u.why ? ' (' + escapeHtml(u.why) + ')' : '') + '</li>').join('');
      fout.innerHTML = '<div>' + escapeHtml(report.match ? report.match.note : '') + '</div>' +
        '<div>' + escapeHtml('Found: ' + parts.join(' · ')) + '</div>' +
        '<ul style="max-height:16em;overflow:auto">' + items + '</ul>' +
        (untouched ? '<div>Mentioned but not edited:</div><ul>' + untouched + '</ul>' : '') +
        '<button id="memForgetGo">forget these</button>';
      document.getElementById('memForgetGo').addEventListener('click', async () => {
        if (!window.confirm('Forget the items listed? This cannot be undone here.\n\nNot reachable: ' + report.residuals.join(' '))) return;
        try {
          const done = await memoryApi('POST', '/api/memory/forget', { query, digest: report.digest });
          const left = Object.keys(done.report.remaining || {}).filter(k => done.report.remaining[k] > 0);
          showMemory().then(() => {
            const out = document.getElementById('memForgetOut');
            if (!out) return;
            const scanned = (done.report.scanned || []).map(a => a.split(' — ')[0]).join(', ');
            const notScanned = done.report.notScanned || [];
            out.textContent = (left.length ? 'Forgotten, but a re-scan still finds it in: ' + left.join(', ') + '.'
              : 'Forgotten. A re-scan of ' + scanned + ' finds nothing left.') +
              (notScanned.length ? ' Not scanned, so it may still be mentioned in: ' + notScanned.join('; ') + '.' : '');
          });
        } catch (e) { fail(e); }
      });
    } catch (e) { fail(e); }
  });
}

async function showTools() {
  return loadPanel('TOOLS', '/api/tools', function (data) {
    if (!Array.isArray(data.tools)) throw new Error('Invalid tools response');
    modalBody.innerHTML = data.tools.map(t => '<div class="item"><div class="name">' + escapeHtml(t.name) + '</div><div class="desc">' + escapeHtml(t.description) + '</div></div>').join('');
  }, showTools);
}

async function showPlans() {
  return loadPanel('CODING PLANS', '/api/plans', function (data) {
  if (!Array.isArray(data.plans)) throw new Error('Invalid plans response');
  const intro = '<div class="empty">Run coding work on a subscription you already pay for (Claude Pro/Max · ChatGPT/Codex · Copilot) instead of a metered API key. LISA drives the vendor CLI you are logged into, so it bills your plan, not a key. This does not change her own model.</div>';
  const rows = (data.plans || []).map(function (p) {
    const star = p.selected ? ' — selected' : '';
    const usage = p.usage ? '<div class="desc">usage: ' + escapeHtml(p.usage) + '</div>' : '';
    let btn;
    if (p.selected) btn = '<button class="plan-select" data-plan="' + escapeHtml(p.id) + '" disabled>selected</button>';
    else if (p.available && p.loggedIn !== false) btn = '<button class="plan-select" data-plan="' + escapeHtml(p.id) + '">use this</button>';
    else btn = '<button class="plan-select" data-plan="' + escapeHtml(p.id) + '" disabled>' + (p.available ? 'sign in first' : 'not installed') + '</button>';
    return '<div class="item"><div class="name">' + escapeHtml(p.mark + ' ' + p.label + star) + '</div><div class="desc">' + escapeHtml(p.detail) + '</div>' + usage + btn + '</div>';
  }).join('');
  const clear = '<div class="item"><button class="plan-select" data-plan="none">clear selection</button></div>';
  modalBody.innerHTML = '<button id="plansRefresh">' + escapeHtml(tr('plans.refresh')) + '</button>' + intro + rows + clear;
  document.getElementById('plansRefresh').addEventListener('click', showPlans);
  document.querySelectorAll('.plan-select').forEach(function (btn) {
    if (btn.disabled) return;
    btn.addEventListener('click', function () { selectPlan(btn.dataset.plan); });
  });
  }, showPlans);
}

async function selectPlan(plan) {
  try {
    const res = await fetch('/api/plans/select', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: plan }),
    });
    if (!res.ok) {
      const t = errorText(await res.text().catch(function () { return ''; }));
      modalBody.insertAdjacentHTML('afterbegin', '<div class="empty" style="color:var(--err-color)">select failed: ' + escapeHtml(String(res.status) + (t ? ' — ' + t : '')) + '</div>');
      return;
    }
    showPlans();
  } catch (e) {
    modalBody.insertAdjacentHTML('afterbegin', '<div class="empty" style="color:var(--err-color)">select error: ' + escapeHtml(e.message) + '</div>');
  }
}

// ── Pair phone: mint a device token + show copyable pairing details ──────────
// Mirrors "lisa pair" / the Mac app Pair iPhone window for browser users. The mint
// endpoint is loopback-only, so this works from a localhost browser on the Mac
// (a LAN browser gets 403, handled below). The server detects the Mac's LAN host
// and returns the lisa-pair:// link + host/port/token so the phone can paste the
// link OR type the fields into Lisa Pocket → Settings → Pair.
function pairRow(label, value) {
  return '<div class="pair-row"><span class="pair-label">' + escapeHtml(label) + '</span>'
    + '<code class="pair-val">' + escapeHtml(value) + '</code>'
    + '<button class="pair-copy" type="button">' + escapeHtml(tr('copy')) + '</button></div>';
}
async function showPair() {
  openModal('PAIR PHONE', '<div class="empty">minting a pairing code…</div>');
  let res;
  try {
    res = await fetch('/api/pair/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'phone', platform: 'ios' }),
    });
  } catch (e) {
    modalBody.innerHTML = '<div class="empty">Couldn\'t reach the Lisa backend.</div>';
    return;
  }
  if (res.status === 403) {
    modalBody.innerHTML = '<div class="empty">Pairing can only be started on the Mac itself. Open this page at <code>http://localhost:' + escapeHtml(location.port || '5757') + '</code> on your Mac, then try again.</div>';
    return;
  }
  if (!res.ok) {
    modalBody.innerHTML = '<div class="empty">Pairing failed (HTTP ' + res.status + ').</div>';
    return;
  }
  const data = await res.json().catch(function () { return {}; });
  if (!data.token) { modalBody.innerHTML = '<div class="empty">The server returned no token.</div>'; return; }
  const port = data.port || 5757;
  const host = data.host || '';
  const link = data.url || ('lisa-pair://v1?host=' + encodeURIComponent(host) + '&port=' + port + '&token=' + encodeURIComponent(data.token) + '&name=phone');
  let html = '';
  if (data.qrSvg) html += '<div class="pair-qr">' + data.qrSvg + '</div>';
  html += '<div class="empty">Scan the code in Lisa Pocket → Settings → Scan QR — or paste the link / type the three fields below. Keep the phone on the same Wi-Fi (or tailnet) as this Mac.</div>';
  html += pairRow('Link', link);
  html += pairRow('Host', host || '(your Mac\'s Wi-Fi IP)');
  html += pairRow('Port', String(port));
  html += pairRow('Token', data.token);
  // UX-11: the panel showed a live credential with no word about its lifetime.
  // Device tokens (devices.ts mintDevice) have no expiry at all — they are
  // valid until the device is revoked — so say exactly that.
  html += '<div class="pair-note">' + escapeHtml(tr('pair.noExpiry')) + '</div>';
  if (!host) html += '<div class="empty">Couldn\'t detect your Mac\'s LAN address — enter its Wi-Fi IP or tailnet name on the phone.</div>';
  modalBody.innerHTML = html;
  const codes = modalBody.querySelectorAll('.pair-row');
  for (let i = 0; i < codes.length; i++) {
    const row = codes[i];
    const btn = row.querySelector('.pair-copy');
    const val = row.querySelector('.pair-val');
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText(val.textContent).then(function () {
        const prev = btn.textContent; btn.textContent = tr('copied'); setTimeout(function () { btn.textContent = prev; }, 1200);
      }).catch(function () {});
    });
  }
}

async function showSoul() {
  openModal('★ SOUL', '<div class="empty">loading…</div>');
  const data = await fetch('/api/soul').then(r => r.json());
  if (!data.born) {
    modalBody.innerHTML = '<div class="empty">Lisa hasn\'t been born yet. Restart the CLI without --no-birth and the birth ritual will run.</div>';
    return;
  }
  const s = data.summary;
  let html = '';
  html += '<h3>name</h3><div>' + escapeHtml(s.name) + '</div>';
  html += '<h3>born</h3><div>' + escapeHtml(s.seed.bornAt) + ' · big5(O' + Math.round(s.seed.bigFive.openness*100) + ' C' + Math.round(s.seed.bigFive.conscientiousness*100) + ' E' + Math.round(s.seed.bigFive.extraversion*100) + ' A' + Math.round(s.seed.bigFive.agreeableness*100) + ' N' + Math.round(s.seed.bigFive.neuroticism*100) + ')</div>';
  html += '<h3>identity</h3><pre>' + escapeHtml(s.identity) + '</pre>';
  html += '<h3>purpose</h3><pre>' + escapeHtml(s.purpose) + '</pre>';
  html += '<h3>constitution</h3><pre>' + escapeHtml(s.constitution) + '</pre>';
  if (s.values?.length) {
    html += '<h3>values</h3>' + s.values.map(v =>
      '<div class="item"><div class="name">' + escapeHtml(v.title) + '</div><div class="desc">' + escapeHtml(v.body) + '</div></div>'
    ).join('');
  }
  if (s.opinions?.length) {
    html += '<h3>opinions</h3>' + s.opinions.map(o =>
      '<div class="item"><div class="name">' + escapeHtml(o.stance) + ' (conf ' + o.confidence.toFixed(2) + ')</div></div>'
    ).join('');
  }
  if (s.desires?.length) {
    html += '<h3>desires</h3>' + s.desires.map(d =>
      '<div class="item"><div class="name">' + escapeHtml(d.what) + (d.actionable ? ' [heartbeat-active]' : '') + '</div><div class="desc">' + escapeHtml(d.why) + '</div></div>'
    ).join('');
  }
  html += '<h3>emotions</h3>' + Object.entries(s.emotions.values).map(([k, v]) => {
    const len = 12;
    const filled = Math.round(Math.abs(v) * len);
    const bar = '█'.repeat(filled) + '░'.repeat(len - filled);
    return '<div class="item"><div class="name">' + escapeHtml(k) + '</div><div class="desc">' + (v < 0 ? '-' : ' ') + bar + '  ' + v.toFixed(2) + '</div></div>';
  }).join('');
  if (s.tampered?.length) {
    html += '<h3>⚠ tampered</h3><div>External edits detected on: ' + s.tampered.map(escapeHtml).join(', ') + '</div>';
  }
  html += '<h3 style="color: var(--fg-3); font-size: 10px;">privacy note</h3><div class="empty">Her journal lives at ~/.lisa/soul/journal/ but is intentionally not shown here — that is hers to keep.</div>';
  modalBody.innerHTML = html;
}

// Panel openers — the top function bar (.fbtn) + any legacy .badge share this.
document.querySelectorAll('[data-panel]').forEach(b => {
  b.addEventListener('click', () => {
    const which = b.dataset.panel;
    if (which === 'soul') showSoul();
    else if (which === 'skills') showSkills();
    else if (which === 'memory') showMemory();
    else if (which === 'tools') showTools();
    else if (which === 'plans') showPlans();
    else if (which === 'pair') showPair();
  });
});

// Find in conversation — toggle a filter box that hides non-matching log rows.
const fnSearchBtn = document.getElementById('fnSearchBtn');
const fnFind = document.getElementById('fnFind');
function filterLog(q) {
  const logEl = document.getElementById('log');
  if (!logEl) return;
  for (const child of logEl.children) {
    child.style.display = !q || (child.textContent || '').toLowerCase().includes(q) ? '' : 'none';
  }
}
if (fnSearchBtn && fnFind) {
  fnSearchBtn.addEventListener('click', () => {
    if (findIsOpen()) closeFind(); else openFind();
  });
  fnFind.addEventListener('input', () => filterLog(fnFind.value.trim().toLowerCase()));
  fnFind.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeFind();
  });
}
function openFind() {
  if (!fnFind) return;
  fnFind.style.display = '';
  document.getElementById('fnbar').classList.add('searching');
  fnFind.focus();
  fnFind.select();
}
function findIsOpen() { return !!fnFind && fnFind.style.display !== 'none'; }
function closeFind() {
  if (!fnFind) return;
  fnFind.value = '';
  filterLog('');
  fnFind.style.display = 'none';
  document.getElementById('fnbar').classList.remove('searching');
}

// ── Keyboard shortcuts (UX-11) ───────────────────────────────────
// Before this the shell had Enter / Shift+Enter / Esc and nothing else:
// switching sessions meant reaching for the sidebar tree, and find-in-chat
// meant finding a 36px magnifier in a twelve-icon bar.
const switcherOverlay = document.getElementById('switcherOverlay');
const switcherInput = document.getElementById('switcherInput');
const switcherList = document.getElementById('switcherList');
let switcherRows = [];
let switcherIdx = 0;

function isTypingTarget(node) {
  if (!node) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true;
}
function switcherIsOpen() { return !!switcherOverlay && !switcherOverlay.hidden; }
function renderSwitcher() {
  if (!switcherList) return;
  const q = (switcherInput.value || '').trim().toLowerCase();
  const all = (typeof window.lisaSessionsForSwitcher === 'function' ? window.lisaSessionsForSwitcher() : []) || [];
  switcherRows = all.filter(function (r) {
    if (!q) return true;
    return (r.label + ' ' + r.id).toLowerCase().indexOf(q) >= 0;
  }).slice(0, 30);
  if (switcherIdx >= switcherRows.length) switcherIdx = 0;
  switcherList.innerHTML = '';
  if (!switcherRows.length) {
    const empty = document.createElement('div');
    empty.className = 'kbd-empty';
    empty.textContent = tr('kbd.noSessions');
    switcherList.appendChild(empty);
    return;
  }
  switcherRows.forEach(function (r, i) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'kbd-row' + (i === switcherIdx ? ' sel' : '') + (r.active ? ' current' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', i === switcherIdx ? 'true' : 'false');
    const nm = document.createElement('span');
    nm.className = 'kbd-row-name';
    nm.textContent = r.label;
    const meta = document.createElement('span');
    meta.className = 'kbd-row-meta';
    meta.textContent = r.meta;
    row.appendChild(nm);
    row.appendChild(meta);
    row.title = r.id;
    // Mousedown, not click: the input keeps focus and the overlay closes
    // before a click could land on whatever is underneath.
    row.addEventListener('mousedown', function (ev) { ev.preventDefault(); activateSwitcher(i); });
    switcherList.appendChild(row);
  });
}
function moveSwitcher(delta) {
  if (!switcherRows.length) return;
  switcherIdx = (switcherIdx + delta + switcherRows.length) % switcherRows.length;
  renderSwitcher();
  const sel = switcherList.querySelector('.kbd-row.sel');
  if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
}
function activateSwitcher(i) {
  const row = switcherRows[i == null ? switcherIdx : i];
  closeSwitcher();
  if (!row) return;
  if (typeof window.lisaSwitchSession === 'function') window.lisaSwitchSession(row.id);
}
function openSwitcher() {
  if (!switcherOverlay) return;
  switcherIdx = 0;
  switcherInput.value = '';
  switcherInput.placeholder = tr('kbd.switchPlaceholder');
  switcherOverlay.hidden = false;
  renderSwitcher();
  switcherInput.focus();
}
function closeSwitcher() {
  if (!switcherOverlay) return;
  switcherOverlay.hidden = true;
}
if (switcherOverlay) {
  switcherInput.addEventListener('input', function () { switcherIdx = 0; renderSwitcher(); });
  switcherInput.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSwitcher(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSwitcher(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); activateSwitcher(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSwitcher(); }
  });
  switcherOverlay.addEventListener('mousedown', function (e) {
    if (e.target === switcherOverlay) closeSwitcher();
  });
}

const SHORTCUTS = [
  ['⌘K / Ctrl+K', 'kbd.switch'],
  ['⌘/ / Ctrl+/', 'kbd.focus'],
  ['⌘F / Ctrl+F', 'kbd.find'],
  ['Esc', 'kbd.close'],
  ['Enter / Shift+Enter', 'kbd.send'],
  ['?', 'kbd.help'],
];
function showShortcuts() {
  const rows = SHORTCUTS.map(function (r) {
    return '<div class="kvrow"><span>' + escapeHtml(r[0]) + '</span><code>' + escapeHtml(tr(r[1])) + '</code></div>';
  }).join('');
  openModal(tr('kbd.title'), '<div class="kvrows">' + rows + '</div>');
}
window.lisaShowShortcuts = showShortcuts;

document.addEventListener('keydown', function (e) {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.altKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openSwitcher(); return; }
  if (mod && !e.altKey && e.key === '/') { e.preventDefault(); input.focus(); return; }
  if (mod && !e.altKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openFind(); return; }
  // "?" only when the user is not typing one into a field.
  if (e.key === '?' && !mod && !isTypingTarget(e.target)) { e.preventDefault(); showShortcuts(); return; }
  if (e.key === 'Escape') {
    // Most-nested first. The key gate and the birth ritual are deliberately
    // NOT dismissible — they are the only way through first run.
    if (switcherIsOpen()) { closeSwitcher(); return; }
    if (findIsOpen()) { closeFind(); return; }
  }
});

// Compact / sidebar mode — force the narrow stacked layout at any width, persisted.
// The toggle UI now lives in the Settings rail view; this block owns the state,
// restores it on load (always — no element dependency), and exposes get/set
// globals the Settings switch drives + reflects.
{
  let compactOn = false;
  try { compactOn = localStorage.getItem('lisaCompact') === '1'; } catch (e) {}
  const applyCompact = () => {
    document.body.classList.toggle('force-compact', compactOn);
    const sw = document.getElementById('setCompactToggle');
    if (sw) {
      sw.classList.toggle('on', compactOn);
      sw.setAttribute('aria-checked', compactOn ? 'true' : 'false');
    }
  };
  applyCompact();
  window.lisaGetCompact = () => compactOn;
  window.lisaSetCompact = (on) => {
    const next = !!on;
    if (next === compactOn) return;
    compactOn = next;
    try { localStorage.setItem('lisaCompact', compactOn ? '1' : '0'); } catch (e) {}
    applyCompact();
  };
}

// Existing choices survive; new profiles follow the OS, including live changes.
// The tiny body-start script applies the same preference before the first paint.
{
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  const normalize = (t) => t === 'calm' || t === 'nebula' ? t : 'system';
  let preference = 'system';
  try { preference = normalize(localStorage.getItem('lisa-theme')); } catch (e) {}
  let theme;
  const applyTheme = () => {
    theme = preference === 'system' ? (systemTheme.matches ? 'nebula' : 'calm') : preference;
    document.documentElement.style.colorScheme = theme === 'calm' ? 'light' : 'dark';
    if (theme === 'calm') document.body.setAttribute('data-theme', 'calm');
    else document.body.removeAttribute('data-theme');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'calm' ? '#f5f6fa' : '#07091a');
    const picker = document.getElementById('setTheme');
    if (picker) picker.value = preference;
    const button = document.getElementById('fnTheme');
    const label = theme === 'calm' ? 'Switch to dark mode' : 'Switch to light mode';
    if (button) { button.title = label; button.setAttribute('aria-label', label); }
    // Keep native window chrome and the offline screen in the same appearance.
    try { window.webkit?.messageHandlers?.lisa?.postMessage({ type: 'appearance', preference }); } catch (_) {}
  };
  applyTheme();
  window.lisaGetTheme = () => theme;
  window.lisaGetThemePreference = () => preference;
  window.lisaSetTheme = (t) => {
    preference = normalize(t);
    try { localStorage.setItem('lisa-theme', preference); } catch (e) {}
    applyTheme();
  };
  systemTheme.addEventListener('change', () => { if (preference === 'system') applyTheme(); });
  window.addEventListener('storage', (event) => {
    if (event.key === 'lisa-theme' || event.key === null) {
      preference = normalize(event.newValue);
      applyTheme();
    }
  });
  const themeBtn = document.getElementById('fnTheme');
  if (themeBtn) themeBtn.addEventListener('click', () => {
    window.lisaSetTheme(theme === 'calm' ? 'nebula' : 'calm');
  });
  // Mail entry from the function bar (the sidebar mail card moved to the
  // right panel, which collapses on narrow widths — this stays reachable).
  const mailBtn = document.getElementById('fnMail');
  if (mailBtn) mailBtn.addEventListener('click', () => {
    if (window.lisaShowView) window.lisaShowView('mail');
  });
}

// Right panel manual collapse (F4) — wide-screen only concern: the ≤1180px
// media query hides the panel regardless. Persisted; the fnbar button shows
// an active tint while collapsed. Collapsed is the DEFAULT: the panel only
// stays open once the user has explicitly opened it ("open" in localStorage),
// so a fresh profile boots into the two-column chat-first layout.
{
  let collapsed = true;
  try { collapsed = localStorage.getItem('lisaRightbar') !== 'open'; } catch (e) {}
  // UX-5: has the user ever driven this toggle themselves? Once they have,
  // their choice is final and the auto-expand nudge below never fires again —
  // including across reloads, which is why it is persisted.
  let touched = false;
  try { touched = localStorage.getItem('lisaRightbarTouched') === '1'; } catch (e) {}
  let autoExpanded = false;
  let attention = 0;
  const PANEL_TITLE = tr('rail.toggle');
  // While the rail is collapsed the only sign that an agent is blocked on a
  // decision was a 34px icon with a tooltip — the count now rides the icon.
  const syncBadge = () => {
    const btn = document.getElementById('fnPanel');
    if (!btn) return;
    let dot = btn.querySelector('.fbtn-badge');
    if (!collapsed || attention <= 0) {
      if (dot) dot.remove();
      btn.title = PANEL_TITLE;
      btn.setAttribute('aria-label', tr('rail.toggleAria'));
      return;
    }
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'fbtn-badge';
      btn.appendChild(dot);
    }
    dot.textContent = attention > 9 ? '9+' : String(attention);
    const noun = attention === 1 ? tr('rail.needs.one') : tr('rail.needs.many', { n: attention });
    btn.title = tr('rail.needs.open', { noun: noun });
    btn.setAttribute('aria-label', tr('rail.needs.openAria', { noun: noun }));
  };
  const applyRb = () => {
    document.body.classList.toggle('rb-collapsed', collapsed);
    const btn = document.getElementById('fnPanel');
    if (btn) btn.classList.toggle('active', collapsed);
    syncBadge();
  };
  applyRb();
  const panelBtn = document.getElementById('fnPanel');
  if (panelBtn) panelBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    touched = true;
    try {
      localStorage.setItem('lisaRightbar', collapsed ? 'collapsed' : 'open');
      localStorage.setItem('lisaRightbarTouched', '1');
    } catch (e) {}
    applyRb();
  });
  // Called from the "needs you" renderer on every roster tick.
  window.lisaRightbarAttention = function (count, needsDecision) {
    attention = count > 0 ? count : 0;
    // One nudge per page load, and only for someone who has never expressed a
    // preference: a blocked agent is worth stealing 320px for exactly once.
    // Deliberately NOT persisted — the next reload returns to the collapsed
    // default, so this can never become a sticky layout the user didn't pick.
    if (needsDecision && collapsed && !touched && !autoExpanded) {
      autoExpanded = true;
      collapsed = false;
    }
    applyRb();
  };
}

let currentLisaSpan = null;
let pendingTools = new Map();
let thinkingEl = null;
// Bumped by lisaResetChatLog on every session switch; runChat captures the
// value at send time and stops rendering once it goes stale.
let chatGeneration = 0;

// UX-11: the inspector showed the full absolute cwd (90+ chars on this
// machine), which ellipsised into uselessness in a 320px rail. No regex —
// this file is a template literal and every backslash would need doubling.
function abbrevPath(p) {
  var s = String(p || '');
  var roots = ['/Users/', '/home/'];
  for (var i = 0; i < roots.length; i++) {
    if (s.indexOf(roots[i]) !== 0) continue;
    var rest = s.slice(roots[i].length);
    var slash = rest.indexOf('/');
    if (slash < 0) return '~';          // the home directory itself
    return '~' + rest.slice(slash);
  }
  return s;
}
// A small "Copy" button that reverts its own label. Used by the inspector and
// anywhere else a long unselectable value needs to be liftable.
function copyButton(getText, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls || 'copy-btn';
  b.textContent = tr('copy');
  b.addEventListener('click', function (ev) {
    ev.stopPropagation();
    const text = typeof getText === 'function' ? getText() : String(getText || '');
    if (!text) return;
    const done = function () {
      b.textContent = tr('copied');
      setTimeout(function () { b.textContent = tr('copy'); }, 1200);
    };
    try {
      navigator.clipboard.writeText(text).then(done).catch(function () {});
    } catch (e) {}
  });
  return b;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  // The first thing appended to the log retires the empty-state card, so a
  // reply never renders underneath "Say anything — or start here:".
  removeChatEmpty();
  log.appendChild(node);
  log.scrollTop = log.scrollHeight;
  return node;
}

// Screen-reader status for the chat (the #chatStatus aria-live region in the
// shell). Coarse turn state only — never the streamed text, which would be
// re-announced on every paint.
function setChatStatus(text) {
  const s = document.getElementById('chatStatus');
  if (s) s.textContent = text || '';
}

function ensureLisaSpan() {
  if (currentLisaSpan) return currentLisaSpan;
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  el('div', 'role lisa', 'LISA');
  currentLisaSpan = el('span', 'msg', '');
  setChatStatus(tr('chat.replying'));
  return currentLisaSpan;
}

// ── live Markdown render for Lisa's streaming bubble ─────────────────
// Lisa streams standard Markdown. Accumulate the raw text on the span
// (span._md) and re-render it to HTML with the source-injected renderMarkdown
// (defined just above this script in lisa-html.ts), throttled to one paint per
// animation frame so long replies stay smooth. flushLisaRender() forces a
// final synchronous paint at segment/turn boundaries so nothing is left
// half-parsed (e.g. an as-yet-unclosed code fence).
let mdFrame = 0;
function paintLisaSpan() {
  if (currentLisaSpan && currentLisaSpan._md != null) {
    currentLisaSpan.innerHTML = renderMarkdown(currentLisaSpan._md);
    log.scrollTop = log.scrollHeight;
  }
}
function scheduleLisaRender() {
  if (mdFrame) return;
  mdFrame = requestAnimationFrame(function () { mdFrame = 0; paintLisaSpan(); });
}
function flushLisaRender() {
  if (mdFrame) { cancelAnimationFrame(mdFrame); mdFrame = 0; }
  paintLisaSpan();
}

// Copy button on rendered code blocks. Event-delegated on the log container so
// it keeps working across the streaming bubble's innerHTML re-renders.
log.addEventListener('click', function (e) {
  const btn = (e.target && e.target.closest) ? e.target.closest('.md-copy') : null;
  if (!btn) return;
  const block = btn.closest('.md-code');
  const pre = block ? block.querySelector('pre') : null;
  if (!pre) return;
  navigator.clipboard.writeText(pre.textContent || '').then(function () {
    const prev = btn.textContent;
    btn.textContent = 'copied';
    setTimeout(function () { btn.textContent = prev; }, 1200);
  }).catch(function () {});
});

function previewInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const order = ['command', 'pattern', 'query', 'path', 'description', 'audio_path', 'text', 'name', 'action', 'entry'];
  for (const k of order) {
    if (typeof input[k] === 'string' && input[k]) {
      let v = input[k].replace(/\s+/g, ' ').trim();
      if (v.length > 120) v = v.slice(0, 117) + '...';
      return v;
    }
  }
  try {
    const s = JSON.stringify(input);
    return s.length > 120 ? s.slice(0, 117) + '...' : s;
  } catch { return ''; }
}

async function send(message) {
  input.value = '';
  input.style.height = 'auto';
  el('div', 'role you', 'YOU');
  el('span', 'msg', message || '(attachment)');
  if (pendingFiles.length) {
    const names = pendingFiles.map(f => f.name).join(', ');
    el('span', 'msg attach-label', '📎 ' + names);
  }
  const filesToSend = [...pendingFiles];
  pendingFiles = [];
  renderAttachPreview();
  maybeOfferKbIngest(message);
  await runChat(message, filesToSend);
}

// ── chat → KB: a bare URL in the user's message gets a one-tap save-to-KB
//    chip under the bubble; it calls the same /api/kb/ingest the KB view uses.
function maybeOfferKbIngest(message) {
  if (!message) return;
  var m = message.match(/https?:\/\/[^\s<>"')\]]+/);
  if (!m) return;
  var url = m[0].replace(/[.,;:!?。，；：、]+$/, '');
  var chip = el('div', 'kb-ingest-chip', null);
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'kb-ingest-btn';
  btn.textContent = tr('kb.save');
  chip.appendChild(btn);
  btn.addEventListener('click', function () {
    btn.disabled = true;
    btn.textContent = tr('kb.saving');
    fetch('/api/kb/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: url }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) {
          btn.textContent = d.deduped ? tr('kb.exists') : tr('kb.saved');
          if (typeof window.lisaReloadKb === 'function') window.lisaReloadKb();
        } else {
          btn.disabled = false;
          btn.textContent = tr('kb.save');
          if (typeof window.lisaKbToast === 'function') window.lisaKbToast((d && d.error) ? d.error : tr('kb.failed'));
        }
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = tr('kb.save');
        if (typeof window.lisaKbToast === 'function') window.lisaKbToast(tr('kb.failed'));
      });
  });
}

// On failure, show the error detail with a retry button that re-runs the same
// turn. Kept separate from send() so retry never re-appends the user's bubble
// or re-reads the (already-cleared) attachment tray.
function showError(detail, message, filesToSend) {
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  const block = el('div', 'err-block', null);
  const head = document.createElement('div');
  head.className = 'err-head';
  head.textContent = tr('err.request');
  block.appendChild(head);
  const body = document.createElement('div');
  body.className = 'err-detail';
  body.textContent = detail || 'unknown error';
  block.appendChild(body);
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'err-retry';
  retry.textContent = tr('err.retry');
  retry.addEventListener('click', () => {
    block.remove();
    runChat(message, filesToSend);
  });
  block.appendChild(retry);
  log.scrollTop = log.scrollHeight;
}

async function runChat(message, filesToSend) {
  sendBtn.disabled = true;
  const gen = chatGeneration;
  // F6 — bind this turn to the session it was sent from: the server routes
  // it to that session's own ctx, so turns in different sessions run
  // concurrently and this reply always persists into the right transcript.
  const sid = window.lisaActiveSessionId || null;
  currentLisaSpan = null;
  pendingTools.clear();
  thinkingEl = el('div', 'thinking', '⋯ thinking');
  setChatStatus(tr('chat.thinking'));
  // UX-10: /chat answers within a few hundred ms normally. If two seconds
  // pass with no frame at all, the backend is busy or stalled — say so on the
  // same line rather than leaving "⋯ thinking" to mean both.
  let sawFrame = false;
  let waitTimer = setTimeout(function () {
    if (sawFrame || gen !== chatGeneration || !thinkingEl) return;
    thinkingEl.classList.add('waiting');
    thinkingEl.textContent = tr('chat.waiting');
  }, 2000);
  const noteFrame = () => {
    if (sawFrame) return;
    sawFrame = true;
    clearTimeout(waitTimer);
    if (thinkingEl && thinkingEl.classList.contains('waiting')) {
      thinkingEl.classList.remove('waiting');
      thinkingEl.textContent = '⋯ thinking';
    }
  };
  // The agent emits an error event AND the server re-sends it from its turn
  // catch — dedupe so one failure renders exactly one error block.
  let errored = false;
  const fail = (detail) => {
    if (errored || gen !== chatGeneration) return;
    errored = true;
    setChatStatus(tr('chat.failed'));
    showError(detail, message, filesToSend);
  };
  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({message, files: filesToSend, sessionId: sid, expressions: true}),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      buf += decoder.decode(value, {stream: true});
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const evRaw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const m = evRaw.match(/^data: (.*)$/m);
        if (!m) continue;
        const ev = JSON.parse(m[1]);
        noteFrame();
        // Stale generation (the user switched sessions mid-reply): drain the
        // stream without touching the DOM; the reply persists server-side.
        if (gen !== chatGeneration) continue;
        if (ev.type === 'text') {
          const span = ensureLisaSpan();
          span._md = (span._md || '') + ev.text;
          scheduleLisaRender();
        } else if (ev.type === 'tool_start') {
          if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
          flushLisaRender();
          currentLisaSpan = null;
          const block = el('div', 'tool-block', null);
          const head = document.createElement('div');
          head.className = 'tool-head';
          head.innerHTML = '<span class="tool-icon">⚙</span> <span class="tool-name"></span> <span class="tool-spinner">...</span>';
          head.querySelector('.tool-name').textContent = ev.name;
          block.appendChild(head);
          const preview = previewInput(ev.name, ev.input);
          if (preview) {
            const p = document.createElement('div');
            p.className = 'tool-input';
            p.textContent = preview;
            block.appendChild(p);
          }
          pendingTools.set(ev.name, block);
        } else if (ev.type === 'tool_end') {
          const block = pendingTools.get(ev.name);
          if (block) {
            const spinner = block.querySelector('.tool-spinner');
            if (spinner) spinner.textContent = ev.isError ? '✗' : '✓';
            if (ev.isError) block.classList.add('tool-error');
            if (ev.resultPreview) {
              const r = document.createElement('div');
              r.className = 'tool-result';
              r.textContent = ev.resultPreview;
              block.appendChild(r);
            }
            pendingTools.delete(ev.name);
          }
        } else if (ev.type === 'expression') {
          flushLisaRender();
          if (ev.expression && !log.querySelector('[data-expression-id="' + CSS.escape(ev.expression.id) + '"]')) log.appendChild(window.LisaExpressions.create(ev.expression, true));
          void window.LisaExpressions.refresh();
          log.scrollTop = log.scrollHeight;
        } else if (ev.type === 'mood') {
          setMood(ev.slug);
        } else if (ev.type === 'error') {
          fail(ev.message);
        } else if (ev.type === 'done') {
          if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
          flushLisaRender();
          setChatStatus(tr('chat.done'));
        }
      }
    }
    if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  } catch (err) {
    fail(err.message);
  } finally {
    // The turn is over one way or another — never let the 2s escalation fire
    // onto a finished (or failed) turn.
    clearTimeout(waitTimer);
    sendBtn.disabled = false;
    void githubRefresh();
    // A completed reply must not reopen a dismissed phone keyboard.
    if (!window.matchMedia('(max-width: 720px)').matches) input.focus();
    // F6 — a reply that finished after its session was switched away:
    // refresh if the user is back on that session, else mark it unread.
    if (gen !== chatGeneration && sid) {
      if (sid === window.lisaActiveSessionId) {
        if (typeof window.lisaResetChatLog === 'function') window.lisaResetChatLog();
      } else if (typeof window.lisaMarkUnread === 'function') {
        window.lisaMarkUnread(sid);
      }
    }
  }
}

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const msg = input.value.trim();
  if (msg || pendingFiles.length) send(msg);
});

input.addEventListener('keydown', (ev) => {
  // Enter sends — but NEVER while an IME composition is active (Chinese /
  // Japanese / Korean input). That Enter is confirming a candidate from the
  // IME popup, not sending the message. isComposing covers modern browsers;
  // keyCode 229 is the legacy signal some IMEs still fire on the confirming key.
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) {
    ev.preventDefault();
    form.dispatchEvent(new Event('submit'));
  }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
});

// ── KB capture: select chat messages → save to the knowledge base ────
// (docs/archive/plans/PLAN_KNOWLEDGE_BASE_v1.0.md, requirement #2). Toggle select mode from
// the function bar, tick messages, "Add to KB" writes a Layer-1 source verbatim.
(function kbCapture() {
  var toggle = document.getElementById('fnKbSelect');
  var log = document.getElementById('log');
  if (!toggle || !log) return;
  var selecting = false;
  var bar = null;

  function selectedMsgs() { return log.querySelectorAll('.msg.kb-sel'); }
  function updateCount() {
    var n = selectedMsgs().length;
    var c = document.getElementById('kbCapCount');
    if (c) c.textContent = n + ' selected';
    var add = document.getElementById('kbCapAdd');
    if (add) add.disabled = n === 0;
  }
  function clearSel() {
    var s = log.querySelectorAll('.msg.kb-sel');
    for (var i = 0; i < s.length; i++) s[i].classList.remove('kb-sel');
  }
  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'kbCaptureBar';
    bar.className = 'kb-capture-bar';
    bar.innerHTML = '<input id="kbCapTitle" class="kb-cap-title" type="text" placeholder="Title (optional)" autocomplete="off">'
      + '<span id="kbCapCount" class="kb-cap-count">0 selected</span>'
      + '<button type="button" id="kbCapAdd" class="kb-cap-add">Add to KB</button>'
      + '<button type="button" id="kbCapCancel" class="kb-cap-cancel">Cancel</button>';
    document.body.appendChild(bar);
    document.getElementById('kbCapCancel').addEventListener('click', function () { setSelecting(false); });
    document.getElementById('kbCapAdd').addEventListener('click', doAdd);
    return bar;
  }
  function setSelecting(on) {
    selecting = on;
    log.classList.toggle('kb-selecting', on);
    toggle.classList.toggle('active', on);
    if (on) { ensureBar().classList.add('open'); updateCount(); }
    else { clearSel(); if (bar) bar.classList.remove('open'); }
  }
  toggle.addEventListener('click', function () { setSelecting(!selecting); });
  log.addEventListener('click', function (e) {
    if (!selecting) return;
    var msg = e.target && e.target.closest ? e.target.closest('.msg') : null;
    if (!msg || !log.contains(msg)) return;
    e.preventDefault();
    msg.classList.toggle('kb-sel');
    updateCount();
  });
  function roleOf(msgEl) {
    var prev = msgEl.previousElementSibling;
    while (prev && !(prev.classList && prev.classList.contains('role'))) prev = prev.previousElementSibling;
    return prev ? (prev.textContent || '').trim() : '';
  }
  function doAdd() {
    var msgs = selectedMsgs();
    if (!msgs.length) return;
    var parts = [];
    for (var i = 0; i < msgs.length; i++) {
      var role = roleOf(msgs[i]) || 'MESSAGE';
      parts.push('**' + role + ':** ' + (msgs[i].textContent || ''));
    }
    var content = parts.join('\n\n');
    var titleEl = document.getElementById('kbCapTitle');
    var title = titleEl ? titleEl.value.trim() : '';
    var add = document.getElementById('kbCapAdd');
    if (add) { add.disabled = true; add.textContent = 'Saving…'; }
    fetch('/api/kb/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: title, content: content, origin: 'chat', tags: [] }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (add) add.textContent = 'Add to KB';
        if (titleEl) titleEl.value = '';
        setSelecting(false);
        if (typeof window.lisaReloadKb === 'function') window.lisaReloadKb();
        kbToast(d && d.ok ? 'Saved to Knowledge Base' : 'Save failed');
      })
      .catch(function () { if (add) { add.disabled = false; add.textContent = 'Add to KB'; } kbToast('Save failed'); });
  }
  function kbToast(msg) {
    var t = document.createElement('div');
    t.className = 'kb-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, 2200);
  }
  // Shared with the chat-bubble ingest chip (defined outside this closure).
  window.lisaKbToast = kbToast;
})();

// ── PWA: register service worker + iOS install hint ─────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('[pwa] sw register failed:', err);
  });
}
(function() {
  const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator).standalone === true;
  if (!isiOS || isStandalone) return;
  if (localStorage.getItem('lisa.pwa.dismissed') === '1') return;
  setTimeout(() => {
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;bottom:8px;left:8px;right:8px;background:var(--bg-card-strong);border:1px solid var(--border-strong);border-radius:12px;padding:10px 12px;color:var(--fg);font-size:12px;z-index:9999;display:flex;gap:8px;align-items:center;';
    banner.innerHTML = '✦ Add Lisa to Home Screen: Share button → "Add to Home Screen"';
    const dismiss = document.createElement('button');
    dismiss.textContent = '✕';
    dismiss.style.cssText = 'background:transparent;border:none;color:var(--fg-2);cursor:pointer;font-size:14px;margin-left:auto;';
    dismiss.onclick = () => {
      localStorage.setItem('lisa.pwa.dismissed', '1');
      banner.remove();
    };
    banner.appendChild(dismiss);
    document.body.appendChild(banner);
  }, 5000);
})();

// ════════════════════════════════════════════════════════════════════
// ── Sidebar live wiring ─────────────────────────────────────────────
//
// Populates the new sidebar blocks introduced by the redesign:
//   - identity card sub-line (born YYYY-MM-DD · NN days)
//   - "currently wanting" paragraph (top actionable desire)
//   - Claude Code monitor card (active sessions)
//   - "last reflection" mini-card (most recent ★ idle message)
// Wires to /api/island/ping + /api/claude/sessions + /api/soul, and
// piggy-backs on the connectEvents() SSE listener above for live
// claude_session_update + idle_message refreshes.
// ════════════════════════════════════════════════════════════════════
(function setupSidebarLive() {
  const sbDesire = document.getElementById('sbDesire');
  const sbClaudeCount = document.getElementById('sbClaudeCount');
  const sbClaudeRows = document.getElementById('sbClaudeRows');
  const sbReflection = document.getElementById('sbReflection');
  const sbReflectionBody = document.getElementById('sbReflectionBody');
  const sbSessionBadge = document.getElementById('sbSessionBadge');
  const identitySub = document.getElementById('identitySub');

  // Active session window matches the watcher's ACTIVE_WINDOW_MS.
  const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

  function relativeTime(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 30_000)    return 'just now';
    if (ms < 60_000)    return Math.round(ms / 1000) + 's';
    if (ms < 3600_000)  return Math.round(ms / 60_000) + 'm';
    if (ms < 86400_000) return Math.round(ms / 3600_000) + 'h';
    return Math.round(ms / 86400_000) + 'd';
  }

  function setDesire(text) {
    sbDesire.textContent = text || '(nothing actively pursued)';
    sbDesire.title = text || '';
  }

  window.updateReflection = function (text) {
    if (!text) { sbReflection.style.display = 'none'; return; }
    sbReflection.style.display = '';
    sbReflectionBody.textContent = '"' + text.replace(/^["“”]+|["“”]+$/g, '').trim() + '"';
  };

  // Compact one-line activity summary — mirrors agent-roster.ts formatActivity
  // (kept inline because this client script is a no-interpolation template
  // literal; the island uses the source-injected shared version).
  function sbActivity(s) {
    const a = s.activity;
    if (!a || typeof a !== 'object') return '';
    if (a.pendingPermission) return '⚠ wants to run ' + a.pendingPermission;
    const bits = [];
    if (a.lastError) bits.push('✗ ' + a.lastError);
    const prog = [];
    if (typeof a.turnCount === 'number' && a.turnCount > 0) prog.push('turn ' + a.turnCount);
    if (a.tokens && (a.tokens.input || a.tokens.output)) {
      const tot = (a.tokens.input || 0) + (a.tokens.output || 0);
      prog.push(tot >= 1000 ? Math.round(tot / 1000) + 'k tok' : tot + ' tok');
    }
    if (prog.length) bits.push(prog.join(' '));
    if (a.lastCommandName) bits.push('$ ' + a.lastCommandName);
    const tool = a.lastTools && a.lastTools.length ? a.lastTools[a.lastTools.length - 1] : '';
    const file = a.filesTouched && a.filesTouched.length ? (String(a.filesTouched[a.filesTouched.length - 1]).split('/').pop() || '') : '';
    if (tool && file) bits.push(tool + ' ' + file);
    else if (tool) bits.push(tool);
    else if (file) bits.push(file);
    return bits.join(' · ');
  }

  // POST a control action to the right agent family (managed|pty), then refresh.
  function agentAction(fam, id, action, body) {
    fetch('/api/agents/' + fam + '/' + encodeURIComponent(id) + '/' + action, {
      method: 'POST',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function () {
      if (typeof refreshClaudeSessions === 'function') refreshClaudeSessions();
    }).catch(function () {});
  }

  // Show a PTY agent's captured terminal tail in the modal — explicit + on
  // demand (it's content, so it's never folded into the structural roster).
  function ptyOutput(id) {
    fetch('/api/agents/pty/' + encodeURIComponent(id) + '/output').then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (d) {
      if (!d) return;
      openModal('agent output', '<pre>' + escapeHtml(d.output || '(no output yet)') + '</pre>');
    }).catch(function () {});
  }

  // ── Agent roster → tree + inspector (PLAN_UI_SESSION_SHELL_v1.0 §1.3/§3.1)
  // The right panel's row list became a single INSPECTOR card for the session
  // selected in the sidebar tree; the roster itself now lives in the tree as
  // per-agent root groups (LISA / Claude Code / Codex … same-level siblings),
  // grouped agent kind → project → session.
  let cachedAgents = [];
  // {type:'agent', key} | {type:'lisa', id} | null (null → auto: the
  // top-ranked live agent, else the active Lisa session).
  let selInsp = null;
  // Collapse state survives the 60s re-renders (keyed group → closed?).
  const collapsedKeys = {};
  function applyCollapsed(el, key) {
    if (collapsedKeys[key]) el.classList.add('closed');
  }
  function toggleCollapsed(el, key) {
    el.classList.toggle('closed');
    collapsedKeys[key] = el.classList.contains('closed');
  }
  function agentKey(s) { return s.agent + '/' + s.sessionId; }
  function agentByKey(key) {
    for (let i = 0; i < cachedAgents.length; i++) {
      if (agentKey(cachedAgents[i]) === key) return cachedAgents[i];
    }
    return null;
  }
  // Label by git branch when available (more meaningful than a worktree
  // hash), stripping the claude/ prefix; fall back to the project name.
  // (String ops, not a regex — a /// here would be mangled by the outer
  // template literal that wraps this client script.)
  function agentLabel(s) {
    const custom = customSessionName('agent/' + s.agent, s.sessionId);
    if (custom) return custom;
    if (s.agent === 'codex') return s.displayName || (s.project || 'Codex') + ' · ' + s.sessionId.slice(-8);
    let label = s.project;
    if (s.activity && s.activity.gitBranch) {
      const br = String(s.activity.gitBranch);
      label = br.indexOf('claude/') === 0 ? br.slice(7) : br;
    }
    return label;
  }
  window.lisaAgentLabel = agentLabel;
  const AGENT_NAMES = {
    'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode',
    aider: 'Aider', 'github-pr': 'GitHub PR', cursor: 'Cursor',
    gemini: 'Gemini', lisa: 'LISA agents', mcp: 'MCP',
  };
  function agentGlyphClass(kind) {
    if (kind === 'lisa') return 'lisa';
    if (kind === 'claude-code') return 'cc';
    if (kind === 'codex') return 'codex';
    return 'other';
  }

  function setAgentGlyph(el, kind, fallback) {
    const icons = { lisa: 'lisa', cc: 'claude', 'claude-code': 'claude', codex: 'codex' };
    el.textContent = '';
    el.setAttribute('aria-hidden', 'true');
    const asset = icons[kind];
    if (!asset) { el.textContent = fallback || 'A'; return; }
    const img = document.createElement('img');
    img.src = '/assets/agents/' + asset + '.webp';
    img.alt = '';
    img.draggable = false;
    img.onerror = () => { el.textContent = fallback || 'A'; };
    el.appendChild(img);
  }

  function setClaudeSessions(sessions) {
    const cutoff = Date.now() - ACTIVE_WINDOW_MS;
    const recent = sessions.filter(s => new Date(s.lastMtime).getTime() >= cutoff);
    sbClaudeCount.textContent = String(recent.length);
    // sort: errors first, then waiting, then working, then by mtime
    const rank = { error: 0, waiting: 1, working: 2, unknown: 3 };
    cachedAgents = recent.slice().sort((a, b) => {
      const ra = rank[a.state] ?? 9;
      const rb = rank[b.state] ?? 9;
      if (ra !== rb) return ra - rb;
      return new Date(b.lastMtime).getTime() - new Date(a.lastMtime).getTime();
    });
    // First roster snapshot: honor a #agent=kind/id deep link (F5).
    if (typeof window.lisaHandleAgentHashOnce === 'function') window.lisaHandleAgentHashOnce();
    renderSessionTree();
    renderNeeds();
    renderInspector();
    // Live refresh for an open stream tab (head/perm/foot reflect the
    // newest snapshot; steps repoll on their own timer too).
    if (currentAgentTab) renderStreamView();
  }

  // ── "Needs you" rail section (确认轮二) — every agent decision waiting
  // on the user, actionable inline: approve/deny a pending permission, or
  // jump straight into the read-only stream of a waiting/errored session.
  function renderNeeds() {
    const rows = document.getElementById('sbNeedsRows');
    const count = document.getElementById('sbNeedsCount');
    if (!rows) return;
    rows.innerHTML = '';
    const needs = cachedAgents.filter(function (s) {
      return (s.activity && s.activity.pendingPermission) || s.state === 'waiting' || s.state === 'error';
    });
    if (count) {
      // The count is an aria-live region: the number plus a visually hidden
      // noun so a screen reader hears "2 agents need you", not just "2".
      count.textContent = '';
      if (needs.length) {
        count.appendChild(document.createTextNode(String(needs.length)));
        const sr = document.createElement('span');
        sr.className = 'sr-only';
        // The visible node already carries the number — the hidden part is
        // just the unit, so a reader hears "2 agents need you", not "2 2 …".
        sr.textContent = ' ' + tr(needs.length === 1 ? 'rail.needs.unit.one' : 'rail.needs.unit.many');
        count.appendChild(sr);
      }
    }
    // UX-5: mirror the count onto the collapsed rail's toggle, and let the
    // rail open itself the first time something is actually blocked on the
    // user. An "error" agent is reported but does NOT trigger the expand —
    // only a decision waiting to be made does.
    if (typeof window.lisaRightbarAttention === 'function') {
      window.lisaRightbarAttention(needs.length, needs.some(function (s) {
        return (s.activity && s.activity.pendingPermission) || s.state === 'waiting';
      }));
    }
    if (!needs.length) {
      const ok = document.createElement('div');
      ok.className = 'session-empty';
      ok.textContent = 'all clear ✓';
      rows.appendChild(ok);
      return;
    }
    needs.slice(0, 6).forEach(function (s) {
      const row = document.createElement('div');
      row.className = 'needs-row';
      row.innerHTML = '<span class="pip"></span><span class="nr-main"><span class="nr-name"></span><span class="nr-sub"></span></span>';
      const st = s.state || 'unknown';
      if (st === 'working' || st === 'waiting' || st === 'error') row.querySelector('.pip').classList.add(st);
      row.querySelector('.nr-name').textContent = agentLabel(s);
      const pend = s.activity && s.activity.pendingPermission;
      row.querySelector('.nr-sub').textContent = pend ? ('⚠ ' + pend) : (s.stateReason || s.state);
      row.title = (AGENT_NAMES[s.agent] || s.agent) + ' · ' + s.project + ' · ' + s.sessionId;
      row.setAttribute('data-agent', s.agent);
      row.setAttribute('data-session', s.sessionId);
      const acts = document.createElement('span');
      acts.className = 'session-ctrl nr-acts';
      if (s.controllable === 'managed' && pend) {
        const ap = document.createElement('button');
        ap.className = 'mc approve'; ap.textContent = '✓'; ap.title = 'Approve';
        ap.setAttribute('data-act', 'approve'); ap.setAttribute('data-approval', s.activity.approvalId || '');
        const dn = document.createElement('button');
        dn.className = 'mc deny'; dn.textContent = '✕'; dn.title = 'Deny';
        dn.setAttribute('data-act', 'deny'); dn.setAttribute('data-approval', s.activity.approvalId || '');
        acts.appendChild(ap); acts.appendChild(dn);
      } else {
        const open = document.createElement('button');
        open.className = 'mc'; open.textContent = '▤'; open.title = 'Open the read-only stream';
        open.setAttribute('data-act', 'stream');
        acts.appendChild(open);
      }
      row.appendChild(acts);
      rows.appendChild(row);
    });
  }

  // ── Tree view mode (F3): group by agent kind (default) or by project ──
  let treeMode = 'agent';
  try { treeMode = localStorage.getItem('lisaTreeMode') === 'project' ? 'project' : 'agent'; } catch (e) {}
  const treeModeBtn = document.getElementById('sbTreeMode');
  function syncTreeModeBtn() {
    if (!treeModeBtn) return;
    treeModeBtn.classList.toggle('on', treeMode === 'project');
    treeModeBtn.title = treeMode === 'project' ? 'Grouped by project — click for agent view' : 'Grouped by agent — click for project view';
  }
  syncTreeModeBtn();
  if (treeModeBtn) treeModeBtn.addEventListener('click', function () {
    treeMode = treeMode === 'project' ? 'agent' : 'project';
    try { localStorage.setItem('lisaTreeMode', treeMode); } catch (e) {}
    syncTreeModeBtn();
    renderSessionTree();
  });
  function lisaProjectOf(s) {
    const c = s.cwd || '';
    const base = c.split('/').pop();
    return base || c || '?';
  }

  // Shared leaf builders (both tree modes). withGlyph adds a mini source
  // glyph in project view where Lisa and agent sessions sit side by side.
  // NOTE (真实E2E修复): tree/needs/inspector rebuild on every roster tick,
  // so per-node listeners kept landing real clicks on freshly-replaced dead
  // elements. All click handling is DELEGATED to the stable containers —
  // nodes only carry data-* attributes.
  function makeLisaLeaf(s, withGlyph) {
    const isActive = s.id === window.lisaActiveSessionId;
    const leaf = document.createElement('button');
    leaf.type = 'button';
    leaf.className = 'tleaf' + (isActive ? ' active' : '') + (window.lisaIsUnread && window.lisaIsUnread(s.id) ? ' unread' : '');
    leaf.innerHTML = '<span class="pip"></span>' + (withGlyph ? '<span class="agent-glyph mini lisa">L</span>' : '') + '<span class="tname"></span><span class="ttime"></span>';
    if (isActive) leaf.querySelector('.pip').classList.add('live');
    leaf.querySelector('.tname').textContent = sessionLabel(s);
    if (withGlyph) setAgentGlyph(leaf.querySelector('.agent-glyph'), 'lisa', 'L');
    leaf.querySelector('.ttime').textContent = relativeTime(s.startedAt);
    leaf.title = sessionLabel(s) + ' · ' + tr('session.renameHint') + '\n' + s.id;
    leaf.setAttribute('aria-haspopup', 'menu');
    leaf.setAttribute('data-lisa-id', s.id);
    return leaf;
  }
  function makeAgentLeaf(s, withGlyph) {
    const key = agentKey(s);
    const leaf = document.createElement('button');
    leaf.type = 'button';
    leaf.className = 'tleaf' + (selInsp && selInsp.type === 'agent' && selInsp.key === key ? ' active' : '');
    leaf.innerHTML = '<span class="pip"></span>' + (withGlyph ? '<span class="agent-glyph mini"></span>' : '') + '<span class="tname"></span><span class="ttime"></span>';
    const st = s.state || 'unknown';
    if (st === 'working' || st === 'waiting' || st === 'error') leaf.querySelector('.pip').classList.add(st);
    if (withGlyph) {
      const g = leaf.querySelector('.agent-glyph');
      const kindName = AGENT_NAMES[s.agent] || s.agent;
      g.classList.add(agentGlyphClass(s.agent));
      setAgentGlyph(g, s.agent, (kindName.charAt(0) || 'A').toUpperCase());
    }
    leaf.querySelector('.tname').textContent = agentLabel(s);
    leaf.querySelector('.ttime').textContent = relativeTime(s.lastMtime);
    leaf.title = agentLabel(s) + ' · ' + (s.stateReason ? s.state + ' · ' + s.stateReason : s.state) + ' · ' + s.project + ' · ' + s.sessionId;
    leaf.setAttribute('data-agent', s.agent);
    leaf.setAttribute('data-session', s.sessionId);
    leaf.setAttribute('aria-haspopup', 'menu');
    return leaf;
  }

  // F3 project view: roots = projects, children = that project's Lisa
  // sessions + agent sessions side by side (mini glyphs mark the source).
  function buildProjectTree(tree) {
    const projects = [];
    const byProject = Object.create(null);
    function bucket(p) {
      if (!byProject[p]) { byProject[p] = { lisa: [], agents: [] }; projects.push(p); }
      return byProject[p];
    }
    cachedSessions.slice(0, 30).forEach(function (s) { bucket(lisaProjectOf(s)).lisa.push(s); });
    cachedAgents.forEach(function (s) { bucket(s.project || '?').agents.push(s); });
    projects.sort(function (a, b) { return a.localeCompare(b); });
    projects.forEach(function (p) {
      const group = document.createElement('div');
      group.className = 'tgroup';
      const key = 'p:' + p;
      applyCollapsed(group, key);
      const root = document.createElement('button');
      root.type = 'button';
      root.className = 'tnode';
      root.innerHTML = '<span class="twist">▾</span><span class="tlabel"></span><span class="tcount"></span>';
      root.querySelector('.tlabel').textContent = p;
      root.querySelector('.tcount').textContent = String(byProject[p].lisa.length + byProject[p].agents.length);
      root.setAttribute('data-toggle', key);
      group.appendChild(root);
      const kids = document.createElement('div');
      kids.className = 'tchildren';
      byProject[p].lisa.forEach(function (s) { kids.appendChild(makeLisaLeaf(s, true)); });
      byProject[p].agents.forEach(function (s) { kids.appendChild(makeAgentLeaf(s, true)); });
      group.appendChild(kids);
      tree.appendChild(group);
    });
  }

  // Sidebar tree: one root group per live agent kind, then project sub-groups,
  // then session leaves. Idempotent — removes its own groups before rebuilding
  // (the LISA group is owned by renderSessionTree below).
  function renderAgentTree() {
    const tree = document.getElementById('sessionTree');
    if (!tree) return;
    const olds = tree.querySelectorAll('.tgroup.agent-group');
    for (let i = 0; i < olds.length; i++) olds[i].remove();
    const kinds = [];
    const byKind = {};
    cachedAgents.forEach(function (s) {
      if (!byKind[s.agent]) { byKind[s.agent] = []; kinds.push(s.agent); }
      byKind[s.agent].push(s);
    });
    kinds.sort();
    kinds.forEach(function (kind) {
      const group = document.createElement('div');
      group.className = 'tgroup agent-group';
      applyCollapsed(group, 'agent:' + kind);
      const root = document.createElement('button');
      root.type = 'button';
      root.className = 'tnode';
      root.innerHTML = '<span class="twist">▾</span><span class="agent-glyph"></span><span class="tlabel"></span><span class="tcount"></span>';
      const kindName = AGENT_NAMES[kind] || kind;
      const glyph = root.querySelector('.agent-glyph');
      glyph.classList.add(agentGlyphClass(kind));
      setAgentGlyph(glyph, kind, (kindName.charAt(0) || 'A').toUpperCase());
      root.querySelector('.tlabel').textContent = kindName;
      root.querySelector('.tcount').textContent = String(byKind[kind].length);
      root.setAttribute('data-toggle', 'agent:' + kind);
      group.appendChild(root);
      const kids = document.createElement('div');
      kids.className = 'tchildren';
      const projects = [];
      const byProject = Object.create(null);
      byKind[kind].forEach(function (s) {
        const p = s.project || '?';
        if (!byProject[p]) { byProject[p] = []; projects.push(p); }
        byProject[p].push(s);
      });
      projects.forEach(function (p) {
        const sub = document.createElement('div');
        sub.className = 'tsub';
        const subKey = 'proj:' + kind + '/' + p;
        applyCollapsed(sub, subKey);
        const pn = document.createElement('button');
        pn.type = 'button';
        pn.className = 'tnode';
        pn.innerHTML = '<span class="twist">▾</span><span class="tlabel"></span>';
        pn.querySelector('.tlabel').textContent = p;
        pn.setAttribute('data-toggle', subKey);
        sub.appendChild(pn);
        const pkids = document.createElement('div');
        pkids.className = 'tchildren';
        byProject[p].forEach(function (s) { pkids.appendChild(makeAgentLeaf(s, false)); });
        sub.appendChild(pkids);
        kids.appendChild(sub);
      });
      group.appendChild(kids);
      tree.appendChild(group);
    });
  }

  // ── Inspector card builders ─────────────────────────────────────────
  function inspRow(label, value, cls) {
    const row = document.createElement('div');
    row.className = 'kvrow' + (cls ? ' ' + cls : '');
    const k = document.createElement('span');
    k.textContent = label;
    const v = document.createElement('code');
    v.textContent = value;
    v.title = value;
    row.appendChild(k);
    row.appendChild(v);
    return row;
  }
  // Same row, but the value is a filesystem path: shown as ~/…, full path in
  // the tooltip, and liftable with one click (UX-11).
  function inspPathRow(label, value) {
    const row = inspRow(label, abbrevPath(value));
    const code = row.querySelector('code');
    if (code) code.title = value;
    const copy = copyButton(function () { return value; }, 'copy-btn kv-copy');
    copy.title = tr('copyPath');
    copy.setAttribute('aria-label', tr('copyPath'));
    row.appendChild(copy);
    return row;
  }
  function inspStat(value, label) {
    const st = document.createElement('div');
    st.className = 'stat';
    const b = document.createElement('b');
    b.textContent = value;
    b.title = value;
    const sp = document.createElement('span');
    sp.textContent = label;
    st.appendChild(b);
    st.appendChild(sp);
    return st;
  }
  function inspHead(glyphCls, glyphText, name, stateCls, stateText, sub) {
    const head = document.createElement('div');
    head.className = 'insp-head';
    const g = document.createElement('span');
    g.className = 'agent-glyph ' + glyphCls;
    setAgentGlyph(g, glyphCls, glyphText);
    const box = document.createElement('div');
    box.className = 'insp-names';
    const nm = document.createElement('div');
    nm.className = 'insp-name';
    const nmText = document.createElement('span');
    nmText.className = 'nm';
    nmText.textContent = name;
    nmText.title = name;
    nm.appendChild(nmText);
    if (stateText) {
      const chip = document.createElement('span');
      chip.className = 'st-chip ' + stateCls;
      chip.textContent = stateText;
      nm.appendChild(chip);
    }
    const subEl = document.createElement('div');
    subEl.className = 'insp-sub';
    subEl.textContent = sub || '';
    subEl.title = sub || '';
    box.appendChild(nm);
    box.appendChild(subEl);
    head.appendChild(g);
    head.appendChild(box);
    return head;
  }
  function fmtTokens(t) {
    if (!t) return '—';
    const total = (t.input || 0) + (t.output || 0);
    return total >= 1000 ? Math.round(total / 1000) + 'k' : String(total);
  }

  function renderInspector() {
    const box = sbClaudeRows;
    while (box.firstChild) box.removeChild(box.firstChild);
    let agent = null;
    let lisaSession = null;
    if (selInsp && selInsp.type === 'agent') agent = agentByKey(selInsp.key);
    if (!agent && selInsp && selInsp.type === 'lisa') lisaSession = sessionById(selInsp.id);
    // Default context = the ACTIVE Lisa session (确认轮二: no more
    // auto-picking a random agent — the Needs-you section carries the
    // agent-attention case now).
    if (!agent && !lisaSession) {
      lisaSession = sessionById(window.lisaActiveSessionId);
    }
    if (agent) { renderAgentInspector(box, agent); return; }
    if (lisaSession) { renderLisaInspector(box, lisaSession); return; }
    const empty = document.createElement('div');
    empty.className = 'session-empty';
    empty.textContent = '(idle)';
    box.appendChild(empty);
  }

  function renderLisaInspector(box, s) {
    const isActive = s.id === window.lisaActiveSessionId;
    box.appendChild(inspHead('lisa', 'L', sessionLabel(s), isActive ? 'working' : 'done', isActive ? 'active' : 'idle', s.id + ' · ' + abbrevPath(s.cwd || '')));
    const stats = document.createElement('div');
    stats.className = 'stats';
    stats.appendChild(inspStat(String(s.messageCount || 0), 'msgs'));
    stats.appendChild(inspStat(relativeTime(s.startedAt), 'started'));
    stats.appendChild(inspStat(String((s.cwd || '—').split('/').pop() || '—'), 'project'));
    box.appendChild(stats);
    const kv = document.createElement('div');
    kv.className = 'kvrows';
    if (s.model) kv.appendChild(inspRow('model', s.model));
    if (s.cwd) kv.appendChild(inspPathRow('cwd', s.cwd));
    box.appendChild(kv);
    if (!isActive) {
      const acts = document.createElement('div');
      acts.className = 'session-ctrl insp-actions';
      const openBtn = document.createElement('button');
      openBtn.className = 'mc adopt';
      openBtn.textContent = '⇱ open';
      openBtn.title = 'Switch to this session';
      openBtn.setAttribute('data-act', 'open-lisa');
      openBtn.setAttribute('data-lisa-id', s.id);
      acts.appendChild(openBtn);
      box.appendChild(acts);
    }
  }

  function renderAgentInspector(box, s) {
    const a = s.activity || {};
    const kindName = AGENT_NAMES[s.agent] || s.agent;
    const stateCls = s.state === 'done' ? 'done' : (s.state || 'unknown');
    const sub = kindName + ' · ' + s.project + (a.gitBranch ? ' · ' + a.gitBranch : '');
    box.appendChild(inspHead(agentGlyphClass(s.agent), (kindName.charAt(0) || 'A').toUpperCase(), agentLabel(s), stateCls, s.state || '?', sub));
    const stats = document.createElement('div');
    stats.className = 'stats';
    stats.appendChild(inspStat(a.turnCount != null ? String(a.turnCount) : '—', 'turns'));
    stats.appendChild(inspStat(fmtTokens(a.tokens), 'tokens'));
    stats.appendChild(inspStat(a.filesTouched ? String(a.filesTouched.length) : '—', 'files'));
    box.appendChild(stats);
    const kv = document.createElement('div');
    kv.className = 'kvrows';
    if (a.lastCommandName) kv.appendChild(inspRow('last cmd', '$ ' + a.lastCommandName));
    if (a.lastTools && a.lastTools.length) kv.appendChild(inspRow('tools', a.lastTools.join(' · ')));
    if (a.filesTouched && a.filesTouched.length) {
      const names = a.filesTouched.slice(-3).map(function (f) { return String(f).split('/').pop(); });
      kv.appendChild(inspRow('files', names.join(' · ')));
    }
    if (a.pendingPermission) kv.appendChild(inspRow('pending', '⚠ ' + a.pendingPermission, 'warn'));
    if (a.lastError) kv.appendChild(inspRow('error', a.lastError, 'err'));
    if (s.stateReason && !a.pendingPermission && !a.lastError) kv.appendChild(inspRow('state', s.stateReason));
    if (kv.childNodes.length) box.appendChild(kv);
    // Controls — same surface the roster rows had, for the selected session:
    // managed → approve/deny pending, send, cancel; pty → send, output,
    // cancel; idle external claude → adopt. Observe-only agents get nothing.
    const fam = s.controllable;
    const id = s.sessionId;
    const acts = document.createElement('div');
    acts.className = 'session-ctrl insp-actions';
    acts.setAttribute('data-fam', fam || '');
    acts.setAttribute('data-agent', s.agent);
    acts.setAttribute('data-session', id);
    acts.setAttribute('data-cwd', s.cwd || '');
    // F1 — every agent session gets a read-only step stream tab.
    const streamBtn = document.createElement('button');
    streamBtn.className = 'mc';
    streamBtn.textContent = '▤ stream';
    streamBtn.title = 'Open the read-only step stream';
    streamBtn.setAttribute('data-act', 'stream');
    acts.appendChild(streamBtn);
    if (fam === 'managed' && a.pendingPermission) {
      const ap = document.createElement('button');
      ap.className = 'mc approve'; ap.textContent = '✓ approve';
      ap.setAttribute('data-act', 'approve'); ap.setAttribute('data-approval', s.activity.approvalId || '');
      const dn = document.createElement('button');
      dn.className = 'mc deny'; dn.textContent = '✕ deny';
      dn.setAttribute('data-act', 'deny'); dn.setAttribute('data-approval', s.activity.approvalId || '');
      acts.appendChild(ap); acts.appendChild(dn);
    } else if (fam && s.state !== 'done') {
      const inp = document.createElement('input');
      inp.className = 'mc-send'; inp.type = 'text';
      inp.placeholder = fam === 'pty' ? 'type into the CLI…' : 'send a follow-up…';
      acts.appendChild(inp);
    }
    if (fam === 'pty') {
      const out = document.createElement('button');
      out.className = 'mc'; out.textContent = '▤ output'; out.title = 'View terminal output';
      out.setAttribute('data-act', 'output');
      acts.appendChild(out);
    }
    if (fam && s.state !== 'done') {
      const cancel = document.createElement('button');
      cancel.className = 'mc cancel'; cancel.textContent = '⏹ cancel'; cancel.title = 'Cancel agent';
      cancel.setAttribute('data-act', 'cancel');
      acts.appendChild(cancel);
    }
    if (s.resumable) {
      const adopt = document.createElement('button');
      adopt.className = 'mc adopt'; adopt.textContent = '⇲ adopt';
      adopt.title = 'Resume this session under LISA — then send / answer / cancel / view it';
      adopt.setAttribute('data-act', 'adopt');
      acts.appendChild(adopt);
    }
    if (acts.childNodes.length) box.appendChild(acts);
  }

  async function refreshPing() {
    try {
      const r = await fetch('/api/island/ping');
      if (!r.ok) return;
      const data = await r.json();
      setDesire(data.current_desire);
      // Same for the desire-derived first starter prompt.
      if (typeof window.lisaRenderChatEmpty === 'function') window.lisaRenderChatEmpty();
      if (data.last_idle_message_text) {
        window.updateReflection(data.last_idle_message_text);
      }
    } catch {}
  }

  // ── Token source + usage (right-rail bottom section) ────────────────
  // Source = the selected coding plan (plan://…) else the configured API
  // key; usage = the local billing ledger's today/12h aggregates plus any
  // per-plan window stats the plan detector reports.
  function fmtUsd(microUSD) {
    if (!microUSD) return '$0';
    const usd = microUSD / 1e6;
    return usd >= 1 ? '$' + usd.toFixed(2) : '$' + usd.toFixed(3);
  }
  function fmtCount(n) {
    if (!n) return '0';
    return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
  }
  async function refreshTokens() {
    const statsEl = document.getElementById('sbTokenStats');
    const rowsEl = document.getElementById('sbTokenRows');
    const modelEl = document.getElementById('sbTokenModel');
    if (!statsEl || !rowsEl || !modelEl) return;
    let model = '';
    let usage = null;
    let plansData = null;
    try {
      const r = await fetch('/session');
      if (r.ok) { const d = await r.json(); model = d.model || ''; }
    } catch (e) {}
    try {
      const r = await fetch('/api/billing/usage');
      if (r.ok) usage = await r.json();
    } catch (e) {}
    try {
      const r = await fetch('/api/plans');
      if (r.ok) plansData = await r.json();
    } catch (e) {}
    modelEl.textContent = model;
    modelEl.title = model;
    statsEl.innerHTML = '';
    rowsEl.innerHTML = '';
    const today = usage && usage.today ? usage.today : null;
    const win = usage && usage.window12h ? usage.window12h : null;
    if (today) {
      statsEl.appendChild(inspStat(fmtCount((today.inputTokens || 0) + (today.outputTokens || 0)), 'tokens'));
      statsEl.appendChild(inspStat(String(today.turns || 0), 'turns'));
      statsEl.appendChild(inspStat(fmtUsd(today.microUSD), 'today'));
    }
    let source = 'API key';
    const plans = plansData && Array.isArray(plansData.plans) ? plansData.plans : [];
    for (let i = 0; i < plans.length; i++) {
      if (plans[i].selected) { source = String(plans[i].label || plans[i].id); break; }
    }
    rowsEl.appendChild(inspRow('source', source));
    if (win) {
      rowsEl.appendChild(inspRow('12h window', fmtCount((win.inputTokens || 0) + (win.outputTokens || 0)) + ' tok · ' + fmtUsd(win.microUSD)));
    }
    plans.forEach(function (p) {
      if (p && p.available && p.usage) rowsEl.appendChild(inspRow(String(p.id || 'plan'), String(p.usage)));
    });
  }
  window.refreshTokens = refreshTokens;

  // Exposed so the SSE handler above can call this on
  // agent_session_update events without redeclaring the helper. D4a — the
  // multi-agent snapshot (all agents), not just Claude Code.
  window.refreshClaudeSessions = async function () {
    try {
      const r = await fetch('/api/agents/sessions');
      if (!r.ok) return;
      const data = await r.json();
      setClaudeSessions(data.sessions || []);
    } catch {}
  };

  // "Delegate a task" → open a modal to pick the agent kind + write the task.
  // (A roomy dialog beats the cramped 280px sidebar.) managed = LISA-run
  // (controllable); claude/codex = a real CLI under a PTY (needs LISA_PTY_AGENTS=1
  // — a 503/error surfaces inline in the dialog).
  function openDelegateModal() {
    openModal(
      'Delegate a task',
      '<div class="delegate-modal">' +
        '<label class="dm-label">Agent</label>' +
        '<select id="dmKind" class="dm-kind">' +
          '<option value="managed">managed — LISA runs it (approve each step)</option>' +
          '<option value="claude" disabled>claude — real CLI under a PTY</option>' +
          '<option value="codex" disabled>codex — real CLI under a PTY</option>' +
        '</select>' +
        '<p id="dmAvailability" class="empty">' + escapeHtml(tr('panel.loading')) + '</p>' +
        '<label class="dm-label">Task</label>' +
        '<textarea id="dmTask" class="dm-task" rows="5" placeholder="Describe the task… (⌘/Ctrl+Enter to start)"></textarea>' +
        '<div class="dm-actions"><button id="dmStart" class="dm-start" type="button">Start agent →</button></div>' +
        '<div id="dmErr" class="dm-err"></div>' +
      '</div>'
    );
    const kindEl = document.getElementById('dmKind');
    panelRequest('/api/agents/pty/status', undefined).then(function (status) {
      if (!kindEl.isConnected) return;
      kindEl.querySelectorAll('option').forEach(function (option) {
        if (option.value === 'managed') return;
        option.disabled = !status.available || !status.agents?.some(agent => agent.id === option.value && agent.available);
      });
      const note = document.getElementById('dmAvailability');
      if (note) note.textContent = status.available ? '' : tr(status.installed ? 'pty.disabled' : 'pty.missing');
    }).catch(function () { const note = document.getElementById('dmAvailability'); if (note) note.textContent = tr('panel.failed'); });
    const taskEl = document.getElementById('dmTask');
    const startEl = document.getElementById('dmStart');
    const errEl = document.getElementById('dmErr');
    if (taskEl) taskEl.focus();
    function submitDelegate() {
      const task = taskEl && taskEl.value.trim();
      if (!task) { if (taskEl) taskEl.focus(); return; }
      const kind = kindEl ? kindEl.value : 'managed';
      const url = kind === 'managed' ? '/api/agents/managed/start' : '/api/agents/pty/start';
      const body = kind === 'managed' ? { task: task } : { agent: kind, task: task };
      if (errEl) errEl.textContent = '';
      if (startEl) { startEl.disabled = true; startEl.textContent = 'Starting…'; }
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (r) {
        if (!r.ok) {
          return r.text().then(function (t) {
            t = errorText(t);
            if (errEl) errEl.textContent = t || ('failed (' + r.status + ')');
            if (startEl) { startEl.disabled = false; startEl.textContent = 'Start agent →'; }
          });
        }
        closeModal();
        if (typeof refreshClaudeSessions === 'function') refreshClaudeSessions();
      }).catch(function () {
        if (errEl) errEl.textContent = 'network error';
        if (startEl) { startEl.disabled = false; startEl.textContent = 'Start agent →'; }
      });
    }
    if (startEl) startEl.addEventListener('click', submitDelegate);
    if (taskEl) taskEl.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitDelegate(); }
    });
  }
  const sbDelegateBtn = document.getElementById('sbDelegateBtn');
  if (sbDelegateBtn) sbDelegateBtn.addEventListener('click', openDelegateModal);
  // Exposed so the console Dashboard / Control views reuse the same dialog.
  window.lisaOpenDelegate = openDelegateModal;

  async function refreshIdentity() {
    try {
      const r = await fetch('/api/soul');
      if (!r.ok) return;
      const data = await r.json();
      if (!data.born) return;
      const bornAt = data.summary?.seed?.bornAt;
      if (!bornAt) return;
      const born = new Date(bornAt);
      if (Number.isNaN(born.getTime())) return;
      const days = Math.max(0, Math.floor((Date.now() - born.getTime()) / 86400000));
      const ymd = born.toISOString().slice(0, 10);
      identitySub.textContent = 'born ' + ymd + ' · ' + days + ' day' + (days === 1 ? '' : 's');
      // The empty-chat card quotes this line; it renders before /api/soul
      // lands, so repaint it once the identity is known.
      if (typeof window.lisaRenderChatEmpty === 'function') window.lisaRenderChatEmpty();
    } catch {}
  }

  // ── Session tree + tab strip (PLAN_UI_SESSION_SHELL_v1.0 §3.1) ──────
  // Lisa's own sessions as the first root group of the sidebar tree; the
  // monitored-agent groups join in the control-tree phase. Open tabs are a
  // client-side notion (which sessions you keep at hand), persisted in
  // localStorage; the tree is the full on-disk list.
  let cachedSessions = [];
  // key → { name, updatedAt }. Names are never deleted, so every source (the
  // POST reply, the session_renamed event, a full refresh) merges by
  // updatedAt: a reply that arrives late cannot undo a newer rename made in
  // another window.
  const sessionNames = new Map();
  function applySessionName(entry) {
    if (!entry || typeof entry.name !== 'string') return false;
    const key = JSON.stringify([entry.kind, entry.id]);
    const stamp = Number(entry.updatedAt) || 0;
    const known = sessionNames.get(key);
    if (known && (known.updatedAt > stamp || (known.updatedAt === stamp && known.name === entry.name))) return false;
    sessionNames.set(key, { name: entry.name, updatedAt: stamp });
    return true;
  }
  function customSessionName(kind, id) {
    const known = sessionNames.get(JSON.stringify([kind, id]));
    return known ? known.name : '';
  }
  function renderSessionNames() {
    renderSessionUI();
    renderInspector();
    renderNeeds();
    if (currentAgentTab) renderStreamView();
  }
  window.lisaSessionRenamed = function (entry) {
    if (applySessionName(entry)) renderSessionNames();
  };
  async function refreshSessionNames() {
    try {
      const response = await fetch('/api/session-names');
      if (!response.ok) return;
      const data = await response.json();
      let changed = false;
      (Array.isArray(data.names) ? data.names : []).forEach(entry => { if (applySessionName(entry)) changed = true; });
      if (changed) renderSessionNames();
    } catch (e) { /* Names retry with the next session refresh. */ }
  }
  // (确认轮二) Multi-tab strip removed: creating/switching lives in the
  // sidebar tree only, and the strip renders a single CONTEXT CHIP for
  // what the main pane is showing — the active Lisa session, or the
  // observed agent while the stream pane is open.
  function sessionLabel(s) {
    const custom = s && customSessionName('lisa', s.id);
    if (custom) return custom;
    // F2 auto-naming: the FIRST user message is the session's name (the
    // opening request describes the task); fall back to the latest one.
    const t = (s && (s.firstUserMessage || s.lastUserMessage) ? (s.firstUserMessage || s.lastUserMessage) : '').trim();
    if (t) return t.length > 30 ? t.slice(0, 30) + '…' : t;
    // UX-4: a session with nothing in it yet used to be labelled with its raw
    // id (20260905-220846-9f7d58) in the tree, the context chip, the title bar
    // and the inspector — four places showing a string no human reads. It is
    // "New session · 2m" now; the id survives as the tooltip / inspector sub.
    if (s && !s.messageCount) return tr('session.new') + ' · ' + relativeTime(s.startedAt);
    return s ? s.id : '';
  }
  // The title bar is rendered outside this closure (setActiveSessionUI runs
  // before /api/sessions lands), so it asks for the label through here and
  // falls back to the raw id while the list is still in flight.
  window.lisaSessionLabel = function (id) {
    const s = sessionById(id);
    return s ? sessionLabel(s) : '';
  };
  // ⌘K switcher (UX-11) lives at top level; hand it pre-rendered rows so it
  // does not need sessionLabel / relativeTime / cachedSessions itself.
  window.lisaSessionsForSwitcher = function () {
    return cachedSessions.map(function (s) {
      return {
        id: s.id,
        label: sessionLabel(s),
        meta: String(s.messageCount || 0) + ' msgs · ' + relativeTime(s.startedAt),
        active: s.id === window.lisaActiveSessionId,
      };
    });
  };
  window.lisaSwitchSession = switchSession;
  window.lisaNewSession = newSession;
  function sessionById(id) {
    for (let i = 0; i < cachedSessions.length; i++) {
      if (cachedSessions[i].id === id) return cachedSessions[i];
    }
    return null;
  }

  // e2e 加固: switch/new used to swallow failures (empty catch, no finally)
  // — one hung POST left the switching flag stuck forever and every later
  // ＋New / tree click silently no-oped. Now: 8s timeout, finally-reset, a
  // visible console error, and the composer LOCKS during the swap so a
  // message can never be typed into a session that's about to be switched
  // away (the "sent but nothing happened" race).
  let switching = false;
  // The keyboard hint does not fit a phone composer: at 375px the textarea is
  // ~160px wide, so "Talk to Lisa…  (Enter to send · Shift+Enter for newline)"
  // wraps and gets clipped mid-word. The hint is also useless there — a soft
  // keyboard has no Shift+Enter. Narrow screens get the short form; the
  // matchMedia listener keeps it right across rotation and window resizes.
  const composerNarrow = window.matchMedia('(max-width: 720px)');
  function composerHint() {
    return composerNarrow.matches
      ? 'Talk to Lisa…'
      : 'Talk to Lisa…  (Enter to send · Shift+Enter for newline)';
  }
  function setComposerLocked(on) {
    try {
      input.disabled = on;
      sendBtn.disabled = on;
      input.placeholder = on ? 'switching session…' : composerHint();
    } catch (e) {}
  }
  try {
    input.placeholder = composerHint();
    composerNarrow.addEventListener('change', function () {
      if (!input.disabled) input.placeholder = composerHint();
    });
  } catch (e) {}
  async function postSessionMutation(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, 8000);
    try {
      const r = await fetch(url, { method: 'POST', signal: ctrl.signal });
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }
  async function switchSession(id) {
    if (switching || !id || id === window.lisaActiveSessionId) return;
    switching = true;
    document.body.classList.add('session-switching');
    setComposerLocked(true);
    try {
      const data = await postSessionMutation('/api/sessions/' + encodeURIComponent(id) + '/activate');
      if (data && data.ok && typeof window.lisaSetActiveSession === 'function') {
        window.lisaSetActiveSession(data.id);
      }
    } catch (e) {
      console.error('[sessions] switch failed:', e);
    } finally {
      document.body.classList.remove('session-switching');
      setComposerLocked(false);
      switching = false;
      refreshSessionsBadge();
    }
  }
  async function newSession() {
    if (switching) return;
    switching = true;
    closeStreamView();
    document.body.classList.add('session-switching');
    setComposerLocked(true);
    try {
      const data = await postSessionMutation('/api/sessions');
      if (data && data.ok && typeof window.lisaSetActiveSession === 'function') {
        window.lisaSetActiveSession(data.id);
      }
    } catch (e) {
      console.error('[sessions] new session failed:', e);
    } finally {
      document.body.classList.remove('session-switching');
      setComposerLocked(false);
      switching = false;
      refreshSessionsBadge();
    }
  }

  function renderSessionTree() {
    const tree = document.getElementById('sessionTree');
    if (!tree) return;
    // Rendering with no Lisa sessions means the list fetch hasn't landed or
    // failed — kick it (in-flight guard + retry make this loop-safe).
    if (!cachedSessions.length) refreshSessionsBadge();
    tree.innerHTML = '';
    if (treeMode === 'project') { buildProjectTree(tree); return; }
    const group = document.createElement('div');
    group.className = 'tgroup';
    applyCollapsed(group, 'lisa');
    const root = document.createElement('button');
    root.type = 'button';
    root.className = 'tnode';
    root.innerHTML = '<span class="twist">▾</span><span class="agent-glyph lisa">L</span><span class="tlabel">LISA</span><span class="tcount"></span>';
    setAgentGlyph(root.querySelector('.agent-glyph'), 'lisa', 'L');
    root.querySelector('.tcount').textContent = String(cachedSessions.length);
    root.setAttribute('data-toggle', 'lisa');
    group.appendChild(root);
    const kids = document.createElement('div');
    kids.className = 'tchildren';
    const MAX_LEAVES = 14;
    cachedSessions.slice(0, MAX_LEAVES).forEach(function (s) {
      kids.appendChild(makeLisaLeaf(s, false));
    });
    group.appendChild(kids);
    tree.appendChild(group);
    renderAgentTree();
  }

  // Single context chip: what the main pane is showing right now — the
  // active Lisa session, or the observed agent while the stream pane is
  // open (with an × back to chat). NOT a switcher: creation and switching
  // live in the sidebar tree only (确认轮二).
  function renderTabs() {
    const strip = document.getElementById('tabStrip');
    if (!strip) return;
    strip.innerHTML = '';
    const chip = document.createElement('div');
    chip.className = 'ctx-chip';
    if (currentAgentTab) {
      chip.classList.add('agent');
      chip.innerHTML = '<span class="pip"></span><span class="agent-glyph mini"></span><span class="ctx-name"></span><span class="ctx-meta">observing</span><button type="button" class="ctx-x" title="Back to chat">×</button>';
      const s = agentByKey(currentAgentTab.agent + '/' + currentAgentTab.id);
      const kindName = AGENT_NAMES[currentAgentTab.agent] || currentAgentTab.agent;
      const g = chip.querySelector('.agent-glyph');
      g.classList.add(agentGlyphClass(currentAgentTab.agent));
      setAgentGlyph(g, currentAgentTab.agent, (kindName.charAt(0) || 'A').toUpperCase());
      const st = s ? (s.state || 'unknown') : 'unknown';
      if (st === 'working' || st === 'waiting' || st === 'error') chip.querySelector('.pip').classList.add(st);
      chip.querySelector('.ctx-name').textContent = s ? agentLabel(s) : (currentAgentTab.label || currentAgentTab.id);
      chip.querySelector('.ctx-x').setAttribute('data-act', 'close-stream');
    } else {
      chip.innerHTML = '<span class="pip live"></span><span class="ctx-name"></span><span class="ctx-meta"></span>';
      const s = sessionById(window.lisaActiveSessionId);
      chip.querySelector('.ctx-name').textContent = s ? sessionLabel(s) : (window.lisaActiveSessionId || '—');
      chip.querySelector('.ctx-meta').textContent = s ? String(s.messageCount || 0) + ' msgs' : '';
      // The raw id is demoted to the tooltip now that the name can be
      // "New session · 2m" (UX-4).
      chip.title = window.lisaActiveSessionId || '';
    }
    strip.appendChild(chip);
  }

  // ── F1: read-only agent stream tab ─────────────────────────────────
  // An agent tab swaps the chat surface for a structural step timeline
  // (GET /api/agents/steps; PTY sessions stream their terminal tail over
  // the existing SSE endpoint instead). 4s visibility-gated polling, plus
  // refresh on agent_session_update via setClaudeSessions.
  let currentAgentTab = null;
  let streamTimer = null;
  let ptyStream = null;
  window.lisaOpenAgentStream = function (s) {
    openStreamTab({ t: 'agent', agent: s.agent, id: s.sessionId, label: agentLabel(s) });
  };
  function openStreamTab(entry) {
    if (currentAgentTab !== entry) document.getElementById('asSteps').replaceChildren();
    if (ptyStream) { ptyStream.close(); ptyStream = null; }
    currentAgentTab = entry;
    document.body.classList.add('agent-tab-active');
    if (window.lisaShowView) window.lisaShowView('chat');
    renderSessionUI();
    renderStreamView();
    if (streamTimer) clearInterval(streamTimer);
    streamTimer = setInterval(function () {
      if (currentAgentTab && !document.hidden) refreshStreamSteps();
    }, 4000);
  }
  function closeStreamView() {
    if (!currentAgentTab) return;
    currentAgentTab = null;
    document.body.classList.remove('agent-tab-active');
    if (streamTimer) { clearInterval(streamTimer); streamTimer = null; }
    if (ptyStream) { ptyStream.close(); ptyStream = null; }
  }
  function streamSession() {
    return currentAgentTab ? agentByKey(currentAgentTab.agent + '/' + currentAgentTab.id) : null;
  }
  function renderStreamView() {
    if (!currentAgentTab) return;
    const head = document.getElementById('asHead');
    const perm = document.getElementById('asPerm');
    const foot = document.getElementById('asFoot');
    if (!head || !perm || !foot) return;
    const s = streamSession();
    head.innerHTML = '';
    const kindName = AGENT_NAMES[currentAgentTab.agent] || currentAgentTab.agent;
    const g = document.createElement('span');
    g.className = 'agent-glyph ' + agentGlyphClass(currentAgentTab.agent);
    setAgentGlyph(g, currentAgentTab.agent, (kindName.charAt(0) || 'A').toUpperCase());
    head.appendChild(g);
    const nameEl = document.createElement('b');
    nameEl.textContent = s ? agentLabel(s) : (currentAgentTab.label || currentAgentTab.id);
    nameEl.title = nameEl.textContent;
    head.appendChild(nameEl);
    const meta = document.createElement('span');
    meta.className = 'meta';
    if (s) {
      const a = s.activity || {};
      const bits = [kindName, s.project];
      if (a.gitBranch) bits.push(a.gitBranch);
      if (a.turnCount != null) bits.push(a.turnCount + ' turns');
      if (a.tokens) bits.push(fmtTokens(a.tokens) + ' tok');
      meta.textContent = bits.join(' · ');
    } else {
      meta.textContent = kindName + ' · (outside the active window)';
    }
    head.appendChild(meta);
    const badge = document.createElement('span');
    badge.className = 'ro-badge';
    badge.textContent = s && s.controllable ? s.controllable : 'observing';
    head.appendChild(badge);
    perm.style.display = 'none';
    perm.innerHTML = '';
    if (s && s.controllable === 'managed' && s.activity && s.activity.pendingPermission) {
      perm.style.display = '';
      const label = document.createElement('span');
      label.textContent = '⚠ pending';
      perm.appendChild(label);
      const code = document.createElement('code');
      code.textContent = s.activity.pendingPermission;
      perm.appendChild(code);
      const grow = document.createElement('span');
      grow.className = 'grow';
      perm.appendChild(grow);
      perm.setAttribute('data-session', s.sessionId);
      const ap = document.createElement('button');
      ap.className = 'mc approve'; ap.textContent = '✓ approve';
      ap.setAttribute('data-act', 'approve'); ap.setAttribute('data-approval', s.activity.approvalId || '');
      const dn = document.createElement('button');
      dn.className = 'mc deny'; dn.textContent = '✕ deny';
      dn.setAttribute('data-act', 'deny'); dn.setAttribute('data-approval', s.activity.approvalId || '');
      perm.appendChild(ap);
      perm.appendChild(dn);
    }
    foot.innerHTML = '';
    if (s && s.controllable && s.state !== 'done') {
      foot.setAttribute('data-fam', s.controllable);
      foot.setAttribute('data-session', s.sessionId);
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'mc-send';
      inp.placeholder = s.controllable === 'pty' ? 'type into the CLI…' : 'send a follow-up…';
      foot.appendChild(inp);
      const cancel = document.createElement('button');
      cancel.className = 'mc cancel'; cancel.textContent = '⏹ cancel';
      cancel.setAttribute('data-act', 'cancel');
      foot.appendChild(cancel);
    } else if (s && s.resumable) {
      const note = document.createElement('span');
      note.style.cssText = 'font-size:11.5px;color:var(--fg-3);align-self:center;';
      note.textContent = 'observe-only — adopt it from the inspector to take control';
      foot.appendChild(note);
    }
    refreshStreamSteps();
  }
  var streamRequest = 0;
  function refreshStreamSteps() {
    if (!currentAgentTab) return;
    const stepsEl = document.getElementById('asSteps');
    if (!stepsEl) return;
    const s = streamSession();
    // PTY sessions: live terminal tail over the existing SSE endpoint.
    if (s && s.controllable === 'pty') {
      if (!ptyStream) {
        stepsEl.innerHTML = '';
        const pre = document.createElement('pre');
        pre.className = 'pty-tail';
        stepsEl.appendChild(pre);
        ptyStream = new EventSource('/api/agents/pty/' + encodeURIComponent(s.sessionId) + '/stream');
        ptyStream.onmessage = function (e) {
          try {
            const ev = JSON.parse(e.data);
            if (ev.type === 'snapshot') pre.textContent = ev.text || '';
            else if (ev.type === 'chunk') pre.textContent += ev.text || '';
            else if (ev.type === 'end') { if (ptyStream) { ptyStream.close(); ptyStream = null; } }
            stepsEl.scrollTop = stepsEl.scrollHeight;
          } catch (err) {}
        };
        ptyStream.onerror = function () { if (ptyStream) { ptyStream.close(); ptyStream = null; } };
      }
      return;
    }
    // 确认轮三: prefer the full local transcript (user/assistant text +
    // structural tool markers — loopback-only endpoint); fall back to the
    // structural steps when it comes back empty (remote access, other
    // agent kinds, or a quiet tail).
    const q = 'agent=' + encodeURIComponent(currentAgentTab.agent) + '&id=' + encodeURIComponent(currentAgentTab.id);
    const tab = currentAgentTab;
    const request = ++streamRequest;
    fetch('/api/agents/transcript?' + q)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (tab !== currentAgentTab || request !== streamRequest) return null;
        if (d && d.metadataOnly) {
          stepsEl.textContent = tr('control.metadata');
          return null;
        }
        if (d && d.entries && d.entries.length) {
          renderTranscript(stepsEl, d.entries);
          return null;
        }
        return fetch('/api/agents/steps?' + q)
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (sd) {
            if (!sd || tab !== currentAgentTab || request !== streamRequest) return;
            renderSteps(stepsEl, sd.steps || []);
          });
      })
      .catch(function () {});
  }
  function renderTranscript(stepsEl, entries) {
    const previous = stepsEl.querySelectorAll('details[open]');
    const expanded = new Set(Array.from(previous, el => el.dataset.group));
    const atBottom = stepsEl.scrollHeight - stepsEl.scrollTop - stepsEl.clientHeight < 60;
    stepsEl.innerHTML = '';
    let group;
    let groupCount = 0;
    entries.forEach(function (en, index) {
      if (en.kind === 'tool') {
        const row = document.createElement('div');
        row.className = 'srow' + (en.isError ? ' err' : '');
        row.innerHTML = '<span class="sic"></span><span></span><span class="sdetail"></span><span class="stime"></span>';
        row.querySelector('.sic').textContent = stepIcon(en.tool);
        row.children[1].textContent = en.tool || '';
        row.querySelector('.sdetail').textContent = en.target || '';
        if (en.ts) row.querySelector('.stime').textContent = relativeTime(en.ts);
        if (!group && entries[index + 1] && entries[index + 1].kind === 'tool') {
          group = document.createElement('details');
          group.className = 'as-tool-group';
          group.dataset.group = String(en.ts || index) + '/' + (en.tool || '');
          group.open = expanded.has(group.dataset.group);
          group.appendChild(document.createElement('summary'));
          stepsEl.appendChild(group);
          groupCount = 0;
        }
        if (group) {
          group.firstChild.textContent = tr('control.tools', { n: ++groupCount });
          group.appendChild(row);
        } else stepsEl.appendChild(row);
        return;
      }
      group = null;
      const msg = document.createElement('div');
      msg.className = 'as-msg ' + (en.kind === 'user' ? 'user' : 'assistant');
      const role = document.createElement('div');
      role.className = 'as-role';
      role.textContent = en.kind === 'user' ? 'USER' : 'AGENT';
      if (en.ts) {
        const t = document.createElement('span');
        t.className = 'stime';
        t.textContent = relativeTime(en.ts);
        role.appendChild(t);
      }
      msg.appendChild(role);
      const body = document.createElement('div');
      body.className = 'as-text';
      // Agent replies are Markdown → render; the user's own text as-is
      // (same rule as Lisa's chat history).
      if (en.kind === 'assistant' && typeof renderMarkdown === 'function') body.innerHTML = renderMarkdown(en.text || '');
      else body.textContent = en.text || '';
      msg.appendChild(body);
      stepsEl.appendChild(msg);
    });
    if (atBottom) stepsEl.scrollTop = stepsEl.scrollHeight;
  }
  function stepIcon(tool) {
    const t = (tool || '').toLowerCase();
    if (t === 'read') return '📖';
    if (t === 'edit' || t === 'write' || t === 'notebookedit') return '✏️';
    if (t === 'bash') return '🖥';
    if (t === 'grep' || t === 'glob') return '🔎';
    return '⚙';
  }
  function renderSteps(stepsEl, steps) {
    const atBottom = stepsEl.scrollHeight - stepsEl.scrollTop - stepsEl.clientHeight < 60;
    stepsEl.innerHTML = '';
    if (!steps.length) {
      const empty = document.createElement('div');
      empty.className = 'session-empty';
      empty.textContent = '(no structural steps in the recent tail — metadata-only visibility, or a quiet session)';
      stepsEl.appendChild(empty);
      return;
    }
    steps.forEach(function (st) {
      const row = document.createElement('div');
      if (st.kind === 'user') {
        row.className = 'srow turn';
        row.innerHTML = '<span class="sic">💬</span><span></span><span class="stime"></span>';
        row.children[1].textContent = 'turn ' + st.turn;
      } else if (st.kind === 'assistant') {
        row.className = 'srow';
        row.innerHTML = '<span class="sic">💭</span><span>reply</span><span class="stime"></span>';
      } else {
        row.className = 'srow' + (st.isError ? ' err' : '');
        row.innerHTML = '<span class="sic"></span><span></span><span class="sdetail"></span><span class="stime"></span>';
        row.querySelector('.sic').textContent = stepIcon(st.tool);
        row.children[1].textContent = st.tool || '';
        row.querySelector('.sdetail').textContent = st.target || '';
      }
      if (st.ts) row.querySelector('.stime').textContent = relativeTime(st.ts);
      stepsEl.appendChild(row);
    });
    if (atBottom) stepsEl.scrollTop = stepsEl.scrollHeight;
  }

  function renderSessionUI() {
    renderSessionTree();
    renderTabs();
    // The label depends on cachedSessions, which lands after the title bar's
    // first paint — refresh it on every list update.
    if (typeof window.lisaUpdateTitlebar === 'function') window.lisaUpdateTitlebar();
    if (typeof window.lisaRenderChatEmpty === 'function') window.lisaRenderChatEmpty();
  }
  window.lisaRenderSessionTree = renderSessionUI;

  // F6 — unread marks for sessions whose reply finished in the background.
  const unreadSessions = {};
  window.lisaMarkUnread = function (id) {
    if (!id) return;
    unreadSessions[id] = true;
    renderSessionUI();
  };
  window.lisaClearUnread = function (id) {
    if (id && unreadSessions[id]) {
      delete unreadSessions[id];
      renderSessionUI();
    }
  };
  window.lisaIsUnread = function (id) { return !!unreadSessions[id]; };

  // ── F5: focus an agent session from outside (island SSE / #agent= hash) ──
  window.lisaFocusAgent = function (agent, id) {
    if (!agent || !id) return;
    selInsp = { type: 'agent', key: agent + '/' + id };
    if (window.lisaShowView) window.lisaShowView('chat');
    renderInspector();
    renderSessionUI();
  };
  let agentHashHandled = false;
  function handleAgentHash() {
    const h = (location.hash || '').replace('#', '');
    if (h.indexOf('agent=') !== 0) return;
    const parts = decodeURIComponent(h.slice(6)).split('/');
    if (parts.length >= 2) window.lisaFocusAgent(parts[0], parts.slice(1).join('/'));
  }
  window.addEventListener('hashchange', handleAgentHash);
  window.lisaHandleAgentHashOnce = function () {
    if (agentHashHandled) return;
    agentHashHandled = true;
    handleAgentHash();
  };
  const sbNewBtn = document.getElementById('sbNewSession');
  if (sbNewBtn) sbNewBtn.addEventListener('click', newSession);

  // e2e 加固: a failed/slow session-list fetch used to stay broken for the
  // whole 5-minute interval while the roster SSE kept rebuilding the tree —
  // Lisa's sessions "vanished" until the next tick. Now: in-flight guard +
  // 5s retry, and renderSessionTree triggers a fetch whenever it finds
  // itself rendering with an empty list.
  let sessionsFetchInFlight = false;
  let sessionsRetryTimer = null;
  async function refreshSessionsBadge() {
    if (sessionsFetchInFlight) return;
    sessionsFetchInFlight = true;
    try {
      const r = await fetch('/api/sessions');
      if (!r.ok) throw new Error('http ' + r.status);
      const data = await r.json();
      cachedSessions = Array.isArray(data.sessions) ? data.sessions : [];
      void refreshSessionNames();
      sbSessionBadge.textContent = String(cachedSessions.length);
      renderSessionUI();
      // The inspector's default target is the active Lisa session — it can
      // only resolve once this list (and /session) has landed, so re-render
      // here too or a fresh page shows "(idle)" until the next roster tick.
      renderInspector();
    } catch (e) {
      if (sessionsRetryTimer) clearTimeout(sessionsRetryTimer);
      sessionsRetryTimer = setTimeout(function () {
        sessionsRetryTimer = null;
        refreshSessionsBadge();
      }, 5000);
    } finally {
      sessionsFetchInFlight = false;
    }
  }

  // ── Mail card: connect a mailbox + show the daily classified digest ──
  function renderMail(accounts, digest) {
    const body = document.getElementById('sbMailBody');
    const count = document.getElementById('sbMailCount');
    const connectBtn = document.getElementById('sbMailConnectBtn');
    if (!body) return;
    while (body.firstChild) body.removeChild(body.firstChild);
    const hasAccounts = accounts && accounts.length > 0;
    // 确认轮二: an unconnected mail section is pure noise — hide the whole
    // card until a mailbox exists (the fnbar Mail button stays the entry
    // point for connecting one).
    const mailCard = document.getElementById('sbMailCard');
    if (mailCard) mailCard.style.display = hasAccounts ? '' : 'none';
    if (connectBtn) connectBtn.textContent = hasAccounts ? '＋ add mailbox' : '＋ connect mailbox';
    if (!hasAccounts) {
      const empty = document.createElement('div');
      empty.className = 'session-empty';
      empty.textContent = '(not connected)';
      body.appendChild(empty);
      if (count) count.textContent = '';
      return;
    }
    const sum = document.createElement('div');
    sum.className = 'mail-summary';
    sum.textContent = digest && digest.summary ? digest.summary : 'No digest yet — sweep to build one.';
    body.appendChild(sum);
    const needs = digest && digest.needsYou ? digest.needsYou : [];
    if (count) count.textContent = needs.length ? ('✦ ' + needs.length) : '';
    for (const i of needs.slice(0, 5)) {
      const row = document.createElement('div');
      row.className = 'mail-row';
      const bang = document.createElement('span');
      bang.className = 'mail-bang' + (i.importance >= 3 ? ' urgent' : '');
      bang.textContent = i.importance >= 3 ? '‼' : '!';
      const subj = document.createElement('span');
      subj.className = 'mail-subj';
      subj.textContent = i.subject || '(no subject)';
      subj.title = (i.from || '') + ' — ' + (i.reason || '');
      row.appendChild(bang);
      row.appendChild(subj);
      body.appendChild(row);
    }
    const sweep = document.createElement('button');
    sweep.className = 'mail-sweep';
    sweep.type = 'button';
    sweep.textContent = 'sweep now';
    sweep.addEventListener('click', function () {
      sweep.disabled = true; sweep.textContent = 'sweeping…';
      fetch('/api/mail/sweep', { method: 'POST' }).then(function () {
        if (window.refreshMail) window.refreshMail();
      }).catch(function () {}).then(function () { sweep.disabled = false; sweep.textContent = 'sweep now'; });
    });
    body.appendChild(sweep);
  }

  window.refreshMail = async function () {
    try {
      const a = await fetch('/api/mail/accounts').then(function (r) { return r.ok ? r.json() : null; });
      const d = await fetch('/api/mail/digest').then(function (r) { return r.ok ? r.json() : null; });
      const accounts = a ? a.accounts : [];
      const digest = d ? d.digest : null;
      renderMail(accounts, digest);
      // Nav 九宫格 Mail tile badge = "needs you" count (blank when none).
      const needs = digest && digest.needsYou ? digest.needsYou : [];
      const nb = document.getElementById('navMailCount');
      if (nb) nb.textContent = needs.length ? String(needs.length) : '';
      // Keep an open Mail rail view in sync.
      if (typeof window.lisaMailViewRender === 'function') window.lisaMailViewRender(accounts, digest);
    } catch (e) {}
  };

  // Guided connect: pick a provider → see exactly where to get an app-password
  // (a link that opens in the system browser), with labels + host tuned to it.
  // Most people do not know an IMAP mailbox needs an app-password, not their
  // login password — the steps + link are the whole point of this modal.
  const MAIL_PROVIDERS = [
    { key: 'gmail', label: 'Gmail', domains: ['gmail.com', 'googlemail.com'],
      emailPh: 'you@gmail.com', hostPh: 'imap.gmail.com',
      credLabel: 'App password', credPh: '16-character app password',
      linkUrl: 'https://myaccount.google.com/apppasswords', linkText: 'Open Google App Passwords ↗',
      steps: [
        'Turn on 2-Step Verification for your Google account (app passwords need it).',
        'Open Google App Passwords below and create one — name it Lisa.',
        'Paste the 16-character code below. Your Google login password will not work.',
      ] },
    { key: 'icloud', label: 'iCloud', domains: ['icloud.com', 'me.com', 'mac.com'],
      emailPh: 'you@icloud.com', hostPh: 'imap.mail.me.com',
      credLabel: 'App-specific password', credPh: 'xxxx-xxxx-xxxx-xxxx',
      linkUrl: 'https://account.apple.com', linkText: 'Open Apple Account ↗',
      steps: [
        'Open Apple Account below and go to Sign-In and Security.',
        'Under App-Specific Passwords, generate one for Lisa.',
        'Paste it below. Your Apple ID login password will not work.',
      ] },
    { key: 'qq', label: 'QQ', domains: ['qq.com', 'foxmail.com'],
      emailPh: 'you@qq.com', hostPh: 'imap.qq.com',
      credLabel: 'Authorization code 授权码', credPh: 'IMAP authorization code',
      linkUrl: 'https://mail.qq.com', linkText: 'Open QQ Mail ↗',
      steps: [
        'In QQ Mail open 设置 → 账户 and find POP3/IMAP/SMTP 服务.',
        'Enable IMAP 服务; QQ shows a 16-char authorization code (授权码).',
        'Paste that 授权码 below, not your QQ login password.',
      ] },
    { key: 'netease', label: '163 / 126', domains: ['163.com', '126.com', 'yeah.net'],
      emailPh: 'you@163.com', hostPh: 'imap.163.com',
      credLabel: 'Authorization code 授权码', credPh: 'IMAP authorization code',
      linkUrl: 'https://mail.163.com', linkText: 'Open 163 Mail ↗',
      steps: [
        'In 163 Mail open 设置 → POP3/SMTP/IMAP.',
        'Enable IMAP 服务 and set a client authorization code (授权码).',
        'Paste that 授权码 below, not your login password.',
      ] },
    { key: 'outlook', label: 'Outlook', domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
      emailPh: 'you@outlook.com', hostPh: 'outlook.office365.com',
      credLabel: 'App password', credPh: 'app password',
      linkUrl: 'https://account.microsoft.com/security', linkText: 'Open Microsoft security ↗',
      steps: [
        'Turn on two-step verification for your Microsoft account.',
        'Under Advanced security options, create an app password.',
        'Paste it below. Some Microsoft accounts block IMAP; then this will not work.',
      ] },
    { key: 'other', label: 'Other', domains: [],
      emailPh: 'you@example.com', hostPh: 'imap.example.com',
      credLabel: 'App-password / authorization code', credPh: 'not your login password',
      linkUrl: '', linkText: '',
      steps: [
        'Most providers need an app-password or authorization code, not your login password.',
        'Find it in the security or IMAP settings of your mail provider.',
        'If the IMAP host is not auto-detected, fill it in below.',
      ] },
  ];

  function openMailModal() {
    function providerByKey(k) {
      for (let i = 0; i < MAIL_PROVIDERS.length; i++) if (MAIL_PROVIDERS[i].key === k) return MAIL_PROVIDERS[i];
      return MAIL_PROVIDERS[MAIL_PROVIDERS.length - 1];
    }
    let currentKey = 'gmail';
    openModal('Connect a mailbox',
      '<div class="delegate-modal mm-modal">' +
        '<div class="mm-providers" id="mmProviders"></div>' +
        '<div class="mm-help" id="mmHelp"></div>' +
        '<label class="dm-label">Email</label>' +
        '<input id="mmEmail" class="dm-kind" type="email" placeholder="you@gmail.com" autocomplete="off" />' +
        '<label class="dm-label" id="mmPassLabel">App password</label>' +
        '<input id="mmPass" class="dm-kind" type="password" placeholder="16-character app password" autocomplete="off" />' +
        '<label class="dm-label">IMAP host (optional, auto-detected)</label>' +
        '<input id="mmHost" class="dm-kind" type="text" placeholder="imap.gmail.com" autocomplete="off" />' +
        '<div class="dm-actions"><button id="mmStart" class="dm-start" type="button">Connect →</button></div>' +
        '<div id="mmErr" class="dm-err"></div>' +
        '<div class="dm-note">Read-only. Stored locally (mode 0600). Lisa reads only headers and a short preview — never full message bodies, and never sends mail.</div>' +
      '</div>');
    const emailEl = document.getElementById('mmEmail');
    const passEl = document.getElementById('mmPass');
    const passLabelEl = document.getElementById('mmPassLabel');
    const hostEl = document.getElementById('mmHost');
    const startEl = document.getElementById('mmStart');
    const errEl = document.getElementById('mmErr');
    const provWrap = document.getElementById('mmProviders');
    const helpEl = document.getElementById('mmHelp');

    function renderHelp(p) {
      if (!helpEl) return;
      while (helpEl.firstChild) helpEl.removeChild(helpEl.firstChild);
      const ol = document.createElement('ol');
      ol.className = 'mm-steps';
      for (let i = 0; i < p.steps.length; i++) {
        const li = document.createElement('li');
        li.textContent = p.steps[i];
        ol.appendChild(li);
      }
      helpEl.appendChild(ol);
      if (p.linkUrl) {
        const a = document.createElement('a');
        a.className = 'mm-link';
        a.href = p.linkUrl; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = p.linkText;
        helpEl.appendChild(a);
      }
    }
    function selectProvider(key) {
      const p = providerByKey(key);
      currentKey = p.key;
      if (provWrap) {
        const chips = provWrap.querySelectorAll('.mm-chip');
        for (let i = 0; i < chips.length; i++) {
          if (chips[i].getAttribute('data-key') === p.key) chips[i].classList.add('on');
          else chips[i].classList.remove('on');
        }
      }
      if (emailEl) emailEl.placeholder = p.emailPh;
      if (hostEl) hostEl.placeholder = p.hostPh;
      if (passLabelEl) passLabelEl.textContent = p.credLabel;
      if (passEl) passEl.placeholder = p.credPh;
      renderHelp(p);
    }
    if (provWrap) {
      MAIL_PROVIDERS.forEach(function (p) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mm-chip' + (p.key === currentKey ? ' on' : '');
        b.textContent = p.label;
        b.setAttribute('data-key', p.key);
        b.addEventListener('click', function () { selectProvider(p.key); if (emailEl) emailEl.focus(); });
        provWrap.appendChild(b);
      });
    }
    function detectFromEmail() {
      const v = (emailEl && emailEl.value ? emailEl.value : '').toLowerCase().trim();
      const at = v.indexOf('@');
      if (at < 0) return;
      const dom = v.slice(at + 1);
      if (!dom) return;
      for (let i = 0; i < MAIL_PROVIDERS.length; i++) {
        if (MAIL_PROVIDERS[i].domains.indexOf(dom) >= 0) {
          if (MAIL_PROVIDERS[i].key !== currentKey) selectProvider(MAIL_PROVIDERS[i].key);
          return;
        }
      }
    }
    if (emailEl) emailEl.addEventListener('input', detectFromEmail);
    selectProvider(currentKey);
    if (emailEl) emailEl.focus();

    function submitMail() {
      const email = emailEl && emailEl.value.trim();
      const pass = passEl && passEl.value;
      if (!email || !pass) { if (errEl) errEl.textContent = 'Email and app-password are required.'; return; }
      const body = { email: email, password: pass };
      if (hostEl && hostEl.value.trim()) body.host = hostEl.value.trim();
      if (errEl) errEl.textContent = '';
      if (startEl) { startEl.disabled = true; startEl.textContent = 'Checking…'; }
      fetch('/api/mail/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) {
          if (!r.ok) { return r.text().then(function (t) { t = errorText(t); if (errEl) errEl.textContent = t || ('failed (' + r.status + ')'); if (startEl) { startEl.disabled = false; startEl.textContent = 'Connect →'; } }); }
          closeModal();
          if (window.refreshMail) window.refreshMail();
        })
        .catch(function () { if (errEl) errEl.textContent = 'Network error.'; if (startEl) { startEl.disabled = false; startEl.textContent = 'Connect →'; } });
    }
    if (startEl) startEl.addEventListener('click', submitMail);
    if (passEl) passEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submitMail(); } });
  }
  // Exposed so the Mail rail view (setupConsole/loadMail) reuses the same
  // connect-mailbox modal instead of duplicating it.
  window.lisaOpenMailModal = openMailModal;
  var sbMailConnectBtn = document.getElementById('sbMailConnectBtn');
  if (sbMailConnectBtn) sbMailConnectBtn.addEventListener('click', openMailModal);
  // The Mail nav tile was removed to lock the launcher to a clean 3x3; the
  // sidebar Mail card's header is now the entry into the full Mail view.
  var sbMailHead = document.querySelector('#sbMailCard .h');
  if (sbMailHead) {
    sbMailHead.style.cursor = 'pointer';
    sbMailHead.title = 'Open Mail';
    sbMailHead.addEventListener('click', function () {
      if (typeof window.lisaShowView === 'function') window.lisaShowView('mail');
    });
  }

  // ── Delegated wiring (真实E2E修复) ───────────────────────────────────
  // The tree / needs-you / inspector / stream controls REBUILD on every
  // roster tick (SSE fires every few seconds while agents are active), so
  // per-node listeners kept landing real clicks on freshly-replaced dead
  // elements — "I clicked and nothing happened". One listener per STABLE
  // container; nodes carry data-* attributes.
  function selectAgentAndStream(agent, sid) {
    selInsp = { type: 'agent', key: agent + '/' + sid };
    renderInspector();
    const found = agentByKey(agent + '/' + sid);
    openStreamTab({ t: 'agent', agent: agent, id: sid, label: found ? agentLabel(found) : sid });
  }
  function runDelegatedAction(act, fam, agent, sid, cwd, sendText, approvalId) {
    if (act === 'stream') { selectAgentAndStream(agent, sid); return; }
    if (act === 'approve') { agentAction('managed', sid, 'approve', { allow: true, approvalId: approvalId }); return; }
    if (act === 'deny') { agentAction('managed', sid, 'approve', { allow: false, approvalId: approvalId }); return; }
    if (act === 'cancel') { agentAction(fam, sid, 'cancel', null); return; }
    if (act === 'output') { ptyOutput(sid); return; }
    if (act === 'send') { agentAction(fam, sid, 'send', { text: sendText }); return; }
    if (act === 'adopt') {
      fetch('/api/agents/pty/start', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'claude', resumeSessionId: sid, cwd: cwd || '' }),
      }).then(function (r) {
        if (!r.ok) { return r.text().then(function (t) { openModal('adopt', '<pre>' + escapeHtml(errorText(t)) + '</pre>'); }); }
        if (typeof refreshClaudeSessions === 'function') refreshClaudeSessions();
      }).catch(function () {});
    }
  }
  const treeEl = document.getElementById('sessionTree');
  let sessionMenu = null;
  function leafTarget(leaf) {
    const lisaId = leaf.getAttribute('data-lisa-id');
    return {
      kind: lisaId ? 'lisa' : 'agent/' + leaf.getAttribute('data-agent'),
      id: lisaId || leaf.getAttribute('data-session'),
      name: leaf.querySelector('.tname').textContent,
    };
  }
  function focusSessionLeaf(target) {
    const leaf = Array.from(treeEl.querySelectorAll('.tleaf')).find(node => {
      const candidate = leafTarget(node);
      return candidate.kind === target.kind && candidate.id === target.id;
    });
    if (leaf) leaf.focus();
  }
  function closeSessionMenu() {
    if (sessionMenu) sessionMenu.remove();
    sessionMenu = null;
  }
  function renameSession(target) {
    closeSessionMenu();
    const dialog = document.createElement('dialog');
    dialog.className = 'session-rename-dialog';
    dialog.setAttribute('aria-labelledby', 'sessionRenameTitle');
    dialog.innerHTML = '<form class="session-rename-form">' +
      '<h2 id="sessionRenameTitle"></h2><label for="sessionRenameInput"></label>' +
      '<input id="sessionRenameInput" name="name" type="text" maxlength="120" autocomplete="off" aria-describedby="sessionRenameError" />' +
      '<p id="sessionRenameError" role="alert"></p><div class="session-rename-actions">' +
      '<button type="button" class="rename-cancel"></button><button type="submit" class="rename-save"></button></div></form>';
    dialog.querySelector('h2').textContent = tr('session.rename');
    dialog.querySelector('label').textContent = tr('session.name');
    const field = dialog.querySelector('input');
    field.value = target.name;
    const cancel = dialog.querySelector('.rename-cancel');
    const save = dialog.querySelector('.rename-save');
    const error = dialog.querySelector('#sessionRenameError');
    cancel.textContent = tr('session.cancel');
    save.textContent = tr('session.save');
    let saving = false;
    cancel.onclick = () => dialog.close();
    dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
    dialog.addEventListener('click', event => { if (event.target === dialog && !saving) dialog.close(); });
    dialog.addEventListener('close', () => { dialog.remove(); focusSessionLeaf(target); });
    field.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) event.preventDefault();
    });
    dialog.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      if (saving) return;
      const name = field.value.trim();
      if (!name || name.length > 120 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(name)) {
        error.textContent = tr('session.invalidName');
        field.setAttribute('aria-invalid', 'true');
        field.focus();
        return;
      }
      error.textContent = '';
      field.removeAttribute('aria-invalid');
      saving = true;
      save.disabled = cancel.disabled = field.disabled = true;
      dialog.setAttribute('aria-busy', 'true');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const response = await fetch('/api/session-names', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: target.kind, id: target.id, name }), signal: ctrl.signal,
        });
        if (!response.ok) throw new Error('rename failed');
        const entry = await response.json();
        window.lisaSessionRenamed(entry);
        dialog.close();
      } catch (e) {
        error.textContent = tr('session.renameFailed');
      } finally {
        clearTimeout(timer);
        saving = false;
        save.disabled = cancel.disabled = field.disabled = false;
        dialog.removeAttribute('aria-busy');
        if (dialog.open) field.focus();
      }
    });
    document.body.appendChild(dialog);
    dialog.showModal();
    field.focus();
    field.select();
  }
  function openSessionMenu(leaf, x, y) {
    closeSessionMenu();
    const target = leafTarget(leaf);
    const menu = document.createElement('div');
    menu.className = 'session-context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', target.name);
    const action = document.createElement('button');
    action.type = 'button';
    action.setAttribute('role', 'menuitem');
    action.innerHTML = '<span aria-hidden="true">✎</span><span></span><kbd>F2</kbd>';
    action.children[1].textContent = tr('session.rename');
    action.onclick = () => renameSession(target);
    menu.appendChild(action);
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        closeSessionMenu(); focusSessionLeaf(target);
      } else if (event.key === 'Tab') {
        closeSessionMenu(); focusSessionLeaf(target);
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); action.focus();
      }
    });
    (leaf.closest('dialog[open]') || document.body).appendChild(menu);
    sessionMenu = menu;
    const box = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - box.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - box.height - 8)) + 'px';
    action.focus({ preventScroll: true });
  }
  if (treeEl) {
    treeEl.addEventListener('contextmenu', event => {
      const leaf = event.target.closest('.tleaf');
      if (!leaf || !treeEl.contains(leaf)) return;
      event.preventDefault();
      openSessionMenu(leaf, event.clientX, event.clientY);
    });
    treeEl.addEventListener('keydown', event => {
      const leaf = event.target.closest('.tleaf');
      if (!leaf || !treeEl.contains(leaf)) return;
      if (event.key === 'F2') {
        event.preventDefault(); renameSession(leafTarget(leaf));
      } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault();
        const box = leaf.getBoundingClientRect();
        openSessionMenu(leaf, box.left + 24, box.bottom);
      }
    });
  }
  document.addEventListener('pointerdown', event => {
    if (sessionMenu && !sessionMenu.contains(event.target)) closeSessionMenu();
  });
  // Dismiss on user scrolling. A queued scroll from revealing the row or a
  // roster refresh must not dismiss the menu immediately after right-click.
  document.addEventListener('wheel', closeSessionMenu, { passive: true });
  document.addEventListener('touchmove', closeSessionMenu, { passive: true });
  window.addEventListener('resize', closeSessionMenu);
  window.addEventListener('blur', closeSessionMenu);
  if (treeEl) treeEl.addEventListener('click', function (e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const leaf = t.closest('.tleaf');
    if (leaf && treeEl.contains(leaf)) {
      const lisaId = leaf.getAttribute('data-lisa-id');
      if (lisaId) {
        selInsp = { type: 'lisa', id: lisaId };
        renderInspector();
        closeStreamView();
        if (lisaId === window.lisaActiveSessionId) renderSessionUI();
        else switchSession(lisaId);
        return;
      }
      const agent = leaf.getAttribute('data-agent');
      const sid = leaf.getAttribute('data-session');
      if (agent && sid) {
        const all = treeEl.querySelectorAll('.tleaf.active');
        for (let i = 0; i < all.length; i++) all[i].classList.remove('active');
        leaf.classList.add('active');
        selectAgentAndStream(agent, sid);
      }
      return;
    }
    const node = t.closest('.tnode');
    if (node && treeEl.contains(node)) {
      const tkey = node.getAttribute('data-toggle');
      if (tkey && node.parentElement) toggleCollapsed(node.parentElement, tkey);
    }
  });
  const stripEl = document.getElementById('tabStrip');
  if (stripEl) stripEl.addEventListener('click', function (e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const btn = t.closest('[data-act]');
    if (btn && btn.getAttribute('data-act') === 'close-stream') {
      closeStreamView();
      renderSessionUI();
    }
  });
  const needsEl = document.getElementById('sbNeedsRows');
  if (needsEl) needsEl.addEventListener('click', function (e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const row = t.closest('.needs-row');
    if (!row) return;
    const agent = row.getAttribute('data-agent');
    const sid = row.getAttribute('data-session');
    const btn = t.closest('[data-act]');
    if (btn) { runDelegatedAction(btn.getAttribute('data-act'), 'managed', agent, sid, '', null, btn.getAttribute('data-approval')); return; }
    if (agent && sid) selectAgentAndStream(agent, sid);
  });
  const inspEl = document.getElementById('sbClaudeRows');
  if (inspEl) {
    inspEl.addEventListener('click', function (e) {
      const t = e.target;
      if (!t || !t.closest) return;
      const btn = t.closest('[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      if (act === 'open-lisa') { switchSession(btn.getAttribute('data-lisa-id')); return; }
      const acts = t.closest('.insp-actions');
      if (!acts) return;
      runDelegatedAction(act, acts.getAttribute('data-fam'), acts.getAttribute('data-agent'), acts.getAttribute('data-session'), acts.getAttribute('data-cwd'), null, btn.getAttribute('data-approval'));
    });
    inspEl.addEventListener('keydown', function (e) {
      const t = e.target;
      if (!t || !t.classList || !t.classList.contains('mc-send')) return;
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && t.value.trim()) {
        e.preventDefault();
        const acts = t.closest('.insp-actions');
        if (acts) runDelegatedAction('send', acts.getAttribute('data-fam'), acts.getAttribute('data-agent'), acts.getAttribute('data-session'), '', t.value.trim());
        t.value = '';
      }
    });
  }
  const permEl = document.getElementById('asPerm');
  if (permEl) permEl.addEventListener('click', function (e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const btn = t.closest('[data-act]');
    if (btn) runDelegatedAction(btn.getAttribute('data-act'), 'managed', '', permEl.getAttribute('data-session'), '', null, btn.getAttribute('data-approval'));
  });
  const footEl = document.getElementById('asFoot');
  if (footEl) {
    footEl.addEventListener('click', function (e) {
      const t = e.target;
      if (!t || !t.closest) return;
      const btn = t.closest('[data-act]');
      if (btn) runDelegatedAction(btn.getAttribute('data-act'), footEl.getAttribute('data-fam'), '', footEl.getAttribute('data-session'), '');
    });
    footEl.addEventListener('keydown', function (e) {
      const t = e.target;
      if (!t || !t.classList || !t.classList.contains('mc-send')) return;
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && t.value.trim()) {
        e.preventDefault();
        runDelegatedAction('send', footEl.getAttribute('data-fam'), '', footEl.getAttribute('data-session'), '', t.value.trim());
        t.value = '';
      }
    });
  }

  // Bootstrap + periodic resync. SSE handles the fast-path updates;
  // these timers are belt-and-braces in case the stream silently dies.
  refreshPing();
  window.refreshClaudeSessions();
  window.refreshMail();
  refreshIdentity();
  refreshSessionsBadge();
  refreshTokens();
  setInterval(refreshPing, 30_000);
  // Resolve refreshClaudeSessions at call time (arrow), not now: setupConsole
  // later wraps window.refreshClaudeSessions to re-render the active console
  // view + nav count, and the wrapper must win on this 60s tick too.
  setInterval(() => window.refreshClaudeSessions(), 60_000);
  setInterval(window.refreshMail, 5 * 60_000);
  setInterval(refreshSessionsBadge, 5 * 60_000);
  // Cheap resync for the tokens section; chat_end gives the fast path.
  setInterval(refreshTokens, 5 * 60_000);
})();

// ════════════════════════════════════════════════════════════════════
// Console view-switcher — adds Dashboard / Control / Reve / Sense /
// Memory views beside the default Chat. Purely additive: the chat
// pipeline and every existing id stay untouched. Each non-chat view is
// built lazily from the real endpoints on first activation, and the live
// agent stream (refreshClaudeSessions) is wrapped to re-render the active
// console view. No backticks / no template placeholders in this block.
// ════════════════════════════════════════════════════════════════════
(function setupConsole() {
  var navList = document.getElementById('navList');
  if (!navList) return;
  var views = {
    chat: document.getElementById('viewChat'),
    dashboard: document.getElementById('viewDashboard'),
    control: document.getElementById('viewControl'),
    reve: document.getElementById('viewReve'),
    room: document.getElementById('viewRoom'),
    sense: document.getElementById('viewSense'),
    memory: document.getElementById('viewMemory'),
    mail: document.getElementById('viewMail'),
    settings: document.getElementById('viewSettings'),
    kb: document.getElementById('viewKb'),
  };
  var loaded = {};
  var active = 'chat';
  var proactiveOn = true;

  function esc(s) { return (typeof escapeHtml === 'function') ? escapeHtml(s) : String(s == null ? '' : s); }
  function getJSON(u) { return fetch(u).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); }

  function statusClass(state) {
    if (state === 'working') return 'working';
    if (state === 'waiting') return 'waiting';
    if (state === 'error') return 'error';
    if (state === 'done' || state === 'idle') return 'done';
    return '';
  }
  function statusLabel(state) {
    if (state === 'working') return 'Working';
    if (state === 'waiting') return 'Waiting';
    if (state === 'error') return 'Error';
    if (state === 'done') return 'Done';
    if (state === 'idle') return 'Idle';
    return 'Unknown';
  }
  // Compact activity line (local copy of the sidebar helper — kept decoupled).
  function actLine(s) {
    var a = s && s.activity;
    if (!a || typeof a !== 'object') return '';
    if (a.pendingPermission) return 'wants to run ' + a.pendingPermission;
    var bits = [];
    if (a.lastError) bits.push(a.lastError);
    if (typeof a.turnCount === 'number' && a.turnCount > 0) bits.push('turn ' + a.turnCount);
    if (a.tokens && (a.tokens.input || a.tokens.output)) {
      var tot = (a.tokens.input || 0) + (a.tokens.output || 0);
      bits.push(tot >= 1000 ? Math.round(tot / 1000) + 'k tok' : tot + ' tok');
    }
    var tool = a.lastTools && a.lastTools.length ? a.lastTools[a.lastTools.length - 1] : '';
    var file = a.filesTouched && a.filesTouched.length ? (String(a.filesTouched[a.filesTouched.length - 1]).split('/').pop() || '') : '';
    if (tool && file) bits.push(tool + ' ' + file);
    else if (tool) bits.push(tool);
    else if (file) bits.push(file);
    return bits.join(' · ');
  }
  function updateAgentCount(n) {
    var c = document.getElementById('navAgentCount');
    if (c) c.textContent = String(n);
  }

  // ── view switching ──────────────────────────────────────────────
  function syncRoomVisibility() {
    var room = document.getElementById('roomFrame');
    if (room && room.contentWindow) room.contentWindow.postMessage({ type: 'lisa-room-visibility', visible: active === 'room' && !document.hidden && (!window.LisaMotion || window.LisaMotion.active()) }, location.origin);
  }
  var motionRoom = document.getElementById('roomFrame');
  if (motionRoom) motionRoom.addEventListener('load', syncRoomVisibility);
  window.addEventListener('lisa-motion-change', syncRoomVisibility);
  window.addEventListener('message', function (event) {
    if (motionRoom && event.source === motionRoom.contentWindow && event.origin === location.origin && event.data && event.data.type === 'lisa-room-ready') syncRoomVisibility();
  });
  function loadView(name) {
    // KB builds once, then refreshes its list on every re-show (it changes).
    if (name === 'kb') { if (!loaded.kb) { loaded.kb = true; loadKb(); } else { loadKbList(); } return; }
    if (name === 'reve' && loaded.reve) { window.LisaReve.refresh(); return; }
    if (loaded[name]) return;
    loaded[name] = true;
    if (name === 'dashboard') loadDashboard();
    else if (name === 'control') loadControl();
    else if (name === 'reve') loadReve();
    else if (name === 'sense') loadSense();
    else if (name === 'memory') loadMemory();
    else if (name === 'mail') loadMail();
    else if (name === 'settings') loadSettings();
    else if (name === 'room') { var rf = document.getElementById('roomFrame'); if (rf && !rf.getAttribute('src')) rf.setAttribute('src', '/room'); }
  }
  function showView(name) {
    if (!views[name]) name = 'chat';
    active = name;
    for (var k in views) { if (views[k]) views[k].classList.toggle('active', k === name); }
    var items = navList.querySelectorAll('.nav-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', items[i].getAttribute('data-view') === name);
    }
    if (name !== 'chat') loadView(name);
    else if (!window.matchMedia('(max-width: 720px)').matches) { try { document.getElementById('input').focus(); } catch (e) {} }
    document.body.dataset.view = name;
    window.dispatchEvent(new CustomEvent('lisa-view-change', { detail: { view: name } }));
    syncRoomVisibility();
    try { history.replaceState(null, '', name === 'chat' ? location.pathname + location.search : '#' + name); } catch (e) {}
  }
  navList.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.nav-item') : null;
    if (btn && btn.getAttribute('data-view')) showView(btn.getAttribute('data-view'));
  });
  window.lisaShowView = showView;

  // (The Room iframe → parent "message" bridge lives at module scope near the
  //  top of this file — it handles the richer {type:'lisa-room', action, prefill}
  //  protocol the Room now posts, superseding the old room_open_chat listener.)

  // ── proactive autonomy state (the toggle UI now lives in the Settings rail
  //    view; this owns the state + keeps the Dashboard proactive panel and the
  //    Settings switch in sync via setProactiveUI) ─────────────────────────
  function setProactiveUI(on) {
    proactiveOn = !!on;
    var sw = document.getElementById('setProactiveToggle');
    if (sw) { sw.classList.toggle('on', proactiveOn); sw.setAttribute('aria-checked', proactiveOn ? 'true' : 'false'); }
    var pp = document.getElementById('ppPanel');
    if (pp) {
      pp.classList.toggle('off', !proactiveOn);
      var st = document.getElementById('ppState');
      if (st) st.textContent = proactiveOn ? 'On · watching' : 'Paused';
      var sd = document.getElementById('ppDesc');
      if (sd) sd.textContent = proactiveOn ? 'Lisa watches your agents, tasks and signals for blockers and next steps.' : 'Resting — she will only act when you talk to her.';
    }
  }
  function syncProactive() {
    getJSON('/api/autonomy/state').then(function (s) { if (s && typeof s.enabled === 'boolean') setProactiveUI(s.enabled); });
  }
  function toggleProactive() {
    var on = !proactiveOn;
    setProactiveUI(on);
    fetch('/api/autonomy/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: on }) })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (j) { if (j && typeof j.enabled === 'boolean') setProactiveUI(j.enabled); else setProactiveUI(!on); })
      .catch(function () { setProactiveUI(!on); });
  }
  syncProactive();

  // ── Dashboard ───────────────────────────────────────────────────
  function agentCardHTML(s) {
    var cls = statusClass(s.state);
    var act = actLine(s);
    return '<div class="ac">' +
      '<div class="ac-top"><span>' + esc(s.agent || 'agent') + '</span><span class="ac-status ' + cls + '">' + esc(statusLabel(s.state)) + '</span></div>' +
      '<div class="ac-title">' + esc(window.lisaAgentLabel(s) || s.agent || 'agent') + '</div>' +
      '<div class="ac-desc">' + (act ? esc(act) : 'no recent activity') + '</div>' +
      '</div>';
  }
  // A dead pid says nothing about success: dispatched agents are detached, so a
  // crash, an OOM kill and a clean finish are indistinguishable from the pid
  // alone. The server sends a classified `status` (running | ok | failed |
  // unknown); `alive` is the fallback for a pre-status backend, and there an
  // exited dispatch is UNKNOWN, never "Done".
  function dispatchState(d) {
    switch (d && d.status) {
      case 'running': return { cls: 'working', label: 'Running' };
      case 'ok': return { cls: 'done', label: 'Done' };
      case 'failed': return {
        cls: 'error',
        label: d.exitSignal ? 'Killed · ' + d.exitSignal
          : (typeof d.exitCode === 'number' ? 'Failed · exit ' + d.exitCode : 'Failed'),
      };
      case 'unknown': return { cls: 'waiting', label: 'Exited · status unknown' };
      default: return d && d.alive
        ? { cls: 'working', label: 'Running' }
        : { cls: 'waiting', label: 'Exited · status unknown' };
    }
  }
  function taskCardHTML(d) {
    var st = dispatchState(d);
    return '<div class="ac">' +
      '<div class="ac-top"><span>' + esc(d.agent || 'dispatch') + '</span><span class="ac-status ' + st.cls + '">' + esc(st.label) + '</span></div>' +
      '<div class="ac-title">' + esc(String(d.task || 'task').slice(0, 80)) + '</div>' +
      '<div class="ac-meta">' + esc(d.cwd ? String(d.cwd).split('/').pop() : 'dispatch') + '</div>' +
      '</div>';
  }
  function loadDashboard() {
    views.dashboard.innerHTML =
      '<div class="view-head"><div><h2>Dashboard</h2><div class="vh-sub">Operations at a glance</div></div>' +
      '<button class="view-act" id="dashDelegate">+ Delegate a task</button></div>' +
      '<div class="view-scroll" id="dashScroll"><div class="view-empty">loading…</div></div>';
    var del = document.getElementById('dashDelegate');
    if (del) del.addEventListener('click', function () { if (typeof window.lisaOpenDelegate === 'function') window.lisaOpenDelegate(); });
    renderDashboard();
  }
  function renderDashboard() {
    var scroll = document.getElementById('dashScroll');
    if (!scroll) return;
    Promise.all([
      getJSON('/api/agents/sessions'), getJSON('/api/dispatch/list'),
      getJSON('/api/sense/recent'), getJSON('/api/island/ping'),
    ]).then(function (res) {
      var sessions = (res[0] && res[0].sessions) || [];
      var dispatches = (res[1] && res[1].dispatches) || [];
      var events = (res[2] && res[2].events) || [];
      var ping = res[3] || {};
      updateAgentCount(sessions.length);
      var aliveTasks = dispatches.filter(function (d) { return d.alive; }).length;
      var waiting = sessions.filter(function (s) { return s.state === 'waiting'; }).length;
      var errored = sessions.filter(function (s) { return s.state === 'error'; }).length;
      var desire = ping.current_desire || '';
      var html = '';
      html += '<div class="stat-bar">' +
        '<div class="stat"><div class="n">' + sessions.length + '</div><div class="k">Agents</div></div>' +
        '<div class="stat"><div class="n">' + aliveTasks + '</div><div class="k">Tasks</div></div>' +
        '<div class="stat"><div class="n">' + dispatches.length + '</div><div class="k">Dispatched</div></div>' +
        '<div class="stat"><div class="n">' + events.length + '</div><div class="k">Signals</div></div></div>';
      html += '<div class="proactive-panel' + (proactiveOn ? '' : ' off') + '" id="ppPanel"><div class="pp-head"><span class="pp-dot"></span>' +
        '<div><div class="pp-title">Proactive mode <b id="ppState">' + (proactiveOn ? 'On · watching' : 'Paused') + '</b></div>' +
        '<div class="pp-desc" id="ppDesc">' + (proactiveOn ? 'Lisa watches your agents, tasks and signals for blockers and next steps.' : 'Resting — she will only act when you talk to her.') + '</div></div></div>' +
        '<div class="pp-tags"><span class="pp-tag">' + sessions.length + ' agents</span><span class="pp-tag">' + aliveTasks + ' tasks</span>' +
        (waiting ? '<span class="pp-tag warn">' + waiting + ' waiting</span>' : '') +
        (errored ? '<span class="pp-tag warn">' + errored + ' errored</span>' : '') +
        '<span class="pp-tag">owner-routed</span><span class="pp-tag">quiet on waits</span></div></div>';
      html += '<div class="view-sec-label">Focus · currently pursuing</div>';
      if (desire) {
        html += '<div class="focus-card"><div class="fc-top">' +
          '<span class="fc-label">Self-directed</span><span class="fc-pill">Active</span></div>' +
          '<p class="fc-title">' + esc(desire) + '</p></div>';
      } else {
        html += '<div class="focus-card"><div class="fc-desc">Nothing actively pursued right now.</div></div>';
      }
      html += '<div class="view-sec-label">Agents &amp; tasks</div>';
      var cards = sessions.map(agentCardHTML).concat(dispatches.slice(0, 6).map(taskCardHTML));
      html += cards.length ? '<div class="card-scroll">' + cards.join('') + '</div>'
                           : '<div class="view-empty">No active agents or tasks. Delegate one to get started.</div>';
      scroll.innerHTML = html;
    });
  }

  // ── Control ─────────────────────────────────────────────────────
  // Progress-only activity line (turns/tokens/cmd/tool·file) — the pending
  // and error states get their own dedicated inline lines below.
  function ctrlProgress(s) {
    var a = s.activity; if (!a || typeof a !== 'object') return '';
    var bits = [];
    if (typeof a.turnCount === 'number' && a.turnCount > 0) bits.push('turn ' + a.turnCount);
    if (a.tokens && (a.tokens.input || a.tokens.output)) {
      var tot = (a.tokens.input || 0) + (a.tokens.output || 0);
      bits.push(tot >= 1000 ? Math.round(tot / 1000) + 'k tok' : tot + ' tok');
    }
    if (a.lastCommandName) bits.push('$ ' + a.lastCommandName);
    var tool = a.lastTools && a.lastTools.length ? a.lastTools[a.lastTools.length - 1] : '';
    var file = a.filesTouched && a.filesTouched.length ? (String(a.filesTouched[a.filesTouched.length - 1]).split('/').pop() || '') : '';
    if (tool && file) bits.push(tool + ' ' + file);
    else if (tool) bits.push(tool);
    else if (file) bits.push(file);
    return bits.join(' · ');
  }
  function ctrlRowHTML(s) {
    var id = esc(s.sessionId);
    var scls = statusClass(s.state);
    var a = s.activity || {};
    var pend = a.pendingPermission;
    var err = a.lastError || (s.state === 'error' ? (s.stateReason || 'errored') : '');
    var label = window.lisaAgentLabel(s) || s.sessionId || 'agent';
    var badge = (s.agent && s.agent !== 'claude-code') ? '<span class="cr-badge">' + esc(s.agent) + '</span>' : '';
    var sub = ctrlProgress(s);
    var rowCls = 'ctrl-row' + (err ? ' problem' : (pend ? ' pending' : ''));
    var h = '<div class="' + rowCls + '" data-sid="' + id + '" role="button" tabindex="0">';
    h += '<div class="cr-pip ' + scls + '"></div>';
    h += '<div class="cr-name">' + badge + '<span class="cr-id" title="' + esc(label) + '">' + esc(label) + '</span></div>';
    h += '<span class="st-chip ' + scls + '">' + esc(statusLabel(s.state)) + '<span class="cr-arrow"> ›</span></span>';
    if (sub) h += '<div class="cr-sub">' + esc(sub) + '</div>';
    if (pend) {
      h += '<div class="cr-pend">⚠ wants to run ' + esc(pend);
      if (s.controllable === 'managed') {
        // The server resolves only the request this row shows, so the buttons carry its id.
        var aid = esc(a.approvalId || '');
        h += '<button class="cr-quick ok" data-q="approve" data-sid="' + id + '" data-approval="' + aid + '">approve</button>';
        h += '<button class="cr-quick no" data-q="deny" data-sid="' + id + '" data-approval="' + aid + '">deny</button>';
      }
      h += '</div>';
    } else if (err) {
      h += '<div class="cr-err" title="' + esc(err) + '">✗ ' + esc(err) + '</div>';
    }
    h += '</div>';
    return h;
  }
  // The decision body for a Control row's quick approve/deny button.
  function ctrlQuickDecision(btn) {
    var body = { allow: btn.getAttribute('data-q') === 'approve' };
    var approvalId = btn.getAttribute('data-approval');
    if (approvalId) body.approvalId = approvalId;
    return body;
  }
  // POST an action to the right agent family, surfacing the server error text.
  function sdAction(fam, id, action, body) {
    return fetch('/api/agents/' + fam + '/' + encodeURIComponent(id) + '/' + action, {
      method: 'POST',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { t = errorText(t); throw new Error(String(r.status) + (t ? ' ' + t : '')); });
      return r.json().catch(function () { return {}; });
    });
  }
  // Click a Control row → a rich per-session inspector (status + follow-up
  // actions + surfaced problem). Re-fetches on open so it always reflects truth.
  function openSessionDetail(id) {
    getJSON('/api/agents/sessions').then(function (res) {
      var sessions = (res && res.sessions) || [];
      var s = null;
      for (var i = 0; i < sessions.length; i++) { if (sessions[i].sessionId === id) { s = sessions[i]; break; } }
      if (!s) { openModal('Session', '<div class="sd"><div class="sd-note">This session is no longer active.</div></div>'); return; }
      var a = s.activity || {};
      var fam = s.controllable;
      var scls = statusClass(s.state);
      var title = (s.agent && s.agent !== 'claude-code' ? s.agent + ' · ' : '') + (window.lisaAgentLabel(s) || 'agent');
      function rel(iso) { var ms = Date.now() - new Date(iso).getTime(); if (ms < 60000) return 'just now'; if (ms < 3600000) return Math.round(ms / 60000) + 'm ago'; if (ms < 86400000) return Math.round(ms / 3600000) + 'h ago'; return Math.round(ms / 86400000) + 'd ago'; }
      function row(k, v) { return '<dt>' + k + '</dt><dd>' + v + '</dd>'; }
      var h = '<div class="sd">';
      h += '<div class="sd-top"><span class="st-chip ' + scls + '">' + esc(statusLabel(s.state)) + '</span>';
      if (fam) h += '<span class="sd-chip">' + esc(fam) + '</span>';
      if (s.resumable) h += '<span class="sd-chip">adoptable</span>';
      h += '<span class="sd-id">' + esc(s.sessionId) + '</span></div>';
      if (a.pendingPermission) {
        h += '<div class="sd-banner pend"><div>⚠ Waiting for approval to run <b>' + esc(a.pendingPermission) + '</b></div>';
        if (fam === 'managed') h += '<div class="sd-b-row"><button class="sd-btn ok" data-sd="approve">Approve</button><button class="sd-btn danger" data-sd="deny">Deny</button></div>';
        h += '</div>';
      }
      if (a.lastError || s.state === 'error') {
        h += '<div class="sd-banner err">✗ ' + esc(a.lastError || s.stateReason || 'errored') + '</div>';
      }
      h += '<dl class="sd-grid">';
      h += row('State', esc(statusLabel(s.state)) + (s.stateReason ? ' <span style="color:var(--fg-3)">(' + esc(s.stateReason) + ')</span>' : ''));
      if (typeof a.turnCount === 'number' && a.turnCount > 0) h += row('Turns', String(a.turnCount));
      if (a.tokens && (a.tokens.input || a.tokens.output)) h += row('Tokens', String(a.tokens.input || 0) + ' in · ' + String(a.tokens.output || 0) + ' out');
      if (a.gitBranch) h += row('Branch', esc(a.gitBranch));
      if (a.lastCommandName) h += row('Last command', esc(a.lastCommandName));
      if (a.lastTools && a.lastTools.length) h += row('Recent tools', '<div class="sd-chips">' + a.lastTools.slice(-6).map(function (t) { return '<span class="sd-chip">' + esc(t) + '</span>'; }).join('') + '</div>');
      if (a.filesTouched && a.filesTouched.length) h += row('Files', '<div class="sd-chips">' + a.filesTouched.slice(-8).map(function (f) { return '<span class="sd-chip">' + esc(String(f).split('/').pop() || f) + '</span>'; }).join('') + '</div>');
      if (s.cwd) h += row('Path', esc(s.cwd));
      h += row('Last activity', esc(rel(s.lastMtime)));
      h += '</dl>';
      h += '<div class="sd-actions">';
      if (fam && s.state !== 'done' && !a.pendingPermission) {
        h += '<input class="sd-send" id="sdSend" type="text" placeholder="' + (fam === 'pty' ? 'type into the CLI…' : 'send a follow-up…') + '">';
        h += '<button class="sd-btn primary" data-sd="send">Send</button>';
      }
      if (fam === 'pty') h += '<button class="sd-btn" data-sd="output">View output</button>';
      if (fam && s.state !== 'done') h += '<button class="sd-btn danger" data-sd="cancel">Cancel</button>';
      if (s.resumable) h += '<button class="sd-btn ok" data-sd="adopt">⇲ Adopt</button>';
      if (!fam && !s.resumable) h += '<span class="sd-note">Observe-only — no control channel for this session.</span>';
      h += '</div>';
      h += '<pre class="sd-out" id="sdOut" style="display:none"></pre>';
      h += '</div>';
      openModal(title, h);
      var body = document.getElementById('modalBody');
      if (!body) return;
      function sdErr(err) { body.insertAdjacentHTML('afterbegin', '<div class="sd-banner err" style="margin-bottom:12px">✗ ' + esc(err && err.message ? err.message : 'action failed') + '</div>'); }
      function afterAct(p) { p.then(function () { if (window.refreshClaudeSessions) window.refreshClaudeSessions(); openSessionDetail(id); }).catch(sdErr); }
      function doSend() { var inp = document.getElementById('sdSend'); var t = inp && inp.value.trim(); if (t) afterAct(sdAction(fam, id, 'send', { text: t })); }
      var btns = body.querySelectorAll('[data-sd]');
      for (var j = 0; j < btns.length; j++) {
        btns[j].addEventListener('click', function () {
          var act = this.getAttribute('data-sd');
          if (act === 'approve') afterAct(sdAction('managed', id, 'approve', { allow: true, approvalId: s.activity.approvalId }));
          else if (act === 'deny') afterAct(sdAction('managed', id, 'approve', { allow: false, approvalId: s.activity.approvalId }));
          else if (act === 'cancel') afterAct(sdAction(fam, id, 'cancel', null));
          else if (act === 'send') doSend();
          else if (act === 'adopt') afterAct(fetch('/api/agents/pty/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'claude', resumeSessionId: s.sessionId, cwd: s.cwd || '' }) }).then(function (r) { if (!r.ok) return r.text().then(function (t) { throw new Error(errorText(t)); }); }));
          else if (act === 'output') {
            var out = document.getElementById('sdOut');
            if (out) { out.style.display = 'block'; out.textContent = 'loading…'; }
            getJSON('/api/agents/pty/' + encodeURIComponent(id) + '/output').then(function (d) { if (out) out.textContent = (d && d.output) ? d.output : '(no output yet)'; });
          }
        });
      }
      var sendInp = document.getElementById('sdSend');
      if (sendInp) { sendInp.focus(); sendInp.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); doSend(); } }); }
    });
  }
  function loadControl() {
    views.control.innerHTML =
      '<div class="view-head"><div><h2>Control</h2><div class="vh-sub">Live agents &amp; control plane · click a session to inspect</div></div>' +
      '<button class="view-act" id="ctrlDelegate">+ Delegate a task</button></div>' +
      '<div class="view-scroll" id="ctrlScroll"><div class="view-empty">loading…</div></div>';
    var del = document.getElementById('ctrlDelegate');
    if (del) del.addEventListener('click', function () { if (typeof window.lisaOpenDelegate === 'function') window.lisaOpenDelegate(); });
    renderControl();
  }
  var changingCodexObservation = false;
  var controlRender = 0;
  function renderControl() {
    var scroll = document.getElementById('ctrlScroll');
    if (!scroll) return;
    var render = ++controlRender;
    Promise.all([getJSON('/api/agents/sessions'), getJSON('/api/control/policy')]).then(function (res) {
      if (render !== controlRender) return;
      if (!res[0] || !Array.isArray(res[0].sessions) || !res[1]) {
        scroll.innerHTML = '<div class="view-empty" role="alert">' + esc(tr('control.loadError')) + '</div>';
        return;
      }
      var sessions = res[0].sessions;
      var policy = res[1] || {};
      updateAgentCount(sessions.length);
      // Surface problems first: error → waiting(needs you) → working → rest.
      var rank = { error: 0, waiting: 1, working: 2, done: 4, idle: 5 };
      sessions = sessions.slice().sort(function (x, y) {
        var rx = rank[x.state]; if (rx === undefined) rx = 3;
        var ry = rank[y.state]; if (ry === undefined) ry = 3;
        if (rx !== ry) return rx - ry;
        return new Date(y.lastMtime).getTime() - new Date(x.lastMtime).getTime();
      });
      var html = '<div class="ctrl-policy">' +
        '<span class="pp-tag">remote control: ' + (policy.remoteControl ? 'on' : 'off') + '</span>' +
        '<span class="pp-tag">adopt external: ' + (policy.remoteAdoptExternal ? 'on' : 'off') + '</span></div>';
      var observation = policy.codexObservation;
      if (observation && (observation.detected || observation.enabled)) {
        html += '<div class="v-row codex-observation"><div class="v-main"><div class="v-name">Codex</div><div class="v-sub">' +
          esc(tr(observation.enabled ? 'control.window' : 'control.found')) +
          '</div></div>' + (observation.enabled && !observation.showsActivity ? '<button type="button" class="sd-btn" id="codexConversations">' + esc(tr('control.upgrade')) + '</button>' : '') +
          '<button type="button" class="sd-btn" id="codexObservation"' + (changingCodexObservation ? ' disabled' : '') + '>' +
          esc(tr(observation.enabled ? 'control.disable' : 'control.enable')) + '</button></div>';
      }
      if (sessions.length) {
        html += '<div class="ctrl-list">';
        sessions.forEach(function (s) { html += ctrlRowHTML(s); });
        html += '</div>';
      } else {
        html += '<div class="view-empty">' + esc(tr('control.empty')) +
          (observation && !observation.detected ? ' ' + esc(tr('control.missing')) : '') + '</div>';
      }
      scroll.innerHTML = html;
      var toggle = scroll.querySelector('#codexObservation');
      var conversations = scroll.querySelector('#codexConversations');
      if (toggle) toggle.addEventListener('click', changeObservation);
      if (conversations) conversations.addEventListener('click', changeObservation);
      async function changeObservation(event) {
        if (changingCodexObservation) return;
        changingCodexObservation = true;
        toggle.disabled = true;
        if (conversations) conversations.disabled = true;
        var enabled = event.currentTarget === conversations || !observation.enabled;
        try {
          var response = await fetch('/api/agents/codex/observation', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            // Only the "Show conversations" button asks for transcripts. The plain
            // toggle must leave a hand-set metadata-only visibility alone.
            body: JSON.stringify({ enabled: enabled, showConversations: event.currentTarget === conversations })
          });
          if (!response.ok) throw new Error();
          changingCodexObservation = false;
          await window.refreshClaudeSessions();
        } catch {
          changingCodexObservation = false;
          var button = scroll.querySelector('#codexObservation');
          if (button) button.disabled = false;
          if (conversations) conversations.disabled = false;
          scroll.insertAdjacentHTML('afterbegin', '<div class="view-empty" role="alert">' + esc(tr('control.saveError')) + '</div>');
        }
      }
      // Inline quick approve/deny — stopPropagation so they do not open the detail.
      var quicks = scroll.querySelectorAll('.cr-quick');
      for (var q = 0; q < quicks.length; q++) {
        quicks[q].addEventListener('click', function (e) {
          e.stopPropagation();
          var self = e.currentTarget;
          self.disabled = true;
          sdAction('managed', self.getAttribute('data-sid'), 'approve', ctrlQuickDecision(self))
            .then(function () { if (window.refreshClaudeSessions) window.refreshClaudeSessions(); renderControl(); })
            .catch(function (err) { self.disabled = false; scroll.insertAdjacentHTML('afterbegin', '<div class="view-empty" style="color:var(--err-color)">' + esc(err.message) + '</div>'); });
        });
      }
      // Row → detail inspector.
      var rows = scroll.querySelectorAll('.ctrl-row');
      for (var r = 0; r < rows.length; r++) {
        rows[r].addEventListener('click', function (ev) { openSessionDetail(ev.currentTarget.getAttribute('data-sid')); });
        rows[r].addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openSessionDetail(ev.currentTarget.getAttribute('data-sid')); } });
      }
    });
  }

  // ── Reve ────────────────────────────────────────────────────────
  function loadReve() {
    window.LisaReve.mount(views.reve);
  }

  // ── Sense ───────────────────────────────────────────────────────
  function loadSense() {
    views.sense.innerHTML =
      '<div class="view-head"><div><h2>Sense</h2><div class="vh-sub">Ambient signals Lisa may see</div></div></div>' +
      '<div class="view-scroll" id="senseScroll"><div class="view-empty">loading…</div></div>';
    renderSense();
  }
  function renderSense() {
    var scroll = document.getElementById('senseScroll');
    if (!scroll) return;
    Promise.all([
      getJSON('/api/consent'),
      getJSON('/api/sense/recent'),
      getJSON('/api/sense/social/connectors'),
      getJSON('/api/sense/social/drafts'),
      getJSON('/api/sense/social/status')
    ]).then(function (res) {
      var grants = (res[0] && res[0].grants) || [];
      var events = (res[1] && res[1].events) || [];
      var connectors = (res[2] && res[2].connectors) || [];
      var drafts = (res[3] && res[3].drafts) || [];
      var paused = Boolean(res[4] && res[4].paused);
      // UX-11: with no connector installed there is no publishing to be
      // active or paused, and offering "Pause publishing" implied there was.
      // State line only until something can actually publish.
      var html = connectors.length
        ? '<div class="social-policy"><span>Publishing ' + (paused ? 'paused' : 'active') +
          '</span><button class="social-action" id="socialPauseBtn">' + (paused ? 'Resume publishing' : 'Pause publishing') +
          '</button></div>'
        : '<div class="social-policy neutral"><span>' + esc(tr('sense.noConnector')) + '</span></div>';
      html += '<div class="view-sec-label">Connected media</div><div class="v-card">';
      if (!connectors.length) {
        html += '<div class="view-empty" style="padding:6px 0">No social connector installed. Ask Lisa to help connect a supported account.</div>';
      }
      connectors.forEach(function (item) {
        var c = item.manifest;
        var accounts = item.accounts || [];
        html += '<div class="v-row"><div class="v-main"><div class="v-name">' +
          esc(c ? c.displayName : item.plugin) + '</div><div class="v-sub">' +
          esc(c ? (accounts.length ? accounts.map(function (a) { return a.handle || a.displayName || a.id; }).join(', ') : c.platform + ' · ready to link') : item.error || 'unavailable') +
          '</div></div><span class="social-state ' + (c ? 'ready' : 'failed') + '">' +
          (c ? (accounts.length ? 'linked' : 'available') : 'error') + '</span></div>';
      });
      html += '</div><div class="view-sec-label">Post drafts</div><div class="v-card">';
      if (!drafts.length) {
        html += '<div class="view-empty" style="padding:6px 0">No drafts yet. Tell Lisa what you want to publish.</div>';
      }
      drafts.slice().reverse().slice(0, 20).forEach(function (d) {
        var targetLabel = (d.targets || []).map(function (t) { return t.platform + ' · ' + t.accountId; }).join(', ');
        var body = (d.canonical && (d.canonical.text || d.canonical.title || d.canonical.link)) || '';
        var mediaCount = (d.canonical && d.canonical.media && d.canonical.media.length) || 0;
        html += '<div class="social-draft"><div class="social-draft-head"><span class="social-state ' +
          esc(d.state) + '">' + esc(d.state) + '</span><span class="v-sub">revision ' +
          esc(d.revision) + '</span></div><div class="v-name">' + esc(body || 'Media post') +
          '</div><div class="v-sub">' + esc(targetLabel) +
          (mediaCount ? ' · ' + mediaCount + ' media' : '') + '</div>';
        if (d.state === 'awaiting-approval' && d.approvalDigest) {
          var approvalSnapshot = JSON.stringify({
            targets: d.targets || [],
            canonical: d.canonical || {},
            variants: d.variants || {}
          }, null, 2);
          html += '<div class="social-preview-note">Confirm this immutable snapshot. Any edit will require a new confirmation.</div>' +
            '<pre class="v-pre social-approval-snapshot">' + esc(approvalSnapshot) + '</pre>' +
            '<button class="social-action primary" data-social-approve="' + esc(d.id) +
            '" data-social-digest="' + esc(d.approvalDigest) + '">Approve snapshot</button>';
        }
        if (['draft', 'awaiting-approval', 'approved', 'failed', 'expired'].indexOf(d.state) >= 0) {
          html += '<button class="social-action" data-social-cancel="' + esc(d.id) + '">Cancel</button>';
        }
        html += '</div>';
      });
      html += '</div><div class="view-sec-label">Consent</div><div class="v-card">';
      if (!grants.length) html += '<div class="view-empty" style="padding:6px 0">No signals configured.</div>';
      grants.forEach(function (g) {
        html += '<div class="v-row"><div class="v-main"><div class="v-name">' + esc(g.signal) + '</div>' +
          (g.description ? '<div class="v-sub">' + esc(g.description) + '</div>' : '') + '</div>' +
          '<button class="v-toggle' + (g.granted ? ' on' : '') + '" data-signal="' + esc(g.signal) + '" data-on="' + (g.granted ? '1' : '0') + '">' + (g.granted ? 'on' : 'off') + '</button></div>';
      });
      html += '</div><div class="view-sec-label">Recently sensed</div><div class="v-card">';
      if (!events.length) html += '<div class="view-empty" style="padding:6px 0">Nothing captured.</div>';
      events.slice(0, 30).forEach(function (e) {
        html += '<div class="v-row"><div class="v-main"><div class="v-name" style="font-weight:400">' + esc(e.summary || '') + '</div>' +
          '<div class="v-sub">' + esc([e.signal, e.kind, e.app].filter(Boolean).join(' · ')) + '</div></div></div>';
      });
      html += '</div>';
      scroll.innerHTML = html;
      var tgs = scroll.querySelectorAll('.v-toggle');
      for (var i = 0; i < tgs.length; i++) {
        tgs[i].addEventListener('click', function () {
          var sig = this.getAttribute('data-signal');
          var on = this.getAttribute('data-on') === '1';
          fetch(on ? '/api/consent/revoke' : '/api/consent/grant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signal: sig }) })
            .then(function () { renderSense(); }).catch(function () {});
        });
      }
      var approveButtons = scroll.querySelectorAll('[data-social-approve]');
      for (var a = 0; a < approveButtons.length; a++) {
        approveButtons[a].addEventListener('click', function (ev) {
          var self = ev.currentTarget;
          var id = self.getAttribute('data-social-approve');
          var digest = self.getAttribute('data-social-digest');
          self.disabled = true;
          fetch('/api/sense/social/drafts/' + encodeURIComponent(id) + '/approve', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ digest: digest })
          }).then(function (r) {
            if (!r.ok) throw new Error('approval failed');
            renderSense();
          }).catch(function () { renderSense(); });
        });
      }
      var cancelButtons = scroll.querySelectorAll('[data-social-cancel]');
      for (var c = 0; c < cancelButtons.length; c++) {
        cancelButtons[c].addEventListener('click', function (ev) {
          var self = ev.currentTarget;
          var id = self.getAttribute('data-social-cancel');
          self.disabled = true;
          fetch('/api/sense/social/drafts/' + encodeURIComponent(id) + '/cancel', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
          }).then(function () { renderSense(); }).catch(function () { renderSense(); });
        });
      }
      var pauseButton = document.getElementById('socialPauseBtn');
      if (pauseButton) {
        pauseButton.addEventListener('click', function () {
          this.disabled = true;
          fetch('/api/sense/social/' + (paused ? 'resume' : 'pause'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
          }).then(function () { renderSense(); }).catch(function () { renderSense(); });
        });
      }
    });
  }

  // ── Memory (launchers for the existing modal panels) ────────────
  function memBtn(key, ico, title, sub) {
    return '<button class="mem-btn" data-mem="' + key + '"><span class="mem-ico">' + ico + '</span>' + title + '<span class="mem-sub">' + sub + '</span></button>';
  }
  function loadMemory() {
    views.memory.innerHTML =
      '<div class="view-head"><div><h2>Memory</h2><div class="vh-sub">Soul · skills · memory · tools</div></div></div>' +
      '<div class="view-scroll">' +
      memBtn('soul', '★', 'Soul', 'identity · values · emotions') +
      memBtn('skills', '✦', 'Skills', 'saved workflows') +
      memBtn('memory', '▤', 'Memory', 'USER.md · MEMORY.md') +
      memBtn('tools', '⚒', 'Tools', 'capabilities') +
      memBtn('plans', '◆', 'Coding plans', 'subscription CLIs') +
      '</div>';
    var mbs = views.memory.querySelectorAll('.mem-btn');
    for (var i = 0; i < mbs.length; i++) {
      mbs[i].addEventListener('click', function () {
        var w = this.getAttribute('data-mem');
        if (w === 'soul' && typeof showSoul === 'function') showSoul();
        else if (w === 'skills' && typeof showSkills === 'function') showSkills();
        else if (w === 'memory' && typeof showMemory === 'function') showMemory();
        else if (w === 'tools' && typeof showTools === 'function') showTools();
        else if (w === 'plans' && typeof showPlans === 'function') showPlans();
      });
    }
  }

  // ── Mail (full rail view — reuses the sidebar mail endpoints and adds the
  //    per-account management the compact sidebar card lacks) ──────────────
  function mailNeedsRow(i) {
    var urgent = i.importance >= 3;
    return '<div class="mail-row">' +
      '<span class="mail-bang' + (urgent ? ' urgent' : '') + '">' + (urgent ? '‼' : '!') + '</span>' +
      '<span class="mail-subj" title="' + esc((i.from || '') + ' — ' + (i.reason || '')) + '">' + esc(i.subject || '(no subject)') + '</span>' +
      '</div>';
  }
  function renderMailView(accounts, digest) {
    var scroll = document.getElementById('mailScroll');
    if (!scroll) return;
    accounts = accounts || [];
    var needs = (digest && digest.needsYou) ? digest.needsYou : [];
    var html = '';
    if (!accounts.length) {
      html += '<div class="v-card"><div class="view-empty" style="padding:6px 0">No mailbox connected yet. Connect one for a daily classified digest — read-only, stored locally (0600).</div></div>';
    } else {
      html += '<div class="view-sec-label">Digest</div><div class="v-card">';
      html += '<div class="mail-summary">' + esc(digest && digest.summary ? digest.summary : 'No digest yet — sweep to build one.') + '</div>';
      if (needs.length) { for (var n = 0; n < needs.length; n++) html += mailNeedsRow(needs[n]); }
      else html += '<div class="view-empty" style="padding:6px 0">Nothing needs you right now.</div>';
      html += '</div>';
      html += '<div class="view-sec-label">Mailboxes</div><div class="v-card">';
      for (var a = 0; a < accounts.length; a++) {
        var ac = accounts[a];
        var on = ac.enabled !== false;
        html += '<div class="v-row"><div class="v-main">' +
          '<div class="v-name">' + esc(ac.label || ac.email || ac.id) + '</div>' +
          '<div class="v-sub">' + esc((ac.email || '') + (ac.host ? ' · ' + ac.host : '')) + '</div></div>' +
          '<button class="v-toggle' + (on ? ' on' : '') + '" data-mail-id="' + esc(ac.id) + '" data-mail-act="' + (on ? 'disable' : 'enable') + '">' + (on ? 'on' : 'off') + '</button>' +
          '<button class="v-del" data-mail-id="' + esc(ac.id) + '" data-mail-act="remove">remove</button></div>';
      }
      html += '</div>';
    }
    scroll.innerHTML = html;
    var btns = scroll.querySelectorAll('[data-mail-act]');
    for (var b = 0; b < btns.length; b++) {
      btns[b].addEventListener('click', function (ev) {
        var self = ev.currentTarget;
        var id = self.getAttribute('data-mail-id');
        var act = self.getAttribute('data-mail-act');
        if (act === 'remove' && !window.confirm('Remove this mailbox from Lisa? Access is read-only; nothing is deleted on the server.')) return;
        self.disabled = true;
        fetch('/api/mail/accounts/' + encodeURIComponent(id) + '/' + act, { method: 'POST' })
          .then(function () { if (window.refreshMail) window.refreshMail(); })
          .catch(function () {});
      });
    }
  }
  window.lisaMailViewRender = renderMailView;
  function loadMail() {
    views.mail.innerHTML =
      '<div class="view-head"><div><h2>Mail</h2><div class="vh-sub">Daily classified digest · read-only</div></div>' +
      '<button class="view-act" id="mailConnectBtn">＋ Connect mailbox</button></div>' +
      '<div class="view-scroll"><div id="mailScroll"><div class="view-empty">loading…</div></div>' +
      '<div style="margin-top:14px"><button class="view-act" id="mailSweepBtn" style="background:var(--bg-3);color:var(--fg)">Sweep now</button></div></div>';
    var cb = document.getElementById('mailConnectBtn');
    if (cb) cb.addEventListener('click', function () { if (window.lisaOpenMailModal) window.lisaOpenMailModal(); });
    var sb = document.getElementById('mailSweepBtn');
    if (sb) sb.addEventListener('click', function () {
      sb.disabled = true; sb.textContent = 'Sweeping…';
      fetch('/api/mail/sweep', { method: 'POST' })
        .then(function () { if (window.refreshMail) window.refreshMail(); })
        .catch(function () {})
        .then(function () { sb.disabled = false; sb.textContent = 'Sweep now'; });
    });
    if (window.refreshMail) window.refreshMail();
  }

  // ── Settings (API keys · Proactive · Compact · About) ─────────────────
  function renderSettings(status, edition) {
    var scroll = document.getElementById('settingsScroll');
    if (!scroll) return;
    status = status || {};
    var chip = function (ok) { return '<span class="set-chip' + (ok ? ' ok' : '') + '">' + (ok ? 'configured' : 'not set') + '</span>'; };
    var compactOn = (typeof window.lisaGetCompact === 'function') ? window.lisaGetCompact() : false;
    var edName = (edition && edition.edition) ? edition.edition : '—';
    var sw = function (id, on, label) {
      return '<div class="set-switch' + (on ? ' on' : '') + '" id="' + id + '" role="switch" aria-label="' + esc(label) + '" aria-checked="' + (on ? 'true' : 'false') + '" tabindex="0"><span class="knob"></span></div>';
    };
    var html = '';
    html += '<div class="view-sec-label">Display</div><div class="set-card">';
    html += '<div class="set-row"><div class="set-main"><label class="set-name" for="setTheme">Appearance</label><div class="set-sub">Choose a look, or follow your device automatically</div></div><select class="set-input set-theme" id="setTheme"><option value="system">System</option><option value="calm">Light · Calm</option><option value="nebula">Dark · Nebula</option></select></div>';
    html += '<div class="set-row"><div class="set-main"><div class="set-name">Compact mode</div><div class="set-sub">Dock Lisa as a narrow stacked panel at any window width</div></div>' + sw('setCompactToggle', compactOn, 'Compact mode') + '</div>';
    html += '</div>';
    // Provider list + one picker, driven by the same table the key gate uses
    // (UX-1 wave 2). Was an Anthropic-and-OpenAI-only pair of inputs, which
    // made every other provider a config.env edit.
    var provs = window.lisaProviderList(status);
    if (edName !== 'cloud') {
      html += '<div class="view-sec-label">Model provider</div><div class="set-card">';
      for (var pi = 0; pi < provs.length; pi++) {
        var pv = provs[pi];
        if (!pv.configured) continue;
        html += '<div class="set-row"><div class="set-main"><div class="set-name">' + esc(pv.label) +
          '</div></div>' + chip(pv.configured) + '</div>';
      }
      html += '<div class="set-form">' +
        '<select class="set-input" id="setProvider" aria-label="Model provider"></select>' +
        '<input class="set-input" id="setKey" aria-label="API key" type="password" autocomplete="off" spellcheck="false" placeholder="key… (leave blank to keep)">' +
        '<input class="set-input" id="setBaseUrl" aria-label="Provider URL" type="text" autocomplete="off" spellcheck="false" placeholder="https://host/v1" style="display:none">' +
        '<input class="set-input" id="setModel" aria-label="Model (optional)" type="text" autocomplete="off" spellcheck="false" placeholder="model (optional)">' +
        '<div style="display:flex;gap:10px;align-items:center"><button class="view-act" id="setKeySave">Save</button><span class="set-err" id="setKeyMsg"></span></div>' +
        '<div class="set-note">Saved on the machine running Lisa. Leave the key blank to keep your existing connection.</div></div>';
      html += '</div>';
    }
    html += '<div class="view-sec-label">Automation</div><div class="set-card">';
    html += '<div class="set-row"><div class="set-main"><div class="set-name">Proactive mode</div><div class="set-sub">Let Lisa watch your agents, tasks and signals and act when you are away</div></div>' + sw('setProactiveToggle', proactiveOn, 'Proactive mode') + '</div>';
    html += '</div>';
    // Reach-out charter controls (docs/POLICY_REACH_OUT.md): filled in by
    // loadReachOut() once /api/reachout/settings answers.
    html += '<div class="view-sec-label">Proactivity</div><div class="set-card" id="setReachOut"><div class="set-row"><div class="set-note">loading…</div></div></div>';
    html += '<div class="view-sec-label">About</div><div class="set-card">';
    html += '<div class="set-row"><div class="set-main"><div class="set-name">Edition</div><div class="set-sub">Runtime build</div></div><span class="set-chip">' + esc(edName) + '</span></div>';
    // A discoverable entry point for the shortcut list — "press ?" is only
    // findable if you already know it is there (UX-11).
    html += '<div class="set-row"><div class="set-main"><div class="set-name">Keyboard shortcuts</div><div class="set-sub">⌘K switch · ⌘/ focus · ⌘F find · ? this list</div></div><button class="v-toggle" id="setShortcuts">show</button></div>';
    if (edName !== 'cloud') html += '<div class="set-row"><div class="set-main"><div class="set-name">Anthropic Console</div><div class="set-sub">Manage billing &amp; keys</div></div><a class="set-chip" href="https://console.anthropic.com/" target="_blank" rel="noopener">open ↗</a></div>';
    html += '</div>';
    scroll.innerHTML = html;
    void window.LisaExpressions.mountSettings(scroll);

    var themePicker = document.getElementById('setTheme');
    if (themePicker) {
      themePicker.value = window.lisaGetThemePreference();
      themePicker.addEventListener('change', function () { window.lisaSetTheme(themePicker.value); });
    }
    var pt = document.getElementById('setProactiveToggle');
    if (pt) {
      pt.addEventListener('click', toggleProactive);
      pt.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleProactive(); } });
    }
    var ct = document.getElementById('setCompactToggle');
    if (ct) {
      var flip = function () { if (window.lisaSetCompact) window.lisaSetCompact(!(window.lisaGetCompact && window.lisaGetCompact())); };
      ct.addEventListener('click', flip);
      ct.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
    }
    var scBtn = document.getElementById('setShortcuts');
    if (scBtn) scBtn.addEventListener('click', function () {
      if (typeof window.lisaShowShortcuts === 'function') window.lisaShowShortcuts();
    });
    var sel = document.getElementById('setProvider');
    var keyEl = document.getElementById('setKey');
    var modelEl = document.getElementById('setModel');
    var baseEl = document.getElementById('setBaseUrl');
    var pick = function () {
      for (var i = 0; i < provs.length; i++) if (provs[i].id === sel.value) return provs[i];
      return provs[0];
    };
    if (sel) {
      var preselect = '';
      for (var q = 0; q < provs.length; q++) {
        var o = document.createElement('option');
        o.value = provs[q].id;
        o.textContent = provs[q].label + (provs[q].configured ? ' · configured' : '');
        sel.appendChild(o);
        if (provs[q].configured && !preselect) preselect = provs[q].id;
      }
      sel.value = preselect || (provs[0] ? provs[0].id : '');
      var syncSel = function () {
        var pv = pick();
        if (!pv) return;
        keyEl.placeholder = pv.envKey + ' — ' + pv.placeholder + (pv.configured ? ' (leave blank to keep)' : '');
        modelEl.placeholder = pv.model ? ('model (optional · ' + pv.model + ')') : 'model (optional)';
        baseEl.style.display = pv.custom ? '' : 'none';
      };
      sel.addEventListener('change', syncSel);
      syncSel();
    }
    var saveBtn = document.getElementById('setKeySave');
    if (saveBtn) saveBtn.addEventListener('click', function () {
      var msg = document.getElementById('setKeyMsg');
      var pv = pick();
      var key = keyEl ? keyEl.value.trim() : '';
      var model = modelEl ? modelEl.value.trim() : '';
      // Same rule as the gate: pin a model only where the server cannot
      // infer one from the key.
      if (!model && key && pv.needsModel && pv.model) model = pv.model;
      var base = (pv && pv.custom && baseEl) ? baseEl.value.trim() : '';
      if (!pv) return;
      if (!key && !model && !base) { if (msg) { msg.style.color = ''; msg.textContent = 'Enter a key or a model to update.'; } return; }
      if (pv.custom && key && !base) { if (msg) { msg.style.color = ''; msg.textContent = 'A custom endpoint needs its base URL.'; } return; }
      if (msg) { msg.style.color = ''; msg.textContent = 'Saving…'; }
      saveBtn.disabled = true;
      fetch('/api/config/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(window.lisaProviderSaveBody(pv, key, model, base)) })
        .then(function (r) { if (!r.ok) return r.text().then(function (t) { t = errorText(t); throw new Error(t || ('failed (' + r.status + ')')); }); return r.json(); })
        .then(function () { return getJSON('/api/config/status').catch(function () { return null; }); })
        .then(function (after) {
          // Same guard as the gate: say so when this backend dropped the key
          // instead of reporting a save that did not happen.
          if (key && after && window.lisaProviderConfirm(pv, after) === false) {
            throw new Error(window.lisaProviderUnsupportedNote(pv));
          }
          if (keyEl) keyEl.value = '';
          if (msg) { msg.style.color = 'var(--proactive)'; msg.textContent = 'Saved.'; }
          loadSettings();
        })
        .catch(function (err) { if (msg) { msg.style.color = ''; msg.textContent = (err && err.message) ? err.message : 'save failed'; } })
        .then(function () { saveBtn.disabled = false; });
    });
    // Refresh Proactive state from the server so the switch reflects truth.
    syncProactive();
    loadReachOut();
  }

  // ── Proactivity: how much Lisa may reach out (dial · quiet hours · sources).
  //    "Proactive mode" above is whether she acts on her own; this is how much
  //    she may interrupt. Approvals and critical alerts are never held back. ──
  var RO_DIALS = [['off', 'Off — in the app only'], ['low', 'Low — 1 push a day'], ['normal', 'Normal — 3 pushes a day'], ['high', 'High — 8 pushes a day']];
  var RO_SOURCES = [
    ['task', 'Task results', 'Your own tasks and routines finishing'],
    ['watcher', 'Watchers', 'Something you asked her to watch changed'],
    ['mail', 'Mail', 'Daily digest and important-mail alerts'],
    ['brief', 'Daily brief', 'Knowledge-base feeds brief'],
    ['advisor', 'Agent advisor', 'Stuck or conflicting coding agents'],
    ['idle', 'While you were away', 'Notes from her idle time'],
    ['desire', 'Her own notes', 'Progress on her own desires — in the app unless push is on below'],
    ['system', 'System', 'Security and host events']
  ];
  function renderReachOut(view) {
    var box = document.getElementById('setReachOut');
    if (!box) return;
    if (!view || !view.settings) { box.innerHTML = '<div class="set-row"><div class="set-note">Proactivity settings are unavailable.</div></div>'; return; }
    var s = view.settings, b = view.budget || {}, q = s.quietHours || {}, src = s.sources || {};
    var sw = function (id, on, label) {
      return '<div class="set-switch' + (on ? ' on' : '') + '" id="' + id + '" role="switch" aria-label="' + esc(label) + '" aria-checked="' + (on ? 'true' : 'false') + '" tabindex="0"><span class="knob"></span></div>';
    };
    var row = function (name, sub, control) {
      return '<div class="set-row"><div class="set-main"><div class="set-name">' + esc(name) + '</div><div class="set-sub">' + esc(sub) + '</div></div>' + control + '</div>';
    };
    var opts = '';
    for (var i = 0; i < RO_DIALS.length; i++) {
      opts += '<option value="' + RO_DIALS[i][0] + '"' + (RO_DIALS[i][0] === s.dial ? ' selected' : '') + '>' + esc(RO_DIALS[i][1]) + '</option>';
    }
    var used = (typeof b.usedToday === 'number' && typeof b.daily === 'number') ? (b.usedToday + ' of ' + b.daily + ' used today. ') : '';
    var h = row('How proactive', used + 'Approvals and critical alerts always get through.',
      '<select class="set-input" id="roDial" style="width:auto" aria-label="How proactive">' + opts + '</select>');
    var times = '<span style="display:flex;gap:6px;align-items:center">' +
      '<input class="set-input" id="roQuietStart" type="time" style="width:auto" aria-label="Quiet hours start" value="' + esc(q.start || '22:00') + '">' +
      '<input class="set-input" id="roQuietEnd" type="time" style="width:auto" aria-label="Quiet hours end" value="' + esc(q.end || '08:00') + '">' +
      sw('roQuietToggle', !!q.enabled, 'Quiet hours') + '</span>';
    h += row('Quiet hours', (view.quietNow ? 'Quiet now. ' : '') + 'Pushes wait until the window ends' + (q.tz ? ' (' + q.tz + ')' : '') + '.', times);
    for (var j = 0; j < RO_SOURCES.length; j++) {
      h += row(RO_SOURCES[j][1], RO_SOURCES[j][2], sw('roSrc_' + RO_SOURCES[j][0], src[RO_SOURCES[j][0]] !== false, RO_SOURCES[j][1]));
    }
    h += row('Push her own notes', 'Let notes about her own desires use push too', sw('roDesirePush', !!s.desirePush, 'Push her own notes'));
    var note = function (text) { return '<div class="set-row"><div class="set-note">' + esc(text) + '</div></div>'; };
    if (view.channelsAvailable && view.channelsAvailable.push === false) {
      h += note('Push is not available here, so everything stays in the app.');
    }
    if (view.proactiveMode === false) {
      h += note('Proactive mode is off, so idle notes and her own notes stay in the app.');
    }
    box.innerHTML = h;

    var onSwitch = function (id, fn) {
      var el = document.getElementById(id);
      if (!el) return;
      var go = function () { fn(!el.classList.contains('on')); };
      el.addEventListener('click', go);
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    };
    var dial = /** @type {HTMLSelectElement | null} */ (document.getElementById('roDial'));
    if (dial) dial.addEventListener('change', function () { saveReachOut({ dial: dial.value }); });
    var qs = /** @type {HTMLInputElement | null} */ (document.getElementById('roQuietStart'));
    var qe = /** @type {HTMLInputElement | null} */ (document.getElementById('roQuietEnd'));
    var saveQuiet = function () {
      if (qs && qe && qs.value && qe.value && qs.value !== qe.value) saveReachOut({ quietHours: { start: qs.value, end: qe.value } });
    };
    if (qs) qs.addEventListener('change', saveQuiet);
    if (qe) qe.addEventListener('change', saveQuiet);
    onSwitch('roQuietToggle', function (on) { saveReachOut({ quietHours: { enabled: on } }); });
    onSwitch('roDesirePush', function (on) { saveReachOut({ desirePush: on }); });
    RO_SOURCES.forEach(function (def) {
      onSwitch('roSrc_' + def[0], function (on) { var p = {}; p[def[0]] = on; saveReachOut({ sources: p }); });
    });
  }
  function loadReachOut() {
    getJSON('/api/reachout/settings').then(renderReachOut).catch(function () { renderReachOut(null); });
  }
  function saveReachOut(patch) {
    fetch('/api/reachout/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (view) { if (view) renderReachOut(view); else loadReachOut(); })
      .catch(function () { loadReachOut(); });
  }
  function loadSettings() {
    views.settings.innerHTML =
      '<div class="view-head"><div><h2>Settings</h2><div class="vh-sub">Keys · automation · display</div></div></div>' +
      '<div class="view-scroll"><div id="settingsScroll"><div class="view-empty">loading…</div></div></div>';
    getJSON('/api/edition').then(function (edition) {
      if (edition && edition.edition === 'cloud') renderSettings(null, edition);
      else getJSON('/api/config/status').then(function (status) { renderSettings(status, edition); });
    });
  }
  // ── Knowledge base view (docs/archive/plans/PLAN_KNOWLEDGE_BASE_v1.0.md) ──────────
  function kbRenderList(entries, container) {
    if (!entries || !entries.length) {
      container.innerHTML = '<div class="view-empty">Nothing here yet. In Chat, select messages and "Add to KB", or ask Lisa to save something.</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var tags = (e.tags && e.tags.length) ? e.tags.map(function (t) { return '#' + t; }).join(' ') : '';
      html += '<button class="kb-item" data-layer="' + esc(e.layer) + '" data-slug="' + esc(e.slug) + '">'
        + '<span class="kb-row"><span class="kb-badge ' + esc(e.layer) + '">' + (e.layer === 'wiki' ? 'wiki' : 'source') + '</span>'
        + '<span class="kb-title">' + esc(e.title) + '</span></span>'
        + (tags ? '<span class="kb-tags">' + esc(tags) + '</span>' : '')
        + (e.excerpt ? '<span class="kb-excerpt">' + esc(e.excerpt) + '</span>' : '')
        + '</button>';
    }
    container.innerHTML = html;
    var items = container.querySelectorAll('.kb-item');
    for (var j = 0; j < items.length; j++) {
      items[j].addEventListener('click', function () {
        kbOpen(this.getAttribute('data-layer'), this.getAttribute('data-slug'));
      });
    }
  }
  function kbOpen(layer, slug) {
    var reader = document.getElementById('kbReader');
    if (!reader) return;
    reader.classList.add('open');
    reader.innerHTML = '<div class="view-empty">loading…</div>';
    getJSON('/api/kb/entry?layer=' + encodeURIComponent(layer) + '&slug=' + encodeURIComponent(slug)).then(function (d) {
      if (!d || !d.entry) { reader.innerHTML = '<div class="view-empty">not found</div>'; return; }
      var e = d.entry;
      var meta = [];
      if (e.tags && e.tags.length) meta.push('tags: ' + e.tags.join(', '));
      if (e.sources && e.sources.length) meta.push('sources: ' + e.sources.join(', '));
      if (e.origin) meta.push('origin: ' + e.origin);
      reader.innerHTML =
        '<div class="kb-reader-head"><span class="kb-badge ' + esc(e.layer) + '">' + (e.layer === 'wiki' ? 'wiki' : 'source') + '</span>'
        + '<h3>' + esc(e.title) + '</h3><button class="kb-del" title="Delete">✕</button></div>'
        + (meta.length ? '<div class="kb-reader-meta">' + esc(meta.join('  ·  ')) + '</div>' : '')
        + '<pre class="kb-reader-body">' + esc(e.body) + '</pre>';
      var del = reader.querySelector('.kb-del');
      if (del) del.addEventListener('click', function () {
        if (window.confirm('Delete "' + e.title + '"? This removes it from your knowledge base.')) kbDelete(e.layer, e.slug);
      });
    });
  }
  function kbDelete(layer, slug) {
    fetch('/api/kb/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ layer: layer, slug: slug }) })
      .then(function () {
        var reader = document.getElementById('kbReader');
        if (reader) { reader.classList.remove('open'); reader.innerHTML = ''; }
        loadKbList();
      });
  }
  var kbSearchTimer = null;
  function loadKbList() {
    var listEl = document.getElementById('kbList');
    if (!listEl) return;
    var box = document.getElementById('kbSearch');
    var q = box ? box.value : '';
    if (q && q.trim()) {
      getJSON('/api/kb/search?q=' + encodeURIComponent(q)).then(function (d) {
        kbRenderList((d && d.hits) || [], listEl);
      });
    } else {
      getJSON('/api/kb').then(function (d) {
        kbRenderList((d && d.entries) || [], listEl);
      });
    }
  }
  function kbIngestSubmit() {
    var urlEl = document.getElementById('kbIngestUrl');
    var go = document.getElementById('kbIngestGo');
    var status = document.getElementById('kbIngestStatus');
    if (!urlEl || !go) return;
    var url = (urlEl.value || '').trim();
    if (!url) return;
    go.disabled = true;
    urlEl.disabled = true;
    if (status) { status.className = 'kb-ingest-status'; status.textContent = 'Fetching & extracting…'; }
    fetch('/api/kb/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: url }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        go.disabled = false;
        urlEl.disabled = false;
        if (d && d.ok) {
          urlEl.value = '';
          var note = d.deduped ? 'Already saved — opening it' : 'Saved via ' + (d.via || 'generic');
          if (d.transcript && String(d.transcript).indexOf('unavailable') === 0) note += ' (no transcript — you can paste one)';
          if (status) status.textContent = note;
          loadKbList();
          if (d.entry) kbOpen(d.entry.layer, d.entry.slug);
        } else if (status) {
          status.className = 'kb-ingest-status err';
          status.textContent = (d && d.error) ? d.error : 'Ingest failed';
        }
      })
      .catch(function () {
        go.disabled = false;
        urlEl.disabled = false;
        if (status) { status.className = 'kb-ingest-status err'; status.textContent = 'Ingest failed (network)'; }
      });
  }
  function loadKb() {
    views.kb.innerHTML =
      '<div class="view-head"><div><h2>Knowledge Base</h2><div class="vh-sub">Sources + wiki · live search</div></div></div>'
      + '<div class="kb-ingestbar"><input id="kbIngestUrl" class="kb-ingest-url" type="url" placeholder="Paste a link to save — WeChat · Bilibili · YouTube · any article" autocomplete="off"><button type="button" id="kbIngestGo" class="kb-ingest-go">Save</button><span id="kbIngestStatus" class="kb-ingest-status"></span></div>'
      + '<div class="kb-searchbar"><input id="kbSearch" class="kb-search" type="text" placeholder="Search your knowledge base…" autocomplete="off"></div>'
      + '<div class="kb-body"><div id="kbList" class="kb-list"></div><div id="kbReader" class="kb-reader"></div></div>';
    var s = document.getElementById('kbSearch');
    if (s) s.addEventListener('input', function () {
      if (kbSearchTimer) clearTimeout(kbSearchTimer);
      kbSearchTimer = setTimeout(loadKbList, 200);
    });
    var go = document.getElementById('kbIngestGo');
    if (go) go.addEventListener('click', kbIngestSubmit);
    var u = document.getElementById('kbIngestUrl');
    if (u) u.addEventListener('keydown', function (e) { if (e.key === 'Enter') kbIngestSubmit(); });
    loadKbList();
  }
  window.lisaReloadKb = loadKbList;

  // ── live refresh: wrap the agent-session refresh so the active console
  //    view + the Control nav count update on SSE agent_session_update.
  var origRefresh = window.refreshClaudeSessions;
  window.refreshClaudeSessions = function () {
    var r = origRefresh ? origRefresh.apply(this, arguments) : undefined;
    Promise.resolve(r).then(function () {
      if (active === 'dashboard') renderDashboard();
      else if (active === 'control') renderControl();
      else getJSON('/api/agents/sessions').then(function (d) { updateAgentCount((d && d.sessions) ? d.sessions.length : 0); });
    });
    return r;
  };
  getJSON('/api/agents/sessions').then(function (d) { updateAgentCount((d && d.sessions) ? d.sessions.length : 0); });

  // ── init: honor a deep-link hash, else default to chat ──────────
  var initial = (location.hash || '').replace('#', '');
  showView(views[initial] ? initial : 'chat');
  window.addEventListener('hashchange', function () {
    var h = (location.hash || '').replace('#', '');
    if (views[h] && h !== active) showView(h);
  });
})();

// ── Warden approvals (W2a) ──────────────────────────────────────────────
// A side-effecting tool call that the policy will not auto-allow waits in the
// server's approval inbox. This renders it as an inline card in the chat log
// and in a small pending list, and answers through /api/approvals.
//
// The card shows the WHOLE payload the approval covers — fetched from
// GET /api/approvals/{id}, in the order the server chose — and approving sends
// back the digest of exactly that payload. A caller the server will not show
// the payload to gets no approve button at all. Everything is set with
// textContent: the payload is model-proposed input and must never be parsed
// as HTML. (A full inbox view is a later PR.)
(function () {
  var chatLog = document.getElementById('log');
  if (!chatLog) return;
  /** @type {Record<string, { item: any, card: HTMLElement, row: HTMLElement | null }>} */
  var pending = Object.create(null);
  var panel = null;
  var panelList = null;
  var panelTitle = null;
  var SCOPE_LABELS = {
    once: 'Approve once',
    task: 'Approve for this task',
    target: 'Always for this destination',
    '24h': 'For 24 hours',
    always: 'Always',
  };
  var RESULT_WORDS = {
    approved: 'Approved',
    denied: 'Denied',
    expired: 'Expired — not run',
    dismissed: 'Dismissed',
  };
  function own(map, key) {
    return typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function ensurePanel() {
    if (panel) return;
    panel = el('div', 'warden-pending');
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Pending approvals');
    panelTitle = el('div', 'warden-pending-title');
    panelList = el('div', 'warden-pending-list');
    panel.appendChild(panelTitle);
    panel.appendChild(panelList);
    document.body.appendChild(panel);
  }

  function refreshPanel() {
    var count = Object.keys(pending).length;
    if (count === 0) {
      if (panel) panel.hidden = true;
      return;
    }
    ensurePanel();
    panel.hidden = false;
    panelTitle.textContent = count === 1 ? '1 approval waiting' : count + ' approvals waiting';
  }

  function answer(id, action, body, buttons, status) {
    buttons.forEach(function (b) { b.disabled = true; });
    status.textContent = action === 'approve' ? 'Approving…' : 'Sending…';
    fetch('/api/approvals/' + encodeURIComponent(id) + '/' + action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.ok) {
          finish(id, data.verdict || (action === 'approve' ? 'approved' : 'denied'));
          return;
        }
        if (r.status === 404 || r.status === 410) {
          finish(id, 'expired');
          return;
        }
        status.textContent = 'Could not ' + action + ': ' + (data.error || r.status);
        buttons.forEach(function (b) { b.disabled = false; });
      });
    }).catch(function () {
      status.textContent = 'Could not reach Lisa. Try again.';
      buttons.forEach(function (b) { b.disabled = false; });
    });
  }

  // `digest` is the digest of the payload this card displayed, or null when the
  // payload could not be shown — in which case there is nothing to approve.
  function actions(item, digest, compact) {
    var wrap = el('div', 'warden-actions');
    var status = el('span', 'warden-status');
    var buttons = [];
    function add(label, cls, action, body) {
      var b = el('button', 'warden-btn ' + cls, label);
      b.type = 'button';
      b.addEventListener('click', function () { answer(item.id, action, body, buttons, status); });
      buttons.push(b);
      wrap.appendChild(b);
    }
    if (item.kind === 'handoff') {
      add('Dismiss', 'deny', 'deny', {});
    } else {
      var scopes = Array.isArray(item.scopes) ? item.scopes : [];
      if (digest) {
        scopes.forEach(function (scope) {
          var label = own(SCOPE_LABELS, scope);
          if (!label) return;
          if (compact && scope !== 'once') return;
          add(label, scope === 'once' ? 'approve' : 'approve-wide', 'approve', { scope: scope, digest: digest });
        });
      }
      add('Deny', 'deny', 'deny', {});
    }
    wrap.appendChild(status);
    return wrap;
  }

  function renderFields(holder, fields) {
    holder.textContent = '';
    fields.forEach(function (field) {
      var box = el('div', 'warden-field' + (field.primary ? ' primary' : ''));
      box.appendChild(el('div', 'warden-field-key', field.key));
      // The whole value: long ones scroll, nothing is cut.
      box.appendChild(el('pre', 'warden-field-value', field.value));
      holder.appendChild(box);
    });
  }

  function buildCard(item) {
    var card = el('div', 'warden-card' + (item.kind === 'handoff' ? ' handoff' : ''));
    card.setAttribute('data-approval-id', item.id);
    card.appendChild(el('div', 'warden-title',
      item.kind === 'handoff' ? 'This needs you' : 'Lisa is asking to run: ' + item.tool));
    var payload = el('div', 'warden-payload');
    payload.appendChild(el('div', 'warden-preview', item.preview));
    card.appendChild(payload);
    if (Array.isArray(item.targets) && item.targets.length) {
      card.appendChild(el('div', 'warden-meta', 'To: ' + item.targets.join(', ')));
    }
    if (item.purpose) card.appendChild(el('div', 'warden-meta', 'For: ' + item.purpose));
    card.appendChild(el('div', 'warden-meta', item.reason || ''));
    if (item.kind !== 'handoff' && item.expiresAt) {
      var when = new Date(item.expiresAt);
      if (!isNaN(when.getTime())) {
        card.appendChild(el('div', 'warden-meta', 'Expires ' + when.toLocaleTimeString() + ' — unanswered means no.'));
      }
    }
    return { card: card, payload: payload };
  }

  function show(item) {
    if (!item || typeof item.id !== 'string' || own(pending, item.id)) return;
    var built = buildCard(item);
    var card = built.card;
    if (typeof removeChatEmpty === 'function') removeChatEmpty();
    chatLog.appendChild(card);
    chatLog.scrollTop = chatLog.scrollHeight;
    ensurePanel();
    var row = el('div', 'warden-pending-row');
    var label = el('button', 'warden-pending-label', (item.kind === 'handoff' ? 'Needs you: ' : '') + item.preview);
    label.type = 'button';
    label.addEventListener('click', function () { card.scrollIntoView({ block: 'center' }); });
    row.appendChild(label);
    panelList.appendChild(row);
    pending[item.id] = { item: item, card: card, row: row };
    refreshPanel();

    if (item.kind === 'handoff') {
      card.appendChild(actions(item, null, false));
      row.appendChild(actions(item, null, true));
      return;
    }
    // Buttons appear only once the full payload is on screen.
    var loading = el('div', 'warden-meta', 'Loading the full request…');
    card.appendChild(loading);
    fetch('/api/approvals/' + encodeURIComponent(item.id)).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (detail) {
      if (!own(pending, item.id)) return;
      loading.remove();
      var approval = detail && detail.approval;
      if (detail && approval && Array.isArray(detail.fields) && typeof approval.digest === 'string') {
        renderFields(built.payload, detail.fields);
        var shown = { id: item.id, kind: item.kind, scopes: approval.scopes };
        card.appendChild(actions(shown, approval.digest, false));
        row.appendChild(actions(shown, approval.digest, true));
      } else {
        card.appendChild(el('div', 'warden-meta',
          'The full request can only be shown, and approved, on the computer running Lisa or from a signed-in account.'));
        card.appendChild(actions(item, null, false));
      }
    }).catch(function () {
      if (!own(pending, item.id)) return;
      loading.textContent = 'Could not load the full request, so it cannot be approved from here.';
      card.appendChild(actions(item, null, false));
    });
  }

  function finish(id, verdict) {
    var entry = own(pending, id);
    if (!entry) return;
    delete pending[id];
    entry.card.classList.add('resolved');
    Array.prototype.forEach.call(entry.card.querySelectorAll('.warden-actions'), function (node) { node.remove(); });
    entry.card.appendChild(el('div', 'warden-result ' + (own(RESULT_WORDS, verdict) ? verdict : ''), own(RESULT_WORDS, verdict) || 'Closed'));
    if (entry.row) entry.row.remove();
    refreshPanel();
  }

  window.lisaApprovalRequested = function (ev) { show(ev); };
  window.lisaApprovalResolved = function (ev) { if (ev && typeof ev.id === 'string') finish(ev.id, ev.verdict); };

  // Anything already waiting when the page loads (or after a reconnect).
  function loadPending() {
    fetch('/api/approvals').then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
      if (!data || !Array.isArray(data.approvals)) return;
      var live = Object.create(null);
      data.approvals.forEach(function (item) { live[item.id] = true; show(item); });
      Object.keys(pending).forEach(function (id) { if (!live[id]) finish(id, 'expired'); });
    }).catch(function () {});
  }
  loadPending();
  setInterval(loadPending, 30000);
})();

// Phone shell: reuse the real navigation and tools so their state and handlers
// stay identical across rotation. Native dialogs supply focus trapping, Escape
// dismissal, and an inert background without a second navigation implementation.
(function setupMobileShell() {
  const narrow = window.matchMedia('(max-width: 720px)');
  const sidebar = document.querySelector('.sidebar');
  const menu = document.getElementById('mobileMenu');
  const tools = document.getElementById('mobileTools');
  const tabs = document.getElementById('mobileTabs');
  const more = document.getElementById('mobileMore');
  const menuButton = document.getElementById('mobileMenuBtn');
  const toolsButton = document.getElementById('mobileToolsBtn');
  const actions = document.getElementById('mobileActions');
  if (!sidebar || !menu || !tools || !tabs || !more || !menuButton || !toolsButton || !actions) return;
  const sidebarHome = document.createComment('desktop sidebar');
  sidebar.before(sidebarHome);
  const actionHomes = ['fnKbSelect', 'fnMail', 'fnTheme'].map(id => {
    const button = document.getElementById(id);
    const home = document.createComment(id);
    button.before(home);
    return { button, home };
  });

  const primaryViews = ['chat', 'control', 'room'];
  primaryViews.forEach(view => {
    const source = document.querySelector('#navList [data-view="' + view + '"]');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mobile-tab';
    button.dataset.mobileView = view;
    button.appendChild(source.querySelector('svg').cloneNode(true));
    const label = document.createElement('span');
    label.textContent = source.querySelector('.nav-label').textContent;
    button.appendChild(label);
    button.addEventListener('click', () => window.lisaShowView(view));
    tabs.insertBefore(button, more);
  });
  function syncTabs() {
    const view = document.body.dataset.view || 'chat';
    tabs.querySelectorAll('[data-mobile-view]').forEach(button => {
      const selected = button.dataset.mobileView === view;
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    const secondary = !primaryViews.includes(view);
    more.classList.toggle('active', secondary);
    if (secondary) more.setAttribute('aria-current', 'page');
    else more.removeAttribute('aria-current');
  }
  window.addEventListener('lisa-view-change', syncTabs);
  syncTabs();

  function openSheet(dialog, trigger) {
    if (!narrow.matches || dialog.open) return;
    // Give native dialog restoration an explicit non-input target. Touch
    // browsers do not consistently focus a tapped button on their own.
    trigger.focus({ preventScroll: true });
    dialog.showModal();
    if (dialog === menu) {
      menuButton.setAttribute('aria-expanded', 'true');
      more.setAttribute('aria-expanded', 'true');
    } else toolsButton.setAttribute('aria-expanded', 'true');
  }
  menuButton.addEventListener('click', () => openSheet(menu, menuButton));
  more.addEventListener('click', () => openSheet(menu, more));
  toolsButton.addEventListener('click', () => openSheet(tools, toolsButton));
  // Native modal sheets make the rest of the document inert. Hand focus back
  // before the existing global shortcuts open a non-dialog overlay or field.
  // Capture runs before those document-level bubbling handlers.
  document.addEventListener('keydown', event => {
    if (!menu.open && !tools.open) return;
    const mod = event.metaKey || event.ctrlKey;
    const globalShortcut = mod && !event.altKey && ['k', 'f', '/'].includes(event.key.toLowerCase());
    const helpShortcut = event.key === '?' && !mod && !isTypingTarget(event.target);
    if (globalShortcut || helpShortcut) {
      menu.close();
      tools.close();
    }
  }, true);
  [menu, tools].forEach(dialog => {
    dialog.querySelector('[data-close-sheet]').addEventListener('click', () => dialog.close());
    // Check coordinates: empty space inside the sheet must not dismiss it.
    let backdropDown = false;
    function outside(event) {
      const box = dialog.getBoundingClientRect();
      return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
    }
    dialog.addEventListener('pointerdown', event => { backdropDown = event.target === dialog && outside(event); });
    dialog.addEventListener('click', event => {
      if (backdropDown && event.target === dialog && outside(event)) dialog.close();
      backdropDown = false;
    });
    dialog.addEventListener('close', () => {
      if (dialog === menu) {
        menuButton.setAttribute('aria-expanded', 'false');
        more.setAttribute('aria-expanded', 'false');
        const contextMenu = dialog.querySelector('.session-context-menu');
        if (contextMenu) contextMenu.remove();
      } else toolsButton.setAttribute('aria-expanded', 'false');
    });
  });
  // Close before the existing handler runs, including actions which open a
  // separate panel. Returning to Chat never summons the keyboard by itself.
  sidebar.addEventListener('click', event => {
    if (!narrow.matches || !menu.open) return;
    if (event.target.closest('.nav-item, .tleaf, #sbNewSession')) {
      menu.close();
      if (event.target.closest('.tleaf, #sbNewSession')) window.lisaShowView('chat');
    }
  }, true);
  actions.addEventListener('click', event => {
    if (event.target.closest('.fbtn')) tools.close();
  }, true);
  document.getElementById('mobileNewChat').addEventListener('click', () => {
    window.lisaShowView('chat');
    document.getElementById('sbNewSession').click();
  });

  // Mirror the actual identity; no second mood/name state to drift over time.
  const portrait = document.getElementById('mascot');
  const name = document.querySelector('.identity h1');
  function syncIdentity() {
    document.getElementById('mobileAvatar').src = portrait.src;
    document.getElementById('mobileName').textContent = name.textContent;
  }
  new MutationObserver(syncIdentity).observe(portrait, { attributes: true, attributeFilter: ['src'] });
  new MutationObserver(syncIdentity).observe(name, { childList: true, subtree: true, characterData: true });
  syncIdentity();

  function syncLayout() {
    if (narrow.matches) {
      menu.appendChild(sidebar);
      actionHomes.forEach(({ button }) => actions.appendChild(button));
    } else {
      menu.close(); tools.close();
      sidebarHome.after(sidebar);
      actionHomes.forEach(({ button, home }) => home.after(button));
    }
    syncViewport();
  }
  // Safari's visual viewport shrinks for the software keyboard while the
  // layout viewport can stay tall. Keep the composer above it, preserve pinch
  // zoom, and give the conversation the tab bar's space while typing.
  function syncViewport() {
    const viewport = window.visualViewport;
    if (!narrow.matches || (viewport && viewport.scale !== 1)) {
      document.documentElement.style.removeProperty('--mobile-height');
      document.documentElement.style.removeProperty('--mobile-top');
      document.body.classList.remove('mobile-keyboard');
      return;
    }
    const height = viewport ? viewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--mobile-height', height + 'px');
    document.documentElement.style.setProperty('--mobile-top', (viewport ? viewport.offsetTop : 0) + 'px');
    const typing = isTypingTarget(document.activeElement);
    document.body.classList.toggle('mobile-keyboard', typing && window.innerHeight - height > 120);
  }
  narrow.addEventListener('change', syncLayout);
  window.addEventListener('resize', syncViewport);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewport);
    window.visualViewport.addEventListener('scroll', syncViewport);
  }
  document.addEventListener('focusin', syncViewport);
  document.addEventListener('focusout', () => requestAnimationFrame(syncViewport));
  syncLayout();
})();
