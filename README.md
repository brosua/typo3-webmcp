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
| **Middleware** (`WebMcpInjectionMiddleware`) | Registers `webmcp.js` as ES module via TYPO3 AssetCollector |
| **webmcp.js** | Registers read-only content tools on `document.modelContext` and fires `webmcp:ready` |
| **ViewHelper** (`Form\ToolAttributesViewHelper`) | Builds declarative `tool*` attributes from `renderingOptions.webmcp` for EXT:form |
| **Site Set** (`brosua/webmcp`) | Overrides the EXT:form frontend template so the `<form>` tag carries the declarative attributes |
| **Form editor config** | Inspector fields for `toolname` / `tooldescription` in the backend form editor |

## Requirements

- TYPO3 v14.3+
- A browser with a native WebMCP implementation (Chrome 149+)

## Content tools

Registered automatically on every page. All are read-only (DOM only):

| Tool | Input | Effect |
|---|---|---|
| `page-get-summary` | `{}` | Title, meta description, language, URL, heading outline |
| `page-find-text` | `{ query: string }` | Finds text, scrolls into view, highlights |
| `page-get-content` | `{ selector?: string }` | Structured main content (paragraphs, lists, links) as JSON |
| `page-list-actions` | `{}` | Available tools and primary navigation links |

## Form tools (declarative)

A `<form>` becomes a tool when it carries the `toolname` attribute. The
browser's native WebMCP implementation builds the tool from the form's controls.
This extension only **renders the declarative attributes** — the native
implementation handles everything else.

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
    autosubmit: false
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
      tooldescription="Subscribe to the newsletter"
      toolautosubmit>
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
