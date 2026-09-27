# Avatar storage & the rclone mirror

Signed-in visitors can upload a profile photo (JPEG or PNG) from **My Home**.
The app writes the image to a plain directory on disk and serves it back from
there. On the production AlwaysData host that directory is mirrored to Google
Drive with `rclone sync`, because FUSE is not available there.

```
browser ──POST /api/auth/avatar──▶  /api/auth/avatar  ──writes──▶  $AVATAR_DIR/<hmac(email)>.<jpg|png>
                                          │                                  │
                                          └──serves GET /api/auth/avatar/<file>       │
                                                                                      ▼
                                                     tools/avatar-sync.sh  (every 10 min)
                                                       rclone sync $AVATAR_DIR gdrive:avatars
```

## 1. What the app stores

* One file per account, named `<HMAC-SHA256(master key, email)>.<jpg|png>`.
  The stem is derived from the account, never supplied by the client, so a
  filename leaks nothing and cannot be enumerated. It is **stable across
  restarts** as long as the data master key is unchanged.
* Uploads are validated by **magic bytes**, not the `Content-Type` header. Only
  PNG (`89 50 4E 47 …`) and JPEG (`FF D8 FF`) are accepted; anything else is a
  `415`. The size cap defaults to **2 MB**.
* Replacing a photo deletes the other extension's file first, so a PNG↔JPEG swap
  never leaves a stale file for `rclone sync` to keep mirroring.
* Removing a photo from My Home unlinks the file and clears the record.
* `GET /api/auth/avatar/<file>` is public (the filename is an unguessable
  pseudonym) and cacheable for an hour; the URL carries `?v=<timestamp>` so a
  replaced photo busts caches without the filename changing.

## 2. Configuration (AlwaysData panel → Web ▸ Sites ▸ Environment)

| Variable | Default | Meaning |
|---|---|---|
| `AVATAR_DIR` | `<data dir>/avatars` | Local directory the app writes/serves. Set to `/home/lumiere/lumiere/avatars` on the host. |
| `MAX_AVATAR_BYTES` | `2097152` | Upload size cap (1 KB – 20 MB). |
| `AVATAR_UPLOADS_PER_IP_HOUR` | `40` | Per-visitor upload rate limit. |
| `AVATAR_UPLOADS_PER_SITE_HOUR` | `400` | Site-wide upload ceiling. |

The app creates `AVATAR_DIR` (mode `0700`) on first upload, and writes each file
mode `0600`.

## 3. rclone: install and configure the remote

rclone is a single static binary, so it can live in your home directory.

```bash
mkdir -p ~/bin
cd ~/bin
# Grab the linux-amd64 static build (adjust for the host's architecture):
curl -LO https://downloads.rclone.org/rclone-current-linux-amd64.zip
unzip rclone-current-linux-amd64.zip
cp rclone-*-linux-amd64/rclone ~/bin/rclone
chmod 755 ~/bin/rclone
~/bin/rclone version
```

On AlwaysData, make sure `~/bin` is on `PATH` for scheduled services, or set
`RCLONE_BIN=/home/lumiere/bin/rclone` for the sync script.

### Authorising Google Drive

The browser-based `rclone config` cannot open a browser on a headless host.
The reliable path is to authorise on a machine that **does** have a browser and
copy the token over:

1. On your own computer, run `rclone config`, create a remote named
   **`gdrive`** of type **`drive`**, and complete the OAuth flow.
2. On the AlwaysData host, run `rclone config` and create a remote also named
   **`gdrive`**. When it asks for authorisation, choose the option to paste a
   token, then on your own machine run:

   ```bash
   rclone authorize "drive"
   ```

   and paste the resulting token block into the headless `rclone config`.
3. Verify from the host:

   ```bash
   rclone lsd gdrive:          # lists your Drive folders
   rclone mkdir gdrive:avatars # the folder the script writes into
   ```

The remote name must match `RCLONE_REMOTE` (default `gdrive:avatars`). The
Google Drive folder is literally called `avatars`.

## 4. The sync script

`tools/avatar-sync.sh` performs exactly one one-way sync:

```bash
rclone sync "$AVATAR_DIR" "$RCLONE_REMOTE" --create-empty-src-dirs ...
```

It takes a lock so two runs cannot overlap, rotates its log, and exits with
rclone's own status code. **`rclone sync` makes the destination match the source
exactly** — a file deleted from `$AVATAR_DIR` is deleted from Drive too, which is
the intended behaviour for this feature. Run it manually once and check the
output before letting a scheduler near it:

```bash
AVATAR_DIR=/home/lumiere/lumiere/avatars RCLONE_REMOTE=gdrive:avatars \
  bash tools/avatar-sync.sh

# Then confirm what would move, without moving it:
rclone sync /home/lumiere/lumiere/avatars gdrive:avatars --dry-run -v
```

## 5. Schedule it every 10 minutes on AlwaysData

In the AlwaysData admin panel go to **Advanced ▸ Scheduled tasks** (the services
panel) and create a task:

* **Command:** `/bin/bash /home/lumiere/lumiere/tools/avatar-sync.sh`
* **Period:** every 10 minutes
* **Environment:** if the panel does not inherit your shell environment, pass the
  variables inline:

  ```bash
  AVATAR_DIR=/home/lumiere/lumiere/avatars RCLONE_REMOTE=gdrive:avatars \
    RCLONE_BIN=/home/lumiere/bin/rclone \
    /bin/bash /home/lumiere/lumiere/tools/avatar-sync.sh
  ```

The log lands at `$(dirname "$AVATAR_DIR")/avatar-sync.log` (i.e.
`/home/lumiere/lumiere/avatar-sync.log`) unless `AVATAR_SYNC_LOG` says otherwise.

## 6. If the local directory is ever wiped

Because the app treats **local disk as the source of truth**, a fresh host (or a
cleared `AVATAR_DIR`) has no avatars until they are pulled back. Restore them
from Drive with a one-way copy — not `sync`, which would otherwise delete Drive's
copies:

```bash
rclone copy gdrive:avatars /home/lumiere/lumiere/avatars -v
```

The account records keep only the extension, so as long as the data master key
(and therefore the filename stem) is unchanged, the restored files line up with
their owners automatically. **If `WAMPYSU_MASTER_KEY` / `data/.wampysu-key`
changes, every stem changes and the restored files will no longer be found** —
back that key up.
