/**
 * dsh-proactive — 模型主动跟进插件（host-level alarms for DSH agents）
 *
 * Wire-up:
 *   - host store (alarms.json / runs.jsonl / state.json) under the data dir
 *   - ProactiveScheduler drives due alarms through WakeDriver
 *   - WakeDriver resumes cold sessions (ctx.agents.resume) or reuses live
 *     agents, delivers the framed wake message, waits for the turn, and the
 *     observer derives the decision from the committed session log
 *   - proactive_* tools are registered on every root agent (agent/created),
 *     so resumed wake turns always see them
 *
 * Configuration: <dataDir>/config.json overrides defaults (see config.ts),
 * DSH_PROACTIVE_* environment variables override both.
 *
 * @care (FORK #13–#15): the plugin (cordis) config carries the guards that the
 * model cannot change (proactive_update_settings writes config.json only):
 * modelTools ('all' | 'own' | 'reclaim') and deliveryGuard ('optional' |
 * 'required'); ctx.dshProactive.setDeliveryGuard / setWakeGuard (guard.ts).
 */
import type { Context } from "@deepseek-ai/cordis";
import { type BusinessDeliveryRequest, type WakeFireResult } from "./wake.js";
import type { Alarm } from "./domain.js";
import { ProactiveGuards } from "./guard.js";
export declare const name = "dsh-proactive";
export declare const inject: string[];
/** Session-owned events from the live in-memory store (cordis augmentation not typed here). */
/**
 * @care: business-alarm IM delivery through the optional dsh-im service
 * (`ctx.dshIm.send`). The same idempotencyKey is passed on every attempt; a
 * dsh-im build without idempotency support ignores the extra option.
 */
export declare function imDelivery(ctx: Pick<Context, "get" | "logger">, guards: ProactiveGuards): (request: BusinessDeliveryRequest) => Promise<string | undefined>;
/** @care (FORK #15): run the wake guard before the driver; a skip is a plain "skipped" outcome (recorded, advanced, no retry, no budget). */
export declare function guardedRunWake(guards: ProactiveGuards, fire: (alarm: Alarm) => Promise<WakeFireResult>): (alarm: Alarm) => Promise<WakeFireResult>;
export declare function apply(ctx: Context, pluginConfig?: unknown): Promise<() => Promise<void>>;
