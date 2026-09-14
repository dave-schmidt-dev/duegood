#!/usr/bin/env python3
"""Offline arithmetic for Due Good; no network calls, billing changes, or benchmarks."""
from __future__ import annotations
import argparse
from dataclasses import asdict, dataclass, fields
import json
import math
from typing import Any

LIMITS = {"worker_requests_per_day": 100_000, "d1_rows_written_per_day": 100_000,
          "d1_rows_read_per_day": 5_000_000}

@dataclass(frozen=True)
class Assumptions:
    students: int = 100
    syncs: float = 4
    courses: int = 5
    assignments_per_course: int = 40
    page_size: int = 100
    course_pages: int = 1
    token_refresh_calls: int = 1
    enrichment_calls: int = 0
    retry_calls: int = 0
    app_requests_per_sync: int = 6
    other_app_requests_per_student: int = 8
    changed_assignments_per_sync: int = 3
    row_write_multiplier: float = 2
    metadata_writes_per_sync: int = 8
    staging_writes_per_sync: int = 0
    other_row_writes_per_student: int = 8
    rows_read_per_sync: int = 250
    other_rows_read_per_student: int = 20
    other_account_requests: int = 0
    other_account_writes: int = 0
    other_account_reads: int = 0

    def validate(self) -> None:
        for field in fields(self):
            value = getattr(self, field.name)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"{field.name} must be numeric")
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"{field.name} must be finite and nonnegative")
            if field.name not in {"syncs", "row_write_multiplier"} and not isinstance(value, int):
                raise ValueError(f"{field.name} must be an integer")
        if self.page_size < 1:
            raise ValueError("page_size must be positive")
        if self.row_write_multiplier < 1:
            raise ValueError("row_write_multiplier must be at least 1")
        if self.changed_assignments_per_sync > self.courses * self.assignments_per_course:
            raise ValueError("changed assignments exceed the modeled assignment count")

def estimate(a: Assumptions) -> dict[str, Any]:
    a.validate()
    assignment_pages = a.courses * max(1, math.ceil(a.assignments_per_course / a.page_size))
    canvas_calls = (a.course_pages + assignment_pages + a.token_refresh_calls
                    + a.enrichment_calls + a.retry_calls)
    daily_syncs = a.students * a.syncs
    writes_per_sync = (a.changed_assignments_per_sync * a.row_write_multiplier
                       + a.metadata_writes_per_sync + a.staging_writes_per_sync)
    requests = (daily_syncs * a.app_requests_per_sync
                + a.students * a.other_app_requests_per_student + a.other_account_requests)
    writes = (daily_syncs * writes_per_sync
              + a.students * a.other_row_writes_per_student + a.other_account_writes)
    reads = (daily_syncs * a.rows_read_per_sync
             + a.students * a.other_rows_read_per_student + a.other_account_reads)
    totals = {"worker_requests_per_day": requests, "d1_rows_written_per_day": writes,
              "d1_rows_read_per_day": reads}
    warnings = ["Assumptions only: CPU, storage size, bursts, and live Canvas pagination are not modeled.",
                "Supply measured staging/cleanup costs; zero staging writes is not a free-staging guarantee."]
    for key, value in totals.items():
        if value >= LIMITS[key]:
            warnings.append(f"{key} reaches or exceeds the modeled free allowance.")
    return {"assumptions": asdict(a), "limits_checked_on": "2026-09-13", "limits": LIMITS,
            "assignment_pages_per_sync": assignment_pages, "canvas_calls_per_sync": canvas_calls,
            "syncs_per_day": daily_syncs, "canvas_calls_per_day": daily_syncs * canvas_calls,
            "estimated_rows_written_per_sync": writes_per_sync, **totals,
            "naive_assignment_rewrites_per_day_before_overhead":
                daily_syncs * a.courses * a.assignments_per_course,
            "utilization_percent": {k: v / LIMITS[k] * 100 for k, v in totals.items()},
            "warnings": warnings}

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    defaults = Assumptions()
    for field in fields(defaults):
        default = getattr(defaults, field.name)
        parser.add_argument('--' + field.name.replace('_','-'), type=float if field.name in {"syncs", "row_write_multiplier"} else int, default=default,
                            help=field.name.replace('_',' '))
    parser.add_argument('--json', action='store_true', help='Emit machine-readable results')
    args = vars(parser.parse_args())
    as_json = args.pop('json')
    try:
        result = estimate(Assumptions(**args))
    except ValueError as exc:
        parser.error(str(exc))
    if as_json:
        print(json.dumps(result, indent=2)); return
    print('DUE GOOD — USAGE ESTIMATE, NOT A BENCHMARK')
    print('Limits snapshot: 2026-09-13; confirm current account plan before deployment.')
    print(f"Canvas calls per sync: {result['canvas_calls_per_sync']:,}")
    print(f"Canvas calls per day: {result['canvas_calls_per_day']:,}")
    for key in LIMITS:
        print(f"{key.replace('_',' ')}: {result[key]:,.0f} / {LIMITS[key]:,} "
              f"({result['utilization_percent'][key]:.1f}%)")
    print('Naive full assignment rewrites/day before indexes and other overhead: '
          f"{result['naive_assignment_rewrites_per_day_before_overhead']:,.0f}")
    print('\nInputs:')
    for key, value in result['assumptions'].items():
        print(f'  {key}: {value}')
    for warning in result['warnings']:
        print('NOTE: ' + warning)

if __name__ == '__main__':
    main()
