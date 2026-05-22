# `subagent.dispatch.v1` envelope

Cross-harness contract for skills that dispatch sub-agent work. Lets one skill drive both Claude Code (`Agent` tool) and OpenAI Codex CLI (and any other harness) through the same on-disk protocol.

## Why a contract

Skills like `skill-code-review` and `skill-llm-wiki` need to spawn sub-agents to do bounded units of work (specialist review, tier-2 merge decision, wiki-runner build). Each harness has its own dispatch primitive (`Agent({subagent_type: ...})` in Claude Code, equivalent in Codex CLI). Skills should not name the primitive directly. They emit an envelope describing the request, and a thin per-harness shim translates the envelope into a real call.

The contract is file-based, not stdout-based: prompts contain code samples and JSON-line escaping breaks under shells. Stage prompts and outputs as files, point at them by path.

## Envelope

A single canonical object: `subagent.dispatch.v1`. The version is on the wire (`kind` field), not the filename, so future shapes (`subagent.dispatch.v2`, `subagent.batch.v1`) ship without churn.

### Required fields

| Field | Type | Description |
|------|------|-------------|
| `kind` | string literal `"subagent.dispatch.v1"` | Wire-version tag. |
| `request_id` | string | Unique, deterministic. Host returns its result keyed on this id. |
| `role` | string | Semantic role: `"code-review-specialist"`, `"wiki-tier2-merge-decision"`, `"wiki-runner"`, etc. The harness shim maps this to its native sub-agent type. Replaces Claude's `subagent_type`. |
| `prompt` | string | Literal prompt the sub-agent receives. The skill ships it ready to dispatch; the host does not concatenate. |
| `inputs` | object | Minimal kind-specific structured inputs. Empty object `{}` is legal when `prompt` already carries everything. |
| `effort` | enum: `"heavy" \| "balanced" \| "light"` | Provider-neutral effort hint. Replaces hard-coded model names like `opus` / `sonnet` / `haiku`. |

### Optional fields

| Field | Type | Description |
|------|------|-------------|
| `model` | string | Explicit model override (`"claude-opus-4-7"`, `"gpt-5-codex"`, etc.). Host harness prefers `model` when set; otherwise maps `effort` to its own lineup. |
| `response_schema` | object | Free-form shape hint describing the JSON the sub-agent must return. **Not** a strict JSON Schema: skills typically use stylised string values like `"string"`, `"integer"`, `"completed\|skipped\|failed"`, `"string?"` (the `?` suffix marks optional). Host shims that want strict validation should ship their own per-skill validators; the shape hint is for human readers and prompt construction. |
| `tools` | string[] | Allowed tool names for the spawned sub-agent (`["Read", "Grep", "Bash"]`). Empty / omitted means host default. |
| `timeout_ms` | integer | Soft cap. Host may shorten to its ceiling. |
| `parent_run_id` | string | Links this dispatch to the parent FSM run for tracing. |
| `outputs_path` | string (absolute) | Where the sub-agent must write its JSON response. Optional in the schema for forward-compat with stdout-based variants, but RECOMMENDED for production usage and required by every existing skill. Skills that emit envelopes without `outputs_path` MUST document an alternate return channel. |

## Transport

The skill writes the envelope to a known path:

```
<run_dir_or_work_dir>/dispatch/<request_id>.json
```

The skill's runner emits a one-line stdout breadcrumb so the host harness knows where to look:

```json
{"status": "awaiting_subagent", "envelope_path": "/abs/.../dispatch/<request_id>.json", "result_path": "/abs/.../<outputs_path>"}
```

The harness shim:

1. Reads the envelope from `envelope_path`.
2. Maps `role` to its native sub-agent type and `effort` (or `model` override) to a real model.
3. Dispatches the sub-agent with `prompt`, `inputs`, `tools`, `response_schema`.
4. Writes the sub-agent's JSON return value to `outputs_path`.
5. Signals the runner to continue (re-run the runner, or send `--continue`).

## Result shape

The sub-agent's return value, written by the harness shim to `outputs_path`, must conform to the envelope's `response_schema` (the stylised shape hint described above). Skills MAY require a top-level `kind` discriminator on the response too, but that is per-skill and not mandated here. Enforcement strategy is host-defined: a host that wants strict validation ships its own per-skill validator; a host that trusts the sub-agent passes the JSON straight through.

## Skill-specific extension profiles

The schema declares `additionalProperties: true`, which means skills MAY include extra fields beyond the required+optional set listed above. Three rules apply:

1. **Required fields are inviolate.** Every envelope MUST include `kind`, `request_id`, `role`, `prompt`, `inputs`, `effort` with their canonical types and values; in particular `kind` MUST be the literal `"subagent.dispatch.v1"`.
2. **Extension fields SHOULD be namespaced.** A skill that adds `wiki_kind` or `cr_shard_idx` should prefix or scope the field to avoid collisions with future standard fields. Skills MAY also place extension data inside `inputs` (which is intentionally free-form).
3. **Hosts MUST tolerate unknown fields.** A host shim that doesn't recognise an extension field SHOULD pass it through to its native sub-agent dispatch unchanged or ignore it; it MUST NOT reject the envelope solely on its presence.

Reference profile: `skill-llm-wiki`'s tier-2 protocol uses a top-level `tier2_kind` field (e.g. `"merge_decision"`, `"propose_structure"`) to discriminate per-Tier-2-request kinds, plus the deprecated `model_hint` / `effort_hint` aliases retained for one release. See `skill-llm-wiki/scripts/lib/tier2-protocol.mjs`.

## Error shape

Failed dispatches surface as a sibling file:

```
<run_dir_or_work_dir>/dispatch/<request_id>.error.json
```

```json
{
  "kind": "subagent.dispatch.error.v1",
  "request_id": "<same as envelope>",
  "error_code": "timeout|model_unavailable|tool_denied|harness_internal",
  "message": "human-readable explanation",
  "retryable": true
}
```

The skill detects the error file at result-collection time and surfaces it through its existing fault path (e.g. `skill-code-review` emits `{"status": "fault", ...}`; `skill-llm-wiki` exits non-zero with a non-7 code).

## Worked example

A `skill-code-review` specialist dispatch for an OWASP A01 leaf:

```json
{
  "kind": "subagent.dispatch.v1",
  "request_id": "cr-run-2026-05-08-abc123-leaf-sec-owasp-a01",
  "role": "code-review-specialist",
  "prompt": "<contents of dispatch_specialists-prompt-sec-owasp-a01.md>",
  "inputs": {},
  "effort": "balanced",
  "response_schema": {
    "id": "string",
    "status": "completed|skipped|failed",
    "runtime_ms": "integer",
    "tokens_in": "integer",
    "tokens_out": "integer",
    "findings": "array",
    "skip_reason": "string?"
  },
  "tools": ["Read", "Grep", "Bash"],
  "outputs_path": "/abs/.skill-code-review/<shard>/<run-id>/workers/dispatch_specialists-output-sec-owasp-a01.json",
  "parent_run_id": "<run-id>"
}
```

## Batch wrapper

When a skill needs to fan out N envelopes at once:

```json
{
  "kind": "subagent.batch.v1",
  "envelopes": [ /* subagent.dispatch.v1 objects */ ],
  "remaining_after": 0,
  "pending_now": 0,
  "total_dispatch_units": 0
}
```

The harness dispatches every envelope in the batch in parallel where possible.

## Effort to model mapping (reference)

Each harness is responsible for its own mapping. Reference table:

| Effort | Claude Code | Codex CLI |
|--------|-------------|-----------|
| `heavy` | Opus | GPT-5 (or 5-pro) |
| `balanced` | Sonnet | GPT-5-mini |
| `light` | Haiku | GPT-5-nano |

When `model` is set explicitly the harness MUST honour it (or fail with `error_code: "model_unavailable"`). When `model` is unset the harness maps `effort` to its lineup.

## Compatibility

- The schema at `templates/_common/subagent-dispatch-v1.schema.json` is authoritative for runtime validation.
- Future versions bump `kind` to `subagent.dispatch.v2`. Harness shims should accept both for one release before the v1 sunset is announced via CHANGELOG.

## Out of scope here

The actual harness shims live elsewhere:

- `ctxr/src/harness/claude-code-shim.mjs` (planned)
- `ctxr/src/harness/codex-cli-shim.mjs` (planned)

Until those ship, both clients can still drive the loop manually: the LLM in the main session reads the envelope file, performs the dispatch in its native idiom, writes the result file, and continues the runner.
