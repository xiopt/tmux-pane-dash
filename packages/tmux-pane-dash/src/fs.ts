import { chmod, lstat, mkdir, open, readdir, readFile, rm } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"

export type FileInfo = { kind: "file" | "directory" | "symlink" | "other"; mode: number; size: number }
export interface FsOps { mkdir(path: string): Promise<void>; mkdirPayloadDirectory(root: string, relativePath: string, mode: number): Promise<void>; readFile(path: string): Promise<Uint8Array>; writeFileExclusive(root: string, relativePath: string, bytes: Uint8Array, mode: number): Promise<void>; openExclusive(path: string, mode: number): Promise<unknown>; write(file: unknown, bytes: Uint8Array): Promise<void>; close(file: unknown): Promise<void>; stat(path: string): Promise<FileInfo>; readdir(path: string): Promise<string[]>; rm(path: string): Promise<void> }

export function canonicalPayloadPath(path: string): string {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || path.endsWith("/") || path.includes("//")) throw new Error("invalid payload path")
  if (path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("invalid payload path")
  return path
}
function within(root: string, relative: string): string { const base = resolve(root), path = resolve(base, canonicalPayloadPath(relative)); if (!path.startsWith(`${base}${sep}`)) throw new Error("path escapes root"); return path }
export function nodeFsOps(): FsOps { return {
  async mkdir(path) { await mkdir(path, { recursive: true, mode: 0o700 }) }, async readFile(path) { return new Uint8Array(await readFile(path)) },
  async mkdirPayloadDirectory(root, relative, mode) { const path = within(root, relative); await mkdir(path, { recursive: false, mode: mode & 0o777 }); await chmod(path, mode & 0o777) },
  async writeFileExclusive(root, relative, bytes, mode) { const path = within(root, relative); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const file = await open(path, "wx", mode & 0o777); try { await file.writeFile(bytes) } finally { await file.close() } },
  async openExclusive(path, mode) { return open(path, "wx", mode & 0o777) }, async write(file, bytes) { await (file as any).writeFile(bytes) }, async close(file) { await (file as any).close() },
  async stat(path) { const entry = await lstat(path); return { kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "other", mode: entry.mode & 0o7777, size: entry.size } },
  async readdir(path) { return readdir(path) }, async rm(path) { await rm(path, { recursive: true, force: true }) },
} }
