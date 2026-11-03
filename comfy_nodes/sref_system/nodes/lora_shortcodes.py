"""
LoRA Shortcodes
===============
Manages LoRA shortcodes for easy reference and includes auto-trigger insertion.

Features:
- Shortcode registry mapping names to LoRA paths
- Random LoRA selection from curated sets
- Automatic trigger word insertion
- Trigger position control (beginning, middle, end of prompt)
"""

import os
import json
import random
from typing import Dict, List, Tuple, Optional, Any
from pathlib import Path
import logging
import sqlite3
from contextlib import closing

logger = logging.getLogger(__name__)


def _like_escape(value: str) -> str:
    """Escape LIKE wildcards so user text (e.g. ``my_lora``) matches literally."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _first_sentence_end(text: str) -> Optional[int]:
    """Index just past the first sentence terminator that is followed by
    whitespace and more text; None when the prompt is a single sentence.
    Requiring whitespace keeps decimals ("1.5x") and URLs intact."""
    for i in range(len(text) - 1):
        if text[i] in ".!?" and text[i + 1].isspace() and text[i + 1:].strip():
            return i + 1
    return None


class LoRAShortcodeDB:
    """
    SQLite-based storage for LoRA shortcodes and metadata.
    """
    
    def __init__(self, db_path: Optional[str] = None):
        if db_path is None:
            comfy_dir = os.environ.get("COMFYUI_PATH", os.path.expanduser("~/.comfyui"))
            db_path = os.path.join(comfy_dir, "lora_shortcodes.db")
        
        self.db_path = db_path
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._init_db()
    
    def _init_db(self):
        """Initialize database schema."""
        with closing(sqlite3.connect(self.db_path)) as conn:
            self._create_schema(conn.cursor())
            conn.commit()

    @staticmethod
    def _create_schema(cursor) -> None:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS lora_shortcodes (
                shortcode TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                display_name TEXT,
                description TEXT DEFAULT '',
                tags TEXT DEFAULT '[]',
                triggers TEXT DEFAULT '[]',
                default_strength REAL DEFAULT 1.0,
                default_clip_strength REAL DEFAULT 1.0,
                model_family TEXT DEFAULT 'SDXL',
                curated_set TEXT DEFAULT '',
                example_prompt TEXT DEFAULT '',
                created_at REAL NOT NULL,
                use_count INTEGER DEFAULT 0
            )
        """)
        
        # Curated sets table for grouping LoRAs
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS curated_sets (
                name TEXT PRIMARY KEY,
                description TEXT DEFAULT '',
                tags TEXT DEFAULT '[]'
            )
        """)
    
    def register(
        self,
        shortcode: str,
        filename: str,
        display_name: Optional[str] = None,
        description: str = "",
        tags: Optional[List[str]] = None,
        triggers: Optional[List[str]] = None,
        default_strength: float = 1.0,
        default_clip_strength: float = 1.0,
        model_family: str = "SDXL",
        curated_set: str = "",
        example_prompt: str = "",
    ) -> bool:
        """Register a LoRA shortcode."""
        import time
        
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        try:
            cursor.execute("""
                INSERT OR REPLACE INTO lora_shortcodes
                (shortcode, filename, display_name, description, tags, triggers,
                 default_strength, default_clip_strength, model_family, curated_set,
                 example_prompt, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                shortcode.lower(),
                filename,
                display_name or shortcode,
                description,
                json.dumps(tags or []),
                json.dumps(triggers or []),
                default_strength,
                default_clip_strength,
                model_family,
                curated_set,
                example_prompt,
                time.time(),
            ))
            conn.commit()
            return True
        except Exception as e:
            logger.error(f"Failed to register shortcode {shortcode}: {e}")
            return False
        finally:
            conn.close()
    
    def lookup(self, shortcode: str) -> Optional[Dict[str, Any]]:
        """Look up a LoRA by shortcode."""
        with closing(sqlite3.connect(self.db_path)) as conn:
            cursor = conn.cursor()

            cursor.execute("""
                SELECT filename, display_name, description, tags, triggers,
                       default_strength, default_clip_strength, model_family,
                       curated_set, example_prompt, use_count
                FROM lora_shortcodes WHERE shortcode = ?
            """, (shortcode.lower(),))

            row = cursor.fetchone()

            if row:
                cursor.execute(
                    "UPDATE lora_shortcodes SET use_count = use_count + 1 WHERE shortcode = ?",
                    (shortcode.lower(),)
                )
                conn.commit()
        
        if not row:
            return None
        
        return {
            "shortcode": shortcode,
            "filename": row[0],
            "display_name": row[1],
            "description": row[2],
            "tags": json.loads(row[3]),
            "triggers": json.loads(row[4]),
            "default_strength": row[5],
            "default_clip_strength": row[6],
            "model_family": row[7],
            "curated_set": row[8],
            "example_prompt": row[9],
            "use_count": row[10],
        }
    
    def get_random_from_set(
        self,
        curated_set: Optional[str] = None,
        model_family: Optional[str] = None,
        seed: Optional[int] = None,
    ) -> Optional[Dict[str, Any]]:
        """Get a random LoRA, optionally from a specific curated set.

        With ``seed`` >= 0 the pick is deterministic for a given registry
        state (candidates are ordered by shortcode, then chosen with a private
        ``random.Random(seed)`` so the global RNG is never reseeded).
        """
        conditions = []
        params = []
        
        if curated_set:
            conditions.append("curated_set = ?")
            params.append(curated_set)
        
        if model_family:
            conditions.append("model_family = ?")
            params.append(model_family)
        
        where_clause = " AND ".join(conditions) if conditions else "1=1"

        with closing(sqlite3.connect(self.db_path)) as conn:
            rows = conn.execute(f"""
                SELECT shortcode FROM lora_shortcodes
                WHERE {where_clause}
                ORDER BY shortcode
            """, params).fetchall()

        if not rows:
            return None
        rng = random.Random(seed) if seed is not None and seed >= 0 else random.SystemRandom()
        return self.lookup(rng.choice(rows)[0])
    
    def list_sets(self) -> List[Dict[str, Any]]:
        """List all curated sets."""
        with closing(sqlite3.connect(self.db_path)) as conn:
            rows = conn.execute("""
                SELECT name, description, tags FROM curated_sets
            """).fetchall()

        return [
            {"name": row[0], "description": row[1], "tags": json.loads(row[2])}
            for row in rows
        ]
    
    def create_set(
        self,
        name: str,
        description: str = "",
        tags: Optional[List[str]] = None,
    ) -> bool:
        """Create a curated set."""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        try:
            cursor.execute("""
                INSERT OR REPLACE INTO curated_sets (name, description, tags)
                VALUES (?, ?, ?)
            """, (name, description, json.dumps(tags or [])))
            conn.commit()
            return True
        except Exception as e:
            logger.error(f"Failed to create set {name}: {e}")
            return False
        finally:
            conn.close()
    
    def search(
        self,
        query: Optional[str] = None,
        tags: Optional[List[str]] = None,
        curated_set: Optional[str] = None,
        limit: int = 20,
    ) -> List[Dict[str, Any]]:
        """Search LoRA shortcodes."""
        conditions = []
        params = []

        if query:
            conditions.append(
                "(shortcode LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\'"
                " OR description LIKE ? ESCAPE '\\')"
            )
            params.extend([f"%{_like_escape(query)}%"] * 3)

        if tags:
            for tag in tags:
                # Match the JSON-encoded element exactly as register() stored
                # it (json.dumps escapes non-ASCII, quotes and backslashes).
                conditions.append("tags LIKE ? ESCAPE '\\'")
                params.append(f"%{_like_escape(json.dumps(tag))}%")
        
        if curated_set:
            conditions.append("curated_set = ?")
            params.append(curated_set)
        
        where_clause = " AND ".join(conditions) if conditions else "1=1"

        with closing(sqlite3.connect(self.db_path)) as conn:
            rows = conn.execute(f"""
                SELECT shortcode, filename, display_name, tags, default_strength, curated_set
                FROM lora_shortcodes
                WHERE {where_clause}
                ORDER BY use_count DESC
                LIMIT ?
            """, params + [limit]).fetchall()

        return [
            {
                "shortcode": row[0],
                "filename": row[1],
                "display_name": row[2],
                "tags": json.loads(row[3]),
                "default_strength": row[4],
                "curated_set": row[5],
            }
            for row in rows
        ]

    def shortcode_for_filename(self, filename: str) -> Optional[str]:
        """Shortcode registered for a LoRA file (exact path, then basename)."""
        name = (filename or "").strip()
        if not name:
            return None
        base = os.path.basename(name.replace("\\", "/"))
        with closing(sqlite3.connect(self.db_path)) as conn:
            row = conn.execute(
                "SELECT shortcode FROM lora_shortcodes WHERE filename = ? "
                "ORDER BY use_count DESC LIMIT 1",
                (name,),
            ).fetchone()
            if row is None and base:
                # Stored filenames may carry a subfolder ("style/foo.safetensors").
                row = conn.execute(
                    "SELECT shortcode FROM lora_shortcodes "
                    "WHERE filename = ? OR filename LIKE ? ESCAPE '\\' "
                    "OR filename LIKE ? ESCAPE '\\' "
                    "ORDER BY use_count DESC LIMIT 1",
                    (base, f"%/{_like_escape(base)}", f"%\\\\{_like_escape(base)}"),
                ).fetchone()
        return row[0] if row else None


_lora_db_instance: Optional[LoRAShortcodeDB] = None


def get_lora_db() -> LoRAShortcodeDB:
    """Get or create the global LoRA shortcode database."""
    global _lora_db_instance
    if _lora_db_instance is None:
        _lora_db_instance = LoRAShortcodeDB()
    return _lora_db_instance


class LoRAShortcodeRegistry:
    """
    ComfyUI node that provides the LoRA shortcode database.
    """
    
    @classmethod
    def INPUT_TYPES(cls) -> Dict[str, Any]:
        return {
            "required": {},
            "optional": {
                "db_path": ("STRING", {"default": ""}),
            }
        }
    
    RETURN_TYPES = ("LORA_DB",)
    RETURN_NAMES = ("lora_database",)
    FUNCTION = "get_registry"
    CATEGORY = "Adrift/LoRA"
    
    def get_registry(self, db_path: str = "") -> Tuple[LoRAShortcodeDB]:
        if db_path:
            return (LoRAShortcodeDB(db_path),)
        return (get_lora_db(),)


class LoRAShortcodeLookup:
    """
    Look up a LoRA by shortcode.
    """
    
    @classmethod
    def INPUT_TYPES(cls) -> Dict[str, Any]:
        return {
            "required": {
                "shortcode": ("STRING", {
                    "default": "",
                    "placeholder": "e.g., anime, realistic, painterly",
                }),
            },
            "optional": {
                "lora_db": ("LORA_DB",),
                "strength_override": ("FLOAT", {
                    "default": -1.0,
                    "min": -1.0,
                    "max": 2.0,
                    "step": 0.05,
                }),
            }
        }
    
    RETURN_TYPES = ("STRING", "FLOAT", "FLOAT", "STRING", "BOOLEAN",)
    RETURN_NAMES = ("filename", "strength", "clip_strength", "triggers_csv", "found",)
    FUNCTION = "lookup"
    CATEGORY = "Adrift/LoRA"
    
    def lookup(
        self,
        shortcode: str,
        lora_db: Optional[LoRAShortcodeDB] = None,
        strength_override: float = -1.0,
    ) -> Tuple[str, float, float, str, bool]:
        db = lora_db or get_lora_db()
        data = db.lookup(shortcode)
        
        if not data:
            return ("", 1.0, 1.0, "", False)
        
        strength = data["default_strength"] if strength_override < 0 else strength_override
        clip_strength = data["default_clip_strength"] if strength_override < 0 else strength_override
        triggers = ", ".join(data["triggers"])
        
        return (data["filename"], strength, clip_strength, triggers, True)


class LoRAShortcodeRandom:
    """
    Select a random LoRA from the registry or a curated set.
    Supports --lora random::strength syntax.
    """
    
    @classmethod
    def INPUT_TYPES(cls) -> Dict[str, Any]:
        return {
            "required": {},
            "optional": {
                "lora_db": ("LORA_DB",),
                "curated_set": ("STRING", {
                    "default": "",
                    "placeholder": "Leave empty for any",
                }),
                "model_family": (["any", "SD1.5", "SDXL", "Flux"], {"default": "SDXL"}),
                "strength": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.0,
                    "max": 2.0,
                    "step": 0.05,
                }),
                "seed": ("INT", {"default": -1, "min": -1, "max": 2**31-1}),
            }
        }
    
    RETURN_TYPES = ("STRING", "STRING", "FLOAT", "FLOAT", "STRING",)
    RETURN_NAMES = ("shortcode", "filename", "strength", "clip_strength", "triggers_csv",)
    FUNCTION = "get_random"
    CATEGORY = "Adrift/LoRA"

    @classmethod
    def IS_CHANGED(cls, seed: int = -1, **kwargs):
        # seed < 0 means "fresh pick every run"; NaN never equals itself, so
        # ComfyUI's output cache can't freeze the first random choice.
        if seed is None or seed < 0:
            return float("nan")
        return seed

    def get_random(
        self,
        lora_db: Optional[LoRAShortcodeDB] = None,
        curated_set: str = "",
        model_family: str = "SDXL",
        strength: float = 1.0,
        seed: int = -1,
    ) -> Tuple[str, str, float, float, str]:
        db = lora_db or get_lora_db()
        model_fam = None if model_family == "any" else model_family
        curated = curated_set if curated_set else None

        # The pick itself is seeded (private RNG): random.seed() would not affect
        # SQL ORDER BY RANDOM() and would clobber the global RNG.
        data = db.get_random_from_set(
            curated_set=curated,
            model_family=model_fam,
            seed=seed if seed >= 0 else None,
        )
        
        if not data:
            return ("", "", strength, strength, "")
        
        triggers = ", ".join(data["triggers"])
        
        return (
            data["shortcode"],
            data["filename"],
            strength,
            strength,
            triggers,
        )


class LoRATriggerInserter:
    """
    Inserts LoRA trigger words into a prompt at specified position.
    
    Supports:
    - Automatic trigger extraction from LoRA metadata
    - User-defined trigger overrides
    - Position control: beginning, middle, end
    - Multiple trigger handling with separator
    """
    
    POSITIONS = ["beginning", "after_first_sentence", "middle", "end"]
    
    @classmethod
    def INPUT_TYPES(cls) -> Dict[str, Any]:
        return {
            "required": {
                "prompt": ("STRING", {
                    "default": "",
                    "multiline": True,
                }),
                "enabled": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                "triggers": ("STRING", {
                    "default": "",
                    "placeholder": "Comma-separated trigger words",
                }),
                "position": (cls.POSITIONS, {"default": "beginning"}),
                "separator": ("STRING", {"default": ", "}),
                "lora_filename": ("STRING", {"default": ""}),
                "lora_db": ("LORA_DB",),
            }
        }
    
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt_with_triggers",)
    FUNCTION = "insert_triggers"
    CATEGORY = "Adrift/LoRA"
    
    def insert_triggers(
        self,
        prompt: str,
        enabled: bool,
        triggers: str = "",
        position: str = "beginning",
        separator: str = ", ",
        lora_filename: str = "",
        lora_db: Optional[LoRAShortcodeDB] = None,
    ) -> Tuple[str]:
        if not enabled:
            return (prompt,)
        
        trigger_list = []
        
        if triggers:
            trigger_list.extend([t.strip() for t in triggers.split(",") if t.strip()])
        
        if lora_filename and not trigger_list:
            db = lora_db or get_lora_db()
            # The filename column is matched directly; search() only covers
            # shortcode/display_name/description, so it is a fallback.
            shortcode = db.shortcode_for_filename(lora_filename)
            if shortcode is None:
                results = db.search(query=lora_filename, limit=1)
                shortcode = results[0]["shortcode"] if results else None
            if shortcode is not None:
                data = db.lookup(shortcode)
                if data and data["triggers"]:
                    trigger_list.extend(data["triggers"])

        if not trigger_list:
            return (prompt,)

        trigger_str = separator.join(trigger_list)

        # An empty prompt must not leave a dangling separator ("trig, ").
        if not prompt.strip():
            return (trigger_str,)

        if position == "beginning":
            result = f"{trigger_str}{separator}{prompt}"
        elif position == "end":
            result = f"{prompt}{separator}{trigger_str}"
        elif position == "after_first_sentence":
            cut = _first_sentence_end(prompt)
            if cut is None:
                result = f"{trigger_str}{separator}{prompt}"
            else:
                result = f"{prompt[:cut]}{separator}{trigger_str}{separator}{prompt[cut:].lstrip()}"
        else:  # middle
            mid = len(prompt) // 2
            # Find nearest word boundary
            while mid < len(prompt) and prompt[mid] not in " ,.!?":
                mid += 1
            if mid < len(prompt) and prompt[mid] in ".!?":
                mid += 1  # keep sentence punctuation with the head
            # A comma at the boundary (on either side) is replaced by the
            # separator, not doubled ("red cat,, T, blue dog").
            head = prompt[:mid].rstrip().rstrip(",").rstrip()
            tail = prompt[mid:].lstrip().lstrip(",").lstrip()
            if not tail:
                result = f"{head}{separator}{trigger_str}"
            else:
                result = f"{head}{separator}{trigger_str}{separator}{tail}"

        return (result.strip(),)


class LoRARegisterShortcode:
    """
    Register a new LoRA shortcode.
    """
    
    @classmethod
    def INPUT_TYPES(cls) -> Dict[str, Any]:
        return {
            "required": {
                "shortcode": ("STRING", {"default": ""}),
                "filename": ("STRING", {"default": ""}),
            },
            "optional": {
                "lora_db": ("LORA_DB",),
                "display_name": ("STRING", {"default": ""}),
                "description": ("STRING", {"default": "", "multiline": True}),
                "tags": ("STRING", {"default": ""}),
                "triggers": ("STRING", {"default": ""}),
                "default_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0}),
                "model_family": (["SD1.5", "SDXL", "Flux"], {"default": "SDXL"}),
                "curated_set": ("STRING", {"default": ""}),
            }
        }
    
    RETURN_TYPES = ("BOOLEAN",)
    RETURN_NAMES = ("success",)
    FUNCTION = "register"
    CATEGORY = "Adrift/LoRA"
    
    def register(
        self,
        shortcode: str,
        filename: str,
        lora_db: Optional[LoRAShortcodeDB] = None,
        display_name: str = "",
        description: str = "",
        tags: str = "",
        triggers: str = "",
        default_strength: float = 1.0,
        model_family: str = "SDXL",
        curated_set: str = "",
    ) -> Tuple[bool]:
        if not shortcode.strip() or not filename.strip():
            logger.warning("LoRA shortcode registration needs both a shortcode and a filename")
            return (False,)
        db = lora_db or get_lora_db()

        tag_list = [t.strip() for t in tags.split(",") if t.strip()]
        trigger_list = [t.strip() for t in triggers.split(",") if t.strip()]
        
        success = db.register(
            shortcode=shortcode.strip(),
            filename=filename.strip(),
            display_name=display_name or None,
            description=description,
            tags=tag_list,
            triggers=trigger_list,
            default_strength=default_strength,
            model_family=model_family,
            curated_set=curated_set,
        )
        
        return (success,)
