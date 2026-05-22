# Squint

Squint is a desktop Git client built for reviewing, editing, staging, and
shipping code changes quickly. It is intentionally focused: open a repository,
inspect the diff, stage exactly what should ship, write the commit, and create a
pull request without leaving the app.

F<img width="1800" height="1169" alt="Screenshot 2026-05-22 at 16 50 51" src="https://github.com/user-attachments/assets/a5a30e2b-aac0-4d48-9e6f-7508d9320d2e" />
<img width="1800" height="1169" alt="Screenshot 2026-05-22 at 16 50 37" src="https://github.com/user-attachments/assets/aab9573e-f52b-480d-899e-6ba61615d459" />
<img width="1800" height="1169" alt="Screenshot 2026-05-22 at 16 49 03" src="https://github.com/user-attachments/assets/ee053c8d-999f-4745-bbb7-562f9e7bd7eb" />
<img width="1800" height="1169" alt="Screenshot 2026-05-22 at 16 48 49" src="https://github.com/user-attachments/assets/b8809224-1674-44b6-a4f1-3ed66b65cb97" />
<img width="1800" height="1169" alt="Screenshot 2026-05-22 at 16 48 46" src="https://github.com/user-attachments/assets/17f77196-0fd3-42a8-aaf8-d3b5c0e3b67e" />
<img width="1800" height="1169" alt="Screenshot 2026-05-22 at 16 48 43" src="https://github.com/user-attachments/assets/b14837b0-3400-4bf7-9804-796859df0b44" />
<img width="1800" height="1169" alt="Screenshot 2026-05-22 at 16 48 39" src="https://github.com/user-attachments/assets/12359752-cfca-4196-8515-4e7a516378c8" />
<img width="1800" height="1169" alt="Screenshot 2026-05-22 at 16 48 19" src="https://github.com/user-attachments/assets/935eb194-575e-4014-a4b2-53a305bee386" />
<img width="1800" height="1169" alt="Screenshot 2026-05-22 at 16 29 15" src="https://github.com/user-attachments/assets/876f6088-db3b-41a2-892d-077ccef80708" />
<img width="1800" height="1169" alt="Screenshot 2026-05-22 at 16 29 10" src="https://github.com/user-attachments/assets/5da7e34e-60de-4203-a5a2-50021b9beca9" />
<img width="1800" height="1169" alt="Screenshot 2026-05-22 at 16 28 39" src="https://github.com/user-attachments/assets/c50a388b-f830-437f-8219-0fd964a37a57" />


## Highlights

- **Focused diff review** with side-by-side, inline, and full-file views.
- **Hunk-level actions** for staging, reverting, and committing individual
  changes.
- **Commit workflow** with staged-file awareness, commit-and-push, and AI
  commit-message generation.
- **Pull request flow** that can branch, commit, push, generate PR copy, and
  open the PR through GitHub CLI.
- **Branch tools** for switching, pruning gone branches, syncing branches, and
  seeing ahead/behind state.
- **Integrated terminal** that opens at the repository root and supports
  clickable terminal links.
- **Search and replace** across the repository with preview before writing.
- **Ignored config file access** for local files such as `.env` without listing
  generated folders like `node_modules`, `dist`, or `target`.
- **Auto-update support** through Tauri updater artifacts on GitHub Releases.

## Tech Stack

- [Tauri 2](https://tauri.app) for the native shell and Rust commands.
- [React 19](https://react.dev), TypeScript, and [Vite](https://vite.dev) for
  the UI.
- [Zustand](https://zustand-demo.pmnd.rs) for app state.
- `git`, `gh`, Codex CLI, and Claude Code integrations through local CLIs.
- `portable-pty` and xterm.js for the integrated terminal.

## Requirements

- macOS for the primary desktop experience.
- [Bun](https://bun.com) 1.3 or newer.
- Rust toolchain from [rustup](https://rustup.rs).
- Xcode Command Line Tools.
- `git` in `PATH`.
- Optional: GitHub CLI `gh` for pull-request creation.
- Optional: Codex CLI or Claude Code for AI-assisted actions.

## Development

Install dependencies and start the desktop app:

```sh
bun install
bun run tauri:dev
```

The default dev command disables Tauri's Rust file watcher so Squint can review
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

## Release

Release builds are created by GitHub Actions from `v*` tags. The workflow builds
macOS, Windows, and Linux bundles and creates a draft GitHub Release with
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
  components/      Top bar, sidebar, diff pane, dialogs, terminal, menus
  features/
    ai/            AI CLI detection and prompt execution
    git/           Git IPC client and shared Git types
    repository/    Repository state, settings, and user workflows
    search/        Repository search APIs
  lib/             Tauri bridge, paths, theme, diff parsing, utilities

src-tauri/
  src/
    commands/      Rust commands for git, gh, terminal, AI, search, replace
    lib.rs         Tauri builder and command registration
    menu.rs        Native app menu
```

## Safety

- Destructive discard actions require explicit confirmation.
- Search and replace writes only after preview and user confirmation.
- Git operations shell out to the local `git` binary, so behavior matches the
  user's command line.
- Ignored files are shown narrowly for editable config use cases; generated
  dependency and build trees remain hidden from the Files tab.
