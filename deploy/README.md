# deploy/

systemd **user** units for running Hem on an always-on box (the
`hermes.shsin.blog` deployment). Nothing here is needed on a laptop:
`bash start.sh` still starts Hermes itself when these units are not installed.

| file | what it is |
| --- | --- |
| `hermes-backend.service` | `hermes serve` on `127.0.0.1:9119`, on its own. `Restart=always`, 60s stop timeout, and the computer-use display env (cua-driver is a child of `hermes serve`). |
| `hermes-backend.sh` | its `ExecStart`: loads `.env` + `ENV_FILE`, exports `HERMES_TOKEN` as `HERMES_DASHBOARD_SESSION_TOKEN`, rotates `.logs/hermes-serve.log`, `exec`s hermes. |
| `hermes-webapp.service` | the proxy only: `start.sh` with `ENV_FILE=.env.public`, `SKIP_BUILD=1`, which execs `node --import tsx src/index.ts`. `Wants=`/`After=hermes-backend`, 512M/1G memory caps. |
| `install.sh` | copies both units into `~/.config/systemd/user/`, writes per-machine `override.conf`s, ensures `HERMES_TOKEN` in `.env`, `daemon-reload` + `enable`. Starts/restarts nothing. |

**Why two units.** `start.sh` used to `nohup hermes serve &` from inside
`hermes-webapp.service`, so Hermes lived in the proxy's cgroup: every proxy
restart, deploy or crash SIGTERMed the agent mid-turn, and a backend that died
alone was restarted by nothing. Now a proxy restart leaves the backend — and its
running turns — alone; with the backend unit installed, `start.sh` only ever
`systemctl --user start`s it and waits for health.

**Per-machine settings** go in `~/.config/systemd/user/<unit>.d/override.conf`
(PATH to node and hermes, `WorkingDirectory`, any display variable that differs).
`install.sh` writes that file only if it does not exist, and keeps a
`.bak.<timestamp>` of any unit copy it replaces, so re-running it (or
`setup_hermes_shsin_blog.sh`, which calls it) never drops a hand edit. Edit with
`systemctl --user edit hermes-backend`, never the copied unit.

**The token must be written down.** The two units start independently, so the
per-run token `start.sh` used to mint cannot reach both. `HERMES_TOKEN` in
`.env` is read by both; `install.sh` generates one if it is missing.

## Migrating the live box (one-time)

```bash
cd ~/code/hermes-webapp
git pull                                   # a tree that has deploy/
# node must be on PATH (nvm loaded) — install.sh bakes its directory into override.conf:
bash deploy/install.sh
systemctl --user cat hermes-backend hermes-webapp    # review, incl. the override.conf drop-ins
bash start.sh --status                     # "! The backend runs inside hermes-webapp.service …"

# When NO turn is running (check the app / Activity):
systemctl --user restart hermes-webapp
```

`install.sh` already ran `daemon-reload` and `enable hermes-backend hermes-webapp`.
The restart stops the old cgroup — **this first restart still kills the old
in-cgroup `hermes serve` once** (with the new 15s stop timeout) — then starts
the proxy, which pulls in `hermes-backend` via `Wants=`, and `start.sh` waits for
it to answer. From here on, proxy restarts no longer touch the agent.

Check it took:

```bash
bash start.sh --status                     # "* hermes-backend.service: active (enabled)", no cgroup warning
systemctl --user status hermes-backend hermes-webapp --no-pager
systemd-cgls --user-unit hermes-webapp     # node (+ its esbuild service) only — no python
systemctl --user show hermes-backend -p ActiveEnterTimestamp
systemctl --user restart hermes-webapp
systemctl --user show hermes-backend -p ActiveEnterTimestamp   # unchanged
```

Logs: `journalctl --user -u hermes-webapp -f` (proxy),
`tail -f .logs/hermes-serve.log` (Hermes; the journal for `hermes-backend` holds
only the wrapper's own lines — start, token/port problems).

## Day to day

```bash
pnpm build && systemctl --user restart hermes-webapp   # deploy app code — turns survive
systemctl --user restart hermes-backend                # restart the agent — ends running turns
```

## Rolling back

```bash
cd ~/.config/systemd/user
systemctl --user disable --now hermes-backend          # stops the agent: ends running turns
cp hermes-webapp.service.bak.<timestamp> hermes-webapp.service   # the copy install.sh kept
rm -f hermes-backend.service
rm -rf hermes-backend.service.d hermes-webapp.service.d
systemctl --user daemon-reload
systemctl --user restart hermes-webapp
```

With no `hermes-backend.service` installed, `start.sh` falls back to launching
`hermes serve` itself (inside `hermes-webapp`, i.e. the old behaviour), so the
code needs no rollback for this. For the old proxy command line as well
(`pnpm --filter @hem/server start`), check out the previous `start.sh`.
