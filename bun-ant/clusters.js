// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Rob Kubicki
// Portions copyright (c) Oven (oven-sh/bun), MIT.
//
// clusters.js -- grapheme clustering and cluster width, a port of Bun v1.4.4
// src/jsc/bindings/stringWidth.cpp (uucode grapheme break algorithm).
import { FUSED_DELTAS, FUSED_VALUES } from "./fused-data.js";

const FUSED = new Uint8Array(0x110000);
{
	let cp = 0;
	for (let i = 0; i < FUSED_DELTAS.length; i++) {
		cp += FUSED_DELTAS[i];
		const end = i + 1 < FUSED_DELTAS.length ? cp + FUSED_DELTAS[i + 1] : 0x110000;
		FUSED.fill(FUSED_VALUES[i], cp, end);
	}
}

const CLASS_MASK = 0x1f, WIDTH_SHIFT = 5, EMOJI_BIT = 0x80;
const widthOf = (packed, ambiguousAsWide) => {
	const w = (packed >> WIDTH_SHIFT) & 3;
	return w === 3 ? (ambiguousAsWide ? 2 : 1) : w;
};

// GraphemeBreakClass ordinals
const Other = 0, Prepend = 1, RI = 2, SpacingMark = 3, L = 4, V = 5, T = 6, LV = 7, LVT = 8,
	Zwj = 9, Zwnj = 10, ExtPict = 11, EmojiModBase = 12, EmojiMod = 13,
	IcbExtend = 14, IcbLinker = 15, IcbConsonant = 16;
// GraphemeBreakState
const S_Default = 0, S_RI = 1, S_ExtPict = 2, S_IcbConsonant = 3, S_IcbLinker = 4;

const isIcbExtend = (g) => g === IcbExtend || g === Zwj;
const isExtend = (g) => g === Zwnj || g === IcbExtend || g === IcbLinker;
const isExtPict = (g) => g === ExtPict || g === EmojiModBase;

// computeGraphemeBreakNoControl: returns [shouldBreak, nextState]
function computeBreak(g1, g2, state) {
	if (state === S_RI) {
		if (g1 !== RI || g2 !== RI) state = S_Default;
	} else if (state === S_ExtPict) {
		const ok = (g) => g === IcbExtend || g === IcbLinker || g === Zwnj || g === Zwj ||
			g === ExtPict || g === EmojiModBase || g === EmojiMod;
		if (!ok(g1) || !ok(g2)) state = S_Default;
	} else if (state === S_IcbConsonant || state === S_IcbLinker) {
		const ok = (g) => g === IcbConsonant || g === IcbLinker || g === IcbExtend || g === Zwj;
		if (!ok(g1) || !ok(g2)) state = S_Default;
	}
	if (g1 === L && (g2 === L || g2 === V || g2 === LV || g2 === LVT)) return [false, state];
	if ((g1 === LV || g1 === V) && (g2 === V || g2 === T)) return [false, state];
	if ((g1 === LVT || g1 === T) && g2 === T) return [false, state];
	if (g2 === SpacingMark) return [false, state];
	if (g1 === Prepend) return [false, state];
	if (g1 === IcbConsonant) {
		if (isIcbExtend(g2)) return [false, S_IcbConsonant];
		if (g2 === IcbLinker) return [false, S_IcbLinker];
	} else if (state === S_IcbConsonant) {
		if (g2 === IcbLinker) return [false, S_IcbLinker];
		if (isIcbExtend(g2)) return [false, state];
		state = S_Default;
	} else if (state === S_IcbLinker) {
		if (g2 === IcbLinker || isIcbExtend(g2)) return [false, state];
		if (g2 === IcbConsonant) return [false, S_Default];
		state = S_Default;
	}
	if (isExtPict(g1)) {
		if (isExtend(g2) || g2 === Zwj) return [false, S_ExtPict];
		if (g1 === EmojiModBase && g2 === EmojiMod) return [false, S_ExtPict];
	} else if (state === S_ExtPict) {
		if ((isExtend(g1) || g1 === EmojiMod) && (isExtend(g2) || g2 === Zwj)) return [false, state];
		if (g1 === Zwj && isExtPict(g2)) return [false, S_Default];
		state = S_Default;
	}
	if (g1 === RI && g2 === RI) {
		if (state === S_Default) return [false, S_RI];
		return [true, S_Default];
	}
	if (isExtend(g2) || g2 === Zwj) return [false, state];
	return [true, state];
}

// Decision table: key = state | g1 << 3 | g2 << 8; value = break | next << 1
const DECISIONS = new Uint8Array(1 << 13);
for (let st = 0; st < 5; st++)
	for (let a = 0; a < 17; a++)
		for (let b = 0; b < 17; b++) {
			const [brk, next] = computeBreak(a, b, st);
			DECISIONS[st | (a << 3) | (b << 8)] = (brk ? 1 : 0) | (next << 1);
		}

// GraphemeState: one cluster's width (flags, keycaps, emoji sequences, VS15/16).
class Cluster {
	reset(cp, packed, aw) {
		this.firstCp = cp;
		const w = cp < 0x80 ? (cp >= 0x20 && cp < 0x7f ? 1 : 0) : widthOf(packed, aw);
		this.count = 1; this.baseWidth = w; this.sum = w;
		const ascii = cp < 0x80;
		this.emojiBase = !ascii && (packed & EMOJI_BIT) !== 0;
		this.keycap = cp === 0x20e3; this.ri = cp >= 0x1f1e6 && cp <= 0x1f1ff;
		this.skin = cp >= 0x1f3fb && cp <= 0x1f3ff; this.zwj = cp === 0x200d;
		this.vs15 = false; this.vs16 = false;
	}
	add(cp, packed, aw) {
		this.count++;
		if (cp === 0x20e3) this.keycap = true;
		if (cp >= 0x1f1e6 && cp <= 0x1f1ff) this.ri = true;
		if (cp >= 0x1f3fb && cp <= 0x1f3ff) this.skin = true;
		if (cp === 0x200d) this.zwj = true;
		if (cp === 0xfe0e) this.vs15 = true;
		if (cp === 0xfe0f) this.vs16 = true;
		this.sum = Math.min(this.sum + widthOf(packed, aw), 1023);
	}
	width() {
		if (this.ri && this.count >= 2) return 2;
		if (this.keycap) return 2;
		if (this.ri) return 1;
		if (this.emojiBase && (this.skin || this.zwj)) return 2;
		// Anthropic's runtime differs from upstream Bun here: VS16 widens an
		// emoji base to 2 and the rest of the cluster still adds its width;
		// otherwise VS15/VS16 leave the plain sum alone.
		if (this.vs16 && (this.emojiBase || this.firstCp === 0xa9 || this.firstCp === 0xae))
			return Math.max(this.baseWidth, 2) + this.sum - this.baseWidth;
		return this.sum;
	}
}

// Streaming clusterizer. Feed text pieces with clusterize(st, s, a, b, out);
// clusterize(st, null, ...) ends the pending cluster. out(g, w) receives
// each cluster: w > 0 visible, 0 zero-width, -1 tab, -2 substituted.
export function newClusterState(ambiguousAsWide, isSubstitute) {
	return { aw: ambiguousAsWide, isSub: isSubstitute, c: new Cluster(), cur: "", have: false, prevClass: 0, state: S_Default };
}

export function clusterize(st, s, a, b, out, onStart) {
	const c = st.c;
	const flush = () => { if (st.have) out(st.cur, c.width()); st.have = false; st.cur = ""; st.state = S_Default; };
	if (s === null) { flush(); return; }
	for (let i = a; i < b; i++) {
		let cp = s.charCodeAt(i);
		if (cp >= 0xd800 && cp <= 0xdbff) {
			const lo = i + 1 < b ? s.charCodeAt(i + 1) : 0;
			if (lo >= 0xdc00 && lo <= 0xdfff) { cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00); i++; }
			else continue;                      // lone lead surrogate: skipped
		} else if (cp >= 0xdc00 && cp <= 0xdfff) continue;
		if (cp === 9) { flush(); onStart(); out("\t", -1); continue; }
		if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) { flush(); continue; }   // controls end a cluster
		if (st.isSub(cp)) { flush(); onStart(); out("\ufffd", -2); continue; }
		const packed = FUSED[cp], cls = packed & CLASS_MASK, ch = String.fromCodePoint(cp);
		if (!st.have) { onStart(); c.reset(cp, packed, st.aw); st.cur = ch; st.have = true; st.state = S_Default; }
		else {
			const v = DECISIONS[st.state | (st.prevClass << 3) | (cls << 8)];
			st.state = v >> 1;
			if (v & 1) { out(st.cur, c.width()); onStart(); c.reset(cp, packed, st.aw); st.cur = ch; }
			else { c.add(cp, packed, st.aw); st.cur += ch; }
		}
		st.prevClass = cls;
	}
}
