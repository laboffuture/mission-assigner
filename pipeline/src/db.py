"""Shared infrastructure: paths, config loading, DB connection, and an
idempotent schema migration.

The migration is deliberately additive and safe to run against the live
database: it uses CREATE TABLE IF NOT EXISTS and checks information_schema
before adding columns/indexes, so it never drops or rewrites existing data.
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
INPUT_DIR = PIPELINE_ROOT / "input"
LOGS_DIR = PIPELINE_ROOT / "logs"

load_dotenv(PIPELINE_ROOT / ".env")


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


CONTENT_CHUNKS_DDL = """
CREATE TABLE IF NOT EXISTS content_chunks (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_file   VARCHAR(255) NOT NULL,
  chunk_ref     VARCHAR(120) NOT NULL,
  heading       VARCHAR(255) NOT NULL,
  body          MEDIUMTEXT NOT NULL,
  content_hash  CHAR(64) NOT NULL,
  subject       VARCHAR(60) NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_chunk (source_file, chunk_ref),
  KEY idx_chunk_hash (content_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
"""

# columns to add to the existing missions table: name -> DDL fragment
MISSIONS_NEW_COLUMNS = {
    "source_chunk_id": "ADD COLUMN source_chunk_id BIGINT UNSIGNED NULL",
    "generated_at": "ADD COLUMN generated_at TIMESTAMP NULL",
    "review_notes": "ADD COLUMN review_notes TEXT NULL",
}


def _column_exists(cur, table: str, column: str) -> bool:
    cur.execute(
        """SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND COLUMN_NAME = %s""",
        (table, column),
    )
    return cur.fetchone()[0] > 0


def _index_exists(cur, table: str, index: str) -> bool:
    cur.execute(
        """SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND INDEX_NAME = %s""",
        (table, index),
    )
    return cur.fetchone()[0] > 0


def ensure_schema(dry_run: bool = False) -> list[str]:
    """Apply the additive Stage 2 schema changes. Returns a list of the actions
    taken (or that would be taken under dry_run)."""
    actions: list[str] = []
    conn = get_connection()
    try:
        cur = conn.cursor()

        # 1. content_chunks table
        cur.execute(
            """SELECT COUNT(*) FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'content_chunks'"""
        )
        if cur.fetchone()[0] == 0:
            actions.append("CREATE TABLE content_chunks")
            if not dry_run:
                cur.execute(CONTENT_CHUNKS_DDL)

        # 2. new columns on missions
        for col, ddl in MISSIONS_NEW_COLUMNS.items():
            if not _column_exists(cur, "missions", col):
                actions.append(f"ALTER TABLE missions {ddl}")
                if not dry_run:
                    cur.execute(f"ALTER TABLE missions {ddl}")

        # 3. index on missions.source_chunk_id
        if not _index_exists(cur, "missions", "idx_missions_source_chunk"):
            # only add once the column is guaranteed to exist
            if _column_exists(cur, "missions", "source_chunk_id") or not dry_run:
                actions.append("CREATE INDEX idx_missions_source_chunk")
                if not dry_run:
                    cur.execute(
                        "ALTER TABLE missions ADD INDEX idx_missions_source_chunk (source_chunk_id)"
                    )

        if not dry_run:
            conn.commit()
        cur.close()
    finally:
        conn.close()
    return actions
