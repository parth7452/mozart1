#!/usr/bin/env python3
"""PreToolUse guard for the dashboard-builder subagent.

Keeps it inside .dashboard/ and its own memory folder, and lets it run `date`
and nothing else. A subagent's `tools` list names tools, not folders, so this is
what makes "only the dashboard" true. Exit 2 blocks the call; stderr goes back
to the agent. Tests: bash .claude/hooks/test/dashboard-guard.test.sh
"""
import json
import os
import re
import shlex
import sys


def block(msg):
    print(msg, file=sys.stderr)
    sys.exit(2)


try:
    data = json.load(sys.stdin)
except Exception:
    block("dashboard-guard: unreadable hook payload.")

tool = data.get("tool_name", "")
inp = data.get("tool_input") or {}
project = os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd") or os.getcwd()
allowed = [
    os.path.realpath(os.path.join(project, ".dashboard")),
    os.path.realpath(os.path.join(project, ".claude", "agent-memory", "dashboard-builder")),
]


def inside(p):
    if not p:
        return False
    full = os.path.realpath(os.path.join(project, os.path.expanduser(p)))
    return any(full == a or full.startswith(a + os.sep) for a in allowed)


# `date` to read the clock, never to set it: -s/--set, -f/--file and -r/--reference
# are not on the list. A format is `+` followed by strftime text only.
DATE_ARG = re.compile(
    r"-u|--utc|--universal|-R|--rfc-email"
    r"|-I(date|hours|minutes|seconds|ns)?"
    r"|--iso-8601(=(date|hours|minutes|seconds|ns))?"
    r"|--rfc-3339=(date|seconds|ns)"
    r"|\+[%A-Za-z0-9:_\-.,/ ]*"
)

if tool == "Bash":
    cmd = (inp.get("command") or "").strip()
    if re.search(r"[;&|`$<>(){}\\\n]", cmd):
        block("dashboard-builder may only run `date` (no shell operators).")
    try:
        argv = shlex.split(cmd)
    except ValueError:
        block("dashboard-builder may only run `date`.")
    if argv and argv[0] == "date" and all(DATE_ARG.fullmatch(a) for a in argv[1:]):
        sys.exit(0)
    block("dashboard-builder may only run `date` to read the clock.")

if tool == "Glob":
    pattern = inp.get("pattern") or ""
    if ".." in pattern or pattern.startswith(("/", "~")):
        block("Glob patterns must stay inside .dashboard/ or the agent's memory.")
    if not inside(inp.get("path")):
        block("Glob needs a path inside .dashboard/ or the agent's memory.")
    sys.exit(0)

if tool in ("Read", "Write", "Edit"):
    if inside(inp.get("file_path")):
        sys.exit(0)
    block("dashboard-builder may only touch .dashboard/ and .claude/agent-memory/dashboard-builder/.")

block(f"dashboard-builder may not use {tool or 'this tool'}.")
