# Session Dashboard · 会话仪表板

[简体中文](<README.md>)

Organize DSH sessions by project: projects, tags and statuses say where the work belongs and where it stands, while execution facts and human acceptance stay separate. Adding a session never copies a conversation, creates an Agent, or starts work.

## Install and Open

Requires Node `>=22.13.0`. The declared DSH support range is `0.2.0-rc.1`, `0.2.0-rc.2`, `0.2.1-alpha.1` through `0.2.1-alpha.4`, and `0.2.1-rc.1` through `0.2.1-rc.3` (nine exact releases, see `package.json`).

Install the prebuilt archive from GitHub Releases (the asset name is version-free, so `latest/download` keeps working):

```sh
dsh plugin --profile web add https://github.com/lemonel/dsh-session-dashboard/releases/latest/download/hsx-dsh-session-dashboard.tgz
```

Replace `web` with the target profile. Then enable the `@hsx/dsh-session-dashboard` bundle on the GUI's **Plugins** page, follow any reload or restart instruction, and open **Dashboard** next to Plugins. Each profile stores its own data; installing into another profile does not update the current GUI. A successful build or pack does not mean the live GUI is deployed.

To build from source instead, run this in the plugin directory:

```sh
npm ci --prefer-offline --no-audit --no-fund
npm test
npm run check:package
npm pack
```

The archive contains runtime output, bundle configuration, an SVG icon and user documentation; no TypeScript loader is needed.

## First Use

1. Click the dashed **New project** tile on the projects overview. A project is one value of the builtin **Projects** tag group.
2. New session asks for a workspace first: the dashboard creates a blank Session, joins it to the current project immediately, and opens it in the native iframe preview where the first message can be sent. An unstarted blank Session in the same workspace is reused; if it belongs to another project, that card is moved here instead of creating another blank.
3. Join an existing session from the plugin entry in the native sidebar, or drag it onto a project card. The move grip at the left of a session title is only for moving between projects.
4. Click a session title to preview its conversation in a floating window (read-only; it never starts or resumes an Agent). The preview can go full screen and can open a second session side by side; closing it keeps a bounded cache. Use the row menu for **Session details** when you need the full facts.
5. Sessions without a project live in the **Unassigned sessions** section at the bottom of the overview; **Archived sessions** has its own section. Both still belong to the dashboard.

## Projects, Tags and Order

- A session belongs to at most one project; a project may contain sessions from different workspaces.
- A tag group is one enumeration: **a session holds at most one value per group**. Ungrouped tags form one implicit group. A project's own shared tags travel on that project value, and session rows show the combined project + session tags.
- Manage statuses, tag groups and tags through **More actions → Categories and order**. Manager sections start collapsed and show only how many groups and values exist; click a heading to edit.
- Statuses, tag groups and tags all support a custom order: the ↑/↓ buttons save immediately and only change display order.
- The project group is builtin: you can add, rename or delete its values (projects), but not the group itself.

## Status, Execution and Review

- Status is the only board-wide classification: builtin In progress / Awaiting confirmation / Awaiting review / Accepted plus board-wide custom statuses, each with an optional colour and a display order.
- Execution facts are separate: stopped, interrupted and failed sessions show as **Stopped / Interrupted / Failed** instead of counting as In progress. **Needs my action** is derived from questions, approvals, blocking, pauses, failure and similar facts.
- Awaiting review is entered only after a complete normal ending, and acceptance always requires your confirmation. It binds the current run, origin and board revision; if the session changed first, the dialog explains why and keeps your selection rather than silently binding a new run.
- The row's status pill changes custom statuses directly; a running session must finish its round first. Session details only keep what a row cannot do: the progress note, source check and execution history.

## Find Sessions That Need You

The **Filters** control at the top right is a general selector. Rows list statuses, projects, each tag group and ungrouped tags with global counts:

- A plain click keeps only that value in its dimension; clicking the sole selected value clears it.
- **Shift-click** adds values inside one dimension: values in a group are ORed, different dimensions are ANDed.
- The trigger shows how many values are active; **Clear all filters** resets everything.
- Filtering narrows sessions inside project cards, the Unassigned section and the Archived section. Counts cover every non-archived session and never change with the selection.
- Filtering is a view only: it writes no data and does not change project order or expansion.

## Review, Conflicts and Safety

- Renames, progress notes and classifications commit with a revision. If another window changed the data first, your input is retained and you are asked to reload instead of overwriting the newer state.
- A service reload, membership change or new run invalidates stale actions; the UI explains why and never retries or accepts automatically.
- Dashboard archive only hides a card from everyday views. It does not change the DSH host archive state and does not stop the Agent; host archive and dashboard archive are separate facts.
- Opening, previewing or inspecting a session never answers a question, grants approval or resumes a Goal for you.

## Archive, Data and Upgrades

- Board data lives at `data/session-dashboard/dashboard.sqlite` inside the target profile. The optional `dataDir` setting can move the directory, but the database stays bound to its profile.
- The current board schema is **11**: a project is a value of the builtin tag group, tags are the only durable foundation, and the runtime/API still expose `projects` and `projectId` as read-only projections.
- Opening a store with `user_version` 8, 9 or 10 upgrades it to 11 in one transaction. Older stores must first be opened by `<=0.6.7`. Before upgrading, stop writers and back up the complete SQLite file including `-wal` / `-shm`.
- Migration is one-way: older plugin versions cannot read a newer store. A failed upgrade keeps the original store and reports the reason; it never silently clears data.

## Optional Extensions

The core works on its own. There are two extension kinds:

- **DSH slot extensions** load through the DSH plugin system and contribute toolbar actions, card badges, single-session actions and similar slots; see the [extension API](<docs/EXTENSION-API.md>) (API v2).
- **Dashboard extensions** live under `extensions/` in the data directory and are loaded by the dashboard's own loader. Capabilities must be declared in the manifest; see the [extension loader](<docs/EXTENSIONS.md>).

Extensions can only query read-only session data and replay changes; they cannot arbitrarily change core state, and undeclared capabilities are never granted.

The sibling `@hsx/dsh-session-dashboard-automation@0.2.0` still declares core `^0.3.0` and has not been updated for 0.7.0, so **do not mix it with this version**. Wait for a release whose core range matches before using automation.

## Compatibility and Verification

- Local verification for this release (2026-10-25, Linux x64 / Node 22.23.1 / Chrome 150): strict type check, build, 570 Node regressions, 61 Chrome interaction tests and the package-content check passed.
- The nine declared DSH releases run through the CI compatibility matrix on Node 22/24 (install, build and behavior checks). That matrix is the release gate; the local machine did not rerun every release, so cloud results are those of the actual CI run.
- Windows, macOS and arm64 were not tested natively here. CI configures the three GitHub-hosted runners, but only a real run is evidence for those platforms.
- Install, GitHub Release and npm publish are separate steps. This repository only creates a GitHub Release from a version tag and never publishes to npm automatically.

## Development

```sh
npm run typecheck
npm run build          # tsc + esbuild into lib/
npm test               # build first, then Node regressions
npm run test:browser   # real Chrome interaction and persistence
npm run check:package  # package contents, entries, locales, API contract
npm run test:surface   # host surface check
npm run test:matrix -- --browser   # exact SDKs in isolated directories
npm run verify:clean   # rebuild from source after deleting output
npm run verify:install -- /absolute/path/package.tgz
```

Business source is strict TypeScript, layered as `src/backend`, `src/frontend` and `src/shared`; build and test scripts stay hand-written JavaScript, and `lib/` is generated output that is not committed.
