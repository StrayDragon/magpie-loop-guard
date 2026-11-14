// loop-guard.server.js — the plugin's own HTTP service: what its page
// talks to (package.json's magpie.page.service).
//
// The page inside magpie's window is sandboxed with connect-src 'none', so
// it cannot fetch anything, this service included. What it can do is go
// here: the page it loads is a forwarding one, and the window (or a browser
// on magpie web) hands it this address as magpie.service. This service then
// serves the real page, which fetches its own API under a policy that names
// this service's own root (pageServicePolicy and serviceSelf in
// internal/gui/pageservice.go), so the fetches work.
//
// It reads the events loop-guard.hooks.js writes and the options magpie
// keeps, and writes options back through magpie's own CLI so a change is
// the same change the Options dialog makes.

import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = join(HERE, "page", "index.html")

// eventsDir and EVENTS are what loop-guard.hooks.js writes: the same rule,
// so the page reads the file the hook wrote. Keep the two in step.
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
const EVENTS = process.env.LOOP_GUARD_EVENTS || join(eventsDir(), "loop-guard-events.jsonl")

// DEFAULT_PORT is the port package.json names; the user's option moves it.
const DEFAULT_PORT = Number(process.env.LOOP_GUARD_PORT) || 3477

// PORT_RECORD remembers the port this service actually took, so a restart
// reuses it instead of hunting again, and so a move that had to be written
// back to magpie is never written twice (a second write would restart the
// host again, forever). It sits beside the events, where /config is writable
// even though the plugin's own folder is mounted read-only.
const PORT_RECORD = join(eventsDir(), "loop-guard-port.json")

// PLUGINS_JSON is magpie's own list, where its options live: settings.Dir()
// in magpie, which is /config/magpie in the usual container and beside the
// config folder elsewhere.
function pluginsJSON() {
  if (process.env.LOOP_GUARD_PLUGINS_JSON) return process.env.LOOP_GUARD_PLUGINS_JSON
  const base = eventsDir()
  return join(base, "magpie", "plugins.json")
}
const PLUGINS_JSON = pluginsJSON()

// spec is this plugin as magpie names it, for the CLI calls: the folder
// magpie loaded it from, which is how a folder install is listed
// (/config/magpie-loop-guard in the usual container), or a name that only
// the CLI can match (MAGPIE_PLUGIN_SPEC). A name that matches nothing makes
// the save answer magpie's own "no plugin" error, which the page shows.
const SPEC = process.env.MAGPIE_PLUGIN_SPEC || process.env.LOOP_GUARD_SPEC || HERE

// readEvents is the newest events, oldest first, each line one JSON object.
// A file that isn't there yet is no events, not an error.
async function readEvents() {
  try {
    const text = await readFile(EVENTS, "utf8")
    const out = []
    for (const line of text.split("\n")) {
      const t = line.trim()
      if (!t) continue
      try {
        out.push(JSON.parse(t))
      } catch {
        // a half-written last line: left out
      }
    }
    return out
  } catch {
    return []
  }
}

// magpieCli runs magpie's own CLI: the only way to set a plugin's options
// that does not need the window's /api.
async function magpieCli(args) {
  const bin = process.env.MAGPIE_BIN || "magpie"
  const p = Bun.spawn([bin, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env
  })
  const out = await new Response(p.stdout).text()
  const err = await new Response(p.stderr).text()
  const code = await p.exited
  return { code, out, err }
}

// STATIC are the page's files and what each is sent as. Nothing else in the
// plugin's folder is served: the events and this service's own files are not
// a page's to read.
// gate.html is not among them: it is the door magpie serves, and a copy of
// it here would send the frame back to this very address, forever.
const STATIC = new Map([
  ["app.js", "text/javascript; charset=utf-8"],
  ["style.css", "text/css; charset=utf-8"]
])

// pageCSP is the policy of the page this service serves. 'self' is its own
// root, which magpie rewrites to the full address it is reached at
// (serviceSelf in internal/gui/pageservice.go), so the page may fetch its own
// api/… while nothing else is reachable. Without a policy of its own the
// document would inherit magpie's page one, whose connect-src is none, and
// every fetch would be refused.
const pageCSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ")

// file answers one of the page's files, read on each ask so an edit shows.
async function file(path, type) {
  try {
    const body = await readFile(path)
    const headers = { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" }
    if (type.startsWith("text/html")) headers["content-security-policy"] = pageCSP
    return new Response(body, { headers })
  } catch {
    return new Response("not found", { status: 404 })
  }
}
// cors are the headers a sandboxed frame's request needs. The frame's
// origin is opaque (Origin: null), so the answer names it as it came: this
// service is served under the page's own token, and nothing without that
// token reaches it (the proxy in front does the checking).
function cors(req) {
  const origin = req.headers.get("origin")
  if (!origin) return {}
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "Origin"
  }
}

const json = (data, status = 200, extra) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(extra || {}) }
  })

// handle is one request of the page's.
async function handle(req) {
  const h = cors(req)
  // a preflight: the frame asks before a POST with a JSON body
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h })
  const res = await route(req)
  for (const k of Object.keys(h)) res.headers.set(k, h[k])
  return res
}

// route is handle without the page's CORS headers.
async function route(req) {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === "/" || path === "/index.html") return file(PAGE, "text/html; charset=utf-8")

  // the page's own files: app.js, style.css, and nothing outside page/
  const rel = path.slice(1)
  if (rel && !rel.includes("..") && STATIC.has(rel)) {
    return file(join(HERE, "page", rel), STATIC.get(rel))
  }

  // the events, newest first, at most limit of them
  if (path === "/api/events") {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200))
    const all = await readEvents()
    return json({ events: all.slice(-limit).reverse(), total: all.length })
  }

  // the plugin's options, as magpie keeps them
  if (path === "/api/options" && req.method === "GET") {
    const r = await magpieCli(["plugin", "options", SPEC])
    if (r.code !== 0) {
      return json({ error: r.err.trim() || r.out.trim() || "magpie plugin options failed" }, 502)
    }
    try {
      return json(JSON.parse(r.out))
    } catch {
      return json({})
    }
  }

  // a save: the body is the options object
  if (path === "/api/options" && req.method === "POST") {
    let body
    try {
      body = await req.json()
    } catch {
      return json({ error: "the options are a JSON object" }, 400)
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "the options are a JSON object" }, 400)
    }
    const r = await magpieCli(["plugin", "options", SPEC, JSON.stringify(body)])
    if (r.code !== 0) {
      return json({ error: r.err.trim() || r.out.trim() || "saving the options failed" }, 502)
    }
    return json({ ok: true, options: body })
  }

  return new Response("not found", { status: 404 })
}

// serve is the plugin's server entry, as the host expects it: it starts the
// service on the port the plugin's options name, or the package's.
// readJSON is a small JSON file, or null when it is missing or unreadable.
async function readJSON(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return null
  }
}

// writeJSON writes one small JSON file, making its folder if need be.
async function writeJSON(path, v) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(v) + "\n")
}

// askedPort is what magpie says the page service is at: its options' port,
// which hostOptions may have moved, else the package's.
function askedPort(options) {
  return Number(options?.port) || DEFAULT_PORT
}

// serve is the plugin's server entry, as the host expects it: it starts
// the service on the port magpie names, and on the next free one when
// something else holds it. A port it had to move to is written back into
// the plugin's options, so magpie looks there too and the page is not a
// 502. The write restarts the host once; PORT_RECORD keeps that from
// happening again for the same move.
export default async function serve(options) {
  const asked = askedPort(options)
  let last
  for (let port = asked; port < asked + 20; port++) {
    try {
      const server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch: (req) => handle(req).catch((e) => json({ error: String(e?.message ?? e) }, 500)),
        error: (e) => json({ error: String(e?.message ?? e) }, 500)
      })
      // Bun picks the port it can take, which is the one asked unless
      // something holds it: what it answers with is what magpie must be
      // told, not the one this loop tried.
      if (server.port !== asked) {
        console.log("loop-guard: port " + asked + " was taken, the page service is on " + server.port)
        await tellMagpie(asked, server.port)
      }
      return { port: server.port }
    } catch (e) {
      last = e
    }
  }
  throw last
}

// tellMagpie writes the port this service took into plugins.json, so the page
// is reached where magpie looks. It edits the file rather than running
// `magpie plugin options`: that CLI ends in SetOptions, which calls Restart,
// which stops the host this service is running in while the call waits for
// it — the host never loads again and the page is a 502 for good. The file
// is what that CLI writes anyway; magpie reads it again on the next look.
// Only `port` is put over the options read, so a preset is never lost. A
// move already recorded is not written again.
async function tellMagpie(asked, port) {
  try {
    const rec = await readJSON(PORT_RECORD)
    if (rec && rec.asked === asked && rec.port === port) return
    const list = await readJSON(PLUGINS_JSON)
    if (!list || !Array.isArray(list.plugins)) return
    const entry = list.plugins.find((p) => p && p.spec === SPEC)
    if (!entry) return
    const cur = entry.options
    const opts = cur && typeof cur === "object" && !Array.isArray(cur) ? { ...cur } : {}
    if (Number(opts.port) === port) {
      await writeJSON(PORT_RECORD, { asked, port, at: new Date().toISOString() })
      return
    }
    opts.port = port
    entry.options = opts
    await writeJSON(PLUGINS_JSON, list)
    console.log("loop-guard: wrote the page service's port " + port + " into plugins.json")
    await writeJSON(PORT_RECORD, { asked, port, at: new Date().toISOString() })
  } catch (e) {
    console.log("loop-guard: could not tell magpie the port: " + (e?.message ?? e))
  }
}
