# Fork workflow (cmsflash/deepseek-harness)

This checkout is a fork: `origin` is upstream, `fork` is ours, and `zhuoran` is the fork's integration branch. The main checkout stays on `zhuoran` and serves the main Web server; never develop in it.

1. **One change, one branch, one worktree:** branch from `zhuoran` into `.worktrees/<short-name>`.
2. **Validate every change end to end** with browser use against a dev server started from that worktree, never the main server.
3. **After validation and the user's approval,** squash-merge locally into `zhuoran` and push `zhuoran` to `fork`. "Merge" always means all three: squash, merge into `zhuoran`, push.
4. **Pass the profile gate before the refresh,** above all after replaying `zhuoran` onto a new upstream `master`: build the new `zhuoran` tip in a worktree and run the dev-servers skill's `dsh_profile_gate.mjs --checkout <worktree>`. It checks the main server's outside plugins (read-aloud, mermaid, and the rest of `~/.dsh/profiles/web`) against that build, and `dsh_restart.py restart --build` refuses a new tree without a pass.
5. **Another agent (e.g. Claude Code) refreshes the main server:** rebuild in the main checkout on `zhuoran`, restart the main server, then send `Continue.` to every interrupted thread, meaning any thread whose last turn did not end normally, whatever the reason or time.
6. **On request after the refresh,** upgrade DSH on the VM and clean up the dev setup: remove the local branch, the worktree, and the dev server.

## Replaying `zhuoran` onto upstream `master`

Replay onto the latest `origin/master`, not the latest release. Until the user approves the result, leave `zhuoran`, the main checkout, the main server and the VM untouched.

1. **Set up two worktrees.** After `git fetch origin`, create the branch `zhuoran-<yyyymmdd>` from `origin/master` in `.worktrees/<short-name>`, and a second worktree detached at the same commit as the baseline. In each, install with `CI=true pnpm install --frozen-lockfile` (otherwise lefthook rewrites the main checkout's git hooks) and run `pnpm run build:native-system` once.
2. **Strip the main server's environment.** A shell started from a DSH thread inherits `DSH_HOME`, `DSH_PROFILE`, `DSH_PROFILE_DIR`, `DSH_WEB_URL`, `DSH_SESSION_ID`, `DSH_SHELL` and `LITELLM_BASE_URL` from the main server. Run every install, build, test and server command with `env -u` for each of them, so nothing reads or writes `~/.dsh`.
3. **Cherry-pick `git log --reverse --no-merges origin/master..zhuoran` in order.** Resolve each conflict so the fork's behavior survives on upstream's new code, and run the tests of the packages the commit touches before continuing. Drop a commit only when upstream fully covers it, shown by the commit's own tests passing without it, and update README.md to match.
4. **Regenerate generated files instead of merging them.** Take upstream's side, then rerun the generators (`gen-persistence-catalog`, `gen-doc-graphs`, `gen-client-catalog`, `gen-cordis-catalog`, `gen-config-catalog`, `gen-cordis-api`, `gen-module-graph`, `gen-tsconfig-paths`). For a `.i18n.yaml` pairing record, take upstream's side and rerun `tsx scripts/verify-translation-pairing.ts --write <file>.md` once both languages are merged. Re-record a persistence change whose record predates upstream's format with `pnpm run persistence-changes --record`.
5. **Translate every fork string into each locale upstream ships;** the dictionaries are typed to require every key.
6. **Fix each problem in the commit that introduced it,** with `git commit --fixup=<sha>` and `git rebase -i --autosquash`, and fold follow-up commits into the feature they complete, so every commit stands alone.
7. **Check every commit:** typecheck, the tests of each package it changes, the generators' checks, `git diff --check` and translation pairing.
8. **Check the tip:** `build:artifacts`, `typecheck`, `build:check`, `lint`, `doc-sync`, the unit suite and the web suite with `DSH_SNAPSHOT=replay`. A failure that also fails on the baseline is upstream's; rerun a timeout alone before calling it a regression.
9. **Pass the profile gate** (item 4 above) on the new tip.
10. **Validate on a copy of the main server.** Copy `~/.dsh` without caches to `~/.dsh-qa/<name>/home`, make the relative symlinks in its `profiles/web/node_modules` absolute, and disable every MCP server entry and active schedule in it. Start the new tip like `~/.dsh/launchd/run-main.sh` with that `DSH_HOME`, on a port and tailnet twin from the dev-servers skill. Keep its sign-in token in an owner-only file, never in a thread. In a `feature-lab` workspace, check every fork feature in the browser with one `REBASE QA NN — <feature>` thread each, and leave the server running. Never press the sidebar's Continue button there: it would resume every interrupted copied thread in its real directory.
11. **Hand over** the review URL, the results and the baseline comparison. After approval, push the old `zhuoran` tip to `fork` as a dated backup branch, point `zhuoran` at the new branch in the main checkout, push it to `fork` with `--force-with-lease`, then follow items 4–6 above.
