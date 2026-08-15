#!/bin/sh
set -eu

if [ "${1:-}" = "--version" ]; then
  printf '%s\n' '0.1.0-rc.6'
  exit 0
fi

if [ "${1:-}" != "web" ]; then
  printf '%s\n' 'expected web command' >&2
  exit 2
fi
shift
host=127.0.0.1
port=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) host=$2; shift 2 ;;
    --port) port=$2; shift 2 ;;
    *) shift ;;
  esac
done
test -n "$port"
exec python3 "$(dirname "$0")/dsh-runtime-host.py" "$host" "$port"
