export function sanitize(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 120)
}
