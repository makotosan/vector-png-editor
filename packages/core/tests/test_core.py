import base64
import io
import json
from pathlib import Path
import struct
import subprocess
import sys
import zlib

from PIL import Image
import pytest
from vector_png_editor import inspect_document, extract_source, validate_source
from vector_png_editor.document import chunks, read_document, MAX_SVG
from vector_png_editor.errors import CoreError
from vector_png_editor.rendering import render_source, validate_render
from vector_png_editor import _backend

SVG = b'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="1" height="2" fill="red"/></svg>'
CATALOG = json.loads((Path(__file__).parent / 'fixtures/vectors.json').read_text())['fixtures']


def chunk(kind, payload):
    return struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload) & 0xffffffff)


def png(source=SVG, size=(2, 2)):
    buffer = io.BytesIO()
    Image.new('RGBA', size).save(buffer, format='PNG')
    raster = buffer.getvalue()
    if source is None:
        return raster
    return raster[:33] + chunk(b'iTXt', b'vector-png.svg\0\x01\0\0\0' + zlib.compress(source)) + raster[33:]


@pytest.mark.parametrize('item', CATALOG, ids=lambda item: item['name'])
def test_pinned_container_catalog(item, tmp_path):
    path = tmp_path / 'fixture.png'
    path.write_bytes(base64.b64decode(item['png_base64']))
    if item['name'] == 'missing-source':
        assert inspect_document(path)['kind'] == 'png'
        assert read_document(path).source is None
    elif item['container_valid']:
        doc = read_document(path)
        assert doc.source == base64.b64decode(item['source_base64'])
        assert inspect_document(path)['preview'] == 'not-checked'
    else:
        with pytest.raises(CoreError):
            read_document(path)


@pytest.mark.parametrize('prefix', [b'', b'\xef\xbb\xbf', b'<?xml version="1.0" encoding="UTF-8"?>', b'\xef\xbb\xbf<?xml version="1.0" encoding="utf-8"?>'])
def test_source_preservation(prefix, tmp_path, monkeypatch):
    source = prefix + SVG.replace(b'><', b'>\r\n<').replace(b'<rect', b'<!-- <?inert?> -->\r\n<rect')
    path, output = tmp_path / 'source.png', tmp_path / 'source.svg'
    path.write_bytes(png(source))
    monkeypatch.setattr(_backend, 'render', lambda *a, **k: pytest.fail('Passive operation rendered SVG'))
    assert validate_source(source)['render'] == 'not-checked'
    assert inspect_document(path)['kind'] == 'vector-png'
    extract_source(path, output)
    assert output.read_bytes() == source
    with pytest.raises(CoreError, match='never overwrites'):
        extract_source(path, output)
    assert output.read_bytes() == source


@pytest.mark.parametrize('source,code', [
    (b'<?xml version="1.0" encoding="ISO-8859-1"?>' + SVG, 'invalid-svg'),
    (SVG + b'<?real pi?>', 'invalid-svg'),
    (b'<!DOCTYPE svg [<!ENTITY x "boom">]>' + SVG, 'invalid-svg'),
    (SVG.replace(b'red', b'url(https://example.com/)'), 'unsupported-profile'),
    (SVG.replace(b'<rect', b'<image'), 'unsupported-profile'),
    (SVG.replace(b'fill="red"', b'style="fill:red"'), 'unsupported-profile'),
    (SVG.replace(b'fill="red"', b'onload="run()"'), 'unsupported-profile'),
    (b'<svg xmlns="http://www.w3.org/2000/svg"><use href="#x"/></svg>', 'unsupported-profile'),
    (b'\xff', 'invalid-svg'), (b'\0' + SVG, 'invalid-svg'),
    (b' ' * (MAX_SVG + 1), 'resource-limit'),
], ids=lambda value: str(len(value)) + '-bytes' if isinstance(value, bytes) else value)
def test_safety_and_xml_outcomes(source, code):
    with pytest.raises(CoreError) as error:
        validate_source(source)
    assert error.value.code == code


def test_container_valid_unsafe_source_is_passively_extractable(tmp_path):
    source = b'<svg xmlns="http://www.w3.org/2000/svg"><script>inert</script></svg>'
    path, output = tmp_path / 'unsafe.png', tmp_path / 'inert.svg'
    path.write_bytes(png(source))
    extract_source(path, output)
    assert output.read_bytes() == source
    with pytest.raises(CoreError) as error:
        validate_source(source)
    assert error.value.code == 'unsupported-profile'


@pytest.mark.parametrize('kind', [b'acTL', b'fcTL', b'fdAT', b'ABCD'])
def test_explicit_forbidden_chunks(kind, tmp_path):
    path = tmp_path / 'bad.png'
    original = png()
    path.write_bytes(original[:33] + chunk(kind, b'') + original[33:])
    with pytest.raises(CoreError) as error:
        read_document(path)
    assert error.value.code == 'invalid-container'


@pytest.mark.parametrize('mutation', ['duplicate-ihdr', 'nonconsecutive-idat', 'late-gamma', 'late-exif', 'missing-idat', 'bad-filter', 'extra-zlib', 'bad-name'])
def test_png_structure_and_image_data(mutation, tmp_path):
    parts = list(chunks(png()))
    if mutation == 'duplicate-ihdr':
        parts.insert(1, parts[0])
    elif mutation == 'nonconsecutive-idat':
        index = next(i for i, p in enumerate(parts) if p[0] == b'IDAT')
        body = parts[index][1]
        parts[index:index+1] = [(b'IDAT', body[:2]), (b'tEXt', b'note\0inert'), (b'IDAT', body[2:])]
    elif mutation == 'late-gamma':
        parts.insert(-1, (b'gAMA', struct.pack('>I', 45455)))
    elif mutation == 'late-exif':
        parts.insert(-1, (b'eXIf', b'Exif'))
    elif mutation == 'missing-idat':
        parts = [p for p in parts if p[0] != b'IDAT']
    elif mutation in {'bad-filter', 'extra-zlib'}:
        index = next(i for i, p in enumerate(parts) if p[0] == b'IDAT')
        if mutation == 'bad-filter':
            raw = zlib.decompress(parts[index][1])
            body = zlib.compress(b'\x05' + raw[1:])
        else:
            body = parts[index][1] + zlib.compress(b'extra')
        parts[index] = (b'IDAT', body)
    else:
        parts.insert(1, (b'bad!', b''))
    path = tmp_path / 'bad.png'
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + b''.join(chunk(*p) for p in parts))
    with pytest.raises(CoreError) as error:
        read_document(path)
    assert error.value.code == 'invalid-container'


def test_plain_png_and_extraction_protection(tmp_path):
    path = tmp_path / 'plain.png'
    original = png(None)
    path.write_bytes(original)
    assert inspect_document(path)['kind'] == 'png'
    with pytest.raises(CoreError) as error:
        extract_source(path, path)
    assert error.value.code == 'ordinary-png'
    assert path.read_bytes() == original


def test_extraction_publication_failure(tmp_path, monkeypatch):
    path, output = tmp_path / 'input.png', tmp_path / 'out.svg'
    original = png()
    path.write_bytes(original)
    import vector_png_editor.document as module
    def fail(*args):
        raise PermissionError('simulated disk failure')
    monkeypatch.setattr(module.os, 'link', fail)
    with pytest.raises(PermissionError):
        extract_source(path, output)
    assert path.read_bytes() == original
    assert not output.exists()
    assert not list(tmp_path.glob('.vector-png-extract-*'))


def test_real_renderer_alpha_and_validation(tmp_path):
    rendered = render_source(SVG, 2, 2)
    with Image.open(io.BytesIO(rendered)) as image:
        assert image.getpixel((0, 0)) == (255, 0, 0, 255)
        assert image.getpixel((1, 0))[3] == 0
    report = validate_render(b'\xef\xbb\xbf<?xml version="1.0" encoding="UTF-8"?>' + SVG, 2, 2)
    assert report['render'] == 'passed'
    assert report['preview'] == 'not-checked'
    assert report['renderer_version']


def test_render_timeout(monkeypatch):
    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired('worker', 20)
    monkeypatch.setattr(_backend.subprocess, 'run', timeout)
    with pytest.raises(CoreError) as error:
        render_source(SVG, 2, 2)
    assert error.value.code == 'render-timeout'


@pytest.mark.parametrize('args,exit_code,code', [
    (['unknown'], 2, 'invalid-arguments'),
    (['inspect', 'absent.png'], 8, 'io-error'),
])
def test_cli_json_errors(args, exit_code, code):
    run = subprocess.run([sys.executable, '-m', 'vector_png_editor', *args], capture_output=True)
    assert run.returncode == exit_code
    report = json.loads(run.stdout)
    assert report['protocol'] == 1 and report['error']['code'] == code
    assert not run.stderr


def test_cli_end_to_end_json_and_unsafe_exit(tmp_path):
    path, output = tmp_path / '日本語 image.png', tmp_path / 'extracted.svg'
    path.write_bytes(png(b'\xef\xbb\xbf' + SVG.replace(b'><', b'>\r\n<')))
    prefix = [sys.executable, '-m', 'vector_png_editor', '--request-id', 'r1']
    for args in [['inspect', str(path)], ['extract', str(path), str(output)], ['validate', str(output), '--width', '2', '--height', '2']]:
        run = subprocess.run(prefix + args, capture_output=True)
        assert run.returncode == 0, run.stdout + run.stderr
        report = json.loads(run.stdout)
        assert report['ok'] and report['request_id'] == 'r1'
        assert not run.stderr
    assert output.read_bytes() == b'\xef\xbb\xbf' + SVG.replace(b'><', b'>\r\n<')
    output.write_bytes(SVG.replace(b'fill="red"', b'style="fill:red"'))
    run = subprocess.run(prefix + ['validate', str(output)], capture_output=True)
    assert run.returncode == 5
    assert json.loads(run.stdout)['error']['code'] == 'unsupported-profile'


@pytest.mark.parametrize('case', ['elements', 'depth', 'attribute', 'decompression'])
def test_independent_resource_outcomes(case, tmp_path):
    opening = b'<svg xmlns="http://www.w3.org/2000/svg">'
    if case == 'elements':
        source = opening + b'<g/>' * 5000 + b'</svg>'
    elif case == 'depth':
        source = opening + b'<g>' * 33 + b'</g>' * 33 + b'</svg>'
    elif case == 'attribute':
        source = opening + b'<g id="' + b'a' * 100_001 + b'"/></svg>'
    else:
        source = b' ' * (MAX_SVG + 1)
    path = tmp_path / 'resource.png'
    path.write_bytes(png(source))
    with pytest.raises(CoreError) as error:
        read_document(path)
    assert error.value.code == 'resource-limit'


def test_adam7_rgba_raster(tmp_path):
    # A 2x2 transparent image with independently specified nonempty Adam7 passes.
    ihdr = struct.pack('>IIBBBBB', 2, 2, 8, 6, 0, 0, 1)
    raw = b'\0' * 5 + b'\0' * 5 + b'\0' * 9
    source = chunk(b'iTXt', b'vector-png.svg\0\x01\0\0\0' + zlib.compress(SVG))
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + source + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
    path = tmp_path / 'adam7.png'
    path.write_bytes(data)
    assert inspect_document(path)['interlace'] == 1
    assert read_document(path).source == SVG


def test_oversized_request_id_has_bounded_error():
    run = subprocess.run([sys.executable, '-m', 'vector_png_editor', '--request-id', 'x' * 129, 'inspect', 'absent.png'], capture_output=True)
    assert run.returncode == 2
    report = json.loads(run.stdout)
    assert report['request_id'] is None
    assert len(report['error']['message']) <= 2000
