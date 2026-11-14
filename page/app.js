// app.js — loop-guard's page: what the guard did, and what it will do.
//
// This page is served by the plugin's own service (loop-guard.server.js),
// so it can fetch its own API. It never talks to magpie's /api.

const $ = (id) => document.getElementById(id)

const fmt = (iso) => {
  const d = new Date(iso)
  if (isNaN(d)) return iso || ""
  const p = (n) => String(n).padStart(2, "0")
  return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds())
}

const WHY = { repeat: "连续重复", fragment: "碎片复读" }
const MODE = { reject: "拒绝", inject: "注入纠正语", log: "仅记录" }

// shortId is the request id as far as it tells one from another: a session
// header is long, and the page is read at a glance.
const shortId = (s) => {
  if (!s) return "—"
  return s.length <= 14 ? s : s.slice(0, 8) + "…" + s.slice(-4)
}

// api is a path of this page's own service, resolved against the page's
// address: the page is served under the service's root
// (/_magpie/plugin/<token>/_magpie/service/), so a leading / would leave it
// for magpie's own /api, which a sandboxed frame may not read.
const api = (path) => new URL(path.replace(/^\//, ""), document.baseURI).href

async function getJSON(path) {
  const r = await fetch(api(path), { cache: "no-store" })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error || ("HTTP " + r.status))
  return body
}

// renderStats is the counts the reader wants first: how many, by what.
function renderStats(events) {
  const by = { reject: 0, inject: 0, log: 0 }
  const models = new Map()
  const presets = new Map()
  for (const e of events) {
    by[e.mode] = (by[e.mode] || 0) + 1
    models.set(e.model || "?", (models.get(e.model || "?") || 0) + 1)
    presets.set(e.preset || "default", (presets.get(e.preset || "default") || 0) + 1)
  }
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
  const card = (n, label, sub) =>
    "<div class=\"card\"><b>" + n + "</b><span>" + label + "</span>" +
    (sub ? "<small class=\"muted\">" + sub + "</small>" : "") + "</div>"
  const list = (xs) => xs.length ? xs.map(([k, v]) => k + " × " + v).join("、") : "—"
  $("stats").innerHTML = [
    card(events.length, "共处理", "本次保留"),
    card(by.inject, "注入纠正语", "请求继续"),
    card(by.reject, "拒绝请求", "已打断"),
    card(by.log, "仅记录", "未干预"),
    card("", "按 preset", list(top(presets))),
    card("", "按模型", list(top(models))),
  ].join("")
}

function renderRows(events) {
  const tbody = $("rows")
  if (!events.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted">还没有被处理过的请求。一切正常。</td></tr>'
    return
  }
  tbody.innerHTML = events.map((e) => {
    const mode = MODE[e.mode] || e.mode || ""
    const why = WHY[e.why] || e.why || ""
    const run = e.run ? (e.run + (e.threshold ? " / " + e.threshold : "")) : ""
    return "<tr>" +
      "<td class=\"mono\">" + fmt(e.at) + "</td>" +
      "<td class=\"mono\" title=\"" + (e.request || "") + "\">" + shortId(e.request) + "</td>" +
      "<td class=\"mono\">" + (e.model || "—") + "</td>" +
      "<td>" + (e.agent || "—") + "</td>" +
      "<td>" + (e.preset || "default") + "</td>" +
      "<td>" + why + "</td>" +
      "<td class=\"mono\">" + run + "</td>" +
      "<td><span class=\"tag " + (e.mode || "") + "\">" + mode + "</span></td>" +
    "</tr>"
  }).join("")
}

async function loadEvents() {
  try {
    const { events } = await getJSON("/api/events?limit=200")
    renderStats(events)
    renderRows(events)
  } catch (e) {
    $("rows").innerHTML = '<tr><td colspan="8" class="muted">读取事件失败：' + e.message + "</td></tr>"
  }
}

// ---- settings -------------------------------------------------------------

const FIELDS = [
  { key: "targets", label: "匹配的模型", kind: "list", hint: "* = 全部；[] = 全部；空 = 不保护任何模型" },
  { key: "threshold", label: "连续重复多少次才认为循环", kind: "int", min: 2, hint: "最小 2" },
  { key: "mode", label: "处置方式", kind: "select", options: ["reject", "inject", "log"], hint: "reject 拒绝请求；inject 追加纠正语；log 只记录" },
  { key: "prompt", label: "注入的纠正语", kind: "text", hint: "仅 inject 模式；空 = 用内置文案" },
  { key: "fragment", label: "碎片复读检测", kind: "bool", hint: "单条回复内部的复读" },
]

// presetOf is the first models rule, whose fields the guard uses for the
// models it names; the top-level ones only stand where a rule leaves one
// out. A form showing only the top level would say "reject" while a preset
// injects, so the field says which it is showing.
function presetOf() {
  const models = Array.isArray(options.models) ? options.models : []
  const first = models[0]
  return first && typeof first === "object" && !Array.isArray(first) ? first : null
}

let options = {}

function field(f) {
  // what the guard actually uses: the preset's value when it sets one.
  // targets is the exception: it is the switch that turns guarding on for
  // models, and a preset's own targets only narrow which model it names, so
  // the top-level one is what a reader is changing here.
  const preset = presetOf()
  const fromPreset = f.key !== "targets" && preset && preset[f.key] !== undefined && preset[f.key] !== null
  const v = fromPreset ? preset[f.key] : options[f.key]
  const id = "f-" + f.key
  let input
  if (f.kind === "list") {
    // [] is not "" here: [] enables every model, while a field left empty
    // turns the guard off. Showing one as the other would change what a
    // save means.
    const text = Array.isArray(v) ? (v.length === 0 ? "[]" : v.join(", ")) : (v == null ? "" : String(v))
    input = '<input id="' + id + '" type="text" value="' + esc(text) + '" placeholder="* 或 provider/model">'
  } else if (f.kind === "int") {
    input = '<input id="' + id + '" type="number" min="' + f.min + '" value="' + esc(v == null ? "" : v) + '">'
  } else if (f.kind === "select") {
    input = '<select id="' + id + '">' + f.options.map((o) =>
      '<option value="' + o + '"' + (v === o ? " selected" : "") + '>' + (MODE[o] || o) + '</option>').join("") + "</select>"
  } else if (f.kind === "bool") {
    input = '<input id="' + id + '" type="checkbox"' + (v ? " checked" : "") + '>'
  } else {
    input = '<input id="' + id + '" type="text" value="' + esc(v == null ? "" : v) + '">'
  }
  const whence = fromPreset ? "（来自 preset " + (preset.name || "") + "）" : ""
  return '<label class="field"><span>' + f.label + whence + '</span>' + input +
    (f.hint ? '<small class="muted">' + f.hint + "</small>" : "") + "</label>"
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
}

function renderForm() {
  $("form").innerHTML = FIELDS.map(field).join("")
  $("raw").value = JSON.stringify(options, null, 2)
}

function readForm() {
  const out = JSON.parse(JSON.stringify(options))
  for (const f of FIELDS) {
    const el = $("f-" + f.key)
    if (!el) continue
    if (f.kind === "list") {
      const raw = el.value.trim()
      if (!raw) { delete out[f.key]; continue }
      if (raw === "[]") { out[f.key] = []; continue }
      out[f.key] = raw.split(",").map((s) => s.trim()).filter(Boolean)
    } else if (f.kind === "int") {
      const n = Number(el.value)
      if (el.value === "" || isNaN(n)) delete out[f.key]
      else out[f.key] = n
    } else if (f.kind === "select") {
      out[f.key] = el.value
    } else if (f.kind === "bool") {
      if (el.checked) out[f.key] = true
      else delete out[f.key]
    } else {
      const t = el.value.trim()
      if (t) out[f.key] = t
      else delete out[f.key]
    }
  }
  return out
}

async function loadOptions() {
  try {
    options = await getJSON("/api/options")
    renderForm()
  } catch (e) {
    $("msg").textContent = "读取设置失败：" + e.message
  }
}

async function save() {
  const rawShown = !$("raw").hidden
  let body
  if (rawShown) {
    try {
      body = JSON.parse($("raw").value)
    } catch (e) {
      $("msg").textContent = "JSON 格式错误：" + e.message
      return
    }
  } else {
    body = readForm()
  }
  $("msg").textContent = "保存中…"
  try {
    const r = await fetch(api("/api/options"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })
    const got = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(got.error || ("HTTP " + r.status))
    options = body
    renderForm()
    $("msg").textContent = "已保存，下一轮请求生效"
  } catch (e) {
    $("msg").textContent = "保存失败：" + e.message
  }
}

// ---- wiring ---------------------------------------------------------------

$("reload").addEventListener("click", loadEvents)
$("save").addEventListener("click", save)
$("raw-toggle").addEventListener("click", () => {
  const raw = $("raw")
  if (raw.hidden) {
    try { raw.value = JSON.stringify(readForm(), null, 2) } catch {}
    raw.hidden = false
    $("raw-toggle").textContent = "收起 JSON"
  } else {
    raw.hidden = true
    $("raw-toggle").textContent = "编辑 JSON"
  }
})

let timer = null
$("auto").addEventListener("change", (e) => {
  if (timer) { clearInterval(timer); timer = null }
  if (e.target.checked) timer = setInterval(loadEvents, 3000)
})

$("auto").checked = true
timer = setInterval(loadEvents, 3000)
loadEvents()
loadOptions()
