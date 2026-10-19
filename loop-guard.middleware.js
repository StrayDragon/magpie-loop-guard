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
// 选项(ctx.options,plugins.json 里该插件的 options)。顶层是默认值,
// models 里按模型组覆盖;一条规则只写它要改的字段,其余继承顶层。
//
//   {
//     "targets": ["*"],      // 匹配请求的模型名(ctx.model;magpie 的模型名是
//                            // "provider/model" 形式)。任何一层的 targets:
//                            // 未填 = 全部模型,[] = 不保护任何模型。
//                            // 写法:大小写不敏感的 * 通配,或 /正则/(区分
//                            // 大小写,与 model-map 的 /pattern/ 一致)
//     "models": [            // 可选:按模型组的规则,按书写顺序匹配,
//       {"targets": ["deepseek/*"], "threshold": 3, "scope": "tools"},
//       {"targets": ["/^anthropic\\/claude/"], "mode": "log"},
//       {"targets": ["zhipu/*"], "ignore": ["x_seed"]}
//     ],
//     "threshold": 5,        // 以下为顶层默认值,规则可逐条覆盖
//     "scope": "full",       // "tools":只比较工具调用(名称+参数),叙述文字的
//                            // 措辞变化不再打断计数;配合 "ignore" 还能忽略
//                            // 工具参数里的注解字段(如 bash 的 description)
//     "scan": 500,           // 最多回看多少条消息(成本上限)
//     "maxChars": 4000000,   // 参与比较的字符总量上限,超出按"不确定"放行
//     "status": 400,         // 拒绝时的 HTTP 状态码。特意不用 429:多数 agent
//                            // 会对 429 自动退避重试,那与打断循环的目的相反
//     "message": "",         // 自定义拒绝消息;默认说明次数与处理办法
//     "mode": "reject",      // "log":只记录不拒绝,先试运行观察会不会误伤
//     "stopOnUser": false,   // true:回看遇到真实用户发言就停止计数(更保守)
//     "ignore": [],          // 在默认表之外,比较时额外忽略的字段名(顶层与
//                            // 规则的并集)
//     "agents": []           // 只对某些 agent 生效(可省),如 ["claude-code"];
//                            // 未填 = 全部,[] = 不保护任何 agent
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

// imul is 32-bit integer multiply. Math.imul (ES6) is used when present;
// the 16-bit split below is the standard fallback, so the hash works on
// engines that lack it too. One local alias, not a patch on Math.
const imul = typeof Math.imul === "function"
  ? Math.imul
  : function (x, y) {
    const ah = (x >>> 16) & 0xffff
    const al = x & 0xffff
    const bh = (y >>> 16) & 0xffff
    const bl = y & 0xffff
    return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0) | 0)
  }

export function onRequest(body, ctx) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return
  const built = cfg(ctx)
  if (!matchTargets(ctx && ctx.agent, built.agents)) return
  const c = pick(built, ctx && ctx.model)
  if (c === null) return
  if (c.scope !== null && c.scope.length === 0) return // scope:[] — 完全放行
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

// build compiles the options once per runtime into an ordered list of
// per-model rules plus one global fallback. A request picks the first
// rule whose targets match its model; with no match — or when there are
// no rules — the top-level fields apply. At every level, targets left
// out means every model and an empty list means none, so a top-level
// "targets": [] with rules underneath guards exactly the listed models.
function build(o) {
  const base = oneCfg(o, null)
  base.agents = listOf(o, null, "agents")
  base.drop = dropOf(o, null)
  const out = { agents: base.agents, global: base, rules: [] }
  const models = Array.isArray(o.models) ? o.models : []
  for (let i = 0; i < models.length; i++) {
    const m = models[i]
    if (!m || typeof m !== "object" || Array.isArray(m)) continue
    const rule = oneCfg(m, base)
    rule.targets = listOf(m, base.targets, "targets")
    rule.drop = dropOf(m, base)
    out.rules.push(rule)
  }
  return out
}

// pick returns the config of the first rule matching the model, then the
// global one — whose own targets decide the no-rule and top-level []
// cases. null means nothing guards this model and the request passes.
function pick(built, model) {
  for (let i = 0; i < built.rules.length; i++) {
    if (matchTargets(model, built.rules[i].targets)) return built.rules[i]
  }
  if (matchTargets(model, built.global.targets)) return built.global
  return null
}

// listOf reads one matching field (targets, agents): left out means every
// model, an empty list (or one with no usable entries) means none, a bare
// string is one entry, entries may be globs with * or /regular
// expressions/. The inherited base is the already-resolved shape from the
// level above, so a models entry without targets takes the top level's.
function listOf(o, base, name) {
  if (o && typeof o === "object" && o[name] !== undefined) {
    const l = strList(o[name])
    if (l.length > 0) return { list: l }
    return { none: true }
  }
  if (base) return base
  return { all: true }
}

// matchTargets is listOf's runtime side: an object from listOf on the
// the left, a name on the right. agent matches work the same way.
function matchTargets(name, t) {
  if (!t) return true
  if (t.all) return true
  if (t.none) return false
  return globOK(name, t.list)
}

function strList(v) {
  const out = []
  if (typeof v === "string") v = [v] // 一个字符串当作单项列表,输入宽容
  if (!Array.isArray(v)) return out
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] === "string" && v[i]) out.push(normPattern(v[i]))
  }
  return out
}

// normPattern lowercases a glob, and compiles a /regular expression/
// into an object once, at build time. A pattern that fails to compile is
// dropped: a broken guard must never take the request path down.
function normPattern(p) {
  if (p.length > 2 && p.charAt(0) === "/" && p.charAt(p.length - 1) === "/") {
    const body = p.slice(1, p.length - 1)
    try {
      return { re: new RegExp(body) }
    } catch (e) {
      return ""
    }
  }
  return p.toLowerCase()
}

// num reads one numeric option: present and valid wins, then the level
// above, then the fallback.
function num(o, base, name, fallback, ok) {
  if (o && typeof o === "object" && o[name] !== undefined) {
    const v = Math.floor(Number(o[name]))
    if (ok(v)) return v
  }
  if (base && base[name] !== undefined) return base[name]
  return fallback
}

// oneCfg normalizes one level (the top level, or one models entry) into
// a concrete config; fields the level leaves out are inherited from base
// (null at the top level), so a rule can name a model group and change
// one number while everything else stays as configured above it.
function oneCfg(o, base) {
  const has = (name) => o && typeof o === "object" && o[name] !== undefined
  const inh = (name) => (base && base[name] !== undefined ? base[name] : undefined)
  const c = {}
  c.threshold = num(o, base, "threshold", 5, (v) => v >= 2)
  c.scan = num(o, base, "scan", 500, (v) => v >= 1)
  c.maxChars = num(o, base, "maxChars", 4000000, (v) => v >= 1)
  c.status = num(o, base, "status", 400, (v) => v >= 400 && v <= 599)
  if (has("message") && typeof o.message === "string") c.message = o.message
  else if (inh("message") !== undefined) c.message = inh("message")
  else c.message = ""
  if (o && o.mode === "log") c.mode = "log"
  else if (o && o.mode === "reject") c.mode = "reject"
  else if (inh("mode") !== undefined) c.mode = inh("mode")
  else c.mode = "reject"
  if (has("scope")) c.scope = normScope(o.scope)
  else if (inh("scope") !== undefined) c.scope = inh("scope")
  else c.scope = null
  if (has("stopOnUser")) c.stopOnUser = o.stopOnUser === true
  else if (inh("stopOnUser") !== undefined) c.stopOnUser = inh("stopOnUser")
  else c.stopOnUser = false
  c.targets = listOf(o, base ? base.targets : null, "targets")
  c.drop = dropOf(o, base)
  return c
}

// dropOf builds the volatile-key table: the built-in list, then every
// name the top level and (for a rule) the models entry adds.
function dropOf(o, base) {
  const drop = {}
  for (let i = 0; i < DEFAULT_IGNORE.length; i++) drop[DEFAULT_IGNORE[i]] = 1
  const levels = base ? [base, o] : [o]
  for (let l = 0; l < levels.length; l++) {
    const src = levels[l]
    if (!src || typeof src !== "object") continue
    const extra = Array.isArray(src.ignore) ? src.ignore
      : typeof src.ignore === "string" ? [src.ignore] : []
    for (let i = 0; i < extra.length; i++) {
      if (typeof extra[i] === "string" && extra[i]) drop[extra[i]] = 1
    }
  }
  return drop
}


// globOK tells whether name matches any pattern; patterns are matched
// case-insensitively, * stands for any run of characters. An empty name
// matches only patterns that are empty or exactly "*".
function globOK(name, pats) {
  const n = String(name || "").toLowerCase()
  const raw = String(name || "")
  for (let i = 0; i < pats.length; i++) {
    const p = pats[i]
    if (typeof p !== "string") {
      if (p && p.re && p.re.test(raw)) return true
      continue
    }
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
// it stops as soon as it reaches the threshold. A logical reply is the run
// of adjacent reply-classified turns (a Responses reply's message and its
// function_call), buffered whole so scope:"tools" can decide per reply
// whether to hash its calls only. 0 means "no loop" — also when the walk
// or the hashing ran out of budget: unknown is never equal.
function countTail(list, c, st, protocol) {
  const n = list.length
  let prevKind = "x"
  let pending = [] // the turns of the logical reply being accumulated
  let ref = null // the hash of the logical reply completed just before it
  let run = 0
  let i = n - 1
  while (i >= 0 && st.walk < c.scan) {
    st.walk++
    const k = kindOf(list[i], protocol)
    if (k === "r") {
      pending.push(list[i])
    } else {
      if (prevKind === "r" && pending.length > 0) {
        const h = hashReplyGroup(pending, c, st, protocol)
        if (st.over) return 0
        if (ref === null) {
          ref = h
          run = 1
        } else if (same(ref, h)) {
          run++
          ref = h
          if (run >= c.threshold) return run
        } else {
          return 0
        }
        pending = []
      }
      if (k === "u" && c.stopOnUser) return 0
    }
    prevKind = k
    i--
  }
  if (prevKind === "r" && pending.length > 0) {
    const h = hashReplyGroup(pending, c, st, protocol)
    if (st.over) return 0
    if (ref === null) run = 1
    else if (same(ref, h)) run++
    else return 0
    if (run >= c.threshold) return run
  }
  return 0
}

// callsOf returns the tool calls of one reply turn, or null when the turn
// carries none: anthropic's tool_use content blocks, chat's tool_calls
// (and its legacy function_call), Responses' call-shaped items, Gemini's
// functionCall parts. Chat and Responses carry the arguments as a JSON
// string; the copy hashed here holds them parsed, so the drop table (and
// with it the "ignore" option) reaches keys inside the arguments. The
// request itself is never touched.
function callsOf(m, protocol) {
  if (!m || typeof m !== "object") return null
  if (protocol === "responses") {
    const ty = m.type
    if (ty === "function_call" || ty === "tool_call" ||
      ty === "custom_tool_call" || ty === "local_shell_call") {
      return [{ name: m.name, arguments: parseArgs(m.arguments) }]
    }
    return null
  }
  if (protocol === "gemini") {
    if (!Array.isArray(m.parts)) return null
    const out = []
    for (let i = 0; i < m.parts.length; i++) {
      const p = m.parts[i]
      if (p && typeof p === "object" && p.functionCall) out.push(p)
    }
    return out.length > 0 ? out : null
  }
  if (protocol === "chat") {
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const out = []
      for (let i = 0; i < m.tool_calls.length; i++) {
        const t = m.tool_calls[i]
        const f = t && typeof t.function === "object" && t.function ? t.function : {}
        out.push({ name: f.name, arguments: parseArgs(f.arguments) })
      }
      return out
    }
    if (m.function_call) {
      return [{ name: m.function_call.name, arguments: parseArgs(m.function_call.arguments) }]
    }
    return null
  }
  if (Array.isArray(m.content)) {
    const out = []
    for (let i = 0; i < m.content.length; i++) {
      const b = m.content[i]
      if (b && typeof b === "object" && b.type === "tool_use") out.push(b)
    }
    return out.length > 0 ? out : null
  }
  return null
}

// parseArgs turns a chat/Responses arguments string into an object so the
// drop table applies inside it; anything unparseable stays as it was.
function parseArgs(v) {
  if (typeof v !== "string" || v.length > 4000000) return v
  try { return JSON.parse(v) } catch (e) { return v }
}

// normScope normalizes one scope value: null means every part takes part
// (the old "full"), "tools"/"text"/"thinking" mean that one part, and an
// array is the set of parts to compare, in any order. An empty array is
// meaningful — the rule never fires ("完全放行"). Unknown entries are
// dropped; a non-empty array whose entries are all unknown falls back to
// full, so a typo cannot silently switch the guard off.
const SCOPE_PARTS = ["text", "thinking", "tools"]
function normScope(v) {
  if (Array.isArray(v)) {
    const out = []
    for (let i = 0; i < v.length; i++) {
      if (SCOPE_PARTS.indexOf(v[i]) >= 0 && out.indexOf(v[i]) < 0) out.push(v[i])
    }
    if (v.length > 0 && out.length === 0) return null // 全是写错的条目:回退 full,不能因手误静默关掉保护
    return out
  }
  if (v === "tools" || v === "text" || v === "thinking") return [v]
  return null
}

// replyPartsOf splits one reply turn into its comparable parts: the
// reply's text, its thinking, and its tool calls (callsOf's parsing, so
// the drop table reaches inside arguments).
function replyPartsOf(m, protocol) {
  const out = { text: "", thinking: "", calls: [] }
  if (!m || typeof m !== "object") return out
  const addText = (s) => {
    if (typeof s === "string" && s) out.text += (out.text ? "\u0000" : "") + s
  }
  const addThink = (s) => {
    if (typeof s === "string" && s) out.thinking += (out.thinking ? "\u0000" : "") + s
  }
  if (protocol === "gemini") {
    if (Array.isArray(m.parts)) {
      for (let i = 0; i < m.parts.length; i++) {
        const p = m.parts[i]
        if (!p || typeof p !== "object") continue
        if (p.functionCall) out.calls.push(p)
        else if (p.thought === true) addThink(p.text)
        else addText(p.text)
      }
    }
    return out
  }
  if (protocol === "responses") {
    if (m.type === "reasoning") {
      if (Array.isArray(m.summary)) {
        for (let i = 0; i < m.summary.length; i++) {
          const s = m.summary[i]
          if (s && typeof s === "object" && s.type === "summary_text") addThink(s.text)
        }
      }
      return out
    }
    if (m.type === "message" && Array.isArray(m.content)) {
      for (let i = 0; i < m.content.length; i++) {
        const p = m.content[i]
        if (p && typeof p === "object" && (p.type === "output_text" || p.type === "text")) addText(p.text)
      }
      return out
    }
    const cs = callsOf(m, protocol)
    if (cs !== null) out.calls = cs
    return out
  }
  if (protocol === "chat") {
    addText(m.content)
    if (Array.isArray(m.content)) {
      for (let i = 0; i < m.content.length; i++) {
        const p = m.content[i]
        if (p && typeof p === "object" && p.type === "text") addText(p.text)
      }
    }
    addThink(m.reasoning_content)
    const cs = callsOf(m, protocol)
    if (cs !== null) out.calls = cs
    return out
  }
  if (Array.isArray(m.content)) {
    for (let i = 0; i < m.content.length; i++) {
      const b = m.content[i]
      if (!b || typeof b !== "object") continue
      if (b.type === "text") addText(b.text)
      else if (b.type === "thinking") addThink(b.thinking)
      else if (b.type === "tool_use") out.calls.push(b)
    }
    return out
  }
  addText(m.content)
  return out
}

// hashReplyGroup hashes one logical reply. scope null (the default) hashes
// the turns whole. With a scope array, only the selected parts take part —
// hashed in the fixed order text, thinking, tools, with the volatile-key
// drop table still applied — so parts that reword between rounds no longer
// break the count. When the reply contains none of the selected parts, the
// whole turns are compared instead: two different replies never compare
// equal because there was nothing selected to compare.
function hashReplyGroup(turns, c, st, protocol) {
  let source = turns
  if (c.scope !== null) {
    const parts = { text: "", thinking: "", calls: [] }
    let hasText = false
    let hasThink = false
    let hasCalls = false
    for (let i = 0; i < turns.length; i++) {
      const p = replyPartsOf(turns[i], protocol)
      if (p.text) {
        parts.text += (hasText ? "\u0000" : "") + p.text
        hasText = true
      }
      if (p.thinking) {
        parts.thinking += (hasThink ? "\u0000" : "") + p.thinking
        hasThink = true
      }
      for (let j = 0; j < p.calls.length; j++) parts.calls.push(p.calls[j])
      if (p.calls.length > 0) hasCalls = true
    }
    const chosen = []
    if (c.scope.indexOf("text") >= 0 && hasText) chosen.push({ text: parts.text })
    if (c.scope.indexOf("thinking") >= 0 && hasThink) chosen.push({ thinking: parts.thinking })
    if (c.scope.indexOf("tools") >= 0 && hasCalls) chosen.push({ calls: parts.calls })
    if (chosen.length > 0) source = chosen
  }
  let out = null
  for (let i = 0; i < source.length; i++) {
    const h = hashTurn(source[i], c.drop, st)
    if (st.over) return [0, 0]
    out = out === null ? h : combine(out, h)
  }
  return out
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
      a = imul(a ^ ch, 16777619)
      b = (imul(b, 33) ^ ch) | 0
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
  return [(imul(p[0], 31) + h[0]) | 0, (imul(p[1], 33) + h[1]) | 0]
}
