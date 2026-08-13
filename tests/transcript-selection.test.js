const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.resolve(__dirname, "..", "sidepanel.js"),
  "utf8",
);

test("all timestamped transcript row clicks use the selection-aware seek helper", () => {
  assert.match(
    source,
    /function hasNonCollapsedTextSelection\(\)[\s\S]*?selection\.rangeCount > 0 && !selection\.isCollapsed/,
  );
  assert.match(
    source,
    /function seekFromTranscriptEntryClick\(event, seconds\)[\s\S]*?if \(hasNonCollapsedTextSelection\(\)\) \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?event\.stopPropagation\(\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?seekTo\(seconds\);/,
  );

  const guardedRowHandlers = source.match(
    /div\.addEventListener\("click", \(event\) =>\s+seekFromTranscriptEntryClick\(event, group\.start\),\s+\);/g,
  );
  assert.equal(
    guardedRowHandlers?.length,
    1,
    "raw transcript rows must use the guard",
  );
  assert.match(
    source,
    /div\.addEventListener\("click", \(event\) =>\s+seekFromTranscriptEntryClick\(event, segment\.start\),\s+\);/,
    "translated-only and bilingual rows must use the guard",
  );
  assert.doesNotMatch(
    source,
    /div\.addEventListener\("click", \(\) => seekTo\(group\.start\)\);/,
  );
});

test("the Explain tooltip preserves selection and contains pointer events", () => {
  assert.match(
    source,
    /tooltip\.addEventListener\("mousedown", \(event\) => \{\s+event\.preventDefault\(\);\s+event\.stopPropagation\(\);/,
  );
  assert.match(
    source,
    /tooltip\.addEventListener\("mouseup", \(event\) => \{\s+event\.stopPropagation\(\);/,
  );
  assert.match(
    source,
    /\.addEventListener\("click", async \(event\) => \{\s+event\.preventDefault\(\);\s+event\.stopPropagation\(\);/,
  );
});

test("selected transcript text can be saved to local vocabulary", () => {
  assert.match(source, /VOCABULARY_STORAGE_KEY = "ytd_vocabulary"/);
  assert.match(source, /save-word-btn/);
  assert.match(source, /saveVocabularyTerm\(selectedText/);
  assert.match(source, /applyVocabularyHighlights\(\)/);
});

test("transcript export supports bilingual printable output", () => {
  assert.match(source, /function openExportDialog\(\)/);
  assert.match(source, /value="bilingual"/);
  assert.match(source, /英语精读 PDF（推荐）/);
  assert.match(source, /ipaUk/);
  assert.match(source, /printWindow\.print/);
  assert.match(source, /function exportTranscriptAdvanced\(options\)/);
});
