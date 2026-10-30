# ContractLens

A dependency-free JavaScript tool for reviewing **OpenAPI 3.0 JSON contract changes** before a release. It compares operations, parameters, request bodies, response statuses, media types and nested schemas, with different compatibility rules for incoming requests and outgoing responses.

Built for Lord_Sumi's portfolio. This is a conservative, documented subset analyzer, not a complete OpenAPI validator or a proof that a release is safe.

## Run

Node.js 20+; no package installation or API keys are needed.

```bash
git clone https://github.com/sumiEmpire001/contractlens.git
cd contractlens
npm test
node src/cli.mjs examples/before.json examples/after.json --json
```

The synthetic example deliberately changes a response field from a required string to an optional integer. It reports two breaking changes and exits **1**, as expected. Compare the same fixture to itself to see exit **0**:

```bash
node src/cli.mjs examples/before.json examples/before.json
```

| Exit | Meaning |
|---|---|
| 0 | No incompatible changes detected in the supported subset |
| 1 | Breaking changes detected, with no unresolved manual-review findings |
| 2 | Invalid input, unsupported input, or manual-review findings; may also include breaking changes |

Use the JSON report's `breaking`, `review` and `findings` fields in CI. Treat exit 2 as a review gate, not as a pass.

## Library

```js
import { compare } from './src/compare.mjs';
const report = compare(previousOpenApiObject, nextOpenApiObject);
for (const finding of report.findings) {
  console.log(finding.severity, finding.code, finding.path, finding.message);
}
```

The function does not mutate the input documents or make network requests. Paths in findings identify the operation and nested schema location. Inputs and outputs exist only in memory unless the calling application writes them.

## Compatibility rules

- Removed paths, operations, response statuses and previously supported media types are breaking.
- New required request parameters, request bodies or properties break existing clients.
- A response property becoming optional removes a guarantee; a request property becoming optional relaxes a requirement.
- Request enum narrowing and response enum widening are breaking. Nullable changes use the same input/output distinction.
- Local JSON Pointer references are resolved, including changed shared component schemas. Nested objects and array item schemas are traversed.
- Recursive/external/broken references, schema composition, directional fields, changed unsupported keywords, authentication changes and encoding changes require manual review.
- Description edits and JSON object key order do not create findings.

## Architecture

`src/compare.mjs` is the pure comparison engine. `src/cli.mjs` handles local JSON input, human/machine reports and exit codes. `test/compare.test.mjs` contains deterministic fixtures and subprocess CLI checks. `examples/` contains synthetic data only.

The engine uses a recursion guard for cyclic schema references. Missing or external references produce review findings rather than network fetches or a clean result. Authentication definitions are checked separately from security requirement names.

## Verification

Local check on 30 October 2026: **22 tests passed** with `npm test`. Tests exercise nested arrays, shared references, recursive references, JSON Pointer escaping, parameter overrides, request/response requiredness and enum direction, authentication definitions, malformed input and actual CLI exit behavior. GitHub Actions is configured for Node 20, 22 and 24; remote execution is tracked separately.

## Limitations

Only OpenAPI **3.0.x JSON** is accepted. YAML and OpenAPI 3.1 are deliberately rejected. There is no full document validation, remote reference loading, server execution, semantic equivalence solver or guarantee against all compatibility regressions. Constraints such as numeric bounds, string patterns, composition, readOnly/writeOnly and polymorphism are outside the automatic compatibility subset and require manual review when relevant. Added operations are not analyzed for validity. Very large, deeply nested or malformed schemas may exceed resource limits; compare trusted local specification files. A clean report means only that the supported rules found no incompatibility.

MIT license; see [LICENSE](LICENSE).
