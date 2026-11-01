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
3. You click **Upload**. The page creates one changeset, uploads every
   changed object, and closes the changeset. A toast confirms the
   upload, and the page switches to the new changeset's view.

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
- Tag diffs listed separately; unchanged tags hidden.
- Version conflicts block upload until Rebase.
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
