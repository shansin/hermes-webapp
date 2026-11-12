# deploy/

systemd **user** units for running Hem on an always-on box (the
`hermes.shsin.blog` deployment). Nothing here is needed on a laptop:
`bash start.sh` still starts Hermes itself when these units are not installed.

| file | what it is |
| --- | --- |
| `hermes-serve.service` | `hermes serve` on `127.0.0.1:9119`, on its own. `Restart=always` (30s apart), 60s stop timeout, and the computer-use display env (cua-driver is a child of `hermes serve`). |
| `hermes-serve.sh` | its `ExecStart`: loads `.env` + `ENV_FILE`, exports `HERMES_TOKEN` as `HERMES_DASHBOARD_SESSION_TOKEN`, waits up to 2 min for a port someone else holds, rotates `.logs/hermes-serve.log`, `exec`s hermes. |
| `hermes-webapp.service` | the proxy only: `start.sh` with `ENV_FILE=.env.public`, `SKIP_BUILD=1`, which execs `node --import tsx src/index.ts`. `Wants=`/`After=hermes-serve`, 512M/1.5G memory caps. |
| `install.sh` | copies both units into `~/.config/systemd/user/`, writes per-machine `override.conf`s, ensures `HERMES_TOKEN` in `.env`, `daemon-reload` + `enable` — but no reload while the pre-split layout runs (below). Starts/restarts nothing. |

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
`systemctl --user edit hermes-serve`, never the copied unit.

**Why `hermes-serve`.** It is Hermes' own name for a unit-managed `hermes serve`,
and `hermes update` acts on it: once the new code is on disk it restarts every
active user unit named `hermes-serve*` (`systemctl --user reset-failed` +
`restart` — `hermes_cli/update_cmd_fleet.py`, the `_LIST_GATEWAY_UNITS` listing
and `_restart_one_systemd_gateway_unit`), and its abort recovery relaunches the
same family (`update_restart_recovery.py`). It reads the unit file but never
rewrites a user unit: `_repair_unit_without_fatal_exit_park` only checks for
`RestartPreventExitStatus=78` and prints a hint when it is missing. So after
`hermes update` there is nothing to do by hand — the restarted wrapper re-reads
`.env`, so the token still matches the proxy's. (Under another name the update's
stale-backend sweep still got to it — killing the PID, then restarting whatever
unit its cgroup named — but outside the fleet pass and its report.)

**The token must be written down.** The two units start independently, so the
per-run token `start.sh` used to mint cannot reach both. `HERMES_TOKEN` in
`.env` is read by both; `install.sh` generates one if it is missing.

## Migrating the live box (one-time)

On the live box Hermes still runs inside `hermes-webapp.service`'s cgroup
(`bash start.sh --status`: "The backend runs inside hermes-webapp.service").
That is why this is two steps.

```bash
cd ~/code/hermes-webapp
git pull                                   # a tree that has deploy/
pnpm install --frozen-lockfile && pnpm build   # deps moved (hono's node server, zod) — the
                                               # running proxy is unaffected until restarted
# node must be on PATH (nvm loaded) — install.sh bakes its directory into override.conf:
bash deploy/install.sh                     # copies + enables; NO daemon-reload (see below)
systemctl --user cat hermes-serve hermes-webapp      # review, incl. the override.conf drop-ins
```

`install.sh` sees the pre-split layout — the listener on the Hermes port is in
`hermes-webapp.service`'s cgroup — and copies the units and enables them with
`--no-reload`, but does **not** `daemon-reload` (`systemctl enable` reloads
implicitly, hence the flag). A reload applies the new `hermes-webapp` definition
to the *running* cgroup on the spot: memory caps sized for a proxy and a 15s
stop timeout, over a cgroup that still holds `hermes serve`, its MCP servers and
its tools (~900 MB anon+kernel on the live box). That is throttling and OOM kills
mid-turn. `setup_hermes_shsin_blog.sh` makes the same check and skips its own
reload too.

Then, **when no turn is running** (check the app / Activity), run together:

```bash
systemctl --user daemon-reload && systemctl --user restart hermes-webapp
systemctl --user enable --now hermes-serve
```

The reload and restart are chained so the caps hold the old cgroup for
milliseconds, not minutes. The restart stops the old cgroup, which **ends the
old in-cgroup `hermes serve` once** (SIGTERM, SIGKILL after the new 15s), then
starts the proxy, which pulls in `hermes-serve` through `Wants=`. systemd orders
the old unit's stop before the new unit's start, so the backend comes up on a
free port; were it still held, `hermes-serve.sh` waits for it rather than
failing. The last line only confirms: `hermes-serve` is enabled for boot and
already started. From here on, proxy restarts no longer touch the agent.

Check it took:

```bash
bash start.sh --status                     # "* hermes-serve.service: active (enabled)", no cgroup warning
systemctl --user status hermes-serve hermes-webapp --no-pager
systemd-cgls --user-unit hermes-webapp     # node (+ its esbuild service) only — no python
systemctl --user show hermes-webapp -p MemoryHigh -p MemoryMax   # 512M / 1.5G
systemctl --user show hermes-serve -p ActiveEnterTimestamp
systemctl --user restart hermes-webapp
systemctl --user show hermes-serve -p ActiveEnterTimestamp   # unchanged
```

Logs: `journalctl --user -u hermes-webapp -f` (proxy),
`tail -f .logs/hermes-serve.log` (Hermes; the journal for `hermes-serve` holds
only the wrapper's own lines — start, token/port problems).

## Day to day

```bash
git pull && pnpm install --frozen-lockfile && pnpm build \
  && systemctl --user restart hermes-webapp      # deploy app code — turns survive
systemctl --user restart hermes-serve            # restart the agent — ends running turns
```

The proxy runs from source, so `node_modules` is its runtime: skip the install
after a dependency moved and the restart boots new code against old packages.
`start.sh` notices a lockfile newer than `node_modules/.modules.yaml` and runs
`pnpm install --frozen-lockfile` itself, even with `SKIP_BUILD=1`, but only as
insurance — it does not rebuild `web/dist`.

`hermes update` restarts `hermes-serve` itself (see *Why `hermes-serve`*).

A backend config error (empty `HERMES_TOKEN`, a missing `ENV_FILE`, no `hermes`
on PATH) exits 78, which the unit does not retry and `start.sh` does not start
again either: the proxy unit dies saying why, every 10s, until the backend is
fixed and `systemctl --user restart hermes-serve` — then it follows on its own.

## Rolling back

```bash
cd ~/.config/systemd/user
systemctl --user disable --now hermes-serve            # stops the agent: ends running turns
cp hermes-webapp.service.bak.<timestamp> hermes-webapp.service   # the copy install.sh kept
rm -f hermes-serve.service
rm -rf hermes-serve.service.d hermes-webapp.service.d
systemctl --user daemon-reload
systemctl --user restart hermes-webapp
```

With no `hermes-serve.service` installed, `start.sh` falls back to launching
`hermes serve` itself (inside `hermes-webapp`, i.e. the old behaviour), so the
code needs no rollback for this. For the old proxy command line as well
(`pnpm --filter @hem/server start`), check out the previous `start.sh`.
