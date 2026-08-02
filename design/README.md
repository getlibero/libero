# Libero design system

The implementation of the locked design spec. Source of truth for the brand, the
colour pairs, the type scale, and the component shapes — used by the README, the
site, and anything that later renders a Libero surface.

Open `index.html` in a browser. No build step, no dependencies, no framework.

```
design/
  tokens.css     colour + type + radius tokens. Verbatim mirror of the design project.
  libero.css     component layer built on the tokens. The system itself.
  index.html     the reference page: every token and component, live, in both modes.
  brand/         mark, lockup, and app icons as standalone SVG.
```

`brand/app-icon-fullbleed.svg` is the app icon without its corner radius, for
hosts that mask icons themselves — Slack workspace icons, avatar crops. Where
nothing rounds it, use `app-icon.svg`. `app-icon-fullbleed-1024.png` is its
raster render, for hosts that reject SVG uploads.

## Where it comes from

The canonical spec is `Libero Design System.dc.html` in the Claude Design project
[Libero Design System](https://claude.ai/design/p/1809cf6a-8009-4d06-99f1-74e8d94c727a),
alongside `libero-tokens.css`. That spec is **locked**: don't introduce new
colours, fonts, radii, or component shapes here. Change the spec, then re-sync.

`tokens.css` is a verbatim copy of the project's `libero-tokens.css` — treat it
as generated. Values the spec *uses* but never *names* (status borders, hover
washes, the two intermediate text weights) are transcribed into a clearly marked
derived-token block at the top of `libero.css`; if the upstream token file ever
names them, delete them from there.

## Using it

```html
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="libero.css">
```

Dark is the default and needs no attribute. Light is a peer, opted into on the
root element:

```html
<html>                      <!-- dark -->
<html data-theme="light">   <!-- light -->
```

Reference tokens by name, never by hex. `--lb-accent` (#1BA85A),
`--lb-accent-ink` (#06120B) and the type stack are identical in both modes — an
Approve button is pixel-identical either way. Only surfaces, text, washes, and
the `--lb-accent-text` contrast alias swap.

## Slack

The workspace wears the dark tokens. Icon: `brand/app-icon-fullbleed-1024.png`.
Sidebar theme — paste into Preferences → Themes → Custom:

```
#0B0F0E,#131A18,#1BA85A,#06120B,#1B2422,#E8EFEC,#1BA85A,#F5B544
```

In Slack's slot order: bg-canvas, bg-surface, accent, accent-ink, bg-raised,
text, accent, warn. Hex because Slack can't read a token; change a token, redo
the string. The mention badge is warn, not danger — a mention is a human that
still has to click, not something blocked.

## The rules the CSS encodes

- **Colour is status, not decoration.** Green = allowed and executed, amber =
  awaiting a human, red = blocked. Nothing else on screen is coloured.
- **Elevation.** Dark lifts a surface by getting lighter (canvas → surface →
  raised); light lifts by gaining a hairline. No shadows, no gradients, in
  either mode. `.lb-raise` is the one place this branches on mode.
- **Type.** IBM Plex Sans for language, IBM Plex Mono for anything a machine
  produced — tool names, timestamps, hashes, money, labels.
- **Shape.** Radii 7 / 10 / 14px only. Buttons pad 10×18, rows 11×14.
- **Icons.** 24px grid, 1.6 stroke, round caps and joins, no fills, stroke
  inherits `--lb-text-muted`.
- **Copy.** Plain, terse, technical. Name the tool call. State what is and isn't
  permitted. No exclamation marks, no emoji, no "AI magic" language.

## Two places this deviates from the source file

Both are deliberate; raise them upstream if you disagree.

1. **Radii are normalised to the tokens.** The spec page hard-codes 8px buttons
   and 16px cards in a few spots, but its own shape rule and `libero-tokens.css`
   say 7 / 10 / 14. The tokens win, so buttons are 7 and cards are 14.
2. **Light-mode accent hover is #158A49.** `libero-tokens.css` says
   `--lb-accent-hover` is inherited unchanged into light (#22C46B, a *lighter*
   green); the canonical `.dc.html` darkens it instead. The `.dc.html` is
   labelled canonical, so it wins — see the derived-token block in `libero.css`.

## Not a shipping surface

Section 05 of `index.html` is a console composition mock, kept because it proves
the tokens compose. Per [ARCHITECTURE.md](../docs/ARCHITECTURE.md), a web admin
UI is an explicit non-goal for v1: the team sheets in git *are* the admin UI.
