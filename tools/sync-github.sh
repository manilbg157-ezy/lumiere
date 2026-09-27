#!/usr/bin/env bash
# Sync this working copy to GitHub in one command.
#
#   npm run sync                  # commit whatever changed, then push
#   npm run sync -- "message"     # ...with a commit message of your own
#
# One-time setup, on the machine you push from:
#
#   git remote add origin https://github.com/<your-account>/lumiere.git
#
# The first push asks for a username and a password. The password is a Personal
# Access Token (GitHub stopped accepting account passwords in 2021) — create one
# at https://github.com/settings/tokens with the `repo` scope (or "Contents:
# read and write" on a fine-grained token). To be asked only once:
#
#   git config --global credential.helper store      # osxkeychain on macOS
#
# Nothing here is deploy-related: the site runs from an uploaded `dist/`, not
# from a push. See "Deploying to AlwaysData" in the README.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d .git ]; then
  echo "This folder is not a git repository yet. Run: git init -b main" >&2
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  cat >&2 <<'MSG'
No 'origin' remote yet. Point this repository at GitHub first:

  git remote add origin https://github.com/<your-account>/lumiere.git

Then run this again.
MSG
  exit 1
fi

# .gitignore is the whole story of what never leaves this machine: node_modules/,
# dist/, .env (and every .env.* except the example), data/, accounts/ and
# tracing/ — every one of them holds either secrets or build output or live user
# data. Read it before adding a new kind of file to the project.
git add -A

if git diff --cached --quiet; then
  echo "Nothing to commit — the working copy already matches the last commit."
else
  message="${1:-Sync from the working copy}"
  git commit -m "$message

🤖 Generated with Codebuff
Co-Authored-By: Codebuff <noreply@codebuff.com>"
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
echo "Pushing ${branch} to origin…"
output="$(mktemp)"
if ! git push -u origin "$branch" >"$output" 2>&1; then
  # Diagnose before advising: a missing token, a token without write access
  # and a genuinely refused push all fail here, and each has a different cure.
  if ! printf 'protocol=https\nhost=github.com\n' \
       | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null \
       | grep -q '^password='; then
    cat >&2 <<'MSG'

GitHub asked for credentials and none are stored on this machine. Run the
one-time setup — it asks for a Personal Access Token and saves it:

  npm run setup:github

then sync again. Create the token at https://github.com/settings/tokens
(tick 'repo').
MSG
  elif grep -q 'Permission to.*denied' "$output"; then
    cat >&2 <<'MSG'

GitHub accepted the token but denied it write access to this repository.
The token exists but is too narrow: a classic token needs the 'repo' scope
ticked, a fine-grained token needs this repo selected with "Contents:
read and write". Fix it at https://github.com/settings/tokens — either edit
the token's scopes, or create a new one and re-store it:

  GH_TOKEN=<new-token> npm run setup:github

(The setup script replaces the stored token.) Then sync again.
MSG
  else
    cat >&2 <<MSG

The push was refused. That usually means the repository on GitHub has commits
this copy does not (it was edited elsewhere, or a README was added when the repo
was created). Bring them in and try again:

  git pull --rebase origin ${branch}
  npm run sync
MSG
  fi
  rm -f "$output"
  exit 1
fi
rm -f "$output"

echo "Synced: $(git remote get-url origin | sed 's#\.git$##')"
