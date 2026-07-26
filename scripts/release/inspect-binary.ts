import { readFile } from "node:fs/promises"
import type { RustTarget } from "./manifest"

const read32 = (bytes: Uint8Array, offset: number, little: boolean) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, little)
const read16 = (bytes: Uint8Array, offset: number, little: boolean) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, little)
const read64 = (bytes: Uint8Array, offset: number, little: boolean) => Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, little))

export async function inspectBinary(path: string, target: RustTarget): Promise<void> {
  const bytes = await readFile(path)
  if (bytes.length < 8) throw new Error("binary is too short")
  const macho = bytes[0] === 0xcf && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe
  if (macho) {
    const cpu = read32(bytes, 4, true); const expected = target.startsWith("aarch64-") ? 0x0100000c : 0x01000007
    if (!target.includes("apple-darwin")) throw new Error("Mach-O does not match Linux target")
    if (cpu !== expected) throw new Error("binary architecture does not match target")
    return
  }
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46 || bytes[4] !== 2 || ![1, 2].includes(bytes[5]!)) throw new Error("unrecognized binary format")
  if (!target.includes("unknown-linux-musl")) throw new Error("ELF does not match Darwin target")
  const little = bytes[5] === 1; const machine = read16(bytes, 18, little); const expected = target.startsWith("aarch64-") ? 183 : 62
  if (machine !== expected) throw new Error("binary architecture does not match target")
  if (bytes.length < 64) throw new Error("truncated ELF header")
  const phoff = read64(bytes, 32, little), phentsize = read16(bytes, 54, little), phnum = read16(bytes, 56, little)
  if (phoff + phentsize * phnum > bytes.length) throw new Error("truncated ELF program headers")
  for (let index = 0; index < phnum; index += 1) {
    const offset = phoff + index * phentsize, type = read32(bytes, offset, little)
    if (type === 3) throw new Error("Linux binary has PT_INTERP")
    if (type === 2) {
      const dynamicOffset = read64(bytes, offset + 8, little), dynamicSize = read64(bytes, offset + 32, little)
      if (dynamicOffset + dynamicSize > bytes.length || dynamicSize % 16 !== 0) throw new Error("truncated ELF dynamic section")
      for (let entry = dynamicOffset; entry < dynamicOffset + dynamicSize; entry += 16) if (read64(bytes, entry, little) === 1) throw new Error("Linux binary has DT_NEEDED")
    }
  }
}
