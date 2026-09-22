# OPAI

Minimal TypeScript CLI for assigned OpenProject tickets and native Claude Code or Codex sessions.

## Setup

Requires Node 22+, Claude Code and/or Codex. Run `npm install && npm run build` in this directory, then link the included launcher into a directory already on your PATH (or use `npm link` where global npm directories are writable). For this WSL setup, `~/.local/bin/opai` is linked to the project launcher. Copy `config.example.json` to `~/.config/opai/config.json`. Set the OpenProject URL, a stable `instanceId`, and the **numeric type IDs from your instance** for Bug and User Story. The type IDs can be read from `/api/v3/types` or a work package's `_links.type.href`. No token belongs in the JSON file.

```sh
mkdir -p ~/.config/opai
cp config.example.json ~/.config/opai/config.json
ln -s "$PWD/opai" ~/.local/bin/opai # once, if ~/.local/bin is already on PATH
opai
```

On first run, OPAI asks for your OpenProject API token with hidden input and saves it to `~/.config/opai/token` with mode `0600`. Future terminals reuse that file automatically. To replace a token, delete the file and run `opai` again. If `OPENPROJECT_API_TOKEN` is set, it takes precedence over the file. OPAI never prints the token.

Optional `cwd` in config sets the repository; otherwise OPAI uses the directory where you run it. Optional `agents.claude` and `agents.codex` select executable paths. `opai show <id>` and `opai resume <id>` are shortcuts.

OpenProject API v3 uses Basic auth with username `apikey` and the token as password. OPAI queries `/api/v3/users/me`, then filters work packages by that numeric assignee ID and open status. It follows collection pagination. Unsupported types are displayed but have no Implement/Fix action. The configured `instanceId` is part of each session key, so keep it stable.

The **Home** menu keeps **My tickets**, **Saved queries**, **My sessions**, and both Refresh actions visible. Its local quest dashboard shows cached ticket totals and status distribution, resumable tickets, Claude/Codex usage, seven-day agent activity, weekly tickets touched, tickets cleared from the assigned board, the open-ticket trend, last refresh, and the most recent session. “Cleared” means that a ticket disappeared between assigned-ticket snapshots; it can indicate completion or reassignment. Daily snapshots are stored in `~/.config/opai/dashboard-history.json`. Opening Home uses the disk cache and session registry and makes no OpenProject request.

Open My tickets to load the list once. Press **Esc** to return from a ticket or list; the cached list is reused. Return to Home and choose **Refresh my tickets** when you want a new API read. Open Saved queries to list the queries visible to your API user. Type to search by name or ID; press **Esc** to go back without scrolling through results. Select a query and **Browse tickets** to read its results. Opening a query marks it as recent, and its menu lets you **Pin** or **Unpin** it. Pinned queries sort first, then recently opened queries. These preferences live in `~/.config/opai/query-preferences.json` and do not change OpenProject queries. **Refresh saved queries** updates query names; each query menu has **Refresh query results** for its own ticket list.

**My sessions** lists tickets with recorded Claude or Codex sessions, sorted by last use. Each entry shows its saved ticket status, agents, conversation count, and time since it was last opened. Fresh ticket lists update matching saved session statuses. **Refresh my tickets** also checks saved tickets absent from the assigned list by ID, so closed tickets can receive their new status. If OpenProject cannot return one of them, OPAI keeps its previous status and reports the ticket ID. Opening My sessions makes no API request. Older records without a ticket snapshot show **Status unavailable** until a refresh finds them. Select a ticket to choose and resume its native session without loading tickets from OpenProject. If a ticket has no Resume action despite an earlier agent conversation, select **Find existing native session** in that ticket's menu. OPAI searches local native sessions whose first user prompt exactly matches the ticket, then lets you choose which one to record. The Resume action appears after recording it.

Lists are cached on disk under `~/.config/opai/cache/`, so reopening OPAI in another terminal reuses a fresh list without an API request. The default time to live is **8 hours**; set `"cacheTtlHours": 8` in `config.json` to change it (up to 168 hours). After expiry, the next time you open that list OPAI fetches it again. Refresh always fetches immediately. My tickets, saved query names, and each query's ticket results have separate cache entries. Cache entries are scoped to the OpenProject instance, type mapping, and API token, and contain no token. Cached files are written with owner-only permissions.

In the ticket picker, type an ID or title to filter, use ↑/↓ to move, and press Enter to open. Press Esc to return to the previous menu, or press Ctrl+C to exit. OPAI uses color when the terminal supports it and respects `NO_COLOR`.

On a normal exit or Ctrl+C at a prompt, the mascot waves goodbye. Saved sessions remain on disk.

The header has a small chibi RPG mascot and a status strip. During an OpenProject request, the mascot and spinner animate on interactive terminals. Afterward, the strip shows the loaded count or an error. Reading a valid disk cache shows a cached status. Non-interactive output stays still and readable.

OPAI uses only `GET` requests to OpenProject. It does not create, edit, delete, or update tickets or queries, and it does not override saved query filters. Agents launched by OPAI run under their own MCP configuration and permission rules; OPAI does not control what those agents can do through MCP.

## Sessions

Claude Code 2.1.278 accepts `--session-id <uuid>` at launch and `--resume <uuid>` later. OPAI assigns a UUID, then records it only if Claude created its native session file. Codex 0.155.1 accepts `resume <uuid>` but has no documented interactive launch option to assign or report a UUID. OPAI inspects newly created Codex session metadata while the agent runs and after exit, and saves an ID only if exactly one new native session matches the first user prompt and working directory. OPAI remains alive when Ctrl+C stops an agent, so it can finish recording. Codex capture and older-session recovery depend on local JSONL metadata; if that format changes or multiple sessions match, OPAI reports that it could not verify the ID and saves nothing. It never selects the newest session by time alone. Sessions are stored atomically in `~/.config/opai/sessions.json`; existing ticket sessions are retained.

The Codex installation checked here has no OpenProject MCP server (`codex mcp list` showed only `chrome-devtools`). Configure OpenProject access in Codex separately before using its ticket prompts. OPAI does not alter global agent settings. Claude Code's OpenProject MCP connection was found in its existing configuration.

Run `npm test` for mocked API, normalization, prompt, session, and launcher checks. Live OpenProject and agent runs need your credentials and interactive terminal and were not part of automated tests.
