# DeepSeek Harness - Zhuoran fork

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## What this fork adds

Each change is one commit on the `zhuoran` branch, which is rebased onto upstream `master`. Give [INSTALL.md](INSTALL.md) to a coding agent to install the fork, plus plugins that cap image sizes, read replies aloud, and render Mermaid diagrams.

- **Billed cost everywhere**: each model call records its cost in USD when the provider publishes prices. A call through a gateway is priced at the origin model's rates when its model ID names that model, such as `anthropic/claude-opus-5`. The Web UI shows cost per turn, per session, and per subagent, and sidebar rows can show each session's total spend including its subagents (View options → Show → Total cost).
- **Collapsed steps**: a Work details mode that folds the steps behind each reply into one summary row with the time, model calls, tokens, and changed lines and files, while the reply stays visible. In this mode the server sends folded steps only when you expand them, so scrolling back through a long session takes far fewer page loads.
- **Phone layout**: on screens 640px wide or narrower, the UI is one full-width column and the session list opens as a drawer.
- **Offline reading**: already-loaded content supports local read-only access.
- **Image row**: inside the composer's **+** menu, an Image row under File opens a picker limited to PNG, JPEG, WebP, and GIF images, so phones offer their photo library instead of a file browser.
- **Per-model reasoning effort**: switching to a model restores the effort you last used with it.
- **Copy table as Markdown**: each rendered table has a button that copies its Markdown source.
- **Session counts**: each Workspace shows how many sessions it holds, and the sidebar header shows the total.
- **Sidebar beside fullscreen panels**: a fullscreen right panel leaves the left sidebar visible.
- **Enter key choice**: each browser can make Enter add a new line instead of sending (Settings → General → Enter key); the Send button and Cmd/Ctrl+Enter still send.
- **Phone keyboard fit**: on a phone, the app shrinks above the on-screen keyboard instead of panning it out of view.
- **Continue interrupted sessions**: a button in the sidebar's brand row sends `Continue.` to every session whose last turn failed or was cut off by a restart.
- **Installed-app branding**: each server can give its installed web app its own icon, drawn as one SVG, and its own name, so apps from two servers are easy to tell apart on one phone ([settings](packages/host/frontend-static/README.md#branding-a-deployment)).

It also fixes these upstream bugs, which are still open:

- A plugin that injects only `connection` can register RPC channels with `connection.rpc.handle()` instead of throwing `cannot get property "webServer" without inject` ([report](https://github.com/deepseek-ai/deepseek-harness/discussions/6105)).
- Sessions that 0.1.x releases wrote with subagents open instead of failing with `unsupported descriptor version 2` ([report](https://github.com/deepseek-ai/deepseek-harness/discussions/7995)).
- The sign-in page accepts a pasted `token` value, so a web app added to the iOS Home Screen can sign in ([report](https://github.com/deepseek-ai/deepseek-harness/discussions/5519)).

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/4MrtZUhpxg">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

`pnpm run dev:web` builds, serves, and rebuilds client bundles on source edits in one terminal, and `make help` lists the matching Make targets for Web and Desktop; the guide's application commands section owns the full table.

For agents, follow [AGENTS.md](AGENTS.md).

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
