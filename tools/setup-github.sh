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

if grep -qs 'github.com' "$HOME/.git-credentials" 2>/dev/null; then
  echo "A stored GitHub credential already exists. Nothing to do — try 'npm run sync'."
  exit 0
fi

if [ ! -t 0 ]; then
  echo "
No terminal is attached, so the token cannot be asked for here.
Open a shell in the project folder and run it yourself:

  npm run setup:github" >&2
  exit 1
fi

echo "
Create a token at https://github.com/settings/tokens (tick 'repo'), then paste
it below. Input is hidden, as a password would be."
printf 'Token: '
read -r token
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
