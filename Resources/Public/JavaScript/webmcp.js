/*
 * WebMCP (experimental) — TYPO3 frontend integration.
 *
 * Registers TYPO3 frontend forms (EXT:form) and page content as in-browser
 * WebMCP tools via `document.modelContext`. When no native implementation is
 * present (currently the case in all shipping browsers), a lightweight shim is
 * installed so tools can still be discovered and executed, and an optional
 * debug overlay lets you try the tools without a real browser agent.
 *
 * Spec reference: https://github.com/webmachinelearning/webmcp
 */

const CONFIG = readConfig();

const state = {
    /** @type {Array<{descriptor: object, exposedTo: (string|null)}>} */
    tools: [],
    listeners: new Set(),
};

bootstrap();

function readConfig() {
    const el = document.getElementById('webmcp-config');
    const fallback = { debug: false, features: { forms: false, content: false }, submitForms: false };
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
    installModelContextShim();

    if (CONFIG.features?.content) {
        registerContentTools();
    }
    const formsReady = CONFIG.features?.forms ? registerFormTools() : Promise.resolve();
    if (CONFIG.debug) {
        renderDebugOverlay();
    }

    formsReady.finally(announceReady);
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
 * Shim for document.modelContext (only when not natively available)
 * ------------------------------------------------------------------ */

function installModelContextShim() {
    if (document.modelContext) {
        return;
    }
    const modelContext = {
        registerTool(descriptor, options = {}) {
            return new Promise((resolve, reject) => {
                if (!descriptor || !descriptor.name || typeof descriptor.execute !== 'function') {
                    reject(new TypeError('WebMCP: a tool needs a "name" and an "execute" callback.'));
                    return;
                }
                const signal = options.signal;
                if (signal?.aborted) {
                    reject(new DOMException('Registration aborted.', 'AbortError'));
                    return;
                }
                signal?.addEventListener('abort', () => unregister(descriptor.name), { once: true });
                state.tools = state.tools.filter((t) => t.descriptor.name !== descriptor.name);
                state.tools.push({ descriptor, exposedTo: options.exposedTo ?? null });
                notifyToolChange();
                resolve({ name: descriptor.name });
            });
        },
        getTools() {
            return state.tools.map(({ descriptor }) => ({
                name: descriptor.name,
                description: descriptor.description,
                inputSchema: descriptor.inputSchema,
            }));
        },
        async executeTool(name, args = {}) {
            const entry = state.tools.find((t) => t.descriptor.name === name);
            if (!entry) {
                throw new Error(`WebMCP: unknown tool "${name}".`);
            }
            return entry.descriptor.execute(args);
        },
        addEventListener(type, cb) {
            if (type === 'toolchange') {
                state.listeners.add(cb);
            }
        },
        removeEventListener(type, cb) {
            state.listeners.delete(cb);
        },
    };
    Object.defineProperty(document, 'modelContext', { value: modelContext, configurable: true });
    document.__webmcpShimInstalled = true;
}

function unregister(name) {
    state.tools = state.tools.filter((t) => t.descriptor.name !== name);
    notifyToolChange();
}

function notifyToolChange() {
    state.listeners.forEach((cb) => {
        try {
            cb({ type: 'toolchange' });
        } catch {
            /* ignore listener errors */
        }
    });
    document.dispatchEvent(new CustomEvent('webmcp:toolchange', { detail: { count: state.tools.length } }));
}

/**
 * Registers a tool both through document.modelContext and in our own registry
 * (so the debug overlay always has the full descriptor incl. execute()).
 */
function register(descriptor, options = {}) {
    if (!state.tools.some((t) => t.descriptor.name === descriptor.name)) {
        state.tools.push({ descriptor, exposedTo: options.exposedTo ?? null });
    }
    try {
        document.modelContext?.registerTool?.(descriptor, options);
    } catch {
        /* ignore — descriptor is already in local registry */
    }
    notifyToolChange();
}

/* ------------------------------------------------------------------ *
 * Content tools
 * ------------------------------------------------------------------ */

function registerContentTools() {
    register({
        name: 'page-get-summary',
        description: 'Returns a structured summary of the current page: title, meta description, language, URL and its headings.',
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

/* ------------------------------------------------------------------ *
 * Form tools (EXT:form + [data-webmcp] forms)
 * ------------------------------------------------------------------ */

function registerFormTools() {
    // The adapters module is imported dynamically from the cache-busted URL that
    // the middleware resolves for us (CONFIG.adaptersUrl). Static sub-imports are
    // not versioned by the AssetCollector, so this avoids serving a stale adapter
    // after an update. Falls back to the relative path if no URL was provided.
    return import(CONFIG.adaptersUrl || './forms/adapters.js')
        .then(({ analyzeForm }) => {
            const usedToolNames = new Set();
            Array.from(document.querySelectorAll('form')).forEach((form, index) => {
                const descriptor = analyzeForm(form, index, CONFIG);
                if (!descriptor) {
                    return;
                }
                registerFormTool(form, descriptor, usedToolNames);
            });
        })
        .catch((error) => {
            if (CONFIG.debug) {
                console.error('WebMCP: could not load form adapters.', error);
            }
        });
}

function registerFormTool(form, descriptor, usedToolNames) {
    const { fields } = descriptor;
    // Submit-only steps (e.g. an EXT:form SummaryPage) expose no editable
    // fields; they only make sense as a tool when submitting is enabled.
    if (descriptor.submitOnly && !CONFIG.submitForms) {
        return;
    }
    const name = uniqueName(descriptor.name, usedToolNames);
    const description = descriptor.description;
    const inputSchema = buildInputSchema(fields);

    if (CONFIG.submitForms) {
        inputSchema.properties.submit = {
            type: 'boolean',
            description: descriptor.submitOnly
                ? 'Submit this step to advance or finish the form. This step has no editable fields.'
                : 'Submit the form after filling it. Defaults to false (leave for human review).',
        };
        if (descriptor.submitOnly) {
            inputSchema.required = Array.from(new Set([...(inputSchema.required || []), 'submit']));
        }
    }

    register({
        name,
        description,
        inputSchema,
        execute(args = {}) {
            const applied = [];
            for (const field of fields) {
                if (!(field.key in args) || args[field.key] === undefined || args[field.key] === null) {
                    continue;
                }
                applyFieldValue(field, args[field.key]);
                applied.push(field.key);
            }

            let submitted = false;
            if (CONFIG.submitForms && args.submit === true) {
                // Multi-step EXT:form (and similarly built forms) decide which
                // page to navigate to from the *clicked* submit button's
                // name/value (e.g. `tx_form_formframework[<id>][__currentPage]`).
                // A bare form.requestSubmit()/submit() omits that button, so the
                // server re-renders the same step. Pass the forward button as the
                // submitter so its name/value is included in the payload.
                const submitter = findForwardSubmitter(form);
                if (typeof form.requestSubmit === 'function') {
                    form.requestSubmit(submitter || undefined);
                } else {
                    if (submitter) {
                        submitter.click();
                    } else {
                        form.submit();
                    }
                }
                submitted = true;
            }

            const message = applied.length
                ? `Filled ${applied.length} field(s): ${applied.join(', ')}.`
                : (descriptor.submitOnly ? 'Confirmation step with no editable fields.' : 'No matching fields were filled.');
            return {
                content: [{
                    type: 'text',
                    text: submitted ? `${message} Form submitted.` : `${message} Form not submitted (awaiting human review).`,
                }],
            };
        },
    });
}

/**
 * Finds the submit button that advances a (possibly multi-step) form.
 *
 * EXT:form renders navigation buttons whose name/value carry the target page
 * (`…[__currentPage]`). The "previous" button additionally has `formnovalidate`,
 * so the forward button (next / final submit) is the submit control without it.
 * Passing this button as the submitter to requestSubmit() ensures its name/value
 * is posted, so the server navigates forward instead of re-rendering the step.
 *
 * @param {HTMLFormElement} form
 * @returns {HTMLButtonElement|HTMLInputElement|null}
 */
function findForwardSubmitter(form) {
    const submitters = Array.from(form.elements).filter((el) =>
        (el instanceof HTMLButtonElement || el instanceof HTMLInputElement)
        && (el.type === 'submit' || (el instanceof HTMLButtonElement && !el.type))
        && !el.disabled);

    if (submitters.length === 0) {
        return null;
    }

    // Prefer EXT:form navigation buttons (name ends with [__currentPage]) that
    // move forward: exclude the "previous" button (formnovalidate) and pick the
    // one with the highest target page value.
    const pageButtons = submitters
        .filter((el) => /\[__currentPage\]$/.test(el.name || '') && !el.hasAttribute('formnovalidate'))
        .sort((a, b) => Number(b.value) - Number(a.value));
    if (pageButtons.length > 0) {
        return pageButtons[0];
    }

    // Generic forms: first submit control that does not opt out of validation.
    const forward = submitters.find((el) => !el.hasAttribute('formnovalidate'));
    return forward || submitters[0];
}

function buildInputSchema(fields) {
    const properties = {};
    const required = [];

    for (const field of fields) {
        let prop;
        switch (field.kind) {
            case 'number':
                prop = { type: 'number' };
                break;
            case 'checkbox':
                prop = { type: 'boolean' };
                break;
            case 'select':
            case 'radio':
                prop = field.multiple
                    ? { type: 'array', items: { type: 'string', enum: field.options } }
                    : { type: 'string', enum: field.options };
                break;
            case 'email':
                prop = { type: 'string', format: 'email' };
                break;
            case 'date':
                prop = { type: 'string', format: 'date' };
                break;
            case 'url':
                prop = { type: 'string', format: 'uri' };
                break;
            default:
                prop = { type: 'string' };
        }
        if (field.label) {
            prop.description = field.label;
        }
        properties[field.key] = prop;
        if (field.required) {
            required.push(field.key);
        }
    }

    const schema = { type: 'object', properties };
    if (required.length) {
        schema.required = required;
    }
    return schema;
}

function applyFieldValue(field, value) {
    if (field.kind === 'radio') {
        const match = field.elements.find((el) => el.value === String(value));
        if (match) {
            match.checked = true;
            dispatchInput(match);
        }
        return;
    }
    const el = field.element;
    if (!el) {
        return;
    }
    if (field.kind === 'checkbox') {
        el.checked = Boolean(value);
    } else if (field.multiple && el instanceof HTMLSelectElement) {
        const values = Array.isArray(value) ? value.map(String) : [String(value)];
        Array.from(el.options).forEach((o) => {
            o.selected = values.includes(o.value);
        });
    } else {
        el.value = String(value);
    }
    dispatchInput(el);
}

function dispatchInput(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

function uniqueName(base, used) {
    let name = base || 'form';
    let counter = 2;
    while (used.has(name)) {
        name = `${base}-${counter++}`;
    }
    used.add(name);
    return name;
}

/* ------------------------------------------------------------------ *
 * Debug overlay
 * ------------------------------------------------------------------ */

function renderDebugOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'webmcp-overlay';
    overlay.innerHTML = `
        <button type="button" class="webmcp-overlay__toggle">
            WebMCP <span class="webmcp-overlay__badge">0</span>
        </button>
        <div class="webmcp-overlay__panel">
            <div class="webmcp-overlay__header">
                <span>Registered tools</span>
                <small>${describeBackend()}</small>
            </div>
            <div class="webmcp-overlay__list"></div>
        </div>`;
    document.body.appendChild(overlay);

    const toggle = overlay.querySelector('.webmcp-overlay__toggle');
    const badge = overlay.querySelector('.webmcp-overlay__badge');
    const list = overlay.querySelector('.webmcp-overlay__list');

    toggle.addEventListener('click', () => overlay.classList.toggle('is-open'));

    const update = () => {
        badge.textContent = String(state.tools.length);
        list.innerHTML = '';
        state.tools.forEach(({ descriptor }) => list.appendChild(renderToolCard(descriptor)));
    };

    document.addEventListener('webmcp:toolchange', update);
    update();
}

function renderToolCard(descriptor) {
    const card = document.createElement('div');
    card.className = 'webmcp-tool';

    const properties = descriptor.inputSchema?.properties ?? {};
    const requiredKeys = descriptor.inputSchema?.required ?? [];

    const fieldsHtml = Object.entries(properties).map(([key, prop]) => {
        const label = prop.description || key;
        const required = requiredKeys.includes(key) ? ' *' : '';
        if (prop.enum) {
            const options = prop.enum.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
            return `<div class="webmcp-tool__field"><label>${escapeHtml(label)}${required}</label><select data-key="${escapeHtml(key)}"><option value=""></option>${options}</select></div>`;
        }
        if (prop.type === 'boolean') {
            return `<div class="webmcp-tool__field"><label>${escapeHtml(label)}${required}</label><select data-key="${escapeHtml(key)}"><option value=""></option><option value="true">true</option><option value="false">false</option></select></div>`;
        }
        const inputType = prop.type === 'number' ? 'number' : 'text';
        return `<div class="webmcp-tool__field"><label>${escapeHtml(label)}${required}</label><input type="${inputType}" data-key="${escapeHtml(key)}"></div>`;
    }).join('');

    card.innerHTML = `
        <div class="webmcp-tool__name">${escapeHtml(descriptor.name)}</div>
        <div class="webmcp-tool__desc">${escapeHtml(descriptor.description || '')}</div>
        ${fieldsHtml}
        <button type="button" class="webmcp-tool__run">Run tool</button>
        <div class="webmcp-tool__result"></div>`;

    const runButton = card.querySelector('.webmcp-tool__run');
    const result = card.querySelector('.webmcp-tool__result');

    runButton.addEventListener('click', async () => {
        const args = {};
        card.querySelectorAll('[data-key]').forEach((input) => {
            const key = input.dataset.key;
            const raw = input.value;
            if (raw === '') {
                return;
            }
            const prop = properties[key];
            if (prop?.type === 'number') {
                args[key] = Number(raw);
            } else if (prop?.type === 'boolean') {
                args[key] = raw === 'true';
            } else {
                args[key] = raw;
            }
        });
        try {
            const output = await descriptor.execute(args);
            result.textContent = renderResult(output);
        } catch (error) {
            result.textContent = `Error: ${error.message}`;
        }
        result.classList.add('is-visible');
    });

    return card;
}

function renderResult(output) {
    if (output?.content?.length) {
        return output.content.map((c) => c.text ?? JSON.stringify(c)).join('\n');
    }
    return JSON.stringify(output, null, 2);
}

function describeBackend() {
    if (document.modelContext && !document.__webmcpShimInstalled) {
        return 'native';
    }
    return 'shim';
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
