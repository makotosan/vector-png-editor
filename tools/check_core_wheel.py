"""Install the built wheel without source imports and exercise packaged worker/CLI."""
import json
import base64
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import venv

dist = Path(sys.argv[1]).resolve()
wheels = list(dist.glob('vector_png_editor_core-*.whl'))
assert len(wheels) == 1, wheels
with tempfile.TemporaryDirectory(prefix='vector-png-wheel-') as directory:
    root = Path(directory)
    env = os.environ.copy()
    env.pop('PYTHONPATH', None)
    env.pop('PYTHONHOME', None)
    venv.create(root / 'venv', with_pip=True)
    python = root / 'venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    subprocess.run([str(python), '-m', 'pip', 'install', str(wheels[0])], cwd=root, env=env, check=True)
    source = root / 'source.svg'
    source.write_bytes(b'\xef\xbb\xbf<?xml version="1.0" encoding="UTF-8"?>\r\n<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="1" height="2" fill="red"/></svg>')
    command = [str(python), '-m', 'vector_png_editor']
    run = subprocess.run(command + ['validate', str(source), '--width', '2', '--height', '2'], cwd=root, env=env, capture_output=True, check=True)
    assert json.loads(run.stdout)['result']['render'] == 'passed', run.stdout
    executable = python.parent / ('vector-png-editor.exe' if os.name == 'nt' else 'vector-png-editor')
    run = subprocess.run([str(executable), 'validate', str(source), '--syntax-only'], cwd=root, env=env, capture_output=True, check=True)
    assert json.loads(run.stdout)['result']['render'] == 'not-checked', run.stdout
    target, rebuilt, extracted = root / 'built.png', root / 'rebuilt.png', root / 'extracted.svg'
    for arguments in [
        ['build', str(source), str(target), '--width', '2', '--height', '2'],
        ['inspect', str(target)], ['verify', str(target)],
        ['rebuild', str(target), str(rebuilt)], ['extract', str(rebuilt), str(extracted)],
    ]:
        run = subprocess.run([str(executable)] + arguments, cwd=root, env=env,
                             capture_output=True, check=True)
        assert json.loads(run.stdout)['ok'], run.stdout
    assert extracted.read_bytes() == source.read_bytes()
    request = {'protocol': 1, 'command': 'validate', 'request_id': 'installed-wheel',
               'source_base64': base64.b64encode(source.read_bytes()).decode(), 'width': 2, 'height': 2}
    run = subprocess.run([str(executable), '--request-json'], input=json.dumps(request).encode(),
                         cwd=root, env=env, capture_output=True, check=True)
    assert json.loads(run.stdout)['request_id'] == 'installed-wheel', run.stdout
    run = subprocess.run([str(python), '-m', 'vector_png_editor.environment'], cwd=root, env=env,
                         capture_output=True, check=True)
    assert json.loads(run.stdout)['report']['healthy'], run.stdout
    print('Clean wheel installation and packaged rendering worker passed outside source tree.')
