---
name: recall
description: "Save durable project knowledge to Mission Control's Recall (project memory) so future sessions start already knowing it, AND navigate this project's indexed code graph. Use when you discover or decide something worth remembering about THIS project — an architecture fact, a decision and its rationale, a convention, a stack detail, a glossary term, a known issue, or a useful discovery (\"X lives in Y\", \"Z is generated\"). Also use when you need to LOCATE or READ code — where a symbol is defined (and its verbatim source), what calls it, or what a change would impact — via the graph_search / graph_node / get_neighbors / impact_of / shortest_path MCP tools instead of grepping. Requires a Mission Control agent session (MC_API_URL, MC_API_TOKEN, MC_TASK_ID are injected automatically). Not for transient to-dos, run-specific notes, or projects running outside Mission Control."
user-invocable: true
---

Mission Control agent sessions receive env vars automatically:

- `MC_API_URL` — loopback API base (e.g. `http://127.0.0.1:54321`)
- `MC_API_TOKEN` — bearer token for that API
- `MC_TASK_ID` — the active task/session id

Mission Control maintains **Recall**, a curated, per-project memory that it assembles into a **Session Brief** and hands to every new session. When you learn something durable about this project, write it back so the next session doesn't rediscover it.

Skip this entirely when the MC env vars are missing (plain shell outside Mission Control).

## Navigating the code (Recall code graph)

Mission Control also indexes this project into a **code graph** — every function, class, method, type, interface, and file, plus the calls/imports between them. It's exposed as MCP tools on the `recall` server. **Prefer these over `grep`/`glob` when you need to locate code or trace relationships** — the graph is pre-indexed, ranked by how central a symbol is, and complete (it won't miss a dynamically-shaped call site the way a text search can):

- `graph_search(query, include_source?)` — find **where a symbol is defined** by name or path (functions, classes, methods, types, React components, files). Your first move when you'd otherwise `grep` for a definition. Returns the most-connected matches first; pass `include_source: true` to get the top matches' verbatim source inline.
- `graph_node(node)` — **read a symbol's definition source** (verbatim, line-numbered) without opening the file. Prefer this over `Read` when you need the body of one function/class/component.
- `get_neighbors(node, direction)` — a symbol's **direct callers/callees and importers**. Answers "what calls X" / "what does X depend on" without grepping for call sites. `direction`: `in`, `out`, or `both`.
- `impact_of(node)` — **what transitively breaks if I change this** (reverse-reachable dependents, several hops out). Run it before an edit instead of grepping for usages.
- `shortest_path(from, to)` — **how two areas connect** through imports/calls — a question `grep` can't answer.

If a graph tool reports the project isn't indexed yet, fall back to `grep` for that lookup; don't block on it. The graph covers JavaScript/TypeScript (`.ts` / `.tsx` / `.js` / `.jsx` / `.mts` / `.cts` / `.mjs` / `.cjs`) and Python (`.py`).

## When to save a memory

Save a memory when you establish a **durable fact about the project** — not about the current task:

- **decision** — a choice that was made and why ("Use JWT instead of session cookies — stateless across the worker fleet")
- **architecture** — where things live / how data flows ("Auth flow lives in `useAuth`")
- **convention** — a project-specific pattern or do/don't ("All API errors go through `handleDomainError`")
- **stack** — a language/framework/build/runtime/infra fact
- **glossary** — a domain term and its meaning
- **known-issue** — a current limitation, gotcha, or flaky area
- **discovery** — a useful finding ("Migrations run on boot from `ensureSchema`")
- **overview** / **preference** — what the project is / how the user likes to work here

Do **not** save: the task you were asked to do, TODOs, transient state, or anything only true for this one run. Prefer a few high-signal facts over many. Recall dedupes by title, so re-saving a known fact is harmless.

## How to save

First resolve the project id from the task, then POST the memory:

```bash
# 1. Get the project id for this session.
PROJECT_ID=$(curl -s "$MC_API_URL/api/tasks/$MC_TASK_ID" \
  -H "authorization: Bearer $MC_API_TOKEN" \
  | sed -n 's/.*"projectId":"\([^"]*\)".*/\1/p')

# 2. Save a memory.
curl -s -X POST "$MC_API_URL/api/projects/$PROJECT_ID/memory" \
  -H "authorization: Bearer $MC_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "type": "decision",
    "title": "Use JWT instead of session cookies",
    "body": "Chosen for statelessness across the worker fleet.",
    "source": "agent",
    "confidence": "confirmed"
  }'
```

### Fields

- `type` (required) — one of `overview`, `stack`, `architecture`, `decision`, `convention`, `glossary`, `known-issue`, `preference`, `discovery`.
- `title` (required) — a one-line headline. This is what gets injected into future briefs, so make it self-contained (≤ 200 chars).
- `body` (optional) — a short detail: the why / where / how.
- `source` — always send `"agent"` so the memory is tagged as agent-written.
- `confidence` — `"confirmed"` when you verified it in the code, `"inferred"` when you're reasonably sure, `"ambiguous"` when unsure.
- `tags` (optional) — a string array for filtering.

A `403` means the user has disabled agent memory writes in Settings → Recall — respect that and stop trying.

## Etiquette

- Save at most a handful of memories per session — the highest-signal facts only.
- Keep each memory atomic (one fact per entry).
- Don't echo the whole brief back; only write things that are genuinely new or now more certain.
