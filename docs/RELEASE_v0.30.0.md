# LISA v0.30.0 — Yours to see, keep and undo

You can now see, edit and delete what Lisa remembers, forget a topic everywhere it is stored after previewing exactly what will change, and take your Lisa with you as a portable archive. Every reflective "dream" pass leaves a record you can audit and undo. Unattended tasks can do real work under Warden approvals. Lisa's portraits, stickers and Room now move. The desktop app finds Codex again, manages Skills and lets you rename sessions. It also carries the fix for a security problem in the Mac's remote connections from v0.29.0, which v0.29.1 shipped first: if you are still on v0.29.0, update the Mac app. And it documents two features that already shipped inside v0.29 without notes: read-only connections to GitHub, Google Calendar, Gmail and Linear from the chat, and a phone-sized web app.

## Security fix for remote connections from v0.29.0

These fixes first shipped in v0.29.1 and are included here.

- **Update Lisa on your Mac if it runs v0.29.0.** In v0.29.0, a web page you visited could use DNS rebinding to reach the Mac's remote-connection controls. It could then point the Mac at a relay of its choice and approve its own device, which gives it lasting remote access. The controls now refuse any request that is not the Mac app's own, as the other owner-only parts of Lisa already did. Phones you approved keep working. (#441)
- **More reliable relay.**
  - A large response no longer stalls the relay connection that every paired phone shares.
  - Phones on your local network can no longer use up the connection slots the relay needs.
  - A dismissed pairing request stays dismissed.
  - A phone or Mac clock that is a few minutes off no longer makes every request fail.
  
  No change to the protocol: Mac 0.29.0 and Lisa Pocket 1.3 stay compatible.

## Your memory, under your control

- **Edit what Lisa remembers.** The web memory panel edits, deletes and adds entries in MEMORY.md and USER.md. Nested list items are separate entries, and an edit never silently overwrites a concurrent one. (#421)
- **Forget a topic everywhere.** `lisa forget "<topic>"`, or Forget in the memory panel, first lists every match with the text around it, then applies exactly that preview. It searches:
  - memory and the knowledge base;
  - conversation transcripts and reflections;
  - tasks and their runs;
  - pending connection requests;
  - dream records and their undo copies;
  - Lisa's soul;
  - the search cache.
  
  Open chats reload their history, so the topic does not come back on the next turn. Matching is by whole word. Chinese, Japanese, Korean and other scripts without spaces match the exact characters. Anything Forget does not search is named in the report.
- **Take your Lisa with you.** `lisa export` (or `GET /api/export`) writes a portable archive, and `lisa import <file>` reads it into another home, Cloud ⇄ Mac. The archive is not encrypted. `--replace` backs up what it replaces, and refuses while Lisa is running.

## Dreams you can audit and undo

- **A record of every pass.** Every autonomous reflective pass (idle Reve, session reflection, the weekly examen and the desire review) writes a dream record. The record lists what changed in memory, the knowledge base, skills and Lisa's soul, with diffs. (#423)
- **Undo changes to your data.** `lisa reve revert <id>` (or `POST /api/reve/dreams/{id}/revert`) undoes a pass's changes to *your* data. Memory is undone entry by entry; knowledge-base pages and skills file by file.
  - A change you or another chat made while the pass was running is never undone.
  - Anything changed since the pass is refused unless you force it.
  - A memory revert never pushes a store past its size limit.
- **Ask Lisa to reconsider her soul.** `lisa reve reconsider <id> "<note>"` asks Lisa to reconsider a change to *her* soul on her next pass. A user action never edits her soul directly.
- **Browse and turn off.** `lisa reve dreams | show | metrics` and `/api/reve/*` list and inspect records. `LISA_REVE_DREAMS=0` turns capture off.

## Tasks that ask before acting

- **Approvals for unattended runs.** With Warden on (`--approval warden` or `LISA_APPROVAL=warden`, under `serve --web`), every unattended task, routine or watcher run gets its own Warden session. A side effect it needs asks you through the approval inbox and a reach-out notice. The task waits in `awaiting_approval` with its clock paused. (#422)
- **Confirmed envelopes.** A task envelope you confirmed is signed, and pre-approves exactly what you confirmed.
- **Taint carries over.** Content from a watcher hit or the web taints a run. The taint carries over to later runs through the task's summary and folder. A tainted run asks before running shell commands, sending, publishing, deleting or writing to the network, even under a "for this task" grant.
- **Sealed run state.** What one run leaves for the next is sealed with the home's key. Edited or unsealed state is treated as untrusted. A forget keeps sealed state sealed.
- **Cost cap.** Runs have a cost cap. With Warden off nothing changes: unattended runs stay read-only.

## Lisa moves

- **Animated portraits, stickers and Room.** All 24 core portraits now animate, covering all 114 moods, along with the 8 stickers, 11 Room actions and the gramophone. Both Room themes gain light object effects. (#440)
- **Motion stops when no one is watching.** Animation stops when the page, the Room, the Mac window or the image is out of view. With Reduced Motion on you see stills. A failed animation falls back to the still artwork.
- **Size and Pocket.** The animation pack adds about 8 MB to the download. Lisa Pocket's animated portraits ship with its next build.

## Desktop: Codex, Skills and session names

- **Codex and Claude Code are found again.** Coding Plans detects an installed Codex or Claude Code, including Mac app bundles. Detection, login checks, dispatch and terminals now share one lookup that resolves an absolute path and ignores empty or relative `PATH` entries, so a program placed in a project folder can no longer run instead of the real one. (#442)
- **Skills.** Skills lists your personal and project workflows. It imports Codex or Claude skills, with their supporting files, and can create and refresh them. Imports refuse symlinks, path escapes, duplicates and oversized files. A skill whose description contains `#`, such as "Fix PR #12", is no longer hidden.
- **Session names.** Rename a session from its context menu or with F2. The name is saved and stays in step across windows.
- **Pasted images and errors.** Pasted images show thumbnails and larger previews. The Skills, Tools and Memory panels recover from loading errors with a Retry.

## Already in v0.29: read-only connections from the chat

- **Ask, approve, continue.** When you explicitly ask Lisa to read GitHub, Google Calendar, Gmail or Linear, a connection card appears in the same chat. Sign in, choose which repositories, calendars, labels or teams she may read (nothing is selected by default), and Lisa resumes the original request on her own. You can cancel, retry or disconnect from the card. Reloads and restarts neither lose a pending request nor deliver its result twice. (#436, #437, #438)
- **GitHub.** GitHub uses your GitHub CLI login or a device code. Lisa makes only reviewed read requests, and only to the repositories you picked.
- **Google.** Google uses a desktop OAuth flow with PKCE:
  - Calendar: busy/free times, or event details from the calendars you choose.
  - Gmail: sender, subject, time and a snippet of up to 400 characters, from the labels you choose. One-time codes and sign-in links are filtered out.
  
  For now Google needs your own *desktop* OAuth client, set as `LISA_GOOGLE_CLIENT_FILE` (or `LISA_GOOGLE_CLIENT_ID`) in `~/.lisa/config.env`; see [the connector plan, §8](PLAN_CONNECTOR_EXPANSION_2026-11-07.md).
- **Linear.** Linear connects through its official read-only MCP endpoint and reads only the teams you confirm.
- **Credentials.** Credentials are kept by the credential broker. Existing mail passwords move there after a verified write.

## Already in v0.29: the web chat on phones

- On phone-sized screens the web app has:
  - a compact header;
  - Chat / Control / Room / More tabs;
  - native sheets for navigation, sessions and conversation actions;
  - a single-line composer that grows as you type and stays above the software keyboard.
  
  Desktop controls come back when the window widens. (#439)

## Also in this release

- **Model setup.** Credential checks for a model now follow the environment they are given. A `LISA_BASE_URL` route or `LISA_PROVIDER=gemini` is now checked against the right key. (#430)
- **Perplexity.** Requests to Perplexity carry an `X-Pplx-Integration` header, including those routed through LISA Cloud. Contributed by @qirh. (#425)
- **Lisa Pocket and LISA Cloud.** Lisa Pocket 1.2 is listed on the [US App Store](https://apps.apple.com/us/app/lisa-pocket/id6784690058). `scripts/check-cloud-health.py` checks LISA Cloud's public endpoints without credentials. (#431)
- **Dependencies.** Updated to openai 7.50, @google/genai 2.32, imapflow 2.10, MCP SDK 1.32.2, music-metadata 12 and Astro 7.3.8. Production `npm audit` reports 0 vulnerabilities. (#426, #428, #435)

## Behaviour changes to note

- **New commands.** `lisa forget <topic>`, `lisa export` and `lisa import <file>` are now commands, but only in exactly those forms. Any other line starting with these words is still a one-shot prompt; for example, `lisa forget it, just say hi` still goes to Lisa.
- **Memory size limits.** The limits (4 KB for MEMORY.md, 2 KB for USER.md) now block only growth. Deleting from or forgetting in an over-limit file always works.
- **Older tasks with a summary.** With Warden on, a task from v0.29 or earlier that already has a last summary is treated as tainted, because those versions did not record where the summary came from. Its runs ask before side effects. Tasks without a summary are not affected.
- **Unknown envelope categories.** Unknown categories in a task envelope are now dropped when the task loads; before, they switched the task off. They never pre-approved anything.
- **Program overrides.** Overrides for Codex or Claude Code must now be absolute paths.

## Known limits

- **Pairing code.** The pairing code compared on Mac and phone protects against a mistaken approval, but not against a malicious relay or TLS interceptor that substitutes both keys during first pairing. Closing that needs a new pairing protocol; see [Remote connections](REMOTE_CONNECTIONS.md).
- **Connections.** Connections run in the Mac web app only, with one account per provider and one provider per request. They are not yet available in LISA Cloud, Lisa Pocket or the native Mac shell.
- **Forget and import.** `lisa forget` from the command line cannot reload a running server's chats, so restart Lisa afterwards. The "Lisa is running" check for `import --replace` probes `LISA_WEB_PORT` only.
- **Dreams.**
  - A write counts as made outside a pass only when it happens in the same process; writes from the command line or a heartbeat are not seen.
  - At about 500 kept records, the revert window is roughly a week.
  - Dreams have no web view yet.
- **Phone shell.** The phone shell's keyboard handling has been tested with a simulated keyboard; acceptance on a physical iPhone in Safari is pending. On an iPhone, rename sessions with a keyboard (F2).
- **Lisa Pocket consent.** Lisa Pocket asks for AI-sharing consent before chat sends. Delegating a task from the Roster does not ask yet; that needs a new Pocket build.

## Updating

Download **Lisa-Suite-v0.30.0.dmg** from this release and replace Lisa.app in Applications. Or run `npm i -g @oratis/lisa@0.30.0`, or `brew upgrade lisa`. Your Lisa home, chats, settings and approved phones stay where they are. This release does not upload a new Lisa Pocket build or change LISA Cloud's production flags.
