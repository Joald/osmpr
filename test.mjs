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
const fns = new Function(src + "\nreturn { b64urlEncode, b64urlDecode, escapeXml, memberKey, normType, parseMemberSpec, parsePrefill, applyOps, diffMembers, diffTags, diffChars, buildObjectXml, buildDeleteXml, buildOsmChange, buildDiffLines, computeMemberGeometryEvents };")();
const { b64urlEncode, b64urlDecode, escapeXml, memberKey, normType, parseMemberSpec, parsePrefill, applyOps, diffMembers, diffTags, diffChars, buildObjectXml, buildDeleteXml, buildOsmChange, buildDiffLines, computeMemberGeometryEvents } = fns;

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

// --- character-level diff ---
assert.deepEqual(diffChars("abc", "abc"), [{ t: "same", s: "abc" }]);
assert.deepEqual(diffChars("", "xy"), [{ t: "ins", s: "xy" }]);
assert.deepEqual(diffChars("kitten", "sitting").filter((o) => o.t !== "same").map((o) => o.t + ":" + o.s).join(","), "del:k,ins:s,del:e,ins:i,ins:g");
const big = diffChars("a".repeat(600), "b".repeat(600));
assert.equal(big.length, 2);
assert.equal(big[0].t, "del");
assert.equal(big[1].t, "ins");

// --- geometry: node moves, way node lists, upload XML ---
const nodeMovePayload = {
  comment: "demo",
  changes: [{ type: "node", id: 900100, lat: 51.6, lon: -0.05, tags: {} }],
};
const nodeParsed = parsePrefill("?d=" + b64urlEncode(JSON.stringify(nodeMovePayload)));
assert.equal(nodeParsed.changes[0].lat, 51.6);
assert.equal(nodeParsed.changes[0].lon, -0.05);
const nodePre = { type: "node", id: 900100, version: 3, tags: { amenity: "atm" }, members: [], lat: 51.5, lon: -0.1, nodeRefs: null };
const nodeMoved = applyOps(nodePre, nodeParsed.changes[0]);
assert.equal(nodeMoved.changed, true);
assert.equal(nodeMoved.lat, 51.6);
assert.equal(nodeMoved.lon, -0.05);
assert.equal(nodeMoved.tags.amenity, "atm");
const nodeSame = applyOps(nodePre, { add: [], remove: [], tags: {}, lat: 51.5, lon: -0.1, nodes: null });
assert.equal(nodeSame.changed, false);
const nodeBad = applyOps(nodePre, { add: [], remove: [], tags: {}, lat: 100, lon: 0, nodes: null });
assert.equal(nodeBad.lat, 51.5);
assert.match(nodeBad.notes[0].text, /Invalid node position/);
const nodeHalf = applyOps(nodePre, { add: [], remove: [], tags: {}, lat: 51.6, lon: null, nodes: null });
assert.equal(nodeHalf.lat, 51.5);
assert.match(nodeHalf.notes[0].text, /Invalid node position/);
const geomWrongType = applyOps(parentPre, { add: [], remove: [], tags: {}, lat: 51.6, lon: -0.05, nodes: null });
assert.match(geomWrongType.notes[0].text, /only apply to nodes/);
const wayPre = { type: "way", id: 900200, version: 1, tags: {}, members: [], lat: null, lon: null, nodeRefs: [11, 22, 33] };
const wayChanged = applyOps(wayPre, { add: [], remove: [], tags: {}, lat: null, lon: null, nodes: [11, 33] });
assert.deepEqual(wayChanged.nodeRefs, [11, 33]);
assert.equal(wayChanged.changed, true);
const waySame = applyOps(wayPre, { add: [], remove: [], tags: {}, lat: null, lon: null, nodes: [11, 22, 33] });
assert.equal(waySame.changed, false);
const wayBad = applyOps(wayPre, { add: [], remove: [], tags: {}, lat: null, lon: null, nodes: [11, "x"] });
assert.deepEqual(wayBad.nodeRefs, [11, 22, 33]);
assert.match(wayBad.notes[0].text, /Invalid way node list/);
// computed geometry flows into upload XML (and way uploads keep node refs)
const wayXml = buildObjectXml("way", 900200, 1, "12345", wayChanged, undefined, undefined);
assert.match(wayXml, /<nd ref="11"\/><nd ref="33"\/>/);
assert.ok(!wayXml.includes('ref="22"'));
const nodeXml = buildObjectXml("node", 900100, 3, "12345", nodeMoved, nodeMoved.lat, nodeMoved.lon);
assert.match(nodeXml, /lat="51.6" lon="-0.05"/);

// --- new objects: negative placeholder ids ---
const newWayPre = { type: "way", id: -1, version: null, tags: {}, members: [], lat: undefined, lon: undefined, nodeRefs: null };
const newWay = applyOps(newWayPre, { add: [], remove: [], tags: {}, lat: null, lon: null, nodes: [111, 222] });
assert.deepEqual(newWay.nodeRefs, [111, 222]);
assert.equal(newWay.changed, true);
const createXml = buildObjectXml("way", -1, null, "12345", newWay, undefined, undefined);
assert.match(createXml, /^<way changeset="12345"><nd ref="111"\/><nd ref="222"\/><\/way>$/);
assert.ok(!createXml.includes("version=") && !createXml.includes('id="-1"'));
const mixedXml = buildOsmChange("12345", [
  { type: "way", id: -1, version: null, state: newWay, lat: undefined, lon: undefined },
  { type: "relation", id: 900001, version: 216, state: parentFixed, lat: undefined, lon: undefined },
]);
assert.match(mixedXml, /<create>\n    <way changeset="12345">/);
assert.match(mixedXml, /<modify>\n    <relation id="900001" version="216" changeset="12345">/);

// --- object deletes ---
const delParsed = parsePrefill("?d=" + b64urlEncode(JSON.stringify({ comment: "demo", changes: [{ type: "node", id: 900100, delete: true }] })));
assert.equal(delParsed.changes[0].delete, true);
assert.equal(buildDeleteXml("node", 900100, 3, "12345", 51.5, -0.1), '<node id="900100" version="3" changeset="12345" lat="51.5" lon="-0.1"/>');
assert.equal(buildDeleteXml("way", 900200, 1, "12345", undefined, undefined), '<way id="900200" version="1" changeset="12345"/>');
const delXml = buildOsmChange("12345", [
  { type: "node", id: 900100, version: 3, state: {}, lat: 51.5, lon: -0.1, deleted: true },
  { type: "relation", id: 900001, version: 216, state: parentFixed, lat: undefined, lon: undefined },
]);
assert.match(delXml, /<delete>\n    <node id="900100" version="3" changeset="12345" lat="51.5" lon="-0.1"\/>\n  <\/delete>/);
assert.match(delXml, /<modify>\n    <relation id="900001" version="216"/);

// --- GitHub-style diff lines ---
const dl = buildDiffLines({ a: "1", b: "old", c: "x" }, [], { a: "1", b: "new", d: "y" }, []);
assert.equal(dl.tagLines.length, 5); // a same, b del+add, c del, d add
assert.deepEqual(dl.tagLines[0], { kind: "same", oldNo: 1, newNo: 1, key: "a", value: "1" });
assert.equal(dl.tagLines[1].kind, "del"); assert.equal(dl.tagLines[1].oldNo, 2); assert.equal(dl.tagLines[1].newNo, "");
assert.equal(dl.tagLines[2].kind, "add"); assert.equal(dl.tagLines[2].newNo, 2);
assert.equal(dl.tagLines[3].kind, "del"); assert.equal(dl.tagLines[3].key, "c");
assert.equal(dl.tagLines[4].kind, "add"); assert.equal(dl.tagLines[4].key, "d");
assert.ok(dl.tagLines[1].ops && dl.tagLines[2].ops, "changed tag keeps char-level ops");
const ml = buildDiffLines({}, [member("way", 1, "outer"), member("way", 2, "outer")], {}, [member("way", 1, "outer"), member("way", 3, "outer")]);
assert.equal(ml.memberLines.length, 3);
assert.equal(ml.memberLines[0].kind, "same"); assert.equal(ml.memberLines[0].oldNo, 1); assert.equal(ml.memberLines[0].newNo, 1);
assert.equal(ml.memberLines[1].kind, "add"); assert.equal(ml.memberLines[1].newNo, 2);
assert.equal(ml.memberLines[2].kind, "del"); assert.equal(ml.memberLines[2].oldNo, 2);

// --- diff geometry lines ---
const nodeDl = buildDiffLines({}, [], {}, [], { type: "node", lat: 51.5, lon: -0.1 }, { type: "node", lat: 51.6, lon: -0.05 });
assert.equal(nodeDl.geometryLines.length, 2);
assert.equal(nodeDl.geometryLines[0].kind, "del"); assert.deepEqual(nodeDl.geometryLines[0].pos, [51.5, -0.1]);
assert.equal(nodeDl.geometryLines[1].kind, "add"); assert.deepEqual(nodeDl.geometryLines[1].pos, [51.6, -0.05]);
const nodeSameDl = buildDiffLines({}, [], {}, [], { type: "node", lat: 51.5, lon: -0.1 }, { type: "node", lat: 51.5, lon: -0.1 });
assert.equal(nodeSameDl.geometryLines.length, 1); assert.equal(nodeSameDl.geometryLines[0].kind, "same");
const nodeCreatedDl = buildDiffLines({}, [], {}, [], null, { type: "node", lat: 51.5, lon: -0.1 });
assert.equal(nodeCreatedDl.geometryLines.length, 1); assert.equal(nodeCreatedDl.geometryLines[0].kind, "add");
const wayDl = buildDiffLines({}, [], {}, [], { type: "way", nodeRefs: [11, 22, 33, 11] }, { type: "way", nodeRefs: [11, 44, 33, 11] });
assert.equal(wayDl.geometryLines.length, 5);
assert.equal(wayDl.geometryLines[0].kind, "same"); assert.equal(wayDl.geometryLines[0].oldNo, 1); assert.equal(wayDl.geometryLines[0].newNo, 1);
assert.equal(wayDl.geometryLines[1].kind, "add"); assert.equal(wayDl.geometryLines[1].ref, 44); assert.equal(wayDl.geometryLines[1].newNo, 2);
assert.equal(wayDl.geometryLines[2].kind, "same"); assert.equal(wayDl.geometryLines[2].oldNo, 3); assert.equal(wayDl.geometryLines[2].newNo, 3);
assert.equal(wayDl.geometryLines[3].kind, "same"); assert.equal(wayDl.geometryLines[3].oldNo, 4); assert.equal(wayDl.geometryLines[3].newNo, 4);
assert.equal(wayDl.geometryLines[4].kind, "del"); assert.equal(wayDl.geometryLines[4].ref, 22); assert.equal(wayDl.geometryLines[4].oldNo, 2);
const relDl = buildDiffLines({}, [], {}, [], { type: "relation" }, { type: "relation" });
assert.equal(relDl.geometryLines.length, 0, "relations carry geometry in members, not a Geometry section");

// --- member geometry events (relation history; real shape: relation 52818) ---
function nodeHist(id, lat, lon, extra) {
  const els = [{ type: "node", id, version: 1, changeset: 100, timestamp: "2008-11-21T00:00:00Z", visible: true, lat, lon }];
  (extra || []).forEach((m, k) => {
    els.push(m.del
      ? { type: "node", id, version: 2 + k, changeset: m.cs, timestamp: m.ts, visible: false }
      : { type: "node", id, version: 2 + k, changeset: m.cs, timestamp: m.ts, visible: true, lat: m.lat, lon: m.lon });
  });
  return els;
}
function wayHist(id, vs) {
  return vs.map((v, k) => ({ type: "way", id, version: k + 1, changeset: v.cs, timestamp: v.ts, visible: true, nodes: v.nodes }));
}
const A = 313437932, B = 313437933, C = 4536695974, D = 4537517868, E = 4537517867, F = 4537517866, G = 4537517865, H = 301742553;
const X = 1179039271, Y = 1297743462, Z = 313437934, P = 600000001, Q = 600000002;
const N = (n) => 500000000 + n;
const nodeHists = new Map([
  [A, nodeHist(A, 63.8413961, 20.1766622, [{ cs: 60117010, ts: "2018-06-24T10:22:36Z", lat: 63.842, lon: 20.177 }])],
  [B, nodeHist(B, 63.8384067, 20.1757181, [{ cs: 44154732, ts: "2016-12-04T10:38:41Z", del: true }])],
  [C, nodeHist(C, 63.8433034, 20.1774727, [])],
  [D, nodeHist(D, 63.8413249, 20.1790937, [])],
  [E, nodeHist(E, 63.8413, 20.1791, [])],
  [F, nodeHist(F, 63.8412, 20.1792, [])],
  [G, nodeHist(G, 63.8411, 20.1793, [])],
  [H, nodeHist(H, 63.8363416, 20.1748466, [])],
  [X, nodeHist(X, 63.8416515, 20.1907677, [])],
  [Y, nodeHist(Y, 63.8427612, 20.1820971, [])],
  [Z, nodeHist(Z, 63.841, 20.19, [])],
  [P, nodeHist(P, 63.84, 20.17, [])],
  [Q, nodeHist(Q, 63.841, 20.171, [])],
]);
for (let n = 1; n <= 13; n++) nodeHists.set(N(n), nodeHist(N(n), 63.84 + n * 0.0001, 20.18, []));
const wayHists = new Map([
  [28533849, wayHist(28533849, [
    { cs: 775238, ts: "2008-11-21T00:00:00Z", nodes: [A, B] },
    { cs: 44154732, ts: "2016-12-04T10:38:41Z", nodes: [C, A, D, E, F, G, H] },
  ])],
  [28533841, wayHist(28533841, [
    { cs: 775238, ts: "2008-11-21T00:00:00Z", nodes: [X, Z] },
    { cs: 44148051, ts: "2016-12-03T00:00:00Z", nodes: [X, Y, Z] },
    { cs: 44154732, ts: "2016-12-04T10:38:41Z", nodes: [X, Y] },
  ])],
  [457639815, wayHist(457639815, [
    { cs: 44154732, ts: "2016-12-04T10:38:41Z", nodes: [N(1), N(2), N(3), N(4), N(5), N(6), N(7), N(8), N(9), N(10), N(11)] },
    { cs: 60117010, ts: "2018-06-24T10:22:36Z", nodes: [N(1), N(2), N(3), N(4), N(5), N(6), N(7), N(8), N(9), N(10), N(11), N(12), N(13)] },
  ])],
  [999, wayHist(999, [
    { cs: 100, ts: "2008-11-21T00:00:00Z", nodes: [P, Q] },
    { cs: 500, ts: "2009-01-01T00:00:00Z", nodes: [P, Q] },
  ])],
]);
// wayHist() numbers versions 1..n in order; 28533841's real versions are
// v3/v6/v7, so the expected detail strings use those test-local numbers.
const relVersions = [
  { type: "relation", id: 52818, version: 6, changeset: 775238, timestamp: "2008-11-21T00:00:00Z", user: "Cohan", visible: true, tags: {}, members: [{ type: "way", ref: 28533841, role: "outer" }, { type: "way", ref: 28533849, role: "outer" }] },
  { type: "relation", id: 52818, version: 7, changeset: 44148051, timestamp: "2016-12-03T00:00:00Z", user: "MMN-o", visible: true, tags: {}, members: [{ type: "way", ref: 28533841, role: "outer" }, { type: "way", ref: 28533849, role: "outer" }] },
  { type: "relation", id: 52818, version: 8, changeset: 44154732, timestamp: "2016-12-04T10:38:41Z", user: "MMN-o", visible: true, tags: {}, members: [{ type: "way", ref: 28533841, role: "outer" }, { type: "way", ref: 28533849, role: "outer" }, { type: "way", ref: 457639815, role: "outer" }, { type: "way", ref: 999, role: "outer" }] },
  { type: "relation", id: 52818, version: 9, changeset: 64454763, timestamp: "2018-11-13T00:00:00Z", user: "-WI-", visible: true, tags: {}, members: [{ type: "way", ref: 28533841, role: "outer" }, { type: "way", ref: 28533849, role: "outer" }, { type: "way", ref: 457639815, role: "outer" }, { type: "way", ref: 999, role: "outer" }] },
];
const mge = computeMemberGeometryEvents(relVersions, wayHists, nodeHists);
assert.equal(mge.partial, false);
// v7 (vi 1): 28533841 extended 2 -> 3 nodes, in v7's own changeset.
assert.equal((mge.versionDetails.get(1) || []).length, 1);
assert.equal(mge.versionDetails.get(1)[0].way, 28533841);
assert.equal(mge.versionDetails.get(1)[0].detail, "nodes 2 → 3 (way v1 → v2)");
// v8 (vi 2): both reshaped members, in v8's own changeset.
assert.equal((mge.versionDetails.get(2) || []).length, 2);
assert.deepEqual(mge.versionDetails.get(2).map((d) => d.way), [28533841, 28533849]);
assert.equal(mge.versionDetails.get(2).find((d) => d.way === 28533849).detail, "nodes 2 → 7 (way v1 → v2)");
// Gap v8 -> v9: 457639815 extended 11 -> 13 nodes, and 28533849's node A
// moved, both in changeset 60117010 (relation version unchanged).
const gap2 = mge.gaps.get(2) || [];
assert.equal(gap2.length, 2);
assert.deepEqual(gap2.map((e) => e.way), [28533849, 457639815]);
assert.equal(gap2.find((e) => e.way === 457639815).kind, "refs");
assert.equal(gap2.find((e) => e.way === 457639815).changeset, 60117010);
assert.equal(gap2.find((e) => e.way === 28533849).kind, "moved");
assert.equal(gap2.find((e) => e.way === 28533849).changeset, 60117010);
// Tag-only way bump (999, same refs and coords) produces no event.
assert.ok(![...mge.gaps.values()].flat().some((e) => e.way === 999));
assert.ok(![...mge.versionDetails.values()].flat().some((d) => d.way === 999));
// Cap: 201 member ways -> partial, no crash.
const manyMembers = Array.from({ length: 201 }, (_, i) => ({ type: "way", ref: 1000 + i, role: "outer" }));
const manyVersions = [
  { type: "relation", id: 1, version: 1, changeset: 100, timestamp: "2008-11-21T00:00:00Z", user: "x", visible: true, tags: {}, members: manyMembers },
  { type: "relation", id: 1, version: 2, changeset: 200, timestamp: "2008-11-22T00:00:00Z", user: "x", visible: true, tags: {}, members: manyMembers },
];
const capRes = computeMemberGeometryEvents(manyVersions, new Map(), new Map());
assert.equal(capRes.partial, true);
assert.equal(capRes.gaps.size, 0);

console.log("All editor logic tests passed.");
