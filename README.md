# WebMCP for TYPO3 (experimental PoC)

Exposes TYPO3 frontend **forms** (EXT:form, Extbase `<f:form>` and any
`<form data-webmcp>`) and **page content** as in-browser
[WebMCP](https://github.com/webmachinelearning/webmcp) tools via
`document.modelContext`, so browser-based AI agents can discover and invoke them.

> Status: experimental proof of concept. WebMCP is an early W3C proposal without
> shipping browser support yet. This extension therefore installs a small shim
> and a debug overlay so the tools can be inspected and executed **without** a
> native browser agent.

## How it works

A frontend PSR-15 middleware (`WebMcpInjectionMiddleware`) registers a JS module
plus a JSON config island with the TYPO3 **AssetCollector**, so the `PageRenderer`
emits them into the page (cache-busted URLs, deduplicated, CSP-nonce aware).
Registration happens *before* the page is rendered, so cached pages are covered
too. In the browser the module (`webmcp.js`):

- installs a `document.modelContext` shim when no native implementation exists;
- registers read-only **content tools** for the current page;
- registers a **form tool** for every recognised `<form>`, deriving a JSON input
  schema from the visible fields;
- fires a `webmcp:ready` event so integrator scripts can register their own tools;
- renders an optional **debug overlay** (bottom-right) listing all tools with a
  "Run" button.

Assets are only injected in a **secure context**: over HTTPS, or on local
development hosts (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`). Plain HTTP on
any other host is skipped, because WebMCP requires a secure context.

## Requirements

- TYPO3 v14.3+ / v15 dev
- `typo3/cms-frontend`
- EXT:form is optional (suggested) — Extbase and declared forms work without it.

## Configuration

Extension configuration (Admin Tools › Settings › Extension Configuration, or
`ext_conf_template.txt`):

| Setting       | Default | Effect                                                                             |
|---------------|---------|------------------------------------------------------------------------------------|
| `debug`       | `0`     | Renders the on-page debug overlay listing all tools. Keep **off** in production.   |
| `submitForms` | `0`     | Allows form tools to actually submit the underlying form after filling it. When off, forms are only **filled** for human review. |

## Content tools

All content tools operate solely on the DOM of the current page and are read-only:

| Tool                | Input                   | Effect                                                          |
|---------------------|-------------------------|----------------------------------------------------------------|
| `page-get-summary`  | `{}`                    | Title, meta description, language, URL, heading outline        |
| `page-find-text`    | `{ query: string }`     | Finds text, scrolls it into view and highlights it             |
| `page-get-content`  | `{ selector?: string }` | Structured main content (paragraphs, lists, links) as JSON     |
| `page-list-actions` | `{}`                    | Available forms / buttons / links with their tool names        |

## Form tools

Each recognised `<form>` gets one `form-{name}` tool. A form is matched by the
first applicable adapter (specific before generic):

| Adapter    | Match                                                                       |
|------------|-----------------------------------------------------------------------------|
| `extform`  | a field named `tx_form_formframework…`                                       |
| `extbase`  | a hidden `…[__trustedProperties]` field **or** a `tx_…[__referrer]` field   |
| `declared` | the `<form>` carries a `data-webmcp` attribute                               |

**Security invariant:** adapters only ever set values of **existing, visible**
fields. Hidden/technical fields (`__*`, CSRF tokens, Extbase `__trustedProperties`
and `__referrer`, honeypots, `type=hidden`/`password`/`file`) are never added to
the schema and are submitted **unchanged** with the real form. This keeps all
security tokens and Extbase property whitelisting intact.

### Extbase `<f:form>`

Extbase forms are detected automatically via their `__trustedProperties` /
`__referrer` fields — no markup changes needed. The adapter strips the
`tx_<ext>_<plugin>` namespace prefix so the tool schema shows clean keys
(`contact.name`, `contact.email`, …). The tool name is derived from
`data-webmcp-name`, else a `<legend>`/heading inside the form, else the plugin
namespace, else `form-N`.

## Opt-in markup (non-EXT:form / non-Extbase forms)

Any other `<form>` can be exposed by adding attributes:

```html
<form data-webmcp
      data-webmcp-name="newsletter"
      data-webmcp-description="Subscribe to the newsletter">
```

- `data-webmcp="off"` on a `<form>` **excludes** it from exposure.
- `data-webmcp-ignore` on a single input **skips** that field.

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
        $config['features']['forms'] = false; // e.g. disable form tools on this page type
        $event->setConfig($config);
    }
}
```

## Known limitations

- Not a production feature; the client APIs (`getTools()`, `executeTool()`) mirror
  the WebMCP draft and may change.
- Forms are **filled** but only **submitted** when `submitForms` is enabled;
  submit-capable form tools are flagged with `destructiveHint` so an agent/overlay
  can ask for confirmation. Multi-step forms are filled but never auto-advanced.