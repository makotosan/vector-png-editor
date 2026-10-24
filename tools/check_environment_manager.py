"""Run real managed-venv tests against the built wheel on every CI platform."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
wheels = list(Path(sys.argv[1]).resolve().glob('vector_png_editor_core-*.whl'))
assert len(wheels) == 1, wheels
env = os.environ.copy()
env['VECTOR_PNG_PYTHON'] = sys.executable
env['VECTOR_PNG_ENV_TEST_WHEEL'] = str(wheels[0])
env['VECTOR_PNG_ENV_TEST_VERSION'] = wheels[0].name.split('-')[1]
env.setdefault('VECTOR_PNG_ENV_TEST_ROOT', tempfile.mkdtemp(prefix='vector-png-managed-tests-'))
node = shutil.which('node')
assert node, 'Node 24 is required for the bridge tests'
subprocess.run([node, '--test', 'tests/bridge.test.mjs', 'tests/environment.test.mjs'],
               cwd=root / 'packages/bridge', env=env, check=True)
