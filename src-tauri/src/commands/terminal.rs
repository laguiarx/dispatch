//! Integrated terminal — spawns a real PTY (via `portable-pty`) running the
//! user's `$SHELL`, streams its stdout/stderr back to the frontend as Tauri
//! events, and accepts writes/resizes/closes from the renderer.
//!
//! Architecture:
//!   - One `Session` per terminal id, stored in a global `Mutex<HashMap>`.
//!   - A dedicated OS thread per session pumps the PTY's read end and emits
//!     `term://<id>/data` events (base64-encoded chunks) to the window.
//!   - Writes/resizes go straight to the PTY master from the IPC thread.
//!   - Close kills the child + drops the master, which makes the reader
//!     thread exit on EOF; we also emit `term://<id>/exit` so the UI can
//!     dispose of the xterm instance.
//!
//! We intentionally keep ids simple (monotonic u32 stringified) — the v1
//! design supports a single integrated terminal per window; the map is
//! future-proofing for tabs.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};

/// One live PTY session.
///
/// `writer` is taken ONCE at session creation and reused for every
/// keystroke. The crate's `UnixMasterWriter::Drop` writes `\n` + EOF
/// (VEOF, usually Ctrl-D) to the PTY before closing — taking a fresh
/// writer per IPC call meant every single keystroke was followed by an
/// implicit newline + EOF, which made zsh execute the user's partial
/// input and then exit on EOF. Holding the writer permanently in the
/// session keeps Drop from firing until we explicitly tear the session
/// down in `term_close`.
struct Session {
    /// Master handle, used for resize/get_size and as the owner whose
    /// lifetime keeps the PTY pair alive.
    master: Box<dyn portable_pty::MasterPty + Send>,
    /// Persistent writer onto the master end — see struct docs.
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    /// Child handle so close() can `kill()` the shell.
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

type Sessions = Arc<Mutex<HashMap<String, Session>>>;

fn sessions() -> Sessions {
    static HOLDER: OnceLock<Sessions> = OnceLock::new();
    HOLDER
        .get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
        .clone()
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermOpenResult {
    pub id: String,
}

/// Spawn a new PTY running `$SHELL` (fallback `/bin/zsh`) sized to
/// `(cols, rows)`. Returns the generated session id; the renderer should
/// subscribe to `term://<id>/data` and `term://<id>/exit` events.
///
/// `cwd` is optional — when provided we start the shell in that directory
/// (useful so the integrated terminal opens at the repo root). The shell is
/// launched with `-l` so it sources login files; combined with the upstream
/// `fix_macos_path_from_login_shell` hack, the terminal sees the same PATH
/// the user has in Terminal.app.
#[tauri::command]
pub fn term_open(
    app: AppHandle,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> AppResult<TermOpenResult> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::msg(format!("openpty failed: {e}")))?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    // `-i` (interactive) instead of the previous `-l` (login). The login
    // flag forced the shell to source ~/.zprofile / ~/.bash_profile every
    // time the user opened the drawer — on machines with nvm / pyenv /
    // rbenv / conda-init scripts that can take 300–800ms before the
    // prompt shows. We don't need it here because:
    //   1. `fix_macos_path_from_login_shell()` in lib.rs already ran an
    //      `$SHELL -ilc 'echo $PATH'` once at app startup and copied the
    //      enriched PATH onto the current process env.
    //   2. We propagate that PATH explicitly to the child below, so the
    //      drawer's shell sees `gh`, `claude`, brew bins, etc just like
    //      Terminal.app would.
    //   3. ~/.zshrc still runs (interactive shell sources it), so aliases
    //      and prompt customization still take effect.
    cmd.arg("-i");
    if let Some(dir) = cwd.as_ref().filter(|s| !s.is_empty()) {
        cmd.cwd(dir);
    }
    // Hint TERM so curses-y tools (vim, less, htop) negotiate correctly with
    // xterm.js, which advertises 256-color support.
    cmd.env("TERM", "xterm-256color");
    // Propagate the current process PATH explicitly — `fix_macos_path_from_login_shell`
    // already enriched it from the user's login shell, and CommandBuilder
    // otherwise inherits whatever Tauri started with.
    if let Ok(p) = std::env::var("PATH") {
        cmd.env("PATH", p);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AppError::msg(format!("spawn shell failed: {e}")))?;
    // The slave end stays inside the child process; dropping our handle here
    // is important so the master sees EOF when the shell exits.
    drop(pair.slave);

    let id = format!("t{}", NEXT_ID.fetch_add(1, Ordering::SeqCst));

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| AppError::msg(format!("clone reader failed: {e}")))?;

    // Take the writer exactly once; reused for every keystroke. See struct
    // docs for why per-call `take_writer` is unsafe here.
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| AppError::msg(format!("take_writer failed: {e}")))?;

    let session = Session {
        master: pair.master,
        writer: Mutex::new(writer),
        child,
    };
    {
        let sessions = sessions();
        let mut map = sessions
            .lock()
            .map_err(|_| AppError::msg("sessions mutex poisoned"))?;
        map.insert(id.clone(), session);
    }

    // Reader thread: pump PTY output → frontend. We emit base64 chunks so
    // arbitrary bytes (including invalid UTF-8 mid-escape-sequence) survive
    // the JSON event payload intact.
    let app_for_thread = app.clone();
    let id_for_thread = id.clone();
    thread::Builder::new()
        .name(format!("pty-reader-{id}"))
        .spawn(move || {
            let data_event = format!("term://{id_for_thread}/data");
            let exit_event = format!("term://{id_for_thread}/exit");
            let mut buf = [0u8; 4096];
            let engine = base64::engine::general_purpose::STANDARD;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        let chunk = engine.encode(&buf[..n]);
                        let _ = app_for_thread.emit(&data_event, chunk);
                    }
                    Err(e) => {
                        // EIO on macOS after the slave is closed; treat as EOF.
                        let _ = app_for_thread.emit(
                            &exit_event,
                            format!("read error: {e}"),
                        );
                        return;
                    }
                }
            }
            let _ = app_for_thread.emit(&exit_event, "eof");
            // Best-effort cleanup of the session map so we don't leak across
            // refreshes / multiple opens.
            if let Ok(mut map) = sessions().lock() {
                map.remove(&id_for_thread);
            }
        })
        .map_err(|e| AppError::msg(format!("spawn reader thread failed: {e}")))?;

    Ok(TermOpenResult { id })
}

/// Forward user keystrokes to the PTY master. `data` is the raw UTF-8 string
/// from xterm.js's `onData` (xterm already handles key→bytes mapping including
/// arrow keys, modifiers, paste, etc).
#[tauri::command]
pub fn term_write(id: String, data: String) -> AppResult<()> {
    let sessions = sessions();
    let map = sessions
        .lock()
        .map_err(|_| AppError::msg("sessions mutex poisoned"))?;
    let session = map
        .get(&id)
        .ok_or_else(|| AppError::msg(format!("no such terminal: {id}")))?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| AppError::msg("writer mutex poisoned"))?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| AppError::msg(format!("write failed: {e}")))?;
    writer
        .flush()
        .map_err(|e| AppError::msg(format!("flush failed: {e}")))?;
    Ok(())
}

/// Inform the PTY of a new size after the user resizes the drawer or window.
#[tauri::command]
pub fn term_resize(id: String, cols: u16, rows: u16) -> AppResult<()> {
    let sessions = sessions();
    let map = sessions
        .lock()
        .map_err(|_| AppError::msg("sessions mutex poisoned"))?;
    let session = map
        .get(&id)
        .ok_or_else(|| AppError::msg(format!("no such terminal: {id}")))?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::msg(format!("resize failed: {e}")))?;
    Ok(())
}

/// Kill the child shell and drop the session. The reader thread will see EOF
/// and emit `term://<id>/exit` on its way out.
#[tauri::command]
pub fn term_close(id: String) -> AppResult<()> {
    let sessions = sessions();
    let mut map = sessions
        .lock()
        .map_err(|_| AppError::msg("sessions mutex poisoned"))?;
    if let Some(mut session) = map.remove(&id) {
        let _ = session.child.kill();
        // Dropping the master closes the PTY, unblocking the reader.
        drop(session.master);
    }
    Ok(())
}
