#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Rob Kubicki
#
# mk-release.sh -- build the release tarball for claude-native.
#
# Usage: sh mk-release.sh
#
# Writes release/FreeBSD-claude-native.tar.gz. Everything unpacks into
# FreeBSD-claude-native/: install.sh, regraft.js, the bun-ant/ modules that
# regraft.js embeds, LICENSE and README.install. Runs on FreeBSD or Linux.

set -eu

NAME=FreeBSD-claude-native
HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/release/$NAME.tar.gz"

die() {
	echo "mk-release: $*" >&2
	exit 1
}

cd "$HERE"

# The bun-ant/ modules to ship are the ones regraft.js embeds; read its list
# so a module added there cannot be left out of the release.
bun_ant=$(sed -n 's/^for (const f of \[\(.*\)\])$/\1/p' regraft.js | tr -d '",')
[ -n "$bun_ant" ] || die "could not find the bun-ant module list in regraft.js"

for f in install.sh regraft.js LICENSE README.install; do
	[ -f "$f" ] || die "missing $f"
done
for f in $bun_ant; do
	[ -f "bun-ant/$f" ] || die "missing bun-ant/$f (listed in regraft.js)"
done
for f in bun-ant/*.js; do
	case " $bun_ant " in
	*" ${f#bun-ant/} "*) ;;
	*) die "$f is not embedded by regraft.js; add it there or remove it" ;;
	esac
done

# The repository root LICENSE is the original; this copy ships.
if [ -f ../LICENSE ] && ! cmp -s LICENSE ../LICENSE; then
	die "LICENSE differs from ../LICENSE"
fi

sh -n install.sh || die "install.sh has a syntax error"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/mk-release.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# --- stage -------------------------------------------------------------------

stage="$WORK/stage/$NAME"
mkdir -p "$stage/bun-ant"
cp install.sh regraft.js LICENSE README.install "$stage/"
for f in $bun_ant; do
	cp "bun-ant/$f" "$stage/bun-ant/"
done
chmod 755 "$stage" "$stage/bun-ant" "$stage/install.sh"
chmod 644 "$stage/regraft.js" "$stage/LICENSE" "$stage/README.install" \
    "$stage"/bun-ant/*.js

# --- pack --------------------------------------------------------------------

mkdir -p release
tar -czf "$OUT.tmp" -C "$WORK/stage" "$NAME"

# --- check -------------------------------------------------------------------

# Unpack the tarball and compare it with what was staged.
mkdir "$WORK/check"
tar -xzf "$OUT.tmp" -C "$WORK/check"
diff -r "$stage" "$WORK/check/$NAME" >/dev/null ||
    die "unpacked tarball differs from the staged files"
[ -x "$WORK/check/$NAME/install.sh" ] || die "install.sh is not executable in the tarball"

mv "$OUT.tmp" "$OUT"

if command -v sha256 >/dev/null 2>&1; then
	sum=$(sha256 -q "$OUT")
else
	sum=$(sha256sum "$OUT" | cut -d' ' -f1)
fi

echo "Wrote $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
echo "SHA-256 $sum"
echo ""
tar -tzf "$OUT" | sort
