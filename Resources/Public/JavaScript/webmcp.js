/*
 * WebMCP (experimental) — TYPO3 frontend integration.
 *
 * Exposes the current page's content as read-only WebMCP tools via
 * `document.modelContext`.
 *
 * Declarative form tools are handled entirely by the browser's native WebMCP
 * implementation: `<form>` elements that carry the declarative attributes
 * (`toolname`, `tooldescription`, `toolparamdescription`, `toolautosubmit`) are
 * turned into tools by the user agent itself. TYPO3 only renders those
 * attributes (see the EXT:form integration); no JavaScript bridge is required.
 *
 * This module only registers its content tools when the browser exposes a
 * native `document.modelContext` (Chrome 149+). Without native support it does
 * nothing — there is no shim.
 *
 * Spec references:
 *   https://github.com/webmachinelearning/webmcp
 *   https://github.com/webmachinelearning/webmcp/blob/main/declarative-api-explainer.md
 */

const CONFIG = readConfig();

const state = {
    /** @type {Array<{descriptor: object, exposedTo: (string|null)}>} */
    tools: [],
};

bootstrap();

function readConfig() {
    const el = document.getElementById('webmcp-config');
    const fallback = { features: { content: false } };
    if (!el) {
        return fallback;
    }
    try {
        return { ...fallback, ...JSON.parse(el.textContent || '{}') };
    } catch {
        return fallback;
    }
}

function bootstrap() {
    // Native-only: without document.modelContext there is nothing to register.
    if (!document.modelContext) {
        return;
    }

    if (CONFIG.features?.content) {
        registerContentTools();
    }
    announceReady();
}

/**
 * Signals that document.modelContext is ready and the built-in tools have been
 * registered. The detail is also stored on the document so integrator scripts
 * that load later can pick it up without missing the event.
 */
function announceReady() {
    const detail = { modelContext: document.modelContext, config: CONFIG, register };
    document.__webmcpReadyDetail = detail;
    document.dispatchEvent(new CustomEvent('webmcp:ready', { detail }));
}

/* ------------------------------------------------------------------ *
 * Tool registration (native document.modelContext)
 * ------------------------------------------------------------------ */

/**
 * Registers a tool through the native document.modelContext and mirrors the
 * descriptor in our local registry (used by page-list-actions).
 */
function register(descriptor, options = {}) {
    if (!state.tools.some((t) => t.descriptor.name === descriptor.name)) {
        state.tools.push({ descriptor, exposedTo: options.exposedTo ?? null });
    }
    try {
        document.modelContext.registerTool(descriptor, options);
    } catch {
        /* ignore — descriptor is already in local registry */
    }
}

/* ------------------------------------------------------------------ *
 * Content tools
 * ------------------------------------------------------------------ */

function registerContentTools() {
    register({
        name: 'page-get-summary',
        description: 'Returns a structured summary of the current page: title, meta description, language, URL and its headings.',
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', properties: {} },
        execute() {
            const headings = Array.from(document.querySelectorAll('h1, h2, h3')).map((h) => ({
                level: Number(h.tagName.substring(1)),
                text: h.textContent.trim(),
            }));
            const summary = {
                title: document.title,
                description: document.querySelector('meta[name="description"]')?.content ?? null,
                language: document.documentElement.lang || null,
                url: location.href,
                headings,
            };
            return {
                content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
            };
        },
    });

    register({
        name: 'page-find-text',
        description: 'Finds the first occurrence of a text on the current page, scrolls it into view and highlights it. Returns the surrounding text snippet.',
        annotations: { readOnlyHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'The text to look for (case-insensitive).' },
            },
            required: ['query'],
        },
        execute({ query }) {
            document.querySelectorAll('.webmcp-highlight').forEach((el) => el.classList.remove('webmcp-highlight'));
            if (!query) {
                return { content: [{ type: 'text', text: 'No query provided.' }] };
            }
            const needle = String(query).toLowerCase();
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                const text = node.nodeValue;
                if (text && text.toLowerCase().includes(needle) && node.parentElement) {
                    const target = node.parentElement;
                    target.classList.add('webmcp-highlight');
                    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    const snippet = text.trim().slice(0, 200);
                    return { content: [{ type: 'text', text: `Found: "${snippet}"` }] };
                }
            }
            return { content: [{ type: 'text', text: `No match found for "${query}".` }] };
        },
    });

    register({
        name: 'page-get-content',
        description: 'Returns the main textual content of the current page as structured blocks (headings, paragraphs, list items and links). Use it to read the page without scraping the DOM yourself.',
        annotations: { readOnlyHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'Optional CSS selector to scope extraction. Defaults to <main> / the primary content area.' },
            },
        },
        execute({ selector } = {}) {
            const root = (selector && document.querySelector(selector))
                || document.querySelector('main, [role="main"], #content, .content, article')
                || document.body;
            const blocks = [];
            const nodes = root.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, a[href]');
            nodes.forEach((node) => {
                const text = node.textContent.trim();
                if (!text) {
                    return;
                }
                const tag = node.tagName.toLowerCase();
                if (/^h[1-6]$/.test(tag)) {
                    blocks.push({ type: 'heading', level: Number(tag.substring(1)), text });
                } else if (tag === 'li') {
                    blocks.push({ type: 'listitem', text });
                } else if (tag === 'a') {
                    blocks.push({ type: 'link', text, href: node.href });
                } else {
                    blocks.push({ type: 'paragraph', text });
                }
            });
            const result = { url: location.href, title: document.title, blocks: blocks.slice(0, 200) };
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        },
    });

    register({
        name: 'page-list-actions',
        description: 'Lists the actions available on this page: the WebMCP tools currently registered and the primary navigation links. Helps decide which tool to call next.',
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', properties: {} },
        execute() {
            const tools = state.tools
                .filter((t) => t.descriptor.name !== 'page-list-actions')
                .map(({ descriptor }) => ({ name: descriptor.name, description: descriptor.description }));
            const links = Array.from(document.querySelectorAll('a[href]'))
                .map((a) => ({ text: a.textContent.trim(), href: a.href }))
                .filter((l) => l.text)
                .slice(0, 50);
            const result = { tools, links };
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        },
    });
}
