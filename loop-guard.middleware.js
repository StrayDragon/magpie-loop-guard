// loop-guard.middleware.js — 打断 LLM 死循环的 magpie 网关中间件。
//
// 模型在同一个会话里连续返回一模一样的回复时(常见于 agent 的工具调用
// 死循环),每多一轮都在白花钱。本中间件在请求发出前,从请求体自带的
// 会话历史里数"连续相同的助手回复":达到阈值(默认 5)就拒绝这个请求,
// 把循环打断——正是"重复 N 次一模一样的内容,就中断后续请求"。
//
// 设计(性能与开销):
//   - 无跨请求状态。计数来自请求体自身携带的历史,天然按会话独立,
//     不需要共享表、锁和淘汰策略;子代理、多会话互不干扰。
//   - 只挂 onRequest,不挂 onEvent/onResponse,回复(流式)路径
//     完全不加包装,零开销。
//   - 每个请求只做:模型名匹配(常数)+ 至多 scan 条消息的角色判断
//     + 至多 threshold 条回复的哈希(凑满阈值或遇到第一个不同就停)。
//   - 比较前去掉 id、signature、usage 等每次必变的字段,只比内容;
//     任何"算不出来"(预算超限)都按不确定处理,放行而不是拒绝。
//
// 选项(ctx.options,plugins.json 里该插件的 options):
//
//   {
//     "targets": ["*"],      // 按请求的模型名匹配(ctx.model;magpie 的模型名是
//                            // "provider/model" 形式),支持 * 通配:
//                            // "deepseek/*"、"*/deepseek-chat"、确切全名
//     "agents": [],          // 只对某些 agent 生效(可省),如 ["claude-code"];空为全部
//     "threshold": 5,        // 连续相同回复达到几次后拒绝后续请求(最小按 2 算)
//     "scan": 500,           // 最多回看多少条消息(成本上限)
//     "maxChars": 4000000,   // 参与比较的字符总量上限,超出按"不确定"放行
//     "status": 400,         // 拒绝时的 HTTP 状态码。特意不用 429:多数 agent
//                            // 会对 429 自动退避重试,那与打断循环的目的相反
//     "message": "",         // 自定义拒绝消息;默认说明次数与处理办法
//     "mode": "reject",      // "log":只记录不拒绝,先试运行观察会不会误伤
//     "stopOnUser": false,   // true:回看遇到真实用户发言就停止计数(更保守)
//     "ignore": []           // 在默认表之外,比较时额外忽略的字段名
//   }

// DEFAULT_IGNORE 是比较回复时忽略的易变字段:同一次死循环里,这些字段
// 每轮都不同(每轮新的消息 id、工具调用 id、思考块签名、用量统计……),
// 不去掉就没法认出"一模一样的回复"。
const DEFAULT_IGNORE = [
  "id", "signature", "usage", "logprobs",
  "created", "created_at", "timestamp", "time",
  "request_id", "response_id", "message_id", "item_id",
  "call_id", "tool_call_id",
  "first_token_at", "session", "trace_id", "span_id",
  "system_fingerprint", "service_tier", "fingerprint",
]

export function onRequest(body, ctx) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return
  const c = cfg(ctx)
  if (!globOK(ctx && ctx.model, c.targets)) return
  if (c.agents.length > 0 && !globOK(ctx && ctx.agent, c.agents)) return
  const list = turnsArray(body, ctx && ctx.protocol)
  if (list === null) return
  const run = countTail(list, c, { walk: 0, chars: 0, max: c.maxChars, over: false }, ctx.protocol)
  if (run < c.threshold) return
  if (c.mode === "log") {
    console.log("loop-guard: " + String(ctx.model || "?") + " has repeated the same reply " + run +
      " times in a row (threshold " + c.threshold + "); mode=log, not blocking")
    return
  }
  const msg = c.message ||
    ("loop-guard: the model has returned the same reply " + run + " times in a row in this session," +
      " so this request was stopped to break the loop. Start a new session or change the prompt," +
      " or raise \"threshold\" in this middleware's options.")
  ctx.reject(c.status, msg)
}

// cfg reads and normalizes ctx.options once per runtime; the same object
// arrives on every request, so the built form is cached like word-guard's
// matcher is.
let cached = null
function cfg(ctx) {
  const o = ctx && typeof ctx.options === "object" && ctx.options ? ctx.options : {}
  let key
  try { key = JSON.stringify(o) } catch (e) { key = "?" }
  if (cached && cached.key === key) return cached.c
  const c = build(o)
  cached = { key: key, c: c }
  return cached.c
}

function build(o) {
  const c = {}
  let targets = strList(o.targets)
  if (targets.length === 0) targets = ["*"]
  c.targets = targets
  c.agents = strList(o.agents)
  let th = Math.floor(Number(o.threshold))
  c.threshold = th >= 2 ? th : 5
  let sc = Math.floor(Number(o.scan))
  c.scan = sc >= 1 ? sc : 500
  let mc = Math.floor(Number(o.maxChars))
  c.maxChars = mc >= 1 ? mc : 4000000
  let st = Math.floor(Number(o.status))
  c.status = st >= 400 && st <= 599 ? st : 400
  c.message = typeof o.message === "string" ? o.message : ""
  c.mode = o.mode === "log" ? "log" : "reject"
  c.stopOnUser = o.stopOnUser === true
  const drop = {}
  for (let i = 0; i < DEFAULT_IGNORE.length; i++) drop[DEFAULT_IGNORE[i]] = 1
  const extra = Array.isArray(o.ignore) ? o.ignore : []
  for (let i = 0; i < extra.length; i++) {
    if (typeof extra[i] === "string" && extra[i]) drop[extra[i]] = 1
  }
  c.drop = drop
  return c
}

function strList(v) {
  const out = []
  if (!Array.isArray(v)) return out
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] === "string" && v[i]) out.push(v[i].toLowerCase())
  }
  return out
}

// globOK tells whether name matches any pattern; patterns are matched
// case-insensitively, * stands for any run of characters. An empty name
// matches only patterns that are empty or exactly "*".
function globOK(name, pats) {
  const n = String(name || "").toLowerCase()
  for (let i = 0; i < pats.length; i++) {
    const p = pats[i]
    if (p === "*" || p === n) return true
    if (p.indexOf("*") < 0) continue
    const parts = p.split("*")
    let pos = 0
    let ok = true
    for (let j = 0; j < parts.length; j++) {
      const part = parts[j]
      if (part === "") continue
      if (j === parts.length - 1) {
        const at = n.lastIndexOf(part)
        if (at < pos || at !== n.length - part.length) { ok = false; break }
        pos = n.length
      } else {
        const at = n.indexOf(part, pos)
        if (at < 0) { ok = false; break }
        pos = at + part.length
      }
    }
    if (ok) return true
  }
  return false
}

// turnsArray is the request's list of turns, in its API's shape; null when
// there is no history to compare (a Responses request whose input is only
// the new text, or a body without messages at all).
function turnsArray(body, protocol) {
  if (protocol === "gemini") {
    if (Array.isArray(body.contents)) return body.contents
    return Array.isArray(body.messages) ? body.messages : null
  }
  if (protocol === "responses") {
    if (typeof body.input === "string") return null
    if (Array.isArray(body.input)) return body.input
    return Array.isArray(body.messages) ? body.messages : null
  }
  return Array.isArray(body.messages) ? body.messages : null
}

// kindOf classes one turn: "r" a reply (assistant message, or one piece of
// one — Responses puts a reply's message and its function_call on adjacent
// items), "t" a tool result, "u" a real user turn, "s" anything else
// (system, developer, unknown shapes), which is passed without a decision.
function kindOf(m, protocol) {
  if (protocol === "gemini") return kindGemini(m)
  if (protocol === "responses") return kindResponses(m)
  if (!m || typeof m !== "object") return "s"
  const role = m.role
  if (protocol === "chat") {
    if (role === "assistant") return "r"
    if (role === "tool") return "t"
    if (role === "user") return "u"
    return "s"
  }
  if (role === "assistant") return "r"
  if (role === "user") {
    if (Array.isArray(m.content)) {
      const b = m.content
      for (let i = 0; i < b.length; i++) {
        if (b[i] && typeof b[i] === "object" && b[i].type === "tool_result") return "t"
      }
    }
    return "u"
  }
  return "s"
}

function kindGemini(m) {
  if (!m || typeof m !== "object") return "s"
  if (m.role === "model") return "r"
  if (Array.isArray(m.parts)) {
    const ps = m.parts
    for (let i = 0; i < ps.length; i++) {
      if (ps[i] && typeof ps[i] === "object" && ps[i].functionResponse) return "t"
    }
  }
  return "u"
}

function kindResponses(m) {
  if (typeof m === "string") return "u"
  if (!m || typeof m !== "object") return "s"
  const ty = m.type
  if (ty === "message") {
    if (m.role === "assistant") return "r"
    if (m.role === "user") return "u"
    return "s"
  }
  if (ty === "function_call" || ty === "tool_call" || ty === "reasoning" ||
    ty === "custom_tool_call" || ty === "local_shell_call") return "r"
  if (ty === "function_call_output" || ty === "tool_call_output" ||
    ty === "custom_tool_call_output") return "t"
  if (ty === "item_reference") return "s"
  if (m.role === "assistant") return "r"
  if (m.role === "user") return "u"
  return "s"
}

// countTail walks the history backward and counts the run of identical
// replies that ends at the newest one: tool results and (unless stopOnUser)
// user turns are passed, the run breaks at the first differing reply, and
// it stops as soon as it reaches the threshold. 0 means "no loop" — also
// when the walk or the hashing ran out of budget: unknown is never equal.
function countTail(list, c, st, protocol) {
  const n = list.length
  let prevKind = "x"
  let cur = null // the logical reply being accumulated, walking backward
  let ref = null // the logical reply completed just before it
  let run = 0
  let i = n - 1
  while (i >= 0 && st.walk < c.scan) {
    st.walk++
    const k = kindOf(list[i], protocol)
    if (k === "r") {
      const h = hashTurn(list[i], c.drop, st)
      if (st.over) return 0
      cur = prevKind === "r" ? combine(cur, h) : h
    } else {
      if (prevKind === "r" && cur !== null) {
        if (ref === null) {
          ref = cur
          run = 1
        } else if (same(ref, cur)) {
          run++
          ref = cur
          if (run >= c.threshold) return run
        } else {
          return 0
        }
        cur = null
      }
      if (k === "u" && c.stopOnUser) return 0
    }
    prevKind = k
    i--
  }
  if (prevKind === "r" && cur !== null) {
    if (ref === null) run = 1
    else if (same(ref, cur)) run++
    else return 0
    if (run >= c.threshold) return run
  }
  return 0
}

// hashTurn feeds one turn's canonical form — its structure and content,
// with the keys in drop taken out — straight into the hash, token by
// token: no canonical string is built, so the turn's bytes are read once
// and nothing is allocated on the way. The canonical token sequence is
// what a JSON-ish printer would emit ("k":v pairs, [a,b,] arrays), so two
// turns the client echoed from the same reply feed the same bytes. The
// budget counts characters; an exhausted budget marks the comparison
// unknown, and unknown is never equal.
function hashTurn(m, drop, st) {
  let a = 0x811c9dc5 | 0
  let b = 5381 | 0
  const feed = (s) => {
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i)
      a = Math.imul(a ^ ch, 16777619)
      b = (Math.imul(b, 33) ^ ch) | 0
    }
  }
  const walk = (v) => {
    if (st.over) return
    if (v === null) { feed("0"); return }
    const t = typeof v
    if (t === "string") {
      st.chars += v.length
      if (st.chars > st.max) { st.over = true; return }
      feed("\"")
      feed(v)
      feed("\"")
      return
    }
    if (t === "number") { feed(String(v)); return }
    if (t === "boolean") { feed(v ? "1" : "0"); return }
    if (t === "object") {
      if (Array.isArray(v)) {
        feed("[")
        for (let i = 0; i < v.length; i++) {
          walk(v[i])
          if (st.over) return
          feed(",")
        }
        feed("]")
        return
      }
      feed("{")
      for (const k in v) {
        if (drop[k]) continue
        feed(k)
        feed(":")
        walk(v[k])
        if (st.over) return
        feed(",")
      }
      feed("}")
      return
    }
    feed("?")
  }
  walk(m)
  if (st.over) return [0, 0]
  return [a, b]
}

function same(p, q) {
  return p[0] === q[0] && p[1] === q[1]
}

// combine folds one turn's hash into the logical reply being accumulated
// (a Responses reply's message and function_call, for one).
function combine(p, h) {
  return [(Math.imul(p[0], 31) + h[0]) | 0, (Math.imul(p[1], 33) + h[1]) | 0]
}
