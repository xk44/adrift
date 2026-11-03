// node --test scripts/brand-check.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findLegacyNames,
  pathHasLegacyName,
  rewritePathRefs,
  scanTree,
} from "./brand-check.mjs";

// Old-name spellings, assembled so this test file stays clean under the gate.
const C = "Comfy";
const J = "Journey";
const FORMS = [
  C + J,
  (C + J).toLowerCase(),
  (C + J).toUpperCase(),
  `${C} ${J}`,
  `${C}-${J}`.toLowerCase(),
  `${C}_${J}`.toLowerCase(),
];
const DIR = `${C}-${J}`.toLowerCase();

test("flags every spelling of the old name", () => {
  for (const f of FORMS) {
    const hits = findLegacyNames(`hello\nmade with ${f} today`);
    assert.equal(hits.length, 1, f);
    assert.equal(hits[0].line, 2);
    assert.equal(hits[0].match, f);
  }
});

test("ignores the new name and lookalikes", () => {
  assert.deepEqual(
    findLegacyNames("Adrift studio for ComfyUI; journey mode; comfy  journey"),
    [],
  );
});

test("lines with the legacy-name marker are allowed", () => {
  const line = `const KEY = "${FORMS[1]}_overlay_url"; // legacy-name`;
  assert.deepEqual(findLegacyNames(line), []);
});

test("path check", () => {
  assert.equal(pathHasLegacyName(`web/${FORMS[1]}_overlay.js`), true);
  assert.equal(pathHasLegacyName("web/adrift_overlay.js"), false);
});

test("rewrites app-dir references for a flattened export", () => {
  assert.equal(
    rewritePathRefs(`git clone x adrift\ncd adrift/${DIR}`),
    "git clone x adrift\ncd adrift",
  );
  assert.equal(rewritePathRefs(`cd adrift\\${DIR}`), "cd adrift");
  assert.equal(
    rewritePathRefs(`ADRIFT=/path/to/${DIR}   # app`),
    "ADRIFT=/path/to/adrift   # app",
  );
  assert.equal(rewritePathRefs(`cd ${DIR}\nnpm test`), "cd adrift\nnpm test");
  assert.equal(
    rewritePathRefs(`the app directory (\`${DIR}/\`, which contains x)`),
    "the app directory (the repository root, which contains x)",
  );
  assert.equal(
    rewritePathRefs(`Build context: the ${DIR}/ directory.`),
    "Build context: the repository root.",
  );
  assert.equal(
    rewritePathRefs(`relative to the ${DIR} root (docs/)`),
    "relative to the repository root (docs/)",
  );
  assert.equal(
    rewritePathRefs(`These ship in \`${DIR}/comfy_nodes/\`.`),
    "These ship in `comfy_nodes/`.",
  );
  assert.equal(
    rewritePathRefs(`\${repo}/blob/main/${DIR}/README.md#start`),
    "${repo}/blob/main/README.md#start",
  );
  // Brand forms that are not path refs are left for the scan to catch.
  assert.equal(
    rewritePathRefs(`Welcome to ${FORMS[0]}`),
    `Welcome to ${FORMS[0]}`,
  );
});

test("scanTree: fixes path refs, then reports what is left (contents + paths)", () => {
  const root = mkdtempSync(join(tmpdir(), "brand-check-"));
  mkdirSync(join(root, "docs"));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "README.md"), `# Adrift\ncd adrift/${DIR}\n`);
  writeFileSync(join(root, "docs", "a.md"), `Welcome to ${FORMS[3]}\n`);
  writeFileSync(join(root, `${FORMS[1]}.js`), "// ok\n");
  writeFileSync(join(root, "node_modules", "x.js"), FORMS[0]);
  writeFileSync(
    join(root, "bin.dat"),
    Buffer.from([0, 1, 2, ...Buffer.from(FORMS[0])]),
  );

  const r = scanTree(root, { fixPaths: true });
  assert.equal(
    readFileSync(join(root, "README.md"), "utf8"),
    "# Adrift\ncd adrift\n",
  );
  assert.equal(r.rewritten, 1);
  const where = r.hits.map((h) => `${h.file}:${h.line}`).sort();
  assert.deepEqual(where, [`${FORMS[1]}.js:0`, "docs/a.md:1"]);
  assert.ok(readdirSync(root).includes("node_modules"));
});

test("scanTree: clean tree has no hits", () => {
  const root = mkdtempSync(join(tmpdir(), "brand-check-"));
  writeFileSync(join(root, "README.md"), "# Adrift\n");
  assert.deepEqual(scanTree(root).hits, []);
});
