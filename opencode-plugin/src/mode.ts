export function isServeInvocation(argv: readonly string[]): boolean {
  return argv[1] === "serve"
}
