## 1. Owner self-identities (server)

- [x] 1.1 Repository: `getArchiveOwnerSelfIdentities` / `setArchiveOwnerSelfJids` over `schema_meta` (canonicalize, validate phone-shaped, dedupe; both repos) + identity-suggestion query (substring over contacts, current label + message count)
- [x] 1.2 Routes: extend `POST /api/brain/owner` with `selfJids`, add `GET /api/brain/owner/identity-suggestions`; expose self identities (with labels) and budget limits + provider usage accuracy in brain status
- [x] 1.3 Labeler precedence in `buildPackLabeler` and its callers: self-JID senders/quoted/reactors/mentions render the owner label, anchor to owner, exempt from stamps; bump `EXTRACTION_VERSION`

## 2. Run budgets (server)

- [x] 2.1 `BrainRunRequest.maxTokens` + run-loop accumulation and named `budget_exceeded` stop before the next call; plumb from routes and CLI
- [x] 2.2 Refuse user-triggered runs/regenerations without an owner name (routes + CLI; scheduler exempt); provider status gains `tokenUsage` accuracy

## 3. Run console (client)

- [x] 3.1 Slim the Brain panel to summary + "Run brain…" button; move identity, mode, provider/model, budgets, and reset into `RunConsoleModal` (house modal pattern, new styles, dark/light)
- [x] 3.2 Self-number editor: chips + substring autocomplete showing each number's current name and message count; warning state when the label differs from the owner; client validation mirroring the server
- [x] 3.3 `deriveRunValidation` matrix: name-required gate, extractive disables model/budgets/regenerate, session-missing/degraded gates with provider message + probe, numeric clamps with inline errors, token-budget accuracy annotation

## 4. Tests

- [x] 4.1 Labeler: self-JID precedence over saved names (sender/quoted/reactor), owner anchoring, stamps exemption
- [x] 4.2 Owner API: normalization/validation/dedupe, suggestions shape, mirror parity
- [x] 4.3 Run control: token-budget stop is a named budget_exceeded with pending remainder; run refusal without owner name; extractive runs ignore model budgets

## 5. Verification gate (browser, live app)

- [x] 5.1 Modal opens from the redesigned panel; empty name disables Run with the reason; setting a name enables it
- [x] 5.2 Typing digits suggests archive identities with their current names; adding one saved under another name shows the warning chip; saved config round-trips
- [x] 5.3 Extractive mode visibly disables model select + call/token budgets + regenerate; out-of-range budgets cannot be submitted; token field annotated under codex
- [x] 5.4 A run started from the modal runs with the chosen budgets; console clean; SSE refresh still live
