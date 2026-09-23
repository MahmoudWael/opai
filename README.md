# OPAI

**Browse tickets, launch a coding agent, and return to the exact conversation later.**

OPAI is a small TypeScript terminal application that connects a ticket provider to Claude Code and OpenAI Codex. It shows your assigned OpenProject work packages and saved queries, launches the selected agent with a focused ticket prompt, and records the agent's native session for reliable resumption.

OpenProject is the provider included in V1. The ticket picker, agent launchers, and session store use a common ticket model so another provider can be added without rewriting the rest of the application.

## Workflow

```text
opai
  -> My tickets
  -> #4521  Fix workflow step execution
  -> Fix with Claude Code
  -> fix openproject bug 4521

Later:

opai
  -> My sessions
  -> #4521  Fix workflow step execution
  -> Resume Claude Code session
```

OPAI starts with these built-in prompt templates:

```text
implement openproject user story <id>
fix openproject bug <id>
```

You can edit either template through **Launch defaults** or for one launch. Ticket details and implementation work remain the coding agent's responsibility.

## Why OPAI?

Coding agents can work from ticket IDs, but the surrounding workflow is still easy to lose:

| Problem | What OPAI does |
| --- | --- |
| Finding the right assigned ticket interrupts terminal work | Presents assigned tickets and saved queries in a searchable picker |
| Recreating ticket context produces long, inconsistent prompts | Starts with a small provider template and previews any edits before launch |
| Agent conversations become detached from their tickets | Associates each ticket with verified native agent session IDs |
| Returning later means searching agent history | Resumes the selected native conversation from **My sessions** |
| Reopening a CLI can repeatedly call the ticket API | Caches ticket lists and queries on disk with explicit refresh actions |
| Scripts may accidentally modify ticket data | Uses only `GET` requests for OpenProject data |

## Features

- Searchable assigned-ticket and saved-query lists
- Bug and User Story actions based on stable type IDs from your OpenProject instance
- Interactive Claude Code and Codex processes with normal permission prompts
- Per-session model, effort, and prompt choices with saved launch defaults
- Local Codex model discovery with model-specific effort choices
- Multiple native sessions per ticket
- Exact-session resume in the original working directory
- Recovery of existing native sessions whose first prompt matches the ticket exactly
- Persistent ticket, query, and session data across terminals, tmux sessions, and WSL restarts
- Eight-hour disk cache by default, plus explicit refresh actions
- Pinned and recently opened saved queries stored locally
- Local dashboard for ticket status, agent use, recent activity, and resumable work
- Read-only OpenProject integration

## Requirements

- Node.js 22 or newer
- npm
- An OpenProject account with API access
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), [OpenAI Codex](https://github.com/openai/codex), or both
- Agent-side access to OpenProject for whichever agent you select

OPAI is currently developed and tested on Ubuntu under WSL2. It launches agents as normal interactive child processes and does not change their permissions or global configuration.

## Install

Install OPAI globally from npm:

```sh
npm install --global @mahmoudwael/opai
```

Then run:

```sh
opai
```

To install from source instead:

```sh
git clone https://github.com/MahmoudWael/opai.git
cd opai
npm ci
npm run build
npm link
```

Confirm that the command is available:

```sh
opai
```

If global npm links are not writable, link the included launcher into a user-owned directory:

```sh
mkdir -p ~/.local/bin
ln -sf "$PWD/opai" ~/.local/bin/opai
```

Ensure `~/.local/bin` is on your `PATH`. For example, add this to `~/.zshrc` or `~/.bashrc`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Then open a new terminal or reload the shell configuration.

## Configure OpenProject

### 1. Create an API token

In OpenProject, open **Account settings -> Access tokens**, select **+ API Token**, and copy the generated token. OpenProject displays a newly created token only once. See the official [OpenProject access-token guide](https://www.openproject.org/docs/user-guide/account-settings/access-tokens/).

### 2. Create the OPAI configuration

```sh
mkdir -p ~/.config/opai
cp config.example.json ~/.config/opai/config.json
```

Edit `~/.config/opai/config.json`:

```json
{
  "openproject": {
    "url": "https://openproject.example.com",
    "instanceId": "work",
    "bugTypeId": 7,
    "userStoryTypeId": 6,
    "promptTemplates": {
      "bug": "fix openproject bug {{id}}",
      "userStory": "implement openproject user story {{id}}"
    }
  },
  "cacheTtlHours": 8,
  "cwd": "/home/you/projects/your-repository",
  "agents": {
    "claude": "claude",
    "codex": "codex"
  },
  "models": {
    "claude": ["custom-claude-model-id"],
    "codex": ["configured-codex-model-id"]
  }
}
```

Replace the sample values with values from your OpenProject instance:

| Setting | Required | Meaning |
| --- | --- | --- |
| `openproject.url` | Yes | Base URL without `/api/v3` |
| `openproject.instanceId` | Yes | Stable local name that distinguishes this OpenProject instance in session keys |
| `openproject.bugTypeId` | Yes | Numeric type ID used by this instance for Bugs |
| `openproject.userStoryTypeId` | Yes | Numeric type ID used by this instance for User Stories |
| `openproject.promptTemplates.bug` | No | Default Bug prompt template; must contain `{{id}}` |
| `openproject.promptTemplates.userStory` | No | Default User Story prompt template; must contain `{{id}}` |
| `cacheTtlHours` | No | Cache lifetime greater than `0` and at most `168` hours; defaults to `8` |
| `cwd` | No | Working directory passed to agents; defaults to the directory where `opai` was started |
| `agents.claude` | No | Claude executable name or absolute path |
| `agents.codex` | No | Codex executable name or absolute path |
| `models.claude` | No | Additional Claude model IDs shown alongside Default, Sonnet, Opus, and Haiku |
| `models.codex` | No | Codex model IDs available in the model preference picker |

OpenProject type IDs vary by instance. Read them from `/api/v3/types` or from a work package's `_links.type.href`. OPAI still displays unsupported ticket types, but it offers no Implement or Fix action until their type is mapped.

Keep `instanceId` stable after sessions have been recorded. It forms part of the provider-qualified ticket key, such as `openproject@work:4521`.

### 3. Save the token

Run `opai`. On the first run, OPAI asks for the token with hidden input and writes it to:

```text
~/.config/opai/token
```

The file is created with owner-only permissions (`0600`) and is reused by future terminals. The token is never written to `config.json`, cache files, or logs.

To replace it, delete `~/.config/opai/token` and run OPAI again. `OPENPROJECT_API_TOKEN` can also provide a temporary environment override.

## Usage

Start the interactive home screen:

```sh
opai
```

Available shortcuts:

```sh
opai mine             # Open assigned tickets
opai show 4521        # Open one ticket
opai resume 4521      # Choose a saved session for one ticket
```

### Navigation

| Key | Action |
| --- | --- |
| `Up` / `Down` | Move through a list |
| Type | Filter tickets, queries, or sessions |
| `Enter` | Open the selected item |
| `Esc` | Return to the previous screen |
| `Ctrl+C` | Exit OPAI |

### Home views

- **My tickets** reads assigned, open OpenProject work packages.
- **Saved queries** reads the queries visible to your OpenProject account. Pinning and recent-query ordering are local preferences and never alter the remote query.
- **My sessions** opens recorded conversations without fetching tickets again.
- **Refresh my tickets** bypasses the cache and updates matching statuses in saved sessions.
- **Refresh saved queries** reloads query names. Each query also has its own result refresh action.

### Launch options and defaults

Selecting **Fix/Implement with Claude Code** or **Fix/Implement with Codex** opens a compact launch screen:

```text
Model    Sonnet
Effort   Medium
Prompt   fix openproject bug {{id}}

Start session
Change model
Change effort
Edit prompt
Save current options as defaults
```

The screen previews the exact resolved prompt before launch. `{{id}}` is replaced with the selected ticket ID, and every prompt template must contain that placeholder. Prompt edits apply only to the current launch unless **Save current options as defaults** is selected.

Use **Launch defaults** on the home screen to set model and effort independently for Claude Code and Codex, and to edit the default Bug and User Story prompt templates. Saved prompt defaults belong to the OpenProject instance and apply to both agents.

The effective prompt template is chosen in this order:

1. The current launch-screen edit.
2. A default saved through OPAI.
3. `openproject.promptTemplates` in `config.json`.
4. OPAI's built-in OpenProject prompt.

Codex models, display names, and model-specific effort choices are read locally from the installed CLI's bundled catalog. Only models marked visible by Codex are shown. Configured IDs from `models.codex` are appended for custom setups or used when discovery is unavailable.

Claude Code has no supported model-catalog command. OPAI reads aliases and effort support from the installed CLI help, always includes Sonnet, Opus, and Haiku, and appends IDs from `models.claude`.

**Default** omits the corresponding model or effort override and lets the agent use its existing configuration. If an agent rejects a selected value, OPAI reports the native error without switching values silently.

The requested model, effort, and resolved initial prompt are saved as historical launch metadata. Resume passes none of these overrides and lets the native session restore its own state.

## Native session tracking

OPAI does not create a separate chat-history format. It records identifiers for the agents' own native conversations in `~/.config/opai/sessions.json`.

New session records include the requested launch model, effort, and resolved initial prompt. `null` represents Default. Older records without these fields remain usable and are treated as Default. These values describe only how OPAI launched the session; a user may change settings inside the agent afterward.

### Claude Code

OPAI assigns a UUID with Claude's native `--session-id` option, launches the exact ticket prompt, and saves the association only after Claude creates the corresponding native session. Resume uses Claude's native `--resume` option.

### Codex

Codex does not currently expose an equivalent interactive launch option for assigning a session ID. OPAI compares native Codex session metadata before and after launch and records a session only when exactly one new session matches both:

- the original working directory; and
- the exact initial ticket prompt.

Resume uses Codex's native `resume` command. This capture depends on Codex's local JSONL metadata format and may need updating if that format changes.

### Safety guarantees

- OPAI never invents a session ID.
- It never associates a ticket based only on the newest session timestamp.
- Multiple sessions for the same ticket are retained.
- Resume uses the session's original working directory.
- A missing native session or working directory produces an error instead of starting a new conversation.
- If automatic capture fails, **Find existing native session** searches for conversations whose first prompt exactly matches the ticket's current effective prompt template.

## Cache and local data

OPAI stores local state below `~/.config/opai/`:

| Path | Purpose |
| --- | --- |
| `config.json` | OpenProject and agent settings |
| `token` | API token with owner-only permissions |
| `sessions.json` | Ticket-to-native-session associations |
| `cache/` | Assigned tickets, saved queries, and query results |
| `query-preferences.json` | Pinned and recently opened queries |
| `launch-preferences.json` | Per-agent model and effort defaults plus provider prompt defaults |
| `dashboard-history.json` | Daily local snapshots used by dashboard statistics |

Opening OPAI does not automatically call OpenProject while a valid cached list exists. The default cache lifetime is eight hours, so reopening it in another terminal reuses the same list. After expiry, the next access reloads that list. Refresh actions always fetch immediately.

Cache namespaces include the provider identity, URL, type mapping, and a one-way hash derived from the token. Cache files do not contain the token.

## Read-only OpenProject access

OPAI sends only `GET` requests to OpenProject API v3. It reads:

- the authenticated user;
- assigned open work packages;
- individual work packages;
- saved-query definitions; and
- saved-query results.

It does not create, edit, delete, or change tickets or saved queries.

Launched agents run with their own configuration and permission rules. If Claude Code or Codex has write access through MCP, those capabilities belong to the agent and remain outside OPAI's read-only API integration. OPAI does not install or modify MCP servers.

## Architecture

```text
TicketProvider
  -> OpenProjectProvider
  -> normalized Ticket
       -> interactive picker
       -> Claude/Codex adapter
       -> native session registry
```

The `TicketProvider` contract handles listing and retrieving tickets, normalization, and construction of Implement or Fix prompts. UI, agent execution, caching, and session storage do not depend on OpenProject response shapes.

V1 intentionally includes one static provider implementation. It has no plugin loader, background service, database, tmux management, ticket modification, branch management, or pull-request automation.

## Known limitations

- OpenProject is the only ticket provider included in V1.
- Bug and User Story type IDs must be configured for each OpenProject instance.
- Claude Code and Codex must already be installed and authenticated.
- Each agent needs its own OpenProject integration. A working Claude MCP setup does not imply that Codex has the same MCP server.
- Native session files must remain present for resume to work.
- Codex capture relies on locally stored native metadata because its interactive launcher does not provide an explicit session-ID option.
- After a failed automatic capture, recovery matches the current effective prompt; a one-session prompt edit must be saved as the ticket-type default before recovery can match it.
- Codex discovery depends on `codex debug models --bundled`; older CLIs fall back to configured IDs.
- Claude Code does not expose a supported complete model catalog, so exact version IDs must be configured when aliases are insufficient.

## Troubleshooting

### `Create ~/.config/opai/config.json from config.example.json`

Create the configuration file and replace every sample OpenProject value with the values from your instance.

### `OpenProject API returned HTTP 401`

Delete `~/.config/opai/token`, run `opai`, and enter a valid API token. Also confirm that API access is enabled by your OpenProject administrator.

### `Could not connect to OpenProject`

Check `openproject.url`, DNS, VPN access, and TLS. The URL should look like `https://openproject.example.com` without `/api/v3` appended.

### A ticket has no Implement or Fix action

Check the work package's numeric type ID and update `bugTypeId` or `userStoryTypeId`. The visible type name alone is not used for action mapping.

### No session was recorded

OPAI saves a session only after verifying a native ID. Reopen the ticket and select **Find existing native session**. If nothing is found, confirm that the agent created a native session with the exact initial prompt and that its local session files are still available.

### Codex cannot retrieve the ticket

Configure OpenProject access for Codex separately. OPAI deliberately does not change global agent or MCP configuration.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Tests mock OpenProject responses and child-process behavior. They do not require live OpenProject credentials and do not launch real coding agents.

## Support and contributions

Use [GitHub Issues](https://github.com/MahmoudWael/opai/issues) for bug reports, setup problems, and focused feature proposals. When reporting a session-capture problem, include the agent name and version, operating environment, and the OPAI error message. Never include API tokens or private ticket contents.

## License

[MIT](LICENSE) © 2026 Mahmoud Wael
