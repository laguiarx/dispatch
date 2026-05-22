use serde::{Deserialize, Serialize};

use crate::commands::{confine_to_repo, resolve_repo};
use crate::commands::search::{
    build_regex, collect_targets, looks_binary, relative, SearchRequest,
};
use crate::error::{AppError, AppResult};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceRequest {
    pub repo_path: String,
    pub find: String,
    pub replace: String,
    pub scope: String,
    pub case_sensitive: bool,
    pub regex: bool,
    pub paths: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceOccurrence {
    pub id: String,
    pub line_number: u32,
    pub original_line: String,
    pub replaced_line: String,
    pub selected: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePreview {
    pub file_path: String,
    pub occurrences: Vec<ReplaceOccurrence>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReplacement {
    pub file_path: String,
    pub occurrence_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReplaceRequest {
    pub repo_path: String,
    pub find: String,
    pub replace: String,
    pub case_sensitive: bool,
    pub regex: bool,
    pub selections: Vec<ApplyReplacement>,
}

const MAX_PREVIEWS: usize = 5000;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

#[tauri::command]
pub fn replace_preview(request: ReplaceRequest) -> AppResult<Vec<ReplacePreview>> {
    if request.find.is_empty() {
        return Ok(Vec::new());
    }
    let repo = resolve_repo(&request.repo_path)?;
    let search_request = SearchRequest {
        repo_path: request.repo_path.clone(),
        query: request.find.clone(),
        scope: request.scope.clone(),
        case_sensitive: request.case_sensitive,
        regex: request.regex,
        paths: request.paths.clone(),
        include: None,
        exclude: None,
    };
    let regex = build_regex(&request.find, request.case_sensitive, request.regex)?;
    let targets = collect_targets(&repo, &search_request)?;

    let mut previews: Vec<ReplacePreview> = Vec::new();
    let mut total = 0usize;

    for path in targets {
        if total >= MAX_PREVIEWS {
            break;
        }
        let metadata = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
            continue;
        }
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if looks_binary(&bytes) {
            continue;
        }
        let content = match String::from_utf8(bytes) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let rel = relative(&repo, &path);
        let mut occurrences = Vec::new();
        for (idx, line) in content.lines().enumerate() {
            if regex.is_match(line) {
                let replaced = regex.replace_all(line, request.replace.as_str()).to_string();
                if replaced == line {
                    continue;
                }
                occurrences.push(ReplaceOccurrence {
                    id: format!("{rel}:{}", idx + 1),
                    line_number: (idx as u32) + 1,
                    original_line: line.to_string(),
                    replaced_line: replaced,
                    selected: true,
                });
                total += 1;
                if total >= MAX_PREVIEWS {
                    break;
                }
            }
        }
        if !occurrences.is_empty() {
            previews.push(ReplacePreview {
                file_path: rel,
                occurrences,
            });
        }
    }

    Ok(previews)
}

#[tauri::command]
pub fn replace_apply(request: ApplyReplaceRequest) -> AppResult<u32> {
    if request.find.is_empty() {
        return Err(AppError::msg("Find pattern is empty"));
    }
    let repo = resolve_repo(&request.repo_path)?;
    let regex = build_regex(&request.find, request.case_sensitive, request.regex)?;

    let mut applied = 0u32;
    for selection in request.selections {
        if selection.occurrence_ids.is_empty() {
            continue;
        }
        let target_lines: std::collections::HashSet<u32> = selection
            .occurrence_ids
            .iter()
            .filter_map(|id| id.rsplit(':').next().and_then(|s| s.parse().ok()))
            .collect();
        if target_lines.is_empty() {
            continue;
        }
        // selection.file_path comes from earlier search results in the
        // renderer's hand — confine so a tampered request can't rewrite
        // files outside the repo.
        let full = match confine_to_repo(&repo, &selection.file_path) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let metadata = match std::fs::metadata(&full) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
            continue;
        }
        let original = match std::fs::read_to_string(&full) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let trailing_newline = original.ends_with('\n');
        let mut new_lines: Vec<String> = Vec::with_capacity(original.lines().count());
        let mut file_applied = 0u32;
        for (idx, line) in original.lines().enumerate() {
            let line_no = (idx as u32) + 1;
            if target_lines.contains(&line_no) {
                let replaced = regex.replace_all(line, request.replace.as_str()).to_string();
                if replaced != line {
                    file_applied += 1;
                }
                new_lines.push(replaced);
            } else {
                new_lines.push(line.to_string());
            }
        }

        if file_applied == 0 {
            continue;
        }

        let mut out = new_lines.join("\n");
        if trailing_newline {
            out.push('\n');
        }
        std::fs::write(&full, out).map_err(AppError::Io)?;
        applied += file_applied;
    }

    Ok(applied)
}
