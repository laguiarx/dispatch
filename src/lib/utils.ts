import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

export function dirname(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(0, idx) : "";
}

export function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "ts",
    tsx: "ts",
    js: "ts",
    jsx: "ts",
    mjs: "ts",
    cjs: "ts",
    json: "ts",
    md: "md",
    mdx: "md",
    rs: "rs",
    py: "py",
    pyi: "py",
    rb: "rb",
    erb: "rb",
    go: "go",
    java: "java",
    kt: "java",
    kts: "java",
    swift: "swift",
    sh: "sh",
    bash: "sh",
    zsh: "sh",
    fish: "sh",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    html: "html",
    css: "css",
    scss: "scss",
  };
  return map[ext] ?? "txt";
}
