// Runs cases.json through the hooks the way magpie's gateway calls them:
// one ctx per case, each body a fresh copy of its JSON, the first
// ctx.reject winning. A case with an "inject" field expects mode:"inject"
// to return the rewritten body: the last turn must carry the injected
// prompt, and every other body field must survive untouched. The same
// cases.json also runs in magpie's own JavaScript engine (moejs); this
// runner works with both runtimes:
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

// keyOf mirrors the middleware's turnsOf: the body key the turns array
// lives under for a protocol.
function keyOf(protocol, request) {
  if (protocol === "gemini") {
    if (Array.isArray(request.contents)) return "contents"
    if (Array.isArray(request.messages)) return "messages"
    return "contents"
  }
  if (protocol === "responses") {
    if (Array.isArray(request.input)) return "input"
    if (Array.isArray(request.messages)) return "messages"
    return "input"
  }
  return "messages"
}

// flatText flattens one turn's user-visible text in a protocol's shape.
function flatText(turn, protocol) {
  if (!turn || typeof turn !== "object") return ""
  if (protocol === "gemini") {
    return (turn.parts ?? []).map((p) => (p && typeof p.text === "string" ? p.text : "")).join("")
  }
  if (typeof turn.content === "string") return turn.content
  if (Array.isArray(turn.content)) {
    return turn.content.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("")
  }
  return ""
}

async function run(c) {
  let rejected = null
  let logged = 0
  let ret
  const realLog = console.log
  console.log = () => { logged++ }
  try {
    const ctx = {
      protocol: "anthropic", model: "", stream: false, path: "", ...c.ctx,
      options: c.options ?? {}, state: {},
      reject(status, message) { rejected ??= { status, message } },
    }
    if (c.request) ret = await m.onRequest(copy(c.request), ctx)
  } finally {
    console.log = realLog
  }
  return { rejected, logged, ret }
}

let failed = 0
for (const c of cases) {
  const got = await run(c)
  const bad = []
  if (c.inject) {
    const protocol = c.ctx?.protocol ?? "anthropic"
    if (got.rejected) bad.push("unexpected reject " + JSON.stringify(got.rejected))
    if (got.ret === undefined || typeof got.ret !== "object" || Array.isArray(got.ret)) {
      bad.push("expected an injected body, got none")
    } else {
      const key = keyOf(protocol, c.request)
      const before = c.request[key] ?? []
      const after = got.ret[key] ?? []
      if (after.length !== before.length + 1) {
        bad.push("expected " + (before.length + 1) + " turns after the injection, got " + after.length)
      } else {
        const text = flatText(after[after.length - 1], protocol)
        if (!text.includes(c.inject.prompt)) {
          bad.push("injected message " + JSON.stringify(text) + " lacks " + JSON.stringify(c.inject.prompt))
        }
      }
      for (const k of Object.keys(c.request)) {
        if (k === key) continue
        if (JSON.stringify(got.ret[k]) !== JSON.stringify(c.request[k])) bad.push("body field " + k + " changed")
      }
    }
  } else if (c.reject) {
    if (got.ret !== undefined) bad.push("unexpected body rewrite")
    if (!got.rejected) bad.push("expected a reject, got none")
    else {
      if (got.rejected.status !== c.reject.status) bad.push("status " + got.rejected.status + ", want " + c.reject.status)
      if (c.reject.message && !got.rejected.message.includes(c.reject.message)) {
        bad.push("message " + JSON.stringify(got.rejected.message) + " lacks " + JSON.stringify(c.reject.message))
      }
    }
  } else {
    if (got.ret !== undefined) bad.push("unexpected body rewrite")
    if (got.rejected) bad.push("unexpected reject " + JSON.stringify(got.rejected))
    if (c.expect_log === true && got.logged < 1) bad.push("expected a log line, got none")
  }
  if (bad.length) {
    failed++
    console.log("\u2717 " + c.name + "\n    " + bad.join("\n    "))
  } else {
    console.log("\u2713 " + c.name)
  }
}
console.log("\n" + (cases.length - failed) + "/" + cases.length + " cases pass")
if (failed > 0) process.exit(1)
