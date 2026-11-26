#!/bin/sh
# Transport-only adapter. Never uses the local desktop state as remote truth.
set -eu
mode=$1
p=$2
case "$p" in
  '~/'*) p=$HOME/${p#\~/} ;;
  */*) ;;
  *)
    name=$p
    p=$(command -v "$name" || true)
    # command -v may ignore non-executable PATH entries. Distinguish those
    # from a missing helper without treating shell aliases/functions as files.
    if [ -z "$p" ]; then
      rest=$PATH
      while :; do
        dir=${rest%%:*}
        if [ -e "${dir:-.}/$name" ]; then p=${dir:-.}/$name; break; fi
        case "$rest" in *:*) rest=${rest#*:} ;; *) break ;; esac
      done
    fi
    ;;
esac
if [ "$mode" = presence ]; then
  if [ -z "$p" ] || [ ! -e "$p" ]; then printf missing
  elif [ ! -f "$p" ] || [ ! -x "$p" ]; then printf not-executable
  else printf executable
  fi
  exit 0
fi
case "$p" in /*) ;; *) p=$PWD/$p ;; esac
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
trap 'exit 130' HUP INT TERM
# Known older fork helpers initialize state before status. Empty HOME + cleaned
# environment isolate their app_paths.json, XDG and config overrides. This is
# configuration isolation, NOT a sandbox for untrusted downloaded executables.
env -i PATH="$PATH" HOME="$work" XDG_CONFIG_HOME="$work/.config" CC_SWITCH_TEST_HOME="$work" "$p" --json status || exit 65
