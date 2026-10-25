# Real Chrome + native-slot integration tests

Run from the plugin directory after building:

```sh
npm run build && npm run test:browser
# Optional explicit browser executable:
CHROME_PATH=/usr/bin/google-chrome npm run test:browser
```

Chrome must exist and be executable; absence is a failure, never a skip. No Chrome download or listening server is used. `page.route` fulfills only `http://dashboard.test`; every other request is blocked and fails the suite. Chrome uses an ephemeral Playwright context, never the live profile or authenticated GUI. Its command-line flag treats only the intercepted virtual origin as secure so production `crypto.randomUUID()` remains native (as it is on loopback/HTTPS); the fixture does not replace crypto.

The fixture consumes the built, unmodified `lib/client.js` native ModuleLoader entry and the locally installed rc.2 renderer/locale package client bundles. The plugin's actual `apply` runs in real Cordis with real `SlotRegistry`, root/keyed-main/list-sidebar registration, the real renderer and `LocaleRuntime`. A clearly labelled fixture shell supplies same-level peer Plugins navigation; this is **not** the entire DSH layout/sidebar shell or a claim that port 3080 was tested. `uiWorkspace.openSession` is a navigation recorder and fixture page, never a user session execution.

The exported native `LocaleRuntime` constructor/register/bind are exercised, not the full locale settings plugin: the native factory receives fail-closed placeholders for store/primitives peers that the dictionary runtime never uses. Accessing either placeholder is an error. The renderer also receives an explicitly absent session-scope adapter; no sessions are loaded or executed.

The RPC transport is replaced with a Playwright binding. The binding dispatches through the installed strict Typert Gateway, `SessionDashboardRemote`, and real `DashboardService` into a separate file-backed SQLite database per test. Candidates and lifecycle facts come from `FakeHost` in the shared test helper. Save failures are real SQLite transaction failures induced with a temporary database trigger, not fake mutation implementations. Service/store restart reopens that same SQLite file. Native registration unload/remount is checked separately from browser reload.

This runner's system image has no CJK fonts. A 94 KB Noto Sans SC CJK-only subset is vendored under `fonts/` with its SIL OFL license, source URLs, and SHA-256, and served from the same intercepted origin. The fixture shell appends this CJK-only font after `system-ui` as a test-host fallback without altering Latin production metrics. No production stylesheet is modified. Font readiness is awaited. Tests do not download anything; the optional maintenance command `node test/tools/browser-font.mjs` refreshes the subset from public Google Fonts.

Generated full-page screenshots are under ignored `artifacts/browser/`. They support the interaction and computed-layout assertions; they are not substitutes for them. The fixture's explicit light/dark host tokens test dashboard token consumption and readability, not the full installed theme catalog.
