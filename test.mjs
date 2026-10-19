// Runs cases.json through the hooks the way magpie's gateway calls them:
// one ctx per case, each body a fresh copy of its JSON, the first
// ctx.reject winning. The same cases.json also runs in magpie's own
// JavaScript engine (moejs); this runner works with both runtimes:
//
//   node test.mjs
//   bun test.mjs
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const dir = dirname(fileURLToPath(import.meta.url))
const mod = await import("./loop-guard.middleware.js")
const m = mod.default ?? mod
const cases = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"))

const copy = (v) => JSON.parse(JSON.stringify(v))

async function run(c) {
  let rejected = null
  let logged = 0
  const realLog = console.log
  console.log = () => { logged++ }
  try {
    const ctx = {
      protocol: "anthropic", model: "", stream: false, path: "", ...c.ctx,
      options: c.options ?? {}, state: {},
      reject(status, message) { rejected ??= { status, message } },
    }
    if (c.request) await m.onRequest(copy(c.request), ctx)
  } finally {
    console.log = realLog
  }
  return { rejected, logged }
}

let failed = 0
for (const c of cases) {
  const got = await run(c)
  const bad = []
  if (c.reject) {
    if (!got.rejected) bad.push(`expected a reject, got none`)
    else {
      if (got.rejected.status !== c.reject.status) bad.push(`status ${got.rejected.status}, want ${c.reject.status}`)
      if (c.reject.message && !got.rejected.message.includes(c.reject.message)) {
        bad.push(`message ${JSON.stringify(got.rejected.message)} lacks ${JSON.stringify(c.reject.message)}`)
      }
    }
  } else {
    if (got.rejected) bad.push(`unexpected reject ${JSON.stringify(got.rejected)}`)
    if (c.expect_log === true && got.logged < 1) bad.push(`expected a log line, got none`)
  }
  if (bad.length) {
    failed++
    console.log(`✗ ${c.name}\n    ${bad.join("\n    ")}`)
  } else {
    console.log(`✓ ${c.name}`)
  }
}
console.log(`\n${cases.length - failed}/${cases.length} cases pass`)
if (failed > 0) process.exit(1)
