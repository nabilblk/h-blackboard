"""Bounded, process-local access to already authorized large tool replies.

No files or credentials are read. Entries expire with the MCP process or after
ten minutes. The caller must recheck current execution permission on every read.
"""
from collections import OrderedDict
import json
import re
import time
import uuid

INLINE_BYTES = 6000
PAGE_CHARS = 3000
MAX_BYTES = 4 * 1024 * 1024
MAX_ENTRY = 1024 * 1024
MAX_ENTRIES = 8
TTL_SECONDS = 600


class ResultCache:
    def __init__(self, clock=time.monotonic, delivered=None):
        self.clock = clock
        self.entries = OrderedDict()
        self.delivered = delivered
        self.delivery = {}
        self.coverage = {}

    def prune(self):
        now = self.clock()
        for key, (expires, _) in list(self.entries.items()):
            if expires <= now:
                del self.entries[key]
        self.delivery = {k:v for k,v in self.delivery.items() if k in self.entries}
        self.coverage = {k:v for k,v in self.coverage.items() if k[0] in self.entries}

    def present(self, value):
        value = dict(value)
        receipt = value.pop("_delivery", None)
        raw = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
        if len(raw) <= INLINE_BYTES or "error" in value:
            if receipt and self.delivered:
                self.delivered(receipt["token"], [""])
            return value
        if len(raw) > MAX_ENTRY:
            raise ValueError("Board reply exceeds the result cache; use narrower scoped queries")
        self.prune()
        while self.entries and (len(self.entries) >= MAX_ENTRIES or
                                sum(len(v[1]) for v in self.entries.values()) + len(raw) > MAX_BYTES):
            self.entries.popitem(last=False)
        key = uuid.uuid4().hex
        self.entries[key] = (self.clock() + TTL_SECONDS, raw)
        self.prune()
        if receipt:
            self.delivery[key] = receipt["token"]
        return {
            "paged_result": True, "result_id": key, "characters": len(raw),
            "root_keys": list(value)[:64],
            "instruction": "This complete reply is saved in the scoped tool cache, not a file. "
                           "Call read_tool_result with result_id and a JSON pointer, e.g. /context, "
                           "/main/items, /context/lifecycle/plan/text, or an empty pointer for all data. "
                           "Follow next_offset until null. Each text chunk is part of JSON. "
                           "Read required context before acting. This is captured data, not fresh authority. "
                           "The cache holds at most 8 replies for 10 minutes and resets between turns; "
                           "refresh the scoped query if an entry expires.",
        }

    def read(self, args):
        if (not isinstance(args, dict) or set(args) - {"result_id", "pointer", "offset"}
                or not isinstance(args.get("result_id"), str)
                or not re.fullmatch(r"[0-9a-f]{32}", args["result_id"])):
            raise ValueError("Use a result_id returned by a paged board reply")
        pointer, offset = args.get("pointer", ""), args.get("offset", 0)
        if (not isinstance(pointer, str) or len(pointer) > 1024
                or (pointer and not pointer.startswith("/"))
                or re.search(r"~(?![01])", pointer)
                or type(offset) is not int or offset < 0 or offset > MAX_ENTRY):
            raise ValueError("Use a JSON pointer and a nonnegative character offset")
        self.prune()
        entry = self.entries.get(args["result_id"])
        if not entry:
            raise ValueError("Saved tool reply expired or is unavailable; refresh the scoped board query")
        value = json.loads(entry[1])
        for part in pointer.split("/")[1:] if pointer else []:
            key = part.replace("~1", "/").replace("~0", "~")
            if isinstance(value, dict) and key in value:
                value = value[key]
            elif isinstance(value, list):
                if not re.fullmatch(r"0|[1-9][0-9]*", key) or int(key) >= len(value):
                    raise ValueError(f"Saved array has {len(value)} items; read its container before choosing a zero-based index")
                value = value[int(key)]
            else:
                raise ValueError("That JSON pointer is absent from this saved reply")
        raw = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
        if offset > len(raw):
            raise ValueError(f"Offset exceeds this saved value's {len(raw)} characters; use the returned next_offset")
        end = min(len(raw), offset + PAGE_CHARS)
        key = (args["result_id"], pointer)
        if key not in self.coverage and len(self.coverage) >= 512:
            # Bound adversarial pointer fan-out. Eviction only permits a
            # duplicate delivery; it never acknowledges omitted content.
            self.coverage.pop(next(iter(self.coverage)))
        ranges = sorted([*self.coverage.get(key, []), (offset, end)])
        merged = []
        for start, stop in ranges:
            if merged and start <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(stop, merged[-1][1]))
            else:
                merged.append((start, stop))
        # At most 256 disjoint ranges; dropping excess coverage can cause a
        # repeated delivery, never a false claim that unseen content was read.
        self.coverage[key] = merged[:256]
        token = self.delivery.get(args["result_id"])
        if token and self.delivered and merged == [(0, len(raw))]:
            self.delivered(token, [pointer])
        shape = {"value_type": "array", "item_count": len(value)} if isinstance(value, list) else {}
        return {"result_id": args["result_id"], "pointer": pointer, "offset": offset,
                "text": raw[offset:end], "next_offset": end if end < len(raw) else None,
                "total_characters": len(raw), "captured": True, **shape}
