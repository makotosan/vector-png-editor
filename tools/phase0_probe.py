import base64
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

parser = argparse.ArgumentParser(description='Non-rendering audit of a trusted pinned vector-png source snapshot.')
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--fixtures', type=Path, required=True)
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
source = args.source.resolve()
spec = importlib.util.spec_from_file_location('baseline', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
out = args.output_dir.resolve()
out.mkdir(parents=True, exist_ok=False)
results = []
catalog = json.loads(args.fixtures.read_text(encoding='utf-8'))
for item in catalog['fixtures']:
    path = out / (item['name'] + '.png')
    path.write_bytes(base64.b64decode(item['png_base64']))
    row = {'name': item['name'], 'container_expected': item['container_valid']}
    try:
        svg, size, _ = module._read_document(path)
        row['accepted'] = True
        if 'source_base64' in item:
            row['source_exact'] = svg.encode('utf-8') == base64.b64decode(item['source_base64'])
    except Exception as exc:
        row.update(accepted=False, error=str(exc))
    results.append(row)
svg = '<svg xmlns="http://www.w3.org/2000/svg"/>'
for name, text in [('bom-declaration', '\ufeff<?xml version="1.0" encoding="UTF-8"?>' + svg), ('non-utf8-declaration', '<?xml version="1.0" encoding="ISO-8859-1"?>' + svg)]:
    row = {'name': name}
    try:
        module.validate_svg(text)
        row['accepted'] = True
    except Exception as exc:
        row.update(accepted=False, error=str(exc))
    results.append(row)
report = {'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'note': 'Existing _read_document combines container and profile checks; no rendering in these probes.', 'results': results}
(out / 'results.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report, indent=2))
