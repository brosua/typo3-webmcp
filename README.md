# WebMCP for TYPO3 (experimental PoC)

[![TYPO3 14](https://img.shields.io/badge/TYPO3-14-orange.svg?style=flat-square&logo=typo3)](https://get.typo3.org/14)
[![Latest Stable Version](https://img.shields.io/packagist/v/brosua/webmcp?style=flat-square)](https://packagist.org/packages/brosua/webmcp)
[![License](https://img.shields.io/packagist/l/brosua/webmcp?style=flat-square)](https://packagist.org/packages/brosua/webmcp)
[![TER](https://img.shields.io/badge/TER-typo3__webmcp-green?style=flat-square)](https://extensions.typo3.org/extension/typo3_webmcp)

Exposes TYPO3 frontend **forms** (EXT:form, Extbase `<f:form>` and any
`<form toolname>`) and **page content** as in-browser
[WebMCP](https://github.com/webmachinelearning/webmcp) tools via
`document.modelContext`, so browser-based AI agents can discover and invoke them.

> **Status:** experimental proof of concept. Requires a native WebMCP
> implementation (Chrome 149+). Without native support the module does nothing.

## What the extension provides

| Component | Purpose |
|---|---|
| **Site Set** (`brosua/webmcp`) | Includes `webmcp.js` (ES module) and `webmcp.css` via `setup.typoscript` |
| **webmcp.js** | Registers read-only content tools on `document.modelContext` and fires `webmcp:ready` |
| **ViewHelper** (`Form\ToolAttributesViewHelper`) | Builds declarative `tool*` attributes from `renderingOptions.webmcp` for EXT:form |
| **Form configuration** (`Configuration/Form/WebMCP`) | Registers the EXT:form frontend template carrying the declarative attributes, and inspector fields for `toolname` / `tooldescription` in the backend form editor. Applies to all sites, see below |

## Requirements

- TYPO3 v14.3+ with EXT:form
- A browser with a native WebMCP implementation (Chrome 149+)

## Installation

Add the site set `brosua/webmcp` to the site. Its TypoScript adds the assets to
the `PAGE` object named `page`.

The EXT:form template is registered at `templateRootPaths.15`. A site that sets
`form.templates.templateRootPath` (index 20) or an extension registering a
higher index renders its own `Form.fluid.html` instead; add
`additionalAttributes="{webmcp:form.toolAttributes(form: form)}"` to its
`<formvh:form>` to keep the declarative attributes.

EXT:form loads the form configuration of every active extension, so the
template and the inspector fields apply to all sites of the installation, also
to those without the site set. Without the set the `tool*` attributes are
rendered, but no script highlights the forms.

## Content tools

Registered automatically on every page of a site using the set. All are
read-only (DOM only) and skip hidden content:

| Tool | Input | Effect |
|---|---|---|
| `page-find-text` | `{ query: string }` | Finds text (also across inline markup), scrolls into view, highlights |
| `page-get-content` | `{ selector?: string }` | Structured main content (headings, paragraphs, lists, table cells, quotes, links) as JSON, at most 200 blocks |

Their results are flagged with `untrustedContentHint`, as pages may contain
user-generated content.

## Site search tool

`site-search` (`{ query: string }`) submits the EXT:indexed_search form in the
background and returns the matching pages with title, URL and snippet. It is
registered when the site setting `webmcp.search.pageUid` names the page holding
the search plugin, or when the current page shows a search box.

```yaml
# config/sites/<site>/settings.yaml
webmcp:
  search:
    pageUid: 42
```

## Backend tools

Off by default. Enabled per user or group via User TSconfig, they are loaded
into the main backend document (`AfterBackendPageRenderEvent`), so they
stay registered while modules change in the content frame. They act with the
editor's session and permissions, and none of them saves anything.

| Tool | Input | Effect |
|---|---|---|
| `backend-search` | `{ query: string, limit?: number }` | Live search over pages, records and modules; returns a `ref` per result |
| `backend-open` | `{ ref?, action?, pageUid?, table?, uid? }` | Opens a search result, a page in the page module or a record in the editing form |
| `backend-prepare-record` | `{ table, pageUid?, values? }` | Opens the form for a new record prefilled via `defVals`; the editor saves it. Without `pageUid` the page open in the backend is used. The form data is compiled like FormEngine does it: only types the editor may choose and only fields the form shows (exclude fields, `TCEFORM.*.disabled`, `displayCond`, hidden palettes) are prefilled |

User TSconfig:

```typoscript
# Enable the backend tools
options.webmcp.enableBackendTools = 1
# Tables backend-prepare-record may open; filtered by the user's tables_modify
options.webmcp.prepareRecordTables = pages,tt_content
```

Everything a tool returns is passed to the agent's model provider; enable the
tools only for users whose data may leave the system. `backend-search` results
are flagged with `untrustedContentHint`, as record titles can stem from
frontend input.

## Form tools (declarative)

A `<form>` becomes a tool when it carries the `toolname` attribute. The
browser's native WebMCP implementation builds the tool from the form's controls.
Tool names consist of letters, digits, `_`, `-` and `.` (at most 128
characters); for EXT:form, other names are not rendered.
This extension renders the declarative attributes and adds:

- **Highlight while the agent fills the form** — on `toolactivated` the form
  gets the class `webmcp-form-active` and is scrolled into view; the native
  `:tool-form-active` / `:tool-submit-active` pseudo-classes are styled too.
- **The visitor always submits** — the agent fills the form, the visitor
  reviews and submits it. `toolautosubmit` is not rendered for EXT:form.

EXT:form's honeypot field is part of the form, so an agent may fill it. When
the visitor submits a form an agent has filled in (`toolactivated`), the
honeypot is cleared first. Bots posting directly still trip it.

### Extbase `<f:form>`

```html
<f:form action="submit" name="contact" object="{contact}"
        additionalAttributes="{'toolname': 'contact', 'tooldescription': 'Send us a message'}">
    <f:form.textfield property="email"
        additionalAttributes="{'toolparamdescription': 'Reply-to address'}" />
</f:form>
```

### EXT:form (YAML)

```yaml
type: Form
identifier: contact
label: Contact
prototypeName: standard
renderingOptions:
  webmcp:
    toolname: contact
    tooldescription: 'Send us a message'
renderables:
  - type: Page
    identifier: page-1
    renderables:
      - type: Text
        identifier: name
        label: Name
        properties:
          fluidAdditionalAttributes:
            toolparamdescription: 'Full name of the sender'
```

The same settings are available as inspector fields in the backend form editor.

### Plain HTML forms

```html
<form toolname="newsletter"
      tooldescription="Subscribe to the newsletter">
  <input type="email" name="email"
         toolparamdescription="The subscriber's e-mail address" required>
  <button type="submit">Subscribe</button>
</form>
```

## Extension point: register your own tools (JS)

`webmcp.js` fires `webmcp:ready` once `document.modelContext` is available and
the built-in tools are registered. The detail (also stored on
`document.__webmcpReadyDetail`) carries `{ modelContext, register }`:

```js
document.addEventListener('webmcp:ready', (e) => {
  const { modelContext } = e.detail;
  modelContext.registerTool({
    name: 'toggle-theme',
    description: 'Switch between light and dark mode.',
    annotations: { idempotentHint: true },
    inputSchema: { type: 'object', properties: { mode: { enum: ['light', 'dark'] } } },
    execute({ mode }) {
      document.documentElement.dataset.theme = mode;
      return { content: [{ type: 'text', text: `theme=${mode}` }] };
    },
  });
});
```

## Known limitations

- Not a production feature; APIs mirror the WebMCP draft and may change.
- **A native WebMCP browser is required** (Chrome 149+). Without it the
  `tool*` attributes are rendered but nothing registers them (no shim).
- The content tools skip hidden, off-screen, clipped (`.sr-only`), tiny and
  transparent text, but not text in the colour of its background.
- `site-search` snippets come from the search index, which also contains text
  that pages hide visually; the results are flagged with `untrustedContentHint`.
