"""P3-03 wiring: the P3-01 CLI integration suite runs inside the
Core CI matrix. The console script is installed alongside the test
dependencies in CI, so the integration tests execute in every
OS/Python cell instead of living outside CI. Locally they skip when
no `vector-png-editor` script is available.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
INTEGRATION = ROOT / "tests" / "integration" / "test_codex_workflow.py"
CLI = shutil.which("vector-png-editor")


@pytest.mark.skipif(CLI is None, reason="vector-png-editor console script not installed")
def test_codex_cli_workflow_integration():
    assert INTEGRATION.exists(), "integration suite missing from the repository"
    env = dict(os.environ, VECTOR_PNG_EDITOR_CLI=CLI)
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", str(INTEGRATION)],
        capture_output=True, text=True, timeout=600, env=env, cwd=ROOT,
    )
    assert proc.returncode == 0, proc.stdout[-3000:] + proc.stderr[-3000:]
