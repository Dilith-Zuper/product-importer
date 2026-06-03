import requests
import time
import json
import os
from datetime import datetime, timezone
from supabase import create_client
import httpx

# ── Load .env ─────────────────────────────────────────────
def _load_env(path=".env"):
    env = {}
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, _, v = line.partition("=")
                    env[k.strip()] = v.strip()
    return env

_env = _load_env()

# ── CONFIG ────────────────────────────────────────────────
SUPABASE_URL = _env.get("SUPABASE_URL") or os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = _env.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_SERVICE_KEY", "")

ABC_CLIENT_ID     = _env.get("ABC_CLIENT_ID")     or os.environ.get("ABC_CLIENT_ID", "")
ABC_CLIENT_SECRET = _env.get("ABC_CLIENT_SECRET") or os.environ.get("ABC_CLIENT_SECRET", "")
ABC_TOKEN_URL     = "https://sandbox.auth.partners.abcsupply.com/oauth2/aus1vp07knpuqf6Xz0h8/v1/token"
ABC_ITEMS_URL     = "https://partners-sb.abcsupply.com/api/product/v1/items"
ABC_SCOPE         = "location.read product.read account.read notification.read notification.write"

ITEMS_PER_PAGE    = 1000
TOKEN_REFRESH_MIN = 25
CHECKPOINT_FILE   = "abc_sync_checkpoint.json"
# ─────────────────────────────────────────────────────────


def log(msg):
    print(msg, flush=True)


def get_token():
    log("[token] Fetching new token...")
    resp = requests.post(ABC_TOKEN_URL, data={
        "client_id":     ABC_CLIENT_ID,
        "client_secret": ABC_CLIENT_SECRET,
        "grant_type":    "client_credentials",
        "scope":         ABC_SCOPE,
    })
    resp.raise_for_status()
    token = resp.json()["access_token"]
    log("[token] Token acquired")
    return token, datetime.now(timezone.utc)


def should_refresh(token_fetched_at):
    elapsed = (datetime.now(timezone.utc) - token_fetched_at).total_seconds()
    return elapsed >= (TOKEN_REFRESH_MIN * 60)


def flatten_item(item):
    color  = item.get("color") or {}
    finish = item.get("finish") or {}
    hier   = item.get("hierarchy") or {}
    pg     = hier.get("productGroup") or {}
    cat    = pg.get("category") or {}
    pt     = cat.get("productType") or {}
    mc     = pt.get("materialComposition") or {}
    warr   = mc.get("warranty") or {}
    brand  = warr.get("brandLine") or {}

    return {
        "item_number":           item.get("itemNumber"),
        "family_id":             item.get("familyId"),
        "family_name":           item.get("familyName"),
        "supplier_name":         item.get("supplierName"),
        "is_dimensional":        item.get("isDimensional"),
        "item_description":      item.get("itemDescription"),
        "marketing_description": item.get("marketingDescription"),
        "status":                item.get("status"),
        "color_code":            color.get("code"),
        "color_name":            color.get("name"),
        "finish_code":           finish.get("code"),
        "finish_name":           finish.get("name"),
        "product_group_code":    pg.get("code"),
        "product_group_name":    pg.get("label"),
        "category_code":         cat.get("code"),
        "category_name":         cat.get("label"),
        "product_type_code":     pt.get("code"),
        "product_type_name":     pt.get("label"),
        "brand_line_code":       brand.get("code"),
        "brand_line_name":       brand.get("label"),
        "last_modified_date":    item.get("lastModifiedDate"),
        "updated_at":            datetime.now(timezone.utc).isoformat(),
    }


def fetch_page(token, page_number):
    headers = {"Authorization": f"Bearer {token}"}
    params  = {"pageNumber": page_number, "itemsPerPage": ITEMS_PER_PAGE}
    backoff = 2
    while True:
        try:
            resp = requests.get(ABC_ITEMS_URL, headers=headers, params=params, timeout=120)
        except requests.exceptions.RequestException as e:
            log(f"[warn] Network error on page {page_number}: {type(e).__name__}. Waiting {backoff}s...")
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)
            continue
        if resp.status_code == 200:
            return resp.json()
        elif resp.status_code in (429, 503, 504):
            log(f"[warn] {resp.status_code} on page {page_number}. Waiting {backoff}s...")
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)
        elif resp.status_code == 401:
            return None  # signal token expired
        else:
            log(f"[error] Unexpected {resp.status_code} on page {page_number}: {resp.text}")
            resp.raise_for_status()


def load_checkpoint():
    if os.path.exists(CHECKPOINT_FILE):
        with open(CHECKPOINT_FILE) as f:
            return json.load(f)
    return {"last_completed_page": 0, "total_pages": None}


def save_checkpoint(page, total_pages):
    with open(CHECKPOINT_FILE, "w") as f:
        json.dump({"last_completed_page": page, "total_pages": total_pages}, f)


def main():
    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
    token, token_fetched_at = get_token()

    checkpoint  = load_checkpoint()
    start_page  = checkpoint["last_completed_page"] + 1
    total_pages = checkpoint["total_pages"]

    if start_page > 1:
        log(f"[resume] Resuming from page {start_page}/{total_pages or '?'}")
    else:
        log("[start] Starting fresh sync")

    page = start_page
    while True:
        if should_refresh(token_fetched_at):
            token, token_fetched_at = get_token()

        log(f"[page] Fetching page {page}/{total_pages or '?'}...")

        data = fetch_page(token, page)

        if data is None:
            token, token_fetched_at = get_token()
            data = fetch_page(token, page)

        total_pages = data["pagination"]["totalPages"]
        items       = data["items"]

        if not items:
            log(f"[warn] No items on page {page}, stopping.")
            break

        rows = [flatten_item(item) for item in items]
        backoff = 2
        while True:
            try:
                supabase.table("abc_items").upsert(rows, on_conflict="item_number").execute()
                break
            except (httpx.ReadError, httpx.ConnectError, httpx.RemoteProtocolError) as e:
                log(f"[warn] Supabase connection error on page {page}: {e}. Waiting {backoff}s...")
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)
        log(f"[ok] Page {page}/{total_pages} — {len(rows)} items upserted")

        save_checkpoint(page, total_pages)

        if page >= total_pages:
            log("[done] Sync complete!")
            if os.path.exists(CHECKPOINT_FILE):
                os.remove(CHECKPOINT_FILE)
            break

        page += 1


if __name__ == "__main__":
    main()
