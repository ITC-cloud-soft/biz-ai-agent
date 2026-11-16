/**
 * @care fork: business-mode alarms (framing, validation, persistence, tools,
 * wake-time IM delivery, unchanged quiet-hours/budget semantics), settings
 * keys, and the mount-relative client transport.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { renderFraming, FRAMING_MARKER } from "../src/framing.js";
import { buildAlarm, validateCreateArgs, type CreateSpec } from "../src/alarm-factory.js";
import { DEFAULT_BUSINESS_FRAMING, DEFAULT_BUSINESS_PROMPT, toAlarmView, type Alarm } from "../src/domain.js";
import { resolveConfig } from "../src/config.js";
import { validateSettingsPatch } from "../src/settings.js";
import { ProactiveStore } from "../src/store.js";
import { ProactiveScheduler } from "../src/scheduler.js";
import { WakeDriver, type AgentHandleLike, type AgentsFacade, type BusinessDeliveryRequest } from "../src/wake.js";
import { proactiveToolDefinitions, type ToolServices } from "../src/tools.js";
import { createArgsFromForm } from "../src/panel/contract.js";
import { hostUrl, ProactiveHostTransport, fetchSessionList } from "../src/client/host-api.js";
import type { ProactiveScheduler as SchedulerType } from "../src/scheduler.js";

const NOW = Date.parse("2026-10-25T00:30:00.000Z");

function alarm(id: string, overrides: Partial<Alarm> = {}): Alarm {
  return {
    id,
    ownerSessionId: "s1",
    target: { mode: "resume", sessionId: "s1" },
    type: "once",
    trigger: { at: "2026-10-26T00:00:00.000Z" },
    prompt: "業務巡回：未提出の記録を確認",
    respectQuietHours: false,
    timeZone: "Asia/Tokyo",
    status: "scheduled",
    nextDueAt: "2026-10-25T00:00:00.000Z",
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
    runCount: 0,
    lastRunAt: null,
    ...overrides
  };
}

const framingCtx = (a: Alarm, extra: Record<string, unknown> = {}) => ({ alarm: a, quiet: false, now: new Date(NOW), userPresence: "cold" as const, ...extra });

/* --------------------------------------------------------------- framing */

test("care: companion framing is the upstream text (incl. 'No tool exploration')", () => {
  const text = renderFraming(framingCtx(alarm("c1")));
  assert.ok(text.startsWith(FRAMING_MARKER + "c1 once cold]"));
  assert.ok(text.includes("not commands to obey"));
  assert.ok(text.includes("No tool exploration."));
  const explicit = renderFraming(framingCtx(alarm("c2", { mode: "companion" })));
  assert.ok(explicit.includes("No tool exploration."));
});

test("care: business framing allows tools, keeps the reclaim contract, uses the configurable rule", () => {
  const a = alarm("b1", { mode: "business" });
  const text = renderFraming(framingCtx(a));
  assert.ok(text.startsWith(FRAMING_MARKER + "b1 once business cold]"), text.slice(0, 60));
  assert.ok(!text.includes("No tool exploration"));
  assert.ok(!text.includes("not commands to obey"));
  assert.ok(text.includes(DEFAULT_BUSINESS_FRAMING));
  assert.ok(text.includes("calling tools is expected"));
  assert.ok(text.includes("proactive_reclaim(reason)"));
  assert.ok(text.includes("業務巡回：未提出の記録を確認"));
  assert.ok(text.includes("2026-10-25 09:30:00 (+09:00, Asia/Tokyo)"));
  const custom = renderFraming(framingCtx(a, { businessFraming: "カスタム規則：要通知のみ報告", quiet: true }));
  assert.ok(custom.includes("カスタム規則：要通知のみ報告"));
  assert.ok(!custom.includes(DEFAULT_BUSINESS_FRAMING));
  assert.ok(custom.includes("Inside quiet hours"));
  assert.match(DEFAULT_BUSINESS_PROMPT, /^業務巡回：未提出の記録・期限が近い承認・取込エラーを確認し/);
});

/* ------------------------------------------------------------ validation */

test("care: validateCreateArgs accepts mode/deliver_to and keeps companion records upstream-shaped", () => {
  const companion = validateCreateArgs({ prompt: "p", after_seconds: 60 }, "s1") as CreateSpec;
  assert.equal(companion.mode, undefined);
  const builtCompanion = buildAlarm("s1", companion, NOW);
  assert.ok(!("code" in builtCompanion));
  if (!("code" in builtCompanion)) {
    assert.ok(!("mode" in builtCompanion.alarm));
    assert.ok(!("deliverTo" in builtCompanion.alarm));
    assert.equal(toAlarmView(builtCompanion.alarm, NOW).mode, "companion");
  }
  const explicitCompanion = validateCreateArgs({ prompt: "p", after_seconds: 60, mode: "companion" }, "s1") as CreateSpec;
  assert.equal(explicitCompanion.mode, undefined);

  const spec = validateCreateArgs({
    prompt: "業務巡回", cron: "0 9 * * 1-5", time_zone: "Asia/Tokyo", mode: "business",
    deliver_to: [{ bot_id: "bot-1", target_id: "t-1" }, { botId: "bot-1", targetId: "t-1" }, { bot_id: "bot-2", target_id: "t-2" }]
  }, "s1") as CreateSpec;
  assert.equal(spec.mode, "business");
  assert.deepEqual(spec.deliverTo, [{ botId: "bot-1", targetId: "t-1" }, { botId: "bot-2", targetId: "t-2" }]);
  const built = buildAlarm("s1", spec, NOW);
  assert.ok(!("code" in built));
  if (!("code" in built)) {
    assert.equal(built.alarm.mode, "business");
    const view = toAlarmView(built.alarm, NOW);
    assert.equal(view.mode, "business");
    assert.deepEqual(view.deliverTo, [{ botId: "bot-1", targetId: "t-1" }, { botId: "bot-2", targetId: "t-2" }]);
  }

  const code = (v: unknown) => (v as { code?: string }).code;
  assert.equal(code(validateCreateArgs({ prompt: "p", after_seconds: 60, mode: "ops" }, "s1")), "invalid_trigger");
  assert.equal(code(validateCreateArgs({ prompt: "p", after_seconds: 60, deliver_to: [{ bot_id: "b", target_id: "t" }] }, "s1")), "invalid_trigger");
  assert.equal(code(validateCreateArgs({ prompt: "p", after_seconds: 60, mode: "business", deliver_to: [{ bot_id: "", target_id: "t" }] }, "s1")), "invalid_trigger");
  assert.equal(code(validateCreateArgs({ prompt: "p", after_seconds: 60, mode: "business", deliver_to: "b/t" }, "s1")), "invalid_trigger");
  // the upstream closed key set still rejects unknown keys
  assert.equal(code(validateCreateArgs({ prompt: "p", after_seconds: 60, nope: 1 }, "s1")), "invalid_trigger");
});

test("care: business alarms survive a store persist/load round trip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-care-store-"));
  try {
    const store = new ProactiveStore(dir);
    store.addAlarm(alarm("b2", { mode: "business", deliverTo: [{ botId: "bot", targetId: "t" }] }));
    store.addAlarm(alarm("c3"));
    await store.persist();
    const loaded = await ProactiveStore.load(dir);
    assert.equal(loaded.corrupt, false);
    assert.equal(loaded.store.getAlarm("b2")?.mode, "business");
    assert.deepEqual(loaded.store.getAlarm("b2")?.deliverTo, [{ botId: "bot", targetId: "t" }]);
    assert.equal(loaded.store.getAlarm("c3")?.mode, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- config */

test("care: config.json businessFraming / businessDefaultPrompt with Japanese defaults; settings keys validated", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-care-cfg-"));
  try {
    const defaults = resolveConfig(dir);
    assert.equal(defaults.businessFraming, DEFAULT_BUSINESS_FRAMING);
    assert.equal(defaults.businessDefaultPrompt, DEFAULT_BUSINESS_PROMPT);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ businessFraming: "  独自の枠組み  ", businessDefaultPrompt: "記録チェック" }));
    const custom = resolveConfig(dir);
    assert.equal(custom.businessFraming, "独自の枠組み");
    assert.equal(custom.businessDefaultPrompt, "記録チェック");
    // quiet hours / budget defaults are untouched by the fork
    assert.equal(custom.maxDeliveriesPerDay, 50);
    assert.deepEqual(custom.quietHours, { start: "23:00", end: "08:00", timeZone: "Asia/Shanghai" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const ok = validateSettingsPatch({ business_framing: "規則", business_default_prompt: "指示" });
  assert.ok(!("code" in ok));
  if (!("code" in ok)) assert.deepEqual(ok.patch, { businessFraming: "規則", businessDefaultPrompt: "指示" });
  const bad = validateSettingsPatch({ business_framing: "  " });
  assert.equal((bad as { code?: string }).code, "invalid_trigger");
});

/* ------------------------------------------------------------- panel form */

test("care: createArgsFromForm sends mode/deliver_to only when the form names them", () => {
  const base = { prompt: "p", kind: "every" as const, everySeconds: 3600, targetMode: "resume" as const, targetSource: "session" as const, targetSessionId: "s1" };
  assert.ok(!("mode" in createArgsFromForm(base)));
  assert.equal(createArgsFromForm({ ...base, mode: "companion" })["mode"], "companion");
  const args = createArgsFromForm({ ...base, mode: "business", deliverTo: [{ botId: "b", targetId: "t" }] });
  assert.equal(args["mode"], "business");
  assert.deepEqual(args["deliver_to"], [{ bot_id: "b", target_id: "t" }]);
  // companion never carries deliver_to even when the form still holds targets
  assert.ok(!("deliver_to" in createArgsFromForm({ ...base, mode: "companion", deliverTo: [{ botId: "b", targetId: "t" }] })));
  const spec = validateCreateArgs(args, "s1") as CreateSpec;
  assert.equal(spec.mode, "business");
});

/* ----------------------------------------------------------------- tools */

class FakeStore {
  corrupt = false;
  alarms: Alarm[] = [];
  listAlarms(): readonly Alarm[] { return this.alarms; }
  getAlarm(id: string): Alarm | undefined { return this.alarms.find((a) => a.id === id); }
  addAlarm(a: Alarm): void { this.alarms.push(a); }
  replaceAlarm(a: Alarm): void { const i = this.alarms.findIndex((x) => x.id === a.id); if (i >= 0) this.alarms[i] = a; }
  removeAlarm(id: string): Alarm | undefined { const i = this.alarms.findIndex((a) => a.id === id); return i < 0 ? undefined : this.alarms.splice(i, 1)[0]; }
  async persist(): Promise<void> { /* ok */ }
  async appendRun(): Promise<void> { /* ok */ }
  budgetFor(): number { return 0; }
  async spendBudget(): Promise<number> { return 0; }
}

test("care: proactive_set creates a business alarm; proactive_update carries mode/deliver_to over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-care-tools-"));
  try {
    const store = new FakeStore();
    const services: ToolServices = {
      store: store as unknown as ProactiveStore,
      config: resolveConfig(dir),
      driver: { isActiveWake: () => false } as unknown as WakeDriver,
      scheduler: { requestDrive: () => undefined } as unknown as SchedulerType,
      now: () => NOW
    };
    const agent = { session: { id: "s1", header: { cwd: "/work" } }, ctx: { get: () => undefined } } as unknown as Agent;
    const defs = Object.fromEntries(proactiveToolDefinitions(agent, services).map((d) => [d.name, d]));
    const exec = { agent, concludeTurn: () => undefined } as unknown as ToolRunContext;
    const created = await defs["proactive_set"]!.execute({
      prompt: "業務巡回", every_seconds: 3600, time_zone: "Asia/Tokyo", mode: "business",
      deliver_to: [{ bot_id: "bot-1", target_id: "t-1" }]
    }, exec) as { id: string; mode: string; deliverTo: unknown };
    assert.equal(created.mode, "business");
    assert.deepEqual(created.deliverTo, [{ botId: "bot-1", targetId: "t-1" }]);
    const updated = await defs["proactive_update"]!.execute({ id: created.id, prompt: "業務巡回（更新）", every_seconds: 7200, time_zone: "Asia/Tokyo" }, exec) as { mode: string; everySeconds: number };
    assert.equal(updated.mode, "business");
    assert.equal(updated.everySeconds, 7200);
    assert.deepEqual(store.getAlarm(created.id)?.deliverTo, [{ botId: "bot-1", targetId: "t-1" }]);
    const back = await defs["proactive_update"]!.execute({ id: created.id, prompt: "p", every_seconds: 7200, mode: "companion" }, exec) as { mode: string; deliverTo?: unknown };
    assert.equal(back.mode, "companion");
    assert.equal(back.deliverTo, undefined);
    const listed = await defs["proactive_list"]!.execute({}, exec) as Array<{ mode: string }>;
    assert.equal(listed[0]?.mode, "companion");
    const settings = await defs["proactive_update_settings"]!.execute({ business_framing: "新しい規則" }, exec) as { business_framing: string; business_default_prompt: string };
    assert.equal(settings.business_framing, "新しい規則");
    assert.equal(settings.business_default_prompt, DEFAULT_BUSINESS_PROMPT);
    assert.equal(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).businessFraming, "新しい規則");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ wake */

function wakeHarness(replyText: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-care-wake-"));
  const cfg = resolveConfig(dir);
  cfg.businessFraming = "テスト用の業務規則";
  const store = new ProactiveStore(dir);
  const messages: unknown[] = [];
  const events: Record<string, unknown>[] = [];
  const agent = {
    session: { id: "s1", events, get seq() { return events.length; } },
    followup: (message: unknown) => {
      messages.push(message);
      events.push({ type: "turn/start", data: { turn: 1 } });
      if (replyText !== null) events.push({ type: "assistant/message", data: { text: replyText } });
      else events.push({ type: "tool/call", data: { turn: 1, step: 1, callId: "c1", name: "proactive_reclaim", arguments: "{\"reason\":\"no findings\"}" } });
      events.push({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    },
    runMaintenance: async (task: () => Promise<unknown>) => { await task(); return true; },
    whenIdle: async () => undefined
  } as unknown as Agent;
  const agents: AgentsFacade = {
    get: () => undefined,
    resume: async () => ({ agent, dispose: async () => undefined } as AgentHandleLike),
    create: async () => { throw new Error("unused"); }
  };
  const deliveries: BusinessDeliveryRequest[] = [];
  const driver = new WakeDriver({
    agents,
    modelSelection: () => ({ provider: "test", model: "x" }),
    store,
    config: cfg,
    log: () => undefined,
    now: () => NOW,
    deliver: async (request) => { deliveries.push(request); return "im: " + (request.alarm.deliverTo?.length ?? 0) + "/" + (request.alarm.deliverTo?.length ?? 0) + " delivered"; }
  });
  return { dir, driver, messages, deliveries };
}

function textOf(message: unknown): string {
  return ((message as { content?: { text?: string }[] }).content ?? []).map((b) => b.text ?? "").join("");
}

test("care: a business 'reply' wake pushes the full reply to deliverTo with a per-fire idempotency key", async () => {
  const long = "承認期限が近い案件が 2 件あります。" + "詳細".repeat(150);
  const h = wakeHarness(long);
  try {
    const a = alarm("b3", { mode: "business", deliverTo: [{ botId: "bot", targetId: "t" }] });
    const fire = await h.driver.fire(a);
    assert.equal(fire.outcome, "ok");
    if (fire.outcome === "ok") {
      assert.equal(fire.analysis.decision, "reply");
      assert.equal(fire.analysis.budgetDelta, 1); // budget accounting unchanged
      assert.equal(fire.analysis.note, "im: 1/1 delivered");
      assert.ok((fire.analysis.replySummary ?? "").length <= 201); // history stays truncated
    }
    const framing = textOf(h.messages[0]);
    assert.ok(framing.includes("テスト用の業務規則"), "configured business framing reaches the wake");
    assert.ok(!framing.includes("No tool exploration"));
    assert.equal(h.deliveries.length, 1);
    assert.equal(h.deliveries[0]!.text, long);
    assert.equal(h.deliveries[0]!.idempotencyKey, "proactive:b3:" + new Date(NOW).toISOString());
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("care: silent business wakes and companion replies never deliver", async () => {
  const silent = wakeHarness(null);
  try {
    const fire = await silent.driver.fire(alarm("b4", { mode: "business", deliverTo: [{ botId: "bot", targetId: "t" }] }));
    assert.equal(fire.outcome === "ok" ? fire.analysis.decision : fire.outcome, "no_reply");
    assert.equal(silent.deliveries.length, 0);
  } finally {
    rmSync(silent.dir, { recursive: true, force: true });
  }
  const companion = wakeHarness("hello");
  try {
    const fire = await companion.driver.fire(alarm("c4", { deliverTo: [{ botId: "bot", targetId: "t" }] }));
    assert.equal(fire.outcome === "ok" ? fire.analysis.decision : fire.outcome, "reply");
    assert.equal(companion.deliveries.length, 0);
    assert.ok(textOf(companion.messages[0]).includes("No tool exploration"));
  } finally {
    rmSync(companion.dir, { recursive: true, force: true });
  }
});

test("care: activeWake(sessionId) names the alarm only while its wake turn runs (business and companion)", async () => {
  for (const mode of ["business", "companion"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-care-active-"));
    try {
      const cfg = resolveConfig(dir);
      const store = new ProactiveStore(dir);
      const events: Record<string, unknown>[] = [];
      const seen: unknown[] = [];
      let driver: WakeDriver | undefined;
      const agent = {
        session: { id: "s1", events, get seq() { return events.length; } },
        followup: () => {
          seen.push(driver?.activeWake("s1"), driver?.activeWake("other"));
          events.push({ type: "turn/start", data: { turn: 1 } });
          events.push({ type: "assistant/message", data: { text: "報告です" } });
          events.push({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
        },
        runMaintenance: async (task: () => Promise<unknown>) => { await task(); return true; },
        whenIdle: async () => { seen.push(driver?.activeWake("s1")?.alarmId); }
      } as unknown as Agent;
      const agents: AgentsFacade = {
        get: () => undefined,
        resume: async () => ({ agent, dispose: async () => undefined } as AgentHandleLike),
        create: async () => { throw new Error("unused"); }
      };
      driver = new WakeDriver({ agents, modelSelection: () => ({ provider: "test", model: "x" }), store, config: cfg, log: () => undefined, now: () => NOW });
      assert.equal(driver.activeWake("s1"), undefined);
      const a = alarm("w1", mode === "business" ? { mode: "business" } : {});
      const fire = await driver.fire(a);
      assert.equal(fire.outcome, "ok");
      assert.deepEqual(seen[0], { alarmId: "w1", mode, firedAt: new Date(NOW).toISOString() });
      assert.equal(seen[1], undefined, "other sessions are not marked");
      assert.equal(seen[2], "w1", "still marked until the turn is idle");
      assert.equal(driver.activeWake("s1"), undefined, "cleared after the turn");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("care: a busy session (maintenance refused) leaves no activeWake behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-care-busy-"));
  try {
    const cfg = resolveConfig(dir);
    const store = new ProactiveStore(dir);
    const agent = {
      session: { id: "s1", events: [], get seq() { return 0; } },
      followup: () => undefined,
      runMaintenance: async () => { throw new Error("busy"); },
      whenIdle: async () => undefined
    } as unknown as Agent;
    const agents: AgentsFacade = {
      get: () => undefined,
      resume: async () => ({ agent, dispose: async () => undefined } as AgentHandleLike),
      create: async () => { throw new Error("unused"); }
    };
    const driver = new WakeDriver({ agents, modelSelection: () => ({ provider: "test", model: "x" }), store, config: cfg, log: () => undefined, now: () => NOW });
    const fire = await driver.fire(alarm("w2", { mode: "business" }));
    assert.equal(fire.outcome, "busy");
    assert.equal(driver.activeWake("s1"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------- quiet hours / budget gates */

test("care: quiet hours and the daily budget gate business alarms exactly like companion alarms", async (tctx) => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-care-sched-"));
  const config = resolveConfig(dir);
  config.quietHours = { start: "00:00", end: "23:59", timeZone: "UTC" };
  const store = new ProactiveStore(dir);
  const fired: Alarm[] = [];
  const scheduler = new ProactiveScheduler({
    store,
    config,
    runWake: async (a) => { fired.push(a); return { outcome: "ok", analysis: { decision: "no_reply", budgetDelta: 0 } }; },
    now: () => Date.parse("2026-10-25T09:00:00.000Z"),
    log: () => undefined
  });
  tctx.after(async () => {
    scheduler.stop();
    await new Promise((r) => setTimeout(r, 50));
    rmSync(dir, { recursive: true, force: true });
  });
  store.addAlarm(alarm("bq", { mode: "business", respectQuietHours: true }));
  store.addAlarm(alarm("bu", { mode: "business", respectQuietHours: false }));
  scheduler.start();
  for (let i = 0; i < 50 && !(fired.length >= 1 && store.getAlarm("bq")?.runCount === 1); i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(fired.map((a) => a.id), ["bu"]); // quiet-respecting business alarm dropped inside the window
  assert.equal(store.getAlarm("bq")?.status, "completed");
  const runs = readFileSync(join(dir, "runs.jsonl"), "utf8");
  assert.match(runs, /quiet hours: once alarm due inside the quiet window is dropped/);
});

/* --------------------------------------------------------- client transport */

test("care: client transport resolves every URL against document.baseURI (sub-path safe)", async () => {
  const g = globalThis as unknown as { document?: unknown; fetch: typeof fetch; EventSource?: unknown };
  const oldDocument = g.document;
  const oldFetch = g.fetch;
  const oldEventSource = g.EventSource;
  const urls: string[] = [];
  g.document = { baseURI: "http://127.0.0.1:3010/dsh/" };
  g.fetch = (async (url: string) => {
    urls.push(String(url));
    if (String(url).includes("session/list")) {
      return { ok: true, json: async () => ({ type: "server-response", result: { ok: true, value: { items: [{ sessionId: "s1", projections: { values: { title: "T" } } }] } } }) };
    }
    return { ok: true, json: async () => ({ server: { now: "", dataDir: "", corrupt: false }, config: {}, alarms: [], runs: [] }) };
  }) as unknown as typeof fetch;
  class FakeEventSource {
    static last = "";
    onmessage: unknown; onopen: unknown; onerror: unknown;
    constructor(url: string) { FakeEventSource.last = url; }
    addEventListener(): void { /* noop */ }
    close(): void { /* noop */ }
  }
  g.EventSource = FakeEventSource;
  try {
    assert.equal(hostUrl("api/dsh-proactive/state"), "http://127.0.0.1:3010/dsh/api/dsh-proactive/state");
    const transport = new ProactiveHostTransport();
    await transport.state("s1");
    await transport.action({ kind: "toggle", id: "a" });
    const sessions = await fetchSessionList();
    assert.equal(sessions[0]?.title, "T");
    transport.subscribe(() => undefined)();
    assert.deepEqual(urls, [
      "http://127.0.0.1:3010/dsh/api/dsh-proactive/state?session=s1",
      "http://127.0.0.1:3010/dsh/api/dsh-proactive/action",
      "http://127.0.0.1:3010/dsh/api/session/list"
    ]);
    assert.equal(FakeEventSource.last, "http://127.0.0.1:3010/dsh/api/dsh-proactive/events");
    // direct (root-mounted) access resolves to the same absolute paths as upstream
    g.document = { baseURI: "http://127.0.0.1:3182/" };
    assert.equal(hostUrl("api/dsh-proactive/state"), "http://127.0.0.1:3182/api/dsh-proactive/state");
  } finally {
    g.document = oldDocument;
    g.fetch = oldFetch;
    g.EventSource = oldEventSource;
  }
});

test("care: built client bundle carries the scoped ModuleLoader id and no absolute plugin URLs", () => {
  let code: string;
  try {
    code = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  } catch {
    return; // lib not built yet (tsc-only run); `npm run build` precedes CI
  }
  assert.ok(code.includes("id: \"@care/dsh-proactive\""));
  assert.ok(!code.includes("\"/api/dsh-proactive"));
  assert.ok(!code.includes("\"/api/session/list\""));
});

/* ------------------------------------------------------------------ i18n */

test("care: use-locale renders non-zh/en locales through locale.bind (ja via @care/dsh-lang-ja)", async () => {
  const { bindProactiveLocale, proactiveCopySnapshot } = await import("../src/client/use-locale.js");
  const { zh, en } = await import("../src/client/locales.js");
  let state = { active: "zh", revision: 1 };
  const face = { getSnapshot: () => state, subscribe: () => () => undefined };
  const calls: string[] = [];
  bindProactiveLocale(face, (key) => { calls.push(key); return key === "tabLabel" ? "プロアクティブ通知" : "en:" + key; });
  assert.equal(proactiveCopySnapshot(), zh);
  state = { active: "en", revision: 2 };
  assert.equal(proactiveCopySnapshot(), en);
  state = { active: "ja", revision: 3 };
  const ja = proactiveCopySnapshot();
  assert.equal(ja.tabLabel, "プロアクティブ通知");
  assert.equal(ja.modeBusiness, "en:modeBusiness"); // fork keys fall back along the registry chain
  assert.equal(proactiveCopySnapshot(), ja, "memoized per revision");
  state = { active: "ja", revision: 4 };
  assert.notEqual(proactiveCopySnapshot(), ja);
  bindProactiveLocale(face); // no translator → en for foreign locales (never zh)
  assert.equal(proactiveCopySnapshot(), en);
  assert.ok(calls.includes("tabLabel"));
});
