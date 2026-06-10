"""Parallel ABC catalog sync — same fetch/flatten/upsert as abc_sync.py but
fans page fetches out over a thread pool (default 6 workers). The ABC items
API is paged and stateless, so pages are independent; upserts are idempotent
on item_number.

Checkpoint: abc_sync_parallel_checkpoint.json stores the set of completed
pages (not just a high-water mark), so a killed run resumes exactly. Seeds
from abc_sync.py's sequential checkpoint if present.

Usage: python abc_sync_parallel.py [--workers N]
"""
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import requests
from supabase import create_client

from abc_sync import (
    ABC_ITEMS_URL, ITEMS_PER_PAGE, SUPABASE_KEY, SUPABASE_URL,
    CHECKPOINT_FILE as SEQ_CHECKPOINT_FILE,
    flatten_item, get_token, log, should_refresh,
)

WORKERS = 6
if "--workers" in sys.argv:
    WORKERS = int(sys.argv[sys.argv.index("--workers") + 1])

PAR_CHECKPOINT_FILE = "abc_sync_parallel_checkpoint.json"

_token_lock = threading.Lock()
_token = None
_token_fetched_at = None

_state_lock = threading.Lock()
_done_pages: set[int] = set()
_total_pages: int | None = None

_thread_local = threading.local()


def current_token(force_refresh=False):
    global _token, _token_fetched_at
    with _token_lock:
        if _token is None or force_refresh or should_refresh(_token_fetched_at):
            _token, _token_fetched_at = get_token()
        return _token


def supabase_client():
    # One client per worker thread — sidesteps any shared-state questions in
    # supabase-py's sync client.
    if not hasattr(_thread_local, "sb"):
        _thread_local.sb = create_client(SUPABASE_URL, SUPABASE_KEY)
    return _thread_local.sb


def load_checkpoint():
    global _done_pages, _total_pages
    if os.path.exists(PAR_CHECKPOINT_FILE):
        with open(PAR_CHECKPOINT_FILE) as f:
            data = json.load(f)
        _done_pages = set(data.get("done_pages") or [])
        _total_pages = data.get("total_pages")
    elif os.path.exists(SEQ_CHECKPOINT_FILE):
        with open(SEQ_CHECKPOINT_FILE) as f:
            data = json.load(f)
        last = data.get("last_completed_page") or 0
        _done_pages = set(range(1, last + 1))
        _total_pages = data.get("total_pages")
        log(f"[resume] Seeded from sequential checkpoint: pages 1-{last} done")


def save_checkpoint():
    tmp = PAR_CHECKPOINT_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"done_pages": sorted(_done_pages), "total_pages": _total_pages}, f)
    os.replace(tmp, PAR_CHECKPOINT_FILE)


def fetch_page(page_number):
    backoff = 2
    while True:
        try:
            resp = requests.get(
                ABC_ITEMS_URL,
                headers={"Authorization": f"Bearer {current_token()}"},
                params={"pageNumber": page_number, "itemsPerPage": ITEMS_PER_PAGE},
                # Concurrent requests slow each other down server-side; a 120s
                # timeout made 6 workers starve (every request abandoned mid-
                # flight and retried, amplifying load). Be patient instead.
                timeout=420,
            )
        except requests.exceptions.RequestException as e:
            log(f"[warn] Network error on page {page_number}: {type(e).__name__}. Waiting {backoff}s...")
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)
            continue
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code == 401:
            current_token(force_refresh=True)
            continue
        if resp.status_code in (429, 500, 502, 503, 504):
            # 502s come in storms when the sandbox gateway is overloaded —
            # back off patiently rather than treating them as fatal.
            log(f"[warn] {resp.status_code} on page {page_number}. Waiting {backoff}s...")
            time.sleep(backoff)
            backoff = min(backoff * 2, 300)
            continue
        log(f"[error] Unexpected {resp.status_code} on page {page_number}: {resp.text[:300]}")
        resp.raise_for_status()


def process_page(page_number):
    global _total_pages
    data = fetch_page(page_number)
    items = data["items"]
    rows = [flatten_item(item) for item in items]

    backoff = 2
    while True:
        try:
            supabase_client().table("abc_items").upsert(rows, on_conflict="item_number").execute()
            break
        except Exception as e:
            log(f"[warn] Supabase error on page {page_number}: {type(e).__name__}: {e}. Waiting {backoff}s...")
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)

    with _state_lock:
        _total_pages = data["pagination"]["totalPages"]
        _done_pages.add(page_number)
        save_checkpoint()
        done = len(_done_pages)
    log(f"[ok] Page {page_number} — {len(rows)} items upserted ({done}/{_total_pages})")


def main():
    global _total_pages
    load_checkpoint()
    current_token()  # prime before workers start

    if _total_pages is None:
        # Need total page count — process page 1 inline first
        if 1 not in _done_pages:
            process_page(1)
        else:
            _total_pages = fetch_page(1)["pagination"]["totalPages"]

    remaining = [p for p in range(1, _total_pages + 1) if p not in _done_pages]
    log(f"[start] {len(remaining)} pages remaining of {_total_pages}, {WORKERS} workers")
    started = time.time()

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(process_page, p): p for p in remaining}
        for fut in as_completed(futures):
            fut.result()  # propagate unexpected exceptions

    elapsed = time.time() - started
    log(f"[done] Sync complete in {elapsed/60:.1f} min")
    for f in (PAR_CHECKPOINT_FILE, SEQ_CHECKPOINT_FILE):
        if os.path.exists(f):
            os.remove(f)


if __name__ == "__main__":
    main()
