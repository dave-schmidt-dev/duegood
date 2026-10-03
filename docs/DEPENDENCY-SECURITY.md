# Rust dependency security status

Checked 2026-10-02 against the locked dependency graph and the upstream advisory
records. `Cargo.toml` dependency requirements remain unchanged; these updates only move compatible
transitive dependencies in `src-tauri/Cargo.lock`.

| Advisory | Affected dependency | Locked version before | Disposition |
| --- | --- | --- | --- |
| [GHSA-82j2-j2ch-gfr8](https://github.com/advisories/GHSA-82j2-j2ch-gfr8) | `rustls-webpki` | 0.103.10 | Updated to 0.103.13, the fixed version recorded by the advisory. |
| [GHSA-xgp8-3hg3-c2mh](https://github.com/advisories/GHSA-xgp8-3hg3-c2mh) | `rustls-webpki` | 0.103.10 | Updated to 0.103.13; the advisory's fixed version is 0.103.12. |
| [GHSA-965h-392x-2mh5](https://github.com/advisories/GHSA-965h-392x-2mh5) | `rustls-webpki` | 0.103.10 | Updated to 0.103.13; the advisory's fixed version is 0.103.12. |
| [GHSA-cq8v-f236-94qc](https://github.com/advisories/GHSA-cq8v-f236-94qc) | `rand` | 0.9.2 | Updated to 0.9.3, the fixed version recorded by the advisory. |
| [GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g) | `glib` | 0.18.5 | **Open.** The advisory's fixed version is 0.20.0. The current Tauri 2.11.6 GTK/WebKit dependency chain requires the 0.18 bindings; forcing 0.20 would break that upstream-compatible graph. The locked macOS target graph was checked with `cargo tree --target aarch64-apple-darwin --locked -i glib` and reports no `glib` dependency. This establishes no `glib` edge for that target, but does not close the advisory for Linux or other GTK/WebKit builds. Reassess when Tauri's compatible bindings move to fixed `glib`. |

The compatible lock updates were made with `cargo update -p rustls-webpki
--precise 0.103.13` and `cargo update -p rand --precise 0.9.3`. No direct
dependency pins were changed. `cargo tree --target all -i rand --locked` did not
show an enabled dependency path under the current default feature selection;
the lockfile alert is still remediated at the locked-package level. The macOS
target check is limited to dependency graph exposure; it is not a complete
platform security audit.

Upstream constraints checked:

- [Tauri 2.11.6 manifest](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.6/crates/tauri/Cargo.toml)
- [webkit2gtk-rs manifest](https://github.com/tauri-apps/webkit2gtk-rs/blob/crate/Cargo.toml)
