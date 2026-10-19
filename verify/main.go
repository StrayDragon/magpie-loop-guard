// verify runs the gateway middleware's cases.json in moejs — the engine
// magpie itself runs gateway middleware in — so the suite is checked in
// production's JavaScript engine and not only in node and bun. With
// -bench it also times onRequest on a large, loop-shaped body the way a
// long agent session looks when it reaches the gateway.
//
//	go run . -file ../loop-guard.middleware.js -cases ../cases.json
//	go run . -file ../loop-guard.middleware.js -bench
//
// This is a development and CI tool; magpie never loads it, and the
// middleware itself takes nothing from it. moejs is the only dependency,
// pinned to an exact version, and every call into its API lives in this
// one file — an upstream rename is a one-file, dev-only fix. The pin is
// deliberately exact (no ranges) so CI measures the engine it names.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/Calcium-Ion/moejs"
)

func main() {
	file := flag.String("file", "../loop-guard.middleware.js", "the middleware source")
	casesPath := flag.String("cases", "../cases.json", "the cases to run")
	bench := flag.Bool("bench", false, "time onRequest on a large loop-shaped body instead of running cases")
	flag.Parse()

	if *bench {
		runBench(*file)
		return
	}
	os.Exit(runCases(*file, *casesPath))
}

// hook loads file as a module and returns its onRequest.
func hook(t *testing, file string) (*moejs.Runtime, moejs.Hook) {
	src, err := os.ReadFile(file)
	if err != nil {
		t.fatalf("read middleware: %v", err)
	}
	mod, err := moejs.Compile(file, string(src))
	if err != nil {
		t.fatalf("compile: %v", err)
	}
	rt := moejs.NewRuntime(moejs.Options{})
	if err := rt.SetGlobal("console", map[string]any{"log": rt.Function("log", 0, nonative),
		"warn": rt.Function("warn", 0, nonative), "error": rt.Function("error", 0, nonative)}); err != nil {
		t.fatalf("console: %v", err)
	}
	if err := rt.Load(mod); err != nil {
		t.fatalf("load: %v", err)
	}
	h, err := mod.Hook("onRequest")
	if err != nil {
		t.fatalf("hook: %v", err)
	}
	if ok, _ := rt.Has(h); !ok {
		t.fatalf("the module has no onRequest")
	}
	return rt, h
}

type testing struct {
	failed int
}

func (t *testing) fatalf(format string, args ...any) {
	fmt.Printf("✗ "+format+"\n", args...)
	os.Exit(1)
}

func nonative(*moejs.Realm, moejs.Value, []moejs.Value) (moejs.Value, error) {
	return moejs.Undefined(), nil
}

// requestCtx builds ctx the way the gateway does: the request's Info, the
// plugin's options, a state of its own, and reject.
func requestCtx(rt *moejs.Runtime, realm *moejs.Realm, info map[string]any, captured *rejectBox) (moejs.Value, error) {
	if info["options"] == nil {
		info["options"] = map[string]any{}
	}
	info["state"] = map[string]any{}
	b, err := json.Marshal(info)
	if err != nil {
		return moejs.Undefined(), err
	}
	ctx, err := rt.ParseJSON(b)
	if err != nil {
		return moejs.Undefined(), err
	}
	fn := rt.Function("reject", 2, func(_ *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
		if captured.status == 0 {
			if a := moejs.Arg(args, 0); a.IsNumber() {
				captured.status = int(a.AsNumber())
			}
			if a := moejs.Arg(args, 1); a.IsString() {
				if s, err := realm.ToString(a); err == nil {
					captured.message = s.GoString()
				}
			}
		}
		return moejs.Undefined(), nil
	})
	return ctx, realm.SetV(ctx, realm.KeyFromGoString("reject"), fn)
}

type rejectBox struct {
	status  int
	message string
}

func runCases(file, casesPath string) (code int) {
	var t testing
	rt, h := hook(&t, file)
	realm := rt.Realm()
	b, err := os.ReadFile(casesPath)
	if err != nil {
		t.fatalf("read cases: %v", err)
	}
	var cases []struct {
		Name    string         `json:"name"`
		Ctx     map[string]any `json:"ctx"`
		Options any            `json:"options"`
		Request any            `json:"request"`
		Reject  *struct {
			Status  int    `json:"status"`
			Message string `json:"message"`
		} `json:"reject"`
		ExpectLog bool `json:"expect_log"`
	}
	if err := json.Unmarshal(b, &cases); err != nil {
		t.fatalf("parse cases: %v", err)
	}
	failed := 0
	for _, c := range cases {
		captured := &rejectBox{}
		ctx, err := requestCtx(rt, realm, map[string]any{
			"protocol": "anthropic", "model": "", "stream": false, "path": "", "options": c.Options,
		}, captured)
		if err != nil {
			t.fatalf("%s: ctx: %v", c.Name, err)
		}
		for k, v := range c.Ctx {
			if err := setMember(rt, realm, ctx, k, v); err != nil {
				t.fatalf("%s: ctx.%s: %v", c.Name, k, err)
			}
		}
		bodyb, _ := json.Marshal(c.Request)
		body, err := rt.ParseJSON(bodyb)
		if err != nil {
			t.fatalf("%s: body: %v", c.Name, err)
		}
		res, err := rt.Call(h, body, ctx)
		if err != nil {
			fmt.Printf("✗ %s\n    onRequest failed: %v\n", c.Name, err)
			failed++
			continue
		}
		if !res.IsUndefined() {
			fmt.Printf("✗ %s\n    onRequest returned a value, want undefined\n", c.Name)
			failed++
			continue
		}
		var bad []string
		if c.Reject != nil {
			if captured.status == 0 {
				bad = append(bad, "expected a reject, got none")
			} else {
				if captured.status != c.Reject.Status {
					bad = append(bad, fmt.Sprintf("status %d, want %d", captured.status, c.Reject.Status))
				}
				if c.Reject.Message != "" && !strings.Contains(captured.message, c.Reject.Message) {
					bad = append(bad, fmt.Sprintf("message %q lacks %q", captured.message, c.Reject.Message))
				}
			}
		} else if captured.status != 0 {
			bad = append(bad, fmt.Sprintf("unexpected reject %d %q", captured.status, captured.message))
		}
		if len(bad) > 0 {
			fmt.Printf("✗ %s\n    %s\n", c.Name, strings.Join(bad, "; "))
			failed++
			continue
		}
		fmt.Printf("✓ %s\n", c.Name)
	}
	fmt.Printf("\n%d/%d cases pass in moejs\n", len(cases)-failed, len(cases))
	if failed > 0 {
		return 1
	}
	return 0
}

// setMember sets ctx[k] = JSON(v) so a case's protocol and model reach the
// hook as they would from the gateway.
func setMember(rt *moejs.Runtime, realm *moejs.Realm, ctx moejs.Value, key string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	val, err := rt.ParseJSON(b)
	if err != nil {
		return err
	}
	return realm.SetV(ctx, realm.KeyFromGoString(key), val)
}

// runBench times onRequest on a Claude-Code-sized body: a 40-turn tool
// loop, each reply ~2 KB with its tool result, ~130 KB of history.
func runBench(file string) {
	var t testing
	rt, h := hook(&t, file)
	realm := rt.Realm()
	turn := func(i int) map[string]any {
		return map[string]any{"role": "assistant", "content": []any{
			map[string]any{"type": "thinking", "thinking": strings.Repeat("consider the options. ", 40), "signature": "sig" + itoa(i)},
			map[string]any{"type": "tool_use", "id": "toolu_" + itoa(i), "name": "edit_file",
				"input": map[string]any{"path": "src/app.py", "old": strings.Repeat("x", 700), "new": strings.Repeat("y", 700)}}},
			"usage": map[string]any{"input_tokens": 1000 + i, "output_tokens": 500}}
	}
	result := func(i int) map[string]any {
		return map[string]any{"role": "user", "content": []any{
			map[string]any{"type": "tool_result", "tool_use_id": "toolu_" + itoa(i), "content": strings.Repeat("ok\n", 200)}},
		}
	}
	msgs := []any{map[string]any{"role": "user", "content": "fix it"}}
	for i := 0; i < 40; i++ {
		msgs = append(msgs, turn(i), result(i))
	}
	body, _ := json.Marshal(map[string]any{"model": "claude-sonnet-4", "stream": true, "messages": msgs})
	captured := &rejectBox{}
	ctx, err := requestCtx(rt, realm, map[string]any{
		"protocol": "anthropic", "model": "anthropic/claude-sonnet-4", "stream": true, "path": "",
	}, captured)
	if err != nil {
		t.fatalf("ctx: %v", err)
	}
	bodyv, err := rt.ParseJSON(body)
	if err != nil {
		t.fatalf("body: %v", err)
	}
	for i := 0; i < 10; i++ {
		if _, err := rt.Call(h, bodyv, ctx); err != nil {
			t.fatalf("call: %v", err)
		}
	}
	const n = 500
	start := time.Now()
	for i := 0; i < n; i++ {
		if _, err := rt.Call(h, bodyv, ctx); err != nil {
			t.fatalf("call: %v", err)
		}
	}
	per := time.Since(start) / n
	fmt.Printf("onRequest on a %d KB body (%d messages, active loop): %v per call (%d calls)\n",
		len(body)/1024, len(msgs), per, n)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var d []byte
	for n > 0 {
		d = append([]byte{byte('0' + n%10)}, d...)
		n /= 10
	}
	return string(d)
}
