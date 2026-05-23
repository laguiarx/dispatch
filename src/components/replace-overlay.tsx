import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useRepoStore } from "@/features/repository/repository.store";
import * as replaceApi from "@/features/replace/replace.api";
import type {
  ReplacePreview,
  ReplaceScope,
} from "@/features/replace/replace.types";
import { cn } from "@/lib/utils";
import { I } from "./icons";
import { Kbd } from "./kbd";
import { Overlay } from "./overlay";

/**
 * Shared style fragments for the Replace dialog. The overlay shell
 * (`CARD`/`HEAD`/`FOOTER`) is reused inside this single component but split
 * out so a future "Find in files" overlay can copy the same skeleton.
 *
 * The `rp-*` fragments target the preview list: file row + per-occurrence
 * row with del/add diff stripes. `.diff-gut-mark` is migrated inline via
 * descendant selectors on the parent diff stripes (`[&>.diff-gut-mark]:...`).
 */
const CARD =
  "w-[min(820px,92vw)] max-h-[80vh] flex flex-col overflow-hidden " +
  "bg-bg-1 border border-bd-2 rounded-3 " +
  "shadow-[0_24px_60px_rgba(0,0,0,0.55),0_2px_0_rgba(255,255,255,0.04)_inset]";
const HEAD =
  "flex items-center gap-2 px-3.5 py-2.5 border-b border-bd-1 text-[13px]";
const TITLE = "font-semibold";
const FOOTER =
  "flex items-center gap-2 px-3.5 py-2.5 border-t border-bd-1 bg-bg-2";

const INPUTS = "flex flex-col gap-1.5 px-3.5 pt-2.5";
const INPUT_ROW =
  "flex items-center gap-2 h-8 px-2.5 bg-bg-2 border border-bd-2 rounded-2 " +
  "focus-within:border-accent";
const RI_LABEL =
  "font-mono text-fg-2 w-7 text-[10px] uppercase tracking-[0.06em]";
const SEARCH_INPUT =
  "flex-1 h-full text-[13px] bg-transparent border-0 outline-none text-fg-0 " +
  "placeholder:text-fg-3";

const META =
  "flex items-center gap-2.5 px-3.5 py-2.5 border-b border-bd-1 text-[11.5px]";

// Aa / .* toggle pill. Duplicated in `search-panel.tsx` and
// `in-file-search-bar.tsx` — see note there.
const FLAG_BASE =
  "inline-flex items-center justify-center min-w-6 h-[22px] px-1.5 " +
  "rounded-[4px] border border-transparent font-mono text-[11px] text-fg-3 " +
  "bg-transparent hover:text-fg-0 hover:bg-bg-3 [&_svg]:block";
const FLAG_ON =
  "!bg-accent-soft !text-accent " +
  "!border-[color-mix(in_oklab,var(--accent)_40%,transparent)]";
const SCOPE_LABEL =
  "font-mono text-fg-2 text-[10px] uppercase tracking-[0.06em]";

const SEG_GROUP =
  "inline-flex bg-bg-2 border border-bd-1 rounded-2 p-0.5 gap-0.5";
const SEG_BTN =
  "px-[9px] py-[3px] rounded text-[11.5px] text-fg-2 font-medium whitespace-nowrap " +
  "hover:not-disabled:text-fg-0 disabled:opacity-40 disabled:cursor-default";
const SEG_BTN_ACTIVE =
  "!bg-bg-4 !text-fg-0 shadow-[0_1px_0_rgba(0,0,0,0.3)] " +
  "[:root[data-theme='light']_&]:!bg-bg-0 " +
  "[:root[data-theme='light']_&]:shadow-[0_1px_2px_rgba(0,0,0,0.06)]";

const PREVIEW_LIST = "flex-1 overflow-y-auto pt-1.5 pb-2.5";
const PREVIEW_EMPTY =
  "flex-1 grid place-items-center text-center text-[12px] p-[30px] min-h-40 " +
  "font-mono text-fg-2";
const SR_EMPTY = "font-mono text-fg-2 p-[30px] text-center";

const RP_FILE = "py-1.5 border-b border-bd-0";
const RP_FILE_HEAD = "flex items-center gap-2 px-3.5 pt-1 pb-1.5 text-[11.5px]";
const RP_FILE_CHECK = "grid place-items-center bg-transparent border-0 cursor-pointer";
const RP_FILE_OCCS = "flex flex-col gap-px";

// Custom checkbox + indeterminate states. 13×13 with bg/border that swap on
// `is-on` and `is-mixed`. The `cb-mix` glyph is a 7×2 accent bar (the dash
// that indicates "some occurrences selected").
const CB_BASE =
  "w-[13px] h-[13px] rounded-[3px] border border-bd-2 bg-bg-2 grid place-items-center " +
  "shrink-0 text-white transition-all duration-[120ms]";
const CB_ON = "!bg-accent !border-accent";
const CB_MIXED = "!bg-accent-soft !border-accent";
const CB_MIX_DASH = "w-[7px] h-0.5 bg-accent rounded-[1px]";

const RP_OCC_BASE =
  "grid grid-cols-[14px_36px_1fr] gap-2 items-start px-3.5 py-1 w-full text-left " +
  "bg-transparent border-0 cursor-pointer hover:bg-bg-hover";
const RP_OCC_LINE =
  "font-mono text-fg-2 text-right text-[11px] pt-[2px]";
const RP_OCC_DIFF = "flex flex-col text-[12px] leading-[1.4]";
// Each diff stripe is a 2-col grid: gutter mark · line text. `whitespace-pre`
// preserves indentation. The accent box-shadow on `RP_OCC_ON` highlights the
// + side when the occurrence is selected.
const RP_OCC_ROW_BASE =
  "grid grid-cols-[16px_1fr] gap-1 whitespace-pre px-1.5 py-px rounded-[3px] font-mono " +
  "[&_mark]:bg-white/[12%] [&_mark]:text-inherit [&_mark]:px-px [&_mark]:rounded-[2px]";
const RP_OCC_DEL =
  "bg-diff-del-bg-strong text-fg-1 [&>.diff-gut-mark]:text-diff-del-mark";
const RP_OCC_ADD =
  "bg-diff-add-bg-strong text-fg-0 [&>.diff-gut-mark]:text-diff-add-mark";
// When the occurrence is selected, accent the + (add) stripe with an inset
// left border so the user sees which row they've picked.
const RP_OCC_ADD_SELECTED = "shadow-[inset_2px_0_0_var(--accent)]";

export function ReplaceOverlay() {
  const open = useRepoStore((s) => s.replaceOpen);
  const setOpen = useRepoStore((s) => s.setReplaceOpen);
  const repo = useRepoStore((s) => s.repository);
  const files = useRepoStore((s) => s.files);
  const selectedFilePath = useRepoStore((s) => s.selectedFilePath);
  const refresh = useRepoStore((s) => s.refresh);
  const pushToast = useRepoStore((s) => s.pushToast);
  const setError = useRepoStore((s) => s.setError);

  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [scope, setScope] = useState<ReplaceScope>("changed");
  const [caseSensitive, setCaseSensitive] = useState(true);
  const [regex, setRegex] = useState(false);
  const [previewed, setPreviewed] = useState(false);
  const [preview, setPreview] = useState<ReplacePreview[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
    else {
      setFind("");
      setReplace("");
      setPreview([]);
      setPreviewed(false);
    }
  }, [open]);

  async function runPreview() {
    if (!repo || !find) return;
    setLoading(true);
    try {
      const paths =
        scope === "changed"
          ? files.map((f) => f.path)
          : scope === "current" && selectedFilePath
            ? [selectedFilePath]
            : undefined;
      const out = await replaceApi.previewReplace({
        repoPath: repo.path,
        find,
        replace,
        scope,
        caseSensitive,
        regex,
        paths,
      });
      setPreview(out);
      setPreviewed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function toggleOcc(fileIdx: number, occIdx: number) {
    setPreview((prev) =>
      prev.map((p, i) =>
        i !== fileIdx
          ? p
          : {
              ...p,
              occurrences: p.occurrences.map((o, j) =>
                j === occIdx ? { ...o, selected: !o.selected } : o,
              ),
            },
      ),
    );
  }

  function toggleFile(fileIdx: number) {
    setPreview((prev) =>
      prev.map((p, i) => {
        if (i !== fileIdx) return p;
        const all = p.occurrences.every((o) => o.selected);
        return {
          ...p,
          occurrences: p.occurrences.map((o) => ({ ...o, selected: !all })),
        };
      }),
    );
  }

  const totalSelected = useMemo(
    () =>
      preview.reduce(
        (n, g) => n + g.occurrences.filter((o) => o.selected).length,
        0,
      ),
    [preview],
  );
  const totalOccs = useMemo(
    () => preview.reduce((n, g) => n + g.occurrences.length, 0),
    [preview],
  );

  async function applyNow() {
    if (!repo) return;
    setLoading(true);
    try {
      const selections = preview
        .map((p) => ({
          filePath: p.filePath,
          occurrenceIds: p.occurrences
            .filter((o) => o.selected)
            .map((o) => o.id),
        }))
        .filter((s) => s.occurrenceIds.length > 0);
      const count = await replaceApi.applyReplace({
        repoPath: repo.path,
        find,
        replace,
        caseSensitive,
        regex,
        selections,
      });
      pushToast(
        `Applied ${count} replacement${count === 1 ? "" : "s"}`,
        count === 0 ? "danger" : "info",
      );
      setOpen(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  return (
    <Overlay onClose={() => setOpen(false)}>
      <div className={CARD}>
        <div className={HEAD}>
          <span className={TITLE}>Replace</span>
          <Kbd>⌘⇧H</Kbd>
          <span className="flex-1" />
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            {I.x}
          </Button>
        </div>
        <div className={INPUTS}>
          <div className={INPUT_ROW}>
            <span className={RI_LABEL}>find</span>
            <input
              ref={inputRef}
              className={SEARCH_INPUT}
              type="text"
              value={find}
              onChange={(e) => {
                setFind(e.target.value);
                setPreviewed(false);
              }}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
            />
            <Button variant="unstyled"
              className={cn(FLAG_BASE, caseSensitive && FLAG_ON)}
              onClick={() => setCaseSensitive(!caseSensitive)}
            >
              Aa
            </Button>
            <Button variant="unstyled"
              className={cn(FLAG_BASE, regex && FLAG_ON)}
              onClick={() => setRegex(!regex)}
            >
              .*
            </Button>
          </div>
          <div className={INPUT_ROW}>
            <span className={RI_LABEL}>repl</span>
            <input
              className={SEARCH_INPUT}
              type="text"
              value={replace}
              onChange={(e) => {
                setReplace(e.target.value);
                setPreviewed(false);
              }}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>
        <div className={META}>
          <span className={SCOPE_LABEL}>Scope</span>
          <div className={SEG_GROUP}>
            <Button variant="unstyled"
              className={cn(SEG_BTN, scope === "all" && SEG_BTN_ACTIVE)}
              onClick={() => {
                setScope("all");
                setPreviewed(false);
              }}
            >
              All files
            </Button>
            <Button variant="unstyled"
              className={cn(SEG_BTN, scope === "changed" && SEG_BTN_ACTIVE)}
              onClick={() => {
                setScope("changed");
                setPreviewed(false);
              }}
            >
              Changed
            </Button>
            <Button variant="unstyled"
              className={cn(SEG_BTN, scope === "current" && SEG_BTN_ACTIVE)}
              onClick={() => {
                setScope("current");
                setPreviewed(false);
              }}
              disabled={!selectedFilePath}
            >
              Current
            </Button>
          </div>
          <span className="flex-1" />
          {previewed ? (
            <span className="font-mono text-fg-2">
              {totalSelected}/{totalOccs} occurrences selected · {preview.length}{" "}
              file{preview.length === 1 ? "" : "s"}
            </span>
          ) : (
            <span className="font-mono text-fg-2">Run preview to see matches</span>
          )}
        </div>

        {previewed ? (
          <div className={PREVIEW_LIST}>
            {preview.length === 0 ? (
              <div className={SR_EMPTY}>No occurrences found.</div>
            ) : null}
            {preview.map((g, fi) => {
              const sel = g.occurrences.filter((o) => o.selected).length;
              const all = sel === g.occurrences.length;
              return (
                <div key={g.filePath} className={RP_FILE}>
                  <div className={RP_FILE_HEAD}>
                    <Button variant="unstyled"
                      className={RP_FILE_CHECK}
                      onClick={() => toggleFile(fi)}
                    >
                      <span
                        className={cn(
                          CB_BASE,
                          all ? CB_ON : sel > 0 ? CB_MIXED : "",
                        )}
                      >
                        {all ? I.check : sel > 0 ? <span className={CB_MIX_DASH} /> : null}
                      </span>
                    </Button>
                    <span className="font-mono">{g.filePath}</span>
                    <span className="font-mono text-fg-2">
                      · {sel}/{g.occurrences.length}
                    </span>
                  </div>
                  <div className={RP_FILE_OCCS}>
                    {g.occurrences.map((o, oi) => (
                      <Button variant="unstyled"
                        key={o.id}
                        className={RP_OCC_BASE}
                        onClick={() => toggleOcc(fi, oi)}
                      >
                        <span className={cn(CB_BASE, o.selected && CB_ON)}>
                          {o.selected ? I.check : null}
                        </span>
                        <span className={RP_OCC_LINE}>{o.lineNumber}</span>
                        <div className={RP_OCC_DIFF}>
                          <div className={cn(RP_OCC_ROW_BASE, RP_OCC_DEL)}>
                            <span className="diff-gut-mark">−</span>
                            <span>{o.originalLine}</span>
                          </div>
                          <div
                            className={cn(
                              RP_OCC_ROW_BASE,
                              RP_OCC_ADD,
                              o.selected && RP_OCC_ADD_SELECTED,
                            )}
                          >
                            <span className="diff-gut-mark">+</span>
                            <span>{o.replacedLine}</span>
                          </div>
                        </div>
                      </Button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className={PREVIEW_EMPTY}>
            Press <Kbd>⌥↵</Kbd> or click Preview to see what will change. Nothing
            is written until you apply.
          </div>
        )}

        <div className={FOOTER}>
          <span className="font-mono text-fg-2">
            Replacements are written to disk only when you click Apply.
          </span>
          <span className="flex-1" />
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          {previewed ? (
            <Button
              variant="default"
              size="sm"
              disabled={totalSelected === 0 || loading}
              onClick={applyNow}
            >
              Apply {totalSelected} replacement
              {totalSelected === 1 ? "" : "s"}
            </Button>
          ) : (
            <Button
              variant="default"
              size="sm"
              onClick={runPreview}
              disabled={!find || loading}
            >
              {loading ? "Working…" : "Preview"}
              {!loading ? <Kbd>⌥↵</Kbd> : null}
            </Button>
          )}
        </div>
      </div>
    </Overlay>
  );
}
