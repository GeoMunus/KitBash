# Kitbash

Kitbash memorizes code into small reusable **parts**, lets you recall them by search, and builds bigger things out of them. This version adds a **Team** tab and a workspace server, so Claude, ChatGPT, an embedded OpenAI agent and you can share files (with revisions), tasks, messages and approvals.

One Node server does everything. Deploy it on Railway and open its address in your phone's browser:

| Address | What it is |
|---|---|
| `/` | The Kitbash app: Import, Parts, Build, Team |
| `/mcp` | The MCP endpoint that Claude / ChatGPT connect to (OAuth 2.1) |
| `/health` | Status: owner key set? database persistent? |

## Status: what has and has not been verified

| | |
|---|---|
| Server, OAuth, MCP tools, SQLite storage, Team tab | Built and tested **locally** on Node 22: 71 backend checks and 4 after-restart checks, plus 36 + 31 checks in a real browser (Kitbash as a Claude artifact, and Kitbash opened from this server). All pass. |
| Clean install from only the root files (`npm ci` then `npm start`) | Run and works, including the no-volume warning. |
| **Deployed on Railway** | **Not done from here.** I have no Railway access, and could not run Railpack itself. The repository is laid out so Railpack finds `package.json` at the root and runs `npm start`, but the first real build is yours to watch. |
| **ChatGPT connector working** | **Not verified.** It needs an external test from your ChatGPT account, and whether your plan allows a custom (and write-capable) connector is unconfirmed. Checklist below. |
| Claude connector | Not verified through claude.ai either. |
| Embedded OpenAI agent | Tested against a mock server only; no real OpenAI call has been made. |
| NTree / NTN files | Stored as opaque, tagged, byte-exact resources with revisions. There are no format-aware adapters yet; those need real example files. |

## Repository layout

Everything Railway needs is in the **root folder, with no subfolders**. That is deliberate: you can upload the root files from a phone's browser. `app/` and `test/` are extras.

```
package.json  package-lock.json  railway.json     build + start config (npm start)
server.js     db.js  oauth.js  schema.js           web server, SQLite storage, OAuth, database schema
service.js    mcp.js  openai_agent.js              the workspace rules and the tools agents call
kitbash.html                                       the built Kitbash app (single file)
env.example                                        the variables to set
app/    Kitbash source (src/*.js, style.css) and build.sh that rebuilds kitbash.html
test/   e2e.mjs, ui_connector.py, ui_standalone.py, run-local.sh, run-ui.sh
```

## Deploy on Railway

1. **Get the files into your GitHub repository** (see "Uploading from Android"). The repo root must contain `package.json`. Railway's build log says "could not determine how to build" when it only sees a zip and a README.
2. In Railway: **New Project → Deploy from GitHub repo →** pick the repository. Railpack detects Node and runs `npm start`.
3. **Variables** (service → Variables): add `OWNER_SECRET` = a long random passphrase (12+ characters). This is your owner key. Optional: `OPENAI_API_KEY` and `OPENAI_MODEL` for the embedded OpenAI agent. If the build complains about the Node version, add `RAILPACK_NODE_VERSION` = `22` (the server needs Node 22.13 or newer).
4. **Attach a Volume** (needed to keep your data): on the project canvas, open the service and attach a volume with mount path `/data`. Railway then sets `RAILWAY_VOLUME_MOUNT_PATH` and the server puts its database at `/data/kitbash.db`. Without a volume the server still runs but warns loudly (in the logs and in `/health`), and **everything is erased on each deploy**.
5. **Networking → Generate Domain.** Redeploy once if the domain was added after the first deploy.
6. Open `https://<your-domain>/health`. You want `owner_secret_configured: true` and `database.persistent: true`, with an empty `warnings` list.
7. Open `https://<your-domain>/`, go to **Team**, type your owner key.

Run **one** instance only. The database is a single SQLite file on the volume.

## Connect the agents

Both use the address `https://<your-domain>/mcp`.

- **Claude:** claude.ai → Settings → Connectors → add a custom connector named exactly **Kitbash Workspace**. On the approval page choose *Claude*, keep read + write ticked, enter your owner key. (The published Kitbash artifact looks for that exact connector name.)
- **ChatGPT:** add the same URL as a custom connector in ChatGPT's settings, if your plan offers it. On the approval page choose *ChatGPT*. If ChatGPT only allows read access, untick write.
- **Embedded OpenAI agent:** no connector. Set `OPENAI_API_KEY` and `OPENAI_MODEL`, then in Team → Tasks assign a task to the OpenAI agent and press *Run OpenAI agent* (or send it a chat message). It is **not** the ChatGPT app and has no memory of your ChatGPT conversations: it only sees this workspace, so put what it should know in `project/BRIEF.md`.

The Team tab works in two modes: served from this server (`/`), it talks to the server directly with your owner key; inside the Claude artifact it goes through the connector. Opened from the server, the chat can leave Claude a message but cannot wake Claude; Claude answers when it next connects.

## What an agent can and cannot do

The approval page decides which agent a connection is, and that identity is stored on the server with the token. Nothing an agent sends can change it, so agents cannot impersonate each other.

| Action | Read-only connection | Read + write connection | Owner key |
|---|---|---|---|
| Read files, history, tasks, messages, approvals, audit log; search/fetch | yes | yes | no |
| Post messages, create/update/hand off tasks | no | yes | no |
| Create a file | no | yes (it becomes the owner) | no |
| Edit an existing file | no | only its own files, or files it holds a lease on | no |
| Change someone else's file | no | propose only | approving needs it |
| Delete a file, restore a checkpoint | no | request only | approving needs it |
| Approve/reject, change a file's owner, register or disable agents, run the OpenAI agent | no | no | every call |

The server enforces: every write names the revision it started from (`base_rev`), and a stale one is rejected as a conflict, so agents cannot silently overwrite each other; deletes keep all history; approvals go stale if the file changed; disabling an agent blocks its tokens at once.

Limits of the single owner key: it is one passphrase for everything; ten wrong attempts in ten minutes lock owner actions out for ten minutes (which also means someone else can lock you out briefly by guessing); and workspace messages are visible to every agent.

## Files and NTree / NTN

Each file has a path, format tag (for example `ntree/manifest`, `ntn/config`), encoding (`utf8` or base64), free-form metadata, SHA-256 and size of the original bytes, an owner, and full revision history. Team → Files imports files exactly as they are (byte order marks and line endings kept; binary stored as base64) under `imports/`. Nothing parses or rewrites NTree or NTN formats. Adapters can hook in through the format tag and metadata once real examples exist.

## Uploading from Android

GitHub's website cannot unzip a file, and it cannot upload folders from a phone browser. Two ways around that:

**A. Only the root files (no folders needed).** Unzip `kitbash-railway.zip` with the Files app (long-press → Extract). Then in your repository on github.com: **Add file → Upload files**, select the 12 files that sit in the root of the extracted folder (`package.json`, `package-lock.json`, `railway.json`, `server.js`, `db.js`, `oauth.js`, `schema.js`, `service.js`, `mcp.js`, `openai_agent.js`, `kitbash.html`, `env.example`), commit. Delete `kitbash-workspace.zip` from the repo. `README.md` can be replaced the same way. That is a complete deployable app.

**B. Everything, with Termux.** In Termux: `pkg install git unzip`, `termux-setup-storage`, then `unzip ~/storage/downloads/kitbash-railway.zip -d kb && cd kb`, `git init -b main`, `git add . && git commit -m "Kitbash for Railway"`, `git remote add origin https://github.com/<you>/<repo>.git`, `git push -f origin main` (sign in with a GitHub personal access token as the password; `-f` replaces what is there).

## Local use and tests

```
npm install
OWNER_SECRET=choose-a-long-passphrase npm start       # http://localhost:8787
./test/run-local.sh                                    # backend suite, restart, persistence check
./test/run-ui.sh                                       # browser suites (needs python3 + playwright)
bash app/build.sh                                      # rebuild kitbash.html after editing app/src
```

## Checklist before you call the ChatGPT connector working

1. `/health` shows `owner_secret_configured: true`, `persistent: true`.
2. `BASE=https://<your-domain> OWNER_KEY=<your key> node test/e2e.mjs` passes against the live server (run it on a fresh database; it also expects a mock OpenAI on port 8899, so skip the embedded-agent section if you don't run one).
3. Kitbash → Team shows "Connected as You (owner)".
4. Add the connector in ChatGPT and note exactly what its settings allow (read-only, read/write, or nothing on your plan).
5. In ChatGPT ask it to call `whoami` (identity should be `chatgpt`), then `list_files`, then post a message; confirm it appears in Team as coming from ChatGPT.
6. If write is allowed: have ChatGPT create a file, then write it again with an old revision and confirm the conflict.

Only after steps 4 to 6 succeed is the ChatGPT connector verified.

## Not done yet

Parallel collaboration (only sequential handoffs), live updates in the Team tab (it refreshes on actions and on Refresh), viewing full file history and restoring checkpoints from the UI (the tools exist), database backups (use Railway's volume backups), and format-aware NTree/NTN adapters. An earlier Cloudflare Workers variant of the same server exists in the previous zip; it is not part of this repository and no longer shares its code.
