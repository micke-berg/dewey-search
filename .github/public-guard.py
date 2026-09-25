#!/usr/bin/env python3
"""public-guard: block private words from reaching a repository or GitHub.

One scanner behind every layer: git hooks (pre-commit, commit-msg, pre-push),
the `gh` wrapper, and the GitHub Actions check. It reads a private list of
words and patterns (never stored in a repo) and exits non-zero when any of
them appears in the text it is given.

Usage
  public-guard text [FILE ...]        scan files, or stdin when none given
  public-guard staged                 scan what `git commit` is about to record
  public-guard commits RANGE          scan commits in RANGE: messages, added lines, file names
  public-guard tree [REF]             scan every tracked file at REF (default HEAD)
  public-guard check-list             show how many entries the list has

Options
  --list PATH   the list (default: $PUBLIC_GUARD_LIST, else ~/.config/public-guard/denylist.txt)
  --redact      never print the matched word or line, only where and which entry number
                (for public CI logs). The list can also come from $PUBLIC_GUARD_LIST_TEXT.

List format: one entry per line, # comments.
  Term        whole word or phrase, any case
  =Term       whole word or phrase, exact case
  re:pattern  regular expression, any case

Exit codes: 0 clean, 1 something matched, 2 the list is missing or unreadable
(fails closed: no list means nothing gets through).

Verified with a clean scan before 2026-09-25; no private words live in this file.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

DEFAULT_LIST = Path.home() / ".config" / "public-guard" / "denylist.txt"
WORD = r"[\w]"


def load_entries(list_path: str | None) -> list[tuple[int, str, re.Pattern[str]]]:
    text = os.environ.get("PUBLIC_GUARD_LIST_TEXT")
    if not text:
        path = Path(list_path or os.environ.get("PUBLIC_GUARD_LIST") or DEFAULT_LIST).expanduser()
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            print(
                f"public-guard: the private word list is missing ({path}). Blocking, because an unchecked "
                "push or post is exactly what this exists to stop.",
                file=sys.stderr,
            )
            sys.exit(2)
    entries: list[tuple[int, str, re.Pattern[str]]] = []
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        try:
            if line.startswith("re:"):
                pattern = re.compile(line[3:], re.IGNORECASE)
            elif line.startswith("="):
                pattern = re.compile(rf"(?<!{WORD}){re.escape(line[1:])}(?!{WORD})")
            else:
                pattern = re.compile(rf"(?<!{WORD}){re.escape(line)}(?!{WORD})", re.IGNORECASE)
        except re.error as error:
            print(f"public-guard: list line {number} is not a valid pattern ({error}). Blocking.", file=sys.stderr)
            sys.exit(2)
        entries.append((number, line, pattern))
    if not entries:
        print("public-guard: the word list is empty. Blocking.", file=sys.stderr)
        sys.exit(2)
    return entries


def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True, errors="replace").stdout


class Scanner:
    def __init__(self, entries: list[tuple[int, str, re.Pattern[str]]], redact: bool) -> None:
        self.entries = entries
        self.redact = redact
        self.hits = 0

    def scan(self, where: str, text: str) -> None:
        for line_no, line in enumerate(text.splitlines(), 1):
            for number, entry, pattern in self.entries:
                match = pattern.search(line)
                if not match:
                    continue
                self.hits += 1
                if self.redact:
                    print(f"  {where}, line {line_no}: matches private list entry on list line {number}")
                else:
                    shown = line.strip()
                    if len(shown) > 160:
                        start = max(0, match.start() - 60)
                        shown = "…" + line[start : start + 150].strip() + "…"
                    print(f"  {where}:{line_no}  [{entry}]  {shown}")

    def diff(self, where: str, patch: str) -> None:
        """Added lines and file names from a unified diff."""
        current = where
        added: list[str] = []

        def flush() -> None:
            if added:
                self.scan(current, "\n".join(added))
                added.clear()

        for line in patch.splitlines():
            if line.startswith("+++ "):
                flush()
                name = line[4:].removeprefix("b/")
                current = f"{where} {name}" if where else name
                if name != "/dev/null":
                    self.scan(f"{current} (file name)", name)
            elif line.startswith("rename to "):
                self.scan(f"{where} (renamed file)", line[len("rename to ") :])
            elif line.startswith("+") and not line.startswith("+++"):
                added.append(line[1:])
        flush()


def main(argv: list[str]) -> int:
    args = list(argv)
    list_path = None
    redact = False
    if "--list" in args:
        i = args.index("--list")
        list_path = args[i + 1]
        del args[i : i + 2]
    if "--redact" in args:
        args.remove("--redact")
        redact = True
    if not args:
        print(__doc__)
        return 2

    command, rest = args[0], args[1:]
    scanner = Scanner(load_entries(list_path), redact)

    if command == "check-list":
        print(f"public-guard: {len(scanner.entries)} entries loaded.")
        return 0
    if command == "text":
        if rest:
            for name in rest:
                scanner.scan(name, Path(name).read_text(encoding="utf-8", errors="replace"))
        else:
            scanner.scan("text", sys.stdin.read())
    elif command == "staged":
        scanner.diff("staged", git("diff", "--cached", "-U0", "--no-color", "--no-ext-diff", "-M"))
    elif command == "commits":
        if not rest:
            print("public-guard commits needs a range, e.g. origin/main..HEAD", file=sys.stderr)
            return 2
        for sha in git("rev-list", "--reverse", rest[0]).split():
            short = sha[:8]
            scanner.scan(f"commit {short} message", git("log", "-1", "--format=%an%n%ae%n%B", sha))
            scanner.diff(f"commit {short}", git("show", "-U0", "--no-color", "--format=", "-M", sha))
    elif command == "tree":
        ref = rest[0] if rest else "HEAD"
        for name in git("ls-tree", "-r", "--name-only", ref).splitlines():
            scanner.scan(f"{name} (file name)", name)
            blob = subprocess.run(["git", "show", f"{ref}:{name}"], capture_output=True).stdout
            if b"\0" in blob[:8000]:
                continue
            scanner.scan(name, blob.decode("utf-8", errors="replace"))
    else:
        print(f"public-guard: unknown command {command!r}", file=sys.stderr)
        return 2

    if scanner.hits:
        print(
            f"public-guard: {scanner.hits} match(es) with the private word list. Remove them; nothing private "
            "goes into a repository, a commit message, a PR, an issue or a comment.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
