// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Rob Kubicki
//
// cellseg-fuzz.js -- differential test: bun-ant/cellsegmenter.js against the
// real Bun.ant.CellSegmenter in Anthropic's Linux runtime.
//
// Runs on Linux. Graft it onto an official Linux `claude` binary:
//   python3 tools/oracle.py <linux-claude> /tmp/fuzz tools/cellseg-fuzz.js \
//       bun-ant/cellsegmenter.js bun-ant/clusters.js bun-ant/fused-data.js
//   SEED=1 N=50000 /tmp/fuzz
// Each iteration feeds both classes the same random text (characters plus
// escape sequences), compares segment() output and all four pools, then
// paints into random screens and compares cells, damage and return values.
// The counters printed at the end show what was actually exercised.

import { CellSegmenter as Mine } from "./cellsegmenter.js";
const Real = Bun.ant.CellSegmenter;
const SCREEN = { widthMask: 3, narrow: 0, wide: 1, spacerTail: 2, spacerHead: 3, emptyCharIndex: 0, spacerCharIndex: 1, emptyWord: 0, tabWidth: 8 };
const BIDI = [[0x061C, 0x061C], [0x202A, 0x202E], [0x2066, 0x2069]];
// mulberry32: the low bits of a plain LCG cycle too fast for % 4.
let r = (+(process.env.SEED || 1) * 0x9e3779b9) >>> 0;
const rnd = (n) => { r = (r + 0x6d2b79f5) >>> 0; let t = r; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (((t ^ (t >>> 14)) >>> 0) % n); };
const pick = (a) => a[rnd(a.length)];
const CH = [..."ab1 ", "\t", "́", "‍", "️", "︎", "⃣", "​", "\u{1f468}", "\u{1f3fb}", "❤", "\u{1f1eb}", "\u{1f1f7}", "中", "Ａ", "ᄀ", "ᅡ", "가", "क", "्", "ष", "ำ", "‮", "é", "─", "\u{1f600}", "©", "\r", "\n", "\u0000", "\u0085", "\ud83d"];
const E = "\x1b[";
const ESC = [E + "m", E + "0m", E + "1m", E + "2m", E + "22m", E + "31m", E + "39m", E + "1;31m", E + "38;5;196m", E + "48;2;1;2;3m", E + "4:3m", E + "1;300m", E + "5m", E + "6m", E + "10m", E + "7;27m", E + "38;5m", E + "01;031m", E + ";m", E + "31;m", E + "2K", E + "?25h", E + "31", "\x1b", "\x1b7", "\x1b(B", "\x18", "\x9b32m", "\x9d8;;http://c\x9c",
	"\x1b]8;;http://a\x07", "\x1b]8;;\x07", "\x1b]8;id=x;http://b\x1b\\", "\x1b]8;;\x1b\\", "\x1b]0;t\x07", "\x1b]8;;http://u", "\x1bPq\x1b\\", "\x1b_x\x07", "\x1b[3\x18", "\x1b]8;x\x07", "\x1b]8\x07",
	E + "38;5;77;48;5;22m", E + "48;5;22;38;5;77m", E + "39;49m", E + "49;39m", E + "48;5;52m", E + "38;5;231m", E + "39m" + E + "49m", E + "49m" + E + "39m", E + "1;38;5;2;48;5;3m", E + "22;39m", E + "0;38;5;9m"];
const randText = () => { let s = ""; const L = rnd(9); for (let i = 0; i < L; i++) s += rnd(4) === 0 ? pick(ESC) : pick(CH); return s; };
const eqArr = (a, b, n) => { for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; return true; };
const mk = (C, screen) => new C({ ambiguousIsNarrow: true, substitute: BIDI, ...(screen ? { screen: SCREEN } : {}) });
const stat = { segments: 0, cells: 0, paints: 0, paintsChanged: 0, wideAtEdge: 0, tabs: 0, setCells: 0, negX: 0, overflow: 0 };
let fails = 0; const report = (what, ...x) => { if (fails++ < 12) console.log("FAIL", what, ...x.map((v) => JSON.stringify(v))); };
const N = +(process.env.N || 20000);
for (let iter = 0; iter < N && fails < 12; iter++) {
	const withScreen = rnd(5) !== 0;
	const R = mk(Real, withScreen), M = mk(Mine, withScreen);
	const W = 1 + rnd(12), H = 2;
	const sR = new Int32Array(W * H * 2), sM = new Int32Array(W * H * 2);
	for (let step = 0; step < 6; step++) {
		const t = randText(), cap = rnd(8) === 0 ? 2 * rnd(4) : 128;
		const cR = new Int32Array(cap), rR = new Int32Array(cap), cM = new Int32Array(cap), rM = new Int32Array(cap);
		const reorder = false;
		const nR = R.segment(t, cR, rR, reorder), nM = M.segment(t, cM, rM, reorder);
		stat.segments++; if (nR < 0) stat.overflow++; else stat.cells += nR;
		if (nR !== nM) { report("count", t, cap, nR, nM); break; }
		if (nR > 0) {
			if (!eqArr(cR, cM, 2 * nR)) { report("cells", t, [...cR.slice(0, 2 * nR)], [...cM.slice(0, 2 * nR)]); break; }
			const runsN = 2 * ((cR[2 * nR - 1] >>> 10) + 1);
			if (!eqArr(rR, rM, runsN)) { report("runs", t, [...rR.slice(0, runsN)], [...rM.slice(0, runsN)]); break; }
		}
		if (nR < 0) break;   // overflow: pools may legitimately differ; start over
		for (const k of ["graphemes", "sgrKeys", "sgrCloseKeys", "uris"])
			if (JSON.stringify(R[k]) !== JSON.stringify(M[k])) { report("pool " + k, t, R[k].slice(-4), M[k].slice(-4)); break; }
		if (!withScreen || nR <= 0) continue;
		const charIdx = new Int32Array(R.graphemes.length).map((_, i) => 1000 + i);
		const words = new Int32Array(64).map((_, i) => ((3 + i) << 17) | ((i & 3) << 2));
		const x = rnd(W + 5) - 3, y = rnd(H);
		const before = [...sR]; stat.paints++; if (x < 0) stat.negX++; if (t.includes("\t")) stat.tabs++; if (/[中Ａ가\u{1f468}\u{1f600}]/u.test(t) && x >= W - 2) stat.wideAtEdge++;
		const pR = R.paint(sR, W, x, y, cR, nR, undefined, charIdx, words), pM = M.paint(sM, W, x, y, cM, nM, undefined, charIdx, words);
		if (!eqArr(before, sR, sR.length)) stat.paintsChanged++;
		if (pR !== pM || !eqArr(sR, sM, sR.length)) { report("paint", t, { W, x, y }, before, [...sR], [...sM], pR, pM); sM.set(sR); break; }
		if (rnd(3) === 0) {
			const cx = rnd(W + 2) - 1, cy = rnd(H), ch = 1000 + rnd(50), word = ((7 + rnd(5)) << 17) | rnd(4);
			stat.setCells++; const qR = R.setCell(sR, W, cx, cy, ch, word), qM = M.setCell(sM, W, cx, cy, ch, word);
			if (qR !== qM || !eqArr(sR, sM, sR.length)) { report("setCell", { W, cx, cy, ch, word }, [...sR], [...sM], qR, qM); sM.set(sR); break; }
		}
	}
}
console.log("seed", process.env.SEED || 1, "iterations", N, "failures", fails, JSON.stringify(stat));
