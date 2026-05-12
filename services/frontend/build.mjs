// Bundles the SPA: src/app.js + its npm deps (Leaflet, fetch-event-source)
// → dist/app.js as a single IIFE. Leaflet's marker images are imported as
// asset URLs (the `file` loader copies them into dist/ with hashed names and
// rewrites the imports to `/marker-icon-<hash>.png`), which is the standard
// fix for Leaflet's broken default icon paths under a bundler. The CSS
// (Tailwind + Leaflet's own stylesheet) is built separately by the Tailwind
// CLI — see package.json's "build" script.
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/app.js"],
  bundle: true,
  format: "iife",
  target: "es2020",
  outdir: "dist",
  publicPath: "/",
  loader: { ".png": "file" },
  logLevel: "info",
});
