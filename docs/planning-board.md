# Planning Board

`npm run planning-board` starts a small, standalone roadmap planning board in the foreground at `http://127.0.0.1:8789`; stop this foreground process with `Ctrl-C`.

To launch it in the background and record its PID, run:

```sh
mkdir -p .velvet
npm run planning-board >.velvet/planning-board.log 2>&1 & echo $! >.velvet/planning-board.pid
```

Stop that background process with `kill "$(cat .velvet/planning-board.pid)"`, then remove the stale PID file with `rm -f .velvet/planning-board.pid`.

The service is deliberately separate from the application: it binds only to loopback, serves only its own static page and JSON state API, and has no application routes, secrets, telemetry, or remote resources. Its one local state file is `.velvet/planning-board.json`; this directory is gitignored and the state file is written with owner-only permissions where the platform supports them.

## Tailnet access

This is appropriate only for a trusted Tailnet. Tailscale Serve provides Tailnet transport and access policy, but this board does **not** implement remote authentication, authorization, tenancy, or identity. Do not use Funnel and do not treat it as an Internet-facing service.

After starting the board locally, inspect existing mappings first:

```sh
tailscale serve status
tailscale serve --https=8445 http://127.0.0.1:8789
```

This uses a dedicated HTTPS port and must not replace existing `443` or `8443` mappings. Verify the current machine's MagicDNS name with `tailscale status`; the expected form is `https://<machine>.<tailnet>.ts.net:8445`. Remove only this dedicated mapping when finished with `tailscale serve --https=8445 off`. Do not use `tailscale serve reset`, which clears all mappings on the node.

## Planning handoff

Every epic starts included, with **Build** selected and a research-based priority: `Now` (P0), `Next` (P1), `Later` (P2), or `Unscheduled` (P3). The board presents these as compact, full-width rows. Repository Health appears first and remains visually distinct; feature epics are displayed under stable domain headings without changing their persisted IDs or array order.

Each row keeps inclusion, title, description, disposition, current and suggested priority, and a Details indicator visible. Scope and dependencies/risks live in an independent native disclosure. Empty details start collapsed; a row with either saved field starts open. Excluding a row retains all saved values, disables disposition and priority edits, and leaves keyboard-focusable, scrollable, selectable Details text available read-only so existing risks can still be copied.

Feature filters cover title/description text, inclusion, and priority. They only hide rows in the current view: filtering does not paginate, reorder state, discard edits, or reset open disclosures. The live result count includes text, and **Clear filters** restores the full feature view. The compact summary reports included and priority counts, answered decisions, included work needing a decision, and readiness as text after each edit.

Each decision is a compact row with its prompt, answer status, recommendation, and answer select always visible. Shared tradeoff framing appears once in the section introduction. The **Unanswered only** toggle filters the view without changing answers. An answered custom row remains visible while its text area is being edited, then the filter applies when focus leaves or the toggle is explicitly reapplied. Selecting a suggestion saves readable text; selecting **Custom answer** reveals and focuses its labeled text area. Recommendations are not selected automatically.

The board uses one semantic form, native checkboxes/selects/disclosures, strong visible keyboard focus, and no ARIA grid. Routine status and filter counts are polite live updates; save conflicts and errors are assertive alerts. Ordinary field and filter changes update their row and summary in place to preserve keyboard focus and text caret. At narrow widths, the same controls reflow into one column without duplicate mobile markup or a sticky footer.

Older saved boards are migrated in memory when read: cards without an inclusion field are included unless they were explicitly `Remove` or `Defer`; legacy `Need decision` and `Build` cards are included. The expanded decision list is also reconciled without rewriting the state file. Migration is persisted only when you next save.

Fill included card details, decision answers, and overall notes. Save, mark **Ready for implementation plan**, and tell me it is ready. The Copy/Export controls create a plain-text saved handoff brief containing only enabled epics and answered decisions, without internal identifiers.
