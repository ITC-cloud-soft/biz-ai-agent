# The `knowledge` capability (Bridge v1, optional) — week 1 interface

Status: implemented here as an add-on (`@dsh-bridge/knowledge` + `bridge-knowledge`), with **no change to the framework**. To become
part of Bridge v1 it needs the upstream changes at the end of this page.

## The rule

> A search never returns a chunk its asker may not read, and never tells that one exists.

The **asker** is one employee: their own web session, or the AI acting as them through a **delegation**. Visibility is the business
system's decision, made on every call. The AI plane keeps no index.

## Route

`GET /bridge/v1/knowledge/search?q=<question>&limit=<1–5>`

| principal | answer |
|---|---|
| nothing valid | 401 `authentication_required` |
| `x-service-token` alone (no employee) | 403 `human_required` (no public knowledge in the MVP) |
| employee (web session), any declared role | 200: the chunks this employee may read |
| delegation (`x-service-token` + `x-delegation-token`) | 200 when the manifest declares a read tool on `GET /bridge/v1/knowledge/search` for the employee's role, otherwise 403 `delegation_not_permitted` (delegation × role, the same `readToolPolicy` as every business read tool) |
| `q` missing / `limit` not 1–5 | 400 `q_required` / `invalid_limit` |

```jsonc
// 200
{
  "ok": true,
  "query": "how many consecutive days can a manager approve",
  "found": true,
  "results": [
    {
      "id": "leave-policy:5:0",                 // chunk id: <document>:<section>:<chunk>
      "documentId": "leave-policy",
      "title": "Leave policy",
      "heading": "Approval rules for managers",
      "text": "A manager may approve up to 10 consecutive working days. …",   // ≤ 600 characters
      "source": { "title": "Leave policy › Approval rules for managers", "url": "https://leave.example.com/handbook/leave-policy#approval-rules" },
      "score": 5.8
    }
  ]
}
```

The answer to an asker who may not read the matching chunks is the same as the answer to a question nobody can answer:
`{ ok: true, query, found: false, results: [] }`. It has no counts, no "hidden" flag, and the scores do not depend on hidden chunks.

## Visibility model

- Document: `visibility: { roles?: [role…], users?: [employeeId…] }`. At least one entry is required. Roles must be declared in the
  manifest.
- Section: may narrow the visibility (`roles` ⊆ the document's roles, `users` ⊆ the document's users). Naming either replaces both
  grants.
- `canSee(chunk, asker) = asker.role ∈ roles ∨ asker.id ∈ users`.
- `users` covers "scope own": a document for one employee, which even managers do not get.
- Links are screen paths of the business web. When the manifest declares `web.routes`, each link must match one of them, so the
  link guard of bridge-identity keeps it.

## Personal data

No chunk enters the index before passing the local shape check (e-mail, phone, long number) **and** `bridgePiiScreen`, the same
check as `POST /bridge/v1/pii-scan` (the protocol's shapes plus the business system's own `hooks.piiScan`, the check bridge-memory
uses). By default the build fails, naming chunk IDs and kinds but never the text. A failing hook fails the build.

## Optional semantic retrieval (week 3)

An embedder chosen by the system owner (`{ id, embed(texts) }`; `httpEmbedder` for OpenAI-compatible endpoints) adds a vector
ranking that is fused with BM25F by RRF. It compares only the asker's visible chunks, so the rule above holds unchanged; the answer
keeps the same shape (`score` is then the RRF score × 100). Without an embedder, nothing changes.

## OpenAPI fragment

```yaml
paths:
  /bridge/v1/knowledge/search:
    get:
      operationId: knowledgeSearch
      summary: Permission-aware search of the business system's documents (optional capability)
      security: [{ session: [] }, { serviceToken: [], delegationToken: [] }]
      parameters:
        - { name: q, in: query, required: true, schema: { type: string, minLength: 1, maxLength: 200 } }
        - { name: limit, in: query, required: false, schema: { type: integer, minimum: 1, maximum: 5, default: 3 } }
      responses:
        '200':
          description: The chunks the asking employee may read (possibly none)
          content:
            application/json:
              schema:
                type: object
                additionalProperties: false
                required: [ok, query, found, results]
                properties:
                  ok: { const: true }
                  query: { type: string }
                  found: { type: boolean }
                  results:
                    type: array
                    maxItems: 5
                    items:
                      type: object
                      additionalProperties: false
                      required: [id, documentId, title, heading, text, source, score]
                      properties:
                        id: { type: string }
                        documentId: { type: string, pattern: '^[a-z0-9][a-z0-9-]{0,62}$' }
                        title: { type: string }
                        heading: { type: [string, 'null'] }
                        text: { type: string, maxLength: 601 }
                        source:
                          type: object
                          additionalProperties: false
                          required: [title, url]
                          properties: { title: { type: string }, url: { type: string } }
                        score: { type: number }
        '400': { $ref: '#/components/responses/Error' }
        '401': { $ref: '#/components/responses/Error' }
        '403': { $ref: '#/components/responses/Error' }
```

## Conformance checks (`@dsh-bridge/knowledge/conformance`)

| id | check |
|---|---|
| K-01 | no credentials → 401 |
| K-02 | the service principal alone → 403 |
| K-03 | `q` missing → 400 `q_required`; `limit` 0 / 6 / x → 400 `invalid_limit` |
| K-04 | an asker who may read the probe document finds it (web session and delegation) |
| K-05 | an asker who may not read it never gets a chunk of it (web session and delegation, limit 3 and 5) |
| K-06 | only the documented fields; sources are screen paths or http(s) URLs (not protocol-relative) |
| K-07 | the answer to a denied asker has the shape of a "nothing found" answer; no `hidden` / `total` / `withheld` / `denied` |
| K-08 | a delegation of a role the manifest's knowledge tool does not list → 403 `delegation_not_permitted` |

The pilot passes K-01…K-07 with the tool for every role, and K-01…K-08 with the tool for managers only.

## Better made upstream (in the framework)

1. **protocol.** A manifest key `knowledge: { tool }`, like `help: { tool }`. The manifest schema has `additionalProperties: false`,
   so today the capability is found only through the tool's `http`. Also: the route in `openapi/`, and K-01…K-08 in the suite as
   optional checks, skipped when the manifest declares no knowledge.
2. **server-kit.** A `knowledge` option, like `help`, so the route always exists: it passes the gate first (401 / 403) and then
   answers 404 without the option, like every optional Bridge v1 route. Today, a system without the add-on answers 404 before the
   gate.
3. **dsh-core `manifestTools`.** Generate the knowledge tool from the manifest, like `manifest.help.tool` → `helpToolSpec`. A system
   would then need no `toolModules` entry, and the citation rendering would hold even without plugin configuration.
4. **bridge-identity / dsh-im answer filter.** Allow more than one answer filter (or a chain after the link guard), so
   bridge-knowledge can install its citation guard (`ensureCitations` with `ledger.recent(sessionId)`). Not wired yet: it is not
   verified whether `setAnswerFilter` keeps more than one filter, and replacing the link guard must not happen.
5. **help.** Export the generic BM25F (fields → tf / len / idf) that `createSearcher` builds for manual sections. knowledge now
   re-implements it with the same constants. Also consider the Latin word terms for English manuals: help's cross-word bigrams are
   noisy in English.
6. **examples/leave-requests.** A `manifest` option on `createLeaveApp` (tests that change the manifest). The pilot's copy has it.
