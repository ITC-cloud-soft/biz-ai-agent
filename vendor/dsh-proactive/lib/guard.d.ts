/**
 * @care (FORK #13–#15): host-side guards for what leaves the AI.
 *
 *   - modelTools (plugin config, NOT the hot settings: the model cannot change it
 *     through proactive_update_settings): which proactive_* model tools exist.
 *       all      upstream (default)
 *       own      the caller's own session only: proactive_set / proactive_update
 *                create companion alarms resuming this session (no deliver_to,
 *                no business mode, no schedule_file, no other session /
 *                workspace / preset / new target); proactive_list never lists
 *                other sessions; proactive_cancel / proactive_update touch only
 *                this session's alarms and never a business alarm (host-managed);
 *                proactive_update_settings is refused
 *       reclaim  only proactive_reclaim (alarms are created by host plugins
 *                through ctx.dshProactive, e.g. bridge-notify's AI report)
 *   - deliveryGuard: 'optional' (default: deliver_to as upstream fork #4) |
 *     'required' (a business wake's IM push needs a registered delivery guard;
 *     none -> nothing is pushed)
 *   - ctx.dshProactive.setDeliveryGuard(fn): fn({ alarm, sessionId, target, text,
 *     firedAt }) -> { text? } (send, optionally replaced text) | { deny: reason }
 *   - ctx.dshProactive.setWakeGuard(fn): fn({ alarm }) -> { skip: reason } |
 *     anything else (run). Called before every wake (scheduled or panel "fire").
 *   A guard that throws counts as deny / skip (fail closed). The last
 *   registration wins; its disposer restores the previous one.
 */
import type { Alarm } from "./domain.js";
export type ModelToolsPolicy = "all" | "own" | "reclaim";
export type DeliveryGuardMode = "optional" | "required";
export interface GuardConfig {
    modelTools: ModelToolsPolicy;
    deliveryGuard: DeliveryGuardMode;
}
export declare function resolveGuardConfig(raw: unknown): GuardConfig;
/** The alarm fields a guard sees (no run history, no internal state). */
export interface GuardAlarmView {
    id: string;
    sessionId: string;
    type: Alarm["type"];
    mode: "companion" | "business";
    prompt: string;
}
export declare function guardAlarmView(alarm: Alarm): GuardAlarmView;
export interface DeliveryGuardInput {
    alarm: GuardAlarmView;
    /** The session the wake actually ran in. */
    sessionId: string;
    target: {
        botId: string;
        targetId: string;
    };
    text: string;
    firedAt: string;
}
export type DeliveryGuardVerdict = {
    text?: string;
} | {
    deny: string;
} | undefined | null | void;
export type DeliveryGuard = (input: DeliveryGuardInput) => DeliveryGuardVerdict | Promise<DeliveryGuardVerdict>;
export interface WakeGuardInput {
    alarm: GuardAlarmView;
}
export type WakeGuardVerdict = {
    skip: string;
} | true | undefined | null | void;
export type WakeGuard = (input: WakeGuardInput) => WakeGuardVerdict | Promise<WakeGuardVerdict>;
export declare class ProactiveGuards {
    private readonly config;
    private readonly log;
    private readonly deliveryStack;
    private readonly wakeStack;
    constructor(config: GuardConfig, log?: (level: "info" | "warn" | "error", message: string) => void);
    setDeliveryGuard(fn: DeliveryGuard): () => boolean;
    setWakeGuard(fn: WakeGuard): () => boolean;
    private push;
    /** undefined = run the wake; a string = skip it with this reason. */
    checkWake(alarm: Alarm): Promise<string | undefined>;
    /** { text } = send this text; { deny } = do not send to this target. */
    checkDelivery(input: {
        alarm: Alarm;
        sessionId: string;
        target: {
            botId: string;
            targetId: string;
        };
        text: string;
        firedAt: string;
    }): Promise<{
        text: string;
    } | {
        deny: string;
    }>;
}
/** The proactive_set / proactive_update arguments a model may pass under modelTools "own" (null = allowed). */
export declare function ownSessionArgsError(args: Record<string, unknown>, ownSessionId: string): string | null;
