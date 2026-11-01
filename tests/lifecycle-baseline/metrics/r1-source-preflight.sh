#!/usr/bin/env bash
# John-operated live metadata inventory only after separate GRE-3269 approval.
set -euo pipefail

read -r -p 'Verified default-instance PostgreSQL port: ' r1_port
read -r -p 'Verified dedicated SELECT-only role: ' r1_role
if [[ ! "$r1_port" =~ ^[0-9]{1,5}$ ]] || (( 10#$r1_port < 1 || 10#$r1_port > 65535 )); then
  echo 'R1 preflight: invalid port' >&2
  exit 1
fi
if [[ ! "$r1_role" =~ ^[a-zA-Z_][a-zA-Z_0-9]*$ ]]; then
  echo 'R1 preflight: invalid role name' >&2
  exit 1
fi
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Everest operator mode (GRE-3269): a 0600 passfile in the run scratch directory, no prompt.
if [[ -n "${R1_PGPASSFILE:-}" ]]; then
  if [[ ! -f "$R1_PGPASSFILE" || -L "$R1_PGPASSFILE" || "$(stat -c '%a' "$R1_PGPASSFILE")" != 600 ]]; then
    echo 'R1 preflight: passfile must be a regular 0600 file' >&2
    exit 1
  fi
  exec env -u PGPASSWORD -u PGSERVICE PGPASSFILE="$R1_PGPASSFILE" \
    psql -h 127.0.0.1 -p "$r1_port" -U "$r1_role" -d paperclip -w -X \
    -v ON_ERROR_STOP=1 -v company_id=34dad57e-b5ad-4a72-9400-9eba645c99f6 \
    -f "$script_dir/r1-source-preflight.sql"
fi
env -u PGPASSWORD -u PGPASSFILE -u PGSERVICE \
  psql -h 127.0.0.1 -p "$r1_port" -U "$r1_role" -d paperclip -W -X \
  -v ON_ERROR_STOP=1 -v company_id=34dad57e-b5ad-4a72-9400-9eba645c99f6 \
  -f "$script_dir/r1-source-preflight.sql"
