# `site/` — dsh-bridge promo site

Static, framework-free, multi-page HTML site for the
**deepseek-hardness-python-bridge** project (a.k.a. `dsh-bridge`).

Pages (shallow → deep):

| File | Purpose |
| --- | --- |
| `index.html` | Hero — biggest highlight + simplest usage, up front |
| `getting-started.html` | 3-step pipeline + one-command installer, in detail |
| `decorators.html` | Every decorator → dsh surface (reference table) |
| `architecture.html` | Subprocess / JSON-RPC / codegen, with diagram |
| `verification.html` | 4-tier verification proof + honest limits |
| `roadmap.html` | Shipped / In progress / Next + non-goals |
| `community.html` | Docs index for humans + agents + cookbook + license |

## Preview locally

```sh
# from the repo root
python3 -m http.server -d site 8000
# then open http://localhost:8000/ in your browser
```

No build step. No npm install. No external CDNs. System fonts only.

## Deploy to GitHub Pages

1. Commit and push the `site/` directory to your default branch.
2. In the GitHub repo settings → **Pages**, set the source to
   `Deploy from a branch` → `main` (or your default) → `/site`.
3. Pages will serve `site/index.html` at `https://<org>.github.io/<repo>/`.

If you serve from the repo root instead, the site will mount at
`https://<org>.github.io/<repo>/site/`.

## Maintenance

The seven HTML pages share a sticky nav and a footer. They are
copy-pasted per file (no build step, no partials). When you change
the nav (e.g. add a page), update all seven files.

To enforce consistency, the same design tokens (colors, spacing,
typography) are defined once in `assets/style.css` under `:root`
as CSS custom properties.

## Editing tips

- The hero's tab switcher (decorators vs installer) is pure CSS —
  see `<input type="radio" id="tab-decorators">` in `index.html`.
- Code blocks get a hover-to-reveal "copy" button injected by
  `assets/main.js` (no syntax highlighter dependency).
- The current page is highlighted in the nav by `class="active"`
  on the matching `<a>`. `main.js` falls back to URL matching.

## What is and isn't bundled

The standalone site (`site/`) bundles only the marketing pages.
The full guides, cookbook, and skill bundle live in the **main repo**:

| In the standalone site | In the main repo only |
| --- | --- |
| The seven HTML pages | `docs/guides/human-engineer.md` (+ `.zh.md`) |
| `assets/style.css` | `docs/guides/agent-friendly.md` (+ `.zh.md`) |
| `assets/main.js` | `docs/cookbook/adding-a-python-bridge.md` (+ `.zh.md`) |
| | `skill/dsh-python-plugin/SKILL.md` + four `references/*.md` |
| | `README.md` |

For that reason, links to those resources in `community.html` and the
footer point to the GitHub view of the file (not a relative `../…` path
that would 404 when the site is served standalone). Each such link is
marked with the small `.badge-repo` "in main repo" pill.

If you want to serve the site from the repo root instead of `site/`,
run:

```sh
python3 -m http.server 8000
# then the site is at http://localhost:8000/site/
```

and you can rewrite the broken-by-design relative paths if you prefer
that mount. The GitHub URLs above will keep working either way.