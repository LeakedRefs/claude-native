#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Rob Kubicki
"""Graft JavaScript files onto a Bun 1.4.4 --compile runtime (host-side tool).

Usage: oracle.py <runtime-exe> <out-exe> <entry.js> [more.js ...]

Modules are named /$bunfs/root/<basename>, so relative imports between the
given files resolve by file name.

Builds a module graph from the given ESM files (entry first) and swaps it
into the runtime's .bun payload, as regraft.js does. Used to run test
programs on Anthropic's Linux runtime, which has the real Bun.ant.
"""
import os, struct, sys

TRAILER = b"\n---- Bun! ----\n"
PAGE = 0x1000
LOADER_JS, FMT_ESM, ENC_LATIN1, ENC_UTF16 = 1, 1, 1, 2


def graph(files):
    out = bytearray()
    recs = []
    for path in files:
        src = open(path, "rb").read().decode("utf-8")
        if src.isascii():
            body, enc = src.encode("ascii"), ENC_LATIN1
        else:
            if len(out) & 1:
                out += b"\0"
            body, enc = src.encode("utf-16-le"), ENC_UTF16
        recs.append({"contents": (len(out), len(body)), "enc": enc,
                     "name": "/$bunfs/root/" + os.path.basename(path)})
        out += body + (b"\0\0" if enc == ENC_UTF16 else b"\0")
    for r in recs:
        n = r["name"].encode()
        r["nameptr"] = (len(out), len(n))
        out += n + b"\0"
    mod_off = len(out)
    for r in recs:
        out += struct.pack("<" + "II" * 6 + "BBBB", *r["nameptr"], *r["contents"],
                           0, 0, 0, 0, 0, 0, 0, 0, r["enc"], LOADER_JS, FMT_ESM, 0)
    mod_len = len(out) - mod_off
    argv_off = len(out)
    out += b"\0"
    total = len(out) + 32 + len(TRAILER)
    out += struct.pack("<QIIIIII", total, mod_off, mod_len, 0, argv_off, 0, 0)
    out += TRAILER
    return bytes(out)


def replace_payload(exe, payload):
    b = bytearray(open(exe, "rb").read())
    phoff, shoff = struct.unpack_from("<QQ", b, 0x20)
    phentsize, phnum, shentsize, shnum, shstrndx = struct.unpack_from("<HHHHH", b, 0x36)
    sh = lambda i: struct.unpack_from("<IIQQQQIIQQ", b, shoff + i * shentsize)
    st = sh(shstrndx)[4]
    for i in range(shnum):
        s = sh(i)
        if b[st + s[0]:b.index(b"\0", st + s[0])] == b".bun":
            idx, addr, off, size = i, s[3], s[4], s[5]
    for i in range(phnum):
        at = phoff + i * phentsize
        t, fl, o, va, pa, fs, ms, al = struct.unpack_from("<IIQQQQQQ", b, at)
        if t == 1 and fl & 2 and va <= addr < va + ms:
            rw = (at, o, va, fs)
    rw_at, rw_off, rw_va, rw_fs = rw
    assert addr % PAGE == 0 and rw_off + rw_fs == off + -(-size // PAGE) * PAGE
    content = 8 + len(payload)
    aligned = -(-content // PAGE) * PAGE
    tail = bytes(b[rw_off + rw_fs:])
    out = bytearray(b[:off]) + struct.pack("<Q", len(payload)) + payload
    out += b"\0" * (off + aligned - len(out)) + tail
    shift = off + aligned - (rw_off + rw_fs)
    new_shoff = shoff + shift
    struct.pack_into("<Q", out, 0x28, new_shoff)
    for i in range(shnum):
        at = new_shoff + i * shentsize
        typ, = struct.unpack_from("<I", out, at + 4)
        so, = struct.unpack_from("<Q", out, at + 24)
        if i == idx:
            struct.pack_into("<Q", out, at + 32, content)
        elif typ != 8 and so >= rw_off + rw_fs:
            struct.pack_into("<Q", out, at + 24, so + shift)
    seg = addr - rw_va + aligned
    struct.pack_into("<QQ", out, rw_at + 32, seg, seg)
    return bytes(out)


runtime, dst, files = sys.argv[1], sys.argv[2], sys.argv[3:]
open(dst, "wb").write(replace_payload(runtime, graph(files)))
os.chmod(dst, 0o755)
