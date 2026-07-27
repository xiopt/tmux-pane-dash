import { lstat, mkdir, open, readdir, readFile, rm } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"

export type FileInfo = { kind: "file" | "directory" | "symlink" | "other"; mode: number; size: number }
export interface FsOps { mkdir(path: string): Promise<void>; readFile(path: string): Promise<Uint8Array>; writeFileExclusive(root: string, relativePath: string, bytes: Uint8Array, mode: number): Promise<void>; stat(path: string): Promise<FileInfo>; readdir(path: string): Promise<string[]>; rm(path: string): Promise<void> }

export function canonicalPayloadPath(path: string): string {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || path.endsWith("/") || path.includes("//")) throw new Error("invalid payload path")
  if (path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("invalid payload path")
  return path
}
function within(root: string, relative: string): string { const base = resolve(root), path = resolve(base, canonicalPayloadPath(relative)); if (!path.startsWith(`${base}${sep}`)) throw new Error("path escapes root"); return path }
export function nodeFsOps(): FsOps { return {
  async mkdir(path) { await mkdir(path, { recursive: true, mode: 0o700 }) }, async readFile(path) { return new Uint8Array(await readFile(path)) },
  async writeFileExclusive(root, relative, bytes, mode) { const path = within(root, relative); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const file = await open(path, "wx", mode & 0o777); try { await file.writeFile(bytes) } finally { await file.close() } },
  async stat(path) { const entry = await lstat(path); return { kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "other", mode: entry.mode & 0o7777, size: entry.size } },
  async readdir(path) { return readdir(path) }, async rm(path) { await rm(path, { recursive: true, force: true }) },
} }
