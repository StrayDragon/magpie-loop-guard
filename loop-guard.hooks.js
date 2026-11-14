// loop-guard.hooks.js — the Bun side of loop-guard: what the guard did,
// written down where the plugin's own page can read it.
//
// The middleware (loop-guard.middleware.js, moejs, in the gateway's own
// process) judges and acts: it refuses a request or appends a corrective
// turn. It can reach nothing but console, so it cannot write this file.
// This hook runs beside it in the plugin host's Bun, on the same request,
// and asks the middleware's own inspect() the same question: the two can
// never disagree about what fired, since one function answers both.
//
// Only a request the guard acted on is written down: a request that is
// fine leaves nothing behind, so the page shows exactly the events worth
// looking at.
//
// The events go to a file beside magpie's own config (a ring of the newest
// RING), which the plugin's page reads through the service its
// package.json's magpie.page.service names.
//
// Not beside this file: the usual install mounts the plugin's folder
// read-only (docker run -v .../magpie-loop-guard:/config/magpie-loop-guard:ro),
// so nothing there can be written. LOOP_GUARD_DIR says where instead, for an
// install that keeps it somewhere else.

import { existsSync } from "node:fs"
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { inspect } from "./loop-guard.middleware.js"

const HERE = dirname(fileURLToPath(import.meta.url))

// eventsDir is the folder the events are kept in. LOOP_GUARD_DIR names one;
// else /config if it is there (the usual container mount, writable while
// the plugin's own folder is not); else the user's XDG state folder; else
// the plugin's own folder, which is right for a folder install running
// under an account that may write it.
function eventsDir() {
  if (process.env.LOOP_GUARD_DIR) return process.env.LOOP_GUARD_DIR
  if (process.env.MAGPIE_STATE_DIR) return process.env.MAGPIE_STATE_DIR
  if (existsSync("/config")) return "/config"
  const state = process.env.XDG_STATE_HOME
  if (state) return join(state, "magpie")
  const home = process.env.HOME
  if (home) return join(home, ".local", "state", "magpie")
  return HERE
}

// EVENTS is where the newest events are kept, and RING how many.
const EVENTS = process.env.LOOP_GUARD_EVENTS || join(eventsDir(), "loop-guard-events.jsonl")
const RING = 500

// append adds one event, and keeps the file to RING lines. The rewrite is
// only done when the file has grown past it, so a busy guard does not
// rewrite on every event.
let writing = Promise.resolve()
function append(ev) {
  writing = writing.then(async () => {
    try {
      await mkdir(dirname(EVENTS), { recursive: true })
      await appendFile(EVENTS, JSON.stringify(ev) + "\n")
      const st = await stat(EVENTS)
      if (st.size < 64 * 1024) return
      const text = await readFile(EVENTS, "utf8")
      const lines = text.split("\n").filter(Boolean)
      if (lines.length <= RING) return
      const tmp = EVENTS + ".tmp"
      await writeFile(tmp, lines.slice(-RING).join("\n") + "\n")
      await rename(tmp, EVENTS)
    } catch {
      // a guard that cannot write its events still guards
    }
  })
  return writing
}

// onRequest is told the request before routing. inspect says whether the
// guard would act on it; when it would, the event is written and the body
// is left exactly as it came (this hook never changes a request).
export async function onRequest(body, ctx) {
  let got
  try {
    got = inspect(body, { model: ctx.model, protocol: ctx.protocol, agent: ctx.agent, options: ctx.options })
  } catch {
    return undefined
  }
  if (!got) return undefined
  await append({
    at: new Date().toISOString(),
    request: ctx.session || "",
    model: ctx.model || "",
    agent: ctx.agent || "",
    preset: got.preset,
    mode: got.mode,
    why: got.why,
    run: got.run,
    threshold: got.threshold,
    kind: ctx.kind || "",
    origin: ctx.origin || ""
  })
  return undefined
}
