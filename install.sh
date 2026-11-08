#!/bin/sh
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
# Requires only the base system, plus ripgrep for Claude Code's search
# tools; if ripgrep is missing the script installs it with pkg (asking for
# root through doas, sudo or su). Re-run this script to update.

set -eu

TARGET="${1:-latest}"
case "$TARGET" in
stable|latest) ;;
[0-9]*.[0-9]*.[0-9]*) ;;
*)
	echo "Usage: $0 [stable|latest|VERSION]" >&2
	exit 1
	;;
esac

CLAUDE_BASE_URL="https://downloads.claude.ai/claude-code-releases"
BUN_BASE_URL="https://github.com/oven-sh/bun/releases/download"

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REGRAFT="$SCRIPT_DIR/regraft.js"
BUN_ANT="$SCRIPT_DIR/bun-ant"
SHARE_DIR="$HOME/.local/share/claude"
VERSIONS_DIR="$SHARE_DIR/versions"
NATIVE_DIR="$SHARE_DIR/freebsd"
BIN_DIR="$HOME/.local/bin"
SETTINGS="$HOME/.claude/settings.json"
WORK_DIR=""

die() {
	echo "Error: $*" >&2
	exit 1
}

cleanup() {
	[ -n "$WORK_DIR" ] && rm -rf "$WORK_DIR"
}
trap cleanup EXIT INT TERM

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
for f in cellsegmenter.js clusters.js fused-data.js; do
	[ -f "$BUN_ANT/$f" ] || die "bun-ant/$f not found next to this script"
done

# Claude Code's search tools need ripgrep. Installing it takes root, so go
# through doas, sudo or su; pkg asks for confirmation itself.
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
if ! command -v rg >/dev/null 2>&1; then
	echo "Claude Code needs ripgrep; installing it with pkg..."
	[ -t 0 ] || die "ripgrep is not installed and there is no terminal to" \
	    "ask for root; run: pkg install ripgrep"
	as_root pkg install ripgrep || die "could not install ripgrep"
	command -v rg >/dev/null 2>&1 || die "ripgrep is still not on PATH"
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

# Keep the converter with the runtime so a later update need not find the repo.
cp "$REGRAFT" "$NATIVE_DIR/regraft.js"
mkdir -p "$NATIVE_DIR/bun-ant"
cp "$BUN_ANT"/*.js "$NATIVE_DIR/bun-ant/"

# --- 5. settings -------------------------------------------------------------

# USE_BUILTIN_RIPGREP=0: use the system rg; ours has no built-in ripgrep.
# DISABLE_UPDATES=1: Claude Code's own updater would fetch the Linux build.
mkdir -p "$(dirname "$SETTINGS")"
"$bun" -e '
	const fs = require("fs");
	const path = process.argv[1];
	let s = {};
	if (fs.existsSync(path))
		s = JSON.parse(fs.readFileSync(path, "utf8"));
	s.env = { ...s.env, USE_BUILTIN_RIPGREP: "0", DISABLE_UPDATES: "1" };
	fs.writeFileSync(path, JSON.stringify(s, null, 2) + "\n");
' "$SETTINGS" || die "could not update $SETTINGS"

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
echo "To update later, run this script again."
