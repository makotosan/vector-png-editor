import os
from pathlib import Path
import uuid
import pytest


@pytest.fixture
def tmp_path(tmp_path_factory):
    custom = os.environ.get("VECTOR_PNG_TEST_TMP_ROOT")
    if custom:
        path = Path(custom) / uuid.uuid4().hex
        path.mkdir(parents=True)
        return path
    return tmp_path_factory.mktemp("core")


@pytest.fixture(autouse=True)
def subprocess_import_path(monkeypatch):
    source = Path(__file__).resolve().parents[1] / "src"
    monkeypatch.setenv("PYTHONPATH", str(source) + os.pathsep + os.environ.get("PYTHONPATH", ""))
