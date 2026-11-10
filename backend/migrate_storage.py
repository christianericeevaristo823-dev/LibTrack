"""Migrate LibTrack local uploads to Supabase Storage without deleting local files.
Run from the project root: python backend/migrate_storage.py
Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend/.env.
"""
from pathlib import Path
import mimetypes
import os
import sys
from dotenv import load_dotenv
from supabase import create_client

BACKEND_DIR = Path(__file__).resolve().parent
UPLOADS_DIR = BACKEND_DIR / "uploads"
load_dotenv(BACKEND_DIR / ".env", encoding="utf-8-sig")
url = os.getenv("SUPABASE_URL")
service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
if not url or not service_key:
    raise SystemExit("Missing Supabase settings in backend/.env")

client = create_client(url, service_key)
BUCKETS = {
    "ebooks": UPLOADS_DIR / "ebooks",
    "book-covers": UPLOADS_DIR / "book_covers",
    "research-pdfs": UPLOADS_DIR / "research_pdfs",
}


def list_remote_keys(bucket: str) -> set[str]:
    storage = client.storage.from_(bucket)
    result: set[str] = set()

    def walk(prefix: str = ""):
        offset = 0
        while True:
            rows = storage.list(prefix, options={"limit": 100, "offset": offset})
            if not rows:
                break
            for row in rows:
                name = row.get("name") if isinstance(row, dict) else getattr(row, "name", None)
                if not name:
                    continue
                key = f"{prefix}/{name}" if prefix else name
                metadata = row.get("metadata") if isinstance(row, dict) else getattr(row, "metadata", None)
                object_id = row.get("id") if isinstance(row, dict) else getattr(row, "id", None)
                if metadata is None and object_id is None:
                    walk(key)
                else:
                    result.add(key)
            if len(rows) < 100:
                break
            offset += len(rows)

    walk()
    return result


def migrate_bucket(bucket: str, folder: Path):
    if not folder.is_dir():
        print(f"SKIP {bucket}: local folder missing: {folder}")
        return 0, 0, 0
    files = sorted(p for p in folder.rglob("*") if p.is_file() and not p.name.startswith("."))
    print(f"\n{bucket}: {len(files)} local files")
    remote = list_remote_keys(bucket)
    uploaded = skipped = failed = 0
    storage = client.storage.from_(bucket)
    for index, path in enumerate(files, 1):
        key = path.relative_to(folder).as_posix()
        if key in remote:
            skipped += 1
            print(f"[{index}/{len(files)}] EXISTS {key}")
            continue
        try:
            data = path.read_bytes()
            content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            storage.upload(key, data, file_options={"content-type": content_type, "upsert": "false"})
            uploaded += 1
            print(f"[{index}/{len(files)}] UPLOADED {key} ({len(data):,} bytes)")
        except Exception as exc:
            failed += 1
            print(f"[{index}/{len(files)}] FAILED {key}: {exc}")
    print(f"RESULT {bucket}: uploaded={uploaded}, existing={skipped}, failed={failed}")
    return uploaded, skipped, failed


if __name__ == "__main__":
    totals = [0, 0, 0]
    for bucket, folder in BUCKETS.items():
        totals = [a + b for a, b in zip(totals, migrate_bucket(bucket, folder))]
    print("\nTOTAL uploaded={}, existing={}, failed={}".format(*totals))
    if totals[2]:
        sys.exit(1)
    print("Migration finished. Local files were not deleted or modified.")
