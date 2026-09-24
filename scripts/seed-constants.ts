// Side-effect-free constants shared by `scripts/seed-playwright-session.ts` and the specs that
// assert on its fixture. Specs import from here, never from the seed script itself: the seed runs
// `main()` at module load, so importing it would execute the D1 seed during `playwright test --list`
// (test discovery in `check-test-membership.mjs`), which fails in any fresh checkout.

/** Title text a Playwright spec asserts renders literally (`element.textContent`) with no `<img>`
 * actually created in the DOM — the content-safety check for Canvas-authored text described in
 * `docs/DESIGN-SYSTEM.md`'s Content safety section. Canvas is a third-party content source; this
 * fixture stands in for a title an institution's Canvas instance could plausibly return. */
export const INJECTED_MARKUP_TITLE = '<img src=x onerror="window.__xss=true">Assignment with markup in its title';
