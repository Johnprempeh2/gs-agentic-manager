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
   to what the issue asks for. If your run started in your parent task's
   worktree, work there and commit on the parent's branch, and say on the issue
   that the change ships in the parent's pull request. If it started in the dev
   checkout and the task needs a branch, do not make a worktree by hand: say so
   on the issue, set it to `blocked` and name Keystone.
3. **Test in a sandbox.** Run the tests for what you touched from the worktree
   root (`npx vitest run <files>`, `npx tsc --noEmit -p <package>`). When you
   need the running app, start a sandbox from the worktree:
   `pnpm dev:once --data-dir ./tmp/sandbox`. It picks the next free port (never
   3100) and has its own empty data. It does not get your run's identity or
   credentials (`GSAM_API_KEY`, the agent, company and task ids, the GitHub
   tokens, live's URL), so it cannot act on live as you; it keeps `GSAM_RUN_ID`,
   so it is still stopped when your run ends. To give the sandbox one of those
   names on purpose, add the `GSAM_SANDBOX_` prefix, for example
   `GSAM_SANDBOX_RUNNER_NETWORK_ACCESS=disabled pnpm dev:once --data-dir ./tmp/sandbox`
   (credentials and tokens are always refused; the start line says what was
   applied). Stop it when you are done, from the
   worktree root, with `pnpm dev:stop --data-dir ./tmp/sandbox` (the same
   `--data-dir` you started it with; it stops only the services registered for
   this worktree), or with `kill <pid>` using the runner PID you recorded
   (`pnpm dev:list --data-dir ./tmp/sandbox` shows it). Never stop it with
   `pkill -f`, `killall` or `kill` on a pattern or name: live runs the same
   commands (`dev-runner`, `dev:once`, `tsx`, `node`, `postgres`, `pnpm`) under
   the same user, so the pattern matches live too. On 4 Oct 2026
   `pkill -f "dev-runner.ts dev"` from an agent sandbox stopped live for 8.5
   hours. Anything your run leaves running (a sandbox and its database, a
   Storybook or other dev server started in the background) is now stopped
   when the run ends: GS Agentic Manager stops every process that still
   carries your run's `GSAM_RUN_ID` (SIGTERM, then SIGKILL after 5 seconds),
   and a sweep every five minutes catches what a restart missed. That is a
   safety net, not the way to finish: it gives no clean shutdown, so still stop
   your sandbox yourself, and do not leave a server running for a later run.
   On 5 Oct 2026 two Storybook servers from finished runs had run for 15 and
   22 hours, 2.2 and 2.5 GB each, in worktrees that were already deleted.
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
  release task for John (what changes, why it is big, what could break, how
  to roll back). If John says "not yet", the change stays out of live until it is
  fixed or reverted.
- **Keystone's own pull requests go to Flint.** Keystone never merges its own
  work. It sets Flint (release verifier) as the `review` stage participant.
  Flint does the ready check and merges; a big change is listed on the release
  task in the same way.
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

## Taking upstream code

We take upstream (`paperclipai/paperclip`, `master`) changes as cherry-picks
or partial ports, so git cannot tell what we already have. Three records do:

- **Every commit that takes upstream code ends with one line per upstream
  commit:** `Upstream-Commit: <sha> taken` (all of it) or
  `Upstream-Commit: <sha> partial` (only some of it). Use the upstream sha, 9
  or more characters. When the rest of a partial commit is taken later, that
  commit says `taken`; if the rest is skipped, add a skip line.
- **Skipped upstream commits** go in `doc/upstream-skipped.txt`, one per line:
  `<sha> <reason>`.
- `doc/upstream-taken.txt` holds commits taken before this rule (4 Oct 2026).
  Do not add new lines there; use the commit line.

`scripts/upstream-pending.sh` lists the upstream commits since the split
(`01d9a1218`) that none of these records name, security-looking ones first,
and partial ones in their own list. It only reads git. Fetch first:
`git fetch https://github.com/paperclipai/paperclip.git master:refs/upstream/master`.

Upstream security advisories have a verdict each in `doc/upstream-advisories.txt`:
`<GHSA id> <severity> <updated_at> <verdict> [note]`, where the verdict is
`in-base`, `taken #<PR>`, `n/a: <reason>` or `check`. The daily check runs
`scripts/upstream-pending.sh --advisories`, which reads the advisories with
`gh api` and prints `NEW`, `CHANGED` and `OPEN` lines, and lists a pending
commit as security when an advisory names its sha or PR number. Each `NEW` or
`CHANGED` line gets a verdict the same day; a `check` that may expose us goes
to GRE-483 as a bug row.

For each upstream batch, Delta also runs
`scripts/licence-diff.sh origin/main refs/upstream/master --fetch` and pastes
any `check` lines (GPL, AGPL, LGPL, SSPL, BUSL, unknown, none) on the
"Upstream log" issue for Harbor before the sync pull request.

## Never

- Edit, run git in, install into, or restart anything under `~/GSAM/`.
- Restart or stop the server on port 3100, or run a server with `~/GSAM/data`.
- Use `pkill -f`, `killall` or `kill` on a pattern or name you did not start
  yourself (`dev-runner`, `dev:once`, `tsx`, `node`, `postgres`, `pnpm`). Live
  runs the same commands under the same user, so the pattern also matches
  live: on 4 Oct 2026 `pkill -f "dev-runner.ts dev"` stopped live for 8.5
  hours. Stop your sandbox with `pnpm dev:stop --data-dir ./tmp/sandbox` from
  the worktree root, or by the PID you recorded.
- Push to `main`, force-push, merge your own pull request, or delete branches
  or tags.
- Push to `public-fork` or open pull requests on `Johnprempeh2/GS-Clip`.
- Run `git clean -x`, `git reset --hard`, `git stash` or `git checkout` of
  another branch in the dev checkout. Your worktree is your only workspace.
- Run `git worktree add` under `.gsam/worktrees/`. GS Agentic Manager does not
  record a worktree you make there, so nothing removes it, and with its
  `node_modules` each one costs gigabytes. For a throwaway check of a pull
  request, a release candidate or a tag, add a detached checkout inside your
  run's scratch folder (`git worktree add --detach
  "$GSAM_RUN_SCRATCH_DIR/check" <sha or tag>`) and remove it with
  `git worktree remove --force "$GSAM_RUN_SCRATCH_DIR/check"` before you
  finish. The scratch folder is deleted when the run ends.
- Commit secrets, tokens, `.env` files, client names or personal data.
- Widen a task on your own. Propose follow-up work as a new issue instead.
- Open a dev server you start to the network. Storybook, the Vite dev and
  preview servers and `scripts/serve-storybook-static.mjs` listen on
  `127.0.0.1` only, which is all a screenshot needs; do not pass
  `--host 0.0.0.0` or set `GSAM_DEV_HOST` in a run. On 5 Oct 2026 two agent
  Storybook servers listened on every interface, so every device on the
  tailnet could open them (see "Dev servers listen on 127.0.0.1" in
  `doc/DEVELOPING.md`).

A `pre-push` hook in the dev checkout (shared by every worktree) checks pushes
only. On this machine it refuses a push to `main`, a tag push that does not come
from the release script, a push that deletes a branch or tag, and any push to
`public-fork`. It does not stop edits, installs or git commands under `~/GSAM/`,
server restarts, force-pushes to other branches, merges, or pull requests on
`Johnprempeh2/GS-Clip`. You must keep those rules yourself.
A local agent run with managed GitHub access (the usual case here) also has a
process guard: `pkill` and `killall` wrappers first on its PATH. They work out
what the command would signal, leave live's processes alone (anything from
`~/GSAM/live` or `~/GSAM/data`, and the live server with the processes that
started it), signal the rest and say how many they left. They do not cover
`kill`, a full path such as `/usr/bin/pkill`, a run that uses the host's own
GitHub login, or a remote sandbox, so keep the rule above yourself.
A `pre-commit` hook, installed automatically when an agent worktree is created
(`scripts/git-hooks/install.sh`), refuses a commit when the branch or worktree
is not the run's `GSAM_WORKSPACE_BRANCH` / `GSAM_WORKSPACE_WORKTREE_PATH`; it
does nothing at a terminal where those are not set.
`main` has no branch protection or ruleset on GitHub (checked 29 Sep 2026), so
a merge on `local-ci` is not blocked there. If a branch rule is added later
that requires the "Fork CI" check, it must also accept `local-ci` (or let
Keystone bypass it), or the fallback cannot merge.

## Asking John to approve something you made

John approves what he can see, not a description (GRE-449). Before you post
a card that asks him to approve a design, screen, deck, video or document:

1. **Check the draft first.** Hold it against the `greatstone-brand` skill and
   the `lessons` document on GRE-13. Fix what they catch before John sees it.
2. **Attach the real thing.** Upload it to the task as an attachment, or
   register it as a deliverable. The Decisions card shows the latest
   deliverable inline, so John does not leave the card.
3. **Then post the card.** Without an attachment on the task the server refuses
   the card with a `422` (`approval_evidence_missing`).

## When something is unclear or blocked

Say so on the issue in one or two sentences, set it to `blocked`, and name who
must act. Do not work around a missing permission.

## Releasing: try first, then agree

Merging does not change the live app. A version goes live in these steps.

1. **Ready check (Keystone).** For each open pull request: Fork CI is green,
   the tests the pull request names pass again, the issue's "Done when" list is
   met, and the diff does not touch `~/GSAM/`, secrets or client data. Keystone
   posts "Ready to merge" or "Not ready, because ..." on the issue.

   **Draft (GRE-605).** `node scripts/greatstone-local-ci.mjs ready <pr>`
   does the mechanical part in the reused local-ci checkout: it reads Fork CI,
   reruns the PR body's "Tests run" commands, runs the S2 steps below, flags
   "big change" triggers (migrations, auth/permissions, `scripts/greatstone-*`,
   CI files, more than 1,000 changed lines outside tests) and `~/GSAM` or
   secret-shaped lines, and prints a 5-line draft verdict. It posts nothing.
   Keystone reads it, checks the "Done when" list, and decides.

   **Page-load check (S2, GRE-501).** In the pull request's checkout, run
   `pnpm metrics:s2-needed --pr <number>`. If it says "yes" (the pull request
   changes `ui/`, the issue/board API routes, or the S2 harness or budgets),
   run `pnpm test:metrics:s2` there. It builds the UI, times the issue page
   and the board on a throwaway instance under `./tmp/`, and takes about two
   minutes. Paste its first line and the six result lines into the ready
   check. If it says FAIL, run it once more (the machine is shared, so one slow
   run can be noise). If it still fails, the verdict is "Not ready, because
   the page is slower", unless John or Everest has accepted the slowdown;
   then merge it and list it on the next release task with the numbers.
   Nothing runs this on GitHub; Keystone runs it locally.

   **Licence check (GRE-624).** If the pull request changes `pnpm-lock.yaml`,
   run `scripts/licence-diff.sh origin/main <pr-head>` (add `--fetch` if it
   says the pnpm store lacks a package). Paste every `check` line on the issue
   for Harbor. No `check` lines: say "licences ok" in the ready check.
2. **Merge (Keystone).** `gh pr merge` when the verdict is "Ready to merge" and
   CI is green (Fork CI, or `local-ci` when GitHub could not start it; see
   "The merge rule"); for a big change, also after Flint's checks pass. Keystone never
   merges its own pull requests; Flint checks and merges those.
3. **Candidate (Keystone, once a day).** Each morning, if `main` has changed
   since live, tag the merged `main` as a candidate and write the release note
   (big changes first, then each change, its issue, what to check) on a release
   issue. The candidate is checked and John's release task is ready for his
   08:00 digest. One candidate per day; a newer merge waits for the next day.
   First run `scripts/greatstone-release-audit.sh` (read-only; Flint also runs
   it at the start of each live check): it shows what live runs against John's
   open release task and the checks of each `live-*` tag of the last 7 days
   (a past tag with no live check shows `missed (no longer live)`). Act on the
   last line: `action: one live check of <tag>` means Keystone gives Flint that
   one live check; `action: none` means nothing to do (GRE-767, GRE-919). Tag it:

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

   John releases the `rc-*` tag that Flint checked, by hand (step 6).

   The release note starts with the change list. Do not write it by hand:

   ```sh
   node scripts/greatstone-changes.mjs rc-YYYY-MM-DD.N   # merges since the last live-* tag
   ```

   It prints one line per merged pull request: the issue link, what changed,
   the page to open on port 3200 and how to reach it from the sidebar, or
   "No visible change". The page comes from the pull request's
   **Where to see it:** line; without that line the script guesses it from the
   changed UI files. Fix a wrong guess in the pull request, not in the list.

   For what to check, list each merge with its issue's "Done when":

   ```sh
   scripts/greatstone-release-note.sh live-YYYY-MM-DD.N [ref]   # ref defaults to origin/main
   ```

   It prints one line per merged pull request: the GRE id, the title and the
   issue's "Done when" items. A pull request with no `GRE-###` in its title or
   branch name is flagged "NO GRE ID"; find its issue before the release note
   goes out. It only reads git, `gh pr view` and the app. Tests:
   `node --test scripts/greatstone-release-note.test.mjs`.
4. **Preview (Flint).** Keystone hands the release issue to Flint with the
   `rc-*` tag and the release note. Flint starts the candidate on a copy of the
   live data, checks it, stops it, and hands the issue back with a verdict.
   Keystone reads the evidence before asking John; if Flint is busy or stuck,
   Keystone may run the check itself.

   ```sh
   scripts/greatstone-preview.sh start rc-YYYY-MM-DD.N   # http://localhost:3200
   scripts/greatstone-preview.sh status                  # tag, commit, migrations applied, agent runs since start
   scripts/greatstone-preview.sh switch-tests            # tests of every Experimental switch on in live
   ```

   Go through each "what to check" line and record pass or fail with evidence on
   the release issue. `status` must show 0 agent runs. Its "migrations applied
   on start" line (from the preview log, GRE-827) goes in the preview report as
   its own pass or fail line: it must match the "Migrations:" line Keystone gives
   (release note or release task), and Keystone copies it to the release task. `switch-tests` must pass:
   it runs the test files of each switch that is on in the preview (a copy of
   live, so live's switches), from `tests/release-switch-tests/switch-tests.json`.
   A failure names the switch, the test file and the test, and fails the
   candidate. A new switch needs an entry in that file. The preview check comment
   starts with the change list from `scripts/greatstone-changes.mjs`, so John
   knows which page to open. For the 2-week beta graduation rule,
   `GSAM_API_URL=<base> GSAM_API_KEY=<key> scripts/beta-switch-age.sh` (GET
   only) prints each switch's on/off, on since, days on and "2-week rule met".
   `--scorecard <file>` (a saved copy of the GRE-81 scorecard) also lists
   switches with no scorecard row and rows whose switch left the catalog.
5. **Release task (Keystone).** Releases happen outside the app (John,
   GRE-489, 4 Oct). There is no "Update live?" card. When Flint reports "All
   pass", Keystone creates a task assigned to John, a child of the release
   issue, titled "John: release rc-YYYY-MM-DD.N to live (by hand)". It holds
   the change list (big changes first), the proof for each line, the release
   command (step 6, "By hand") and the rollback command. Keystone also creates
   a Flint "check live" task blocked by John's task. John may try the preview
   too. "Not yet" leaves live as it is; the fixes become new issues.
6. **Release (John, by hand).** John runs the release from the dev checkout
   (see "By hand" below) and marks his task done. The **Releases** page in the
   app (board only; agents get 403 on every release action) still works but
   is not part of the normal flow. For reference, the page shows the
   live version, the next version (the pull requests merged into `main` since
   live, a proposed title and the changelog, and Fork CI on that commit), the
   history, and the progress. **Release now** needs no prepared candidate: the
   server cuts the `rc-*` tag from `origin/main` itself, with the title and the
   changelog, once Fork CI on that commit is green. A checked `rc-*` tag can
   also be released. Keystone may edit the proposed title
   (`PATCH /api/companies/:companyId/releases/next`); nothing else. The
   "Update live?" card (a `request_confirmation` with `idempotencyKey`
   `live-release:rc-YYYY-MM-DD.N`) still works and calls the same service, but
   agents do not post it any more.

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

   **By hand (the normal way).** John runs from the dev checkout, when no
   agent is running:

   ```sh
   git pull --ff-only origin main
   scripts/greatstone-release.sh rc-YYYY-MM-DD.N
   ```

   It does the same checks and steps and prints the rollback command and the
   backup file. The new `live-*` tag gets the rc tag's title and changelog. The
   script refuses to run when its release scripts are older than origin/main;
   pull first. It also refuses an rc tag that does not contain the live commit
   (an older candidate), so a release never goes backwards; to go back, roll
   back with a `live-*` tag (GRE-839).

   **Full stop and start.** When the release task says so (a fix to the dev
   runner itself, such as #274), John runs
   `scripts/greatstone-release.sh --full-restart rc-YYYY-MM-DD.N` instead.
   It takes the same backup and tag, then stops all of live (the dev runner,
   any server it leaves behind, and the live database), checks that nothing
   of live is left and nothing answers on port 3100, and starts live with
   `~/GSAM/start-live.sh`. If something does not stop, it starts nothing and
   names the processes. It cannot run from the app.
7. **Check live (Flint, then Keystone).** When John's task is done, Flint runs
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
As releases are by hand, the normal way to roll back is by hand too. John
runs from the dev checkout (also when the automatic rollback failed, or the
app is down):

```sh
scripts/greatstone-release.sh live-YYYY-MM-DD.N   # the previous live tag
```

This moves live back to that tag the same way (backup first, then restart). If
the live server is down it starts it with `~/GSAM/start-live.sh`. If the live
database is down too, a rollback after a one-click release keeps the backup
taken before that release. It does not undo database migrations. If the older
code cannot run on the newer database, restore the backup the release printed
(below). Each release task says "Migrations: none" or names the migrations
the candidate adds, so you know before you release if this can happen.

#### Restore the live database from a release backup (John)

Only when the older code fails on the newer database (live does not come up
after the rollback, or `~/GSAM/logs/live.log` shows a database error). The
restore puts back the database as it was just before the release. **Work done
in live after that release is lost**; step 2 keeps a copy of it. No agent may
be running. Run from the dev checkout, in this order:

```sh
cd ~/Desktop/Code/gs-clip
# The file the release printed ("Database backup from before this release: ..."),
# from the release that added the migration. To find it: ls -t ~/GSAM/backups/release-*/before-*.sql.gz
BACKUP=~/GSAM/backups/release-<time>-<rc-tag>/before-<rc-tag>-<stamp>.sql.gz
PREVIOUS=live-YYYY-MM-DD.N        # the live tag before that release
export BACKUP DB_DIR=~/GSAM/data/instances/default/db

# 1. Stop live (runner, server and database).
bash -c 'source scripts/greatstone-common.sh && stop_live_server'

# 2. Keep the current database folder, in case you must go back to it.
cp -a "$DB_DIR" ~/GSAM/backups/db-before-restore-$(date +%Y%m%dT%H%M%S)

# 3. Restore the backup into the live database (it starts and stops it again).
node cli/node_modules/tsx/dist/cli.mjs --eval '
(async () => {
  const { ensureEmbeddedPostgres } = await import("./cli/src/commands/worktree.ts");
  const { embeddedPostgresConnectionString, resetPostgresDatabase, runDatabaseRestore } = await import("./packages/db/src/index.ts");
  const pg = await ensureEmbeddedPostgres(process.env.DB_DIR, 54339, { allowExisting: false });
  try {
    const url = (database) => embeddedPostgresConnectionString({ ...pg, database });
    await resetPostgresDatabase(url("postgres"), "paperclip");
    await runDatabaseRestore({ connectionString: url("paperclip"), backupFile: process.env.BACKUP });
    console.log(`Restored ${process.env.BACKUP} into ${process.env.DB_DIR}`);
  } finally { await pg.stop(); }
})().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
'

# 4. Move the code back and start live. The database is down, so tell the
#    script which backup to keep instead of taking a new one.
GSAM_RELEASE_EXISTING_BACKUP="$BACKUP" scripts/greatstone-release.sh "$PREVIOUS"
#    If it says "live is already on $PREVIOUS" (the automatic rollback moved
#    the code already), start live instead: ~/GSAM/start-live.sh

# 5. Check: status "ok" and the commit of $PREVIOUS.
curl -s http://localhost:3100/api/health
git rev-parse "$PREVIOUS^{commit}"
```

Step 3 prints `Restored ...`. If it fails, live is still stopped, the code has
not moved and the copy from step 2 is untouched: put it back with
`rm -rf "$DB_DIR" && cp -a ~/GSAM/backups/db-before-restore-<stamp> "$DB_DIR"`,
start live with `~/GSAM/start-live.sh` and tell Keystone. After a restore, tell
Keystone too, so Flint checks live and the migration is fixed before the next
candidate.

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

### Stable image (John, after each promote)

Clients install a Docker image, not a checkout. Each `stable-*` tag gets one
image, built from that tag's commit and pushed to a private registry
(GRE-138). From the dev checkout, with Docker Desktop running:

```sh
scripts/greatstone-stable-image.sh publish stable-YYYY-MM-DD.N
```

It builds the image from the tag (`git archive`, never the working tree),
starts it on `127.0.0.1` (a free port in 3300-3399, never 3100 or 3200) with
the Managed edition values from `scripts/client-instance.sh edition-env`, a new
auth secret and no volume, and checks `/api/health`: status `ok`, the tag's
commit, login mode, and every Managed hidden setting. Then it pushes
`ghcr.io/johnprempeh2/gsam-stable:stable-YYYY-MM-DD.N` and reads the package
visibility; a public package stops the push. A Stable image is pushed once and
never replaced. `build`, `check` and `push` run one step each.

- **Registry:** GitHub Container Registry, package `gsam-stable` under John's
  account, private. The image has no `org.opencontainers.image.source` label,
  so it is not linked to the (public) source repository and does not take its
  visibility. Set `GSAM_IMAGE_REPO` to use another registry.
- **Log-in (John, once):** a classic token with `write:packages` and
  `read:packages` only, then `docker login ghcr.io -u johnprempeh2`. Docker
  keeps it in the macOS keychain. `gh auth refresh -s read:packages` lets the
  script read the package visibility. No token goes in the repo or on an issue.
- **Platform:** this Mac builds `linux/arm64`. A client server with another
  CPU needs `GSAM_IMAGE_PLATFORM=linux/amd64` (slower: emulated).
- Tests: `node --test scripts/greatstone-stable-image.test.mjs`.

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
cd ~/GSAM/live
node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts auth login --api-base http://localhost:3100
node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts token board create --name live-release --never-expires --api-base http://localhost:3100 --json
# copy the "token" value (pcp_board_...), then:
( umask 077; pbpaste > ~/GSAM/release-board-key )
chmod 600 ~/GSAM/release-board-key
```

The file must be mode 0600 and must never go into a repository. A release
stops before anything moves if the file is readable by others, if the key is
wrong, or if live hides `serverInfo` (login mode and no key). To replace the key,
revoke the old one (from `~/GSAM/live`: `node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts token board revoke <keyId>`) and write the new
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
- **Run from a fresh checkout:** the script uses the dependencies of the
  checkout it runs from. In a fresh clone of a tag, run
  `pnpm install --frozen-lockfile` there first; `start` says so if you forget.

### Screenshots (`shot`): one-time host setup

`shot` uses Playwright's Chromium headless shell. Agent runs have a temp
`HOME`, so `shot` looks for the browser in the account's own folder
(`~/.cache/ms-playwright` on Linux, `~/Library/Caches/ms-playwright` on macOS),
not in `$HOME`. Set `PLAYWRIGHT_BROWSERS_PATH` to use another folder.

The browser is installed once, by anyone, in the dev checkout:

```sh
npx playwright install chromium-headless-shell   # the browser, in ~/.cache/ms-playwright
```

Chromium also needs system libraries (libnss3, libnspr4, libasound2). When the
host lacks them, `shot` fetches them without root (`apt-get download` and
`dpkg-deb -x`) into `~/.cache/ms-playwright/gs-chromium-libs`, one folder
shared by every worktree, and loads them from there (GRE-1065). To fetch them
by hand, run `node scripts/chromium-libs.mjs`. Only when that fetch fails does
`shot` say "The no-root fetch failed"; then John runs
`sudo npx playwright install-deps chromium` once. After a Playwright upgrade,
install the browser again.

### Sandbox test of the scripts

By default the scripts use `GSAM` in the home folder of the user account, not
`$HOME`, so they find the real `~/GSAM/` from an agent run too (agent runs set
`HOME` to a temp folder). You do not need to set `GSAM_ROOT` for a real check.

Every path can be moved, so the scripts can be tried without the real
`~/GSAM/`: set `GSAM_ROOT` (fake GSAM home with `live/`, `data/`, `backups/`,
`preview/`), `GSAM_LIVE_URL` (a fake live server), and `GSAM_RELEASE_REPO` (a
clone whose `origin` is a local bare repository, so no tag reaches GitHub).
