The frozen baseline was generated from locally available `origin/main` ancestor
`fff1b031d795f17c15a6e57d152cebbca63f9d7a` (before PR #318; that revision has no
`src/router/config-catalog.ts`). It contains all 3,360 scenarios from the previous
identity comparison, including complete candidate and skipped decisions,
provider/model/checkpoint identities and experimentally observed quota-window/reserve-key
mappings. Routine tests read this fixture without Git or network access.

Reproduce from this checkout, with dependencies installed and `.routing-baseline` absent:

```sh
mkdir .routing-baseline
git archive fff1b031d795f17c15a6e57d152cebbca63f9d7a | tar -x -C .routing-baseline
cp test/routing-identity-support.ts .routing-baseline/test/
bun -e '
import { identitySnapshot } from "./.routing-baseline/test/routing-identity-support.ts";
const snapshot = identitySnapshot();
const candidateTable = [], skippedTable = [], decisionTable = [];
const intern = (table, value) => {
  const encoded = JSON.stringify(value);
  let index = table.findIndex(row => JSON.stringify(row) === encoded);
  if (index < 0) { index = table.length; table.push(value); }
  return index;
};
for (const row of snapshot.decisions) {
  row.decision.candidates = row.decision.candidates.map(value => intern(candidateTable, value));
  row.decision.skipped = row.decision.skipped.map(value => intern(skippedTable, value));
  row.decision = intern(decisionTable, row.decision);
}
await Bun.write("test/fixtures/routing-identity.json", JSON.stringify({
  baselineCommit: "fff1b031d795f17c15a6e57d152cebbca63f9d7a",
  snapshot, candidateTable, skippedTable, decisionTable
}, null, 2) + "\n");
'
bunx biome format --write test/fixtures/routing-identity.json
```

Remove the disposable `.routing-baseline` directory after reproduction, before running tests.
The copied helper's imports resolve exclusively to the pre-PR implementation. The three
intern tables are lossless: expand their indexes as shown in `routing-policy.test.ts`.
This keeps the complete fixture small enough for normal lint checks.

The helper replaces endpoint hostnames with provider-specific `example.invalid` names
before routing and supplies only fake tokens, including the static-token fallback.
All other target fields and endpoint paths remain part of the full decision comparison.
No real config, credentials, timestamps, network access or live quota readings are used.
Do not regenerate expectations during routine tests.
