# Fork workflow (cmsflash/deepseek-harness)

This checkout is a fork: `origin` is upstream, `fork` is ours, and `zhuoran` is the fork's integration branch. The main checkout stays on `zhuoran` and serves the main Web server; never develop in it.

1. **One change, one branch, one worktree:** branch from `zhuoran` into `.worktrees/<short-name>`.
2. **Validate every change end to end** with browser use against a dev server started from that worktree, never the main server.
3. **After validation and the user's approval,** squash-merge locally into `zhuoran` and push `zhuoran` to `fork`. "Merge" always means all three: squash, merge into `zhuoran`, push.
4. **Another agent (e.g. Claude Code) refreshes the main server:** rebuild in the main checkout on `zhuoran`, restart the main server, then send `Continue.` to every interrupted thread, meaning any thread whose last turn did not end normally, whatever the reason or time.
5. **On request after the refresh,** upgrade DSH on the VM and clean up the dev setup: remove the local branch, the worktree, and the dev server.
