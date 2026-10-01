# Single-VM deployment runbook

This is an install template for one Linux VM with one Gather Node process, one local SQLite database, and local media storage. It is not a deployed service or a production-security certification. Use a staging VM first and keep synthetic data until the open release gates in [PRODUCTION_PLAN.md](./PRODUCTION_PLAN.md) are closed.

## Topology and prerequisites

- Linux systemd host, Node.js 22, npm, Caddy 2, `rclone`, and a `gather` system user/group.
- DNS A/AAAA records for the chosen host name pointing to the VM; inbound TCP 80/443 and outbound access to the configured mail/AI providers and backup destination.
- One attached persistent local filesystem mounted for `/var/lib/gather`; SQLite WAL, media, and local backup directories must not be on NFS or other network filesystems.
- One writable application instance only. Do not run a second replica or worker against this SQLite database.
- Card photos are limited to 512 MiB per workspace and 5 GiB total by default (`SCAN_STORAGE_WORKSPACE_LIMIT_BYTES`, `SCAN_STORAGE_TOTAL_LIMIT_BYTES`). Set both to positive whole-byte values sized to the mounted disk, leaving room for SQLite, WAL, backups, releases and operating-system use. These app quotas are not a substitute for a host filesystem quota or disk alerts.
- QR-only scans are limited to 20,000 rows per workspace and 100,000 rows total by default (`QR_SCAN_WORKSPACE_LIMIT_COUNT`, `QR_SCAN_TOTAL_LIMIT_COUNT`). Discarding an unsaved QR-only scan removes its row and releases capacity; saved QR scans remain linked to their people. Size the limits to the VM disk and review a deliberate retention policy before increasing them.
- Text notes are limited transactionally to 16 MiB and 100,000 rows per workspace, and 512 MiB and 500,000 rows service-wide (`NOTE_STORAGE_WORKSPACE_LIMIT_BYTES`, `NOTE_STORAGE_TOTAL_LIMIT_BYTES`, `NOTE_COUNT_WORKSPACE_LIMIT`, `NOTE_COUNT_TOTAL_LIMIT`). Each accepted note also creates an audit row. Note creation is additionally rate-limited to 120 saves per member per hour in production. Size the limits to the persistent disk and maintain host-level disk alerts; application quotas do not replace filesystem quotas or backups.
- Follow-up and meeting rows (including closed records) are limited transactionally to 25,000 per workspace and 100,000 service-wide (`TASK_COUNT_WORKSPACE_LIMIT`, `TASK_COUNT_TOTAL_LIMIT`). Each accepted row also creates an audit record in the same transaction. Production task creation is additionally limited to 120 saves per member per hour; the per-process burst window resets on restart and assumes the documented single-process deployment. A dedicated test-only low-limit journey verifies HTTP 429 and per-member isolation. These are row-count limits, not a database-byte guarantee; maintain host-level disk alerts, a deliberate record-retention policy, and backups.
- Voice recordings are limited to 256 MiB per workspace and 5 GiB total by default (`VOICE_STORAGE_WORKSPACE_LIMIT_BYTES`, `VOICE_STORAGE_TOTAL_LIMIT_BYTES`). Set both to positive whole-byte values sized to the mounted disk, leaving room for SQLite, WAL, backups, releases and operating-system use. The total is enforced transactionally across all workspaces but is not a substitute for a host filesystem quota or disk alerts.
- Voice-note creation is additionally capped for the lifetime of the service at 25,000 per workspace and 100,000 service-wide (`VOICE_NOTE_COUNT_WORKSPACE_LIMIT`, `VOICE_NOTE_COUNT_TOTAL_LIMIT`); deletion does not replenish these counters. User-entered transcript text is capped in aggregate at 16 MiB per workspace and 512 MiB service-wide (`VOICE_TRANSCRIPT_WORKSPACE_LIMIT_BYTES`, `VOICE_TRANSCRIPT_TOTAL_LIMIT_BYTES`). These counters/limits reduce database amplification, but they do not guarantee host disk capacity or replace backup and retention planning. `npm run test:voice-quota` covers the count, transcript and deletion boundaries locally.
- An off-VM object-storage destination configured in rclone. For confidentiality at rest, the configured remote must be an rclone `crypt` remote or use equivalent provider-side encryption with separately controlled keys. Configure remote lifecycle/retention and a separate alert for backup failures and storage capacity.

## Install a staging release

1. Create the service account and private data directories; the service user must own the data tree, and other users must not be able to read it:

   ```sh
   sudo useradd --system --home-dir /var/lib/gather --create-home --shell /usr/sbin/nologin gather
   sudo install -d -o gather -g gather -m 0700 /var/lib/gather/database /var/lib/gather/uploads /var/lib/gather/backups /var/lib/gather/.config/rclone
   sudo install -d -o root -g gather -m 0750 /etc/gather
   ```

2. Install the built release at `/opt/gather/current`. Build on the target Linux distribution (native SQLite and Argon2 packages must match the VM):

   ```sh
   sudo install -d -o root -g gather -m 0750 /opt/gather/current
   cd /opt/gather/current
   sudo -u gather git clone <your-reviewed-repository-url> .
   sudo -u gather npm ci
   sudo -u gather npm run build
   ```

   Pin the release to a reviewed commit. For later releases, stage a new versioned directory, install and build it, run the checks below, then atomically switch `/opt/gather/current` and restart the service. Keep the prior release available for rollback. Do not copy a Windows `node_modules` directory onto Linux.

3. Copy `ops/gather.env.example` to `/etc/gather/gather.env`; fill in the production origin and provider values only when those providers are configured. Keep `AI_MODE=off` by default. Only set `AI_MODE=provider` after explicitly approving card and CRM-context transfer to Anthropic and validating the provider key/model in staging. The server requires both provider mode and a key before any AI call. Production sign-up refuses account creation unless SMTP and a canonical HTTPS origin are configured, then requires one-time email verification before sign-in. Existing and new email addresses receive the same public signup response in this mode. Install the environment file `root:gather`, mode `0640`. Do not use the demo seed password or expose public sign-up until the verification and password-recovery flows have been exercised through the staging mail provider.

4. Configure an rclone crypt remote interactively as user `gather`; keep its config readable only by that user (`0600`). Copy `ops/backup.env.example` to `/etc/gather/backup.env`, set the actual remote path and local retention, then install it as `root:gather`, mode `0640`. Test remote read/write and download verification with synthetic data before enabling the timer.

5. Install the service and proxy templates, replacing `gather.example.com` with the exact DNS name:

   ```sh
   sudo install -o root -g root -m 0644 ops/systemd/gather.service /etc/systemd/system/gather.service
   sudo install -o root -g root -m 0644 ops/systemd/gather-backup.service /etc/systemd/system/gather-backup.service
   sudo install -o root -g root -m 0644 ops/systemd/gather-backup.timer /etc/systemd/system/gather-backup.timer
   sudo install -o root -g root -m 0750 ops/bin/gather-backup /usr/local/sbin/gather-backup
   sudo install -o root -g root -m 0644 ops/caddy/Caddyfile /etc/caddy/Caddyfile
   sudo systemctl daemon-reload
   sudo systemctl enable --now gather.service caddy.service
   ```

6. Confirm service state and external HTTPS health before entering real data:

   ```sh
   sudo systemctl --no-pager --full status gather.service caddy.service
   curl --fail --show-error https://gather.example.com/api/health
   curl --fail --show-error -I https://gather.example.com/scan
   ```

   Check browser camera capture over HTTPS, cookie settings, sign-in, and a manual lead save. Review systemd and Caddy logs for errors and ensure they contain no card images, email bodies, transcript text, or secrets. The health endpoint is a process health response, not proof that SMTP, OCR, backups, or all dependencies are healthy.

## Daily backup and restore

The supplied timer runs at about 03:17 local VM time with up to five minutes of jitter and catches up after downtime. The root-owned oneshot stops the single app service only while SQLite and the media tree are copied, then restarts it before the potentially long off-VM transfer and checksum download. It serializes runs with `flock`, uploads the completed bundle, downloads/checks every file using `rclone check --download`, and only then prunes local bundles older than the configured newest N. Remote backups are not deleted by this script; enforce retention in the object-storage lifecycle policy and alert on failures.

Enable after a successful manual test:

```sh
sudo systemctl start gather-backup.service
sudo journalctl -u gather-backup.service --since today --no-pager
sudo systemctl enable --now gather-backup.timer
sudo systemctl list-timers gather-backup.timer
```

The brief local snapshot creates a planned capture outage. Record its measured duration, and schedule it during low traffic. Before restoring, stop Gather and follow the integrity-checking restore command in the project README into an isolated path first. A restore drill must verify database integrity, media checksums and readable sample media; practice traffic cutover and rollback on staging. Never test restoration over the active database. This runbook does not provision, test, or monitor an actual VM, DNS zone, SMTP account, AI key, offsite bucket, encryption keys, alerts, or restore exercise.

## Release and rollback gate

Before a real-data release, rehearse a backup, clean stop, schema migration, service restart, health check, one full browser capture journey, and rollback on a separate staging VM. Confirm the backup timer resumed after reboot, an offsite bundle can be retrieved using separately controlled credentials, remote retention is active, and an operator received a failure alert. One app process is a deliberate SQLite constraint, not horizontal scaling. Production customer use remains blocked until the product, provider, identity lifecycle, privacy, accessibility, recovery, monitoring, and independent review gates in the plan are complete.
