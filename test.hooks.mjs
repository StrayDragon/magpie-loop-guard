// test.hooks.mjs — what the plugin's Bun side records, and what it leaves
// alone. node test.hooks.mjs, bun test.hooks.mjs, both.

import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"

const HERE = dirname(fileURLToPath(import.meta.url))

// The events go where LOOP_GUARD_DIR says, as the hook reads it on import.
// A folder of this run's own, so a test never reads or writes an install's.
const DIR = join(tmpdir(), "loop-guard-test-" + process.pid)
process.env.LOOP_GUARD_DIR = DIR
// (LOOP_GUARD_DIR alone decides it: EVENTS is that folder's file.)

const { onRequest } = await import("./loop-guard.hooks.js")

const EVENTS = join(DIR, "loop-guard-events.jsonl")

const A = { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] }
const T = { role: "tool", tool_call_id: "c1", content: "same" }

// loop is a conversation going round one tool call: what the guard stops.
const loop = () => ({ model: "m", messages: [
  { role: "system", content: "S" },
  { role: "user", content: "go" },
  A, T, A, T, A, T
] })

const clean = () => ({ model: "m", messages: [{ role: "user", content: "hi" }] })

const ctx = (over) => Object.assign({
  model: "x/y", protocol: "chat", agent: "pi",
  options: { targets: ["*"], threshold: 3, mode: "reject" },
  session: "ses_1"
}, over)

async function lines() {
  try {
    const text = await readFile(EVENTS, "utf8")
    return text.split("\n").filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

const reset = () => rm(EVENTS, { force: true })

let passed = 0, failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log("✓ " + name)
  } catch (e) {
    failed++
    console.log("✗ " + name + " — " + (e.message || e))
  }
}

await test("a request that is fine writes nothing", async () => {
  await reset()
  assert.equal(await onRequest(clean(), ctx({})), undefined)
  assert.deepEqual(await lines(), [])
})

await test("the hook never changes the request", async () => {
  await reset()
  assert.equal(await onRequest(loop(), ctx({})), undefined)
  assert.equal((await lines()).length, 1)
})

await test("a hit is written with the request, the preset and the run", async () => {
  await reset()
  await onRequest(loop(), ctx({ session: "ses_abc", model: "p/m" }))
  const [e] = await lines()
  assert.equal(e.request, "ses_abc")
  assert.equal(e.model, "p/m")
  assert.equal(e.agent, "pi")
  assert.equal(e.preset, "default")
  assert.equal(e.mode, "reject")
  assert.equal(e.why, "repeat")
  assert.equal(e.run, 3)
  assert.equal(e.threshold, 3)
})

await test("a named preset is written by its name", async () => {
  await reset()
  await onRequest(loop(), ctx({ options: {
    targets: [],
    threshold: 3,
    models: [{ name: "mine", targets: ["*"], mode: "inject" }]
  } }))
  const [e] = await lines()
  assert.equal(e.preset, "mine")
  assert.equal(e.mode, "inject")
})

await test("targets left out guards nothing, so nothing is written", async () => {
  await reset()
  await onRequest(loop(), ctx({ options: { threshold: 3 } }))
  assert.deepEqual(await lines(), [])
})

await test("a body that is no object is let by in silence", async () => {
  await reset()
  await onRequest("nope", ctx({}))
  await onRequest(null, ctx({}))
  assert.deepEqual(await lines(), [])
})

await reset()
console.log("\n" + passed + " passed, " + failed + " failed")
if (failed) process.exit(1)
