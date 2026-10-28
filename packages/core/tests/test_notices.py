"""P0-03 guard: the license inventory must cover the pinned lock.

Every package pinned in the repository requirements.lock must appear
in the root THIRD_PARTY_NOTICES.md at exactly that version, so the
inventory cannot silently drift from the lock.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def _pins() -> dict[str, str]:
    pins = {}
    for line in (ROOT / "requirements.lock").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if "==" in line and not line.startswith("#"):
            name, version = line.split("==", 1)
            pins[name.strip()] = version.strip()
    return pins


def test_every_lock_pin_is_inventoried_at_its_version():
    notices = (ROOT / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
    pins = _pins()
    assert len(pins) == 9, f"expected the 9 application runtime pins, got {sorted(pins)}"
    for name, version in pins.items():
        row = re.compile(rf"^\|\s*{re.escape(name)}\s*\|\s*{re.escape(version)}\s*\|", re.MULTILINE)
        assert row.search(notices), f"{name} {version} missing from THIRD_PARTY_NOTICES.md"


def test_native_and_bundled_components_are_inventoried():
    notices = (ROOT / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
    assert "Cairo (libcairo)" in notices and "LGPL-2.1" in notices
    assert "Monaco Editor" in notices and "0.57.0" in notices
