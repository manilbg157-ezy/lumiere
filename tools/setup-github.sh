#!/usr/bin/env bash
# One-time setup for pushing this repository to GitHub.
#
#   npm run setup:github
#
# You will be asked for a Personal Access Token — the only thing `npm run sync`
# cannot do for you, because it is your GitHub password and belongs to you.
# Create one at https://github.com/settings/tokens (classic token, `repo` scope,
# or a fine-grained token with "Contents: read and write" on the lumiere repo).
#
# The token is stored on this machine only, in ~/.git-credentials, by git's
# own credential helper. It never enters the repository, so it can never be
# committed or pushed by accident. Everything it allows can be revoked at any
# time on the same GitHub settings page.
#
# Run this once; afterwards `npm run sync` pushes without asking again.
#
# In a shell where nothing can be typed into a prompt (a web command runner,
# CI, a cron job), pass the token instead of pasting it:
#
#   GH_TOKEN=<paste-your-token> npm run setup:github
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d .git ]; then
  echo "This folder is not a git repository yet. Run: git init -b main" >&2
  exit 1
fi

remote="$(git remote get-url origin 2>/dev/null || true)"
if [ -z "$remote" ]; then
  echo "No 'origin' remote yet. Point this repository at GitHub first:

  git remote add origin https://github.com/<your-account>/lumiere.git

Then run this again." >&2
  exit 1
fi
echo "Remote: $remote"

if printf 'protocol=https\nhost=github.com\n' \
     | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null \
     | grep -q '^password='; then
  echo "A GitHub token is already stored; it will be REPLACED by the new one.
(Handy when a token lacked the 'repo' scope, or when rotating tokens.)"
  replacing=1
fi

token="${GH_TOKEN:-}"
if [ -z "$token" ] && [ ! -t 0 ]; then
  echo "
No terminal is attached, so the token cannot be asked for here. Either open a
real shell (SSH) in the project folder and run 'npm run setup:github' again,
or pass the token once on the command line:

  GH_TOKEN=<paste-your-token> npm run setup:github" >&2
  exit 1
fi

if [ -z "$token" ]; then
  echo "
Create a token at https://github.com/settings/tokens (tick 'repo'), then paste
it below. Input is hidden, as a password would be."
  printf 'Token: '
  read -r token
fi
if [ -z "$token" ]; then
  echo "No token given — nothing stored." >&2
  exit 1
fi

helper="$(git config --get credential.helper || true)"
if [ "$helper" != "store" ]; then
  git config --global credential.helper store
  echo "Set git's credential helper to 'store' (that is what saves the token)."
fi

# The credential is stored per host. GitHub accepts the account name as the
# username when the password is a Personal Access Token.
path="${remote#*github.com/}"
path="${path%.git}"
owner="${path%%/*}"
printf 'protocol=https\nhost=github.com\nusername=%s\npassword=%s\n' \
  "$owner" "$token" \
  | git credential approve

echo "Token stored. Verifying with GitHub…"
if git ls-remote origin >/dev/null 2>&1; then
  echo "Verified. From now on, 'npm run sync' commits and pushes without asking."
else
  echo "Could not read the remote with that token. If this keeps failing, revoke
the token on GitHub and run 'npm run setup:github' again with a fresh one
(make sure it has the 'repo' scope)." >&2
  exit 1
fi
