<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Peeblo site

The landing page for Peeblo. One page, statically rendered, deployed on Vercel at peeblo.xyz.

## Commands
- `npm run dev` starts the dev server
- `npm run check` runs lint, typecheck and a production build

## Layout
- `src/app`: layout, page, global CSS (`globals.css`, `peeblo.css` holds the tokens and shared classes)
- `src/components/sections`: one file per page section, each with its CSS module
- `src/components/peeblo`: shared pieces (avatar, critter, receipt, signature kit, cursor effects)
- `src/content`: crew, models, integrations, links
- `src/avatars`: Open Bot Avatar definitions, plus Peeblo's own
- `public`: logos, model marks, people photos

## Rules
- TypeScript strict, named exports, 2-space indent
- Plural copy: teammates, employees, crew
- Teammates on the page are examples; there is no premade crew
- Respect `prefers-reduced-motion` in every animation
