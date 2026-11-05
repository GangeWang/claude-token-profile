#!/usr/bin/env python3
"""Fold Claude Code transcripts into a local ledger and print a usage report.

Transcripts in ~/.claude/projects get cleaned up over time, so every message
is copied into a SQLite ledger: lifetime totals keep what the transcripts lose.
Only token counts, timestamps, model and folder names are stored, never text.
"""
import base64
import datetime as dt
import json
import os
import random
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import uuid
from collections import defaultdict
from pathlib import Path

HOME = Path.home()


def web_cache_dir():
    """The desktop app's web cache, wherever this system's install keeps it."""
    if sys.platform == "darwin":
        roots = [HOME / "Library" / "Application Support" / "Claude"]
    elif sys.platform == "win32":
        local = Path(os.environ.get("LOCALAPPDATA") or HOME / "AppData" / "Local")
        roaming = Path(os.environ.get("APPDATA") or HOME / "AppData" / "Roaming")
        roots = [*local.glob("Claude-Data/claude_*"), roaming / "Claude"]
    else:
        roots = [Path(os.environ.get("XDG_CONFIG_HOME") or HOME / ".config") / "Claude"]
    caches = [root / "Cache" / "Cache_Data" for root in roots]
    return next((cache for cache in caches if cache.is_dir()), caches[0])


CUSTOM_CONFIG = os.environ.get("CLAUDE_CONFIG_DIR")
CONFIG = Path(CUSTOM_CONFIG) if CUSTOM_CONFIG else HOME / ".claude"
ACCOUNT_FILE = (CONFIG if CUSTOM_CONFIG else HOME) / ".claude.json"
PROJECTS = CONFIG / "projects"
DATA = CONFIG / "token-profile"
LEDGER = DATA / "usage.sqlite"
OWN_AVATAR = DATA / "avatar.webp"
MACHINE_ID = DATA / "machine-id"
# The latest report, for every open conversation to follow.
SHARED_REPORT = DATA / "report.json"
# A git clone every computer shares; without one this computer stands alone.
SYNC = DATA / "sync"
SYNC_STATUS = DATA / "last-sync"
SYNC_EVERY_S = 10 * 60
GIT_TIMEOUT_S = 30
PUSH_TRIES = 4
# Past every git's timeout, so no running git can still own the lock.
STALE_LOCK_S = 2 * GIT_TIMEOUT_S
# Commits work on a computer with no git identity of its own.
GIT_IDENTITY = {
    "GIT_AUTHOR_NAME": "token-profile",
    "GIT_AUTHOR_EMAIL": "token-profile@users.noreply.github.com",
    "GIT_COMMITTER_NAME": "token-profile",
    "GIT_COMMITTER_EMAIL": "token-profile@users.noreply.github.com",
}
WEB_CACHE = web_cache_dir()
WORKTREE = re.compile(r"[\\/]\.claude[\\/]worktrees[\\/]")
AVATAR_CHECK_S = 24 * 60 * 60
# A longer silence inside a task is waiting on the person, not working.
IDLE_GAP_MS = 30 * 60 * 1000

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, size INT, mtime REAL);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, ts TEXT, model TEXT, project TEXT,
  input INT, cache_write INT, cache_read INT, output INT);
CREATE TABLE IF NOT EXISTS tasks (
  session TEXT, start_ts TEXT, active_ms INT, project TEXT,
  PRIMARY KEY (session, start_ts));
"""

# A message is logged once per content block, so one id spans several rows.
UPSERT_MESSAGE = """
INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  input = max(input, excluded.input),
  cache_write = max(cache_write, excluded.cache_write),
  cache_read = max(cache_read, excluded.cache_read),
  output = max(output, excluded.output)
"""


def parse_ts(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def project_name(cwd):
    if not cwd:
        return "未知"
    if "scratch-workspaces" in cwd:
        return "臨時工作區"
    repo = WORKTREE.split(cwd)[0].rstrip("\\/")
    return "~" if repo == str(HOME) else re.split(r"[\\/]", repo)[-1]


def is_prompt(row):
    """Whether a person started a task here; a background job's report does not."""
    if row["type"] != "user" or row.get("isMeta"):
        return False
    origin = row.get("turnOrigin")
    if origin:
        return origin in ("human", "sdk")
    content = (row.get("message") or {}).get("content")
    return not (
        isinstance(content, list)
        and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)
    )


def scan_file(db, path):
    session = path.stem
    task = None

    def close_task():
        if task and task["active_ms"] > 0:
            db.execute(
                "INSERT OR REPLACE INTO tasks VALUES (?, ?, ?, ?)",
                (session, task["start_ts"], task["active_ms"], task["project"]),
            )

    with path.open(encoding="utf-8", errors="replace") as lines:
        for line in lines:
            if '"type":"assistant"' not in line and '"type":"user"' not in line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue  # a line still being written
            ts = row.get("timestamp")
            if row.get("type") not in ("assistant", "user") or not ts:
                continue
            at = parse_ts(ts)
            project = project_name(row.get("cwd"))

            if is_prompt(row):
                close_task()
                task = {"start_ts": ts, "last": at, "active_ms": 0, "project": project}
            elif task:
                gap_ms = (at - task["last"]).total_seconds() * 1000
                if 0 < gap_ms <= IDLE_GAP_MS:
                    task["active_ms"] += int(gap_ms)
                task["last"] = max(at, task["last"])

            message = row.get("message") or {}
            usage = message.get("usage")
            model = message.get("model")
            if row["type"] != "assistant" or not usage or model == "<synthetic>":
                continue
            db.execute(
                UPSERT_MESSAGE,
                (
                    message.get("id") or row.get("uuid"),
                    ts,
                    model,
                    project,
                    usage.get("input_tokens") or 0,
                    usage.get("cache_creation_input_tokens") or 0,
                    usage.get("cache_read_input_tokens") or 0,
                    usage.get("output_tokens") or 0,
                ),
            )
    close_task()


def update_ledger(db):
    known = {p: (s, m) for p, s, m in db.execute("SELECT path, size, mtime FROM files")}
    for path in PROJECTS.glob("*/*.jsonl"):
        stat = path.stat()
        if known.get(str(path)) == (stat.st_size, stat.st_mtime):
            continue
        scan_file(db, path)
        db.execute(
            "INSERT OR REPLACE INTO files VALUES (?, ?, ?)",
            (str(path), stat.st_size, stat.st_mtime),
        )
    db.commit()


def streaks(days, today):
    """Longest run of used days, and the run still alive today or yesterday."""
    longest = run = 0
    previous = None
    for day in sorted(days):
        run = run + 1 if previous and day - previous == dt.timedelta(days=1) else 1
        longest = max(longest, run)
        previous = day
    alive = previous is not None and today - previous <= dt.timedelta(days=1)
    return longest, run if alive else 0


def ranked(totals, limit):
    top = sorted(totals.items(), key=lambda item: -item[1])
    rows = [{"name": name, "tokens": tokens} for name, tokens in top[:limit]]
    rest = sum(tokens for _, tokens in top[limit:])
    return rows + ([{"name": "其他", "tokens": rest}] if rest else [])


def signed_in_account():
    try:
        return json.loads(ACCOUNT_FILE.read_text(encoding="utf-8"))["oauthAccount"]
    except (OSError, ValueError, KeyError):
        return {}


def cached_avatar(account_id):
    """The newest copy of the account's picture in the app's web cache, as WebP."""
    needle = f"/api/account_avatar/{account_id}/".encode()
    entries = [entry for entry in os.scandir(WEB_CACHE) if entry.is_file()]
    for entry in sorted(entries, key=lambda e: e.stat().st_mtime, reverse=True):
        try:
            data = Path(entry.path).read_bytes()
        except OSError:
            continue  # the app evicted it mid-scan
        start = data.find(b"RIFF")
        if needle in data and start >= 0 and data[start + 8 : start + 12] == b"WEBP":
            size = int.from_bytes(data[start + 4 : start + 8], "little") + 8
            return data[start : start + size]
    return None


def shared_avatar(account_id):
    return SYNC / f"avatar-{account_id}.webp"


def avatar(account_id):
    """The account's picture as base64 WebP; a saved copy outlives the cache.

    Windows locks the cache index while the app runs, so a computer that cannot
    read its own cache shows the copy another computer of this account shared.
    """
    saved = OWN_AVATAR
    if not saved.exists() or time.time() - saved.stat().st_mtime > AVATAR_CHECK_S:
        picture = cached_avatar(account_id) if account_id and WEB_CACHE.is_dir() else None
        if picture:
            saved.write_bytes(picture)
        elif saved.exists():
            saved.touch()
    picture = saved if saved.exists() else shared_avatar(account_id)
    return base64.b64encode(picture.read_bytes()).decode() if picture.exists() else None


def local_usage(db):
    """This computer's tokens per day, model and project, in a stable order."""
    totals = defaultdict(lambda: [0, 0, 0, 0])
    rows = db.execute(
        "SELECT ts, model, project, input, cache_write, cache_read, output FROM messages"
    )
    for ts, model, project, *tokens in rows:
        day = parse_ts(ts).astimezone().date().isoformat()
        kept = totals[day, model, project]
        for index, count in enumerate(tokens):
            kept[index] += count
    return [[*key, *tokens] for key, tokens in sorted(totals.items())]


def own_record(db):
    task = db.execute(
        "SELECT active_ms, project FROM tasks ORDER BY active_ms DESC LIMIT 1"
    ).fetchone()
    return {
        "name": socket.gethostname().split(".")[0],
        "usage": local_usage(db),
        "longestTask": {
            "ms": task[0] if task else 0,
            "project": task[1] if task else None,
        },
    }


def machine_id():
    if not MACHINE_ID.exists():
        MACHINE_ID.write_text(uuid.uuid4().hex, encoding="utf-8")
    return MACHINE_ID.read_text(encoding="utf-8").strip()


def run_git(*args):
    return subprocess.run(
        ["git", "-C", str(SYNC), *args],
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=GIT_TIMEOUT_S,
        env={
            **os.environ,
            **GIT_IDENTITY,
            "GIT_TERMINAL_PROMPT": "0",
            "GCM_INTERACTIVE": "never",
        },
    )


def git(*args):
    ran = run_git(*args)
    if ran.returncode != 0:
        lines = ran.stderr.strip().splitlines() or [f"git {args[0]} failed"]
        raise RuntimeError(next((l for l in lines if l.startswith(("fatal", "error"))), lines[0]))


def clear_interrupted_git():
    """A killed git leaves these behind, and every later sync would fail on them."""
    repo = SYNC / ".git"
    lock = repo / "index.lock"
    if lock.exists() and time.time() - lock.stat().st_mtime > STALE_LOCK_S:
        lock.unlink()
    for leftover in (repo / "rebase-merge", repo / "rebase-apply"):
        if leftover.exists():
            run_git("rebase", "--abort")
            shutil.rmtree(leftover, ignore_errors=True)


def share(record):
    """Publish this computer's file over the latest of everyone else's.

    The file is rebuilt whole from the ledger, so nothing local needs keeping:
    start from the remote each try, and a rejected push just tries again.
    """
    clear_interrupted_git()
    mine = SYNC / f"{machine_id()}.json"
    account_id = signed_in_account().get("accountUuid")
    for attempt in range(PUSH_TRIES):
        git("fetch")
        git("reset", "--hard", "@{upstream}")
        mine.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        # Only a computer that read its own cache shares, so a copy never overwrites it.
        if account_id and OWN_AVATAR.exists():
            shutil.copyfile(OWN_AVATAR, shared_avatar(account_id))
        git("add", "-A")
        if run_git("diff", "--cached", "--quiet").returncode == 0:
            return
        git("commit", "-m", f"Update {record['name']}")
        if attempt == PUSH_TRIES - 1:
            git("push")
        elif run_git("push").returncode == 0:
            return
        time.sleep(random.uniform(0.2, 1.5))  # another computer pushed first


def all_records(record):
    """Every computer's record, with this one's always current, and any sync failure."""
    if not (SYNC / ".git").exists():
        return [record], None

    age = time.time() - SYNC_STATUS.stat().st_mtime if SYNC_STATUS.exists() else SYNC_EVERY_S
    if age >= SYNC_EVERY_S:
        SYNC_STATUS.touch()  # keeps a session starting now from syncing too
        try:
            share(record)
            problem = ""
        except (OSError, RuntimeError, subprocess.SubprocessError) as failure:
            problem = str(failure)
        SYNC_STATUS.write_text(problem, encoding="utf-8")

    records = [record]
    for path in SYNC.glob("*.json"):
        if path.stem == machine_id():
            continue
        try:
            records.append(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            continue  # a file git is replacing right now
    return records, SYNC_STATUS.read_text(encoding="utf-8") or None


def build_report(records, sync_error):
    days = defaultdict(int)
    models = defaultdict(int)
    projects = defaultdict(int)
    machines = defaultdict(int)
    parts = {"input": 0, "output": 0, "cacheWrite": 0, "cacheRead": 0}

    for record in records:
        for day, model, project, tokens_in, write, read, tokens_out in record["usage"]:
            total = tokens_in + write + read + tokens_out
            days[dt.date.fromisoformat(day)] += total
            models[model] += total
            projects[project] += total
            machines[record["name"]] += total
            parts["input"] += tokens_in
            parts["output"] += tokens_out
            parts["cacheWrite"] += write
            parts["cacheRead"] += read

    account = signed_in_account()
    today = dt.date.today()
    longest, current = streaks(days, today)
    peak_day = max(days, key=days.get, default=None)
    task = max((record["longestTask"] for record in records), key=lambda one: one["ms"])

    return {
        "name": account.get("displayName") or "Claude Code",
        "avatar": avatar(account.get("accountUuid")),
        "today": today.isoformat(),
        "firstDay": min(days).isoformat() if days else None,
        "lifetime": sum(parts.values()),
        "parts": parts,
        "peak": {
            "day": peak_day.isoformat() if peak_day else None,
            "tokens": days[peak_day] if peak_day else 0,
        },
        "longestTask": task,
        "longestStreak": longest,
        "currentStreak": current,
        "days": {day.isoformat(): tokens for day, tokens in sorted(days.items())},
        "models": ranked(models, 4),
        "projects": ranked(projects, 5),
        "machines": ranked(machines, 8),
        "syncError": sync_error,
        "dataDir": str(DATA),
    }


def share_report(text):
    """Replace the file whole, so a conversation never reads half of it."""
    draft = SHARED_REPORT.with_name(f"report-{os.getpid()}.tmp")
    try:
        draft.write_text(text, encoding="utf-8")
        os.replace(draft, SHARED_REPORT)
    except OSError:
        pass  # a reader holds it open; the next run replaces it


def main():
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(LEDGER, timeout=30)
    db.executescript(SCHEMA)
    update_ledger(db)
    records, sync_error = all_records(own_record(db))
    text = json.dumps(build_report(records, sync_error), ensure_ascii=False)
    share_report(text)
    sys.stdout.reconfigure(encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
