# pi-web-fetch

A pi extension that registers one tool, `web_fetch`: fetch a URL and return
its readable content as markdown.

- **HTML**: Readability extracts the main content, Turndown converts it to
  markdown.
- **PDF**: text extraction via `unpdf`.
- **Plain text**: returned as is.
- **JS-rendered pages**: when the extracted content is too short, falls back
  to Jina Reader (`https://r.jina.ai/`).

## Install

```bash
pi install git:github.com/novis10813/pi-web-fetch
```

pi runs `npm install` for the package. `@earendil-works/pi-*` and `typebox`
are provided by pi's extension loader and are not listed as dependencies.

## Development

```bash
npm install
pi -ne -e . -p "fetch https://example.com"
```
