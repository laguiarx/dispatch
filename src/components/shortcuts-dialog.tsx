import { useRepoStore } from "@/features/repository/repository.store";
import { I } from "./icons";
import { Overlay } from "./overlay";
import { CHIP, splitShortcut } from "./kbd";

type Shortcut = {
  label: string;
  /** Each entry is one chord. Use a space-separated chord array like
   *  `["⌘K", "W"]` for chord sequences (press ⌘K, then W). */
  keys: string[];
  /**
   * Optional alternative binding rendered after `keys` with an "or"
   * separator (e.g. ⌘` · ⌘J). Use sparingly — only when the app accepts
   * two equally first-class chords for the same action.
   */
  altKeys?: string[];
};

type Group = {
  title: string;
  shortcuts: Shortcut[];
};

/**
 * Single source of truth for what the user sees as the app's keybindings.
 * If you add a real shortcut in keyboard.ts, mirror it here so the cheatsheet
 * stays accurate. Future work: let the user remap from this same data.
 */
const GROUPS: Group[] = [
  {
    title: "Project",
    shortcuts: [
      { label: "Open repository…", keys: ["⌘O"] },
      { label: "Refresh git status", keys: ["⌘R"] },
      { label: "Preferences", keys: ["⌘,"] },
    ],
  },
  {
    title: "Navigation",
    shortcuts: [
      { label: "Go to file…", keys: ["⌘P"] },
      { label: "Command palette", keys: ["⌘⇧P"] },
      { label: "Next changed file", keys: ["⌥↓"] },
      { label: "Previous changed file", keys: ["⌥↑"] },
    ],
  },
  {
    title: "Tabs",
    shortcuts: [
      { label: "Next tab", keys: ["⌘⌥→"] },
      { label: "Previous tab", keys: ["⌘⌥←"] },
      { label: "Close current tab", keys: ["⌘W"] },
      { label: "Close all tabs", keys: ["⌘K", "W"] },
    ],
  },
  {
    title: "Search",
    shortcuts: [
      { label: "Find in current file", keys: ["⌘F"] },
      { label: "Find in repository", keys: ["⌘⇧F"] },
      { label: "Find & replace", keys: ["⌘⇧H"] },
    ],
  },
  {
    title: "Editing",
    shortcuts: [
      { label: "Edit current file", keys: ["⌘E"] },
      { label: "Save", keys: ["⌘S"] },
    ],
  },
  {
    title: "Git",
    shortcuts: [
      { label: "Stage / unstage current file", keys: ["⌘↵"] },
      { label: "Mark current file reviewed", keys: ["⌘⇧M"] },
      { label: "Discard changes to current file", keys: ["⌘⌫"] },
    ],
  },
  {
    title: "Panels",
    shortcuts: [
      { label: "Zoom in", keys: ["⌘+"] },
      { label: "Zoom out", keys: ["⌘-"] },
      { label: "Reset zoom", keys: ["⌘0"] },
      { label: "Toggle left sidebar", keys: ["⌘B"] },
      { label: "Toggle right sidebar", keys: ["⌘⌥B"] },
      { label: "Toggle terminal", keys: ["⌘`"], altKeys: ["⌘J"] },
      { label: "Show Changes", keys: ["⌘⌥G"] },
      { label: "Show File tree", keys: ["⌘⇧E"] },
    ],
  },
];

export function ShortcutsDialog() {
  const open = useRepoStore((s) => s.shortcutsOpen);
  const close = useRepoStore((s) => s.setShortcutsOpen);

  if (!open) return null;

  return (
    <Overlay onClose={() => close(false)} centered>
      <div
        className={
          "w-[min(560px,92vw)] max-h-[80vh] flex flex-col overflow-hidden " +
          "bg-bg-1 border border-bd-2 rounded-3 shadow-[0_24px_60px_rgba(0,0,0,0.55)]"
        }
      >
        <div className="flex items-center gap-2 px-3.5 py-3 border-b border-bd-1">
          <span className="text-[14px] font-semibold tracking-[-0.01em]">
            Keyboard shortcuts
          </span>
          <span className="flex-1" />
          <button
            className="w-[22px] h-[22px] grid place-items-center rounded-[4px] text-fg-3 bg-transparent border-0 cursor-pointer hover:bg-bg-hover hover:text-fg-0"
            onClick={() => close(false)}
            title="Close"
            aria-label="Close shortcuts"
          >
            {I.x}
          </button>
        </div>
        <div className="overflow-y-auto">
          {GROUPS.map((g, gi) => (
            <section
              key={g.title}
              className={
                "px-4 pt-3 pb-3.5" +
                (gi === GROUPS.length - 1 ? "" : " border-b border-bd-0")
              }
            >
              <div className="text-[10.5px] uppercase tracking-[0.08em] text-fg-3 mb-2">
                {g.title}
              </div>
              <div className="flex flex-col gap-1">
                {g.shortcuts.map((s) => (
                  <div
                    key={s.label}
                    className="flex items-center gap-3 px-1 py-1.5 rounded hover:bg-bg-hover"
                  >
                    <span className="flex-1 text-[12.5px] text-fg-1">
                      {s.label}
                    </span>
                    <span className="inline-flex items-center gap-[3px]">
                      {s.keys.map((chord, ci) => (
                        <span
                          key={ci}
                          className="inline-flex items-center gap-[3px]"
                        >
                          {splitShortcut(chord).map((k, ki) => (
                            <span key={ki} className={CHIP}>
                              {k}
                            </span>
                          ))}
                        </span>
                      ))}
                      {s.altKeys && s.altKeys.length > 0 ? (
                        <>
                          <span className="text-fg-2 text-[11px] px-1 lowercase">
                            or
                          </span>
                          {s.altKeys.map((chord, ci) => (
                            <span
                              key={`alt-${ci}`}
                              className="inline-flex items-center gap-[3px]"
                            >
                              {splitShortcut(chord).map((k, ki) => (
                                <span key={ki} className={CHIP}>
                                  {k}
                                </span>
                              ))}
                            </span>
                          ))}
                        </>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </Overlay>
  );
}
