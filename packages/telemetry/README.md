# @dsh-bridge/telemetry

The log format of a business system on the DSH Business Bridge (`docs/RSI_SELF_IMPROVING_SYSTEM.md` §5.1). It has no dependencies, and it does no I/O except through the `write` function you pass.

| Part | What it does |
|---|---|
| `createLogger({ app, service, version, env, level, write })` | Writes one JSON line per event with `ts level app service version env kind trace_id span_id request_id tenant_id actor event msg http err attrs pii`. It masks by default and never throws. `child(bindings)` takes an object or a function, and a function is read when the line is written. `security(event, fields)` writes a `kind: security` line that keeps the raw `ip` and marks it `pii: restricted`. `console()` is an adapter for legacy `log.error('[x] text', error)` calls. |
| `mask` | Masks values in two layers. The first replaces the values of sensitive keys (`name`, `email`, `phone`, `note`, `body`, `password`, `token`, `account_number`, `insured_number`, `my_number` …). The second replaces values by shape: e-mail, phone, runs of 7 or more digits, JWT, bearer tokens and `?token=`. `maskMessage` also drops quoted values, including PostgreSQL's `Key (col)=(value)`. Changes to these lists are class A2: a human decides. |
| `trace` | Implements W3C traceparent in and out. A UUID `x-request-id` (Caddy's `{http.request.uuid}`) becomes the trace id. `runWithTrace` / `currentTrace` use AsyncLocalStorage, so an outbox row, an ai_event or an audit row written during a request can record its trace. `traceFromStored` continues that trace in a worker. |
| `fingerprint` | `errorFields(err, { service, route })` returns `{ kind, code, constraint, table, message (masked), frames, fingerprint }`. The same cause gives the same 16-hex fingerprint. pg's `detail` / `where` / parameters are never copied. |
| `http` | `instrumentRequest(req, res, { logger, trustForwarded, skip, stats })` reads the trace from the incoming request and sets `x-request-id` on the response. When the response ends, it writes one `kind: access` line with the route template the handler set (never the raw path), the status, the duration, an IP hash and the IP /24. 404s and health checks are only counted. |

Rules for callers:

- Put IDs, counts, codes and durations in `attrs`. Never put names or free text there.
- Keep `msg` short and constant. Values go in `attrs`.
- Name events `domain.action[.result]`, for example `http.request`, `auth.login.failed`, `outbox.event.gave_up`.

The first user is care-ai-native. Its design is in `docs/design/LOGGING_MONITORING_RSI.md`.
