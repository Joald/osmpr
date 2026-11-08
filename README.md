# OSMPR

OSMPR stands for OpenStreetMap Pull Request.

A single-file, zero-dependency, zero-backend editor for OpenStreetMap
relation member edits, tag edits, and geometry edits. It turns an edit into a
shareable link: open the link, review the diff, click Upload.

## How it works

1. Someone builds a link with the intended change encoded in the URL
   (see [Link format](#link-format)).
2. You open it. The page fetches the current objects from the OSM API
   (public read), applies the encoded operations, and shows a diff
   preview: added members, removed members, tag changes. Each prefill
   object card has a Preview / Diff / Raw / Map switch: Diff shows a
   GitHub-style unified diff, Raw shows the change JSON, Map draws the
   object on OpenStreetMap tiles and highlights geometry changes.
   Changeset cards have Preview / Diff / Map (no Raw: there is no
   custom-format change object to show, only the before/after states).
   In changeset view the cards are grouped into collapsible
   Nodes / Ways / Relations sections, and an overview map between
   the changeset description and the cards shows every changed
   object on one map (nodes, ways, and relation member ways).
   Prefill view has the same overview map above its cards: it sums
   the whole pending change (current state against the computed new
   state), filling in as each object loads.
3. You click **Upload**. The page creates one changeset, uploads every
   changed object, and closes the changeset. A toast confirms the
   upload, and the page switches to the new changeset's view. A failed
   upload shows a persistent error toast instead (it stays until you
   close it, and links the failed changeset when one was created).

An existing changeset can be viewed the same way: open
`?changeset=<id>`, or paste an id or changeset URL in the page header.

After the first login, a typical edit is two clicks: open the link,
click Upload.

## Token storage

- Access token + refresh token live in `localStorage` on the page's
  origin only. They persist across sessions on the same browser and
  device, and the page refreshes an expired access token automatically
  before uploading.
- Tokens are never sent anywhere except `openstreetmap.org` itself
  (the OAuth token endpoint and the API). They are never in a URL
  and never in the repository. The editor itself is this one audited
  file; the Map view additionally loads Leaflet (JS + CSS) from CDN
  and map tiles from `tile.openstreetmap.org`, only the first time
  Map is opened — neither receives any token.
- **Log out** on the page wipes both tokens. You can also revoke
  access anytime from OSM My Settings → Authorized applications.
- Limitation: login needs the **https** hosted URL. Opening the file
  directly (`file://`) can preview diffs, but OSM cannot redirect an
  OAuth flow back to a `file://` URL, so login will not complete from
  a local file. Use the hosted URL for uploads.
- The page requests only the `write_api` scope (least privilege). It
  does not fetch your username, which would need an extra scope.

## Link format

Primary format — one URL parameter `d` with base64url-encoded JSON
(UTF-8). No full geometry, no full member lists: only the operations.
The page fetches the current objects from the OSM API and applies them.

```json
{
  "comment": "Changeset comment",
  "changes": [
    {
      "type": "relation", "id": 1234567, "version": 42,
      "add":    [{ "type": "relation", "id": 7654321, "role": "subarea" }],
      "remove": [{ "type": "relation", "id": 7654321, "role": "subarea" }],
      "tags":   { "name": "New name", "old_key": null }
    }
  ]
}
```

Rules:

- `version` is optional. If present and the live version differs,
  upload is blocked until you click **Rebase** (refetch + re-apply).
- `add` entries already present (same type + id + role) are skipped
  with a note; `remove` entries not present produce a warning.
  Neither is fatal.
- `remove` without a `role` matches any role for that type + id.
  `tags` value `null` deletes the tag.
- Member operations only apply to relations. Tag operations apply to
  nodes, ways, and relations.
- Geometry: a node change may set `lat` and `lon` (both, decimal
  degrees); a way change may set `nodes` (array of node ids). Invalid
  geometry is ignored with a warning.
- New objects: use a negative id (e.g. `-1`) in a change. The object
  is created on upload (creates go first, then modifies with
  placeholder references remapped to the real ids). Other changes
  can reference it by that id — list created objects before the
  changes that reference them.
- Delete an object: set `"delete": true` in a change. Upload sends
  DELETE after creates and modifies. The object must not be used by
  another object, or the server refuses (412). Other operations in
  the same change are ignored.
- Upload is disabled when every computed object is unchanged, so
  re-opening an already-applied link cannot re-upload it.

Simple format for a single relation (no JSON):

```
?rel=1234567&v=42&add=rel:7654321:subarea&comment=…
```

`add`/`del` may repeat; a member spec is `type:id[:role]` with type
`n`/`w`/`r` or `node`/`way`/`relation`. If both `d` and `rel` are
present, `d` wins.

## Safety features

- Preview shows added members (green) and removed members (red);
  unchanged members are omitted. Each object card has a
  Preview / Diff / Map switch (prefill cards also have Raw): Diff is a
  GitHub-style unified diff with line numbers, whole changed lines
  tinted, and unchanged lines collapsed by default; geometry changes
  show in a Geometry section (node positions, way node lists), and
  Preview summarizes them as Geometry changed. Map draws the
  object on OpenStreetMap tiles (Leaflet, loaded from CDN on first
  use) and highlights old vs new geometry. Sections (Tags, Members)
  have a separator and a chevron to collapse them.
- The changeset overview map reuses one batched node-coordinate
  fetch and one fetch per external relation member way (capped at
  200), instead of one fetch per card. The prefill view uses the
  same map live: both sides start from today's coordinates, and
  a node moved by the pending change draws at its old position
  on the old side and its new position on the new side (created
  nodes only on the new side, deleted nodes only on the old side).
  Coordinates without a real
  lat/lon (e.g. a deleted node referenced by a way) are skipped
  instead of breaking the map, and the renderers drop any
  remaining invalid points, so one bad drawable never wipes the
  whole map. Clicking a drawn element opens a popup naming the
  object (with its change kind, and the relation for an external
  member way) with a "Scroll to card" button; the click itself
  never scrolls, only the button does, and the target card is
  expanded if its group was collapsed, then briefly highlighted.
  The popup and hover tooltip use the page dark theme. A changed
  way is drawn segment by segment (consecutive node pairs
  matched as a multiset): unchanged segments grey, removed
  segments red, added segments green — never the whole new way
  in green on top of the whole old way in red. Lines that coincide
  exactly (a way both added and removed, the same member way drawn
  by two relations) are offset sideways by a few metres, so each
  stays visible and clickable instead of hiding under the top one.
- Diff views show 3 lines of context around each change; the
  rest of an unchanged run collapses behind one expander, and
  expanding it reveals the lines and removes the expander button.
- Previous versions are fetched for every modified object, in
  batches of 100 so a large changeset never hits the API with
  hundreds of requests at once. The page renders immediately;
  each card swaps its loading state for the real diff as its
  batch arrives, and the overview map updates its layers after
  each batch (the map itself is created once, so pan/zoom are
  not reset by an update).
- Tag diffs listed separately; unchanged tags hidden.
- Version conflicts block upload until Rebase.
- A prefill object deleted on OSM (API 410) is reported as an
  invalid link — the object no longer exists — and blocks upload.
- **Show osmChange XML** and **Download .osc** for inspection before
  uploading.
- If an upload fails midway, the page tries to close the changeset
  automatically, so nothing is left dangling silently.

## Development

```sh
node test.mjs   # pure-logic tests: prefill parsing, applyOps, diff, XML
```

No build step, no dependencies. Open `index.html` from any static
host for preview-only use; uploads need https + the registered
redirect URI.

## Hosting (GitHub Pages)

Settings → Pages → Build and deployment → Source: **Deploy from a
branch** → Branch: `main`, folder `/ (root)` → Save. The editor is
then live at https://joald.github.io/osmpr/ .
