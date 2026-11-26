#!/bin/sh
# Shared by the desktop SSH installer (include_str!) and standalone installation.
# Never steal an existing lock: after transport loss remote completion is unknown.
set -eu
repo=${CC_SWITCH_REMOTE_HELPER_RELEASE_REPO:-${CC_SWITCH_REPO:-PowerDi/cc-switch-remote}}
tag=${1:-${CC_SWITCH_REMOTE_HELPER_RELEASE_TAG:-remote-helper-latest}}
helper_path=${CC_SWITCH_HELPER_PATH:-${CC_SWITCH_BIN_DIR:-$HOME/.local/bin}/${CC_SWITCH_BIN_NAME:-cc-switch-remote-helper}}
mode=${CC_SWITCH_INSTALL_MODE:-download}
required=${CC_SWITCH_REQUIRED_CAPABILITIES:-providers}
fail() { printf 'CC_SWITCH_INSTALL_ERROR:%s\n' "$1" >&2; exit "$2"; }
case "$helper_path" in
  '~/'*) helper_path=$HOME/${helper_path#\~/} ;;
  */*) ;;
  *) helper_path=$(command -v "$helper_path" || printf '%s/.local/bin/%s' "$HOME" "$helper_path") ;;
esac
case "$helper_path" in /*) ;; *) helper_path=$PWD/$helper_path ;; esac
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64|Linux/amd64) asset_os=Linux; asset_arch=x86_64 ;;
  Linux/aarch64|Linux/arm64) asset_os=Linux; asset_arch=arm64 ;;
  Darwin/x86_64|Darwin/arm64|Darwin/aarch64) asset_os=macOS; asset_arch=universal ;;
  *) fail unsupported-platform 66 ;;
esac
helper_dir=$(dirname "$helper_path")
mkdir -p "$helper_dir" || fail install-permission 73
# Do not replace symlinks or special files (including a concurrently replaced target).
[ ! -L "$helper_path" ] || fail install-path 73
[ ! -e "$helper_path" ] || [ -f "$helper_path" ] || fail install-path 73
lock=$helper_path.install-lock
mkdir "$lock" 2>/dev/null || fail install-locked 75
work=
cleanup() {
  [ -z "$work" ] || rm -rf "$work"
  rm -rf "$lock"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
printf '%s\n' preparing > "$lock/phase"
work=$(mktemp -d "$helper_dir/.cc-switch-install.XXXXXX") || fail install-permission 73
stage=$work/helper
# Copy only permissions, not ownership/path changes to the installed binary.
if [ -f "$helper_path" ]; then cp -p "$helper_path" "$stage" || fail install-permission 73; fi
: > "$stage" || fail install-permission 73
fetch() {
  if command -v curl >/dev/null 2>&1; then
    if curl -fsSL --connect-timeout 10 --max-time 45 --speed-limit 1024 --speed-time 15 "$1" -o "$2"; then return 0; else rc=$?; fi
    # Local filesystem failures are not network fallback candidates.
    case "$rc" in 23|26) fail install-permission 73 ;; esac
  fi
  if command -v wget >/dev/null 2>&1; then
    if wget -q -T 15 -t 1 -O "$2" "$1"; then return 0; else rc=$?; fi
    [ "$rc" != 3 ] || fail install-permission 73
  fi
  return 1
}
if [ "$mode" = upload ]; then
  printf '%s\n' receiving > "$lock/phase"
  cat > "$stage" || fail upload-failed 74
else
  printf '%s\n' downloading > "$lock/phase"
  base=https://github.com/$repo/releases/download/$tag
  downloaded=false
  for name in "cc-switch-remote-helper-latest-$asset_os-$asset_arch" "cc-switch-remote-helper-$tag-$asset_os-$asset_arch"; do
    if fetch "$base/$name" "$stage"; then downloaded=true; break; fi
  done
  # This specific exit code is the ONLY signal authorizing local-network fallback.
  [ "$downloaded" = true ] || fail download-failed 69
fi
[ -s "$stage" ] || fail helper-validation 65
if [ ! -f "$helper_path" ]; then chmod 755 "$stage"; fi
[ -x "$stage" ] || fail helper-not-executable 65
printf '%s\n' validating > "$lock/phase"
mkdir "$work/home"
# Older helpers initialize databases even for status. Remove inherited overrides
# and use an empty home; never validate a downloaded binary against real state.
status=$(env -i PATH="$PATH" HOME="$work/home" XDG_CONFIG_HOME="$work/home/.config" CC_SWITCH_TEST_HOME="$work/home" "$stage" --json status) || fail helper-validation 65
# Accept only the known metadata JSON schema, not arbitrary text containing
# "ok" or a capability. Keys may be ordered differently between helper builds.
string='"[A-Za-z0-9_.+-]+"'
array='\["[a-z0-9-]+"(,"[a-z0-9-]+")*\]'
field="(\"(version|platform|arch)\":$string|\"build\":(null|$string)|\"capabilities\":$array)"
data="\"data\":\{$field(,$field)*\}"
envelope="(\"ok\":true|\"error\":null|$data)"
[ "$(printf '%s\n' "$status" | wc -l | tr -d ' ')" = 1 ] || fail helper-protocol 65
printf '%s\n' "$status" | grep -Eq "^\{$envelope(,$envelope)*\}$" || fail helper-protocol 65
# serde rejects duplicate envelope fields; reject duplicates at every level
# before commit, including otherwise-valid JSON with last-key-wins data.
for key in ok data version platform arch capabilities; do
  count=$(printf '%s\n' "$status" | grep -o "\"$key\":" | wc -l | tr -d ' ')
  [ "$count" = 1 ] || fail helper-protocol 65
done
for key in error build; do
  count=$(printf '%s\n' "$status" | grep -o "\"$key\":" | wc -l | tr -d ' ')
  [ "$count" -le 1 ] || fail helper-protocol 65
done
printf '%s\n' "$status" | grep -q '"ok":true' || fail helper-protocol 65
printf '%s\n' "$status" | grep -q '"version":"' || fail helper-protocol 65
for capability in $required; do
  printf '%s\n' "$status" | grep -Eq "\"capabilities\":\[[^]]*\"$capability\"(,|\])" || fail helper-capabilities 65
done
[ ! -L "$helper_path" ] || fail install-path 73
printf '%s\n' committing > "$lock/phase"
# Same filesystem; rename is the sole commit point. Every earlier failure leaves
# the old file/mode/runtime untouched. A lost acknowledgement is NOT a failed commit.
mv -f "$stage" "$helper_path" || fail install-commit 73
# A failure after rename is uncertain to the caller, never a pre-commit error.
printf '%s\n' committed > "$lock/phase" || true
printf '%s\n' "$status"
