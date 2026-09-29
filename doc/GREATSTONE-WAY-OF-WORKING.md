# How we change GS Agentic Manager

This is the brief for every agent (and human) that changes the platform. The
agents run on this platform, so a careless change can break the app they live
in. The rule behind everything below: **build in isolation, John releases.**

## The places

| Place | Path | What it is | Who may change it |
|---|---|---|---|
| Live app | `~/GSAM/live` (code) and `~/GSAM/data` (data), served at http://localhost:3100 | The copy John and the agents use every day. Always a tagged release. | Nobody edits it. John updates it from the **Releases** page in the app. |
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
- **Big changes: John decides once, at release.** A change is big if it adds
  or changes a database migration; touches login, permissions, secrets, tokens,
  or GitHub or Claude access; changes the release or preview scripts, CI, or
  the push guard; removes or renames something John uses every day; or changes
  more than about 1,000 lines outside tests. If unsure, it is big. Keystone
  merges a big change after the ready check and Flint's checks pass; there is
  no card per merge. Keystone lists each big change at the top of the next
  release card (what changes, why it is big, what could break, how to roll
  back). If John says "not yet", the change stays out of live until it is
  fixed or reverted.
- **Keystone's own pull requests go to Flint.** Keystone never merges its own
  work. It sets Flint (release verifier) as the `review` stage participant.
  Flint does the ready check and merges; a big change is listed on the release
  card in the same way.
- **When GitHub cannot run CI: `local-ci` (GRE-201).** "CI is green" means
  Fork CI is green, or, only when GitHub could not start Fork CI on the pull
  request's head, the commit status `local-ci` is green on that same head.
  Check first with `node scripts/greatstone-local-ci.mjs detect <pr>`: exit 0
  means GitHub did not start the jobs (the billing-stop message) or no job
  started within 15 minutes. Then run
  `node scripts/greatstone-local-ci.mjs run <pr>`: it runs guard, typecheck and
  build on the Mac in `.gsam/local-ci/work`, one pull request at a time, waits
  while the RAM guard says the host is busy, and posts `local-ci` and a comment
  on the pull request. It refuses to run when Fork CI ran, so a real Fork CI
  failure is never overridden: the owner fixes it. A new push needs a new check.
  `local-ci` is only for pull requests from branches on
  `Johnprempeh2/gs-agentic-manager` (agent pull requests). The repo is public,
  and the check installs and builds the pull request's code on the Mac that
  runs the live app, so `run` refuses a pull request from a fork (also with
  `--dry-run`). A fork pull request waits for GitHub CI.
  Note on the issue that the merge used `local-ci`. Runner and vitest lanes are
  not part of it; they are not part of Fork CI on pull requests either.

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
A `pre-commit` hook, installed automatically when an agent worktree is created
(`scripts/git-hooks/install.sh`), refuses a commit when the branch or worktree
is not the run's `GSAM_WORKSPACE_BRANCH` / `GSAM_WORKSPACE_WORKTREE_PATH`; it
does nothing at a terminal where those are not set.
`main` has no branch protection or ruleset on GitHub (checked 29 Sep 2026), so
a merge on `local-ci` is not blocked there. If a branch rule is added later
that requires the "Fork CI" check, it must also accept `local-ci` (or let
Keystone bypass it), or the fallback cannot merge.

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
   CI is green (Fork CI, or `local-ci` when GitHub could not start it; see
   "The merge rule"); for a big change, also after Flint's checks pass. Keystone never
   merges its own pull requests; Flint checks and merges those.
3. **Candidate (Keystone, once a day; optional since GRE-121).** The Releases
   page can release `origin/main` at any time and cuts the candidate itself.
   A daily candidate is still useful for Flint's preview check. Each morning, if `main` has changed
   since live, tag the merged `main` as a candidate and write the release note
   (big changes first, then each change, its issue, what to check) on a release
   issue. The candidate is checked and its card is ready for John's 08:00
   digest. One candidate per day; a newer merge waits for the next day. Tag it:

   ```sh
   git fetch origin
   node scripts/greatstone-candidate.mjs rc-YYYY-MM-DD.N --title "Decisions in the sidebar and RAM-aware run limits"
   ```

   The tag is annotated. Line 1 is the title: short, plain English, what this
   release brings. The script writes the changelog under it from the merged
   pull requests since the last `live-*` tag, in two groups, `Features` and
   `Fixes`, one line each: `- <summary> (#<PR>, GRE-<n>)`. A pull request whose
   title starts with "fix" is a fix. Add `--print` to see the message first.
   The release refuses an `rc-*` tag without a title (a lightweight tag, or a
   placeholder such as "Release candidate rc-..."), and the `live-*` tag it
   makes gets the rc tag's message. The app shows the title and changelog.

   The tag stays local until the release. The release script pushes the
   `rc-*` tag and its new `live-*` tag only after live is healthy on it; a
   release that fails deletes its local `live-*` tag, so History never offers
   a version that never ran (GRE-239). A release from the app that is cancelled,
   or stops before the switch, deletes the `rc-*` tag it cut.

   Do not cut an `rc-*` tag for the Releases page. The page shows the next
   version from `origin/main` and cuts its own candidate at **Release now**;
   it has no "candidate" field any more. Cut an `rc-*` only for a preview check.

   The release note starts with the change list. Do not write it by hand:

   ```sh
   node scripts/greatstone-changes.mjs rc-YYYY-MM-DD.N   # merges since the last live-* tag
   ```

   It prints one line per merged pull request: the issue link, what changed,
   the page to open on port 3200 and how to reach it from the sidebar, or
   "No visible change". The page comes from the pull request's
   **Where to see it:** line; without that line the script guesses it from the
   changed UI files. Fix a wrong guess in the pull request, not in the list.
4. **Preview (Flint).** Keystone hands the release issue to Flint with the
   `rc-*` tag and the release note. Flint starts the candidate on a copy of the
   live data, checks it, stops it, and hands the issue back with a verdict.
   Keystone reads the evidence before asking John; if Flint is busy or stuck,
   Keystone may run the check itself.

   ```sh
   scripts/greatstone-preview.sh start rc-YYYY-MM-DD.N   # http://localhost:3200
   scripts/greatstone-preview.sh status                  # tag, commit, agent runs since start
   scripts/greatstone-preview.sh switch-tests            # tests of every Experimental switch on in live
   ```

   Go through each "what to check" line and record pass or fail with evidence on
   the release issue. `status` must show 0 agent runs. `switch-tests` must pass:
   it runs the test files of each switch that is on in the preview (a copy of
   live, so live's switches), from `tests/release-switch-tests/switch-tests.json`.
   A failure names the switch, the test file and the test, and fails the
   candidate. A new switch needs an entry in that file. The preview check comment
   starts with the change list from `scripts/greatstone-changes.mjs`, so John
   knows which page to open.
5. **Agree (John).** John may try the preview too. He decides on the
   Releases page (step 6); nobody asks him whether something is released.
   "Not yet" leaves live as it is; the fixes become new issues.
6. **Release (John, from the app).** John releases from the **Releases** page
   (board only; agents get 403 on every release action). The page shows the
   live version, the next version (the pull requests merged into `main` since
   live, a proposed title and the changelog, and Fork CI on that commit), the
   history, and the progress. **Release now** needs no prepared candidate: the
   server cuts the `rc-*` tag from `origin/main` itself, with the title and the
   changelog, once Fork CI on that commit is green. A checked `rc-*` tag can
   also be released. Keystone may edit the proposed title
   (`PATCH /api/companies/:companyId/releases/next`); nothing else. The
   "Update live?" card (a `request_confirmation` with `idempotencyKey`
   `live-release:rc-YYYY-MM-DD.N`) still works and calls the same service, but
   nothing waits for a card any more.

   The release goes through these states, shown on the page:

   - **checking** (seconds): the release repo exists, is a git repo on a
     clean `main`, has the release scripts, and fast-forwards to `origin/main`
     (it refuses local changes or a diverged `main`); the tag exists, has a
     title and is on `origin/main`; live is not already on it. Any failure
     answers at once with a plain reason; live and agent runs are untouched.
   - **holding**: new agent runs are held (the task drain). The release waits
     only for runs flagged **finish before update**, at most 60 minutes. John
     can **cancel** here (live unchanged) or **release without waiting**.
   - **switching**, then **restarting**: `scripts/greatstone-live-release.sh`
     runs `scripts/greatstone-release.sh <tag>` from the release repo, in its
     own process: database backup to `~/GSAM/backups/`, a local `live-*` tag,
     `~/GSAM/live` moved, then a **hot restart**. The tags are pushed once
     live is healthy. Detached runs keep running;
     ACP runs are checkpointed and continue as conversation retries; held runs
     start after. `/api/health` must report the tag's commit from a new process.
   - **healthy**, **rolled_back** (live did not come up; the script went back
     to the previous `live-*` tag by itself, with the reason), **failed**, or
     **cancelled**. A version that failed before GRE-239 kept its `live-*`
     tag; History marks it **Never ran** and offers no rollback. The page shows the hot-restart report: which runs resumed
     and any run that was lost. Runs go again.

   **Finish before update.** An agent in the middle of a commit, a migration or
   similar sets it on its own run, and clears it when done:
   `POST /api/heartbeat-runs/$GSAM_RUN_ID/finish-before-update` with
   `{"enabled": true, "reason": "mid-migration"}`. The board can set or clear it
   on any run. Do not set it for ordinary work: the hot restart keeps it.

   **Release repo.** The server finds the dev checkout from `GSAM_RELEASE_REPO`,
   else `release_repo=` in `~/GSAM/release.conf`. `greatstone-preview.sh start`
   and `greatstone-release.sh` write that file, and `preview stop` leaves it, so
   release works with no preview running. Release works only on the server that
   runs from `~/GSAM/live`; elsewhere the page says it is off.

   **By hand (fallback).** If the app cannot be used, John runs from the dev
   checkout, when no agent is running:

   ```sh
   git pull --ff-only origin main
   scripts/greatstone-release.sh rc-YYYY-MM-DD.N
   ```

   It does the same checks and steps and prints the rollback command and the
   backup file. The new `live-*` tag gets the rc tag's title and changelog. The
   script refuses to run when its release scripts are older than origin/main;
   pull first.
7. **Check live (Flint, then Keystone).** Flint runs
   `curl -s http://localhost:3100/api/health`: the `commit` is the tag's
   commit. Flint spot-checks the changes in live and reports on the release
   issue. Keystone closes it, or gives John the rollback command if live is
   broken.

### Waiting for a release (agents)

When live starts on a new commit (by the card or by hand), it records it once:
an `instance.live_released` entry in each company's activity log (commit,
`live-*` tag, time). A restart on the same commit records nothing. Then it wakes
the issues that wait for a release. Do not ask John whether something is live.

- **To wait:** keep the issue `in_progress` and set a monitor with
  `serviceName: "GSAM live release"` and `externalRef` set to the commit SHA or
  `rc-*` tag you need (leave `externalRef` out to wake on any release). Set
  `nextCheckAt` as your deadline, for example 3 days out. The monitor fires
  once, as soon as live contains that commit, with `liveRelease.commit` and
  `liveRelease.tag` in the wake payload; otherwise it fires at the deadline.
- **To ask:** `GET /api/health/live-release?ref=<sha or rc-* tag>` returns the
  running `commit` and `tag`, the last recorded live start, and `live`:
  `true`, `false`, or `null` (git cannot tell).
- **Old "is it released?" cards:** a pending agent card whose idempotencyKey
  ends in `release:<sha or rc-* tag>` (such as `confirmation:<issue>:release:<sha>`
  or `live-release:<rc-tag>`) is withdrawn when live contains that ref, and the
  issue's agent is woken once. Cards without such a key stay open.

### Rollback (John)

A release rolls back by itself when live does not come up on the new version,
and says so on the Releases page (and on the card's issue) with the backup
file. To move live back later, pick any earlier version in the history on the
Releases page and choose **Roll back**. It takes the same path: the same
checks, the same progress, the same hot restart
(`POST /api/companies/:companyId/releases/rollback` with `{"tag": "live-YYYY-MM-DD.N"}`).
When the page says the automatic rollback failed, or the app is down, John
runs from the dev checkout:

```sh
scripts/greatstone-release.sh live-YYYY-MM-DD.N   # the previous live tag
```

This moves live back to that tag the same way (backup first, then restart). If
the live server is down it starts it with `~/GSAM/start-live.sh`. If the live
database is down too, a rollback after a one-click release keeps the backup
taken before that release. It does not undo database migrations. If the older
code cannot run on the newer database, restore the backup the release printed;
ask Keystone for the steps.

### Promote to Stable (John)

Clients follow `stable-*` tags (Stable); our live install runs `live-*` tags
(Beta); `main` that is not tagged yet is Dev and never goes to clients. To give
clients a version, pick it in the history on the Releases page and choose
**Promote to Stable** (`POST /api/companies/:companyId/releases/promote` with
`{"liveTag": "live-YYYY-MM-DD.N", "notes": "..."}`). Write the client notes:
features only, plain words, no client names. The app refuses notes with a pull
request number (`#123`) or a GRE number. It adds the annotated tag
`stable-YYYY-MM-DD.N` on the same commit, with the notes as its message, and
pushes it to origin. Live does not change. It asks for your password again in
login mode. A release can be promoted once; a promote that fails to push
leaves no tag.

Run the release from your own terminal, not from an agent run. Both scripts
run `pnpm install` without questions. If the pnpm store is not the one live was
installed with (agent runs each get their own store), pnpm deletes and
reinstalls `node_modules` under the running live server. Your terminal always
uses the same store, so this does not happen there.

### Live in login mode: the release key (John, once)

In `local_trusted` the scripts need no login. When live runs in login mode
(`authenticated`, GRE-125), three calls need a board login: the restart request,
the `serverInfo` read in `/api/health`, and the active-run count. The scripts
send a board API key from `~/GSAM/release-board-key` (or
`GSAM_LIVE_BOARD_KEY_FILE`). The release from the app runs the same script, so
it uses the same file. With no file the scripts send no login, as before.

Make the key once, after you claim the board, signed in as the board owner:

```sh
pnpm gsam auth login --api-base http://localhost:3100
pnpm gsam token board create --name live-release --never-expires --api-base http://localhost:3100 --json
# copy the "token" value (pcp_board_...), then:
( umask 077; pbpaste > ~/GSAM/release-board-key )
chmod 600 ~/GSAM/release-board-key
```

The file must be mode 0600 and must never go into a repository. A release
stops before anything moves if the file is readable by others, if the key is
wrong, or if live hides `serverInfo` (login mode and no key). To replace the key,
revoke the old one (`pnpm gsam token board revoke <keyId>`) and write the new
one to the same file. `scripts/release-auth-sandbox-check.sh` tests all of this
on a throwaway sandbox, in both modes.

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

By default the scripts use `GSAM` in the home folder of the user account, not
`$HOME`, so they find the real `~/GSAM/` from an agent run too (agent runs set
`HOME` to a temp folder). You do not need to set `GSAM_ROOT` for a real check.

Every path can be moved, so the scripts can be tried without the real
`~/GSAM/`: set `GSAM_ROOT` (fake GSAM home with `live/`, `data/`, `backups/`,
`preview/`), `GSAM_LIVE_URL` (a fake live server), and `GSAM_RELEASE_REPO` (a
clone whose `origin` is a local bare repository, so no tag reaches GitHub).
