/*
 * WebMCP (experimental) — TYPO3 frontend integration.
 *
 * Exposes the current page's content and the site search as read-only WebMCP
 * tools via `document.modelContext`.
 *
 * Declarative form tools are built by the browser's native WebMCP
 * implementation from `<form>` elements that carry the declarative attributes
 * (`toolname`, `tooldescription`, `toolparamdescription`). TYPO3 renders
 * those attributes (see the EXT:form integration); this module only highlights
 * a form while an agent fills it. Submitting stays with the user.
 *
 * This module only acts when the browser exposes a native
 * `document.modelContext` (Chrome 149+). Without native support it does
 * nothing — there is no shim.
 *
 * Spec references:
 *   https://github.com/webmachinelearning/webmcp
 *   https://github.com/webmachinelearning/webmcp/blob/main/declarative-api-explainer.md
 */

function bootstrap() {
    // Native-only: without document.modelContext there is nothing to register.
    if (!document.modelContext) {
        return;
    }

    registerContentTools();
    registerSearchTool();
    bindDeclarativeForms();
    announceReady();
}

/**
 * Signals that document.modelContext is ready and the built-in tools have been
 * registered. The detail is also stored on the document so integrator scripts
 * that load later can pick it up without missing the event.
 */
function announceReady() {
    const detail = { modelContext: document.modelContext, register };
    document.__webmcpReadyDetail = detail;
    document.dispatchEvent(new CustomEvent('webmcp:ready', { detail }));
}

/* ------------------------------------------------------------------ *
 * Tool registration (native document.modelContext)
 * ------------------------------------------------------------------ */

/**
 * Registers a tool through the native document.modelContext.
 */
function register(descriptor, options = {}) {
    // registerTool() returns a promise; it rejects e.g. with NotAllowedError or InvalidStateError.
    Promise.resolve()
        .then(() => document.modelContext.registerTool(descriptor, options))
        .catch((error) => {
            console.warn(`[webmcp] Tool "${descriptor.name}" was not registered.`, error);
        });
}

/* ------------------------------------------------------------------ *
 * Visibility helpers
 * ------------------------------------------------------------------ */

const NON_CONTENT_SELECTOR = 'script, style, noscript, template, [hidden], [inert], [aria-hidden="true"]';

/**
 * Hidden text is never handed to the agent: it is invisible to the user and
 * a common carrier for prompt injection.
 */
function isVisible(element) {
    if (!element || element.closest(NON_CONTENT_SELECTOR)) {
        return false;
    }
    if (typeof element.checkVisibility === 'function'
        && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
        return false;
    }
    return !isConcealed(element);
}

function isTransparent(color) {
    return color === 'transparent' || /[,/]\s*0(\.0*)?\s*\)$/.test(color);
}

/**
 * Rendered but not readable: off-screen, clipped to a pixel (.sr-only),
 * tiny or transparent text. Text in the background colour is not detected.
 */
function isConcealed(element) {
    const style = getComputedStyle(element);
    if (parseFloat(style.fontSize) < 4 || isTransparent(style.color)) {
        return true;
    }
    const rect = element.getBoundingClientRect();
    if (rect.right + window.scrollX <= 0 || rect.bottom + window.scrollY <= 0) {
        return true;
    }
    for (let node = element; node && node !== document.body; node = node.parentElement) {
        const box = node === element ? rect : node.getBoundingClientRect();
        const nodeStyle = node === element ? style : getComputedStyle(node);
        const clips = nodeStyle.overflowX !== 'visible' || nodeStyle.overflowY !== 'visible';
        if (clips && (box.width <= 1 || box.height <= 1)) {
            return true;
        }
    }
    return false;
}

/* ------------------------------------------------------------------ *
 * Content tools
 * ------------------------------------------------------------------ */

const MAX_BLOCKS = 200;
const BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, dt, dd, td, th, blockquote, figcaption, a[href]';
const BLOCK_TYPES = { li: 'listitem', dt: 'term', dd: 'definition', td: 'cell', th: 'cell', blockquote: 'quote', figcaption: 'caption' };

function scrollToElement(element) {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
}

/**
 * Finds the first visible occurrence of the needle in the page text. The text
 * nodes are searched as one string, so a match may span inline markup.
 */
function findText(needle) {
    const segments = [];
    let text = '';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (node.parentElement?.closest(NON_CONTENT_SELECTOR) ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT),
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        let value = node.nodeValue.replace(/\s+/g, ' ');
        if (text.endsWith(' ') && value.startsWith(' ')) {
            value = value.slice(1);
        }
        if (value) {
            segments.push({ node, start: text.length, end: text.length + value.length });
            text += value;
        }
    }

    const haystack = text.toLowerCase();
    for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + 1)) {
        const end = index + needle.length;
        const matched = segments.filter((segment) => segment.end > index && segment.start < end);
        if (matched.every((segment) => isVisible(segment.node.parentElement))) {
            const range = document.createRange();
            range.setStartBefore(matched[0].node);
            range.setEndAfter(matched[matched.length - 1].node);
            const ancestor = range.commonAncestorContainer;
            // The snippet stays within the matched (visible) text nodes.
            const snippet = text.slice(
                Math.max(matched[0].start, index - 80),
                Math.min(matched[matched.length - 1].end, end + 80)
            );
            return {
                element: ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement,
                snippet: snippet.trim(),
            };
        }
    }
    return null;
}

function registerContentTools() {
    register({
        name: 'page-find-text',
        description: 'Finds the first occurrence of a text on the current page, scrolls it into view and highlights it. Returns the surrounding text snippet.',
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'The text to look for (case-insensitive).' },
            },
            required: ['query'],
        },
        execute({ query }) {
            document.querySelectorAll('.webmcp-highlight').forEach((el) => el.classList.remove('webmcp-highlight'));
            const needle = String(query ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!needle) {
                return textResult('No query provided.');
            }
            const match = findText(needle);
            if (!match) {
                return textResult(`No match found for "${query}".`);
            }
            match.element.classList.add('webmcp-highlight');
            scrollToElement(match.element);
            return textResult(`Found: "${match.snippet}"`);
        },
    });

    register({
        name: 'page-get-content',
        description: 'Returns the main textual content of the current page as structured blocks (headings, paragraphs, list items, table cells, quotes and links). Use it to read the page without scraping the DOM yourself.',
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'Optional CSS selector to scope extraction. Defaults to <main> / the primary content area.' },
            },
        },
        execute({ selector } = {}) {
            let scope = null;
            if (selector) {
                try {
                    scope = document.querySelector(selector);
                } catch {
                    return textResult(`"${selector}" is not a valid CSS selector.`);
                }
            }
            const root = scope
                || document.querySelector('main, [role="main"], #content, .content, article')
                || document.body;
            const blocks = [];
            let truncated = false;
            for (const node of root.querySelectorAll(BLOCK_SELECTOR)) {
                // Nested blocks (a link in a list item, a paragraph in a quote) belong to their outermost block.
                const outer = node.parentElement?.closest(BLOCK_SELECTOR);
                if ((outer && root.contains(outer)) || !isVisible(node)) {
                    continue;
                }
                const text = node.textContent.trim();
                if (!text) {
                    continue;
                }
                if (blocks.length === MAX_BLOCKS) {
                    truncated = true;
                    break;
                }
                const tag = node.tagName.toLowerCase();
                if (tag === 'a') {
                    blocks.push({ type: 'link', text, href: node.href });
                    continue;
                }
                const block = /^h[1-6]$/.test(tag)
                    ? { type: 'heading', level: Number(tag.substring(1)), text }
                    : { type: BLOCK_TYPES[tag] ?? 'paragraph', text };
                const links = Array.from(node.querySelectorAll('a[href]'))
                    .filter(isVisible)
                    .map((a) => ({ text: a.textContent.trim(), href: a.href }))
                    .filter((l) => l.text);
                if (links.length) {
                    block.links = links;
                }
                blocks.push(block);
            }
            const result = { url: location.href, title: document.title, blocks };
            if (truncated) {
                result.truncated = `Only the first ${MAX_BLOCKS} blocks are returned; pass a selector to read a part of the page.`;
            }
            return textResult(JSON.stringify(result, null, 2));
        },
    });
}

/* ------------------------------------------------------------------ *
 * Site search (EXT:indexed_search)
 * ------------------------------------------------------------------ */

const SEARCH_WORD_SELECTOR = 'input[name$="[search][sword]"]';

function textResult(text) {
    return { content: [{ type: 'text', text }] };
}

function parseHtml(html) {
    return new DOMParser().parseFromString(html, 'text/html');
}

function cleanText(element) {
    return element ? element.textContent.replace(/\s+/g, ' ').trim() : '';
}

/**
 * The search page comes from the site setting webmcp.search.pageUid (rendered
 * as meta tag by the site set); a search box on the current page is used
 * otherwise.
 */
function findSearchSource() {
    const url = document.querySelector('meta[name="webmcp-search"]')?.content;
    if (url) {
        return { url };
    }
    const form = document.querySelector(SEARCH_WORD_SELECTOR)?.form;
    return form ? { form, baseUrl: location.href } : null;
}

async function loadSearchForm(source) {
    if (source.form) {
        return source;
    }
    const response = await fetch(source.url, { credentials: 'same-origin' });
    if (!response.ok) {
        throw new Error(`The search page answered with HTTP ${response.status}.`);
    }
    const form = parseHtml(await response.text()).querySelector(SEARCH_WORD_SELECTOR)?.form;
    if (!form) {
        throw new Error('The search page does not contain an indexed_search form.');
    }
    return { form, baseUrl: response.url };
}

function registerSearchTool() {
    const source = findSearchSource();
    if (!source) {
        return;
    }

    register({
        name: 'site-search',
        description: 'Searches the full-text index of this website and returns the matching pages with title, URL and a text snippet. Use it to find pages that are not linked from the current page.',
        // Snippets come from the index, which also holds text that pages hide visually.
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'The search words, as a visitor would type them into the search box.' },
            },
            required: ['query'],
        },
        async execute({ query }) {
            const term = String(query ?? '').trim();
            if (!term) {
                return textResult('No query provided.');
            }

            // Submitting the plugin's own form keeps its hidden Extbase fields (__trustedProperties, __referrer).
            const { form, baseUrl } = await loadSearchForm(source);
            const data = new FormData(form);
            data.set(form.querySelector(SEARCH_WORD_SELECTOR).name, term);
            const action = new URL(form.getAttribute('action') || baseUrl, baseUrl);
            if (action.origin !== location.origin) {
                return textResult('The search form points to another origin and was not submitted.');
            }

            const response = await fetch(action, { method: 'POST', body: data, credentials: 'same-origin' });
            if (!response.ok) {
                return textResult(`The search failed with HTTP ${response.status}.`);
            }
            const doc = parseHtml(await response.text());
            const results = Array.from(doc.querySelectorAll('.tx-indexedsearch-res'))
                .filter((row) => !row.parentElement?.closest('.tx-indexedsearch-res'))
                .map((row) => {
                    const link = row.querySelector('.tx-indexedsearch-title a[href]') ?? row.querySelector('a[href]');
                    return {
                        title: cleanText(row.querySelector('.tx-indexedsearch-title')),
                        url: link ? new URL(link.getAttribute('href'), response.url).href : null,
                        snippet: cleanText(row.querySelector('.tx-indexedsearch-description')),
                    };
                });
            if (!results.length) {
                return textResult(`No pages found for "${term}".`);
            }
            return textResult(JSON.stringify({ query: term, results }, null, 2));
        },
    });
}

/* ------------------------------------------------------------------ *
 * Declarative form tools
 * ------------------------------------------------------------------ */

const ACTIVE_FORM_CLASS = 'webmcp-form-active';

// EXT:form renders its honeypot as a text field hidden from assistive technology and the keyboard.
const HONEYPOT_SELECTOR = 'input[type="text"][aria-hidden="true"][tabindex="-1"]';

/** Forms an agent has filled in: an agent cannot tell the honeypot from a real field. */
const agentFilledForms = new WeakSet();

function findToolForm(toolName) {
    return toolName ? document.querySelector(`form[toolname="${CSS.escape(toolName)}"]`) : null;
}

function clearActiveForms() {
    document.querySelectorAll(`.${ACTIVE_FORM_CLASS}`).forEach((form) => form.classList.remove(ACTIVE_FORM_CLASS));
}

function bindDeclarativeForms() {
    // Mirrors the :tool-form-active pseudo-class for browsers that fire the events but lack the selector.
    document.modelContext.addEventListener?.('toolactivated', (event) => {
        const form = findToolForm(event.toolName);
        if (form) {
            agentFilledForms.add(form);
            clearActiveForms();
            form.classList.add(ACTIVE_FORM_CLASS);
            scrollToElement(form);
        }
    });
    document.modelContext.addEventListener?.('toolcancel', (event) => {
        findToolForm(event.toolName)?.classList.remove(ACTIVE_FORM_CLASS);
    });
    document.addEventListener('reset', (event) => event.target.classList?.remove(ACTIVE_FORM_CLASS), true);
    document.addEventListener('submit', (event) => {
        const form = event.target;
        form.classList?.remove(ACTIVE_FORM_CLASS);
        // The entry list is built after the submit event, so the cleared value is what gets sent.
        if (agentFilledForms.has(form)) {
            form.querySelectorAll(HONEYPOT_SELECTOR).forEach((input) => {
                input.value = '';
            });
        }
    }, true);
}

bootstrap();
