#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Rob Kubicki
#
# install.sh -- install Claude Code natively on FreeBSD.
#
# Anthropic publishes no FreeBSD build. This script downloads the official
# Linux build, verifies it, and moves its JavaScript onto the official
# FreeBSD build of the same Bun runtime (see regraft.js). The result is a
# native FreeBSD executable: no Linux compatibility layer is involved.
# Pieces of Anthropic's runtime that stock Bun lacks (Bun.ant) are supplied
# in JavaScript from bun-ant/.
#
# Usage: sh install.sh [stable|latest|VERSION]
#
# Requires the base system plus four packages Claude Code needs on FreeBSD:
# ripgrep, ugrep, bfs and bash. Any that are missing are installed with pkg
# (asking for root through doas, sudo or su).
#
# Updates: Claude Code's own updater would install the Linux build, so it is
# turned off. Instead this script installs a copy of itself next to the
# runtime and adds a SessionStart hook that runs that copy with --background
# each time claude starts. At most every 8 hours, that starts a detached
# --update run, which installs the newest version of your release channel
# if it is newer than the one installed. The next session shows the result.

set -eu

MODE=install
TARGET=latest
case "${1:-}" in
--background) MODE=background ;;
--update) MODE=update ;;
""|stable|latest|[0-9]*.[0-9]*.[0-9]*) TARGET="${1:-latest}" ;;
*)
	echo "Usage: $0 [stable|latest|VERSION]" >&2
	exit 1
	;;
esac

CLAUDE_BASE_URL="https://downloads.claude.ai/claude-code-releases"
BUN_BASE_URL="https://github.com/oven-sh/bun/releases/download"

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
SELF="$SCRIPT_DIR/$(basename "$0")"
REGRAFT="$SCRIPT_DIR/regraft.js"
BUN_ANT="$SCRIPT_DIR/bun-ant"
SHARE_DIR="$HOME/.local/share/claude"
VERSIONS_DIR="$SHARE_DIR/versions"
NATIVE_DIR="$SHARE_DIR/freebsd"
BIN_DIR="$HOME/.local/bin"
SETTINGS="$HOME/.claude/settings.json"
LOCK_DIR="$NATIVE_DIR/update.lock"
UPDATE_LOG="$NATIVE_DIR/update.log"
UPDATE_NOTICE="$NATIVE_DIR/update-notice"
UPDATE_STAMP="$NATIVE_DIR/update-checked"
CHECK_MINUTES=480
WORK_DIR=""
LOCKED=""

die() {
	echo "Error: $*" >&2
	exit 1
}

cleanup() {
	[ -n "$WORK_DIR" ] && rm -rf "$WORK_DIR"
	[ -n "$LOCKED" ] && rm -rf "$LOCK_DIR"
	return 0
}
trap cleanup EXIT INT TERM

# --- background updates ------------------------------------------------------

# True if version $1 is newer than version $2 (or $2 is empty).
newer() {
	[ "$1" != "$2" ] || return 1
	[ -n "$2" ] || return 0
	[ "$(printf '%s\n%s\n' "$1" "$2" |
	    sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)" = "$1" ]
}

# --background: run by the SessionStart hook. It must return at once and
# print nothing but hook JSON, which Claude Code shows to the user.
if [ "$MODE" = background ]; then
	if [ -s "$UPDATE_NOTICE" ]; then
		msg=$(tr -d '"\\' < "$UPDATE_NOTICE")
		rm -f "$UPDATE_NOTICE"
		printf '{"systemMessage": "%s"}\n' "$msg"
	fi
	[ -d "$NATIVE_DIR" ] || exit 0
	[ -z "$(find "$UPDATE_STAMP" -mmin "-$CHECK_MINUTES" 2>/dev/null)" ] || exit 0
	touch "$UPDATE_STAMP"
	/usr/sbin/daemon -f /bin/sh "$SELF" --update
	exit 0
fi

# --update: the detached check. Installs only a newer version of the
# release channel set in Claude Code's autoUpdatesChannel (default latest).
if [ "$MODE" = update ]; then
	mkdir -p "$NATIVE_DIR"
	if [ -f "$UPDATE_LOG" ]; then
		tail -n 500 "$UPDATE_LOG" > "$UPDATE_LOG.tmp" &&
		    mv -f "$UPDATE_LOG.tmp" "$UPDATE_LOG"
	fi
	exec >> "$UPDATE_LOG" 2>&1 < /dev/null
	echo "--- $(date '+%Y-%m-%d %H:%M:%S') checking for updates"
	channel=$(sed -n 's/.*"autoUpdatesChannel"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' \
	    "$SETTINGS" 2>/dev/null | head -n 1)
	[ "$channel" = stable ] || channel=latest
	current=$(readlink "$BIN_DIR/claude" 2>/dev/null) || current=""
	current=${current##*/}
	available=$(fetch -q -o - "$CLAUDE_BASE_URL/$channel" 2>/dev/null) || available=""
	case "$available" in
	[0-9]*.[0-9]*.[0-9]*) ;;
	*)
		echo "could not get the $channel version; will try again later"
		exit 0
		;;
	esac
	if ! newer "$available" "$current"; then
		echo "up to date: $current ($channel is $available)"
		exit 0
	fi
	echo "updating ${current:-nothing} to $available ($channel)"
	rc=0
	/bin/sh "$SELF" "$available" || rc=$?
	case $rc in
	0)
		echo "Claude Code updated to $available. Restart claude to use it." \
		    > "$UPDATE_NOTICE"
		;;
	75)
		echo "another install or update is running; skipped"
		;;
	*)
		echo "Background update to Claude Code $available failed; see $UPDATE_LOG" \
		    > "$UPDATE_NOTICE"
		;;
	esac
	exit 0
fi

# One install or update at a time. The lock holds the owner's pid; a lock
# whose owner is gone is taken over (an empty one only once it is old).
take_lock() {
	mkdir -p "$NATIVE_DIR"
	if ! mkdir "$LOCK_DIR" 2>/dev/null; then
		pid=$(cat "$LOCK_DIR/pid" 2>/dev/null) || pid=""
		if [ -n "$pid" ]; then
			! kill -0 "$pid" 2>/dev/null || return 1
		else
			[ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +60)" ] || return 1
		fi
		rm -rf "$LOCK_DIR"
		mkdir "$LOCK_DIR" 2>/dev/null || return 1
	fi
	LOCKED=1
	echo $$ > "$LOCK_DIR/pid"
}

# Copy by rename, so a copy of this script that is running is never
# rewritten under it.
install_file() {
	cp "$1" "$2.tmp" && mv -f "$2.tmp" "$2"
}

# --- preflight ---------------------------------------------------------------

# Everything goes under $HOME; under doas or sudo that would be root's home.
if [ "$(id -u)" -eq 0 ] && [ -n "${DOAS_USER:-}${SUDO_USER:-}" ] &&
    [ -z "${CLAUDE_INSTALL_ALLOW_ROOT:-}" ]; then
	die "do not run this installer with doas or sudo; it installs into your" \
	    "home directory. Set CLAUDE_INSTALL_ALLOW_ROOT=1 to install for root."
fi

[ "$(uname -s)" = "FreeBSD" ] || die "this installer is for FreeBSD only"
case "$(uname -m)" in
amd64)
	linux_platform="linux-x64"
	bun_platform="bun-freebsd-x64"
	;;
*)
	die "unsupported architecture: $(uname -m) (only amd64 is supported)"
	;;
esac

for tool in fetch sha256 unzip; do
	command -v "$tool" >/dev/null 2>&1 || die "$tool not found"
done
[ -f "$REGRAFT" ] || die "regraft.js not found next to this script ($REGRAFT)"
for f in embedded-tools.js cellsegmenter.js clusters.js fused-data.js; do
	[ -f "$BUN_ANT/$f" ] || die "bun-ant/$f not found next to this script"
done

# Packages Claude Code needs on FreeBSD:
#   ripgrep, ugrep, bfs -- Anthropic's runtime has rg, ugrep and bfs built in;
#                          ours runs the system copies instead (see
#                          bun-ant/embedded-tools.js)
#   bash                 -- Claude Code runs commands in bash or zsh only
# Installing takes root, so go through doas, sudo or su; pkg asks for
# confirmation itself.
have() {
	command -v "$1" >/dev/null 2>&1 || [ -x "/usr/local/bin/$1" ]
}
as_root() {
	if [ "$(id -u)" -eq 0 ]; then
		"$@"
	elif command -v doas >/dev/null 2>&1; then
		doas "$@"
	elif command -v sudo >/dev/null 2>&1; then
		sudo "$@"
	else
		echo "(enter the root password for su)"
		su root -c "$*"
	fi
}
missing=""
have rg || missing="$missing ripgrep"
have ugrep || missing="$missing ugrep"
have bfs || missing="$missing bfs"
have bash || have zsh || missing="$missing bash"
if [ -n "$missing" ]; then
	echo "Claude Code needs:$missing; installing with pkg..."
	[ -t 0 ] || die "missing packages and no terminal to ask for root;" \
	    "run: pkg install$missing"
	# shellcheck disable=SC2086
	as_root pkg install$missing || die "could not install:$missing"
	for tool in rg ugrep bfs; do
		have "$tool" || die "$tool is still not on PATH after pkg install"
	done
fi

if ! take_lock; then
	echo "Another Claude Code install or update is running; try again later." >&2
	exit 75
fi

WORK_DIR=$(mktemp -d -t claude-install)

# --- helpers -----------------------------------------------------------------

download() {
	fetch -q -o "$2" "$1" || die "download failed: $1"
}

# Print the value of "$2" inside the "$1" object of a manifest on stdin.
# The manifest is flat enough that the platform object has no nested braces.
manifest_field() {
	tr -d '\n\r\t ' |
	    sed -nE "s/.*\"$1\":\{[^{}]*\"$2\":\"?([^\",}]*).*/\1/p"
}

checksum_ok() {
	[ "$(sha256 -q "$1")" = "$2" ]
}

# --- 1. download the official Linux build ------------------------------------

case "$TARGET" in
stable|latest)
	download "$CLAUDE_BASE_URL/$TARGET" "$WORK_DIR/version"
	version=$(cat "$WORK_DIR/version")
	;;
*)
	version="$TARGET"
	;;
esac
case "$version" in
[0-9]*.[0-9]*.[0-9]*) ;;
*) die "could not get a valid version from downloads.claude.ai" ;;
esac
echo "Installing Claude Code $version for FreeBSD..."

download "$CLAUDE_BASE_URL/$version/manifest.json" "$WORK_DIR/manifest.json"
checksum=$(manifest_field "$linux_platform" checksum < "$WORK_DIR/manifest.json")
size=$(manifest_field "$linux_platform" size < "$WORK_DIR/manifest.json")
case "$checksum" in
*[!0-9a-f]*|"") die "$linux_platform not found in the $version manifest" ;;
esac
[ ${#checksum} -eq 64 ] || die "bad checksum in the $version manifest"

linux_bin="$WORK_DIR/claude-linux"
verified=false
# The zstd-compressed download is about a third of the size; zstd is in base.
if command -v zstd >/dev/null 2>&1; then
	download "$CLAUDE_BASE_URL/$version/manifest.zst.json" "$WORK_DIR/manifest.zst.json"
	zst_checksum=$(manifest_field "$linux_platform" checksum < "$WORK_DIR/manifest.zst.json")
	if [ ${#zst_checksum} -eq 64 ]; then
		download "$CLAUDE_BASE_URL/$version/$linux_platform/claude.zst" "$linux_bin.zst"
		if checksum_ok "$linux_bin.zst" "$zst_checksum"; then
			zstd -d -q -c "$linux_bin.zst" | head -c "$size" > "$linux_bin"
			checksum_ok "$linux_bin" "$checksum" && verified=true
		fi
		rm -f "$linux_bin.zst"
	fi
fi
if [ "$verified" = false ]; then
	download "$CLAUDE_BASE_URL/$version/$linux_platform/claude" "$linux_bin"
	checksum_ok "$linux_bin" "$checksum" || die "checksum verification failed"
fi

# --- 2. get the FreeBSD build of the same Bun version ------------------------

# The module graph format is tied to the Bun version that wrote it.
bun_version=$(grep -a -o -m 1 'Bun v[0-9]*\.[0-9]*\.[0-9]*' "$linux_bin" |
    head -n 1 | cut -c6-)
[ -n "$bun_version" ] || die "could not find the Bun version in the Linux build"

bun_dir="$NATIVE_DIR/bun-$bun_version"
bun="$bun_dir/bun"
template="$bun_dir/template"
if [ ! -x "$bun" ]; then
	echo "Fetching Bun $bun_version for FreeBSD..."
	download "$BUN_BASE_URL/bun-v$bun_version/$bun_platform.zip" "$WORK_DIR/bun.zip"
	download "$BUN_BASE_URL/bun-v$bun_version/SHASUMS256.txt" "$WORK_DIR/SHASUMS256.txt"
	bun_checksum=$(awk -v f="$bun_platform.zip" '$2 == f { print $1 }' \
	    "$WORK_DIR/SHASUMS256.txt")
	[ -n "$bun_checksum" ] || die "$bun_platform.zip not in Bun $bun_version checksums"
	checksum_ok "$WORK_DIR/bun.zip" "$bun_checksum" ||
	    die "Bun checksum verification failed"
	unzip -q -o -d "$WORK_DIR" "$WORK_DIR/bun.zip"
	mkdir -p "$bun_dir"
	mv "$WORK_DIR/$bun_platform/bun" "$bun"
	rm -f "$template"
fi

# Any `bun build --compile` output carries the FreeBSD runtime we graft onto.
if [ ! -x "$template" ]; then
	echo 'console.log("template");' > "$WORK_DIR/template.js"
	"$bun" build --compile "$WORK_DIR/template.js" --outfile "$template" \
	    >/dev/null || die "could not build the Bun template"
fi

# --- 3. convert -------------------------------------------------------------

native_bin="$WORK_DIR/claude-freebsd"
"$bun" "$REGRAFT" "$linux_bin" "$template" "$native_bin" ||
    die "conversion failed"
rm -f "$linux_bin"

reported=$("$native_bin" --version 2>/dev/null | cut -d' ' -f1)
[ "$reported" = "$version" ] ||
    die "converted binary reports '$reported', expected $version"

# --- 4. install --------------------------------------------------------------

mkdir -p "$VERSIONS_DIR" "$BIN_DIR"
mv "$native_bin" "$VERSIONS_DIR/$version.tmp"
mv "$VERSIONS_DIR/$version.tmp" "$VERSIONS_DIR/$version"
ln -sfn "$VERSIONS_DIR/$version" "$BIN_DIR/claude"

# Keep the installer and converter with the runtime, for background updates.
install_file "$SELF" "$NATIVE_DIR/install.sh"
install_file "$REGRAFT" "$NATIVE_DIR/regraft.js"
mkdir -p "$NATIVE_DIR/bun-ant"
for f in "$BUN_ANT"/*.js; do
	install_file "$f" "$NATIVE_DIR/bun-ant/${f##*/}"
done

# --- 5. settings -------------------------------------------------------------

# USE_BUILTIN_RIPGREP=0: use the system rg; ours has no built-in ripgrep.
# DISABLE_UPDATES=1: Claude Code's own updater would fetch the Linux build.
# SessionStart hook: background updates (see the top of this file). Added
# once; other hooks are left alone.
mkdir -p "$(dirname "$SETTINGS")"
"$bun" -e '
	const fs = require("fs");
	const [path, command] = process.argv.slice(1);
	let s = {};
	if (fs.existsSync(path))
		s = JSON.parse(fs.readFileSync(path, "utf8"));
	s.env = { ...s.env, USE_BUILTIN_RIPGREP: "0", DISABLE_UPDATES: "1" };
	s.hooks ??= {};
	s.hooks.SessionStart ??= [];
	const ours = (h) => typeof h.command === "string" &&
	    h.command.includes("/freebsd/install.sh") && h.command.includes("--background");
	if (!s.hooks.SessionStart.some((g) => (g.hooks ?? []).some(ours)))
		s.hooks.SessionStart.push({ hooks: [{ type: "command", command }] });
	fs.writeFileSync(path, JSON.stringify(s, null, 2) + "\n");
' "$SETTINGS" "/bin/sh '$NATIVE_DIR/install.sh' --background" ||
    die "could not update $SETTINGS"

# --- 6. desktop extras (optional) --------------------------------------------

# Fonts: Claude Code draws a few symbols that FreeBSD's default fonts lack;
# desktop terminals then show empty boxes. Each package covers some of them:
#   noto-sans-symbols   U+23BF  the connector under each tool call
#   noto-sans-symbols2  U+23F5, U+23F8, U+23FA  mode indicators, bullet
# Only scalable fonts count: VTE-based terminals (xfce4-terminal, GNOME
# Terminal) ignore bitmap fonts such as Misc Fixed.
# Clipboard: Claude Code pastes images (Ctrl+V) by running xclip on X11 or
# wl-paste on Wayland; Linux builds use the same commands, so ours does too.
# Text consoles and remote sessions need neither, so ask first.
has_glyph() {
	[ -n "$(fc-list ":charset=$1:scalable=true" family 2>/dev/null)" ]
}
if [ -t 0 ]; then
	echo ""
	printf "Will you use Claude Code in a terminal on a graphical desktop? [y/N] "
	read -r answer || answer=""
	case "$answer" in
	[Yy]*)
		fonts=""
		if command -v fc-list >/dev/null 2>&1; then
			has_glyph 23bf || fonts="$fonts noto-sans-symbols"
			has_glyph 23f5 && has_glyph 23f8 && has_glyph 23fa ||
			    fonts="$fonts noto-sans-symbols2"
		else
			fonts=" noto-sans-symbols noto-sans-symbols2"
		fi
		clip=""
		if [ -n "${WAYLAND_DISPLAY:-}" ]; then
			have wl-paste || clip=" wl-clipboard"
		else
			have xclip || have wl-paste || clip=" xclip"
		fi
		if [ -n "$fonts$clip" ]; then
			[ -n "$fonts" ] &&
			    echo "Fonts for Claude Code's symbols:$fonts"
			[ -n "$clip" ] &&
			    echo "Clipboard tool for pasting images:$clip"
			# shellcheck disable=SC2086
			if as_root pkg install$fonts$clip; then
				[ -z "$fonts" ] ||
				    echo "Restart your terminal to pick up the new fonts."
			else
				echo "Warning: could not install:$fonts$clip" >&2
			fi
		else
			echo "Your fonts and clipboard tools already cover Claude Code."
		fi
		;;
	esac
fi

echo ""
echo "Claude Code $version installed: $BIN_DIR/claude"
case ":$PATH:" in
*":$BIN_DIR:"*) ;;
*)
	echo ""
	echo "$BIN_DIR is not on your PATH. Add it:"
	echo "  csh/tcsh: set path = ($BIN_DIR \$path)   (in ~/.cshrc)"
	echo "  sh:       export PATH=\"$BIN_DIR:\$PATH\"  (in ~/.profile)"
	;;
esac
echo ""
echo "Updates install in the background when you start claude (checked at"
echo "most every 8 hours). To update now: sh $NATIVE_DIR/install.sh"
