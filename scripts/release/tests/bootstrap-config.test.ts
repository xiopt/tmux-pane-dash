import { expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeBootstrapConfig } from "../bootstrap-config"

test("bootstrap writes active branch/tag rulesets and three separate environment request bodies", async () => {
  const output = await mkdtemp(join(tmpdir(), "pane-dash-bootstrap-test-"))
  const result = await writeBootstrapConfig({ outputDir: output, reviewerId: 123456 })
  expect(result.paths).toHaveLength(5)
  expect(result.summary).toContain("reviewer=123456")
  const branch = JSON.parse(await readFile(join(output, "branch-ruleset.json"), "utf8"))
  const tags = JSON.parse(await readFile(join(output, "tag-ruleset.json"), "utf8"))
  expect(branch).toMatchObject({ name: "master", target: "branch", enforcement: "active" })
  expect(branch.rules).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "pull_request", parameters: expect.objectContaining({ required_approving_review_count: 1 }) }),
    expect.objectContaining({ type: "required_status_checks" }),
    expect.objectContaining({ type: "non_fast_forward" }),
    expect.objectContaining({ type: "deletion" }),
  ]))
  expect(tags).toMatchObject({ name: "v*", target: "tag", enforcement: "active" })
  expect(tags.rules).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "creation" }),
    expect.objectContaining({ type: "update" }),
    expect.objectContaining({ type: "deletion" }),
  ]))
  expect(tags).not.toHaveProperty("bypass_actors")
  for (const environment of ["github-draft", "npm-production", "release-promotion"]) {
    const body = JSON.parse(await readFile(join(output, `${environment}.json`), "utf8"))
    expect(body).toMatchObject({ name: environment, reviewers: [{ type: "User", id: 123456 }] })
    expect(body).not.toHaveProperty("repository")
  }
})

test("bootstrap rejects invalid reviewer IDs and repository output paths", async () => {
  const output = await mkdtemp(join(tmpdir(), "pane-dash-bootstrap-test-"))
  for (const reviewerId of [0, -1, 1.2, Number.NaN, "123" as never]) {
    await expect(writeBootstrapConfig({ outputDir: output, reviewerId: reviewerId as number })).rejects.toThrow(/reviewer/i)
  }
  await expect(writeBootstrapConfig({ outputDir: process.cwd(), reviewerId: 123 })).rejects.toThrow(/temporary|output/i)
})
