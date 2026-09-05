/**
 * The web UI's static files, inlined into the binary. `bun run build:ui`
 * writes the two generated files; the logo is the repository's own mark.
 */
import appCss from "./generated/app.css" with { type: "text" };
import appJs from "./generated/app.js" with { type: "text" };
import logoPath from "../../docs/logo.png" with { type: "file" };

export const UI_APP_JS: string = appJs;
export const UI_APP_CSS: string = appCss;
export const UI_LOGO_PATH: string = logoPath;

export const UI_INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Capshelf</title>
<link rel="icon" href="/logo.png">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div id="app"></div>
<script type="module" src="/app.js"></script>
</body>
</html>
`;
