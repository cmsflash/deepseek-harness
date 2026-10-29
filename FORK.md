# Fork workflow (cmsflash/deepseek-harness)

This checkout is a fork: `origin` is upstream, `fork` is ours, and `zhuoran` is the fork's integration branch. The main checkout stays on `zhuoran` and serves the main Web server; never develop in it.

1. **One change, one branch, one worktree:** branch from `zhuoran` into `.worktrees/<short-name>`.
2. **Validate every change end to end** with browser use against a dev server started from that worktree, never the main server.
3. **After validation and the user's approval,** squash-merge locally into `zhuoran` and push `zhuoran` to `fork`. "Merge" always means all three: squash, merge into `zhuoran`, push.
4. **Pass the profile gate before the refresh,** above all after replaying `zhuoran` onto a new upstream `master`: build the new `zhuoran` tip in a worktree and run the dev-servers skill's `dsh_profile_gate.mjs --checkout <worktree>`. It checks the main server's outside plugins (read-aloud, mermaid, and the rest of `~/.dsh/profiles/web`) against that build, and `dsh_restart.py restart --build` refuses a new tree without a pass.
5. **Another agent (e.g. Claude Code) refreshes the main server:** rebuild in the main checkout on `zhuoran`, restart the main server, then send `Continue.` to every interrupted thread, meaning any thread whose last turn did not end normally, whatever the reason or time.
6. **On request after the refresh,** upgrade DSH on the VM and clean up the dev setup: remove the local branch, the worktree, and the dev server.
