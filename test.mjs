// Logic tests for osmpr (run: node test.mjs).
// Loads the <script> block from index.html and exercises the pure functions.
// No network, no DOM: the page script guards all browser UI behind
// `typeof document !== "undefined"`, so eval under node only defines logic.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
assert(m, "no <script> block found in index.html");
const src = m[1];
// The page script uses top-level consts, which do not leak out of eval().
// Run it as a function body and return the pure functions explicitly.
const fns = new Function(src + "\nreturn { b64urlEncode, b64urlDecode, escapeXml, memberKey, normType, parseMemberSpec, parsePrefill, applyOps, diffMembers, diffTags, buildObjectXml, buildOsmChange };")();
const { b64urlEncode, b64urlDecode, escapeXml, memberKey, normType, parseMemberSpec, parsePrefill, applyOps, diffMembers, diffTags, buildObjectXml, buildOsmChange } = fns;

// --- b64url roundtrip, incl. non-ASCII (changeset comments may be Polish) ---
const pl = "Zażółć gęślą jaźń";
assert.equal(b64urlDecode(b64urlEncode(pl)), pl);
assert(!/[+/=]/.test(b64urlEncode(pl)), "b64url output must be URL-safe");

// --- parsePrefill: JSON format ---
const payload = {
  comment: "test comment",
  changes: [
    { type: "relation", id: 900001, version: 217, add: [{ type: "relation", id: 900002, role: "subarea" }], remove: [], tags: {} },
    { type: "relation", id: 900010, version: 11, add: [], remove: [{ type: "relation", id: 900002, role: "subarea" }], tags: { name: "X", old: null } },
  ],
};
const d = b64urlEncode(JSON.stringify(payload));
const parsed = parsePrefill("?d=" + d);
assert.equal(parsed.comment, "test comment");
assert.equal(parsed.changes.length, 2);
assert.equal(parsed.changes[0].add[0].ref, 900002);
assert.equal(parsed.changes[1].tags.old, null);
assert.equal(parsed.changes[1].remove[0].roleGiven, true);

// --- parsePrefill: simple single-relation format ---
const simple = parsePrefill("?rel=900001&v=217&add=rel:900002:subarea&add=r:999:&comment=hi");
assert.equal(simple.changes.length, 1);
assert.equal(simple.changes[0].version, 217);
assert.equal(simple.changes[0].add.length, 2);
assert.equal(simple.changes[0].add[1].role, "");
assert.equal(simple.comment, "hi");

// --- member spec parsing ---
assert.deepEqual(parseMemberSpec("r:900002:subarea"), { type: "relation", ref: 900002, role: "subarea" });
assert.deepEqual(parseMemberSpec("n:123"), { type: "node", ref: 123, role: "" });
assert.equal(parseMemberSpec("x:1"), null);
assert.equal(parseMemberSpec("r:abc"), null);

// --- applyOps on synthetic parent, pre-fix state (two subareas, child absent) ---
function member(type, ref, role) { return { type, ref, role }; }
const parentPre = {
  type: "relation", id: 900001, version: 216, tags: { name: "Test Parent", type: "boundary" },
  members: [member("way", 111, "outer"), member("relation", 900003, "subarea"), member("relation", 900004, "subarea")],
};
const parentFixed = applyOps(parentPre, { add: [{ type: "relation", ref: 900002, role: "subarea" }], remove: [], tags: {} });
assert.equal(parentFixed.changed, true);
assert.equal(parentFixed.members.length, 4);
assert.equal(parentFixed.members[3].ref, 900002);
assert.equal(parentFixed.notes.length, 0);

// re-applying the same add is a no-op with a note (demo safety)
const parentAgain = applyOps({ ...parentPre, members: parentFixed.members }, { add: [{ type: "relation", ref: 900002, role: "subarea" }], remove: [], tags: {} });
assert.equal(parentAgain.changed, false);
assert.match(parentAgain.notes[0].text, /Already present/);

// remove of a non-member warns, does not change
const parentNoop = applyOps(parentPre, { add: [], remove: [{ type: "relation", ref: 900002, role: "subarea", roleGiven: true }], tags: {} });
assert.equal(parentNoop.changed, false);
assert.match(parentNoop.notes[0].text, /not present/);

// remove without role matches any role
const parentRole = applyOps(parentPre, { add: [], remove: [{ type: "relation", ref: 900003, role: "", roleGiven: false }], tags: {} });
assert.equal(parentRole.members.length, 2);
assert.ok(!parentRole.members.some((x) => x.ref === 900003));

// tag ops: set, change, delete, delete-missing warning
const tagOut = applyOps(parentPre, { add: [], remove: [], tags: { name: "Test Parent", type: null, wikidata: "Q123" } });
assert.equal(tagOut.tags.name, "Test Parent");
assert.ok(!("type" in tagOut.tags));
assert.equal(tagOut.tags.wikidata, "Q123");
assert.equal(tagOut.changed, true);
const tagWarn = applyOps(parentPre, { add: [], remove: [], tags: { nope: null } });
assert.match(tagWarn.notes[0].text, /not present/);

// member ops on a way must fail loudly
assert.throws(() => applyOps({ type: "way", id: 1, tags: {}, members: [] }, { add: [{ type: "node", ref: 2, role: "" }], remove: [], tags: {} }), /only apply to relations/);

// --- diff + osmChange XML for the pre-fix two-relation fix ---
const masterPre = {
  type: "relation", id: 900010, version: 10, tags: { type: "route_master", route: "bus" },
  members: [member("way", 900011, ""), member("relation", 900012, ""), member("relation", 900013, ""), member("relation", 900002, "subarea")],
};
const masterFixed = applyOps(masterPre, { add: [], remove: [{ type: "relation", ref: 900002, role: "subarea", roleGiven: true }], tags: {} });
assert.equal(masterFixed.members.length, 3);
const dm = diffMembers(parentPre.members, parentFixed.members);
assert.equal(dm.added.length, 1);
assert.equal(dm.removed.length, 0);
assert.equal(dm.unchangedCount, 3);
const xml = buildOsmChange("12345", [
  { type: "relation", id: 900001, version: 216, state: parentFixed, lat: undefined, lon: undefined },
  { type: "relation", id: 900010, version: 10, state: masterFixed, lat: undefined, lon: undefined },
]);
assert.match(xml, /<member type="relation" ref="900002" role="subarea"\/>/);
assert.match(xml, /changeset="12345"/);
assert.match(xml, /version="216"/);
assert.match(xml, /<tag k="name" v="Test Parent"\/>/);
// master section must NOT contain the removed member
const n8Section = xml.split('id="900010"')[1];
assert.ok(!n8Section.includes('ref="900002"'), "master osmChange must not contain the removed member");

// XML escaping
assert.equal(escapeXml('a<b>&"c'), "a&lt;b&gt;&amp;&quot;c");

console.log("All editor logic tests passed.");
