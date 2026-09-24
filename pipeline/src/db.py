"""Shared infrastructure: paths, config loading, DB connection, and a schema
CHECK.

This module does not create schema. It used to: `ensure_schema` ran
CREATE TABLE IF NOT EXISTS and ALTER TABLE ... ADD COLUMN at pipeline runtime,
which put six objects outside the Node migration chain and made
`verify:migrations` — whose job is catching drift — structurally unable to see
the largest drift in the project. Those objects now belong to migration
010_adopt_pipeline_schema.

`verify_schema` therefore only looks, and raises SchemaOutOfDate naming the
missing objects and the command to fix them. The database schema has exactly
one owner: the umzug chain in mission-demo/src/migrations.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import mysql.connector
from dotenv import load_dotenv

# --- Paths -------------------------------------------------------------------
PIPELINE_ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = PIPELINE_ROOT / "config"

load_dotenv(PIPELINE_ROOT / ".env")

# Input and working directories can be pointed elsewhere (the curriculum pipeline
# harness runs against a throwaway directory so it never touches real SME drops).
INPUT_DIR = Path(os.getenv("PIPELINE_INPUT_DIR") or PIPELINE_ROOT / "input")
LOGS_DIR = Path(os.getenv("PIPELINE_LOGS_DIR") or PIPELINE_ROOT / "logs")


# --- Config loaders ----------------------------------------------------------
def load_json_config(name: str) -> dict:
    path = CONFIG_DIR / name
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def load_levels() -> dict:
    return load_json_config("levels.json")


def load_tags() -> list[str]:
    return load_json_config("tags.json")["tags"]


def load_active_template() -> dict:
    """Return the single active template. The config supports many templates via
    the `active` flag, so the SME can enable descriptive/project types later
    without any code change."""
    templates = load_json_config("templates.json")["templates"]
    active = [t for t in templates if t.get("active")]
    if not active:
        raise RuntimeError("No active template in config/templates.json")
    if len(active) > 1:
        raise RuntimeError(
            "More than one active template; Stage 2 supports one at a time."
        )
    return active[0]


def load_curriculum_config() -> dict:
    """config/curriculum.json (or PIPELINE_CURRICULUM_FILE): which track, credit and
    credit and hours each SME file covers, plus the hour heading pattern. Missing
    file = no mappings, so every input file must be listed as legacy."""
    path = Path(os.getenv("PIPELINE_CURRICULUM_FILE") or CONFIG_DIR / "curriculum.json")
    if not path.exists():
        return {"files": {}, "legacy_files": []}
    with path.open("r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    cfg.setdefault("files", {})
    cfg.setdefault("legacy_files", [])
    return cfg


# --- Database ----------------------------------------------------------------
def get_connection():
    return mysql.connector.connect(
        host=os.getenv("DB_HOST", "127.0.0.1"),
        port=int(os.getenv("DB_PORT", "3306")),
        user=os.getenv("DB_USER", "root"),
        password=os.getenv("DB_PASS", ""),
        database=os.getenv("DB_NAME", "mission_demo"),
        autocommit=False,
    )


# What migrations 010_adopt_pipeline_schema, 009_curriculum and 012_hours must
# have put in
# place before the pipeline can run. Checked, never created — see the module
# docstring. Keep in step with src/migrations/ in the Node tree.
REQUIRED_TABLES = ("content_chunks",)

REQUIRED_COLUMNS = (
    ("content_chunks", "hour_id"),
    ("missions", "source_chunk_id"),
    ("missions", "generated_at"),
    ("missions", "review_notes"),
    ("missions", "source_chunk_hash"),
    # Owned by 012_hours (009 created it as session_id): without it, generated
    # missions cannot be curriculum-scoped and would be unservable.
    ("missions", "hour_id"),
)

REQUIRED_INDEXES = (("missions", "idx_missions_source_chunk"),)

MIGRATE_HINT = (
    "Run `npm run db:migrate` in mission-demo (migrations 009_curriculum, "
    "010_adopt_pipeline_schema and 012_hours) before running the pipeline."
)


class SchemaOutOfDate(RuntimeError):
    """The database is missing objects the migration chain owns.

    Raised instead of creating them: a pipeline that silently patches the schema
    hides drift from verify:migrations, which is how this went unnoticed through
    31 commits.
    """


def _column_exists(cur, table: str, column: str) -> bool:
    cur.execute(
        """SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND COLUMN_NAME = %s""",
        (table, column),
    )
    return cur.fetchone()[0] > 0


def _table_exists(cur, table: str) -> bool:
    cur.execute(
        """SELECT COUNT(*) FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s""",
        (table,),
    )
    return cur.fetchone()[0] > 0


def _index_exists(cur, table: str, index: str) -> bool:
    cur.execute(
        """SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND INDEX_NAME = %s""",
        (table, index),
    )
    return cur.fetchone()[0] > 0


def verify_schema(dry_run: bool = False) -> list[str]:
    """Check that every object the pipeline depends on exists.

    Returns a list of human-readable confirmations (so `--dry-run` and the CLI
    can still report what was inspected). Raises SchemaOutOfDate listing every
    missing object if anything is absent — it never creates or alters anything.

    `dry_run` is accepted for signature compatibility with the callers and makes
    no difference: this function only ever reads.
    """
    checked: list[str] = []
    missing: list[str] = []
    conn = get_connection()
    try:
        cur = conn.cursor()

        for table in REQUIRED_TABLES:
            if _table_exists(cur, table):
                checked.append(f"table {table}: present")
            else:
                missing.append(f"table {table}")

        for table, column in REQUIRED_COLUMNS:
            # A missing table already reported above would make every one of its
            # columns "missing" too; only report the table once.
            if table not in REQUIRED_TABLES or _table_exists(cur, table):
                if _column_exists(cur, table, column):
                    checked.append(f"column {table}.{column}: present")
                else:
                    missing.append(f"column {table}.{column}")

        for table, index in REQUIRED_INDEXES:
            if _index_exists(cur, table, index):
                checked.append(f"index {table}.{index}: present")
            else:
                missing.append(f"index {table}.{index}")

        cur.close()
    finally:
        conn.close()

    if missing:
        lines = [
            f"The database is missing {len(missing)} object(s) owned by the migration chain:",
            *(f"  - {m}" for m in missing),
            "",
            MIGRATE_HINT,
        ]
        raise SchemaOutOfDate("\n".join(lines))
    return checked


# Back-compat alias. The name is kept so existing callers and any operator
# muscle memory still work, but it no longer ensures anything — it verifies.
ensure_schema = verify_schema
