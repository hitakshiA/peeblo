# Peeblo frontend

An animated landing page for an autonomous accounts receivable teammate. Adapted from the user's Manthan frontend; original source attribution is in `../FRONTEND_IMPORT.md` and the preserved Apache license. The previous landing implementation is retained in `reference/ManthanLanding.tsx`.

## Run

```sh
npm ci
npm run dev -- --host 127.0.0.1
```

Open http://127.0.0.1:5173/. No credentials or backend are required for the landing page.

## What works

- Responsive Peeblo landing page with the original Geist / Instrument Serif typography and dark editorial layout language.
- Looping four-scene Northstar animation with drawn outlines, typed fields, cursor motion, and replay.
- Seamless eight-app marquee with rotating selection, plus three domain responsibility examples.
- Two original generated still-life assets and two five-second Seedance 2.0 loops, silent and optimized for web playback.
- Exact supplied ThreeUI Data Pixel Arc and Living Green source integrations.
- Viewport-aware media, reduced-motion fallbacks, keyboard focus and automatic reduced-motion support.

The business case is illustrative; no financial action is executed. App connections, Arga validation and Lemma tracing are planned. The original `/app` workspace remains imported and backend-dependent.

## Source and media records

- `src/vendor/threeui/PROVENANCE.md`: source bundles, SHA-256 verification, license and dependency notes.
- `public/images/PROVENANCE.md`: exact image-generation prompts and brand-mark sources.
- `output/video/RESEARCH.md`: Exa research, model choice and estimated cost.
- `output/video/*-prompt.txt`: exact video prompts.
- `output/video/*-raw.mp4`: original returned videos.
- `public/videos/*.mp4`: silent H.264 web derivatives.
- `output/verification/`: browser screenshots and frame contact sheets.

Video generation uses `scripts/generate-loop.mjs` with `TOGETHER_API_KEY` supplied in the shell. Existing job records prevent accidental duplicate submissions. Never put this credential in a frontend environment variable. No key is saved in this project.

## Verification

`npm run build` produces the production bundle. Repository-wide typechecking still reports existing errors in untouched imported app pages; the landing redesign introduces no additional diagnostics. The authored Sylva component includes a substantial Three.js runtime and procedural geometry, so its lazy-loaded chunk is large and software-rendered browsers can be slow during its entrance.
