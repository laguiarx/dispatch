import { useEffect, useState } from "react";
import { getBinaryPreview } from "@/features/git/git.api";
import type { BinaryPreview, ChangedFileStatus } from "@/features/git/git.types";
import { cn } from "@/lib/utils";

type Props = {
  repoPath: string;
  filePath: string;
  staged: boolean;
  status: ChangedFileStatus;
};

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "ico",
  "bmp",
  "avif",
]);

export function isPreviewableImage(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

function formatBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// Centered fallback used for non-image binaries / load failures / loading.
const FALLBACK = "grid place-content-center text-center p-10 h-full gap-1.5";

// Subtle 16px checkerboard so transparent PNGs are easy to read against the
// dark background. Two diagonal gradient pairs + a 16px tile.
const CHECKER =
  "bg-[linear-gradient(45deg,rgba(255,255,255,0.02)_25%,transparent_25%)," +
  "linear-gradient(-45deg,rgba(255,255,255,0.02)_25%,transparent_25%)," +
  "linear-gradient(45deg,transparent_75%,rgba(255,255,255,0.02)_75%)," +
  "linear-gradient(-45deg,transparent_75%,rgba(255,255,255,0.02)_75%)] " +
  "[background-size:16px_16px] " +
  "[background-position:0_0,0_8px,8px_-8px,-8px_0]";

/**
 * Renders an image diff for binary files (PNG, JPG, SVG, …). For modified
 * files we show old vs new side by side. For added / deleted / untracked,
 * just the relevant single side.
 *
 * Migrated from `.image-diff`, `.image-side*`, `.binary-fallback*` rules.
 */
export function BinaryPreviewPane({
  repoPath,
  filePath,
  staged,
  status,
}: Props) {
  const [preview, setPreview] = useState<BinaryPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isImage = isPreviewableImage(filePath);

  useEffect(() => {
    if (!isImage) return;
    let cancelled = false;
    setPreview(null);
    setError(null);
    getBinaryPreview(repoPath, filePath, staged)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, filePath, staged, isImage]);

  if (!isImage) {
    return (
      <div className={FALLBACK}>
        <div className="text-[14px] font-medium">Binary file</div>
        <div className="text-[12px] text-fg-3">
          No preview available for this format.
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={FALLBACK}>
        <div className="text-[14px] font-medium">Couldn't load preview</div>
        <div className="text-[12px] text-fg-3">{error}</div>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className={FALLBACK}>
        <div className="text-[12px] text-fg-3">Loading preview…</div>
      </div>
    );
  }

  // Single-side render for whole-file added / deleted / untracked.
  if (status === "added" || status === "untracked") {
    return (
      <div className="grid grid-cols-1 gap-px bg-bd-1 h-full">
        <ImageSide
          label="Added"
          accent="add"
          url={preview.newDataUrl}
          size={preview.newSize}
          mime={preview.mime}
        />
      </div>
    );
  }
  if (status === "deleted") {
    return (
      <div className="grid grid-cols-1 gap-px bg-bd-1 h-full">
        <ImageSide
          label="Deleted"
          accent="del"
          url={preview.oldDataUrl}
          size={preview.oldSize}
          mime={preview.mime}
        />
      </div>
    );
  }

  // Modified / renamed → side-by-side.
  return (
    <div className="grid grid-cols-2 gap-px bg-bd-1 h-full">
      <ImageSide
        label="Before"
        accent="del"
        url={preview.oldDataUrl}
        size={preview.oldSize}
        mime={preview.mime}
      />
      <ImageSide
        label="After"
        accent="add"
        url={preview.newDataUrl}
        size={preview.newSize}
        mime={preview.mime}
      />
    </div>
  );
}

function ImageSide({
  label,
  accent,
  url,
  size,
  mime,
}: {
  label: string;
  accent: "add" | "del";
  url: string | null;
  size: number | null;
  mime: string;
}) {
  return (
    <div className="flex flex-col min-w-0 bg-bg-0">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-bd-1 bg-bg-1">
        <span
          className={cn(
            "text-[11px] font-semibold uppercase tracking-[0.04em]",
            accent === "add" ? "text-git-add" : "text-git-del",
          )}
        >
          {label}
        </span>
        <span className="text-[10.5px] text-fg-3 font-mono ml-auto">
          {mime} · {formatBytes(size)}
        </span>
      </div>
      <div className={cn("flex-1 min-h-0 grid place-items-center p-6 overflow-auto", CHECKER)}>
        {url ? (
          <img
            src={url}
            alt={label}
            className="max-w-full max-h-full object-contain rounded shadow-[0_4px_14px_rgba(0,0,0,0.25)]"
          />
        ) : (
          <div className="text-fg-3 text-[12px]">—</div>
        )}
      </div>
    </div>
  );
}
