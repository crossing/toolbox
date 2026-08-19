"""Read/write classification: default deny.

A tool call is a read only if its positional argv matches an entry in the toolset's
read allowlist. Anything else -- unknown subcommands, misspellings, new verbs -- is
a write and becomes a plan. There is deliberately no write blocklist: a missed
entry must fail closed (a plan a human reviews), never execute.

Matching ignores flag tokens (anything starting with ``-``). A flag's *separate*
value is not removed; if such a value lands inside the pattern window the call
simply fails to match and is treated as a write, which errs closed. For gws and
freeagent, mutation is always expressed in a positional verb (create/update/
delete/approve/...), never in a flag, so ignoring flags cannot turn a write into
a read.

A pattern is a list of tokens matched as a *prefix* of the positional argv; ``*``
matches exactly one token. Trailing positionals beyond the pattern are arguments
to the matched read verb (ids, queries), not further subcommands.
"""

from __future__ import annotations


def positionals(argv: list[str]) -> list[str]:
    """Drop flag tokens; keep everything else in order."""
    return [token for token in argv if not token.startswith("-")]


def matches(pattern: list[str], positional_argv: list[str]) -> bool:
    """True when `pattern` is a wildcard-aware prefix of the positional argv."""
    if not pattern or len(positional_argv) < len(pattern):
        return False
    return all(
        expected == "*" or expected == token
        for expected, token in zip(pattern, positional_argv)
    )


def is_read(argv: list[str], read_allowlist: list[list[str]]) -> bool:
    """Default deny: only an allowlist match makes this call a read."""
    tokens = positionals(argv)
    if not tokens:
        return False
    return any(matches(pattern, tokens) for pattern in read_allowlist)
