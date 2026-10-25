# Session Dashboard: Project-Centered Work and Session Status Management

> Historical design baseline for 0.3.0. The current 0.7.0 / schema 11 UI and data rules are documented in the [README](<../README.en.md>) and [CHANGELOG](<CHANGELOG.md>); board columns and the old tab bar no longer exist.

[简体中文](<PRODUCT-DESIGN.md>)

> **Status: implemented rules and acceptance baseline for core `0.3.0` local delivery.** Independent automation is `0.2.0`. R01–R06 were adopted following this iteration's user authorization, retaining their original recommendation status distinct from D01–D06. The Linux isolated checks below are complete, not acceptance of every platform or online instance. Real profile installation, activation, reloads, and publication are neither authorized nor performed; the live GUI has not updated as a result.
>
> For usage and verification scope, see the [English README](<../README.en.md>) / [中文 README](<../README.md>). Contracts are documented in the [technical design](<TECH-DESIGN.md>) and [extension API](<EXTENSION-API.md>). Rules and A01–A24 remain acceptance standards; failed or unverified items are explicit, and previous-version results do not establish this version's acceptance.

## 1. Product Positioning

**Organize work around projects, with a session as the unit of execution and management.**

Users create a project, set shared tags and the custom statuses they need, then add existing sessions or sessions subsequently created in DSH. Each session has its own work status, actual execution state, and human review. Global queues continue to cover review and required attention across projects.

The plugin organizes work and tracks progress. It does not replace DSH conversations, Agent execution, workspaces, or access control. A project is not a directory: sessions from different workspaces may belong to one project. Adding a session does not copy the conversation, create an Agent, or start execution.

### Problems to Solve

- Plan a project before adding sessions.
- Start adding a session directly from the native left sidebar instead of finding it again in a second list.
- Set project-wide tags without repeating the same edits on every session.
- Use user-named work statuses such as research, development, or delivery, each potentially involving several AI runs.
- Keep normal execution completion, human acceptance, and the next work status distinct.
- Let the user choose the destination after review rather than follow a predefined sequence.

## 2. Decisions and Their Scope

### 2.1 Established Product Direction

| ID | Direction | Meaning |
| --- | --- | --- |
| D01 | Projects are the primary organizing entry; sessions are the management unit | Empty projects are useful; members progress independently rather than changing status together |
| D02 | Projects have a set of non-status tags | Shared classification is separate from status; members do not inherit one common current status |
| D03 | Adding from the left session list is a target interaction | Equivalent button actions remain available; dragging is not mandatory; host integration is covered in section 7 |
| D04 | Status supports “custom status → built-in execution and review → custom status” | A session may repeatedly enter the execution process; this rule applies only to status tags |
| D05 | The user freely chooses the next status | No required successor configuration, advancement by column order, or automatic reuse of the previous choice |
| D06 | Acceptance applies to the execution round actually reviewed | Accepting that round's work does not complete all work in the session or the whole project |

### 2.2 Recommended Baseline Adopted for This Iteration

These choices were originally recommendations, with that source kept distinct from D01–D06 above. **Following the user's authorization, R01–R06 are adopted as the implementation baseline for `0.3.0`.** Adoption is not acceptance evidence. Update this document and affected criteria before changing the baseline.

| ID | Recommended baseline | Reason or consequence |
| --- | --- | --- |
| R01 | Explicit project membership rather than automatic tag matching; at most one project per session | Preserves existing membership semantics; matching tags do not automatically add, remove, or duplicate membership |
| R02 | Display project tags dynamically rather than copy them into session-owned tags | Shared and session-owned tags remain distinguishable when projects or tags change |
| R03 | Each project manages its custom statuses with stable identities; an “Unset status” position is available | Projects can use different arrangements; identical names do not mean identical statuses; no mandatory research/development template |
| R04 | Offer both “Accept and choose status” and “Accept only; choose later” | Supports a single action without requiring an immediate destination; cancellation cannot leave a partial operation |
| R05 | Cross-project moves preserve the current round's origin; outside the built-in process, explicitly choose a destination status or Unset | Preserves moving while avoiding invented stages or automatic matching by name |
| R06 | Prefer a dedicated button/drag handle in the native session row on the current host | Avoids incidental sidebar reordering; shipping requires real browser and version compatibility verification |


## 3. Changes from the Previous Version

| Area | Previous `0.2.2` | This iteration's `0.3.0` implementation scope |
| --- | --- | --- |
| Main flow | Add sessions, then classify and group them | Create a project, then create a new session or join from the sidebar, and manage them within it |
| Project | Name, color, single-project membership; empty projects exist but creation is less discoverable | Prominent creation, shared tags, status settings, membership and progress summaries |
| Ordinary tags | Set directly on sessions | Distinguish project-shared and session-owned tags |
| Status | Global In progress, Pending review, Accepted | Custom statuses combined with one built-in execution/review process |
| After acceptance | Remain Accepted | Preserve the round's decision and let the user choose a destination now or later |
| Dragging | Plugin candidate panel → project column; card → project column | Native sidebar entry only: click or drag onto a project card/in-project target; the dashboard no longer has a candidate panel |
| Global views | Board, Pending review, Archive, and a Needs attention filter | Project overview first, with cross-project review, attention, unassigned, and archive views retained |

Accepted becomes **a human decision for one execution round and an optional holding position**, rather than an apparent endpoint for all work. Existing acceptance records must not be removed or rewritten as a result.

## 4. Projects, Sessions, and Tags

### 4.1 Projects

A project includes at least a name, optional color, shared tags, available custom statuses, and display order. An empty project remains visible and can accept sessions.

- Creating a project does not import all host sessions, create a conversation, or start an Agent.
- Show member, pending-review, and needs-attention counts using unique sessions.
- A project has no current status inherited by every member. Aggregated member statuses do not automatically declare the project complete.
- Projects can be deleted: deletion clears only the grouping concept (name, color, shared tags, custom statuses and membership). Its sessions become unassigned and stay on the dashboard with their work state reset; host chats, history and execution facts are unaffected. Cascading deletion, bulk archiving, member permissions and project hierarchies remain out of scope.
- Unassigned sessions retain a separate entry; not choosing a project does not lose data.

### 4.2 Sessions

Within one profile, each session still has one dashboard record. Multiple appearances refer to that record and must not duplicate counts or review history.

Session rows offer a read-only conversation preview: it reads user, assistant and tool content from the current or persisted log without sending a message, starting or resuming an agent, and never replaces opening the session.

A session retains its title override, progress note, ordinary tags, relationships, project membership, and work-status information. Changing project does not change the workspace, start execution, or overwrite saved notes and human decisions.

### 4.3 Ordinary Tags and Priority

Under R02, visible ordinary tags are the deduplicated union of project-shared and session-owned tags, with their sources inspectable.

- A tag from both sources appears once, but both sources remain recorded.
- Removing a project tag does not remove the same tag independently added to a session.
- Moving projects changes the project-shared portion; session-owned tags remain unchanged.
- Unchecking a tag in session details must not silently edit the whole project's shared tags; direct the user to project settings instead.
- Ordinary tags trigger neither execution nor review/status transitions. Dragging between ordinary-tag columns is out of scope.
- Priority remains a session-specific choice and is not automatically overwritten by project or stage changes.
- New UI tag filters use the displayed union and distinguish sources. Existing automation/API tag fields must not silently acquire this meaning; see section 10.

### 4.4 Status display and Needs my action

- Needs my action is not a stored status. It is a derived attention layer over execution facts (waiting for input, waiting for approval, resume needed, failure, interruption, sync trouble); it is orthogonal to status, may appear on any status, and never rewrites the stored state.
- The card always shows its real status (including a custom name or No work status). Needs my action is only a small mark beside the status whose hover and screen-reader text name the concrete reason; it never replaces the status text. The mark's text comes from the system's own turn/end reason: interrupted, failed, stopped by hand, or goal blocked. When the system has not closed the run there is no such conclusion, and the dashboard never guesses one.
- Completion notices appear only when the session main agent's round is truly settled: a round that ended while child agents still run stays silent, one notice appears once the board settles it (awaiting confirmation/review, no running child agents), child-agent completions never notify on their own, and archived sessions stay silent.
- One colour map serves every surface: In progress the info blue, Awaiting confirmation the same info blue on purpose (the live spinner is what distinguishes a running round), Awaiting review the warn yellow, Accepted the ok green; a custom status uses its own colour or the faint tone when it has none, and No work status uses the faint tone. The attention mark uses the danger tone. The status chip, the status dropdown options and the board column heads all paint from this map.
- When the system reported a terminal failure (interrupted, failed, stopped by hand) while the card is still in the built-in In progress position, the status chip shows that system outcome (Interrupted / Failed / Stopped) in the danger tone instead of showing both contradictory words. This is display only: the stored status stays In progress, its placement is unchanged, and the status picker, acceptance and archive rules are untouched.

## 5. Main User Flows

### 5.1 Create a Project, Then Add Sessions

1. Open the project overview and choose New project.
2. Enter a name and shared tags. Custom statuses can be created now or later.
3. Save an empty project without being required to select a session.
4. Drag from the plugin's entry in a native session row, or click Add to project and select the destination.
5. Create one dashboard record for an untracked session; apply move rules to an existing member without duplicating it.
6. Open the project board to inspect and change individual session statuses.

### 5.2 Research and Development Are Only an Example

```text
Project: Payment system redesign
Shared tags: Client A, Backend, Phase 2
Custom statuses: Research planned, Development planned, Ready for delivery, On hold

Session: API proposal
Research planned
  → User actually starts execution in DSH
  → In progress (origin status: Research planned)
  → The complete round ends normally
  → Pending review (origin status: Research planned)
  → User accepts and freely chooses Development planned
  → Development planned
  → A later real run enters a new built-in execution/review cycle
```

The user may instead select Research planned again, choose On hold, or accept without deciding yet. The example does not require research to lead to development, and names do not define behavior.

### 5.3 Freely Choose the Next Status

The review dialog shows the session, the round's origin status, the current execution round, and the review guidance. Destination options come from the **available custom statuses of the session's current project**, with no system-preselected destination. An explicit drop onto a custom status may carry that user choice into the dialog, but still requires review and confirmation rather than immediate submission.

- The user can choose the original or another available status, regardless of adjacency or any notion of forward progress.
- Accept and move to… requires an explicit destination and confirmation. It must not silently use the first column or the previous result.
- Under R04, Accept only; choose later leaves the card in the built-in Accepted position.
- Freedom applies to the next work status, not to declaring execution facts successful.
- Choosing a status does not send a message, start/resume an Agent, or resolve a pending question or approval.
- A subsequent manual custom-status change does not create another acceptance record.

## 6. Rules for Status Tags

### 6.1 One Main Status per Card, with Execution Origin Preserved

Custom statuses are separate from ordinary tags. A card occupies one main status position; when the built-in process takes over, the origin custom status remains available.

| Information | Product meaning |
| --- | --- |
| Custom status | The user's current work arrangement, such as Research planned, Ready for delivery, or On hold; the name triggers no special behavior |
| Round origin | The project, custom status, and names associated with the round when execution can be reliably identified; explains what that round belongs to |
| Built-in status | In progress, Pending review, Accepted; constrained by actual host execution and human decisions |
| Runtime details | Running, waiting for an answer/approval, paused, failed, interrupted, awaiting continuation, sync unavailable, and other supported facts |
| Human record | The authenticated user's decision, its execution round and time, and the chosen destination; do not invent a name or account attribution when the host supplies no verifiable personal identity |

“Stage” describes the round's origin, not an additional required entity for users to configure. The UI must not rename a user status such as Research planned into Research and treat it as a different status.

A suggested card label is Pending review · Origin: Research planned. In progress does not mean the Agent is running at this instant: waits, failures, and awaiting-continuation conditions must remain visible.

### 6.2 Entering and Leaving the Built-in Process

| Current situation | Event or action | Result |
| --- | --- | --- |
| Reliably confirmed to have no actual round and no pending execution | User selects a custom status | Allow selection from Unset or the legacy In progress / Not started presentation without inventing execution or acceptance |
| Custom or Unset status | A real new execution starts in DSH | Enter In progress and record the origin; plugin initiation is not required |
| Already in the built-in process | A real new execution starts | Track the new round and invalidate the old review; retain old records without reusing acceptance |
| In progress | The complete round ends normally | Enter Pending review, never directly a custom status |
| In progress | A wait, pause, block, failure, or interruption occurs | Preserve origin and the actual reason; do not treat it as completion or advance |
| Pending review | Accept and select a custom status | Atomically save the acceptance and destination, then enter that status |
| Pending review | Accept only | Save acceptance and remain Accepted until the user chooses |
| Pending review | Explicitly return for more work | Record the returned/not-accepted decision; show In progress / Awaiting continuation without starting AI |
| Accepted | Freely select a custom status | Preserve acceptance and move without accepting again |
| Custom status | User selects another custom status | Record a manual adjustment without inventing execution or acceptance |

While already inside the built-in process, a new real execution retains the origin if it still applies to the current project: it continues the same work arrangement rather than automatically selecting a next status. If origin cannot be established, execution predates membership, or a cross-project move leaves the new origin unspecified, show Origin status unspecified. Do not infer it from titles, conversation text, matching names, tags, or the newest configuration. When execution is discovered after delayed synchronization or downtime, bind an origin only if the status at execution start can be reliably established; never backfill the past using the latest status at synchronization time.

### 6.3 Required Restrictions

- Dragging or editing cannot directly manufacture Running or Pending review.
- Ordinary movement cannot silently accept pending work. Dropping Pending review onto a custom status opens acceptance with destination selection rather than directly writing the status.
- Ordinary movement must not hide actual execution or an unresolved built-in process. Sessions reliably confirmed never to have executed and to have no pending input are not locked merely because the old version displayed In progress; they can choose an initial custom status as above. Other cases can be handled in the original session. A future Abandon this round action requires a separate design and cannot count as acceptance.
- Returning work does not prevent rework; the next real run is handled as a new round. Pause, stop, and cancel do not mean accepted work.
- The end of an AI message, completion of a tool, or Agent idle is insufficient evidence of normal completion. Gaps between Goal continuation rounds are not stage completion either.
- Acceptance checks the actual session, execution round, runtime state, and validity of the origin, membership, and project/destination selection. A new round, remove-and-rejoin, or concurrent change invalidates the old dialog.
- Cold historical records can be displayed, but the existing safety boundary remains: no acceptance when the current execution state cannot be reliably checked.
- Late or duplicate completion for the same round must not pull a session back from its chosen custom status into Pending review.
- Changing ordinary tags, display order, or a status name creates neither an execution round nor acceptance.
- A custom status named Done is not evidence of human acceptance. Built-in statuses have clear fixed styling; custom statuses cannot impersonate their reserved names or identities.

### 6.4 Saving, Cancellation, and Conflicts

- Accept and move to… is one user operation: acceptance and destination succeed or fail together.
- Cancelled confirmation, stale source, or an unavailable target commits neither half. Retain the selection and explanation for rechecking; do not substitute another destination.
- After Accept only succeeds, closing a later status picker does not undo acceptance; the card remains Accepted.
- Recheck concurrent edits, execution starting during drag, status deactivation, and project movement at submission. Do not show success before committing and then silently reverse it.
- Validate the status selection and origin revisions too; the former card metadata revision alone must not overlook newly introduced state changes.

### 6.5 Managing Custom Statuses

Under R03, each project can create, rename, color, order, and deactivate custom statuses. Display order is not transition order.

- No required default starting status or next status. Unset status is a display position, not an automatically created business label.
- Deactivated statuses cannot be new destinations. Existing members, origins, and history remain visible; they are not automatically moved or hidden. Users may move cards out to available custom statuses.
- Referenced statuses cannot be hard-deleted. Merging, a global cross-project status catalog, and automatic bulk reassignment are out of scope.
- Renaming preserves identity; history shows the name at the time. Rename/deactivation does not create a new stage for an old run or revoke accepted work.
- Unassigned sessions retain built-in status management and unspecified origins. Under this baseline, a session must join a project before choosing that project's custom statuses.

## 7. Adding, Moving, and Dragging Sessions

### 7.1 Keep Two Drag Operations Distinct

| Action | Changes | Does not change |
| --- | --- | --- |
| Drop onto a project card, project header, or Add to this project area | Membership; the displayed shared-tag source changes under R02 | No acceptance, AI start, or overwrite of session-owned tags or notes |
| Drop onto a custom-status column inside a project | Requests a status change, opening review confirmation where necessary | The destination is not evidence that execution started, ended, or was accepted |

An untracked sidebar session cannot become accepted merely by landing on a status column, nor can the drop invent a stage for its past execution. Adding and changing status must remain distinct in the interaction and its validation.

### 7.2 Native Left-Sidebar Entry

Read-only inspection of DSH `0.2.0-rc.2` found that native session-row dragging carries an ID in `text/plain` for host reordering. Drag end can still commit the last visited reorder position. This is not an established cross-plugin Session drag protocol, and handling the destination cannot guarantee removal of source-side sorting effects.

Under adopted R06, this iteration uses the public `sidebar.workspaces.session.row.action` and `sidebar.workspaces.session.menu.item` slots for plugin-owned buttons/menu items:

- Click to choose a project, or drag from the dedicated button onto a project.
- Handle events only on plugin-owned elements; do not start the parent row's sort, inspect private DOM, or rewrite host UI.
- Use an explicit plugin payload. An ID or MIME type is not authorization; the backend still validates the current session, profile scope, membership, and revisions.
- Do not keep Add session or the candidate panel as dashboard fallbacks: existing sessions join only from the native sidebar entry or by dragging. Builds lacking the public sidebar entry offer no dashboard way to add an existing session. Narrow or collapsed layouts must not pretend to offer identical dragging.
- Native whole-row dragging is not a default guarantee for this phase. Reassess if the host later provides a verifiable formal protocol; do not force it through global interception or host changes.

This is a feasibility finding for the inspected version, not browser acceptance or evidence that all eight currently supported versions offer the new capability.

### 7.3 Membership Rules

- New session: create one card. No default historical acceptance; use reliable runtime facts without inventing a pre-membership stage. If no actual round or pending execution is reliably confirmed, start at Unset and allow the user to choose; unknown is not equivalent to never executed.
- Already in the same project: show Already added and offer navigation without duplication or overwrites.
- In another project: make the source/destination clear, handle status differences under R05, and commit after confirmation.
- Board-archived: require explicit restoration; dropping cannot silently restore it.
- DSH-archived: retain the existing explicit-selection rules. Adding does not unarchive or run the Agent. Unknown archive state is identified as unknown, not treated as active to allow restricted operations.
- Missing/inaccessible session, remove-and-rejoin, unavailable project, or changed source revision: reject the stale operation, preserve data, and explain how to retry from a fresh selection.
- Hidden by current filters after adding: explain success and why it is hidden, with a way to locate it; do not silently clear filters.
- Invalid target or cancelled drag: no membership, status, or native sidebar-order write.

### 7.4 Status Origin Across Projects

Under R05:

- Outside a built-in process requiring attention, a cross-project move explicitly selects a target-project status or Unset; matching names are not mapped automatically.
- While running, pending review, holding at Accepted, or returned and awaiting continuation, project membership may change, but the round retains and displays its original project and status.
- The move neither accepts the round nor changes its built-in status. Later review selects among the current project's available statuses, and old confirmations must be rechecked.
- If the next real run has no explicit origin in the destination project, its origin remains unspecified rather than borrowing a status from the previous project.
- Past execution/review records retain their original source. Project renames, moves, and tag changes must not rewrite history.

## 8. Page Organization

```text
Native DSH sidebar                Dashboard main area
Session list + Add to project     Projects / Pending review / Needs attention / Unassigned / Archive
                                  ├─ New project
                                  ├─ Project cards: name, shared tags, session/attention counts
                                  └─ Project page
                                     ├─ Name, shared tags, Edit project, New session
                                     ├─ Custom-status and built-in-status board sections
                                     └─ Session details: notes, tag sources, execution/review history
```

- Project overview is the new-user home. Preserve existing users' saved entry/filter state where possible, with a clear return to Projects instead of losing their location during upgrade.
- Inside a project, group by status by default, with a tag view available. Changing the view does not change membership or status. A project card's session list and each board column follow the configured status order, with the most recently active session first inside one status; activity updates reorder immediately.
- Visually distinguish custom statuses from built-in execution/review columns without presenting the built-in columns as the only endpoint. Each card appears once on the main status board.
- Tag views may show several references to a card; totals remain deduplicated.
- Global review and attention totals are independent of the current project filter. Keep them separate: failures and unanswered questions are not pending acceptance.
- Cross-project custom-status summaries retain project qualification instead of merging identical names into one status.
- Distinguish an empty project, no sessions, no filter matches, and load failure; errors are not empty projects.
- Every drag action has an equivalent button/keyboard path. Touch does not depend on hover; preserve understandable focus and location after actions.
- New features and changed existing UI require host-locale-based zh/en. Do not translate user-provided project names, statuses, or tags.

## 9. Records and Reliability

This phase records round origins, manual custom-status changes, acceptance/return decisions, and destinations. Details should explain which round ran under which status, how the user handled it, and where it went. Store necessary business records, not conversation bodies.

- Use stable identities, not names, column positions, or current display status as execution-round identifiers.
- Preserve origin and human decisions as they were. A new round replaces the current display without deleting previous decisions.
- Define history retention and capacity in the technical design. The existing expiring extension event stream is not permanent history, and storage must not grow without bounds.
- Duplicate requests cannot duplicate membership, acceptance, or transition records. Retries cannot apply an old destination to a new round.
- Authentication, cancellation, source checks, multi-window conflicts, and pre-commit validation remain intact.
- Closing a page does not stop backend synchronization. Reload, disable, and uninstall clean resources; old pages/requests cannot write into a new instance.
- Board archiving changes everyday visibility only. It neither stops AI nor means DSH session archiving or project completion.

## 10. Existing Data, Public APIs, and Automation

### 10.1 Upgrade

- Preserve existing project identities, membership, tags, titles/notes, relationships, archive state, execution rounds, human decisions, and timestamps.
- Every stored priority is merged into the custom status list by name: an existing status with the same name absorbs it, a new name becomes a new custom status. The old priority list, filters, grouping and per-card priority field are cleared on upgrade without silently widening filters.
- Existing projects start with no shared tags. Existing session tags remain session-owned rather than being promoted automatically.
- Existing In progress, Pending review, and Accepted records retain compatible presentation. Missing origins are shown as unspecified; do not invent research, development, or a default stage. After a fresh reliable check, legacy In progress / Not started records may choose an initial custom status without first executing or being accepted.
- Migration does not emit fresh completion, invent acceptance, choose a next status, or execute a backlog.
- Preserve accessible old human records without claiming to reconstruct history that the old version never saved.
- Do not change package/plugin identity, database location, or profile binding just because positioning changes. Naming can be revisited separately; this phase retains Session Dashboard.
- Migration is atomic; failure preserves the original data. Provide accurate backup guidance first. Older versions reject formats they cannot understand; copying only a live SQLite main file is not a downgrade procedure.

### 10.2 Third-Party APIs and the Independent Automation Plugin

The previous API v1 and automation assumed three fixed statuses, session tags, and project membership. Core `0.3.0` adopts API v2 and **explicitly rejects v1**. Custom product statuses cannot simply be inserted into old fields and called compatible.

- v2 distinguishes builtin/custom/unset `placement`, the latest built-in execution disposition, frozen round origin, and human decisions. Custom Done cannot map to human Accepted. See the [extension API](<EXTENSION-API.md>) for exact method names and parameters.
- Distinguish project-shared, session-owned, and display-union tags. Preserve existing rule matching; upgrades do not silently broaden scope, and new scope needs explicit configuration. The independent automation plugin in this iteration supports only session-owned tag scope, with no project/combined-tag rule controls.
- Stage acceptance or a custom-status transition does not start the next run or grant extensions write authority over core state.
- After a new stage/round, project move, or membership recreation, old reminders/reports are not current results. Unavailable source data or incompatible APIs explicitly disable affected functionality.
- Independent automation stays off by default with its existing grants and local-only boundaries: no automatic acceptance, commands, or external delivery.
- If old extensions cannot correctly understand the data, explicitly reject incompatible calls rather than disguise unknown statuses as In progress or an empty result.

## 11. Scope and Development Order

### Included

Project overview and empty projects; shared tags; custom-status management; session state and round origin; free destination selection after review; single-session sidebar addition/dragging; existing archive/global queues; necessary history; migration; public API/automation adaptation; corresponding bilingual UI/docs and tests.

### Excluded

Automatic tag-based membership, simultaneous multi-project membership, nested projects, project-level default states or priorities, bulk operations, configured successors/flowcharts/conditional routing, multilevel approval, automatic session creation, starting/resuming AI from the board, task decomposition or multi-Agent orchestration, automatic acceptance, AI quality judging, external notifications, host modifications, and cross-profile projects.

### Implementation and Joint Acceptance Sequence

| Phase | Work | Gate before proceeding |
| --- | --- | --- |
| 1. Finalize design | R01–R06 adopted; interactions; data/migration/API and history-retention design; verify new host capabilities | Consistent status semantics, explicit breaking API changes, and recovery approach |
| 2. Core rules | Projects, tag sources, custom statuses, round origin, atomic acceptance/destination, migration | Domain, concurrency, persistence, failure recovery, and real RPC tests pass |
| 3. Project UI | Overview, project board, status settings, details, global queues, zh/en, keyboard use | Buttons can complete all core flows without dragging |
| 4. Sidebar integration | Public row button/menu, dedicated dragging, project targets | Browser tests with real host components show no sidebar reorder/opening side effects; missing capabilities have a clear fallback |
| 5. Joint acceptance | Automation/third-party API, compatibility matrix, lifecycle, clean build, package install | Criteria below pass; docs reflect actual capabilities; installing/reloading the live instance needs separate authorization |

The user specified core `0.3.0` and independent automation `0.2.0` for this iteration. Updating version metadata does not publish a release, replace earlier archives, or update the live GUI.

## 12. Product Acceptance Criteria

These remain **product acceptance criteria, not an all-environments-passed checklist**. This iteration's rules are implemented; changes to R01–R06 require matching updates.

**Verified scope:** each of the eight exact SDK releases passed 308 Node tests and 32 baseline Chrome tests on Linux x64 / Node 22.23.1 / Chrome 150. A12's real-mouse drop-to-custom-state confirmation separately passed on all eight releases. A04 used real native-sidebar components; A22 covered consecutive disposal, re-enabling, and reloads with isolated official ModuleLoader/SlotRegistry and temporary hosts; A23's bilingual, keyboard, and narrow-layout checks ran in isolated browsers. None is acceptance of the current live GUI.

**Not run or not verified:** A22's current-instance watcher / online HMR was not verified. A23's test fonts and screenshots do not guarantee identical fonts/layouts on user devices. For A24, locked installation, rebuilding without inherited output, and package-content checks passed in a fixed source copy; this is not a clean Git checkout of the original repository. Consult the accompanying delivery verification record for independent-checkout rebuild and installation results for the final delivery tree. Windows, macOS, arm64, Node 24, cloud CI, real profile installation/activation/reloads, and public releases were not performed and are not counted as passes. A01–A24 retain their rules and expectations below; evidence is not extrapolated beyond its environment.

| ID | Scenario | Expected result |
| --- | --- | --- |
| A01 | Create a project with no sessions | It stays visible, accepts tags/custom statuses, and is a valid add target |
| A02 | Add an untracked session from the sidebar | One record in the correct project; no AI start, workspace change, or invented acceptance |
| A03 | Add to the same project again or retry a request | No duplicate cards/history/decisions; existing fields unchanged |
| A04 | Drag across native rows, cancel, or drop on an invalid area | No sidebar reorder, ordering-mode change, or session opening; failed addition writes no membership |
| A05 | Edit shared tags, use both sources, or display tags after moving projects | Correct union/source display and retained session-owned tags; tag changes cause no additional status transition; cross-project status selection follows section 7.4 |
| A06 | Reorder, rename, or deactivate a custom status | No automatic transition; history remains identifiable; inactive targets reject new selection |
| A07 | Start a Research planned session in native DSH | Enter the built-in process with its correct origin, without plugin initiation |
| A08 | Normal completion versus wait/pause/failure/interruption | Only full normal completion becomes Pending review; other conditions preserve origin and do not claim success |
| A09 | After acceptance choose a nonadjacent/original/On hold status | Explicit choices with no fixed successor or system default; an explicit drop target may carry over but still needs confirmation; no AI start |
| A10 | Accept only, close, and choose later | Remain Accepted; later movement adds no duplicate acceptance and preserves history |
| A11 | Cancel Accept and move, invalidate target, or fail storage | No partial acceptance/destination commit; existing data and local choice remain recoverable |
| A12 | Drag Pending review to custom status or drag directly into built-in columns | The former requires human confirmation; the latter cannot manufacture execution/completion/acceptance |
| A13 | Return work, receive late completion, then actually start a new round | Old events do not reverse return; the new round can enter execution and review again |
| A14 | Receive duplicate same-round completion after choosing a destination | No return to Pending review and no duplicate history |
| A15 | A new execution starts and ends while review is open | Reject old confirmation rather than accept the new round using the old choice |
| A16 | Move running/pending work to a project with a same-named status | Preserve origin and built-in state; no automatic name-based mapping |
| A17 | Never executed, execution predates membership, delayed sync, cold history, or sync failure | Reliably unexecuted sessions can select an initial status; otherwise explicit unspecified/unavailable state, no current-status backfill into history, and no bypassed review |
| A18 | Board archive, DSH archive, restore, remove-and-rejoin | Keep archive meanings separate; no silent restore/run; old member operations invalidated |
| A19 | Multiple tag appearances and global review/attention totals | Deduplicated sessions and explicit scopes; custom Done is not human acceptance |
| A20 | Migrate existing data and inject migration failure | Preserve identities/classification/decisions; no fabricated origin/execution; failure preserves original data |
| A21 | Old API/automation reads new statuses and project tags | Explicit compatibility or rejection; no broadened old rules or obsolete-round tasks |
| A22 | Multiple windows, reload, two consecutive replacements, disable/re-enable, unload with requests pending | No duplicate entries/listeners/requests; old callbacks cannot write new state; committed data remains |
| A23 | zh/en, keyboard, narrow layout, missing public sidebar entry | Core flows remain usable; accurate errors/empty states; working button fallbacks |
| A24 | Final supported-version and package acceptance | Evidence per version for new capabilities; clean build and actual package install; isolated tests are not a claim that the live GUI updated |

## 13. Relationship to Other Documentation

- This document owns this iteration's behavior, scope, and acceptance criteria. Both languages preserve decision origins, rules, and unfinished items.
- The [technical design](<TECH-DESIGN.md>) records schema 3 models, commands, source witnesses, transactions, history, migration, and verification boundaries; implementation does not replace product acceptance.
- The [extension guide](<EXTENSION-API.md>) documents exact API v2 fields and available capabilities, with explicit v1 rejection rather than a lossy three-state facade.
- The [English README](<../README.en.md>) / [中文 README](<../README.md>) follow user operations. Documentation, metadata, and screenshots claim only what implementation and actual verification support.
- Code development is authorized in this iteration. Real profile installation, reloads, publication, and changes to the live GUI remain outside that authorization.
