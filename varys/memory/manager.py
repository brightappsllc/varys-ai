"""Memory manager for Varys - persists user preferences."""
import datetime
import logging
from pathlib import Path
from typing import Dict, Optional, Tuple

log = logging.getLogger(__name__)

# Module-level cache: absolute path → (mtime, content)
# Avoids re-reading the file on every request when contents haven't changed.
_MEM_CACHE: Dict[str, Tuple[float, str]] = {}


class MemoryManager:
    """Manages the .jupyter-assistant/memory/preferences.md file."""

    def __init__(self, root_dir: str, notebook_path: str = ""):
        self.root_dir = Path(root_dir)
        self.notebook_path = notebook_path
        self.memory_file = self._find_memory_file()

    def _find_memory_file(self) -> Path:
        """Find or determine the memory file path."""
        # Try notebook directory first
        if self.notebook_path:
            notebook_dir = self.root_dir / Path(self.notebook_path).parent
            memory_dir = notebook_dir / ".jupyter-assistant" / "memory"
            memory_dir.mkdir(parents=True, exist_ok=True)
            return memory_dir / "preferences.md"

        # Fall back to root dir
        memory_dir = self.root_dir / ".jupyter-assistant" / "memory"
        memory_dir.mkdir(parents=True, exist_ok=True)
        return memory_dir / "preferences.md"

    def load(self) -> str:
        """Load the memory file contents, using a mtime-based cache."""
        if not self.memory_file.exists():
            return ""
        try:
            key = str(self.memory_file)
            mtime = self.memory_file.stat().st_mtime
            cached = _MEM_CACHE.get(key)
            if cached and cached[0] == mtime:
                return cached[1]
            content = self.memory_file.read_text(encoding="utf-8")
            _MEM_CACHE[key] = (mtime, content)
            return content
        except Exception as exc:
            log.warning("Varys: could not read memory file %s: %s", self.memory_file, exc)
            return ""

    def update(self, content: str) -> None:
        """Overwrite the memory file."""
        try:
            self.memory_file.write_text(content, encoding="utf-8")
            # Invalidate the mtime cache so the next load() re-reads the file.
            _MEM_CACHE.pop(str(self.memory_file), None)
        except Exception as exc:
            log.warning("Varys: could not write memory file %s: %s", self.memory_file, exc)

    def record_declined_suggestion(
        self,
        suggestion: str,
        reason: Optional[str] = None
    ) -> None:
        """Add a declined suggestion to memory."""
        current = self.load()
        timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
        entry = f"\n## Declined: {suggestion}\n- Date: {timestamp}\n"
        if reason:
            entry += f"- Reason: {reason}\n"
        self.update(current + entry)

    def record_preference(self, preference: str) -> None:
        """Add a user preference to memory."""
        current = self.load()
        timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
        entry = f"\n## Preference: {preference}\n- Date: {timestamp}\n"
        self.update(current + entry)
