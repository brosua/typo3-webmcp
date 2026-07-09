# WebMCP for TYPO3 (experimental PoC)

Exposes TYPO3 frontend **forms** (EXT:form, Extbase `<f:form>` and any
`<form toolname>`) and **page content** as in-browser
[WebMCP](https://github.com/webmachinelearning/webmcp) tools via
`document.modelContext`, so browser-based AI agents can discover and invoke them.

The client implements the WebMCP
[declarative API](https://github.com/webmachinelearning/webmcp/blob/main/declarative-api-explainer.md)
for forms **natively**: the extension renders the standard `toolname` /
`tooldescription` / `toolparamdescription` / `toolautosubmit` attributes onto the
`<form>` and its controls, and the browser's native WebMCP implementation turns
them into tools. No JavaScript bridge is involved for forms.

> Status: experimental proof of concept. This integration requires a native
> WebMCP implementation (Chrome 149+): both the declarative form tools and the
> read-only **content tools** are only exposed when the browser provides
> `document.modelContext`. Without native support the module does nothing.

## How it works

A frontend PSR-15 middleware (`WebMcpInjectionMiddleware`) registers a JS module
plus a JSON config island with the TYPO3 **AssetCollector**, so the `PageRenderer`
emits them into the page (cache-busted URLs, deduplicated, CSP-nonce aware).
Registration happens *before* the page is rendered, so cached pages are covered
too. In the browser the module (`webmcp.js`):

- registers read-only **content tools** on the native `document.modelContext`
  (and does nothing if the browser has no native WebMCP implementation);
- fires a `webmcp:ready` event so integrator scripts can register their own tools.

Declarative **form tools** are not handled by this module: the browser's native
WebMCP implementation reads the `tool*` attributes that TYPO3 renders on the
`<form>` (see below) and exposes them itself.

## Requirements

- TYPO3 v14.3+
- A browser with a native WebMCP implementation (Chrome 149+) — required for
  both form and content tools.

## Content tools

All content tools operate solely on the DOM of the current page and are read-only:

| Tool                | Input                   | Effect                                                          |
|---------------------|-------------------------|----------------------------------------------------------------|
| `page-get-summary`  | `{}`                    | Title, meta description, language, URL, heading outline        |
| `page-find-text`    | `{ query: string }`     | Finds text, scrolls it into view and highlights it             |
| `page-get-content`  | `{ selector?: string }` | Structured main content (paragraphs, lists, links) as JSON     |
| `page-list-actions` | `{}`                    | Available forms / buttons / links with their tool names        |

## Form tools

A `<form>` becomes a tool when it carries the official `toolname` attribute; the
browser's native WebMCP implementation builds the tool and its input schema from
the form's controls. This extension's job is only to **render the declarative
attributes** — on plain HTML forms you write them yourself, for EXT:form and
Extbase forms the sections below show how to emit them.

Because the native implementation drives the real form, hidden/technical fields
(CSRF tokens, Extbase `__trustedProperties` / `__referrer`, honeypots) stay
intact and are submitted unchanged.

### Extbase `<f:form>`

Add the declarative attributes via `additionalAttributes` on `<f:form>` and
`toolparamdescription` on the fields:

```html
<f:form action="submit" name="contact" object="{contact}"
        additionalAttributes="{'toolname': 'contact', 'tooldescription': 'Send us a message'}">
    <f:form.textfield property="email"
        additionalAttributes="{'toolparamdescription': 'Reply-to address'}" />
</f:form>
```

## Declarative API markup (non-EXT:form / non-Extbase forms)

Any other `<form>` is exposed by adding the standard WebMCP declarative
attributes. The control's `name` becomes the schema property and
`toolparamdescription` its description:

```html
<form toolname="newsletter"
      tooldescription="Subscribe to the newsletter"
      toolautosubmit>
  <input type="email" name="email"
         toolparamdescription="The subscriber's e-mail address" required>
  <button type="submit">Subscribe</button>
</form>
```

- `toolname` (required) turns the form into a tool; `tooldescription` describes it.
- `toolparamdescription` on a control supplies its property description.
- `toolautosubmit` (boolean) lets the agent submit the form after filling it.
  Without it, the tool only fills the form, focuses the submit button
  (`:tool-submit-active`) and leaves submission to the user.

## EXT:form

Declare the tool on the **root form** with a `renderingOptions.webmcp`
block, and describe fields with
`properties.fluidAdditionalAttributes.toolparamdescription`:

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

### Backend form editor

The same settings are available as inspector fields in the backend form editor.


## Extension points

### JS: register your own tools

`webmcp.js` fires `webmcp:ready` once `document.modelContext` is available and the
built-in tools are registered. The event detail (also stored on
`document.__webmcpReadyDetail` for late-loading scripts) carries
`{ modelContext, config, register }`:

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

### PHP: `ModifyWebMcpConfigEvent` (PSR-14)

Dispatched right before the `#webmcp-config` JSON is serialized. Listeners can
tweak any config value per request/site/user and queue additional client-side JS
tool modules (each an `EXT:` path, injected as `<script type="module">` right
after the core module):

```php
final class MyWebMcpTools
{
    #[\TYPO3\CMS\Core\Attribute\AsEventListener('my-ext/webmcp')]
    public function __invoke(\Brosua\Webmcp\Event\ModifyWebMcpConfigEvent $event): void
    {
        $event->addModule('EXT:my_ext/Resources/Public/JavaScript/webmcp-tools.js');

        $config = $event->getConfig();
        $config['features']['content'] = false; // e.g. disable content tools on this page type
        $event->setConfig($config);
    }
}
```

## Known limitations

- Not a production feature; the client APIs (`getTools()`, `executeTool()`) mirror
  the WebMCP draft and may change.
- **A native WebMCP browser is required** (Chrome 149+). Without it neither the
  form tools nor the content tools are exposed — the `tool*` attributes are still
  rendered, but nothing registers them (there is no shim).
