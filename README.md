# claude-native: Claude Code on FreeBSD, natively

Anthropic ships no FreeBSD build of Claude Code. This directory installs it
as a native FreeBSD executable, with no Linux compatibility layer, using
the base system plus four packages: `ripgrep`, `ugrep`, `bfs` and `bash`.

## Install

From the release tarball (see [README.install](README.install)):

```sh
tar -xzf FreeBSD-claude-native.tar.gz -C /tmp
sh /tmp/FreeBSD-claude-native/install.sh
rm -rf /tmp/FreeBSD-claude-native     # the installer keeps its own copy
```

From a checkout of this directory:

```sh
sh install.sh            # latest release
sh install.sh stable     # stable channel
sh install.sh 2.1.302    # a specific version
```

`install.sh`, `regraft.js` and `bun-ant/` must sit in the same directory. Run as your
own user, not under doas or sudo. Any of the four packages that are missing
are installed with `pkg install` through doas, sudo or su, which needs a
terminal.

At the end, the script asks whether you will use Claude Code in a terminal
on a graphical desktop. If you answer yes, it installs whichever of these
are missing:

| Package | Why |
|---|---|
| `noto-sans-symbols` | `⎿` (U+23BF), the connector under each tool call |
| `noto-sans-symbols2` | `⏵` `⏸` `⏺` (U+23F5, U+23F8, U+23FA), mode indicators and bullet |
| `xclip`, or `wl-clipboard` on Wayland | pasting images with Ctrl+V |

Without the fonts, desktop terminals show empty boxes for those symbols;
restart the terminal after installing them. Text consoles and remote
sessions need none of these (Claude Code does not paste images over SSH).

Updates are automatic. When `claude` starts, a `SessionStart` hook checks
(at most every 8 hours) for a newer version of the release channel in
Claude Code's `autoUpdatesChannel` setting (`latest` by default, or
`stable`), and converts and installs it in the background. The next session
shows whether it worked; `~/.local/share/claude/freebsd/update.log` has the
details, and a failed update leaves the installed version alone. To update
right away, run `sh ~/.local/share/claude/freebsd/install.sh`. Claude
Code's own updater stays disabled (see below).

## How it works

[TECHNICAL.md](TECHNICAL.md) covers the design in depth, including how
it compares to running the Linux build under the Linux compatibility layer.

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
- **Two Linux native addons:** `clipboard-napi.node` and
  `audio-capture.node`. Voice input is unavailable. Image paste still
  works: Claude Code reads images from the clipboard by running `xclip` or
  `wl-paste`, not through the addon, which it uses only to copy text (and
  that falls back to `xclip`, `wl-copy`, `xsel` or OSC 52).

What `regraft.js` adds: Anthropic runs Claude Code on its own build of Bun,
which has a native `Bun.ant` namespace that stock Bun lacks. One part of it,
`Bun.ant.CellSegmenter`, is required by the terminal renderer: without it,
`claude` hangs before drawing. `bun-ant/` is a JavaScript replacement, made
to match the native class exactly; [CELLSEGMENTER.md](CELLSEGMENTER.md) has
how it works and how it was verified. A small prelude installs it before
Claude Code starts.

The prelude also stands in for three tools compiled into Anthropic's
runtime: when the binary is started as `rg`, `ugrep` or `bfs`, it runs the
system's copy instead (`bun-ant/embedded-tools.js`). Claude Code depends on
this. It spawns itself as `rg` for its search tools, and its Bash tool
shadows `grep` and `find` with shell functions that run the binary as
`ugrep` and `bfs`. The packages:

| Package | Why |
|---|---|
| `ripgrep`, `ugrep`, `bfs` | stand-ins for the tools built into Anthropic's runtime |
| `bash` | Claude Code runs commands only in bash or zsh, never csh or sh |

The graph format follows Bun v1.4.4,
`src/standalone_graph/StandaloneModuleGraph.rs` and
`src/exe_format/elf.rs`. A future Bun release that changes the format will
make `regraft.js` stop with an error rather than produce a broken binary.

## Rolling back

Each install or update keeps two versions (about 170 MB each): the active
one and the newest other one. Older versions are removed, except any that a
running `claude` is still using. To switch back:

```sh
ls ~/.local/share/claude/versions
ln -sfn ~/.local/share/claude/versions/<version> ~/.local/bin/claude
```

The background updater moves forward again at its next check (within 8
hours) if your channel has a newer version. Versions cannot be pinned yet;
to stop automatic updates, remove the `install.sh --background` entry from
`hooks.SessionStart` in `~/.claude/settings.json`.

## Files installed

| Path | Contents |
|---|---|
| `~/.local/bin/claude` | symlink to the active version |
| `~/.local/share/claude/versions/<version>` | converted binaries: the active one and the newest other, for rolling back |
| `~/.local/share/claude/freebsd/bun-<v>/` | cached FreeBSD Bun and template |
| `~/.local/share/claude/freebsd/install.sh` | copy of the installer, run for updates |
| `~/.local/share/claude/freebsd/regraft.js` | copy of the converter |
| `~/.local/share/claude/freebsd/bun-ant/` | copy of the Bun.ant replacement |
| `~/.local/share/claude/freebsd/update.log` | background update log (last 500 lines) |
| `~/.local/share/claude/freebsd/update-checked` | time of the last update check |

If `XDG_DATA_HOME` is set, `$XDG_DATA_HOME/claude` takes the place of
`~/.local/share/claude`, matching where Claude Code looks for its native
install. `~/.local/bin` is used either way.

Added to `~/.claude/settings.json` (other settings and hooks are kept):

| Setting | Why |
|---|---|
| `env.USE_BUILTIN_RIPGREP=0` | use the system `rg` directly instead of spawning the binary as `rg` |
| `env.DISABLE_UPDATES=1` | Claude Code's updater (and `claude update`) would install the Linux build |
| `hooks.SessionStart`: `install.sh --background` | background updates |

## Known gaps

- Voice input does not work (Linux-only native addon).
- amd64 only so far.
- Right-to-left text is not reordered in Windows Terminal and VS Code
  terminals (see CELLSEGMENTER.md).

## Directory layout

| Path | Purpose |
|---|---|
| `TECHNICAL.md` | design overview; native versus the Linux compatibility layer |
| `install.sh` | the installer (POSIX sh, base tools only) |
| `mk-release.sh` | builds `release/FreeBSD-claude-native.tar.gz` |
| `README.install` | install instructions shipped in the tarball |
| `regraft.js` | moves the module graph onto FreeBSD Bun, adds `bun-ant/` |
| `bun-ant/` | JavaScript replacement for `Bun.ant.CellSegmenter`; `rg`/`ugrep`/`bfs` dispatch |
| `tools/gen-fused-data.py` | regenerates `bun-ant/fused-data.js` from Bun's tables |
| `tools/oracle.py` | grafts test JavaScript onto Anthropic's Linux runtime |
| `tools/cellseg-fuzz.js` | differential test against the native class (Linux) |

## License

MIT; see [LICENSE](LICENSE), a copy of the repository root's
[LICENSE](../LICENSE) that ships in the release tarball.

`bun-ant/clusters.js`, `bun-ant/cellsegmenter.js` and `bun-ant/fused-data.js`
port code and tables from [Bun](https://github.com/oven-sh/bun)
(copyright Oven, MIT). The tables in `fused-data.js` derive from Unicode
data ([Unicode License v3](https://www.unicode.org/license.txt)).

This license covers only the files in this repository. Claude Code itself,
the official build the installer downloads, and the converted binary it
produces remain under Anthropic's terms.
