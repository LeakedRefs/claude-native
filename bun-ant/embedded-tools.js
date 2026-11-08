// embedded-tools.js -- stand in for the tools built into Anthropic's runtime.
//
// Anthropic's build of Bun has ripgrep, ugrep and bfs compiled in: when the
// claude binary is started under the name rg, ugrep or bfs, it runs that
// tool. Claude Code relies on this. It spawns itself as `rg` for its search
// tools, and in native installs its Bash tool shadows `grep` and `find`
// with shell functions that run the claude binary as `ugrep` and `bfs`.
//
// Stock Bun has none of them, so here a binary started under one of those
// names runs the system's copy instead (installed by install.sh from pkg).

import { accessSync, constants, realpathSync } from "fs";
import { basename, join } from "path";
import { constants as osConstants } from "os";

const TOOLS = { rg: "ripgrep", ugrep: "ugrep", bfs: "bfs" };

function findInPath(name) {
	let self = "";
	try { self = realpathSync(process.execPath); } catch {}
	for (const dir of (process.env.PATH || "").split(":")) {
		if (!dir) continue;
		const candidate = join(dir, name);
		try {
			accessSync(candidate, constants.X_OK);
			if (realpathSync(candidate) !== self) return candidate;
		} catch {}
	}
	return null;
}

// Returns only when this process was not started as one of the tools.
export function runEmbeddedTool() {
	const name = basename(process.argv0 || "");
	if (!Object.hasOwn(TOOLS, name)) return;
	const exe = findInPath(name);
	if (exe === null) {
		process.stderr.write(`claude: ${name} is not installed (Claude Code needs it on FreeBSD); ` +
		    `install it with: pkg install ${TOOLS[name]}\n`);
		process.exit(127);
	}
	const r = Bun.spawnSync({
		cmd: [exe, ...process.argv.slice(2)],
		stdio: ["inherit", "inherit", "inherit"],
	});
	if (r.exitCode !== null && r.exitCode !== undefined) process.exit(r.exitCode);
	// Killed by a signal (SIGPIPE from `grep ... | head`, say): exit the way a shell reports it.
	process.exit(128 + (osConstants.signals[r.signalCode] || 1));
}
