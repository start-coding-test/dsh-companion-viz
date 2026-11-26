#!/bin/sh
# Usage: scripts/snapshot.sh /path/to/production.db [/path/to/snapshot.db]
set -eu
umask 077
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || { echo "Usage: $0 SOURCE_DB [SNAPSHOT_DB]" >&2; exit 2; }
src=$1
dst=${2:-${VIZ_SNAPSHOT:-./data/snapshot.db}}
[ -f "$src" ] || { echo 'Source database not found' >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo 'sqlite3 CLI required' >&2; exit 1; }
mkdir -p "$(dirname "$dst")"
src_abs=$(realpath "$src"); dst_abs=$(realpath -m "$dst")
[ "$src_abs" != "$dst_abs" ] || { echo 'Source and snapshot must differ' >&2; exit 1; }
lock="${dst}.lock"
mkdir "$lock" 2>/dev/null || { echo 'Snapshot already running' >&2; exit 1; }
tmp=''
cleanup() { [ -z "$tmp" ] || rm -f "$tmp"; rmdir "$lock"; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -f "$dst" ]; then
  now=$(date +%s); modified=$(stat -c %Y "$dst")
  if [ $((now - modified)) -lt 600 ]; then echo 'Snapshot is less than 10 minutes old; skipped.'; exit 0; fi
fi
# mktemp reserves a name in the destination directory; VACUUM INTO requires it not exist.
tmp=$(mktemp "${dst}.tmp.XXXXXXXX"); rm -f "$tmp"
quoted=$(printf '%s' "$tmp" | sed "s/'/''/g")
sqlite3 -readonly "$src" "VACUUM INTO '$quoted';"
mv -f -- "$tmp" "$dst"
tmp=''
echo "Snapshot refreshed: $dst"
