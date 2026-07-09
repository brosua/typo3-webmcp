/*
 * WebMCP form adapters.
 *
 * Each adapter recognises a class of forms rendered by TYPO3 and knows how to
 * derive a tool name and a normalized field list. The public entry point is
 * `analyzeForm(form, index, config)`, which returns a descriptor:
 *
 *   { adapter, name, description, fields }  (or null if the form is ignored)
 *
 * Security invariant: adapters only ever describe values of EXISTING, visible
 * fields. Internal state fields (`__*`, CSRF tokens, Extbase trustedProperties,
 * referrer, hidden inputs) are never exposed, so all security tokens remain
 * intact and are submitted unchanged with the real form.
 */

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * @returns {{adapter: string, name: string, description: string, fields: Array}|null}
 */
export function analyzeForm(form, index, config) {
    if ((form.getAttribute('data-webmcp') || '').toLowerCase() === 'off') {
        return null;
    }

    const adapter = ADAPTERS.find((a) => a.match(form, config));
    if (!adapter) {
        return null;
    }

    const context = adapter.context ? adapter.context(form) : {};
    const fields = extractFields(form, (el) => adapter.fieldKey(form, el, context));
    if (fields.length === 0) {
        // Some steps have no editable fields but still need to be submitted to
        // advance or finish the form — most notably the EXT:form SummaryPage
        // (read-only confirmation) and single confirmation steps. Register a
        // submit-only tool for those so agents can complete the form instead of
        // silently getting stuck on the summary page.
        if (adapter.allowEmpty && adapter.allowEmpty(form)) {
            return {
                adapter: adapter.id,
                name: adapter.deriveToolName(form, index, context),
                description: deriveToolDescription(form, true),
                fields: [],
                submitOnly: true,
            };
        }
        return null;
    }

    return {
        adapter: adapter.id,
        name: adapter.deriveToolName(form, index, context),
        description: deriveToolDescription(form),
        fields,
    };
}

/* ------------------------------------------------------------------ *
 * Adapter registry (order = priority: specific before declared)
 * ------------------------------------------------------------------ */

const extformAdapter = {
    id: 'extform',
    match(form) {
        return !!form.querySelector('[name^="tx_form_formframework"]');
    },
    context() {
        return {};
    },
    fieldKey(form, el) {
        return labelKey(form, el);
    },
    deriveToolName(form, index) {
        return deriveToolName(form, index);
    },
    // EXT:form SummaryPage / confirmation steps carry no editable fields but do
    // render a forward navigation button (…[__currentPage]). Allow such steps to
    // register a submit-only tool so they can still be completed.
    allowEmpty(form) {
        return hasForwardNavigationButton(form);
    },
};

const extbaseAdapter = {
    id: 'extbase',
    match(form) {
        return Array.from(form.elements).some((el) => {
            const name = el.name || '';
            return name.endsWith('[__trustedProperties]')
                || (name.startsWith('tx_') && name.includes('[__referrer]'));
        });
    },
    context(form) {
        return { prefix: extbasePrefix(form) };
    },
    fieldKey(form, el, context) {
        return extbaseKey(context.prefix, el.name) || labelKey(form, el);
    },
    deriveToolName(form, index, context) {
        const explicit = form.getAttribute('data-webmcp-name');
        if (explicit) {
            return slug(explicit);
        }
        const heading = form.querySelector('legend, h1, h2, h3')?.textContent.trim();
        if (heading) {
            return `form-${slug(heading)}`;
        }
        if (context.prefix) {
            const segment = context.prefix.split('_').pop();
            if (segment) {
                return `form-${slug(segment)}`;
            }
        }
        return `form-${index + 1}`;
    },
};

const declaredAdapter = {
    id: 'declared',
    match(form) {
        return form.hasAttribute('data-webmcp');
    },
    context() {
        return {};
    },
    fieldKey(form, el) {
        return labelKey(form, el);
    },
    deriveToolName(form, index) {
        return deriveToolName(form, index);
    },
};

const ADAPTERS = [extformAdapter, extbaseAdapter, declaredAdapter];

/* ------------------------------------------------------------------ *
 * Field extraction (shared)
 * ------------------------------------------------------------------ */

function extractFields(form, keyFor) {
    const fields = [];
    const radioGroups = new Map();
    const usedKeys = new Set();

    Array.from(form.elements).forEach((el) => {
        if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) {
            return;
        }
        if (!el.name || el.disabled) {
            return;
        }
        if (el.hasAttribute('data-webmcp-ignore')) {
            return;
        }
        // Skip technical/internal fields; never touch security tokens.
        if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button' || el.type === 'file' || el.type === 'password') {
            return;
        }
        if (el.name.includes('__')) {
            return;
        }
        // Skip fields that are hidden from the user (spam honeypots and other
        // decorative/off-screen inputs). EXT:form renders its honeypot as a
        // visible-type text input that is only hidden via `aria-hidden`,
        // `tabindex="-1"` and off-screen CSS, so it would otherwise be exposed
        // as a fillable field. Honeypots must stay empty to pass validation.
        if (isHiddenFromUser(el)) {
            return;
        }

        if (el instanceof HTMLInputElement && el.type === 'radio') {
            if (!radioGroups.has(el.name)) {
                const key = uniqueKey(keyFor(el), usedKeys);
                const elements = [];
                radioGroups.set(el.name, elements);
                fields.push({
                    key,
                    kind: 'radio',
                    name: el.name,
                    label: deriveFieldLabel(form, el),
                    required: el.required,
                    options: [],
                    elements,
                });
            }
            radioGroups.get(el.name).push(el);
            const group = fields.find((f) => f.kind === 'radio' && f.name === el.name);
            if (group && el.value) {
                group.options.push(el.value);
            }
            return;
        }

        const key = uniqueKey(keyFor(el), usedKeys);
        fields.push({
            key,
            kind: resolveKind(el),
            name: el.name,
            label: deriveFieldLabel(form, el),
            required: el.required,
            options: el instanceof HTMLSelectElement
                ? Array.from(el.options).map((o) => o.value).filter((v) => v !== '')
                : [],
            multiple: el instanceof HTMLSelectElement && el.multiple,
            element: el,
        });
    });

    return fields;
}

function resolveKind(el) {
    if (el instanceof HTMLTextAreaElement) {
        return 'text';
    }
    if (el instanceof HTMLSelectElement) {
        return 'select';
    }
    switch (el.type) {
        case 'checkbox':
            return 'checkbox';
        case 'number':
        case 'range':
            return 'number';
        case 'email':
            return 'email';
        case 'date':
            return 'date';
        case 'url':
            return 'url';
        default:
            return 'text';
    }
}

/* ------------------------------------------------------------------ *
 * Key / name / label derivation
 * ------------------------------------------------------------------ */

/**
 * Detects the Extbase plugin namespace (e.g. `tx_myext_contact`) from the first
 * matching field so it can be stripped from property paths.
 */
function extbasePrefix(form) {
    for (const el of Array.from(form.elements)) {
        const match = el.name && el.name.match(/^(tx_[a-z0-9]+_[a-z0-9]+)\[/i);
        if (match) {
            return match[1];
        }
    }
    return null;
}

/**
 * Turns an Extbase field name into a clean dotted key by removing the plugin
 * namespace and collapsing the bracket path, e.g.
 * `tx_myext_contact[contact][email]` -> `contact.email`.
 */
function extbaseKey(prefix, name) {
    if (!name) {
        return '';
    }
    let rest = name;
    if (prefix && name.startsWith(prefix)) {
        rest = name.slice(prefix.length);
    }
    const segments = Array.from(rest.matchAll(/\[([^\]]+)\]/g)).map((m) => m[1]);
    if (segments.length) {
        return segments.map(slug).join('.');
    }
    return slug(rest);
}

function labelKey(form, el) {
    const label = deriveFieldLabel(form, el);
    if (label) {
        return slug(label);
    }
    const segments = el.name.match(/\[([^\]]+)\]/g);
    if (segments?.length) {
        return slug(segments[segments.length - 1].replace(/[[\]]/g, ''));
    }
    return slug(el.name);
}

function deriveToolName(form, index) {
    const explicit = form.getAttribute('data-webmcp-name');
    if (explicit) {
        return slug(explicit);
    }
    const heading = form.querySelector('legend, h1, h2, h3');
    if (heading?.textContent.trim()) {
        return `form-${slug(heading.textContent)}`;
    }
    if (form.id) {
        return `form-${slug(form.id)}`;
    }
    return `form-${index + 1}`;
}

function deriveToolDescription(form, submitOnly = false) {
    const explicit = form.getAttribute('data-webmcp-description');
    if (explicit) {
        return explicit;
    }
    const heading = form.querySelector('legend, h1, h2, h3')?.textContent.trim();
    if (submitOnly) {
        const base = heading ? `Confirms and submits the "${heading}" step.` : 'Confirms and submits the current form step.';
        return `${base} This step (e.g. an EXT:form summary page) has no editable fields; set "submit" to true to advance or finish the form.`;
    }
    const base = heading ? `Fills the "${heading}" form on this page.` : 'Fills a form on this page.';
    return `${base} Field values are applied to the visible form so the user can review and submit them.`;
}

/**
 * Detects whether a form exposes an EXT:form-style forward navigation button
 * (Next / Submit). The "previous" button opts out of validation via
 * `formnovalidate`, so a forward button is a submit control without it whose
 * name targets the current page pointer (…[__currentPage]).
 *
 * @param {HTMLFormElement} form
 * @returns {boolean}
 */
function hasForwardNavigationButton(form) {
    return Array.from(form.elements).some((el) =>
        (el instanceof HTMLButtonElement || el instanceof HTMLInputElement)
        && el.type === 'submit'
        && /\[__currentPage\]$/.test(el.name || '')
        && !el.hasAttribute('formnovalidate')
        && !el.disabled);
}

function deriveFieldLabel(form, el) {
    if (el.id) {
        const label = form.querySelector(`label[for="${cssEscape(el.id)}"]`);
        if (label?.textContent.trim()) {
            return label.textContent.trim();
        }
    }
    const wrappingLabel = el.closest('label');
    if (wrappingLabel?.textContent.trim()) {
        return wrappingLabel.textContent.trim();
    }
    return el.getAttribute('aria-label') || el.placeholder || '';
}

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */

/**
 * Detects fields that are hidden from the user and must therefore not be
 * exposed as fillable tool inputs — most importantly spam honeypots.
 *
 * EXT:form renders its honeypot as an `<input type="text">` with a random
 * name, hidden only via `aria-hidden="true"`, `tabindex="-1"` and off-screen
 * CSS (e.g. `position:absolute; margin:0 0 0 -999em;`). Such fields must stay
 * empty; filling them would trigger the honeypot validator and reject the
 * submission. This also covers other visually-hidden decorative inputs.
 */
function isHiddenFromUser(el) {
    // Explicitly hidden from assistive technology (the standard honeypot
    // technique) — on the element itself or any ancestor.
    if (el.closest('[aria-hidden="true"]')) {
        return true;
    }

    // Not rendered at all.
    const style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(el) : null;
    if (style) {
        if (style.display === 'none'
            || style.visibility === 'hidden'
            || style.visibility === 'collapse'
            || parseFloat(style.opacity) === 0) {
            return true;
        }
    }

    // Zero-size or pushed off-screen (negative offsets, e.g. -999em margins).
    const rect = el.getBoundingClientRect();
    if ((rect.width === 0 && rect.height === 0) || rect.right <= 0 || rect.bottom <= 0) {
        return true;
    }

    return false;
}

function uniqueKey(base, usedKeys) {
    let key = base || 'field';
    let counter = 2;
    while (usedKeys.has(key)) {
        key = `${base}-${counter++}`;
    }
    usedKeys.add(key);
    return key;
}

function slug(value) {
    return String(value)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50) || 'field';
}

function cssEscape(value) {
    return window.CSS?.escape ? window.CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}
