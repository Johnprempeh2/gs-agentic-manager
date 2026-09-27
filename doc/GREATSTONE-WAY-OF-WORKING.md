# How we change GS Agentic Manager

This is the brief for every agent (and human) that changes the platform. The
agents run on this platform, so a careless change can break the app they live
in. The rule behind everything below: **build in isolation, John releases.**

## The three places

| Place | Path | What it is | Who may change it |
|---|---|---|---|
| Live app | `~/GSAM/live` (code) and `~/GSAM/data` (data), served at http://localhost:3100 | The copy John and the agents use every day. Always a tagged release. | Nobody edits it. John updates it with `scripts/greatstone-release.sh`. |
| Dev checkout | `~/Desktop/Code/gs-clip` | The repository your worktrees come from. | Nobody works in it directly. It is the root for worktrees. |
| Your worktree | `~/Desktop/Code/gs-clip/.gsam/worktrees/<branch>` | One folder and one branch per task, created for you when you start the task. | You, for that task only. |

The repository is private: `Johnprempeh2/gs-agentic-manager` (remote
`origin`, default branch `main`). The public fork `Johnprempeh2/GS-Clip`
(remote `public-fork`) only tracks upstream Paperclip. Never push to it.

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
   hand. Link the GRE issue. Put the pull request link on the issue and set it
   to `in_review`.
6. **Checks and review.** Fork CI runs the fast lanes on every pull request. If
   they fail, fix on the same branch and push again. John reviews and merges.
7. **Release.** John tags a release and updates the live app when no agent is
   running. If the release misbehaves, he moves the live app back to the
   previous tag.

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

## Releasing (John)

After merging, from the dev checkout:

```sh
scripts/greatstone-release.sh            # tags origin/main and updates the live app
scripts/greatstone-release.sh <tag>      # moves the live app to an existing tag (rollback)
```

The script refuses while an agent run is active, installs dependencies in the
live checkout, and restarts the live server.
