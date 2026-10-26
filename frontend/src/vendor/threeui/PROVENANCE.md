# ThreeUI registered sources

Retrieved September 13, 2026:
- https://threeui.com/source-code/predictive-arc.json
- https://threeui.com/source-code/sylva-living-world.json

All registered file contents were saved verbatim and validated against the SHA-256 values supplied in each bundle and the user request. Shared CSS is identical in both bundles. The selected runtime entries use the exact configured props: PredictiveArcCanvas data-pixel, dark, speed 1, hue 0, saturation 1, brightness 1; SylvaLivingWorldScene living-green.

The local Vite alias exposes these entries as @designcodeio/threeui and its shared stylesheet. No documentation page is embedded. Sylva's sandboxed srcDoc iframe is part of its authored implementation and embeds its bundled Three.js r149 runtime.

The registered predictive bundle references additional unselected variants. Supplemental raw HTML strings were recovered from the official @designcodeio/threeui 1.2.0 npm distribution for dependency resolution. The collection entry is preserved but not used; its unselected recursive-erosion and synthesis-orb sources are absent from that npm release. The selected PredictiveArcCanvas entry and all of its runtime dependencies are present. Registered source files are unmodified.

MIT license retained in LICENSE. Three.js retains its embedded MIT notice. Decorative scene mounting and reduced-motion fallbacks are controlled by the host page, outside the authored components.

The Sylva stylesheet's referenced `inner-green-assets/lexend-latin.woff2` was copied from the official npm package to that exact public asset path. Static font CORS headers are supplied by the Vite development/preview middleware and the existing Vercel configuration, permitting the authored opaque-origin iframe to load it. Font notices are retained in FONT-LICENSES.md.
