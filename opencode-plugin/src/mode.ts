export function isServeInvocation(argv: readonly string[]): boolean {
  return argv[2] === "serve"
}
