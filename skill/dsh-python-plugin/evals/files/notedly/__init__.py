"""A tiny persistent note store: the business code under conversion (no bridge decorators)."""

import json
import time
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class NoteStore:
    root: str
    max_notes: int = 1000
    _notes: list = field(default_factory=list, repr=False)

    def __post_init__(self):
        self._path = Path(self.root) / "notes.json"
        if self._path.exists():
            self._notes = json.loads(self._path.read_text())

    def add_note(self, title: str, body: str = "") -> dict:
        note = {"id": f"n-{int(time.time() * 1000)}", "title": title, "body": body}
        self._notes.append(note)
        self._notes = self._notes[-self.max_notes :]
        self._path.write_text(json.dumps(self._notes))
        return note

    def list_notes(self) -> list:
        return list(self._notes)

    def search(self, query: str) -> list:
        q = query.lower()
        return [n for n in self._notes if q in n["title"].lower() or q in n["body"].lower()]
