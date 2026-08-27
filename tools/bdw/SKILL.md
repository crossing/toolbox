---
name: bdw
description: Run one Claude Code session per beads issue in its own tmux session, and harvest the session's conclusions back onto the bead when it ends. Use when starting work on a bead, resuming a bead whose session is stale or gone, listing which beads have live sessions, or writing a session's outcome onto its bead.
---

# bdw

One bead, one tmux session, one Claude session ID — recorded on the bead so the work
survives the terminal it was started in.

```
bdw <bead-id>             attach to its session, or start it if there is none
bdw start <bead-id>       claim the bead, open its tmux session, prime Claude
bdw attach <bead-id>      switch to (or attach) that bead's tmux session
bdw ls [--human]          beads with a bdw session, joined to live state
bdw finish <bead-id>      harvest conclusions onto the bead now
          [--close]       ...and close the bead
bdw hook                  SessionEnd hook entrypoint; reads hook JSON on stdin
```

## What it writes on the bead

The bead is the durable record; the state directory is only a cache.

| Where | What |
|---|---|
| `bdw_session` metadata | the Claude Code session ID, minted before launch |
| `bdw_tmux` metadata | the tmux session name (`bd-<id>`, with `.` and `:` flattened) |
| `bdw_cwd` metadata | the directory the session runs in |
| `bdw_host` metadata | the machine holding the transcript |
| `bdw_harvested` metadata | timestamp of the last harvest |
| `bdw` label | what `bdw ls` queries on |
| notes | one `## bdw session <id> (<ts>)` block per harvest, each optionally followed by `## bdw handoff` |

## Where the session runs

`dir` metadata is the one thing on the bead bdw *reads* rather than writes — the
directory the work lives in, declared by you:

```bash
bd update work-abc --set-metadata dir=~/works/home/home-ops
```

A subtask inherits it from the nearest ancestor that sets one, so an epic can name its
repository once and every `<epic>.<n>` under it opens there. `~` is expanded against
`$HOME`; a path that is not a directory on this machine is reported and ignored, because
a bead is shared between hosts and a path is not.

Resolution order is `bdw_cwd`, then `dir`, then the directory you ran bdw from. `bdw_cwd`
comes first on purpose: Claude Code files transcripts per directory, so a recorded
session can only be resumed from the directory it was started in.

## Starting and resuming

`bdw <bead-id>` with no subcommand is `bdw start`, which is the only entry point you
need; it decides what to do:

1. **tmux session already live** → attaches, changes nothing.
2. **`bdw_session` recorded and `bdw_host` is this machine** → `claude --resume`, so the
   full transcript comes back.
3. **otherwise** (never started, transcript expired, or the session belongs to another
   host) → a fresh Claude session primed with the bead's title, description, design,
   notes, and the **last handoff block** from the notes.

That third case is the point of the handoff: a bead is resumable even when its
transcript is not. Nothing is lost that the harvest wrote down.

`bdw start` claims the bead (`bd update --claim`: assignee you, status `in_progress`)
only when it actually launches something.

## Harvesting

The harvest re-reads the ended session's own transcript and writes the conclusion onto
the bead. It runs with `--tools ""` (a pure summarisation pass, no tool access) and
`--fork-session` (so it never appends to the transcript it is reading).

It asks for `{"summary", "handoff", "done"}`. If the model answers with prose instead,
the prose is kept as the summary rather than the harvest being lost.

Because the hook fires *at* `SessionEnd`, the session being read may still be shutting
down; the first attempt can come back with a plain-text complaint instead of the wrapper
JSON. bdw retries three times (5s, then 10s — `BDW_RETRY_DELAY` scales it) and, if all
three fail, writes a "Harvest failed" note rather than failing silently.

**The automatic harvest never closes a bead.** A session ending is not the same as work
being finished — you quit, you `/clear`, you log out. Closing is a decision:

```bash
bdw finish work-abc --close
```

## Wiring the automatic harvest

`bdw hook` is a `SessionEnd` hook. It resolves the bead from a reverse index (O(1), well
inside the hook budget) and detaches the real work with `setsid`:

```json
{
  "hooks": {
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "bdw hook" } ] }
    ]
  }
}
```

It exits 0 and silent for any session bdw did not start, so it is safe to install
globally. `BDW_HARVEST=1` is set for the harvest's own Claude invocation, which is what
stops the harvester harvesting itself.

## Limits

- **No worktree.** The session runs in `bdw_cwd`, which is wherever `dir` or your shell
  pointed at the first time. Two beads started in the same checkout share a working tree
  and will collide. Point the second one's `dir` at a `git worktree` you made yourself.
- **Transcripts are per-machine and expire.** That is what the handoff is for; expect
  case 3 above rather than treating it as a failure.
- **`bd`, `claude` and `tmux` come from the ambient PATH**, deliberately — see the note
  in `package.nix`. Absent, bdw fails with a plain "command not found".
- **The harvest costs a model call** per session end, on the session's own quota.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success; also every `bdw hook` outcome, including "not a bdw session" |
| 1 | the bead does not exist, has no session to harvest, or `bd`/`tmux` refused |
| 2 | usage error, including a first word that is neither a subcommand nor a bead |
