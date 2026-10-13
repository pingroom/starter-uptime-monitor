# PingRoom uptime monitor starter

Check an HTTP health endpoint and send a PingRoom alert when it goes down or
recovers. Three consecutive failed checks trigger an outage by default. A
healthy first check is quiet, and repeated checks of the same status do not
create more alerts.

This monitor runs independently of the service it observes. It uses Node.js 22+
and the pinned [`@pingroom/cli` 0.13.0](https://github.com/pingroom/cli).

## Try it offline

Click **Use this template**, or create a repository with GitHub CLI:

```sh
gh repo create YOUR-OWNER/YOUR-REPO --template pingroom/starter-uptime-monitor --private --clone
cd YOUR-REPO
npm ci
npm run demo
npm test
```

The demo simulates healthy checks, a transient failure, a sustained outage, and
recovery. It uses temporary state and an injected sender: no credentials, HTTP
requests, or real pings. Tests use local HTTP servers, including integration
tests with the installed PingRoom CLI. GitHub CI runs them on Node 22 and 24
without secrets.

## Connect your service and phone

1. [Install or open PingRoom](https://pingroom.io/i), sign in, and choose a room
   for service alerts.
2. Run `npm run pair`. Open the claim link, claim the robot, and choose its home
   room and access. Keep the pairing process open until it finishes.
3. Copy `.env.example` to `.env`. Set `HEALTH_URL` to your service's health
   endpoint and `SERVICE_NAME` to a short, recognizable name.
4. Run one check with `npm start`, or keep checking with `npm start -- --loop`.

Pairing saves a dedicated connection in this starter's ignored `.pingroom/`
directory. Set `PINGROOM_HOME` explicitly to use a different directory. Pairing
again replaces the connection in that directory. Alternatively, set both
`PINGROOM_TOKEN` and `PINGROOM_ROOM` in `.env` or the environment. Both values are
required; partial pairs are rejected. Keep these files private.

The monitor loads `.env` from the working directory at startup. Existing
environment variables take precedence. Restart the loop to load changed settings.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HEALTH_URL` | Required | Absolute HTTP(S) endpoint; no embedded username/password or URL fragment |
| `SERVICE_NAME` | `Service` | Name used in alerts, up to 40 characters |
| `FAILURE_THRESHOLD` | `3` | Consecutive failed checks before an outage, 1–100 |
| `CHECK_TIMEOUT_MS` | `5000` | Request deadline, 100–120000 ms |
| `POLL_INTERVAL_MS` | `60000` | Loop delay after a completed check and delivery batch, 1000–86400000 ms |
| `STATE_FILE` | `.monitor/state.json` in this starter | Persistent state path; use an absolute path when scheduling |
| `PINGROOM_HOME` | `.pingroom/` in this starter | Saved CLI connection directory |
| `PINGROOM_TOKEN`, `PINGROOM_ROOM` | Saved connection | Optional complete environment credential pair |

Each check makes one `GET`. Any 2xx response is healthy; other statuses,
connection failures, redirects, and timeouts count as failures. Redirects are
never followed. The monitor does not read response bodies or send the endpoint
URL in an alert. Use a dedicated health endpoint that needs no custom headers.

A successful check resets the failure counter. Once the monitor is down, the
first successful check creates a recovery alert. A service that starts down
still triggers an alert after the configured number of failed checks.

## Persistence and delivery

State is written to a temporary file, synced, then atomically renamed. It stores
the current status, failure counter, a configuration digest, and pending alerts.
It contains no endpoint URL or bearer token. Keep the same state file across
restarts; deleting it loses the previous status and any undelivered alerts.

An alert is queued on disk before delivery. Failed sends remain queued and are
retried on the next run or loop iteration while new health changes are observed.
Delayed alerts are sent in order and show the original UTC observation time, for example:

```text
My service: DOWN at 2026-10-13T10:00:00.000Z (3 failed checks).
My service: RECOVERED at 2026-10-13T10:05:00.000Z.
```

The queue holds at most 100 transitions. When full, the monitor pauses new health
checks and tries to deliver the backlog first. It reports the paused state and
preserves every queued alert. Once delivery works, it resumes checks; changes
that occurred entirely during that pause cannot be reconstructed.

Delivery is not guaranteed exactly once. A crash after PingRoom accepts an alert
but before the queue update reaches disk can cause that alert to be sent again.
Each alert carries a stable `event_id` in its data; the CLI ping endpoint does
not use it to deduplicate sends. Failed or interrupted deliveries can also have
an unknown remote outcome.

Changing the endpoint, service name, failure threshold, request timeout, room,
or token requires an explicit reset. Changing the polling interval does not.
Stop the loop, then run:

```sh
npm start -- --reset-state
npm start -- --loop
```

Reset discards previous status, failure counts, and pending alerts. It makes no
HTTP check and sends no ping. Back up the state first if you need its history.
Corrupt state is left in place and blocks monitoring until restored or reset.

## Run periodically

`npm start` checks once. It exits zero when it records a result, including an
outage, and exits nonzero for setup, persistence, or delivery errors. `--loop`
keeps running after delivery errors and retries after the configured delay.
Ctrl-C stops the loop and releases its lock.

To use your own scheduler, run the one-shot command from this repository's
absolute path. For example, after replacing the paths with your installation:

```cron
* * * * * cd /absolute/path/to/starter-uptime-monitor && /absolute/path/to/node scripts/monitor.mjs >> /absolute/path/to/uptime-monitor.log 2>&1
```

Find the Node path with `command -v node`; verify that it is Node 22 or newer.
The command reads the local `.env` and saved connection; no token goes in the
crontab. This starter does not install or modify a scheduler.

Checks sharing a state file use an exclusive local directory lock. An overlapping
invocation skips its check. Run one scheduler or loop per state file on one
machine; this is not a distributed lock or a multi-host monitor.

An abrupt process kill or power loss can leave `<STATE_FILE>.lock`. Its
`owner.json` records the PID and start time. Verify that the owner and any other
monitor using that state are stopped, then remove only the lock directory.
The monitor never steals a stale lock automatically.

## Adapt it

- [`src/monitor.mjs`](src/monitor.mjs): checks, transition rules, state, queue, and lock.
- [`src/cli.mjs`](src/cli.mjs): timestamped messages and CLI delivery.
- [`src/config.mjs`](src/config.mjs): settings and configuration identity.

For progress reported by a running job, see
[starter-job-progress](https://github.com/pingroom/starter-job-progress). For a
human deployment decision, see
[starter-ci-approval](https://github.com/pingroom/starter-ci-approval).

MIT licensed.
