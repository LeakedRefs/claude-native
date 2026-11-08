// regraft.js -- move a Bun --compile module graph onto another Bun runtime.
//
// Usage: bun regraft.js <source-exe> <template-exe> <output-exe>
//
// <source-exe>   a Bun v1.4.x ELF standalone executable (e.g. Linux claude)
// <template-exe> any `bun build --compile` output for the target platform,
//                built by the same Bun version
// <output-exe>   template runtime + source module graph, without bytecode,
//                plus the bun-ant/ modules (next to this file) and a prelude
//                entry point that installs them before the original entry
//
// Format: Bun v1.4.4 src/standalone_graph/StandaloneModuleGraph.rs and
// src/exe_format/elf.rs.  All integers are little-endian.

import { readFileSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";

const TRAILER = Buffer.from("\n---- Bun! ----\n");
const OFFSETS_SIZE = 32;        // u64 byte_count, SP modules, u32 entry, SP argv, u32 flags
const FILE_SIZE = 52;           // 6 x StringPointer + 4 x u8
const ENC_UTF16 = 2;

// Flags bits carried over from the source; everything else describes
// bytecode / prelinking that we drop.
const FLAG_DISABLE_MASK = 0xf;
const FLAG_HAS_SOURCE_HASHES = 1 << 5;
const FLAG_HAS_BUILTIN_BYTECODE = 1 << 6;
const FLAG_HAS_BYTECODE_STRING_TABLE = 1 << 7;
const FLAG_HAS_STARTUP_MODULE_COUNT = 1 << 8;
const FLAG_HAS_MODULE_INFO_STRING_TABLE = 1 << 9;
const FLAG_HAS_PRELINKED_MODULE_GRAPH = 1 << 11;
const FLAG_HAS_RUNTIME_OPTIONS = 1 << 12;

function die(msg) {
	console.error("regraft: " + msg);
	process.exit(1);
}

// ---- ELF helpers ---------------------------------------------------------

function elfHeader(b) {
	if (b.readUInt32BE(0) !== 0x7f454c46 || b[4] !== 2 || b[5] !== 1)
		die("not a little-endian ELF64 file");
	return {
		phoff: Number(b.readBigUInt64LE(0x20)),
		shoff: Number(b.readBigUInt64LE(0x28)),
		phentsize: b.readUInt16LE(0x36),
		phnum: b.readUInt16LE(0x38),
		shentsize: b.readUInt16LE(0x3a),
		shnum: b.readUInt16LE(0x3c),
		shstrndx: b.readUInt16LE(0x3e),
	};
}

function readShdr(b, at) {
	return {
		at,
		name: b.readUInt32LE(at),
		type: b.readUInt32LE(at + 4),
		addr: Number(b.readBigUInt64LE(at + 16)),
		offset: Number(b.readBigUInt64LE(at + 24)),
		size: Number(b.readBigUInt64LE(at + 32)),
	};
}

function findSection(b, eh, want) {
	const strtab = readShdr(b, eh.shoff + eh.shstrndx * eh.shentsize);
	for (let i = 0; i < eh.shnum; i++) {
		const sh = readShdr(b, eh.shoff + i * eh.shentsize);
		const s = strtab.offset + sh.name;
		if (b.toString("latin1", s, b.indexOf(0, s)) === want)
			return { index: i, ...sh };
	}
	die("no " + want + " section");
}

// ---- graph reading -------------------------------------------------------

function readGraph(exe) {
	const b = readFileSync(exe);
	const eh = elfHeader(b);
	const sec = findSection(b, eh, ".bun");
	const len = Number(b.readBigUInt64LE(sec.offset));
	if (len === 0 || len + 8 > sec.size)
		die(exe + ": .bun section holds no module graph");
	const g = b.subarray(sec.offset + 8, sec.offset + 8 + len);
	if (!g.subarray(g.length - TRAILER.length).equals(TRAILER))
		die(exe + ": module graph trailer not found");

	const o = g.length - TRAILER.length - OFFSETS_SIZE;
	const modOff = g.readUInt32LE(o + 8), modLen = g.readUInt32LE(o + 12);
	const entry = g.readUInt32LE(o + 16);
	const flags = g.readUInt32LE(o + 28);
	if (modLen % FILE_SIZE !== 0)
		die(exe + ": module table size is not a multiple of " + FILE_SIZE);

	const sp = (at) => g.subarray(g.readUInt32LE(at), g.readUInt32LE(at) + g.readUInt32LE(at + 4));
	const n = modLen / FILE_SIZE;
	const modules = [];
	for (let i = 0; i < n; i++) {
		const at = modOff + i * FILE_SIZE;
		modules.push({
			name: sp(at),
			contents: sp(at + 8),
			encoding: g[at + 48],
			loader: g[at + 49],
			format: g[at + 50],
			side: g[at + 51],
		});
	}

	// Walk the optional records that follow the module table, in flag
	// bit order, to reach the runtime options (JIT policy).
	let r = modOff + modLen;
	if (flags & FLAG_HAS_SOURCE_HASHES) r += n * 4;
	if (flags & FLAG_HAS_BUILTIN_BYTECODE) r += 4 + g.readUInt32LE(r) * 12;
	if (flags & FLAG_HAS_BYTECODE_STRING_TABLE) r += 8;
	if (flags & FLAG_HAS_STARTUP_MODULE_COUNT) r += 4;
	if (flags & FLAG_HAS_MODULE_INFO_STRING_TABLE) r += 8;
	if (flags & FLAG_HAS_PRELINKED_MODULE_GRAPH) r += 12 + g.readUInt32LE(r + 8) * 4;
	let runtimeOptions = null;
	if (flags & FLAG_HAS_RUNTIME_OPTIONS)
		runtimeOptions = g.subarray(r, r + 8);

	return { modules, entry, flags, runtimeOptions };
}

// ---- graph writing -------------------------------------------------------

function writeGraph(graph) {
	const parts = [];
	let len = 0;
	const put = (buf) => { parts.push(buf); len += buf.length; };
	const pad = (n) => { if (n > 0) put(Buffer.alloc(n)); };
	const sp = [];

	// Source text first, then names, then the table (as Bun lays it out).
	for (const m of graph.modules) {
		if (m.encoding === ENC_UTF16)
			pad(len & 1);           // UTF-16 bodies sit at even offsets
		sp.push({ contents: [len, m.contents.length] });
		put(m.contents);
		pad(m.encoding === ENC_UTF16 ? 2 : 1);
	}
	graph.modules.forEach((m, i) => {
		sp[i].name = [len, m.name.length];
		put(m.name);
		pad(1);
	});

	const table = Buffer.alloc(graph.modules.length * FILE_SIZE);
	graph.modules.forEach((m, i) => {
		const at = i * FILE_SIZE;
		table.writeUInt32LE(sp[i].name[0], at);
		table.writeUInt32LE(sp[i].name[1], at + 4);
		table.writeUInt32LE(sp[i].contents[0], at + 8);
		table.writeUInt32LE(sp[i].contents[1], at + 12);
		// sourcemap, bytecode, module_info, bytecode_origin_path stay 0
		table[at + 48] = m.encoding;
		table[at + 49] = m.loader;
		table[at + 50] = m.format;
		table[at + 51] = m.side;
	});
	const modOff = len;
	put(table);

	let flags = graph.flags & FLAG_DISABLE_MASK;
	if (graph.runtimeOptions) {
		flags |= FLAG_HAS_RUNTIME_OPTIONS;
		put(graph.runtimeOptions);
	}

	const argvOff = len;
	pad(1);                         // empty compile_exec_argv, NUL-terminated

	const offsets = Buffer.alloc(OFFSETS_SIZE);
	offsets.writeBigUInt64LE(BigInt(len + OFFSETS_SIZE + TRAILER.length), 0);
	offsets.writeUInt32LE(modOff, 8);
	offsets.writeUInt32LE(table.length, 12);
	offsets.writeUInt32LE(graph.entry, 16);
	offsets.writeUInt32LE(argvOff, 20);
	offsets.writeUInt32LE(0, 24);
	offsets.writeUInt32LE(flags, 28);
	put(offsets);
	put(TRAILER);
	return Buffer.concat(parts, len);
}

// ---- payload replacement (elf.rs write_bun_section, replace mode) --------

function replacePayload(template, payload) {
	const b = readFileSync(template);
	const eh = elfHeader(b);
	const sec = findSection(b, eh, ".bun");
	if (b.readBigUInt64LE(sec.offset) === 0n)
		die(template + ": not a --compile output (empty .bun section)");

	const PT_LOAD = 1, PF_W = 2, PAGE = 0x1000;
	let rw = null;
	for (let i = 0; i < eh.phnum; i++) {
		const at = eh.phoff + i * eh.phentsize;
		const p = {
			at,
			type: b.readUInt32LE(at),
			flags: b.readUInt32LE(at + 4),
			offset: Number(b.readBigUInt64LE(at + 8)),
			vaddr: Number(b.readBigUInt64LE(at + 16)),
			filesz: Number(b.readBigUInt64LE(at + 32)),
			memsz: Number(b.readBigUInt64LE(at + 40)),
		};
		if (p.type === PT_LOAD && (p.flags & PF_W) &&
		    p.vaddr <= sec.addr && sec.addr < p.vaddr + p.memsz)
			rw = p;
	}
	if (!rw)
		die(template + ": no writable PT_LOAD holds .bun");
	if (sec.addr % PAGE !== 0 || rw.offset + rw.filesz !== sec.offset +
	    Math.ceil(sec.size / PAGE) * PAGE)
		die(template + ": .bun is not an appended payload at the segment end");

	const contentSize = 8 + payload.length;
	const alignedSize = Math.ceil(contentSize / PAGE) * PAGE;
	const tail = b.subarray(rw.offset + rw.filesz);
	const out = Buffer.alloc(sec.offset + alignedSize + tail.length);
	b.copy(out, 0, 0, sec.offset);
	out.writeBigUInt64LE(BigInt(payload.length), sec.offset);
	payload.copy(out, sec.offset + 8);
	tail.copy(out, sec.offset + alignedSize);

	const shift = sec.offset + alignedSize - (rw.offset + rw.filesz);
	const newShoff = eh.shoff + shift;
	out.writeBigUInt64LE(BigInt(newShoff), 0x28);
	const SHT_NOBITS = 8;
	for (let i = 0; i < eh.shnum; i++) {
		const at = newShoff + i * eh.shentsize;
		const sh = readShdr(out, at);
		if (i === sec.index)
			out.writeBigUInt64LE(BigInt(contentSize), at + 32);
		else if (sh.type !== SHT_NOBITS && sh.offset >= rw.offset + rw.filesz)
			out.writeBigUInt64LE(BigInt(sh.offset + shift), at + 24);
	}
	const segSize = BigInt(sec.addr - rw.vaddr + alignedSize);
	out.writeBigUInt64LE(segSize, rw.at + 32);
	out.writeBigUInt64LE(segSize, rw.at + 40);
	return out;
}

// ---- main ----------------------------------------------------------------

const [src, tpl, dst] = process.argv.slice(2);
if (!dst)
	die("usage: bun regraft.js <source-exe> <template-exe> <output-exe>");

const graph = readGraph(src);
const NAPI = 10;
const dropped = graph.modules.filter((m) => m.loader === NAPI);
const entryName = graph.modules[graph.entry].name;
graph.modules = graph.modules.filter((m) => m.loader !== NAPI);

// Anthropic's runtime has native pieces stock Bun lacks (Bun.ant). Add our
// JavaScript replacements, and a prelude that installs them before loading
// Claude Code's own entry point.
const LOADER_JS = 1, FORMAT_ESM = 1, ENC_LATIN1 = 1;
const SHIM_DIR = join(import.meta.dir, "bun-ant");
const SHIM_ROOT = "/$bunfs/root/freebsd/";
const addModule = (name, source) => {
	if (!/^[\x00-\x7f]*$/.test(source))
		die(name + ": embedded modules must be ASCII");
	graph.modules.push({ name: Buffer.from(name), contents: Buffer.from(source, "latin1"),
	    encoding: ENC_LATIN1, loader: LOADER_JS, format: FORMAT_ESM, side: 0 });
};
for (const f of ["embedded-tools.js", "cellsegmenter.js", "clusters.js", "fused-data.js"])
	addModule(SHIM_ROOT + f, readFileSync(join(SHIM_DIR, f), "latin1"));
addModule(SHIM_ROOT + "prelude.js", [
	"// Added by claude-native/regraft.js: provide what Anthropic's runtime",
	"// has natively, then start Claude Code.",
	'import { runEmbeddedTool } from "./embedded-tools.js";',
	"runEmbeddedTool();   // started as rg, ugrep or bfs: runs it and exits",
	'const { CellSegmenter } = await import("./cellsegmenter.js");',
	'if (typeof Bun.ant?.CellSegmenter !== "function")',
	"\tBun.ant = Object.assign(Bun.ant ?? {}, { CellSegmenter });",
	"await import(" + JSON.stringify(entryName.toString("latin1")) + ");",
	"",
].join("\n"));
graph.entry = graph.modules.length - 1;

const payload = writeGraph(graph);
writeFileSync(dst, replacePayload(tpl, payload));
chmodSync(dst, 0o755);
console.log("regraft: %d modules (%d native addons dropped: %s; Bun.ant shim added), graph %d bytes",
    graph.modules.length, dropped.length,
    dropped.map((m) => m.name.toString().replace("/$bunfs/root/", "")).join(", "),
    payload.length);
