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
            "docs/SOURCES.md", "fixtures/planner-scenarios.json", "fixtures/canvas-phase1.json",
            "scripts/estimate_usage.py",
            "templates/wrangler.example.jsonc", "templates/.dev.vars.example",
            "docs/IMPLEMENTATION-PLAN.md"]
CANVAS_PHASE1_SUBMISSION_STATES = {"known", "known_null", "not_returned", "unsupported"}
CANVAS_PHASE1_MAX_SAFE_INTEGER = 2**53 - 1
BANNED_NAMES = {"courses.json", "coursework.json", "coursework-refresh-history.json", "coursework.sh"}
PRIVATE_REFERENCE_HASHES = {
    "13485099d0cb205d4108f0de36b510059035b4bcae9f785b65e253c8d09b191a",
    "248255d61f8219484333a86261e23780bba1ae87e7ac5db51a947fbe481689e8",
}
LOCAL_ONLY_NAMES = {
    "Codex Image Sep 13, 2026, 08_42_01 PM.png",
    "Codex Image Sep 13, 2026, 08_43_40 PM.png",
    "Codex Image Sep 16, 2026, 02_55_45 PM.png",
    "Codex Image Sep 16, 2026, 02_55_51 PM.png",
}
IGNORED_PARTS = {
    ".git", "__pycache__", "node_modules", ".wrangler", ".evidence", ".logs",
    "dist", "build", "coverage", "playwright-report", "test-results", ".playwright",
    "target",
}

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

def _canvas_phase1_submission_state(course_supported: bool, assignment: dict) -> str:
    if not course_supported:
        return 'unsupported'
    if 'submission' not in assignment:
        return 'not_returned'
    if assignment['submission'] is None:
        return 'known_null'
    return 'known'

def validate_canvas_phase1_fixture(fixture: dict) -> None:
    if fixture.get('synthetic') is not True:
        raise ValueError('canvas-phase1 fixture must explicitly be synthetic')
    if fixture.get('institution', {}).get('canvasOrigin') != 'https://canvas.example.invalid':
        raise ValueError('canvas-phase1 fixture must use the inert example origin')

    profiles = fixture.get('profiles', {})
    for name in ('small', 'typical', 'large'):
        profile = profiles.get(name)
        if not profile or profile.get('courseCount', 0) <= 0 or profile.get('assignmentsPerCourse', 0) <= 0:
            raise ValueError(f'canvas-phase1 fixture missing a valid "{name}" profile')
    if not (profiles['small']['courseCount'] <= profiles['typical']['courseCount'] <= profiles['large']['courseCount']):
        raise ValueError('canvas-phase1 profiles must scale small <= typical <= large by course count')
    if not (profiles['small']['assignmentsPerCourse'] <= profiles['typical']['assignmentsPerCourse']
            <= profiles['large']['assignmentsPerCourse']):
        raise ValueError('canvas-phase1 profiles must scale small <= typical <= large by assignments per course')

    courses = fixture['courses']
    course_ids = [c['id'] for c in courses]
    if len(course_ids) != len(set(course_ids)):
        raise ValueError('Duplicate canvas-phase1 course identifiers')
    course_supported = {c['id']: c['submissionIncludeSupported'] for c in courses}

    assignments = fixture['assignments']
    assignment_ids = [a['id'] for a in assignments]
    if len(assignment_ids) != len(set(assignment_ids)):
        raise ValueError('Duplicate canvas-phase1 assignment identifiers')

    seen_states = set()
    for assignment in assignments:
        if assignment['courseId'] not in course_supported:
            raise ValueError('canvas-phase1 assignment references unknown course')
        seen_states.add(_canvas_phase1_submission_state(course_supported[assignment['courseId']], assignment))
    if seen_states != CANVAS_PHASE1_SUBMISSION_STATES:
        missing = CANVAS_PHASE1_SUBMISSION_STATES - seen_states
        raise ValueError(f'canvas-phase1 fixture missing submission states: {sorted(missing)}')

    unsafe_id = fixture.get('unsafeCourseId', '')
    if not unsafe_id.isdigit() or int(unsafe_id) <= CANVAS_PHASE1_MAX_SAFE_INTEGER:
        raise ValueError('canvas-phase1 fixture unsafeCourseId must exceed Number.MAX_SAFE_INTEGER')

def check(root: Path = ROOT) -> list[str]:
    errors = []
    for name in REQUIRED:
        if not (root / name).is_file():
            errors.append('Missing ' + name)
    files = [p for p in root.rglob('*') if p.is_file()
             and p.name not in LOCAL_ONLY_NAMES
             and not any(part in IGNORED_PARTS for part in p.relative_to(root).parts)]
    for path in files:
        rel = str(path.relative_to(root))
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest in PRIVATE_REFERENCE_HASHES:
            errors.append('Supplied private design reference present: ' + rel)
            continue
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
        validate_canvas_phase1_fixture(json.loads((root/'fixtures/canvas-phase1.json').read_text()))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        errors.append('Manifest or fixture error: ' + str(exc))
    return errors

if __name__ == '__main__':
    issues = check()
    if issues:
        print('\n'.join('FAIL: ' + issue for issue in issues)); sys.exit(1)
    print('PASS: required files, internal Markdown links, JSON, reference hashes, and fixture structure.')
    print('Original private-data filenames are absent. This is not a general secret scan or app security audit.')
