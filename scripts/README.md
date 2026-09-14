# Offline utilities

Run from the package root:

```sh
python3 scripts/check_package.py
python3 -m unittest discover -s tests -v
python3 scripts/estimate_usage.py --students 100 --syncs 4
python3 scripts/estimate_usage.py --students 1000 --syncs 4 --staging-writes-per-sync 200 --json
```

`estimate_usage.py --help` lists every assumption. Canvas page size is the effective returned size in the model, not a promise that Canvas honors a requested value. Every selected course requires at least one assignment-list request even when empty. Set course-page and refresh-token calls to zero for a warm refresh that does not perform those operations.

Incoming Worker requests are modeled independently of outgoing Canvas calls. `row_write_multiplier` is an explicit estimate for index/change-history amplification on changed assignments; metadata and staging/cleanup writes are additional. Count reads from staging and other SQL in `rows_read_per_sync`. Non-sync per-student operations and other account workloads have separate daily inputs. No formula estimates CPU time, payload size, storage growth, burst traffic, or the number of D1 queries per invocation.

Defaults are illustrative, not measured performance. The package checker only validates known filenames, fixture structure, JSON, internal documentation links, and preserved reference hashes. It does not certify arbitrary additions as safe for public release.
