# Install this fork

This branch (`zhuoran` on [cmsflash/deepseek-harness](https://github.com/cmsflash/deepseek-harness)) is DeepSeek Harness with extra Web UI features and a set of plugins. Give this file to your coding agent and ask it to set things up. The agent installs the fork and the plugins, starts a server that keeps running after the agent exits and across reboots, and returns a link to it. Running the same request again updates everything.

## What it adds over upstream DeepSeek Harness

- **Billed cost everywhere**: every model call records its billed USD, and the Web UI shows it per turn, per session, and per subagent. Sidebar rows can show each thread's spend (View options → Show → Total cost).
- **Collapsed steps**: a turn's settled tool steps fold into one row per human input, and step details load on expand.
- **Per-model reasoning effort**: each model remembers the last effort you picked.
- **Phone layout**: one full-width column with an overlay drawer on narrow screens.
- **Session counts** per Workspace and in total.
- **Copy table as Markdown**: copying a rendered table yields its Markdown source.
- **Plugins**: [dsh-image-side-limit](https://github.com/cmsflash/dsh-image-side-limit) caps each request image's long edge at 2000px, which Anthropic requires once a request carries more than twenty images; [dsh-read-aloud](https://github.com/cmsflash/dsh-read-aloud) reads replies aloud; [dsh-mermaid](https://github.com/AKS1st/dsh-mermaid) (third-party) renders `mermaid` code blocks as diagrams.

## Instructions for the agent

Do all of this in one turn. Ask the user only where a step says to.

1. **Check prerequisites.** `node --version` must be `^22.19` or `>=24`, `pnpm --version` must be 11.x (if not, run `npm install -g pnpm@11`), and `git` must exist. The install needs about 3 GB of disk.

2. **Choose the data directory.** DeepSeek Harness keeps sessions and settings in `$DSH_HOME`, which defaults to `~/.dsh`. If `~/dsh-fork/run.sh` exists, this fork is already installed: reuse the `DSH_HOME` and port that script sets, for every step below, so the user keeps their sessions. Otherwise this is a first install. This fork writes session format 3, and upstream releases from `0.2.0` write format 4, which this fork refuses to read. So if `~/.dsh/sessions` or `~/.dsh/settings.yaml` exists, the user already runs another DeepSeek Harness: use `DSH_HOME=~/.dsh-fork` and leave `~/.dsh` alone. Otherwise use `~/.dsh`.

3. **Pick a port.** On a first install, use `3080` unless something listens on it (`lsof -nP -iTCP:3080 -sTCP:LISTEN`); otherwise pick a free port. On an update, keep the port from step 2. Never stop a process you did not start to free a port.

4. **Clone and build.** Clone the fork and the two first-party plugins as siblings under one directory, because each plugin links its build dependencies from `../../deepseek-harness`:

   ```sh
   mkdir -p ~/dsh-fork/plugins && cd ~/dsh-fork
   git clone --branch zhuoran https://github.com/cmsflash/deepseek-harness.git
   (cd deepseek-harness && pnpm install --frozen-lockfile && pnpm run build)
   for p in dsh-image-side-limit dsh-read-aloud; do
     git clone "https://github.com/cmsflash/$p.git" "plugins/$p"
     (cd "plugins/$p" && pnpm install && pnpm run build)
   done
   ```

   The first build takes a few minutes; give the command a timeout of at least 15 minutes. To update an existing install instead, run `git pull --ff-only` in each repository and repeat the install and build steps. The `zhuoran` branch is rebased onto each upstream release, so if `git pull --ff-only` refuses, run `git fetch origin && git reset --hard origin/zhuoran` there after checking that `git status` shows no local changes.

5. **Add the plugins to the `web` profile.** Run from `~/dsh-fork/deepseek-harness`, with the chosen `DSH_HOME`:

   ```sh
   pnpm dsh plugin --profile web add link:$HOME/dsh-fork/plugins/dsh-image-side-limit
   pnpm dsh plugin --profile web add github:AKS1st/dsh-mermaid#2708cdf2e2eb1c0cd15448c3d3d680b8fba58d48
   pnpm dsh plugin --profile web add link:$HOME/dsh-fork/plugins/dsh-read-aloud
   ```

   Bundle order is the order of first addition; adding a plugin that is already present is skipped.

6. **Configure a model.** Stock DeepSeek Harness needs only a DeepSeek API key: put `DEEPSEEK_API_KEY=<key>` in `$DSH_HOME/.env` with mode `600`. Ask the user for the key if it is not already set; never print it. To use another provider, see the [llm-pi-ai README](packages/llm/llm-pi-ai/README.md). Read-aloud needs a speech route. Its bundled defaults expect an OpenAI-compatible gateway; to use OpenAI directly, put `OPENAI_API_KEY` in the same `.env` and override the plugin's `read-aloud` row in `$DSH_HOME/profiles/web/cordis.patch.yml`, changing `provider`, `model`, and `voice` together as the plugin's [Config section](https://github.com/cmsflash/dsh-read-aloud#config) requires. A patch replaces the row's whole `config`, so restate every field.

7. **Run it as a login service.** Write the launch script `~/dsh-fork/run.sh`, which sets `DSH_HOME` and runs, from `~/dsh-fork/deepseek-harness`, `node apps/cli/lib/bin.js --profile web --no-open --host 127.0.0.1 --port <PORT>`, with its output appended to `~/dsh-fork/server.log`. Register that script as a service that restarts on exit and at login: a LaunchAgent with `RunAtLoad` and `KeepAlive` on macOS (`launchctl bootstrap gui/$(id -u) <plist>`), or a `systemd --user` unit with `Restart=always` on Linux (`systemctl --user enable --now <unit>`; also `loginctl enable-linger $USER` so it survives logout). A server started from the agent's own shell dies with the agent; the service is what makes it last.

8. **Verify and report.** Wait for the line `dsh web: http://127.0.0.1:<PORT>/?token=…` in `server.log`. Opening that URL must sign in (HTTP 303 with a `dsh-auth-` cookie), and the log must not contain `did not activate`; if it does, report the named plugins as not working. Give the user the link and tell them it is a password: anyone who opens it gets an agent with the server's permissions until the next restart. Opening it signs that browser in for 30 days; after a restart, read the new link from the end of `server.log`.

## Reaching it from other devices

The server binds to `127.0.0.1` only. To open it from a phone or another computer, put a private proxy in front of it, such as `tailscale serve --bg --https=<PORT+100> http://127.0.0.1:<PORT>`, and add `--trusted-host <your-machine's-DNS-name>:<PORT+100>` to the launch command, or the UI loads but every API call is refused. Never use a public tunnel: the link grants an agent with full access to the machine.
