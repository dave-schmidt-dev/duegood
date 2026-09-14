#!/usr/bin/env python3
"""Validate this handoff's structure and reference hashes; not a security audit."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = ["README.md", "SPEC.md", "AGENTS.md", "AGENT_HANDOFF.md", "MANIFEST.json",
            "docs/SOURCES.md", "fixtures/planner-scenarios.json", "scripts/estimate_usage.py",
            "templates/wrangler.example.jsonc", "templates/.dev.vars.example"]
BANNED_NAMES = {"courses.json", "coursework.json", "coursework-refresh-history.json", "coursework.sh"}
IGNORED_PARTS = {".git", "__pycache__", "node_modules", ".wrangler"}

def validate_fixture(fixture: dict) -> None:
    if fixture.get('synthetic') is not True:
        raise ValueError('Fixture must explicitly be synthetic')
    if fixture.get('institution', {}).get('canvasOrigin') != 'https://canvas.example.invalid':
        raise ValueError('Fixture must use the inert example origin')
    courses = [c['id'] for c in fixture['courses']]
    assignment_ids = [a['id'] for a in fixture['assignments']]
    if len(courses) != len(set(courses)) or len(assignment_ids) != len(set(assignment_ids)):
        raise ValueError('Duplicate fixture identifiers')
    for assignment in fixture['assignments']:
        if assignment['courseId'] not in courses:
            raise ValueError('Unknown course reference')
    for checkpoint in fixture['normalizedCheckpoints']:
        if checkpoint['parentAssignmentId'] not in assignment_ids:
            raise ValueError('Unknown checkpoint parent')
    for state in fixture['studentState']:
        if state['assignmentId'] not in assignment_ids:
            raise ValueError('Unknown state assignment')
    for task in fixture['personalTasks']:
        if task['courseId'] not in courses or task['source'] != 'student':
            raise ValueError('Invalid personal task')
    cases = [s['id'] for s in fixture['scenarios']]
    if len(cases) != len(set(cases)):
        raise ValueError('Duplicate scenario identifiers')

def check(root: Path = ROOT) -> list[str]:
    errors = []
    for name in REQUIRED:
        if not (root / name).is_file():
            errors.append('Missing ' + name)
    files = [p for p in root.rglob('*') if p.is_file()
             and not any(part in IGNORED_PARTS for part in p.relative_to(root).parts)]
    for path in files:
        rel = str(path.relative_to(root))
        if path.name in BANNED_NAMES:
            errors.append('Original private-data/launcher file present: ' + rel)
        if path.name.startswith(('.env', '.dev.vars')) and not path.name.endswith('.example'):
            errors.append('Non-example secret file present: ' + rel)
        if path.suffix in {'.pem', '.key', '.db', '.sqlite', '.sqlite3'}:
            errors.append('Unexpected credential/database file: ' + rel)
        if path.suffix == '.json':
            try:
                json.loads(path.read_text(encoding='utf-8'))
            except (ValueError, OSError) as exc:
                errors.append(f'Invalid JSON {rel}: {exc}')
        if path.suffix == '.md':
            for target in re.findall(r'\[[^\]]+\]\(([^\s)]+)\)', path.read_text(encoding='utf-8')):
                if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', target) or target.startswith('#'):
                    continue
                target_path = target.split('#', 1)[0]
                if target_path and not (path.parent / target_path).exists():
                    errors.append(f'Broken relative link in {rel}: {target}')
    try:
        manifest = json.loads((root/'MANIFEST.json').read_text())
        for entry in manifest['copied_frontend']:
            digest = hashlib.sha256((root/entry['path']).read_bytes()).hexdigest()
            if digest != entry['sha256']:
                errors.append('Reference changed: ' + entry['path'])
        validate_fixture(json.loads((root/'fixtures/planner-scenarios.json').read_text()))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        errors.append('Manifest or fixture error: ' + str(exc))
    return errors

if __name__ == '__main__':
    issues = check()
    if issues:
        print('\n'.join('FAIL: ' + issue for issue in issues)); sys.exit(1)
    print('PASS: required files, internal Markdown links, JSON, reference hashes, and fixture structure.')
    print('Original private-data filenames are absent. This is not a general secret scan or app security audit.')
