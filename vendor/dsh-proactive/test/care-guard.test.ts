/**
 * @care fork #13–#15 (N1b): model-tool policy (all / own / reclaim), the IM
 * delivery guard of business wakes, and the wake guard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { Alarm } from "../src/domain.js";
import { resolveConfig } from "../src/config.js";
import type { ProactiveStore } from "../src/store.js";
import type { ProactiveScheduler } from "../src/scheduler.js";
import type { BusinessDeliveryRequest, WakeDriver, WakeFireResult } from "../src/wake.js";
import { proactiveToolDefinitions, type ToolServices } from "../src/tools.js";
import { ProactiveGuards, ownSessionArgsError, resolveGuardConfig } from "../src/guard.js";
import { guardedRunWake, imDelivery } from "../src/index.js";

const NOW = Date.parse("2026-10-25T00:30:00.000Z");

function alarm(id: string, overrides: Partial<Alarm> = {}): Alarm {
  return {
    id,
    ownerSessionId: "s1",
    target: { mode: "resume", sessionId: "s1" },
    type: "once",
    trigger: { at: "2026-10-26T00:00:00.000Z" },
    prompt: "remind me",
    respectQuietHours: false,
    timeZone: "Asia/Tokyo",
    status: "scheduled",
    nextDueAt: "2026-10-26T00:00:00.000Z",
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
    runCount: 0,
    lastRunAt: null,
    ...overrides
  };
}

class FakeStore {
  corrupt = false;
  alarms: Alarm[] = [];
  listAlarms(): readonly Alarm[] { return this.alarms; }
  getAlarm(id: string): Alarm | undefined { return this.alarms.find((a) => a.id === id); }
  addAlarm(a: Alarm): void { this.alarms.push(a); }
  replaceAlarm(a: Alarm): void { const i = this.alarms.findIndex((x) => x.id === a.id); if (i >= 0) this.alarms[i] = a; }
  removeAlarm(id: string): Alarm | undefined { const i = this.alarms.findIndex((a) => a.id === id); return i < 0 ? undefined : this.alarms.splice(i, 1)[0]; }
  async persist(): Promise<void> { /* ok */ }
}

function toolsFor(policy: ToolServices["policy"], dir: string, store = new FakeStore()) {
  const services: ToolServices = {
    store: store as unknown as ProactiveStore,
    config: resolveConfig(dir),
    driver: { isActiveWake: () => true } as unknown as WakeDriver,
    scheduler: { requestDrive: () => undefined } as unknown as ProactiveScheduler,
    now: () => NOW,
    ...(policy !== undefined ? { policy } : {})
  };
  const agent = { session: { id: "s1", header: { cwd: "/work" } }, ctx: { get: () => undefined } } as unknown as Agent;
  const defs = Object.fromEntries(proactiveToolDefinitions(agent, services).map((d) => [d.name, d]));
  const exec = { agent, concludeTurn: () => undefined } as unknown as ToolRunContext;
  return { defs, exec, store };
}

test("care #13: resolveGuardConfig defaults to upstream (all / optional) and accepts own / reclaim / required only", () => {
  assert.deepEqual(resolveGuardConfig(undefined), { modelTools: "all", deliveryGuard: "optional" });
  assert.deepEqual(resolveGuardConfig({ modelTools: "reclaim", deliveryGuard: "required" }), { modelTools: "reclaim", deliveryGuard: "required" });
  assert.deepEqual(resolveGuardConfig({ modelTools: "own" }), { modelTools: "own", deliveryGuard: "optional" });
  assert.deepEqual(resolveGuardConfig({ modelTools: "everything", deliveryGuard: "yes" }), { modelTools: "all", deliveryGuard: "optional" });
});

test("care #13: modelTools reclaim registers proactive_reclaim only; all keeps the six tools", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-guard-"));
  try {
    assert.deepEqual(Object.keys(toolsFor("reclaim", dir).defs), ["proactive_reclaim"]);
    assert.equal(Object.keys(toolsFor(undefined, dir).defs).length, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("care #13: modelTools own — this session's companion alarms only; no deliver_to / business / other targets / settings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-guard-"));
  try {
    const store = new FakeStore();
    store.addAlarm(alarm("other", { ownerSessionId: "s2", target: { mode: "resume", sessionId: "s2" } }));
    store.addAlarm(alarm("report", { mode: "business", prompt: "【定時業務報告】…", deliverTo: [{ botId: "b", targetId: "t" }] }));
    const { defs, exec } = toolsFor("own", dir, store);
    const base = { prompt: "remind me", after_seconds: 600 };
    for (const extra of [
      { deliver_to: [{ bot_id: "bot-x", target_id: "someone-else" }] },
      { mode: "business" },
      { target_mode: "new" },
      { target_session_id: "s2" },
      { target_preset_id: "care-billing" },
      { schedule_file: "C:/x.json" }
    ]) {
      const out = await defs["proactive_set"]!.execute({ ...base, ...extra }, exec) as { code?: string };
      assert.equal(out.code, "invalid_action", JSON.stringify(extra));
    }
    const created = await defs["proactive_set"]!.execute({ ...base, deliver_to: [] }, exec) as { id: string; sessionId: string; mode: string };
    assert.equal(created.sessionId, "s1");
    assert.equal(created.mode, "companion");
    // list never shows other sessions (all=true is ignored)
    const listed = await defs["proactive_list"]!.execute({ all: true }, exec) as Array<{ id: string }>;
    assert.deepEqual(listed.map((a) => a.id).sort(), [created.id, "report"].sort());
    // cancel / update: another session's alarm does not exist for this caller; the host's business alarm is not touchable
    assert.equal((await defs["proactive_cancel"]!.execute({ id: "other" }, exec) as { code: string }).code, "not_found");
    assert.equal((await defs["proactive_update"]!.execute({ id: "other", ...base }, exec) as { code: string }).code, "not_found");
    assert.equal((await defs["proactive_cancel"]!.execute({ id: "report" }, exec) as { code: string }).code, "invalid_action");
    assert.equal((await defs["proactive_update"]!.execute({ id: "report", ...base }, exec) as { code: string }).code, "invalid_action");
    assert.equal((await defs["proactive_update"]!.execute({ id: created.id, ...base, target_session_id: "s2" }, exec) as { code: string }).code, "invalid_action");
    assert.ok(store.getAlarm("other") !== undefined && store.getAlarm("report") !== undefined);
    // own companion alarm: editable and cancellable
    const updated = await defs["proactive_update"]!.execute({ id: created.id, prompt: "later", after_seconds: 1200 }, exec) as { prompt: string };
    assert.equal(updated.prompt, "later");
    assert.deepEqual(await defs["proactive_cancel"]!.execute({ id: created.id }, exec), { id: created.id, cancelled: true });
    // settings are the operator's
    assert.equal((await defs["proactive_update_settings"]!.execute({ business_framing: "x" }, exec) as { code: string }).code, "invalid_action");
    assert.equal(ownSessionArgsError({ target_mode: "resume", target_session_id: "s1" }, "s1"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function deliveryRequest(overrides: Partial<Alarm> = {}): BusinessDeliveryRequest {
  return {
    alarm: alarm("b1", { mode: "business", prompt: "【定時業務報告】…", deliverTo: [{ botId: "bot", targetId: "own" }, { botId: "bot", targetId: "stranger" }], ...overrides }),
    text: "AI の本文",
    firedAt: new Date(NOW).toISOString(),
    sessionId: "s1",
    idempotencyKey: "proactive:b1:" + new Date(NOW).toISOString()
  };
}

function fakeIm() {
  const sent: Array<{ botId: string; targetId: string; text: string; options: unknown }> = [];
  const ctx = {
    get: (name: string) => (name === "dshIm" ? { send: async (botId: string, targetId: string, text: string, options: unknown) => { sent.push({ botId, targetId, text, options }); return { sent: true }; } } : undefined),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined }
  } as unknown as Parameters<typeof imDelivery>[0];
  return { ctx, sent };
}

test("care #14: the delivery guard decides per target and may replace the text; deliveryGuard required fails closed", async () => {
  // optional + no guard: upstream fork #4 behaviour
  const open = fakeIm();
  assert.equal(await imDelivery(open.ctx, new ProactiveGuards(resolveGuardConfig({})))(deliveryRequest()), "im: 2/2 delivered");
  assert.equal(open.sent.length, 2);
  // required + no guard: nothing is pushed
  const closed = fakeIm();
  const note = await imDelivery(closed.ctx, new ProactiveGuards(resolveGuardConfig({ deliveryGuard: "required" })))(deliveryRequest());
  assert.equal(note, "im: 0/2 delivered (2 refused by the delivery guard)");
  assert.equal(closed.sent.length, 0);
  // a guard: only the owner's own target, with the screened text
  const guarded = fakeIm();
  const guards = new ProactiveGuards(resolveGuardConfig({ deliveryGuard: "required" }));
  const seen: unknown[] = [];
  const dispose = guards.setDeliveryGuard((input) => {
    seen.push(input);
    return input.target.targetId === "own" ? { text: "【定時のご報告】固定の文面" } : { deny: "not the owner's 1:1 target" };
  });
  assert.equal(await imDelivery(guarded.ctx, guards)(deliveryRequest()), "im: 1/2 delivered (1 refused by the delivery guard)");
  assert.deepEqual(guarded.sent.map((s) => [s.targetId, s.text]), [["own", "【定時のご報告】固定の文面"]]);
  assert.deepEqual((seen[0] as { alarm: unknown }).alarm, { id: "b1", sessionId: "s1", type: "once", mode: "business", prompt: "【定時業務報告】…" });
  // a throwing guard is a refusal; dispose restores the previous state (required + none)
  guards.setDeliveryGuard(() => { throw new Error("boom"); });
  const failing = fakeIm();
  assert.match(await imDelivery(failing.ctx, guards)(deliveryRequest()) ?? "", /0\/2 delivered/);
  assert.equal(failing.sent.length, 0);
  assert.equal(dispose(), true);
  assert.equal(dispose(), false);
});

test("care #15: the wake guard skips before the driver runs; errors skip (fail closed); no guard = run", async () => {
  const guards = new ProactiveGuards(resolveGuardConfig({}));
  const fired: string[] = [];
  const fire = async (a: Alarm): Promise<WakeFireResult> => { fired.push(a.id); return { outcome: "busy" }; };
  const run = guardedRunWake(guards, fire);
  assert.deepEqual(await run(alarm("a1")), { outcome: "busy" });
  const off = guards.setWakeGuard(({ alarm: a }) => (a.mode === "business" ? { skip: "owner is no longer eligible" } : undefined));
  assert.deepEqual(await run(alarm("a2", { mode: "business" })), { outcome: "skipped", skipReason: "wake guard: owner is no longer eligible" });
  assert.deepEqual(await run(alarm("a3")), { outcome: "busy" });
  guards.setWakeGuard(() => { throw new Error("care-api down"); });
  assert.deepEqual(await run(alarm("a4")), { outcome: "skipped", skipReason: "wake guard: error" });
  assert.deepEqual(fired, ["a1", "a3"]);
  off();
});
