# How we change GS Agentic Manager

This is the brief for every agent (and human) that changes the platform. The
agents run on this platform, so a careless change can break the app they live
in. The rule behind everything below: **build in isolation, John releases.**

## The places

| Place | Path | What it is | Who may change it |
|---|---|---|---|
| Live app | `~/GSAM/live` (code) and `~/GSAM/data` (data), served at http://localhost:3100 | The copy John and the agents use every day. Always a tagged release. | Nobody edits it. John updates it with `scripts/greatstone-release.sh`. |
| Preview | `~/GSAM/preview` (its own code clone and a copy of the data), served at http://localhost:3200 | A release candidate on a copy of the live data, agents off. Thrown away after each check. | Flint (or Keystone) starts and stops it with `scripts/greatstone-preview.sh`. |
| Dev checkout | `~/Desktop/Code/gs-clip` | The repository your worktrees come from. | Nobody works in it directly. It is the root for worktrees. |
| Your worktree | `~/Desktop/Code/gs-clip/.gsam/worktrees/<branch>` | One folder and one branch per task, created for you when you start the task. | You, for that task only. |

The repository is private: `Johnprempeh2/gs-agentic-manager` (remote
`origin`, default branch `main`). The public fork `Johnprempeh2/GS-Clip`
(remote `public-fork`) only tracks the upstream open-source project. Never push
to it.

## How a change travels

1. **Task.** A GRE issue in the "GS Agentic Manager platform" project. Its
   branch is named after the issue, for example `GRE-12-faster-board`.
2. **Build in your worktree.** Work only inside your worktree. Keep the change
   to what the issue asks for.
3. **Test in a sandbox.** Run the tests for what you touched from the worktree
   root (`npx vitest run <files>`, `npx tsc --noEmit -p <package>`). When you
   need the running app, start a sandbox from the worktree:
   `pnpm dev:once --data-dir ./tmp/sandbox`. It picks the next free port (never
   3100) and has its own empty data. Stop it when you are done.
4. **Commit.** Small commits with plain-English messages that say what changed
   and why. Stage files by name; never `git add -A` or `git add .`.
5. **Pull request.** `git push -u origin <branch>`, then
   `gh pr create --base main`. The description says: what changed, why, the
   exact tests you ran and their results, and anything John should check by
   hand. Link the GRE issue. Put the pull request link on the issue, add
   Keystone as the reviewer (`executionPolicy` with one `review` stage whose
   participant is agent Keystone), and set the issue to `in_review`.
6. **Checks and review.** Fork CI runs the fast lanes on every pull request. If
   they fail, fix on the same branch and push again. Keystone reviews and
   merges (see "The merge rule"); nobody merges their own pull request.
7. **Release.** Merged changes go live only through the release flow below.

## The merge rule

- **Every pull request goes to Keystone.** The owner adds Keystone as the
  `review` stage participant and sets the issue to `in_review`.
- **Routine changes: Keystone merges.** After the ready check says "Ready to
  merge" and CI is green, Keystone merges and sets the issue to `done`. John
  does not merge routine pull requests.
- **Big changes: John agrees first.** A change is big if it adds or changes a
  database migration; touches login, permissions, secrets, tokens, or GitHub or
  Claude access; changes the release or preview scripts, CI, or the push guard;
  removes or renames something John uses every day; or changes more than about
  1,000 lines outside tests. If unsure, it is big. Keystone does the ready
  check, then posts a confirmation card for John on the issue (what changes,
  why it is big, what could break, how to roll back). Keystone merges only
  after John accepts; if he rejects, the issue goes back to its owner.
- **Keystone's own pull requests go to Flint.** Keystone never merges its own
  work. It sets Flint (release verifier) as the `review` stage participant.
  Flint does the ready check and merges; for a big change, Flint posts the card
  for John and merges after he accepts.

## Never

- Edit, run git in, install into, or restart anything under `~/GSAM/`.
- Restart or stop the server on port 3100, or run a server with `~/GSAM/data`.
- Push to `main`, force-push, merge your own pull request, or delete branches
  or tags.
- Push to `public-fork` or open pull requests on `Johnprempeh2/GS-Clip`.
- Run `git clean -x`, `git reset --hard`, `git stash` or `git checkout` of
  another branch in the dev checkout. Your worktree is your only workspace.
- Commit secrets, tokens, `.env` files, client names or personal data.
- Widen a task on your own. Propose follow-up work as a new issue instead.

A `pre-push` hook in the dev checkout (shared by every worktree) checks pushes
only. On this machine it refuses a push to `main`, a tag push that does not come
from the release script, a push that deletes a branch or tag, and any push to
`public-fork`. It does not stop edits, installs or git commands under `~/GSAM/`,
server restarts, force-pushes to other branches, merges, or pull requests on
`Johnprempeh2/GS-Clip`. You must keep those rules yourself.
GitHub Free cannot protect a private repo's `main` on the server; with GitHub
Pro, add a branch rule that requires a pull request and the "Fork CI" check.

## When something is unclear or blocked

Say so on the issue in one or two sentences, set it to `blocked`, and name who
must act. Do not work around a missing permission.

## Releasing: try first, then agree

Merging does not change the live app. A version goes live in these steps.

1. **Ready check (Keystone).** For each open pull request: Fork CI is green,
   the tests the pull request names pass again, the issue's "Done when" list is
   met, and the diff does not touch `~/GSAM/`, secrets or client data. Keystone
   posts "Ready to merge" or "Not ready, because ..." on the issue.
2. **Merge (Keystone).** `gh pr merge` when the verdict is "Ready to merge" and
   CI is green; big changes only after John accepts the card. Keystone never
   merges its own pull requests; Flint checks and merges those.
3. **Candidate (Keystone).** Tag the merged `main` as a candidate and write the
   release note (each change, its issue, what to check) on a release issue:

   ```sh
   git fetch origin && git tag -a rc-YYYY-MM-DD.N origin/main -m "Release candidate rc-YYYY-MM-DD.N"
   ```

   The tag stays local until the release; the release script pushes it.
4. **Preview (Flint).** Keystone hands the release issue to Flint with the
   `rc-*` tag and the release note. Flint starts the candidate on a copy of the
   live data, checks it, stops it, and hands the issue back with a verdict.
   Keystone reads the evidence before asking John; if Flint is busy or stuck,
   Keystone may run the check itself.

   ```sh
   scripts/greatstone-preview.sh start rc-YYYY-MM-DD.N   # http://localhost:3200
   scripts/greatstone-preview.sh status                  # tag, commit, agent runs since start
   ```

   Go through each "what to check" line and record pass or fail with evidence on
   the release issue. `status` must show 0 agent runs.
5. **Agree (John).** John tries the preview too, then says "release" or
   "not yet" on the release issue. "Not yet" leaves live as it is; the fixes
   become new issues and a new candidate.
6. **Release (John).** From the dev checkout, when no agent is running:

   ```sh
   scripts/greatstone-release.sh rc-YYYY-MM-DD.N
   ```

   The script checks that the tag is on `origin/main` and is the commit the
   preview runs, refuses while an agent run is active, backs up the live
   database to `~/GSAM/backups/release-<time>-<tag>/`, tags the same commit as
   `live-YYYY-MM-DD.N`, moves `~/GSAM/live` to it, restarts the live server,
   waits for the new server to report the tag's commit, and stops the preview.
   It prints the rollback command and the backup file.
7. **Check live (Flint, then Keystone).** Flint runs
   `curl -s http://localhost:3100/api/health`: the `commit` is the tag's
   commit. Flint spot-checks the changes in live and reports on the release
   issue. Keystone closes it, or gives John the rollback command if live is
   broken.

### Rollback (John)

```sh
scripts/greatstone-release.sh live-YYYY-MM-DD.N   # the previous live tag, printed by the release
```

This moves live back to that tag the same way (backup first, then restart). It
does not undo database migrations. If the older code cannot run on the newer
database, restore the backup the release printed; ask Keystone for the steps.

Run the release from your own terminal, not from an agent run. Both scripts
run `pnpm install` without questions. If the pnpm store is not the one live was
installed with (agent runs each get their own store), pnpm deletes and
reinstalls `node_modules` under the running live server. Your terminal always
uses the same store, so this does not happen there.

### What the preview does and does not do

- **Code:** its own clone in `~/GSAM/preview/code`, fetched from the local
  repository, checked out at the tag, installed and started with the same
  command as live (`pnpm dev:once`, which builds what it needs).
- **Data:** a fresh copy on every `start`. Files are copied from `~/GSAM/data`
  without the database, the `secrets/` folder, locks and backups. The database
  is copied with a read-only backup of the running live database, so live does
  not need to be quiet or stopped; the copy is one consistent snapshot. Paths
  into `~/GSAM/data` inside the copy (for example agent instruction files) are
  pointed at the preview's own folder. Nothing is written under `~/GSAM/data`,
  and the preview never talks to port 3100. If the live database is not
  running, `start` refuses instead of starting it.
- **Agents off:** `HEARTBEAT_SCHEDULER_ENABLED=false` turns off timer
  heartbeats and routines; `GSAM_RESTORE_IN_PROGRESS=true` makes every agent
  wake (assignment, comment, "run now") a skipped wake, so no agent run can
  start.
- **No outside effects:** the live secrets key is not copied, so stored
  credentials (GitHub, chat, email, tool connections) cannot be used. In the
  copy, workspace dev servers are set to stopped, pending tool actions are
  cancelled, tool connections, chat endpoints and plugins are turned off, and
  telemetry and database backups are off.
- **Take care:** execution workspaces in the copy still point at the real task
  worktrees under the dev checkout. Do not archive or clean up workspaces in
  the preview.
- `stop` stops only the preview process group and its database. The code and
  data folders stay until the next `start` replaces them.

### Sandbox test of the scripts

Every path can be moved, so the scripts can be tried without the real
`~/GSAM/`: set `GSAM_ROOT` (fake GSAM home with `live/`, `data/`, `backups/`,
`preview/`), `GSAM_LIVE_URL` (a fake live server), and `GSAM_RELEASE_REPO` (a
clone whose `origin` is a local bare repository, so no tag reaches GitHub).
