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
export function resolveGuardConfig(raw) {
    const input = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const modelTools = input["modelTools"] === "own" || input["modelTools"] === "reclaim" ? input["modelTools"] : "all";
    const deliveryGuard = input["deliveryGuard"] === "required" ? "required" : "optional";
    return { modelTools, deliveryGuard };
}
export function guardAlarmView(alarm) {
    return { id: alarm.id, sessionId: alarm.ownerSessionId, type: alarm.type, mode: alarm.mode ?? "companion", prompt: alarm.prompt };
}
const errorText = (error) => (error instanceof Error ? error.message : String(error));
export class ProactiveGuards {
    config;
    log;
    deliveryStack = [];
    wakeStack = [];
    constructor(config, log = () => undefined) {
        this.config = config;
        this.log = log;
    }
    setDeliveryGuard(fn) {
        if (typeof fn !== "function")
            throw new TypeError("setDeliveryGuard: fn must be a function");
        return this.push(this.deliveryStack, fn);
    }
    setWakeGuard(fn) {
        if (typeof fn !== "function")
            throw new TypeError("setWakeGuard: fn must be a function");
        return this.push(this.wakeStack, fn);
    }
    push(stack, fn) {
        stack.push(fn);
        let done = false;
        return () => {
            if (done)
                return false;
            done = true;
            const index = stack.lastIndexOf(fn);
            if (index >= 0)
                stack.splice(index, 1);
            return true;
        };
    }
    /** undefined = run the wake; a string = skip it with this reason. */
    async checkWake(alarm) {
        const guard = this.wakeStack.at(-1);
        if (guard === undefined)
            return undefined;
        try {
            const verdict = await guard({ alarm: guardAlarmView(alarm) });
            if (verdict !== null && typeof verdict === "object" && typeof verdict.skip === "string") {
                return "wake guard: " + (verdict.skip || "skipped");
            }
            return undefined;
        }
        catch (error) {
            this.log("warn", "dsh-proactive: wake guard failed for alarm " + alarm.id + " (skipped): " + errorText(error));
            return "wake guard: error";
        }
    }
    /** { text } = send this text; { deny } = do not send to this target. */
    async checkDelivery(input) {
        const guard = this.deliveryStack.at(-1);
        if (guard === undefined) {
            return this.config.deliveryGuard === "required" ? { deny: "no delivery guard is registered (deliveryGuard: required)" } : { text: input.text };
        }
        try {
            const verdict = await guard({ alarm: guardAlarmView(input.alarm), sessionId: input.sessionId, target: { ...input.target }, text: input.text, firedAt: input.firedAt });
            if (verdict !== null && typeof verdict === "object" && typeof verdict.deny === "string")
                return { deny: verdict.deny || "denied" };
            const text = verdict !== null && typeof verdict === "object" && typeof verdict.text === "string" ? verdict.text : input.text;
            return text === "" ? { deny: "empty text" } : { text };
        }
        catch (error) {
            this.log("warn", "dsh-proactive: delivery guard failed for alarm " + input.alarm.id + " (not delivered): " + errorText(error));
            return { deny: "delivery guard error" };
        }
    }
}
/** The proactive_set / proactive_update arguments a model may pass under modelTools "own" (null = allowed). */
export function ownSessionArgsError(args, ownSessionId) {
    const deliverTo = args["deliver_to"];
    if (deliverTo !== undefined && !(Array.isArray(deliverTo) && deliverTo.length === 0))
        return "deliver_to is not available to the model on this host";
    if (args["mode"] === "business")
        return "business alarms are managed by the host, not by the model";
    if (args["schedule_file"] !== undefined)
        return "schedule_file alarms are not available to the model on this host";
    if (args["target_mode"] !== undefined && args["target_mode"] !== "resume")
        return "only this conversation can be woken (target_mode resume)";
    if (args["target_source"] !== undefined && args["target_source"] !== "session")
        return "only this conversation can be woken (target_source session)";
    if (args["target_session_id"] !== undefined && args["target_session_id"] !== ownSessionId)
        return "only this conversation can be woken";
    for (const key of ["target_workspace_id", "target_workspace_path", "target_preset_id", "target_provider", "target_model"]) {
        if (args[key] !== undefined)
            return key + " is not available to the model on this host";
    }
    return null;
}
