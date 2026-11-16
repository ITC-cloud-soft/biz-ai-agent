/**
 * Locale hook for the Proactive surfaces. Bound to the live locale service by
 * the client mount (index.ts); falls back to zh whenever the service is
 * absent. Re-renders on locale switches.
 *
 * @care fork (from plugins/dsh-lang-ja/fork-resources/dsh-proactive/use-locale.ts):
 * upstream 0.3.1 returned the module-local zh object for every non-en locale,
 * so with a language pack active (ja from @care/dsh-lang-ja) the panel body
 * rendered in Chinese and the pack's `dsh-proactive` dictionary was never read.
 * Now zh / en keep the built-in objects, and any other active locale builds
 * the copy through the DSH locale registry (`ctx.locale.bind(NS)`), whose
 * lookup walks that language's fallback chain (ja → en) per key. The object is
 * memoized per snapshot revision so useSyncExternalStore sees a stable value.
 * This fork registers only zh / en; ja is registered by @care/dsh-lang-ja
 * (a second (namespace, locale) registration throws).
 *
 * The active language is derived from the live service on EVERY snapshot
 * read — never cached at bind time (the page can boot in the fallback locale
 * before the persisted preference arrives).
 */

import { useSyncExternalStore } from "react";
import { zh, en, type ProactivePanelCopy } from "./locales.js";

interface LocaleFaceLike {
  getSnapshot(): { active: string; revision?: number };
  subscribe(fn: () => void): () => void;
}

type Translate = (key: string) => string;

let bound: LocaleFaceLike | null = null;
let translate: Translate | null = null;
const listeners = new Set<() => void>();
let memo: { revision: number | undefined; active: string; copy: ProactivePanelCopy } | null = null;

/** Called by the client mount to bind the live locale service (idempotent). */
export function bindProactiveLocale(face: LocaleFaceLike, t?: Translate): void {
  bound = face;
  translate = t ?? null;
  memo = null;
  // A panel may already be mounted — wake every listener so it re-reads.
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const unsubscribe = bound?.subscribe(fn);
  return () => {
    listeners.delete(fn);
    unsubscribe?.();
  };
}

/** Exported for tests: the copy object for the current snapshot. */
export function proactiveCopySnapshot(): ProactivePanelCopy {
  const snapshot = bound?.getSnapshot();
  const active = typeof snapshot?.active === "string" ? snapshot.active : "zh";
  if (active === "zh" || active.startsWith("zh-")) return zh;
  if (active === "en" || active.startsWith("en-")) return en;
  if (translate === null || snapshot === undefined) return en;
  if (memo !== null && memo.revision === snapshot.revision && memo.active === active) return memo.copy;
  const t = translate;
  const copy = Object.fromEntries(Object.keys(en).map((key) => [key, t(key)])) as unknown as ProactivePanelCopy;
  memo = { revision: snapshot.revision, active, copy };
  return copy;
}

/** Copy for the current UI language; re-renders when the language changes. */
export function useProactiveLocale(): ProactivePanelCopy {
  return useSyncExternalStore(subscribe, proactiveCopySnapshot, proactiveCopySnapshot);
}
