"""Make an explicitly broken test wheel; never used for application setup."""
import base64
import csv
import hashlib
import io
from pathlib import Path
import sys
import zipfile

source, output = map(Path, sys.argv[1:])
with zipfile.ZipFile(source) as archive:
    files = {name: archive.read(name) for name in archive.namelist()}
files['vector_png_editor/environment.py'] = b'import json; print(json.dumps({"protocol":1,"kind":"environment","report":{"healthy":False}}))\n'
record = next(name for name in files if name.endswith('.dist-info/RECORD'))
rows = io.StringIO(newline='')
writer = csv.writer(rows, lineterminator='\n')
for name, data in files.items():
    if name != record:
        writer.writerow([name, 'sha256=' + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode(), len(data)])
writer.writerow([record, '', ''])
files[record] = rows.getvalue().encode()
with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
    for name, data in files.items():
        archive.writestr(name, data)
