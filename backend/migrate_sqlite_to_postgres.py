"""
LibTrack SQLite -> PostgreSQL migration

Run from the project root:
    python backend/migrate_sqlite_to_postgres.py

Set DATABASE_URL in the same PowerShell session before running.
The script reads SQLite in read-only mode, refuses to copy into populated
destination tables, preserves IDs/foreign keys/indexes, verifies counts,
and never modifies the SQLite source.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    MetaData,
    create_engine,
    func,
    inspect,
    select,
    text,
)
from sqlalchemy.engine import URL, make_url
from sqlalchemy.schema import DefaultClause
from sqlalchemy.dialects.sqlite import DATE as SQLiteDATE, DATETIME as SQLiteDATETIME
from sqlalchemy.exc import SQLAlchemyError

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SOURCE_DB = PROJECT_ROOT / "backend" / "libtrack_dev.db"
BATCH_SIZE = 500


def get_database_url() -> str:
    value = os.getenv("DATABASE_URL", "").strip()
    if not value:
        raise RuntimeError("DATABASE_URL is missing. Set it before running.")

    parsed = make_url(value)
    if parsed.drivername in ("postgres", "postgresql", "postgresql+psycopg2"):
        parsed = parsed.set(drivername="postgresql+psycopg")

    if parsed.get_backend_name() != "postgresql":
        raise RuntimeError("DATABASE_URL must point to PostgreSQL.")

    return parsed.render_as_string(hide_password=False)


def main() -> int:
    if not SOURCE_DB.is_file():
        raise FileNotFoundError(f"SQLite source database not found: {SOURCE_DB}")

    database_url = get_database_url()

    sqlite_url = URL.create(
        "sqlite",
        database=f"file:{SOURCE_DB.as_posix()}?mode=ro",
        query={"uri": "true"},
    )
    source_engine = create_engine(sqlite_url)
    target_engine = create_engine(database_url, pool_pre_ping=True)

    try:
        source_metadata = MetaData()
        source_metadata.reflect(bind=source_engine)

        if not source_metadata.tables:
            raise RuntimeError("No tables found in the SQLite database.")

        # Convert SQLite numeric Boolean defaults (1/0) to PostgreSQL
        # Boolean literals (true/false) before creating destination tables.
        for table in source_metadata.tables.values():
            for column in table.columns:
                # SQLite's reflected DATE/DATETIME dialect types compile to
                # invalid PostgreSQL type names. Replace them with portable
                # SQLAlchemy types before generating the PostgreSQL schema.
                if isinstance(column.type, DateTime):
                    column.type = DateTime()
                elif isinstance(column.type, Date):
                    column.type = Date()

                if isinstance(column.type, Boolean) and column.server_default is not None:
                    raw = str(column.server_default.arg).strip().strip("()")
                    if raw in ("1", "'1'", '"1"', "true", "TRUE"):
                        column.server_default = DefaultClause(text("true"))
                    elif raw in ("0", "'0'", '"0"', "false", "FALSE"):
                        column.server_default = DefaultClause(text("false"))

        print(f"SQLite source: {SOURCE_DB}")
        print("Connecting to PostgreSQL...")

        source_counts = {}
        with source_engine.connect() as source_conn:
            print("\nTables found:")
            for table in source_metadata.sorted_tables:
                count = source_conn.execute(
                    select(func.count()).select_from(table)
                ).scalar_one()
                source_counts[table.name] = count
                print(f"  {table.name}: {count}")

        with target_engine.begin() as target_conn:
            if target_conn.dialect.name != "postgresql":
                raise RuntimeError("Destination is not PostgreSQL.")

            source_metadata.create_all(bind=target_conn, checkfirst=True)
            target_inspector = inspect(target_conn)
            target_names = set(target_inspector.get_table_names())

            missing = [
                table.name
                for table in source_metadata.sorted_tables
                if table.name not in target_names
            ]
            if missing:
                raise RuntimeError(
                    "Could not create destination tables: " + ", ".join(missing)
                )

            # Fail closed: never merge into or overwrite populated tables.
            for table in source_metadata.sorted_tables:
                existing = target_conn.execute(
                    select(func.count()).select_from(table)
                ).scalar_one()
                if existing:
                    raise RuntimeError(
                        f"Destination table '{table.name}' already has "
                        f"{existing} rows. Use a fresh, empty PostgreSQL database."
                    )

            print("\nCopying records...")
            for table in source_metadata.sorted_tables:
                expected = source_counts[table.name]
                copied = 0

                with source_engine.connect() as source_conn:
                    result = source_conn.execution_options(
                        stream_results=True
                    ).execute(select(table))

                    while True:
                        batch = result.fetchmany(BATCH_SIZE)
                        if not batch:
                            break
                        target_conn.execute(
                            table.insert(),
                            [dict(row._mapping) for row in batch],
                        )
                        copied += len(batch)

                if copied != expected:
                    raise RuntimeError(
                        f"{table.name}: expected {expected}, copied {copied}"
                    )
                print(f"  {table.name}: copied {copied}")

            print("\nVerifying destination counts...")
            for table in source_metadata.sorted_tables:
                actual = target_conn.execute(
                    select(func.count()).select_from(table)
                ).scalar_one()
                expected = source_counts[table.name]
                if actual != expected:
                    raise RuntimeError(
                        f"{table.name}: expected {expected}, found {actual}"
                    )
                print(f"  {table.name}: verified {actual}")

            # Advance serial/identity sequences past explicitly copied IDs.
            for table in source_metadata.sorted_tables:
                for column in table.primary_key.columns:
                    if column.autoincrement not in (True, "auto"):
                        continue
                    try:
                        if column.type.python_type is not int:
                            continue
                    except (AttributeError, NotImplementedError):
                        continue

                    sequence = target_conn.execute(
                        text(
                            "SELECT pg_get_serial_sequence(:table_name, :column_name)"
                        ),
                        {
                            "table_name": table.name,
                            "column_name": column.name,
                        },
                    ).scalar_one_or_none()

                    if not sequence:
                        continue

                    max_id = target_conn.execute(
                        select(func.max(column))
                    ).scalar_one()

                    if max_id is None:
                        target_conn.execute(
                            text("SELECT setval(:sequence_name, 1, false)"),
                            {"sequence_name": sequence},
                        )
                    else:
                        target_conn.execute(
                            text("SELECT setval(:sequence_name, :max_id, true)"),
                            {
                                "sequence_name": sequence,
                                "max_id": int(max_id),
                            },
                        )

        print("\nSUCCESS: migration and count verification completed.")
        print("The original SQLite database was not changed.")
        return 0

    except Exception:
        print(
            "\nMIGRATION STOPPED. Destination transaction was rolled back "
            "where supported. SQLite source remains unchanged.",
            file=sys.stderr,
        )
        raise
    finally:
        source_engine.dispose()
        target_engine.dispose()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (SQLAlchemyError, OSError, RuntimeError, ValueError) as exc:
        print(f"\nERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
