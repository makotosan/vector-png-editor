import base64
import io
import json
from pathlib import Path
import subprocess
import sys

import pytest
from jsonschema import Draft202012Validator
from vector_png_editor.protocol import parse_request
from vector_png_editor.errors import CoreError
from vector_png_editor import environment
from test_core import SVG

SCHEMAS = Path(__file__).resolve().parents[3] / 'schemas'
if not SCHEMAS.is_dir():
    SCHEMAS = Path(__file__).parent / 'fixtures'
REQUEST = json.loads((SCHEMAS / 'cli-request-v1.schema.json').read_text())
RESULT = json.loads((SCHEMAS / 'cli-result-v1.schema.json').read_text())


def request(**changes):
    return {'protocol': 1, 'command': 'validate', 'request_id': 'preview-1',
            'source_base64': base64.b64encode(SVG).decode(), 'syntax_only': True, **changes}


def parse(value):
    return parse_request(io.BytesIO(json.dumps(value).encode()))


@pytest.mark.parametrize('value', [
    request(), request(input='source.svg', source_base64=None),
    {'protocol': 1, 'command': 'inspect', 'request_id': 'i', 'input': 'a.png'},
    {'protocol': 1, 'command': 'extract', 'request_id': 'e', 'input': 'a.png', 'output': 'a.svg'},
    {'protocol': 1, 'command': 'verify', 'request_id': 'v', 'input': 'a.png'},
    {'protocol': 1, 'command': 'build', 'request_id': 'b', 'source_base64': '', 'output': 'a.png'},
    {'protocol': 1, 'command': 'rebuild', 'request_id': 'r', 'input': 'a.png', 'output': 'b.png',
     'overwrite': True, 'expected_sha256': '0' * 64},
])
def test_request_schema_and_parser(value):
    if value.get('source_base64', 'missing') is None:
        del value['source_base64']
    Draft202012Validator.check_schema(REQUEST)
    Draft202012Validator(REQUEST).validate(value)
    assert parse(value).request_id == value['request_id']


@pytest.mark.parametrize('changes', [
    {'protocol': True}, {'protocol': 2}, {'request_id': ''}, {'request_id': 'a' * 129},
    {'request_id': '\ud800'}, {'command': []}, {'command': 'help'}, {'extra': True},
    {'input': 'also.svg'}, {'source_base64': '!!!!'}, {'source_base64': 'Zh=='},
    {'width': True}, {'width': 0}, {'width': 4096, 'height': 4096},
    {'syntax_only': 1}, {'source_base64': None}, {'source_base64': 'a'},
])
def test_invalid_requests(changes):
    with pytest.raises(CoreError) as error:
        parse(request(**changes))
    assert error.value.code == 'invalid-arguments'


@pytest.mark.parametrize('raw', [b'[]', b'{}{}', b'{"a":1,"a":2}', b'{"value":NaN}',
                                      b'\xff', b'[' * 2000 + b']' * 2000])
def test_bad_json_bounded_result(raw):
    run = subprocess.run([sys.executable, '-m', 'vector_png_editor', '--request-json'], input=raw, capture_output=True)
    value = json.loads(run.stdout)
    Draft202012Validator(RESULT).validate(value)
    assert run.returncode == 2 and value['request_id'] is None
    assert not run.stderr


def test_oversize_read_is_bounded():
    class Stream:
        def read(self, count):
            assert count == 2_000_001
            return b' ' * count
    with pytest.raises(CoreError) as error:
        parse_request(Stream())
    assert error.value.code == 'resource-limit'


def test_decoded_source_limit():
    with pytest.raises(CoreError) as error:
        parse(request(source_base64=base64.b64encode(b'a' * 1_000_001).decode()))
    assert error.value.code == 'resource-limit'


def test_json_six_command_source_roundtrip(tmp_path):
    source = b'\xef\xbb\xbf<?xml version="1.0" encoding="UTF-8"?>\r\n' + SVG
    original, rebuilt, extracted = tmp_path / '日本語 $[] output.png', tmp_path / 'rebuilt.png', tmp_path / 'source.svg'
    base = {'protocol': 1, 'request_id': 'roundtrip'}
    operations = [
        {'command': 'validate', 'source_base64': base64.b64encode(source).decode(), 'width': 2, 'height': 2},
        {'command': 'build', 'source_base64': base64.b64encode(source).decode(), 'output': str(original), 'width': 2, 'height': 2},
        {'command': 'inspect', 'input': str(original)}, {'command': 'verify', 'input': str(original)},
        {'command': 'rebuild', 'input': str(original), 'output': str(rebuilt)},
        {'command': 'extract', 'input': str(rebuilt), 'output': str(extracted)},
    ]
    for operation in operations:
        value = {**base, **operation}
        Draft202012Validator(REQUEST).validate(value)
        run = subprocess.run([sys.executable, '-m', 'vector_png_editor', '--request-json'],
                             input=json.dumps(value).encode(), capture_output=True)
        report = json.loads(run.stdout)
        Draft202012Validator(RESULT).validate(report)
        assert run.returncode == 0 and report['ok'], report
        assert report['request_id'] == 'roundtrip' and not run.stderr
    assert extracted.read_bytes() == source


def test_environment_health_and_failure(monkeypatch):
    report = environment.diagnose()
    assert report['healthy'] and report['render']['render'] == 'passed'
    monkeypatch.setattr(environment.metadata, 'version', lambda name: 'unexpected')
    monkeypatch.setattr(environment, 'validate_render', lambda *args: {'render': 'passed'})
    assert not environment.diagnose()['healthy']
    def fail(*args):
        raise CoreError('render-failed', 'Native Cairo missing')
    monkeypatch.setattr(environment, 'validate_render', fail)
    report = environment.diagnose()
    assert not report['healthy'] and report['render']['error']['code'] == 'render-failed'


def test_environment_without_site_packages():
    run = subprocess.run([sys.executable, '-S', '-m', 'vector_png_editor.environment'], capture_output=True)
    report = json.loads(run.stdout)
    assert run.returncode == 1 and not report['report']['healthy']
    assert report['report']['render']['error']['code'] == 'missing-dependency'
    assert not run.stderr


def test_sdist_schema_copies_match_canonical_files():
    root = Path(__file__).resolve().parents[3] / 'schemas'
    if root.is_dir():
        for name in ['cli-request-v1.schema.json', 'cli-result-v1.schema.json']:
            assert (root / name).read_bytes() == (Path(__file__).parent / 'fixtures' / name).read_bytes()
