# Dispatch

Dispatch is a desktop workspace for running AI coding agents, reviewing their
work, and shipping the result through Git. It combines an agent board, isolated
Git worktrees, a focused diff reviewer, an integrated terminal, and a PR flow in
one native app.

The core loop is intentionally tight: capture a task, send it to Codex or Claude
Code, watch the run move through the board, inspect the generated diff, and open
a pull request without losing context.

<p align="center">
  <a href="docs/assets/dispatch-demo.mp4">
    <img src="docs/assets/dispatch-demo.gif" alt="Dispatch walkthrough: create an agent task, review the diff, and open a pull request" width="960">
  </a>
</p>

<p align="center"><sub>18-second walkthrough. Click the animation for the MP4.</sub></p>

## Agent Workflow

1. **Capture work in Backlog.** Create a card with a brief, attachments, target
   project, base branch, agent, model, priority, and reasoning mode.
2. **Queue it in To Do.** Dispatch creates an isolated worktree, copies relevant
   local config files, optionally runs the project setup script, and starts the
   selected agent.
3. **Track the run.** Cards move into In Progress while the agent runs. Logs,
   status, run history, and metadata stay attached to the card.
4. **Review the output.** Completed runs land in Review, where you can inspect
   the diff, run project actions, add follow-up instructions, or send the card
   back for another pass.
5. **Approve and ship.** Dispatch stages the agent work, commits, pushes, opens a
   pull request, and moves the card to Done.

## Screenshots

### Agent board

<img width="1800" height="1169" alt="Dispatch agent board with a review card" src="https://github.com/user-attachments/assets/ee053c8d-999f-4745-bbb7-562f9e7bd7eb" />

### Create a card with run configuration

<img width="1800" height="1169" alt="New card dialog with brief, attachment, project, agent, model, reasoning and priority controls" src="https://github.com/user-attachments/assets/5da7e34e-60de-4203-a5a2-50021b9beca9" />

### Card detail, follow-ups, and run metadata

<img width="1800" height="1169" alt="Card detail view with task brief, follow-up composer and floating run metadata island" src="https://github.com/user-attachments/assets/935eb194-575e-4014-a4b2-53a305bee386" />

### Running agent

<img width="1800" height="1169" alt="Card detail view while Codex is running, with abort control and live run status" src="https://github.com/user-attachments/assets/b8809224-1674-44b6-a4f1-3ed66b65cb97" />

### Review the generated diff

<img width="1800" height="1169" alt="Diff review mode for an agent worktree, with staged changes sidebar and Create PR action" src="https://github.com/user-attachments/assets/a5a30e2b-aac0-4d48-9e6f-7508d9320d2e" />

<details>
<summary>More screenshots</summary>

#### Project setup script

<img width="1800" height="1169" alt="Project setup script dialog with detected package manager and AI suggestion button" src="https://github.com/user-attachments/assets/12359752-cfca-4196-8515-4e7a516378c8" />

#### Project actions

<img width="1800" height="1169" alt="Project actions dialog with reusable Dev and Push commands" src="https://github.com/user-attachments/assets/b14837b0-3400-4bf7-9804-796859df0b44" />

#### Card in progress on the board

<img width="1800" height="1169" alt="Board with a card in the In Progress lane" src="https://github.com/user-attachments/assets/17f77196-0fd3-42a8-aaf8-d3b5c0e3b67e" />

#### Backlog card

<img width="1800" height="1169" alt="Board with a backlog card ready to be queued" src="https://github.com/user-attachments/assets/876f6088-db3b-41a2-892d-077ccef80708" />

#### Empty project board

<img width="1800" height="1169" alt="Empty project board with Backlog, To Do, In Progress, Review and Done lanes" src="https://github.com/user-attachments/assets/c50a388b-f830-437f-8219-0fd964a37a57" />

#### Preferences

<img width="1800" height="1169" alt="Preferences dialog with appearance themes, fonts and color controls" src="https://github.com/user-attachments/assets/aab9573e-f52b-480d-899e-6ba61615d459" />

</details>

## Highlights

- **Agent board** with Backlog, To Do, In Progress, Review, and Done lanes.
- **Codex and Claude Code runners** with per-card model, reasoning, priority,
  and fast-mode configuration.
- **Isolated Git worktrees** so each task can run without dirtying the source
  checkout.
- **Project setup scripts** for dependency install, env copying, and other
  pre-run bootstrapping inside the worktree.
- **Reusable project actions** for commands such as dev servers, tests, lint,
  database pushes, or deployment checks.
- **Card detail view** with editable briefs before a run, markdown transcripts,
  run history, follow-up prompts, attachments, and a compact metadata panel.
- **Focused diff review** with side-by-side, inline, and full-file views.
- **Hunk-level actions** for staging, reverting, and committing individual
  changes.
- **Commit and PR flow** that can stage, commit, push, generate PR copy, and
  open the pull request.
- **Integrated terminal** with multi-tab sessions, bottom or right docking,
  setup-script output, clickable links, and persistent sessions while hidden.
- **Search and replace** across the repository with preview before writing.
- **Local preferences** for themes, fonts, diff behavior, AI CLI selection, and
  notifications.
- **Auto-update support** through Tauri updater artifacts on GitHub Releases.

## Tech Stack

- [Tauri 2](https://tauri.app) for the native desktop shell and Rust commands.
- [React 19](https://react.dev), TypeScript, and [Vite](https://vite.dev) for
  the UI.
- [Zustand](https://zustand-demo.pmnd.rs) for app state.
- SQLite via Tauri/Rust for board projects, cards, runs, logs, scripts, and
  attachments.
- `git`, `gh`, Codex CLI, and Claude Code integrations through local CLIs.
- `portable-pty` and xterm.js for the integrated terminal.

## Requirements

- macOS for the primary desktop experience.
- [Bun](https://bun.com) 1.3 or newer.
- Rust toolchain from [rustup](https://rustup.rs).
- Xcode Command Line Tools.
- `git` in `PATH`.
- Optional: GitHub CLI `gh` for pull-request creation.
- Optional: Codex CLI or Claude Code for agent runs and AI-assisted actions.

## Development

Install dependencies and start the desktop app:

```sh
bun install
bun run tauri:dev
```

The default dev command disables Tauri's Rust file watcher so Dispatch can review
or merge changes in its own repository without restarting itself.

When actively changing Rust/Tauri code and you want backend rebuilds on file
changes, run:

```sh
bun run tauri:dev:watch
```

Build the app locally:

```sh
bun run tauri:build
```

## Useful Scripts

```sh
bun run build        # TypeScript + Vite build
bun run preview      # Preview the frontend bundle
bun run tauri:dev    # Run Tauri without Rust file watching
bun run tauri:build  # Build desktop bundles
```

## Project Layout

```text
src/
  app/             App shell, keyboard shortcuts, native menu bridge
  components/      Top bar, diff review, dialogs, terminal, menus
  components/board Agent board, cards, card detail, project sidebar
  features/
    ai/            AI CLI detection and prompt execution
    board/         Board API, store, types, and lane transitions
    git/           Git IPC client and shared Git types
    repository/    Repository state, settings, and user workflows
    search/        Repository search APIs
    terminal/      Terminal IPC client
  lib/             Tauri bridge, paths, theme, diff parsing, utilities

src-tauri/
  src/
    commands/      Rust commands for agents, board, git, gh, terminal, search
    db/            SQLite schema, migrations, and board models
    lib.rs         Tauri builder and command registration
    menu.rs        Native app menu
```

## Safety

- Agent work happens in isolated Git worktrees.
- Setup script failures stop the run and send the card back for attention.
- Destructive discard actions require explicit confirmation.
- Search and replace writes only after preview and user confirmation.
- Git operations shell out to the local `git` binary, so behavior matches the
  user's command line.
- Ignored files are surfaced narrowly for config use cases; generated
  dependency and build trees stay hidden from the Files tab.

## Release

Release builds are created by GitHub Actions from `v*` tags. The workflow builds
macOS Apple Silicon and Intel bundles and creates a draft GitHub Release with
updater artifacts.

The short version:

```sh
# update versions first
git tag v0.2.4
git push origin v0.2.4
```

Then open the generated draft release, confirm that `latest.json`, `.sig`, and
platform installers are attached, and publish it.

See [docs/releasing.md](docs/releasing.md) for the full release checklist and
updater signing setup.
