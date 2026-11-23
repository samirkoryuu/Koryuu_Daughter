#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: koryuu-deploy <release-archive> <40-character-commit-sha>" >&2
  exit 2
fi

archive=$1
commit=$2

if [[ ! $commit =~ ^[0-9a-f]{40}$ ]]; then
  echo "Invalid commit SHA" >&2
  exit 2
fi

if [[ ! -f $archive ]]; then
  echo "Release archive not found: $archive" >&2
  exit 1
fi

trap 'rm -f -- "$archive"' EXIT

base=/opt/koryuu
release="$base/releases/$commit"
previous=$(readlink "$base/current" || true)

mkdir -p "$release"
tar --no-same-owner -xzf "$archive" -C "$release"
chown -R koryuu:koryuu "$release"
runuser -u koryuu -- bash -c 'cd "$1" && npm ci' _ "$release"

rm -f "$base/current.next"
ln -s "$release" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"

if ! systemctl restart koryuu-gateway.service ||
  ! systemctl is-active --quiet koryuu-gateway.service; then
  echo "Gateway did not start; restoring the previous release" >&2
  if [[ -n $previous ]]; then
    rm -f "$base/current.rollback"
    ln -s "$previous" "$base/current.rollback"
    mv -Tf "$base/current.rollback" "$base/current"
    systemctl restart koryuu-gateway.service
  else
    rm -f "$base/current"
  fi
  exit 1
fi

echo "Deployed Koryuu Gateway commit $commit"
