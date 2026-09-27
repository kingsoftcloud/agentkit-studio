# AgentKit Studio visual system

## Direction

AgentKit Studio uses an **industrial-cloud** direction: a calm enterprise canvas, a
deep ink foundation, and one sharp teal signal for active execution. The visual language
should feel like an operations console for building and running agents, not a generic chat
application.

The official DSH shell remains the chrome and typography owner. Studio styles are scoped to
Studio panels, cards, badges, and domain artwork so the plugin does not change DSH's global
appearance or create a second design system for the conversation UI.

## Logo

The mark is an original geometric `A` built from a continuous roof/terminal silhouette. The
inner cut-out is the execution signal: a small open path that reads as both an agent and a
compiled unit. It is used as a 16–24px navigation mark and as a 48–64px panel identity mark.

The distributable Web/Desktop build sets `DSH_CLIENT_TITLE=AgentKit Studio` so the browser or
window title follows the same product identity as the visible sidebar brand row. The checked-in
DSH development dist may still show its fallback title until that release build is produced.

```text
      /\
     /  \
    /_()_\
   /      \
```

The canonical path is exported from `src/brand.js`, and the first app-icon candidate is kept at
`assets/agentkit-studio-mark.svg`. Do not use the Kingsoft Cloud corporate logo as a substitute;
product branding and corporate marks have separate approval paths.

## Palette

| Token | Value | Use |
| --- | --- | --- |
| Ink | `#0b1220` | headings, active dark surfaces |
| Ink muted | `#526174` | secondary text |
| Canvas | `#f6f9fc` | Studio page background |
| Surface | `#ffffff` | cards and forms |
| Border | `#dbe5ef` | low-contrast structure |
| Accent | `#0aa6a6` | active state, links, primary action |
| Accent strong | `#087f86` | hover/pressed accent |
| Accent soft | `#dff7f4` | selected and informational surfaces |
| Signal | `#f0ad4e` | queued/waiting state |
| Danger | `#c44747` | failed/cancelled state |

The palette follows a 70/20/10 balance: canvas/surfaces dominate, ink establishes hierarchy,
and teal is reserved for action and live state. Status colors are semantic and never replace
the text label.

## Component rules

- Use the official DSH conversation, tool, Goal, and Dock components without restyling them.
- Studio domain cards use 10–12px radii, 1px borders, and one accent edge or badge rather than
  large gradients or glass effects.
- The global Studio panel may use a faint diagonal grid or signal line as atmosphere; keep it
  behind content and respect reduced motion.
- Every status has text, a color, and an accessible label. A color alone never communicates
  health, capability, or deployment state.
- The Studio mark must remain legible at 16px, in light and dark DSH themes.

## Accessibility and host compatibility

- Keep body and control contrast at WCAG AA or better.
- Inherit DSH's font stack and density for controls and conversation surfaces.
- Scope custom CSS/inline variables below `[data-agentkit-studio]` or component roots.
- Support `prefers-reduced-motion` and do not animate live Session events in the domain page.
