#!/usr/bin/env bash
# Copies status-master to a Docker host over SSH and (re)starts its container there.
#
#   scripts/deploy.sh                       # the host is DEPLOY_HOST in .env
#   HOST=user@dockerhost scripts/deploy.sh
#
# Copies the code, .env (with the host user's uid/gid for the container) and, on the first deploy only,
# .token.json as data/token.json: after that the token rotates on the host and the host's copy is kept.
set -euo pipefail

DIR='~/status-master'
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "no .env here (see .env.example)" >&2; exit 1; }
HOST=${HOST:-$(sed -n 's/^DEPLOY_HOST=//p' .env | tail -n 1)}
[ -n "$HOST" ] || { echo "set DEPLOY_HOST in .env or HOST=user@host" >&2; exit 1; }

echo "==> $HOST: $DIR"
ssh "$HOST" "mkdir -p $DIR/data && chmod 700 $DIR $DIR/data"
uid_gid=$(ssh "$HOST" 'echo "$(id -u) $(id -g)"')
read -r uid gid <<<"$uid_gid"

echo "==> code"
tar czf - Dockerfile compose.yaml .dockerignore .gitignore package.json src README.md CLAUDE.md .env.example |
  ssh "$HOST" "tar xzf - -C $DIR"

echo "==> .env (container user $uid:$gid)"
{
  grep -v -E '^(STATUS_MASTER_[UG]ID|DEPLOY_HOST)=' .env
  printf '\n# Container user = owner of ./data on this host\nSTATUS_MASTER_UID=%s\nSTATUS_MASTER_GID=%s\n' "$uid" "$gid"
} | ssh "$HOST" "umask 077; cat > $DIR/.env"

if ssh "$HOST" "test -s $DIR/data/token.json"; then
  echo "==> token: kept the one on $HOST (it rotates there)"
elif [ -s .token.json ]; then
  echo "==> token: copying .token.json"
  ssh "$HOST" "umask 077; cat > $DIR/data/token.json" <.token.json
else
  echo "no token on $HOST and no .token.json here: run 'npm run login' first" >&2
  exit 1
fi

echo "==> container"
ssh "$HOST" "cd $DIR && docker compose up -d --build && docker compose ps"
