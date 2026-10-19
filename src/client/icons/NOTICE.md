# Vendored icon subset

## Material Icon Theme 5.39.0

- Upstream: https://github.com/material-extensions/vscode-material-icon-theme
- Official release: https://registry.npmjs.org/material-icon-theme/5.39.0
- Archive: https://registry.npmjs.org/material-icon-theme/-/material-icon-theme-5.39.0.tgz
- Source revision: `92a9c5b25a5f4ae4c6a475fb99e434caffef5871`
- License: MIT; the unmodified full notice is in [material/LICENSE](<material/LICENSE>).
- This bounded subset contains 72 unmodified SVGs, including the **generated** closed/open folder pairs from the published npm archive. These pairs are not assumed to exist in the source repository.
- Brand artwork keeps its original geometry and colors. Open-source copyright permission does not confer endorsement or trademark rights.

## Lucide Static 0.468.0

- Upstream: https://github.com/lucide-icons/lucide
- Official release: https://registry.npmjs.org/lucide-static/0.468.0
- Archive: https://registry.npmjs.org/lucide-static/-/lucide-static-0.468.0.tgz
- License: ISC plus the included Feather-derived MIT notice, retained in full in [lucide/LICENSE](<lucide/LICENSE>).
- Seventeen static SVG geometries are represented as React elements in [ui-icons.jsx](<ui-icons.jsx>), with the shared stroke width adjusted to 1.7 for the compact desktop interface. No runtime icon library is installed.
- The Select additionally uses `check`, `chevron-down`, and `chevron-up` from the same upstream version; hashes of their upstream SVG bytes are recorded under `upstreamSha256` in [provenance.json](<provenance.json>).

## Integration and safety

- npm SHA512 archive integrity and per-asset SHA256 hashes are recorded in [provenance.json](<provenance.json>).
- Only the selected trusted assets are included. No third-party package scripts or JavaScript were executed to obtain them.
- esbuild embeds file SVGs as `data:` URLs. Controls render static React SVG elements. There are no CDN, font, or runtime network requests.
- Repository filenames resolve through the bounded lookup in [file-icons.mjs](<../file-icons.mjs>); they never become asset URLs, imports, SVG, or HTML. Unknown entries get generic local icons.
- Icons beside visible labels are decorative; controls keep their own accessible names. File labels, chevrons, `aria-current`, and `aria-expanded` carry meaning without relying only on color.
- Both full licenses are appended to the generated bundle's third-party notices by [notices.mjs](<../../../scripts/notices.mjs>).
