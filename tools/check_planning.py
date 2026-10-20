"""Supplementary planning checks; does not establish translation meaning or conformance."""
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
pin = json.loads((root / 'spec-reference.json').read_text(encoding='utf-8'))
assert pin['repository'] == 'makotosan/vector-png-spec'
assert re.fullmatch('[0-9a-f]{40}', pin['revision'])
assert pin['normative_document'] == 'SPEC.md'
issues = sorted((root / 'planning/issues').glob('P*.md'))
expected = {f'P{p}-{n:02d}' for p, count in enumerate([4, 5, 7, 4]) for n in range(1, count + 1)}
assert {p.stem for p in issues} == expected
for issue in issues:
    text = issue.read_text(encoding='utf-8')
    for heading in ['Purpose', 'Target files', 'Implementation', 'Dependencies', 'Acceptance criteria', 'Test method', '目的', '対象ファイル', '実装内容', '依存Issue', '受入条件', 'テスト方法']:
        assert f'### {heading}' in text, (issue, heading)
for path in root.rglob('*.md'):
    text = path.read_text(encoding='utf-8')
    if path.name.endswith('.ja.md'):
        en = path.with_name(path.name.replace('.ja.md', '.md'))
        assert en.is_file(), path
        english = en.read_text(encoding='utf-8')
        assert en.name in text and path.name in english, path
        assert len(re.findall(r'^## ', text, re.M)) == len(re.findall(r'^## ', english, re.M)), path
        assert re.findall(r'```[^\n]*\n(.*?)```', text, re.S) == re.findall(r'```[^\n]*\n(.*?)```', english, re.S), path
    for target in re.findall(r'!?\[[^\]]*\]\(([^)]+)\)', text):
        if '://' not in target and not target.startswith('#'):
            assert (path.parent / target.split('#')[0]).exists(), (path, target)
print('20 bilingual task bodies, pins, local links and pair structure checked; semantic parity requires human/agent review.')

