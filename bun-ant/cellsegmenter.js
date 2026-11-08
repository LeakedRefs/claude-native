// cellsegmenter.js -- JavaScript replacement for Bun.ant.CellSegmenter.
//
// Anthropic's private Bun build provides Bun.ant.CellSegmenter natively;
// Claude Code's terminal renderer cannot draw without it. This is a
// behavioral reimplementation, fitted against the native class (see
// CELLSEGMENTER.md). Grapheme clustering and widths port Bun v1.4.4
// src/jsc/bindings/stringWidth.cpp (MIT); the escape grammar follows
// ANSIHelpers.h consumeANSI(); SGR bookkeeping follows ansi-tokenize.

import { clusterize, newClusterState } from "./clusters.js";

const REPLACEMENT = "\ufffd";
const FLAG_TAB = 256, FLAG_SUBST = 512, RUN_SHIFT = 10;

// ---- SGR ------------------------------------------------------------------

// Close code for an SGR code, by its first number (ansi-styles pairs).
function closeOf(n) {
	if (n === 1 || n === 2) return 22;
	if (n === 3 || n === 20) return 23;
	if (n === 4 || n === 21) return 24;
	if (n === 5 || n === 6) return 25;
	if (n === 7) return 27;
	if (n === 8) return 28;
	if (n === 9) return 29;
	if ((n >= 30 && n <= 38) || (n >= 90 && n <= 97)) return 39;
	if ((n >= 40 && n <= 48) || (n >= 100 && n <= 107)) return 49;
	if (n === 51 || n === 52) return 54;
	if (n === 53) return 55;
	if (n === 58) return 59;
	if (n === 73 || n === 74) return 75;
	return 0;
}

const CLOSERS = new Set([22, 23, 24, 25, 27, 28, 29, 39, 49, 54, 55, 59, 75]);

// Replacement slot: codes in one slot replace each other.
function slotOf(n) {
	if ((n >= 30 && n <= 38) || (n >= 90 && n <= 97)) return "fg";
	if ((n >= 40 && n <= 48) || (n >= 100 && n <= 107)) return "bg";
	if (n === 5 || n === 6) return "blink";
	if (n === 73 || n === 74) return "script";
	if (closeOf(n) === 0) return "other";
	return "a" + n;
}

const sgr = (body) => "\x1b[" + body + "m";

// Split an SGR parameter string into codes: [{ body, n }] or "reset" marks.
function sgrCodes(params) {
	if (params.includes(":"))
		return [{ body: params, n: parseInt(params, 10) || 0 }];
	const raw = params.split(";");
	const nums = raw.map((p) => (p === "" ? 0 : parseInt(p, 10)));
	if (nums.some((v) => !(v <= 255)))
		return [{ body: params, n: parseInt(params, 10) || 0 }];
	const out = [];
	for (let i = 0; i < nums.length; i++) {
		const v = nums[i];
		if ((v === 38 || v === 48 || v === 58) && nums[i + 1] === 5 && i + 2 < nums.length) {
			out.push({ body: v + ";5;" + nums[i + 2], n: v, plain: true });
			i += 2;
		} else if ((v === 38 || v === 48 || v === 58) && nums[i + 1] === 2 && i + 4 < nums.length) {
			out.push({ body: v + ";2;" + nums[i + 2] + ";" + nums[i + 3] + ";" + nums[i + 4], n: v, plain: true });
			i += 4;
		} else {
			out.push({ body: String(v), n: v, plain: true });
		}
	}
	return out;
}

// ---- the class --------------------------------------------------------------

export class CellSegmenter {
	#aw; #subst; #screen;
	#graphemes = []; #gIndex = new Map();
	#sgrKeys = [""]; #sgrClose = [""]; #sgrIndex = new Map([["", 0]]);
	#uris = [""]; #uriIndex = new Map([["", 0]]);

	constructor(opts = {}) {
		this.#aw = opts.ambiguousIsNarrow === false;
		const ranges = opts.substitute || [];
		this.#subst = (cp) => {
			for (let i = 0; i < ranges.length; i++)
				if (cp >= ranges[i][0] && cp <= ranges[i][1]) return true;
			return false;
		};
		this.#screen = opts.screen;
		this.#intern(" ");
		this.#intern("");
		for (let c = 0x21; c <= 0x7e; c++) this.#intern(String.fromCharCode(c));
		this.#intern("\t");
		this.#intern(REPLACEMENT);
	}

	get graphemes() { return this.#graphemes; }
	get sgrKeys() { return this.#sgrKeys; }
	get sgrCloseKeys() { return this.#sgrClose; }
	get uris() { return this.#uris; }

	#intern(g) {
		let i = this.#gIndex.get(g);
		if (i === undefined) {
			i = this.#graphemes.length;
			this.#graphemes.push(g);
			this.#gIndex.set(g, i);
		}
		return i;
	}

	#styleIndex(active) {
		if (active.length === 0) return 0;
		const key = active.map((c) => sgr(c.body)).join("\0");
		let i = this.#sgrIndex.get(key);
		if (i === undefined) {
			i = this.#sgrKeys.length;
			this.#sgrKeys.push(key);
			this.#sgrClose.push(active.map((c) => sgr(String(c.close))).join("\0"));
			this.#sgrIndex.set(key, i);
		}
		return i;
	}

	#uriIndexOf(uri) {
		let i = this.#uriIndex.get(uri);
		if (i === undefined) {
			i = this.#uris.length;
			this.#uris.push(uri);
			this.#uriIndex.set(uri, i);
		}
		return i;
	}

	segment(text, cells, runs, reorder) {
		const outCells = [], outRuns = [];
		// A style enters its pool only when a cell is emitted under it; a link
		// target enters as soon as it is parsed. Once the output arrays are
		// full, clusters are only counted (graphemes are not interned).
		// A cluster takes the style and link in effect where it started, even
		// when an escape sequence falls inside it. The style enters its pool
		// when a cluster starts under it (even one later dropped as zero-width).
		let active = [], uriIdx = 0, runIdx = -1, count = 0;
		let internedFor = null, startIdx = 0, startUri = 0;
		const onStart = () => {
			if (active !== internedFor) { startIdx = this.#styleIndex(active); internedFor = active; }
			startUri = uriIdx;
		};
		const emit = (g, w, flags) => {
			const styleIdx = startIdx, uriIdx = startUri;
			const room = 2 * (count + 1) <= cells.length;
			count++;
			if (runIdx < 0 || outRuns[2 * runIdx] !== styleIdx || outRuns[2 * runIdx + 1] !== uriIdx) {
				runIdx++;
				outRuns.push(styleIdx, uriIdx);
			}
			outCells.push(room ? this.#intern(g) : 0, (w & 255) | flags | (runIdx << RUN_SHIFT));
		};
		const onCluster = (g, w) => {
			if (w === -1) emit("\t", 0, FLAG_TAB);
			else if (w === -2) emit(REPLACEMENT, 1, FLAG_SUBST);
			else if (w > 0) emit(g, w, 0);
		};
		const applySgr = (params) => {
			for (const c of sgrCodes(params)) {
				if (c.plain && c.n === 0) { if (active.length) active = []; continue; }
				if (c.plain && CLOSERS.has(c.n)) { active = active.filter((a) => a.close !== c.n); continue; }
				c.close = closeOf(c.n);
				c.slot = slotOf(c.n);
				// Re-applying an identical code changes nothing, except a verbatim
				// sequence (':' or a value over 255), which moves to the end.
				if (c.plain && active.some((a) => a.body === c.body)) continue;
				active = active.filter((a) => a.slot !== c.slot);
				active.push(c);
			}
		};
		const onOsc = (payload) => {
			if (!payload.startsWith("8;")) return;
			const semi = payload.indexOf(";", 2);
			if (semi < 0) return;
			uriIdx = this.#uriIndexOf(payload.slice(semi + 1));
		};
		const st = newClusterState(this.#aw, this.#subst);
		// Escape sequences are transparent to clustering: a mark after one
		// still joins the cluster before it.
		parse(text, (s, a, b) => clusterize(st, s, a, b, onCluster, onStart), (params, final) => {
			// An SGR whose parameters hold anything but digits, ';' and ':'
			// (private markers, stray bytes) is ignored.
			if (final === "m" && /^[0-9;:]*$/.test(params)) applySgr(params);
		}, onOsc, () => {});
		clusterize(st, null, 0, 0, onCluster, onStart);
		const nRuns = outRuns.length / 2;
		if (cells.length < 2 * count || runs.length < 2 * nRuns)
			return -Math.max(count, nRuns);
		for (let i = 0; i < outCells.length; i++) cells[i] = outCells[i];
		for (let i = 0; i < outRuns.length; i++) runs[i] = outRuns[i];
		return count;
	}

	// ---- screen writes --------------------------------------------------

	paint(screen, width, x, y, cells, count, _unused, charIndex, runWords) {
		const sc = this.#screen;
		const d = { lo: 0xffff, hi: 0 };
		let col = x;
		for (let i = 0; i < count; i++) {
			const packed = cells[2 * i + 1];
			if (packed & FLAG_TAB) {
				// On screen, a tab clears up to the next stop, capped at the
				// edge. Past the edge it advances nothing.
				if (col < width) {
					const stop = Math.min(col - (col % sc.tabWidth) + sc.tabWidth, width);
					this.#clearRange(screen, width, Math.max(col, 0), stop, y, d);
					col = stop;
				}
				continue;
			}
			if (col >= width) { col++; continue; }   // past the edge: one column per cell
			const w = packed & 255;
			const word = runWords[packed >>> RUN_SHIFT];
			if (col + w > width) {
				// Does not fit: a spacer head, one column.
				if (col >= 0) this.#write(screen, width, col, y, sc.emptyCharIndex, sc.spacerHead, d);
				col++;
				continue;
			}
			if (col >= 0) {
				this.#write(screen, width, col, y, charIndex[cells[2 * i]], (word & ~sc.widthMask) | (w >= 2 ? sc.wide : sc.narrow), d);
				if (w >= 2) this.#write(screen, width, col + 1, y, sc.spacerCharIndex, sc.spacerTail, d);
			}
			// Columns past the second carry the style on their tails.
			for (let k = 2; k < w; k++)
				if (col + k >= 0) this.#write(screen, width, col + k, y, sc.spacerCharIndex, (word & ~sc.widthMask) | sc.spacerTail, d);
			col += w;
		}
		return Math.max(col, 0) + 1048576 * d.lo + 68719476736 * d.hi;
	}

	setCell(screen, width, x, y, ch, word) {
		const sc = this.#screen;
		const d = { lo: 0xffff, hi: 0 };
		if (x >= 0 && x < width) {
			this.#write(screen, width, x, y, ch, word, d);
			if ((word & sc.widthMask) === sc.wide && x + 1 < width)
				this.#write(screen, width, x + 1, y, sc.spacerCharIndex, sc.spacerTail, d);
		}
		return x + 1 + 1048576 * d.lo + 68719476736 * d.hi;
	}

	// Write one screen cell, repairing any wide pair it breaks: a cell that
	// replaces a tail clears the head before it (unless it is a tail itself),
	// and one that replaces a head clears the tail after it.
	#write(screen, width, c, y, ch, word, d) {
		const sc = this.#screen, mask = sc.widthMask, row = y * width;
		const at = (k) => (row + k) << 1;
		const touch = (k) => { if (k < d.lo) d.lo = k; if (k + 1 > d.hi) d.hi = k + 1; };
		const clear = (k) => { screen[at(k)] = sc.emptyCharIndex; screen[at(k) + 1] = sc.emptyWord; touch(k); };
		const oldKind = screen[at(c) + 1] & mask, newKind = word & mask;
		if (oldKind === sc.spacerTail && newKind !== sc.spacerTail && c > 0 && (screen[at(c - 1) + 1] & mask) === sc.wide) clear(c - 1);
		if (oldKind === sc.wide && newKind !== sc.wide && c + 1 < width && (screen[at(c + 1) + 1] & mask) === sc.spacerTail) clear(c + 1);
		if (oldKind === sc.wide && newKind === sc.spacerTail && c + 1 < width && (screen[at(c + 1) + 1] & mask) === sc.spacerTail) clear(c + 1);
		screen[at(c)] = ch;
		screen[at(c) + 1] = word;
		touch(c);
	}

	#clearRange(screen, width, from, to, y, d) {
		const sc = this.#screen;
		for (let c = from; c < to; c++) this.#write(screen, width, c, y, sc.emptyCharIndex, sc.emptyWord, d);
	}
}

// ---- escape parsing (ANSIHelpers.h consumeANSI) -----------------------------

// Calls onText(str, start, end) for plain text, onCsi(params, final) for a
// complete CSI, onOsc(payload) for a terminated OSC, onOther() for any other
// consumed escape.
function parse(s, onText, onCsi, onOsc, onOther) {
	const n = s.length;
	let i = 0, textStart = 0;
	const flushText = (end) => { if (end > textStart) onText(s, textStart, end); };
	while (i < n) {
		const c = s.charCodeAt(i);
		if (c !== 0x1b && c !== 0x9b && c !== 0x9d && c !== 0x90 && c !== 0x98 && c !== 0x9e && c !== 0x9f) { i++; continue; }
		flushText(i);
		i = escape(s, i, onCsi, onOsc, onOther);
		textStart = i;
	}
	flushText(n);
}

// Consume escape sequences starting at i; returns the index after them.
function escape(s, i, onCsi, onOsc, onOther) {
	const n = s.length;
	let state = "start", body = 0;
	for (; i < n; i++) {
		const c = s.charCodeAt(i);
		switch (state) {
		case "start":
			if (c === 0x1b) state = "esc";
			else if (c === 0x9b) { state = "csi"; body = i + 1; }
			else if (c === 0x9d) { state = "osc"; body = i + 1; }
			else if (c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) state = "st";
			else return i;
			break;
		case "oscEsc":
		case "stEsc":
			if (c === 0x5c) {             // ESC \ terminates
				if (state === "oscEsc") onOsc(s.slice(body, i - 1)); else onOther();
				state = "start";
				break;
			}
			state = "esc";
			// fall through: this byte follows a fresh ESC
		case "esc":
			if (c === 0x1b) break;
			if (c === 0x18 || c === 0x1a) { onOther(); state = "start"; break; }
			if (c === 0x5b) { state = "csi"; body = i + 1; break; }
			if (c === 0x5d) { state = "osc"; body = i + 1; break; }
			if (c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f) { state = "st"; break; }
			if (c >= 0x20 && c <= 0x2f) { state = "skip"; break; }
			if (c >= 0x30 && c <= 0x7e) { onOther(); state = "start"; break; }
			if (c === 0x9c) { onOther(); state = "start"; break; }
			return i;
		case "skip":
			if (c === 0x1b) { state = "esc"; break; }
			onOther();
			state = "start";
			break;
		case "csi":
			if (c >= 0x40 && c <= 0x7e) { onCsi(s.slice(body, i), String.fromCharCode(c)); state = "start"; break; }
			if (c === 0x1b) { state = "esc"; break; }
			if (c === 0x18 || c === 0x1a || c === 0x9c) { onOther(); state = "start"; break; }
			break;
		case "osc":
		case "st":
			if (c === 0x07 && state === "osc") { onOsc(s.slice(body, i)); state = "start"; break; }
			if (c === 0x9c) { if (state === "osc") onOsc(s.slice(body, i)); else onOther(); state = "start"; break; }
			if (c === 0x1b) { state = state === "osc" ? "oscEsc" : "stEsc"; break; }
			if (c === 0x18 || c === 0x1a) { onOther(); state = "start"; break; }
			break;
		}
	}
	return n;
}
