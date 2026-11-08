# claude-native: Claude Code on FreeBSD, natively

Anthropic ships no FreeBSD build of Claude Code. This directory installs it
as a native FreeBSD executable, with no Linux compatibility layer, using
only the base system plus `ripgrep`.

## Install

```sh
sh install.sh            # latest release
sh install.sh stable     # stable channel
sh install.sh 2.1.302    # a specific version
```

`install.sh`, `regraft.js` and `bun-ant/` must sit in the same directory. Run as your
own user, not under doas or sudo. If `ripgrep` is missing, the script runs
`pkg install ripgrep` through doas, sudo or su, which needs a terminal.

To update, run the script again. Claude Code's own updater is disabled
(see below).

## How it works

The official `claude` binary is a [Bun](https://bun.sh) single-file
executable: the Bun runtime with Claude Code's JavaScript embedded in an
ELF section (`.bun`). Bun publishes an official FreeBSD build, so the
script:

1. Downloads the official `linux-x64` build and verifies its SHA-256
   against Anthropic's release manifest.
2. Reads which Bun version built it, then downloads that Bun release for
   FreeBSD and verifies it against Bun's `SHASUMS256.txt`.
3. Compiles a one-line program with FreeBSD Bun to get a template
   executable.
4. Runs `regraft.js`, which copies the embedded module table from the Linux
   binary into the template's `.bun` section unchanged (names, loaders and
   encodings), and adds the `bun-ant/` modules (see below).
5. Checks that the result reports the expected version, then installs it
   where the official native installer would.

Claude Code's JavaScript is never modified. What `regraft.js` drops:

- **JavaScriptCore bytecode.** It was built by Anthropic's Linux runtime.
  FreeBSD Bun parses the source instead.
- **Two Linux native addons:** `clipboard-napi.node` (image paste) and
  `audio-capture.node` (voice input). Those features are unavailable.

What `regraft.js` adds: Anthropic runs Claude Code on its own build of Bun,
which has a native `Bun.ant` namespace that stock Bun lacks. One part of it,
`Bun.ant.CellSegmenter`, is required by the terminal renderer: without it,
`claude` hangs before drawing. `bun-ant/` is a JavaScript replacement, made
to match the native class exactly; [CELLSEGMENTER.md](CELLSEGMENTER.md) has
how it works and how it was verified. A small prelude installs it before
Claude Code starts.

The graph format follows Bun v1.4.4,
`src/standalone_graph/StandaloneModuleGraph.rs` and
`src/exe_format/elf.rs`. A future Bun release that changes the format will
make `regraft.js` stop with an error rather than produce a broken binary.

## Files installed

| Path | Contents |
|---|---|
| `~/.local/bin/claude` | symlink to the active version |
| `~/.local/share/claude/versions/<version>` | converted binaries |
| `~/.local/share/claude/freebsd/bun-<v>/` | cached FreeBSD Bun and template |
| `~/.local/share/claude/freebsd/regraft.js` | copy of the converter |
| `~/.local/share/claude/freebsd/bun-ant/` | copy of the Bun.ant replacement |

Settings added to the `env` block of `~/.claude/settings.json`:

| Variable | Why |
|---|---|
| `USE_BUILTIN_RIPGREP=0` | Anthropic's runtime has ripgrep built in; stock Bun does not, so use the system `rg` |
| `DISABLE_UPDATES=1` | Claude Code's updater (and `claude update`) would install the Linux build |

## Known gaps

- Image paste and voice input do not work (Linux-only native addons).
- amd64 only so far.
- Old versions are not pruned from `versions/` (about 170 MB each).
- Right-to-left text is not reordered in Windows Terminal and VS Code
  terminals (see CELLSEGMENTER.md).

## Directory layout

| Path | Purpose |
|---|---|
| `install.sh` | the installer (POSIX sh, base tools only) |
| `regraft.js` | moves the module graph onto FreeBSD Bun, adds `bun-ant/` |
| `bun-ant/` | JavaScript replacement for `Bun.ant.CellSegmenter` |
| `tools/gen-fused-data.py` | regenerates `bun-ant/fused-data.js` from Bun's tables |
| `tools/oracle.py` | grafts test JavaScript onto Anthropic's Linux runtime |
| `tools/cellseg-fuzz.js` | differential test against the native class (Linux) |
