from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from collections.abc import Iterator

SCHEMA_VERSION = 9

SCHEMA_SQL = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_path TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL UNIQUE,
    media_type TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    file_size INTEGER,
    mtime REAL,
    text_detected_ocr INTEGER,
    text_detected_vision INTEGER,
    text_detected_caption INTEGER,
    text_detected_signature INTEGER,
    is_small INTEGER NOT NULL DEFAULT 0,
    is_missing INTEGER NOT NULL DEFAULT 0,
    last_seen_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL,
    model_name TEXT NOT NULL,
    model_version TEXT NOT NULL,
    embedding BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(asset_id, model_name, model_version),
    FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS captions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL,
    model_name TEXT NOT NULL,
    model_version TEXT NOT NULL,
    caption_type TEXT NOT NULL DEFAULT 'long',
    caption TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(asset_id, model_name, model_version, caption_type),
    FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL,
    tag TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(asset_id, tag, source),
    FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
    asset_id UNINDEXED,
    content
);

CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL,
    model_name TEXT NOT NULL,
    model_version TEXT NOT NULL,
    score REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(asset_id, model_name, model_version),
    FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS clusters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER,
    run_id INTEGER,
    cluster_label INTEGER,
    depth INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(parent_id) REFERENCES clusters(id) ON DELETE SET NULL,
    FOREIGN KEY(run_id) REFERENCES cluster_runs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS cluster_members (
    cluster_id INTEGER NOT NULL,
    asset_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(cluster_id, asset_id),
    FOREIGN KEY(cluster_id) REFERENCES clusters(id) ON DELETE CASCADE,
    FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_embeddings_model_asset
    ON embeddings(model_name, model_version, asset_id);
CREATE INDEX IF NOT EXISTS idx_captions_model_asset
    ON captions(model_name, model_version, caption_type, asset_id);
CREATE INDEX IF NOT EXISTS idx_scores_model_asset
    ON scores(model_name, model_version, asset_id);
CREATE INDEX IF NOT EXISTS idx_tags_asset
    ON tags(asset_id);
CREATE INDEX IF NOT EXISTS idx_tags_tag
    ON tags(tag);
CREATE INDEX IF NOT EXISTS idx_tags_source_tag
    ON tags(source, tag);
CREATE UNIQUE INDEX IF NOT EXISTS ux_embeddings_asset_model_version
    ON embeddings(asset_id, model_name, model_version);
CREATE UNIQUE INDEX IF NOT EXISTS ux_captions_asset_model_version_type
    ON captions(asset_id, model_name, model_version, caption_type);
CREATE UNIQUE INDEX IF NOT EXISTS ux_scores_asset_model_version
    ON scores(asset_id, model_name, model_version);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tags_asset_tag_source
    ON tags(asset_id, tag, source);

CREATE TABLE IF NOT EXISTS vector_sync_state (
    backend TEXT NOT NULL,
    model_name TEXT NOT NULL,
    model_version TEXT NOT NULL,
    synced_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(backend, model_name, model_version)
);

CREATE TABLE IF NOT EXISTS pipeline_resume (
    pipeline TEXT NOT NULL,
    model_name TEXT NOT NULL,
    model_version TEXT NOT NULL,
    caption_type TEXT,
    shard_key TEXT NOT NULL DEFAULT '0/1',
    last_asset_id INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(pipeline, model_name, model_version, caption_type, shard_key)
);

CREATE TABLE IF NOT EXISTS lora_training_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method TEXT NOT NULL,
    trainer_name TEXT NOT NULL,
    model_family TEXT NOT NULL,
    base_model TEXT,
    status TEXT NOT NULL,
    dataset_manifest_path TEXT,
    config_path TEXT,
    command_json TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT
);

CREATE TABLE IF NOT EXISTS lora_artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    artifact_type TEXT NOT NULL,
    path TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(run_id) REFERENCES lora_training_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lora_training_runs_family
    ON lora_training_runs(model_family, started_at);
CREATE INDEX IF NOT EXISTS idx_lora_artifacts_run
    ON lora_artifacts(run_id, artifact_type);

CREATE TABLE IF NOT EXISTS style_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    style_name TEXT NOT NULL UNIQUE,
    source_cluster_id INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(source_cluster_id) REFERENCES clusters(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS style_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    style_node_id INTEGER NOT NULL,
    run_id INTEGER NOT NULL,
    model_family TEXT NOT NULL,
    base_model TEXT,
    variant_name TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(style_node_id) REFERENCES style_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY(run_id) REFERENCES lora_training_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_style_variants_style_node
    ON style_variants(style_node_id, model_family, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS ux_style_variants_node_family_base
    ON style_variants(style_node_id, model_family, COALESCE(base_model, ''));

CREATE INDEX IF NOT EXISTS idx_style_nodes_cluster
    ON style_nodes(source_cluster_id);

CREATE TABLE IF NOT EXISTS user_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL,
    rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(asset_id),
    FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_ratings_asset ON user_ratings(asset_id);
CREATE INDEX IF NOT EXISTS idx_user_ratings_rating ON user_ratings(rating);
"""

KNN_GRAPH_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS knn_graph_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    models_json TEXT NOT NULL,
    weights_json TEXT NOT NULL,
    k INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS knn_graph_edges (
    run_id INTEGER NOT NULL,
    source_asset_id INTEGER NOT NULL,
    neighbor_asset_id INTEGER NOT NULL,
    score REAL NOT NULL,
    rank INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(run_id, source_asset_id, neighbor_asset_id),
    FOREIGN KEY(run_id) REFERENCES knn_graph_runs(id) ON DELETE CASCADE,
    FOREIGN KEY(source_asset_id) REFERENCES assets(id) ON DELETE CASCADE,
    FOREIGN KEY(neighbor_asset_id) REFERENCES assets(id) ON DELETE CASCADE
);
"""

CLUSTER_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS cluster_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    models_json TEXT NOT NULL,
    weights_json TEXT NOT NULL,
    min_cluster_size INTEGER NOT NULL,
    min_samples INTEGER,
    cluster_selection_epsilon REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cluster_labels (
    run_id INTEGER NOT NULL,
    asset_id INTEGER NOT NULL,
    cluster_label INTEGER NOT NULL,
    probability REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(run_id, asset_id),
    FOREIGN KEY(run_id) REFERENCES cluster_runs(id) ON DELETE CASCADE,
    FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
);
"""

UMAP_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS umap_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    models_json TEXT NOT NULL,
    weights_json TEXT NOT NULL,
    n_neighbors INTEGER NOT NULL,
    min_dist REAL NOT NULL,
    metric TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS umap_points (
    run_id INTEGER NOT NULL,
    asset_id INTEGER NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(run_id, asset_id),
    FOREIGN KEY(run_id) REFERENCES umap_runs(id) ON DELETE CASCADE,
    FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
);
"""


class _ClosingConnection(sqlite3.Connection):
    """sqlite3.Connection whose ``with`` block also closes it.

    Plain ``with sqlite3.connect(...) as conn`` only commits/rolls back — the
    handle (and its WAL/SHM file descriptors) stays open until GC. Every
    caller here uses ``with db.connect(path) as connection:`` as a scoped
    session, so close on exit after the commit/rollback.
    """

    def __exit__(self, exc_type, exc, tb):  # type: ignore[override]
        try:
            return super().__exit__(exc_type, exc, tb)
        finally:
            self.close()


def connect(db_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(db_path, factory=_ClosingConnection)
    connection.execute("PRAGMA foreign_keys = ON;")
    connection.execute("PRAGMA journal_mode = WAL;")
    connection.execute("PRAGMA synchronous = NORMAL;")
    connection.execute("PRAGMA busy_timeout = 5000;")
    connection.row_factory = sqlite3.Row
    return connection


def init_db(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with connect(db_path) as connection:
        connection.executescript(SCHEMA_SQL)
        connection.executescript(KNN_GRAPH_SCHEMA_SQL)
        connection.executescript(CLUSTER_SCHEMA_SQL)
        connection.executescript(UMAP_SCHEMA_SQL)
        connection.execute(
            "INSERT OR REPLACE INTO metadata(key, value) VALUES(?, ?)",
            ("schema_version", str(SCHEMA_VERSION)),
        )
        connection.commit()


def _get_schema_version(connection: sqlite3.Connection) -> int:
    row = connection.execute(
        "SELECT value FROM metadata WHERE key = ?",
        ("schema_version",),
    ).fetchone()
    if row is None:
        return 0
    try:
        return int(row["value"])
    except (TypeError, ValueError):
        return 0


def get_schema_version(connection: sqlite3.Connection) -> int:
    return _get_schema_version(connection)


def _set_schema_version(connection: sqlite3.Connection, version: int) -> None:
    connection.execute(
        "INSERT OR REPLACE INTO metadata(key, value) VALUES(?, ?)",
        ("schema_version", str(version)),
    )


def _ensure_column(
    connection: sqlite3.Connection,
    table: str,
    column: str,
    definition: str,
) -> None:
    columns = {
        row["name"]
        for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
    }
    if column in columns:
        return
    connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def migrate_db(db_path: Path) -> list[str]:
    with connect(db_path) as connection:
        return migrate_connection(connection)


def migrate_connection(connection: sqlite3.Connection) -> list[str]:
    version = _get_schema_version(connection)
    applied: list[str] = []
    if version < 1:
        connection.executescript(SCHEMA_SQL)
        connection.executescript(KNN_GRAPH_SCHEMA_SQL)
        connection.executescript(CLUSTER_SCHEMA_SQL)
        connection.executescript(UMAP_SCHEMA_SQL)
        _set_schema_version(connection, SCHEMA_VERSION)
        connection.commit()
        return ["init"]
    if version < 2:
        connection.execute("ALTER TABLE assets ADD COLUMN file_size INTEGER")
        connection.execute("ALTER TABLE assets ADD COLUMN mtime REAL")
        connection.execute("ALTER TABLE clusters ADD COLUMN run_id INTEGER")
        connection.execute("ALTER TABLE clusters ADD COLUMN cluster_label INTEGER")
        connection.execute("ALTER TABLE clusters ADD COLUMN depth INTEGER")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS vector_sync_state (
                backend TEXT NOT NULL,
                model_name TEXT NOT NULL,
                model_version TEXT NOT NULL,
                synced_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY(backend, model_name, model_version)
            )
            """
        )
        _set_schema_version(connection, 2)
        applied.append("v2")
    if version < 3:
        _ensure_column(connection, "assets", "is_missing", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(connection, "assets", "last_seen_at", "TEXT")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS embeddings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                asset_id INTEGER NOT NULL,
                model_name TEXT NOT NULL,
                model_version TEXT NOT NULL,
                embedding BLOB NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(asset_id, model_name, model_version),
                FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS captions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                asset_id INTEGER NOT NULL,
                model_name TEXT NOT NULL,
                model_version TEXT NOT NULL,
                caption_type TEXT NOT NULL DEFAULT 'long',
                caption TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(asset_id, model_name, model_version, caption_type),
                FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS scores (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                asset_id INTEGER NOT NULL,
                model_name TEXT NOT NULL,
                model_version TEXT NOT NULL,
                score REAL NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(asset_id, model_name, model_version),
                FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                asset_id INTEGER NOT NULL,
                tag TEXT NOT NULL,
                source TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(asset_id, tag, source),
                FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS vector_sync_state (
                backend TEXT NOT NULL,
                model_name TEXT NOT NULL,
                model_version TEXT NOT NULL,
                synced_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY(backend, model_name, model_version)
            )
            """
        )
        connection.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_embeddings_asset_model_version
                ON embeddings(asset_id, model_name, model_version)
            """
        )
        connection.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_captions_asset_model_version_type
                ON captions(asset_id, model_name, model_version, caption_type)
            """
        )
        connection.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_scores_asset_model_version
                ON scores(asset_id, model_name, model_version)
            """
        )
        connection.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_tags_asset_tag_source
                ON tags(asset_id, tag, source)
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_embeddings_model_asset
                ON embeddings(model_name, model_version, asset_id)
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_captions_model_asset
                ON captions(model_name, model_version, caption_type, asset_id)
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_scores_model_asset
                ON scores(model_name, model_version, asset_id)
            """
        )
        connection.execute("CREATE INDEX IF NOT EXISTS idx_tags_asset ON tags(asset_id)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_tags_source_tag ON tags(source, tag)")
        _ensure_column(connection, "clusters", "run_id", "INTEGER")
        _ensure_column(connection, "clusters", "cluster_label", "INTEGER")
        _ensure_column(connection, "clusters", "depth", "INTEGER")
        _set_schema_version(connection, 3)
        applied.append("v3")
    if version < 4:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS pipeline_resume (
                pipeline TEXT NOT NULL,
                model_name TEXT NOT NULL,
                model_version TEXT NOT NULL,
                caption_type TEXT,
                shard_key TEXT NOT NULL DEFAULT '0/1',
                last_asset_id INTEGER NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY(pipeline, model_name, model_version, caption_type, shard_key)
            )
            """
        )
        _set_schema_version(connection, 4)
        applied.append("v4")
    if version < 5:
        _ensure_column(connection, "assets", "text_detected_ocr", "INTEGER")
        _ensure_column(connection, "assets", "text_detected_vision", "INTEGER")
        _ensure_column(connection, "assets", "text_detected_caption", "INTEGER")
        _ensure_column(connection, "assets", "text_detected_signature", "INTEGER")
        _ensure_column(connection, "assets", "is_small", "INTEGER NOT NULL DEFAULT 0")
        _set_schema_version(connection, 5)
        applied.append("v5")
    if version < 6:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS lora_training_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                method TEXT NOT NULL,
                trainer_name TEXT NOT NULL,
                model_family TEXT NOT NULL,
                base_model TEXT,
                status TEXT NOT NULL,
                dataset_manifest_path TEXT,
                config_path TEXT,
                command_json TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                started_at TEXT NOT NULL DEFAULT (datetime('now')),
                ended_at TEXT
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS lora_artifacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id INTEGER NOT NULL,
                artifact_type TEXT NOT NULL,
                path TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY(run_id) REFERENCES lora_training_runs(id) ON DELETE CASCADE
            )
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_lora_training_runs_family
                ON lora_training_runs(model_family, started_at)
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_lora_artifacts_run
                ON lora_artifacts(run_id, artifact_type)
            """
        )
        _set_schema_version(connection, 6)
        applied.append("v6")
    if version < 7:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS style_nodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                style_name TEXT NOT NULL UNIQUE,
                source_cluster_id INTEGER,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY(source_cluster_id) REFERENCES clusters(id) ON DELETE SET NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS style_variants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                style_node_id INTEGER NOT NULL,
                run_id INTEGER NOT NULL,
                model_family TEXT NOT NULL,
                base_model TEXT,
                variant_name TEXT NOT NULL,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY(style_node_id) REFERENCES style_nodes(id) ON DELETE CASCADE,
                FOREIGN KEY(run_id) REFERENCES lora_training_runs(id) ON DELETE CASCADE
            )
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_style_variants_style_node
                ON style_variants(style_node_id, model_family, created_at)
            """
        )
        connection.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_style_variants_node_family_base
                ON style_variants(style_node_id, model_family, COALESCE(base_model, ''))
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_style_nodes_cluster
                ON style_nodes(source_cluster_id)
            """
        )
        _set_schema_version(connection, 7)
        applied.append("v7")
    if version < 8:
        _set_schema_version(connection, 8)
        applied.append("v8")
    if version < 9:
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS user_ratings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                asset_id INTEGER NOT NULL,
                rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(asset_id),
                FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_user_ratings_asset ON user_ratings(asset_id);
            CREATE INDEX IF NOT EXISTS idx_user_ratings_rating ON user_ratings(rating);
        """)
        connection.execute(
            "UPDATE metadata SET value = '9' WHERE key = 'schema_version'"
        )
        connection.commit()
        applied.append("v9")
    if applied:
        connection.commit()
    return applied


def ensure_knn_graph_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(KNN_GRAPH_SCHEMA_SQL)


def ensure_cluster_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(CLUSTER_SCHEMA_SQL)


def ensure_umap_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(UMAP_SCHEMA_SQL)


def check_database(connection: sqlite3.Connection) -> tuple[list[str], list[str]]:
    issues: list[str] = []
    repairs: list[str] = []
    fk_enabled = connection.execute("PRAGMA foreign_keys").fetchone()[0]
    if int(fk_enabled) != 1:
        issues.append("foreign_keys=OFF")
        repairs.append("PRAGMA foreign_keys = ON;")
    journal_mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
    if str(journal_mode).lower() != "wal":
        issues.append(f"journal_mode={journal_mode}")
        repairs.append("PRAGMA journal_mode = WAL;")
    index_names = {
        "embeddings": {
            "idx_embeddings_model_asset",
            "ux_embeddings_asset_model_version",
        },
        "captions": {
            "idx_captions_model_asset",
            "ux_captions_asset_model_version_type",
        },
        "scores": {
            "idx_scores_model_asset",
            "ux_scores_asset_model_version",
        },
        "tags": {
            "idx_tags_asset",
            "idx_tags_tag",
            "idx_tags_source_tag",
            "ux_tags_asset_tag_source",
        },
    }
    index_sql = {
        "idx_embeddings_model_asset": """
            CREATE INDEX IF NOT EXISTS idx_embeddings_model_asset
                ON embeddings(model_name, model_version, asset_id)
        """,
        "ux_embeddings_asset_model_version": """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_embeddings_asset_model_version
                ON embeddings(asset_id, model_name, model_version)
        """,
        "idx_captions_model_asset": """
            CREATE INDEX IF NOT EXISTS idx_captions_model_asset
                ON captions(model_name, model_version, caption_type, asset_id)
        """,
        "ux_captions_asset_model_version_type": """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_captions_asset_model_version_type
                ON captions(asset_id, model_name, model_version, caption_type)
        """,
        "idx_scores_model_asset": """
            CREATE INDEX IF NOT EXISTS idx_scores_model_asset
                ON scores(model_name, model_version, asset_id)
        """,
        "ux_scores_asset_model_version": """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_scores_asset_model_version
                ON scores(asset_id, model_name, model_version)
        """,
        "idx_tags_asset": "CREATE INDEX IF NOT EXISTS idx_tags_asset ON tags(asset_id)",
        "idx_tags_tag": "CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag)",
        "idx_tags_source_tag": "CREATE INDEX IF NOT EXISTS idx_tags_source_tag ON tags(source, tag)",
        "ux_tags_asset_tag_source": """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_tags_asset_tag_source
                ON tags(asset_id, tag, source)
        """,
    }
    for table, required in index_names.items():
        existing = {
            row["name"]
            for row in connection.execute(f"PRAGMA index_list('{table}')").fetchall()
        }
        missing = required - existing
        if missing:
            issues.append(f"{table}: missing {', '.join(sorted(missing))}")
            for name in sorted(missing):
                repairs.append(index_sql[name].strip() + ";")
    return issues, repairs


def fetch_asset_by_path(connection: sqlite3.Connection, source_path: str) -> sqlite3.Row | None:
    cursor = connection.execute(
        "SELECT * FROM assets WHERE source_path = ?",
        (source_path,),
    )
    return cursor.fetchone()


def fetch_asset_by_sha(connection: sqlite3.Connection, sha256: str) -> sqlite3.Row | None:
    cursor = connection.execute(
        "SELECT * FROM assets WHERE sha256 = ?",
        (sha256,),
    )
    return cursor.fetchone()


def fetch_asset_by_id(connection: sqlite3.Connection, asset_id: int) -> sqlite3.Row | None:
    cursor = connection.execute(
        "SELECT * FROM assets WHERE id = ?",
        (asset_id,),
    )
    return cursor.fetchone()


def fetch_cluster_by_id(connection: sqlite3.Connection, cluster_id: int) -> sqlite3.Row | None:
    cursor = connection.execute(
        "SELECT * FROM clusters WHERE id = ?",
        (cluster_id,),
    )
    return cursor.fetchone()


def fetch_cluster_by_name(connection: sqlite3.Connection, name: str) -> sqlite3.Row | None:
    cursor = connection.execute(
        "SELECT * FROM clusters WHERE name = ?",
        (name,),
    )
    return cursor.fetchone()


def insert_cluster(
    connection: sqlite3.Connection,
    name: str,
    parent_id: int | None = None,
    run_id: int | None = None,
    cluster_label: int | None = None,
    depth: int | None = None,
) -> int:
    cursor = connection.execute(
        """
        INSERT INTO clusters(name, parent_id, run_id, cluster_label, depth)
        VALUES(?, ?, ?, ?, ?)
        """,
        (name, parent_id, run_id, cluster_label, depth),
    )
    return int(cursor.lastrowid)


def ensure_cluster(connection: sqlite3.Connection, name: str) -> int:
    existing = fetch_cluster_by_name(connection, name)
    if existing:
        return int(existing["id"])
    return insert_cluster(connection, name=name)


def fetch_asset_cluster_map(
    connection: sqlite3.Connection,
    asset_ids: list[int],
) -> dict[int, int]:
    """Return {asset_id: cluster_id} for the given assets (first cluster wins)."""
    if not asset_ids:
        return {}
    result: dict[int, int] = {}
    chunk_size = 900
    for i in range(0, len(asset_ids), chunk_size):
        chunk = asset_ids[i : i + chunk_size]
        placeholders = ",".join("?" * len(chunk))
        rows = connection.execute(
            f"SELECT asset_id, cluster_id FROM cluster_members WHERE asset_id IN ({placeholders})",
            chunk,
        ).fetchall()
        for row in rows:
            aid = int(row["asset_id"])
            if aid not in result:
                result[aid] = int(row["cluster_id"])
    return result


def add_assets_to_cluster(
    connection: sqlite3.Connection,
    cluster_id: int,
    asset_ids: list[int],
) -> int:
    if not asset_ids:
        return 0
    connection.executemany(
        """
        INSERT OR IGNORE INTO cluster_members(cluster_id, asset_id)
        VALUES(?, ?)
        """,
        [(cluster_id, asset_id) for asset_id in asset_ids],
    )
    cursor = connection.execute(
        """
        SELECT COUNT(*) AS count
        FROM cluster_members
        WHERE cluster_id = ?
          AND asset_id IN ({placeholders})
        """.format(
            placeholders=", ".join("?" for _ in asset_ids)
        ),
        [cluster_id, *asset_ids],
    )
    row = cursor.fetchone()
    return int(row["count"]) if row else 0


def remove_assets_from_cluster(
    connection: sqlite3.Connection,
    cluster_id: int,
    asset_ids: list[int],
) -> int:
    if not asset_ids:
        return 0
    placeholders = ", ".join("?" for _ in asset_ids)
    cursor = connection.execute(
        f"""
        DELETE FROM cluster_members
        WHERE cluster_id = ?
          AND asset_id IN ({placeholders})
        """,
        [cluster_id, *asset_ids],
    )
    return int(cursor.rowcount or 0)


def fetch_clusters(connection: sqlite3.Connection) -> list[sqlite3.Row]:
    cursor = connection.execute(
        """
        SELECT id, name, parent_id, created_at
        FROM clusters
        ORDER BY id
        """
    )
    return cursor.fetchall()


def fetch_cluster_member_counts(connection: sqlite3.Connection) -> dict[int, int]:
    cursor = connection.execute(
        """
        SELECT cluster_id, COUNT(*) AS member_count
        FROM cluster_members
        GROUP BY cluster_id
        """
    )
    return {int(row["cluster_id"]): int(row["member_count"]) for row in cursor.fetchall()}


def _build_text_filter_clause(text_filter: str | None) -> tuple[str | None, list[object]]:
    if text_filter is None:
        return None, []
    if text_filter == "any":
        return (
            "("
            "assets.text_detected_ocr = 1 OR "
            "assets.text_detected_vision = 1 OR "
            "assets.text_detected_caption = 1 OR "
            "assets.text_detected_signature = 1"
            ")",
            [],
        )
    if text_filter == "none":
        return (
            "("
            "assets.text_detected_ocr = 0 AND "
            "assets.text_detected_vision = 0 AND "
            "assets.text_detected_caption = 0 AND "
            "assets.text_detected_signature = 0"
            ")",
            [],
        )
    if text_filter == "unknown":
        return (
            "("
            "assets.text_detected_ocr IS NULL AND "
            "assets.text_detected_vision IS NULL AND "
            "assets.text_detected_caption IS NULL AND "
            "assets.text_detected_signature IS NULL"
            ")",
            [],
        )
    mapping = {
        "ocr": "assets.text_detected_ocr = 1",
        "vision": "assets.text_detected_vision = 1",
        "caption": "assets.text_detected_caption = 1",
        "signature": "assets.text_detected_signature = 1",
    }
    clause = mapping.get(text_filter)
    if clause is None:
        raise ValueError(f"Unknown text filter: {text_filter}")
    return clause, []


def _build_small_filter_clause(small_filter: str | None) -> tuple[str | None, list[object]]:
    if small_filter is None:
        return None, []
    if small_filter == "small":
        return "assets.is_small = 1", []
    if small_filter == "not_small":
        return "assets.is_small = 0", []
    if small_filter == "unknown":
        return "assets.is_small IS NULL", []
    raise ValueError(f"Unknown small filter: {small_filter}")


def fetch_cluster_members(
    connection: sqlite3.Connection,
    cluster_id: int,
    limit: int,
    offset: int,
    text_filter: str | None = None,
    small_filter: str | None = None,
) -> list[sqlite3.Row]:
    conditions = ["cluster_members.cluster_id = ?"]
    params: list[object] = [cluster_id]
    text_clause, text_params = _build_text_filter_clause(text_filter)
    if text_clause:
        conditions.append(text_clause)
        params.extend(text_params)
    small_clause, small_params = _build_small_filter_clause(small_filter)
    if small_clause:
        conditions.append(small_clause)
        params.extend(small_params)
    cursor = connection.execute(
        f"""
        SELECT
            assets.id,
            assets.source_path,
            assets.sha256,
            assets.text_detected_ocr,
            assets.text_detected_vision,
            assets.text_detected_caption,
            assets.text_detected_signature,
            assets.is_small
        FROM cluster_members
        JOIN assets ON assets.id = cluster_members.asset_id
        WHERE {' AND '.join(conditions)}
        ORDER BY assets.id
        LIMIT ?
        OFFSET ?
        """,
        (*params, limit, offset),
    )
    return cursor.fetchall()


def fetch_cluster_members_with_score(
    connection: sqlite3.Connection,
    cluster_id: int,
    model_name: str,
    model_version: str,
    limit: int,
    offset: int,
    score_min: float | None = None,
    score_max: float | None = None,
    sort: str = "score_desc",
    text_filter: str | None = None,
    small_filter: str | None = None,
) -> list[sqlite3.Row]:
    conditions = ["cluster_members.cluster_id = ?"]
    params: list[object] = [model_name, model_version, cluster_id]
    if score_min is not None:
        conditions.append("scores.score >= ?")
        params.append(score_min)
    if score_max is not None:
        conditions.append("scores.score <= ?")
        params.append(score_max)
    text_clause, text_params = _build_text_filter_clause(text_filter)
    if text_clause:
        conditions.append(text_clause)
        params.extend(text_params)
    small_clause, small_params = _build_small_filter_clause(small_filter)
    if small_clause:
        conditions.append(small_clause)
        params.extend(small_params)

    if sort == "score_asc":
        order_by = "scores.score IS NULL, scores.score ASC, assets.source_path COLLATE NOCASE"
    elif sort == "path":
        order_by = "assets.source_path COLLATE NOCASE"
    else:
        order_by = "scores.score IS NULL, scores.score DESC, assets.source_path COLLATE NOCASE"

    query = f"""
        SELECT
            assets.id,
            assets.source_path,
            assets.sha256,
            assets.text_detected_ocr,
            assets.text_detected_vision,
            assets.text_detected_caption,
            assets.text_detected_signature,
            assets.is_small,
            scores.score
        FROM cluster_members
        JOIN assets ON assets.id = cluster_members.asset_id
        LEFT JOIN scores
          ON scores.asset_id = assets.id
         AND scores.model_name = ?
         AND scores.model_version = ?
        WHERE {' AND '.join(conditions)}
        ORDER BY {order_by}
        LIMIT ? OFFSET ?
        """
    params.extend([limit, offset])
    cursor = connection.execute(query, params)
    return cursor.fetchall()


def fetch_cluster_member_total_with_score(
    connection: sqlite3.Connection,
    cluster_id: int,
    model_name: str,
    model_version: str,
    score_min: float | None = None,
    score_max: float | None = None,
    text_filter: str | None = None,
    small_filter: str | None = None,
) -> int:
    conditions = ["cluster_members.cluster_id = ?"]
    params: list[object] = [model_name, model_version, cluster_id]
    if score_min is not None:
        conditions.append("scores.score >= ?")
        params.append(score_min)
    if score_max is not None:
        conditions.append("scores.score <= ?")
        params.append(score_max)
    text_clause, text_params = _build_text_filter_clause(text_filter)
    if text_clause:
        conditions.append(text_clause)
        params.extend(text_params)
    small_clause, small_params = _build_small_filter_clause(small_filter)
    if small_clause:
        conditions.append(small_clause)
        params.extend(small_params)
    query = f"""
        SELECT COUNT(*) AS member_count
        FROM cluster_members
        JOIN assets ON assets.id = cluster_members.asset_id
        LEFT JOIN scores
          ON scores.asset_id = assets.id
         AND scores.model_name = ?
         AND scores.model_version = ?
        WHERE {' AND '.join(conditions)}
        """
    cursor = connection.execute(query, params)
    row = cursor.fetchone()
    return int(row["member_count"]) if row else 0


def fetch_cluster_member_total(
    connection: sqlite3.Connection,
    cluster_id: int,
    text_filter: str | None = None,
    small_filter: str | None = None,
) -> int:
    conditions = ["cluster_members.cluster_id = ?"]
    params: list[object] = [cluster_id]
    text_clause, text_params = _build_text_filter_clause(text_filter)
    if text_clause:
        conditions.append(text_clause)
        params.extend(text_params)
    small_clause, small_params = _build_small_filter_clause(small_filter)
    if small_clause:
        conditions.append(small_clause)
        params.extend(small_params)
    query = f"""
        SELECT COUNT(*) AS member_count
        FROM cluster_members
        JOIN assets ON assets.id = cluster_members.asset_id
        WHERE {' AND '.join(conditions)}
        """
    row = connection.execute(query, params).fetchone()
    return int(row["member_count"]) if row else 0


def fetch_assets_missing_embeddings(
    connection: sqlite3.Connection,
    model_name: str,
    model_version: str,
    limit: int | None = None,
) -> list[sqlite3.Row]:
    sql = """
        SELECT *
        FROM assets
        WHERE NOT EXISTS (
            SELECT 1
            FROM embeddings
            WHERE embeddings.asset_id = assets.id
              AND embeddings.model_name = ?
              AND embeddings.model_version = ?
        )
        ORDER BY id
    """
    params: list[object] = [model_name, model_version]
    if limit is not None:
        sql += " LIMIT ?"
        params.append(limit)
    cursor = connection.execute(sql, params)
    return list(cursor.fetchall())


def iter_assets_missing_embeddings(
    connection: sqlite3.Connection,
    model_name: str,
    model_version: str,
    batch_size: int = 500,
    start_after: int = 0,
    shard_total: int = 1,
    shard_index: int = 0,
) -> Iterator[sqlite3.Row]:
    last_id = start_after
    while True:
        sql = """
            SELECT *
            FROM assets
            WHERE id > ?
              AND NOT EXISTS (
                SELECT 1
                FROM embeddings
                WHERE embeddings.asset_id = assets.id
                  AND embeddings.model_name = ?
                  AND embeddings.model_version = ?
            )
        """
        params: list[object] = [last_id, model_name, model_version]
        if shard_total > 1:
            sql += " AND (id % ?) = ?"
            params.extend([shard_total, shard_index])
        sql += " ORDER BY id LIMIT ?"
        params.append(batch_size)
        rows = connection.execute(sql, params).fetchall()
        if not rows:
            break
        last_id = int(rows[-1]["id"])
        for row in rows:
            yield row


def count_assets(connection: sqlite3.Connection) -> int:
    row = connection.execute("SELECT COUNT(*) AS count FROM assets").fetchone()
    return int(row["count"] or 0)


def count_assets_missing_embeddings(
    connection: sqlite3.Connection,
    model_name: str,
    model_version: str,
) -> int:
    row = connection.execute(
        """
        SELECT COUNT(*) AS count
        FROM assets
        WHERE NOT EXISTS (
            SELECT 1
            FROM embeddings
            WHERE embeddings.asset_id = assets.id
              AND embeddings.model_name = ?
              AND embeddings.model_version = ?
        )
        """,
        (model_name, model_version),
    ).fetchone()
    return int(row["count"] or 0)


def fetch_assets_missing_scores(
    connection: sqlite3.Connection,
    model_name: str,
    model_version: str,
    limit: int | None = None,
) -> list[sqlite3.Row]:
    sql = """
        SELECT *
        FROM assets
        WHERE NOT EXISTS (
            SELECT 1
            FROM scores
            WHERE scores.asset_id = assets.id
              AND scores.model_name = ?
              AND scores.model_version = ?
        )
        ORDER BY id
    """
    params: list[object] = [model_name, model_version]
    if limit is not None:
        sql += " LIMIT ?"
        params.append(limit)
    cursor = connection.execute(sql, params)
    return list(cursor.fetchall())


def iter_assets_missing_scores(
    connection: sqlite3.Connection,
    model_name: str,
    model_version: str,
    batch_size: int = 500,
    start_after: int = 0,
    shard_total: int = 1,
    shard_index: int = 0,
) -> Iterator[sqlite3.Row]:
    last_id = start_after
    while True:
        sql = """
            SELECT *
            FROM assets
            WHERE id > ?
              AND NOT EXISTS (
                SELECT 1
                FROM scores
                WHERE scores.asset_id = assets.id
                  AND scores.model_name = ?
                  AND scores.model_version = ?
            )
        """
        params: list[object] = [last_id, model_name, model_version]
        if shard_total > 1:
            sql += " AND (id % ?) = ?"
            params.extend([shard_total, shard_index])
        sql += " ORDER BY id LIMIT ?"
        params.append(batch_size)
        rows = connection.execute(sql, params).fetchall()
        if not rows:
            break
        last_id = int(rows[-1]["id"])
        for row in rows:
            yield row


def iter_assets_missing_text_detection(
    connection: sqlite3.Connection,
    methods: list[str],
    batch_size: int = 500,
    start_after: int = 0,
    shard_total: int = 1,
    shard_index: int = 0,
) -> Iterator[sqlite3.Row]:
    column_map = {
        "ocr": "text_detected_ocr",
        "vision": "text_detected_vision",
        "caption": "text_detected_caption",
        "signature": "text_detected_signature",
    }
    columns = [column_map[method] for method in methods if method in column_map]
    if not columns:
        return iter(())
    last_id = start_after
    while True:
        conditions = ["id > ?"]
        params: list[object] = [last_id]
        if shard_total > 1:
            conditions.append("(id % ?) = ?")
            params.extend([shard_total, shard_index])
        null_checks = " OR ".join(f"{col} IS NULL" for col in columns)
        conditions.append(f"({null_checks})")
        query = f"""
            SELECT *
            FROM assets
            WHERE {' AND '.join(conditions)}
            ORDER BY id
            LIMIT ?
        """
        params.append(batch_size)
        rows = connection.execute(query, params).fetchall()
        if not rows:
            break
        last_id = int(rows[-1]["id"])
        for row in rows:
            yield row


def count_assets_missing_scores(
    connection: sqlite3.Connection,
    model_name: str,
    model_version: str,
) -> int:
    row = connection.execute(
        """
        SELECT COUNT(*) AS count
        FROM assets
        WHERE NOT EXISTS (
            SELECT 1
            FROM scores
            WHERE scores.asset_id = assets.id
              AND scores.model_name = ?
              AND scores.model_version = ?
        )
        """,
        (model_name, model_version),
    ).fetchone()
    return int(row["count"] or 0)


def fetch_embeddings_for_model(
    connection: sqlite3.Connection,
    model_name: str,
    model_version: str,
) -> list[sqlite3.Row]:
    cursor = connection.execute(
        """
        SELECT asset_id, embedding
        FROM embeddings
        WHERE model_name = ? AND model_version = ?
        """,
        (model_name, model_version),
    )
    return list(cursor.fetchall())


def iter_embeddings_for_model(
    connection: sqlite3.Connection,
    model_name: str,
    model_version: str,
    batch_size: int = 500,
    start_after: int = 0,
) -> Iterator[list[sqlite3.Row]]:
    last_id = start_after
    while True:
        rows = connection.execute(
            """
            SELECT asset_id, embedding
            FROM embeddings
            WHERE model_name = ? AND model_version = ? AND asset_id > ?
            ORDER BY asset_id
            LIMIT ?
            """,
            (model_name, model_version, last_id, batch_size),
        ).fetchall()
        if not rows:
            break
        last_id = int(rows[-1]["asset_id"])
        yield rows


def fetch_embeddings_for_assets(
    connection: sqlite3.Connection,
    model_name: str,
    model_version: str,
    asset_ids: list[int],
) -> list[sqlite3.Row]:
    if not asset_ids:
        return []
    rows: list[sqlite3.Row] = []
    chunk_size = 900
    for start in range(0, len(asset_ids), chunk_size):
        chunk = asset_ids[start : start + chunk_size]
        placeholders = ", ".join("?" for _ in chunk)
        query = f"""
            SELECT asset_id, embedding
            FROM embeddings
            WHERE model_name = ? AND model_version = ? AND asset_id IN ({placeholders})
        """
        params: list[object] = [model_name, model_version, *chunk]
        cursor = connection.execute(query, params)
        rows.extend(cursor.fetchall())
    return rows


def fetch_model_version(connection: sqlite3.Connection, model_name: str) -> str:
    cursor = connection.execute(
        """
        SELECT model_version
        FROM embeddings
        WHERE model_name = ?
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT 1
        """,
        (model_name,),
    )
    row = cursor.fetchone()
    if row is None:
        raise ValueError(f"No embeddings found for model '{model_name}'.")
    return str(row["model_version"])


def fetch_vector_sync_state(
    connection: sqlite3.Connection,
    backend: str,
    model_name: str,
    model_version: str,
) -> sqlite3.Row | None:
    cursor = connection.execute(
        """
        SELECT *
        FROM vector_sync_state
        WHERE backend = ? AND model_name = ? AND model_version = ?
        """,
        (backend, model_name, model_version),
    )
    return cursor.fetchone()


def mark_vector_sync_state(
    connection: sqlite3.Connection,
    backend: str,
    model_name: str,
    model_version: str,
) -> None:
    connection.execute(
        """
        INSERT INTO vector_sync_state(backend, model_name, model_version)
        VALUES(?, ?, ?)
        ON CONFLICT(backend, model_name, model_version)
        DO UPDATE SET synced_at = datetime('now')
        """,
        (backend, model_name, model_version),
    )


def fetch_assets_missing_captions(
    connection: sqlite3.Connection,
    model_name: str,
    model_version: str,
    caption_type: str,
    limit: int | None = None,
) -> list[sqlite3.Row]:
    sql = """
        SELECT *
        FROM assets
        WHERE NOT EXISTS (
            SELECT 1
            FROM captions
            WHERE captions.asset_id = assets.id
              AND captions.model_name = ?
              AND captions.model_version = ?
              AND captions.caption_type = ?
        )
        ORDER BY id
    """
    params: list[object] = [model_name, model_version, caption_type]
    if limit is not None:
        sql += " LIMIT ?"
        params.append(limit)
    cursor = connection.execute(sql, params)
    return list(cursor.fetchall())


def iter_assets_missing_captions(
    connection: sqlite3.Connection,
    model_name: str,
    model_version: str,
    caption_type: str,
    batch_size: int = 500,
    start_after: int = 0,
    shard_total: int = 1,
    shard_index: int = 0,
) -> Iterator[sqlite3.Row]:
    last_id = start_after
    while True:
        sql = """
            SELECT *
            FROM assets
            WHERE id > ?
              AND NOT EXISTS (
                SELECT 1
                FROM captions
                WHERE captions.asset_id = assets.id
                  AND captions.model_name = ?
                  AND captions.model_version = ?
                  AND captions.caption_type = ?
            )
        """
        params: list[object] = [last_id, model_name, model_version, caption_type]
        if shard_total > 1:
            sql += " AND (id % ?) = ?"
            params.extend([shard_total, shard_index])
        sql += " ORDER BY id LIMIT ?"
        params.append(batch_size)
        rows = connection.execute(sql, params).fetchall()
        if not rows:
            break
        last_id = int(rows[-1]["id"])
        for row in rows:
            yield row


def fetch_resume_token(
    connection: sqlite3.Connection,
    pipeline: str,
    model_name: str,
    model_version: str,
    caption_type: str | None = None,
    shard_key: str = "0/1",
) -> int | None:
    row = connection.execute(
        """
        SELECT last_asset_id
        FROM pipeline_resume
        WHERE pipeline = ? AND model_name = ? AND model_version = ?
          AND caption_type IS ?
          AND shard_key = ?
        """,
        (pipeline, model_name, model_version, caption_type, shard_key),
    ).fetchone()
    if row is None:
        return None
    return int(row["last_asset_id"])


def update_resume_token(
    connection: sqlite3.Connection,
    pipeline: str,
    model_name: str,
    model_version: str,
    last_asset_id: int,
    caption_type: str | None = None,
    shard_key: str = "0/1",
) -> None:
    connection.execute(
        """
        INSERT INTO pipeline_resume(
            pipeline, model_name, model_version, caption_type, shard_key, last_asset_id
        )
        VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(pipeline, model_name, model_version, caption_type, shard_key)
        DO UPDATE SET last_asset_id = excluded.last_asset_id,
                      updated_at = datetime('now')
        """,
        (
            pipeline,
            model_name,
            model_version,
            caption_type,
            shard_key,
            last_asset_id,
        ),
    )


def count_assets_missing_captions(
    connection: sqlite3.Connection,
    model_name: str,
    model_version: str,
    caption_type: str,
) -> int:
    row = connection.execute(
        """
        SELECT COUNT(*) AS count
        FROM assets
        WHERE NOT EXISTS (
            SELECT 1
            FROM captions
            WHERE captions.asset_id = assets.id
              AND captions.model_name = ?
              AND captions.model_version = ?
              AND captions.caption_type = ?
        )
        """,
        (model_name, model_version, caption_type),
    ).fetchone()
    return int(row["count"] or 0)


def fetch_cluster_labels_for_run(
    connection: sqlite3.Connection,
    run_id: int,
) -> list[sqlite3.Row]:
    cursor = connection.execute(
        """
        SELECT cluster_labels.asset_id,
               cluster_labels.cluster_label,
               cluster_labels.probability,
               assets.source_path,
               assets.sha256
        FROM cluster_labels
        JOIN assets ON assets.id = cluster_labels.asset_id
        WHERE cluster_labels.run_id = ?
        ORDER BY cluster_labels.cluster_label, cluster_labels.asset_id
        """,
        (run_id,),
    )
    return list(cursor.fetchall())


def fetch_cluster_run(connection: sqlite3.Connection, run_id: int) -> sqlite3.Row | None:
    cursor = connection.execute(
        """
        SELECT *
        FROM cluster_runs
        WHERE id = ?
        """,
        (run_id,),
    )
    return cursor.fetchone()


def fetch_cluster_labels(
    connection: sqlite3.Connection,
    run_id: int,
) -> list[sqlite3.Row]:
    cursor = connection.execute(
        """
        SELECT asset_id, cluster_label, probability
        FROM cluster_labels
        WHERE run_id = ?
        ORDER BY asset_id
        """,
        (run_id,),
    )
    return list(cursor.fetchall())


def fetch_umap_run(connection: sqlite3.Connection, run_id: int) -> sqlite3.Row | None:
    cursor = connection.execute(
        """
        SELECT *
        FROM umap_runs
        WHERE id = ?
        """,
        (run_id,),
    )
    return cursor.fetchone()


def fetch_umap_runs(connection: sqlite3.Connection) -> list[sqlite3.Row]:
    cursor = connection.execute(
        """
        SELECT *
        FROM umap_runs
        ORDER BY id DESC
        """
    )
    return list(cursor.fetchall())


def fetch_umap_points(
    connection: sqlite3.Connection,
    run_id: int,
    limit: int | None = None,
    offset: int = 0,
) -> list[sqlite3.Row]:
    sql = """
        SELECT
            umap_points.asset_id,
            umap_points.x,
            umap_points.y,
            assets.source_path,
            assets.sha256
        FROM umap_points
        JOIN assets ON assets.id = umap_points.asset_id
        WHERE umap_points.run_id = ?
        ORDER BY umap_points.asset_id
    """
    params: list[object] = [run_id]
    if limit is not None:
        sql += " LIMIT ? OFFSET ?"
        params.extend([limit, offset])
    cursor = connection.execute(sql, params)
    return list(cursor.fetchall())


def fetch_umap_points_sample(
    connection: sqlite3.Connection,
    run_id: int,
    sample: int,
) -> list[sqlite3.Row]:
    cursor = connection.execute(
        """
        SELECT
            umap_points.asset_id,
            umap_points.x,
            umap_points.y,
            assets.source_path,
            assets.sha256
        FROM umap_points
        JOIN assets ON assets.id = umap_points.asset_id
        WHERE umap_points.run_id = ?
        ORDER BY RANDOM()
        LIMIT ?
        """,
        (run_id, sample),
    )
    return list(cursor.fetchall())


def insert_asset(
    connection: sqlite3.Connection,
    source_path: str,
    sha256: str,
    media_type: str,
    width: int | None,
    height: int | None,
    file_size: int | None = None,
    mtime: float | None = None,
    is_small: int = 0,
    is_missing: int = 0,
    last_seen_at: str | None = None,
) -> int:
    cursor = connection.execute(
        """
        INSERT INTO assets(
            source_path,
            sha256,
            media_type,
            width,
            height,
            file_size,
            mtime,
            is_small,
            is_missing,
            last_seen_at
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            source_path,
            sha256,
            media_type,
            width,
            height,
            file_size,
            mtime,
            is_small,
            is_missing,
            last_seen_at,
        ),
    )
    return int(cursor.lastrowid)


def insert_embedding(
    connection: sqlite3.Connection,
    asset_id: int,
    model_name: str,
    model_version: str,
    embedding: bytes,
) -> int:
    cursor = connection.execute(
        """
        INSERT INTO embeddings(asset_id, model_name, model_version, embedding)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(asset_id, model_name, model_version)
        DO UPDATE SET embedding = excluded.embedding,
                      created_at = datetime('now')
        """,
        (asset_id, model_name, model_version, embedding),
    )
    return int(cursor.lastrowid)


def insert_caption(
    connection: sqlite3.Connection,
    asset_id: int,
    model_name: str,
    model_version: str,
    caption_type: str,
    caption: str,
) -> int:
    cursor = connection.execute(
        """
        INSERT INTO captions(asset_id, model_name, model_version, caption_type, caption)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(asset_id, model_name, model_version, caption_type)
        DO UPDATE SET caption = excluded.caption,
                      created_at = datetime('now')
        """,
        (asset_id, model_name, model_version, caption_type, caption),
    )
    refresh_search_index_for_asset(connection, asset_id)
    return int(cursor.lastrowid)


def insert_tag(connection: sqlite3.Connection, asset_id: int, tag: str, source: str) -> int | None:
    cursor = connection.execute(
        """
        INSERT OR IGNORE INTO tags(asset_id, tag, source)
        VALUES(?, ?, ?)
        """,
        (asset_id, tag, source),
    )
    if cursor.rowcount:
        refresh_search_index_for_asset(connection, asset_id)
        return int(cursor.lastrowid)
    return None


def delete_captions_for_model(
    connection: sqlite3.Connection,
    model_name: str,
    model_version: str,
    caption_type: str | None = None,
) -> int:
    params: list[object] = [model_name, model_version]
    query = """
        DELETE FROM captions
        WHERE model_name = ? AND model_version = ?
    """
    if caption_type is not None:
        query += " AND caption_type = ?"
        params.append(caption_type)
    cursor = connection.execute(query, params)
    return int(cursor.rowcount or 0)


def refresh_search_index_for_asset(connection: sqlite3.Connection, asset_id: int) -> None:
    captions = connection.execute(
        """
        SELECT caption
        FROM captions
        WHERE asset_id = ?
        """,
        (asset_id,),
    ).fetchall()
    tags = connection.execute(
        """
        SELECT tag
        FROM tags
        WHERE asset_id = ?
        """,
        (asset_id,),
    ).fetchall()
    # File name too, so a new library is searchable before anything is captioned.
    asset = connection.execute(
        "SELECT source_path FROM assets WHERE id = ?", (asset_id,)
    ).fetchone()
    file_name = Path(str(asset["source_path"])).stem if asset else ""
    content_parts = [row["caption"] for row in captions] + [row["tag"] for row in tags]
    content = " ".join(part for part in [file_name, *content_parts] if part)
    connection.execute("DELETE FROM search_index WHERE rowid = ?", (asset_id,))
    if content:
        connection.execute(
            """
            INSERT INTO search_index(rowid, asset_id, content)
            VALUES(?, ?, ?)
            """,
            (asset_id, asset_id, content),
        )


def rebuild_search_index(connection: sqlite3.Connection) -> int:
    connection.execute("DELETE FROM search_index")
    asset_ids = connection.execute("SELECT id FROM assets ORDER BY id").fetchall()
    for row in asset_ids:
        refresh_search_index_for_asset(connection, int(row["id"]))
    return len(asset_ids)


def has_tag(
    connection: sqlite3.Connection,
    asset_id: int,
    tag: str,
    source: str | None = None,
) -> bool:
    if source is None:
        cursor = connection.execute(
            "SELECT 1 FROM tags WHERE asset_id = ? AND tag = ? LIMIT 1",
            (asset_id, tag),
        )
    else:
        cursor = connection.execute(
            "SELECT 1 FROM tags WHERE asset_id = ? AND tag = ? AND source = ? LIMIT 1",
            (asset_id, tag, source),
        )
    return cursor.fetchone() is not None


def remove_tag(
    connection: sqlite3.Connection,
    asset_id: int,
    tag: str,
    source: str | None = None,
) -> int:
    if source is None:
        cursor = connection.execute(
            "DELETE FROM tags WHERE asset_id = ? AND tag = ?",
            (asset_id, tag),
        )
    else:
        cursor = connection.execute(
            "DELETE FROM tags WHERE asset_id = ? AND tag = ? AND source = ?",
            (asset_id, tag, source),
        )
    if cursor.rowcount:
        refresh_search_index_for_asset(connection, asset_id)
    return int(cursor.rowcount or 0)


def update_asset_path(
    connection: sqlite3.Connection,
    asset_id: int,
    new_path: str,
) -> None:
    connection.execute(
        """
        UPDATE assets
        SET source_path = ?, updated_at = datetime('now')
        WHERE id = ?
        """,
        (new_path, asset_id),
    )


def update_asset_metadata(
    connection: sqlite3.Connection,
    asset_id: int,
    sha256: str,
    width: int | None,
    height: int | None,
    file_size: int | None,
    mtime: float | None,
    is_small: int | None = None,
) -> None:
    set_clauses = [
        "sha256 = ?",
        "width = ?",
        "height = ?",
        "file_size = ?",
        "mtime = ?",
        "updated_at = datetime('now')",
    ]
    params: list[object] = [sha256, width, height, file_size, mtime]
    if is_small is not None:
        set_clauses.insert(5, "is_small = ?")
        params.insert(5, is_small)
    params.append(asset_id)
    connection.execute(
        f"""
        UPDATE assets
        SET {', '.join(set_clauses)}
        WHERE id = ?
        """,
        params,
    )


def update_asset_text_flags(
    connection: sqlite3.Connection,
    asset_id: int,
    text_detected_ocr: int | None = None,
    text_detected_vision: int | None = None,
    text_detected_caption: int | None = None,
    text_detected_signature: int | None = None,
) -> None:
    set_clauses: list[str] = []
    params: list[object] = []
    if text_detected_ocr is not None:
        set_clauses.append("text_detected_ocr = ?")
        params.append(text_detected_ocr)
    if text_detected_vision is not None:
        set_clauses.append("text_detected_vision = ?")
        params.append(text_detected_vision)
    if text_detected_caption is not None:
        set_clauses.append("text_detected_caption = ?")
        params.append(text_detected_caption)
    if text_detected_signature is not None:
        set_clauses.append("text_detected_signature = ?")
        params.append(text_detected_signature)
    if not set_clauses:
        return
    set_clauses.append("updated_at = datetime('now')")
    params.append(asset_id)
    connection.execute(
        f"""
        UPDATE assets
        SET {', '.join(set_clauses)}
        WHERE id = ?
        """,
        params,
    )


def update_asset_seen(
    connection: sqlite3.Connection,
    asset_id: int,
    seen_at: str,
) -> None:
    connection.execute(
        """
        UPDATE assets
        SET last_seen_at = ?,
            is_missing = 0,
            updated_at = datetime('now')
        WHERE id = ?
        """,
        (seen_at, asset_id),
    )


def update_small_flags(
    connection: sqlite3.Connection,
    min_width: int,
    min_height: int,
) -> int:
    cursor = connection.execute(
        """
        UPDATE assets
        SET is_small = CASE
            WHEN width IS NOT NULL AND height IS NOT NULL
             AND (width < ? OR height < ?) THEN 1
            ELSE 0
        END,
        updated_at = datetime('now')
        """,
        (min_width, min_height),
    )
    return int(cursor.rowcount or 0)


def mark_assets_missing(
    connection: sqlite3.Connection,
    root_prefix: str,
    seen_before: str,
) -> int:
    cursor = connection.execute(
        """
        UPDATE assets
        SET is_missing = 1,
            updated_at = datetime('now')
        WHERE source_path LIKE ?
          AND (last_seen_at IS NULL OR last_seen_at < ?)
        """,
        (root_prefix, seen_before),
    )
    return int(cursor.rowcount or 0)


def fetch_missing_assets(
    connection: sqlite3.Connection,
    root_prefix: str | None = None,
    limit: int | None = None,
) -> list[sqlite3.Row]:
    query = "SELECT id, sha256, source_path FROM assets WHERE is_missing = 1"
    params: list[object] = []
    if root_prefix is not None:
        query += " AND source_path LIKE ?"
        params.append(root_prefix)
    query += " ORDER BY id"
    if limit is not None:
        query += " LIMIT ?"
        params.append(limit)
    cursor = connection.execute(query, params)
    return list(cursor.fetchall())


def delete_assets(connection: sqlite3.Connection, asset_ids: list[int]) -> int:
    if not asset_ids:
        return 0
    total_deleted = 0
    chunk_size = 900
    for i in range(0, len(asset_ids), chunk_size):
        chunk = asset_ids[i : i + chunk_size]
        placeholders = ",".join(["?"] * len(chunk))
        connection.execute(
            f"DELETE FROM search_index WHERE asset_id IN ({placeholders})",
            chunk,
        )
        cursor = connection.execute(
            f"DELETE FROM assets WHERE id IN ({placeholders})",
            chunk,
        )
        total_deleted += int(cursor.rowcount or 0)
    return total_deleted


def insert_knn_graph_run(
    connection: sqlite3.Connection,
    models: list[dict[str, str]],
    weights: dict[str, float],
    k: int,
) -> int:
    cursor = connection.execute(
        """
        INSERT INTO knn_graph_runs(models_json, weights_json, k)
        VALUES(?, ?, ?)
        """,
        (json.dumps(models, sort_keys=True), json.dumps(weights, sort_keys=True), k),
    )
    return int(cursor.lastrowid)


def insert_knn_graph_edge(
    connection: sqlite3.Connection,
    run_id: int,
    source_asset_id: int,
    neighbor_asset_id: int,
    score: float,
    rank: int,
) -> None:
    connection.execute(
        """
        INSERT OR REPLACE INTO knn_graph_edges(
            run_id,
            source_asset_id,
            neighbor_asset_id,
            score,
            rank
        )
        VALUES(?, ?, ?, ?, ?)
        """,
        (run_id, source_asset_id, neighbor_asset_id, score, rank),
    )


def insert_cluster_run(
    connection: sqlite3.Connection,
    models: list[dict[str, str]],
    weights: dict[str, float],
    min_cluster_size: int,
    min_samples: int | None,
    cluster_selection_epsilon: float,
) -> int:
    cursor = connection.execute(
        """
        INSERT INTO cluster_runs(
            models_json,
            weights_json,
            min_cluster_size,
            min_samples,
            cluster_selection_epsilon
        )
        VALUES(?, ?, ?, ?, ?)
        """,
        (
            json.dumps(models, sort_keys=True),
            json.dumps(weights, sort_keys=True),
            min_cluster_size,
            min_samples,
            cluster_selection_epsilon,
        ),
    )
    return int(cursor.lastrowid)


def insert_cluster_label(
    connection: sqlite3.Connection,
    run_id: int,
    asset_id: int,
    cluster_label: int,
    probability: float,
) -> None:
    connection.execute(
        """
        INSERT OR REPLACE INTO cluster_labels(
            run_id,
            asset_id,
            cluster_label,
            probability
        )
        VALUES(?, ?, ?, ?)
        """,
        (run_id, asset_id, cluster_label, probability),
    )


def insert_cluster_member(
    connection: sqlite3.Connection,
    cluster_id: int,
    asset_id: int,
) -> None:
    connection.execute(
        """
        INSERT OR IGNORE INTO cluster_members(cluster_id, asset_id)
        VALUES(?, ?)
        """,
        (cluster_id, asset_id),
    )


def insert_score(
    connection: sqlite3.Connection,
    asset_id: int,
    model_name: str,
    model_version: str,
    score: float,
) -> None:
    connection.execute(
        """
        INSERT INTO scores(asset_id, model_name, model_version, score)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(asset_id, model_name, model_version)
        DO UPDATE SET score = excluded.score,
                      created_at = datetime('now')
        """,
        (asset_id, model_name, model_version, score),
    )


def delete_scores_for_model(
    connection: sqlite3.Connection,
    model_name: str,
    model_version: str,
) -> int:
    cursor = connection.execute(
        """
        DELETE FROM scores
        WHERE model_name = ? AND model_version = ?
        """,
        (model_name, model_version),
    )
    return int(cursor.rowcount or 0)


def insert_umap_run(
    connection: sqlite3.Connection,
    models: list[dict[str, str]],
    weights: dict[str, float],
    n_neighbors: int,
    min_dist: float,
    metric: str,
) -> int:
    cursor = connection.execute(
        """
        INSERT INTO umap_runs(models_json, weights_json, n_neighbors, min_dist, metric)
        VALUES(?, ?, ?, ?, ?)
        """,
        (
            json.dumps(models, sort_keys=True),
            json.dumps(weights, sort_keys=True),
            n_neighbors,
            min_dist,
            metric,
        ),
    )
    return int(cursor.lastrowid)


def insert_umap_point(
    connection: sqlite3.Connection,
    run_id: int,
    asset_id: int,
    x: float,
    y: float,
) -> None:
    connection.execute(
        """
        INSERT OR REPLACE INTO umap_points(run_id, asset_id, x, y)
        VALUES(?, ?, ?, ?)
        """,
        (run_id, asset_id, x, y),
    )


def _search_assets_where(query: str) -> tuple[str, tuple[object, ...]]:
    return "WHERE search_index MATCH ?", (query,)


def _fts_literal_query(query: str) -> str | None:
    """Quote every whitespace token so FTS5 treats it as a plain term.

    Natural queries like ``blue-green water`` or ``style:anime`` are FTS5 syntax
    errors (``-``/``:`` are operators). Quoting each token (with embedded ``"``
    doubled) makes it a phrase literal; tokens are implicitly AND-ed. Returns None
    when the query has no tokens.
    """
    tokens = [token.replace('"', '""') for token in query.split()]
    tokens = [token for token in tokens if token.strip('"')]
    if not tokens:
        return None
    return " ".join(f'"{token}"' for token in tokens)


def _execute_fts(
    connection: sqlite3.Connection,
    sql: str,
    query: str,
    extra_params: tuple[object, ...] = (),
) -> sqlite3.Cursor | None:
    """Run an FTS MATCH query; on FTS syntax errors retry with a literal query.

    Raw FTS5 syntax (``AND``/``OR``/``NEAR``/prefix ``*``) keeps working for power
    users; only a query SQLite rejects falls back to the literal form. Returns None
    when nothing searchable remains.
    """
    try:
        return connection.execute(sql, (query, *extra_params))
    except sqlite3.OperationalError as exc:
        message = str(exc).lower()
        # Messages SQLite emits for malformed MATCH strings (verified on 3.x):
        # "fts5: syntax error near ...", "no such column: <tok>" (a:b / a-b),
        # "unterminated string" (unbalanced "). Anything else (locked, missing
        # table) is a real error and propagates.
        if not any(
            marker in message
            for marker in ("fts5:", "no such column", "unterminated string")
        ):
            raise
    literal = _fts_literal_query(query)
    if literal is None:
        return None
    return connection.execute(sql, (literal, *extra_params))


def search_assets(
    connection: sqlite3.Connection,
    query: str,
    limit: int = 10,
    offset: int = 0,
) -> list[tuple[int, float]]:
    where_clause, _params = _search_assets_where(query)
    cursor = _execute_fts(
        connection,
        f"""
        SELECT asset_id, bm25(search_index) AS score
        FROM search_index
        {where_clause}
        ORDER BY score
        LIMIT ? OFFSET ?
        """,
        query,
        (limit, offset),
    )
    if cursor is None:
        return []
    return [(int(row["asset_id"]), float(row["score"])) for row in cursor.fetchall()]


def count_search_assets(connection: sqlite3.Connection, query: str) -> int:
    where_clause, _params = _search_assets_where(query)
    cursor = _execute_fts(
        connection,
        f"""
        SELECT COUNT(*) AS count
        FROM search_index
        {where_clause}
        """,
        query,
    )
    if cursor is None:
        return 0
    row = cursor.fetchone()
    return int(row["count"]) if row is not None else 0


def fetch_assets_by_ids(
    connection: sqlite3.Connection,
    asset_ids: list[int],
) -> list[sqlite3.Row]:
    if not asset_ids:
        return []
    placeholders = ", ".join("?" for _ in asset_ids)
    cursor = connection.execute(
        f"""
        SELECT
            id,
            source_path,
            sha256,
            media_type,
            width,
            height,
            text_detected_ocr,
            text_detected_vision,
            text_detected_caption,
            text_detected_signature,
            is_small,
            created_at
        FROM assets
        WHERE id IN ({placeholders})
        """,
        asset_ids,
    )
    return cursor.fetchall()


def fetch_media_type_facets(connection: sqlite3.Connection) -> dict[str, int]:
    cursor = connection.execute(
        """
        SELECT media_type, COUNT(*) AS count
        FROM assets
        GROUP BY media_type
        ORDER BY count DESC, media_type
        """
    )
    return {row["media_type"]: int(row["count"]) for row in cursor.fetchall()}


def fetch_aspect_facets(connection: sqlite3.Connection) -> dict[str, int]:
    cursor = connection.execute(
        """
        SELECT
            CASE
                WHEN width IS NULL OR height IS NULL THEN 'unknown'
                WHEN width = height THEN 'square'
                WHEN width > height THEN 'landscape'
                ELSE 'portrait'
            END AS aspect,
            COUNT(*) AS count
        FROM assets
        GROUP BY aspect
        ORDER BY count DESC, aspect
        """
    )
    return {row["aspect"]: int(row["count"]) for row in cursor.fetchall()}


def fetch_text_facets(connection: sqlite3.Connection) -> dict[str, int]:
    cursor = connection.execute(
        """
        SELECT
            SUM(CASE WHEN text_detected_ocr = 1 THEN 1 ELSE 0 END) AS ocr_count,
            SUM(CASE WHEN text_detected_vision = 1 THEN 1 ELSE 0 END) AS vision_count,
            SUM(CASE WHEN text_detected_caption = 1 THEN 1 ELSE 0 END) AS caption_count,
            SUM(CASE WHEN text_detected_signature = 1 THEN 1 ELSE 0 END) AS signature_count,
            SUM(
                CASE
                    WHEN text_detected_ocr = 1
                      OR text_detected_vision = 1
                      OR text_detected_caption = 1
                      OR text_detected_signature = 1
                    THEN 1
                    ELSE 0
                END
            ) AS any_count,
            SUM(
                CASE
                    WHEN text_detected_ocr IS NULL
                     AND text_detected_vision IS NULL
                     AND text_detected_caption IS NULL
                     AND text_detected_signature IS NULL
                    THEN 1
                    ELSE 0
                END
            ) AS unknown_count
        FROM assets
        """
    ).fetchone()
    if cursor is None:
        return {}
    return {
        "any": int(cursor["any_count"] or 0),
        "ocr": int(cursor["ocr_count"] or 0),
        "vision": int(cursor["vision_count"] or 0),
        "caption": int(cursor["caption_count"] or 0),
        "signature": int(cursor["signature_count"] or 0),
        "unknown": int(cursor["unknown_count"] or 0),
    }


def fetch_small_facets(connection: sqlite3.Connection) -> dict[str, int]:
    cursor = connection.execute(
        """
        SELECT
            SUM(CASE WHEN is_small = 1 THEN 1 ELSE 0 END) AS small_count,
            SUM(CASE WHEN is_small = 0 THEN 1 ELSE 0 END) AS not_small_count
        FROM assets
        """
    ).fetchone()
    if cursor is None:
        return {}
    return {
        "small": int(cursor["small_count"] or 0),
        "not_small": int(cursor["not_small_count"] or 0),
    }


def fetch_score_facets(
    connection: sqlite3.Connection,
    buckets: int = 5,
) -> dict[str, dict[str, object]]:
    cursor = connection.execute(
        """
        SELECT model_name, model_version
        FROM scores
        GROUP BY model_name, model_version
        ORDER BY model_name, model_version
        """
    )
    models = [(row["model_name"], row["model_version"]) for row in cursor.fetchall()]
    facets: dict[str, dict[str, object]] = {}
    for model_name, model_version in models:
        stats = connection.execute(
            """
            SELECT COUNT(*) AS count, MIN(score) AS min_score, MAX(score) AS max_score, AVG(score) AS avg_score
            FROM scores
            WHERE model_name = ? AND model_version = ?
            """,
            (model_name, model_version),
        ).fetchone()
        count = int(stats["count"] or 0)
        if count == 0:
            continue
        min_score = float(stats["min_score"])
        max_score = float(stats["max_score"])
        avg_score = float(stats["avg_score"])
        bucket_defs: list[dict[str, object]] = []
        if max_score == min_score or buckets <= 1:
            bucket_defs.append(
                {
                    "label": f"{min_score:.4f}",
                    "min": min_score,
                    "max": max_score,
                    "count": count,
                }
            )
        else:
            step = (max_score - min_score) / buckets
            for idx in range(buckets):
                low = min_score + step * idx
                high = max_score if idx == buckets - 1 else min_score + step * (idx + 1)
                if idx == buckets - 1:
                    bucket_count = connection.execute(
                        """
                        SELECT COUNT(*) AS count
                        FROM scores
                        WHERE model_name = ? AND model_version = ?
                          AND score >= ? AND score <= ?
                        """,
                        (model_name, model_version, low, high),
                    ).fetchone()["count"]
                else:
                    bucket_count = connection.execute(
                        """
                        SELECT COUNT(*) AS count
                        FROM scores
                        WHERE model_name = ? AND model_version = ?
                          AND score >= ? AND score < ?
                        """,
                        (model_name, model_version, low, high),
                    ).fetchone()["count"]
                bucket_defs.append(
                    {
                        "label": f"{low:.4f}-{high:.4f}",
                        "min": low,
                        "max": high,
                        "count": int(bucket_count),
                    }
                )
        key = f"{model_name}@{model_version}"
        facets[key] = {
            "count": count,
            "min": min_score,
            "max": max_score,
            "avg": avg_score,
            "buckets": bucket_defs,
        }
    return facets


def insert_lora_training_run(
    connection: sqlite3.Connection,
    *,
    method: str,
    trainer_name: str,
    model_family: str,
    status: str,
    command: list[str],
    metadata: dict[str, object],
    base_model: str | None = None,
    dataset_manifest_path: str | None = None,
    config_path: str | None = None,
    ended_at: str | None = None,
) -> int:
    cursor = connection.execute(
        """
        INSERT INTO lora_training_runs(
            method,
            trainer_name,
            model_family,
            base_model,
            status,
            dataset_manifest_path,
            config_path,
            command_json,
            metadata_json,
            ended_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            method,
            trainer_name,
            model_family,
            base_model,
            status,
            dataset_manifest_path,
            config_path,
            json.dumps(command),
            json.dumps(metadata),
            ended_at,
        ),
    )
    return int(cursor.lastrowid)


def insert_lora_artifact(
    connection: sqlite3.Connection,
    *,
    run_id: int,
    artifact_type: str,
    path: str,
    metadata: dict[str, object],
) -> int:
    cursor = connection.execute(
        """
        INSERT INTO lora_artifacts(run_id, artifact_type, path, metadata_json)
        VALUES(?, ?, ?, ?)
        """,
        (run_id, artifact_type, path, json.dumps(metadata)),
    )
    return int(cursor.lastrowid)


def fetch_lora_training_runs(
    connection: sqlite3.Connection,
    limit: int = 20,
) -> list[sqlite3.Row]:
    cursor = connection.execute(
        """
        SELECT *
        FROM lora_training_runs
        ORDER BY datetime(started_at) DESC, id DESC
        LIMIT ?
        """,
        (limit,),
    )
    return cursor.fetchall()


def upsert_style_node(
    connection: sqlite3.Connection,
    *,
    style_name: str,
    source_cluster_id: int | None,
    metadata: dict[str, object] | None = None,
) -> int:
    payload = json.dumps(metadata or {})
    resolved_cluster_id = source_cluster_id
    if source_cluster_id is not None:
        cluster_row = connection.execute(
            "SELECT id FROM clusters WHERE id = ?",
            (source_cluster_id,),
        ).fetchone()
        if cluster_row is None:
            resolved_cluster_id = None
    row = connection.execute(
        "SELECT id FROM style_nodes WHERE style_name = ?",
        (style_name,),
    ).fetchone()
    if row is None:
        cursor = connection.execute(
            """
            INSERT INTO style_nodes(style_name, source_cluster_id, metadata_json)
            VALUES(?, ?, ?)
            """,
            (style_name, resolved_cluster_id, payload),
        )
        return int(cursor.lastrowid)
    node_id = int(row["id"])
    connection.execute(
        """
        UPDATE style_nodes
        SET source_cluster_id = COALESCE(?, source_cluster_id),
            metadata_json = ?,
            updated_at = datetime('now')
        WHERE id = ?
        """,
        (resolved_cluster_id, payload, node_id),
    )
    return node_id


def upsert_style_variant(
    connection: sqlite3.Connection,
    *,
    style_node_id: int,
    run_id: int,
    model_family: str,
    base_model: str | None,
    variant_name: str,
    metadata: dict[str, object] | None = None,
) -> int:
    payload = json.dumps(metadata or {})
    row = connection.execute(
        """
        SELECT id
        FROM style_variants
        WHERE style_node_id = ? AND model_family = ? AND COALESCE(base_model, '') = COALESCE(?, '')
        """,
        (style_node_id, model_family, base_model),
    ).fetchone()
    if row is None:
        cursor = connection.execute(
            """
            INSERT INTO style_variants(
                style_node_id,
                run_id,
                model_family,
                base_model,
                variant_name,
                metadata_json
            ) VALUES(?, ?, ?, ?, ?, ?)
            """,
            (style_node_id, run_id, model_family, base_model, variant_name, payload),
        )
        return int(cursor.lastrowid)
    variant_id = int(row["id"])
    connection.execute(
        """
        UPDATE style_variants
        SET run_id = ?,
            variant_name = ?,
            metadata_json = ?,
            created_at = datetime('now')
        WHERE id = ?
        """,
        (run_id, variant_name, payload, variant_id),
    )
    return variant_id


def fetch_style_nodes(
    connection: sqlite3.Connection,
    limit: int = 100,
) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT *
        FROM style_nodes
        ORDER BY datetime(updated_at) DESC, id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()


def fetch_style_variants_for_node(
    connection: sqlite3.Connection,
    style_node_id: int,
) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT *
        FROM style_variants
        WHERE style_node_id = ?
        ORDER BY datetime(created_at) DESC, id DESC
        """,
        (style_node_id,),
    ).fetchall()


def fetch_lora_artifacts(
    connection: sqlite3.Connection,
    limit: int = 200,
) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT la.id, la.run_id, la.artifact_type, la.path, la.metadata_json,
               lr.trainer_name, lr.model_family, lr.base_model, lr.method,
               lr.status, lr.started_at
        FROM lora_artifacts la
        JOIN lora_training_runs lr ON la.run_id = lr.id
        WHERE la.artifact_type = 'lora'
        ORDER BY la.id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()


def fetch_lora_artifact_by_id(
    connection: sqlite3.Connection,
    artifact_id: int,
) -> sqlite3.Row | None:
    return connection.execute(
        """
        SELECT la.*, lr.trainer_name, lr.model_family, lr.base_model,
               lr.method, lr.status
        FROM lora_artifacts la
        JOIN lora_training_runs lr ON la.run_id = lr.id
        WHERE la.id = ?
        """,
        (artifact_id,),
    ).fetchone()


def fetch_cluster_member_asset_ids(
    connection: sqlite3.Connection,
    cluster_id: int,
    limit: int = 5000,
) -> list[int]:
    rows = connection.execute(
        """
        SELECT asset_id FROM cluster_members
        WHERE cluster_id = ?
        LIMIT ?
        """,
        (cluster_id, limit),
    ).fetchall()
    return [int(row["asset_id"]) for row in rows]


def fetch_style_node_by_id(
    connection: sqlite3.Connection,
    style_node_id: int,
) -> sqlite3.Row | None:
    return connection.execute(
        "SELECT * FROM style_nodes WHERE id = ?",
        (style_node_id,),
    ).fetchone()


def fetch_top_scored_assets_in_cluster(
    connection: sqlite3.Connection,
    cluster_id: int,
    score_model: str,
    score_version: str,
    limit: int = 10,
) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT a.id, a.source_path, a.sha256, s.value AS score
        FROM cluster_members cm
        JOIN assets a ON cm.asset_id = a.id
        LEFT JOIN scores s ON a.id = s.asset_id
            AND s.model_name = ? AND s.model_version = ?
        WHERE cm.cluster_id = ?
        ORDER BY s.value DESC NULLS LAST
        LIMIT ?
        """,
        (score_model, score_version, cluster_id, limit),
    ).fetchall()


def fetch_lora_training_run_by_id(
    connection: sqlite3.Connection,
    run_id: int,
) -> sqlite3.Row | None:
    cursor = connection.execute(
        "SELECT * FROM lora_training_runs WHERE id = ?",
        (run_id,),
    )
    return cursor.fetchone()


def update_lora_training_run_status(
    connection: sqlite3.Connection,
    run_id: int,
    status: str,
    ended_at: str | None = None,
) -> None:
    if ended_at:
        connection.execute(
            "UPDATE lora_training_runs SET status = ?, ended_at = ? WHERE id = ?",
            (status, ended_at, run_id),
        )
    else:
        connection.execute(
            "UPDATE lora_training_runs SET status = ? WHERE id = ?",
            (status, run_id),
        )


def fetch_lora_artifacts_for_run(
    connection: sqlite3.Connection,
    run_id: int,
) -> list[sqlite3.Row]:
    cursor = connection.execute(
        "SELECT * FROM lora_artifacts WHERE run_id = ? ORDER BY created_at",
        (run_id,),
    )
    return cursor.fetchall()


def upsert_user_rating(
    connection: sqlite3.Connection,
    asset_id: int,
    rating: int,
    metadata: dict[str, object] | None = None,
) -> int:
    payload = json.dumps(metadata or {})
    cursor = connection.execute(
        """
        INSERT INTO user_ratings(asset_id, rating, metadata_json)
        VALUES(?, ?, ?)
        ON CONFLICT(asset_id) DO UPDATE SET
            rating = excluded.rating,
            metadata_json = excluded.metadata_json,
            updated_at = datetime('now')
        """,
        (asset_id, rating, payload),
    )
    return int(cursor.lastrowid)


def fetch_user_rating(
    connection: sqlite3.Connection,
    asset_id: int,
) -> sqlite3.Row | None:
    cursor = connection.execute(
        "SELECT * FROM user_ratings WHERE asset_id = ?",
        (asset_id,),
    )
    return cursor.fetchone()


def fetch_user_ratings_batch(
    connection: sqlite3.Connection,
    asset_ids: list[int],
) -> dict[int, int]:
    if not asset_ids:
        return {}
    placeholders = ",".join("?" for _ in asset_ids)
    cursor = connection.execute(
        f"SELECT asset_id, rating FROM user_ratings WHERE asset_id IN ({placeholders})",
        asset_ids,
    )
    return {int(row["asset_id"]): int(row["rating"]) for row in cursor.fetchall()}


def search_style_nodes(
    connection: sqlite3.Connection,
    query: str,
    limit: int = 20,
) -> list[sqlite3.Row]:
    pattern = f"%{query}%"
    cursor = connection.execute(
        """
        SELECT * FROM style_nodes
        WHERE style_name LIKE ? OR metadata_json LIKE ?
        ORDER BY id DESC
        LIMIT ?
        """,
        (pattern, pattern, limit),
    )
    return cursor.fetchall()


def fetch_unassigned_asset_ids(
    connection: sqlite3.Connection,
    limit: int = 500,
) -> list[int]:
    cursor = connection.execute(
        """
        SELECT a.id FROM assets a
        LEFT JOIN cluster_members cm ON a.id = cm.asset_id
        WHERE cm.asset_id IS NULL
        ORDER BY a.id DESC
        LIMIT ?
        """,
        (limit,),
    )
    return [int(row["id"]) for row in cursor.fetchall()]

def fetch_style_variants_with_runs(
    connection: sqlite3.Connection,
    style_node_id: int,
) -> list[sqlite3.Row]:
    cursor = connection.execute(
        """
        SELECT sv.*, lr.status, lr.started_at, lr.ended_at,
               lr.trainer_name, lr.method
        FROM style_variants sv
        JOIN lora_training_runs lr ON sv.run_id = lr.id
        WHERE sv.style_node_id = ?
        ORDER BY lr.started_at
        """,
        (style_node_id,),
    )
    return cursor.fetchall()
