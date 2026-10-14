/*
 * WebMCP (experimental) — TYPO3 backend tools.
 *
 * Loaded into the main backend document (see LoadBackendTools), so the tools
 * stay registered while the editor switches modules in the content frame.
 * Nothing here writes records: backend-prepare-record only opens a prefilled
 * form, saving it stays with the editor.
 */
import AjaxRequest from '@typo3/core/ajax/ajax-request.js';
import ModuleMenu from '@typo3/backend/module-menu.js';
import Viewport from '@typo3/backend/viewport.js';

const settings = window.TYPO3?.settings?.WebMcp?.backend ?? {};

/** Results of the latest backend-search, keyed by the ref handed to the agent. */
const searchResults = new Map();

function register(descriptor) {
    // registerTool() returns a promise; it rejects e.g. with NotAllowedError or InvalidStateError.
    Promise.resolve()
        .then(() => document.modelContext.registerTool(descriptor))
        .catch((error) => {
            console.warn(`[webmcp] Tool "${descriptor.name}" was not registered.`, error);
        });
}

function textResult(text) {
    return { content: [{ type: 'text', text }] };
}

const NOT_OPENED = 'The editor kept the current view (e.g. because of unsaved changes). Nothing was opened.';

/** Resolves to false when the editor cancels, e.g. in the unsaved-changes dialog. */
async function navigate(open) {
    try {
        await open();
        return true;
    } catch {
        return false;
    }
}

function isPositiveInteger(value) {
    return typeof value !== 'boolean' && Number.isInteger(Number(value)) && Number(value) > 0;
}

function isBackendUrl(url) {
    return new URL(url, location.href).origin === location.origin;
}

function findActionUrl(item, identifier) {
    const url = (item.actions ?? []).find((action) => action.identifier === identifier)?.url;
    return url ? new URL(url, location.href) : null;
}

/** Page results carry no table/uid in extraData, so read them from the edit link. */
function recordOf(item) {
    if (item.extraData?.table && item.extraData?.uid) {
        return { table: item.extraData.table, uid: Number(item.extraData.uid) };
    }
    for (const key of findActionUrl(item, 'edit')?.searchParams.keys() ?? []) {
        const match = key.match(/^edit\[([a-z0-9_]+)\]\[(\d+)\]$/i);
        if (match) {
            return { table: match[1], uid: Number(match[2]) };
        }
    }
    return { table: null, uid: null };
}

/** The page a result lives on (for pages the page itself), taken from the "id" of its page module or list link. */
function pageUidOf(item) {
    for (const identifier of ['layout', 'list']) {
        const id = findActionUrl(item, identifier)?.searchParams.get('id');
        if (isPositiveInteger(id)) {
            return Number(id);
        }
    }
    return null;
}

function registerSearchTool() {
    if (!window.TYPO3?.settings?.ajaxUrls?.livesearch) {
        return;
    }

    register({
        name: 'backend-search',
        description: 'Searches the TYPO3 backend like its live search: pages, content elements, other records and backend modules the editor has access to. Returns a ref per result that backend-open accepts, plus table and uid of the record and pageUid: the page the result is on (for pages the page itself). Use pageUid, not uid, when creating records with backend-prepare-record.',
        // Titles and paths may come from frontend input, e.g. form submissions or website users.
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search words, a record uid or a page title.' },
                limit: { type: 'number', description: 'Maximum number of results, 1 to 20. Defaults to 10.' },
            },
            required: ['query'],
        },
        async execute({ query, limit }) {
            const term = String(query ?? '').trim();
            if (!term) {
                return textResult('No query provided.');
            }
            const body = new FormData();
            body.set('query', term);
            body.set('limit', String(Math.min(Math.max(Number(limit) || 10, 1), 20)));

            const response = await new AjaxRequest(window.TYPO3.settings.ajaxUrls.livesearch).post(body);
            const items = (await response.resolve('json'))?.results ?? [];

            searchResults.clear();
            const results = items.map((item, index) => {
                const ref = String(index + 1);
                searchResults.set(ref, item);
                return {
                    ref,
                    title: item.itemTitle,
                    type: item.typeLabel,
                    path: item.extraData?.breadcrumb ?? null,
                    ...recordOf(item),
                    pageUid: pageUidOf(item),
                    actions: (item.actions ?? []).map((action) => action.identifier),
                };
            });
            if (!results.length) {
                return textResult(`Nothing found for "${term}".`);
            }
            return textResult(JSON.stringify({ query: term, results }, null, 2));
        },
    });
}

async function openSearchResult(ref, actionIdentifier) {
    const item = searchResults.get(String(ref));
    if (!item) {
        return textResult(`Unknown ref "${ref}". Refs are only valid for the latest backend-search.`);
    }
    const action = (item.actions ?? []).find((candidate) => candidate.identifier === actionIdentifier)
        ?? item.defaultAction;
    if (!action?.url) {
        return textResult(`The result "${item.itemTitle}" offers no action to open.`);
    }
    if (action.identifier === 'preview') {
        window.open(action.url, '_blank', 'noopener');
        return textResult(`Opened the frontend preview of "${item.itemTitle}" in a new tab.`);
    }
    if (!isBackendUrl(action.url)) {
        return textResult('The result points outside of this backend and was not opened.');
    }
    const opened = await navigate(() => (action.identifier === 'open_module' && item.extraData?.moduleIdentifier
        ? ModuleMenu.App.showModule(item.extraData.moduleIdentifier)
        : Viewport.ContentContainer.setUrl(action.url)));
    return textResult(opened ? `Opened "${item.itemTitle}" (${action.identifier}).` : NOT_OPENED);
}

function registerOpenTool() {
    register({
        name: 'backend-open',
        description: 'Opens something in the TYPO3 backend for the editor: a result of backend-search (by ref, optionally with one of its actions), a page in the page module (pageUid), or a record in the editing form (table and uid).',
        inputSchema: {
            type: 'object',
            properties: {
                ref: { type: 'string', description: 'A ref returned by the latest backend-search.' },
                action: { type: 'string', description: 'One of the actions listed for the ref, e.g. "edit", "layout", "list", "preview". Defaults to the result\'s main action.' },
                pageUid: { type: 'number', description: 'Uid of a page to show in the page module.' },
                table: { type: 'string', description: 'Table of a record to edit, e.g. "tt_content". Requires uid.' },
                uid: { type: 'number', description: 'Uid of the record to edit. Requires table.' },
            },
        },
        async execute({ ref, action, pageUid, table, uid } = {}) {
            if (ref !== undefined && ref !== null && ref !== '') {
                return openSearchResult(ref, action);
            }
            if (isPositiveInteger(pageUid)) {
                const opened = await navigate(() => ModuleMenu.App.showModule('web_layout', `id=${Number(pageUid)}`));
                return textResult(opened ? `Opened page ${Number(pageUid)} in the page module.` : NOT_OPENED);
            }
            if (typeof table === 'string' && /^[a-z0-9_]+$/i.test(table) && isPositiveInteger(uid) && settings.recordEditUrl) {
                const url = new URL(settings.recordEditUrl, location.href);
                url.searchParams.set(`edit[${table}][${Number(uid)}]`, 'edit');
                url.searchParams.set('returnUrl', Viewport.ContentContainer.getUrl() || '');
                const opened = await navigate(() => Viewport.ContentContainer.setUrl(url.toString()));
                return textResult(opened ? `Opened ${table}:${Number(uid)} in the editing form.` : NOT_OPENED);
            }
            return textResult('Pass a ref from backend-search, a pageUid, or a table with a uid.');
        },
    });
}

/** Uid of the page shown in the content frame, e.g. by the page module or list module. */
function currentPageUid() {
    const contentUrl = Viewport.ContentContainer.getUrl();
    const id = contentUrl ? new URL(contentUrl, location.href).searchParams.get('id') : null;
    return isPositiveInteger(id) ? Number(id) : null;
}

/** Resolves to the page info if the editor may create records of the table on the page, otherwise null. */
async function findPage(uid, table) {
    const ajaxUrl = window.TYPO3?.settings?.ajaxUrls?.webmcp_page_info;
    if (!ajaxUrl) {
        return null;
    }
    const response = await new AjaxRequest(ajaxUrl).withQueryArguments({ uid, table }).get();
    const page = await response.resolve('json');
    return page?.found ? page : null;
}

/** Resolves to the record type and the fields its form shows the editor, or to { error }. */
async function findFormFields(table, pageUid, values) {
    const body = new FormData();
    body.set('table', table);
    body.set('pageUid', String(pageUid));
    Object.entries(values).forEach(([field, value]) => body.set(`values[${field}]`, value));
    const response = await new AjaxRequest(window.TYPO3.settings.ajaxUrls.webmcp_record_fields).post(body);
    return response.resolve('json');
}

function registerPrepareRecordTool() {
    const tables = Array.isArray(settings.prepareRecordTables) ? settings.prepareRecordTables : [];
    if (!tables.length || !settings.recordEditUrl || !window.TYPO3?.settings?.ajaxUrls?.webmcp_record_fields) {
        return;
    }

    register({
        name: 'backend-prepare-record',
        description: 'Opens the TYPO3 form for a new record on a page, prefilled with the given field values. Nothing is saved: the editor reviews the form and saves it. Use field names of the table, e.g. "title" for pages or "header" and "bodytext" for tt_content. Only fields the form shows for the record type (e.g. CType of tt_content, doktype of pages) are prefilled; pass the type field to choose the type.',
        inputSchema: {
            type: 'object',
            properties: {
                table: { type: 'string', enum: tables, description: 'Table of the new record.' },
                pageUid: { type: 'number', description: 'Uid of an existing page the record is created on (the pageUid of a backend-search result, never the uid of a content element). For a new page this is its parent page. Omit it to use the page the editor has open.' },
                values: {
                    type: 'object',
                    description: 'Field values to prefill, keyed by field name.',
                    additionalProperties: { type: ['string', 'number', 'boolean'] },
                },
            },
            required: ['table'],
        },
        async execute({ table, pageUid, values } = {}) {
            if (!tables.includes(table)) {
                return textResult(`Records of "${table}" cannot be prepared. Allowed tables: ${tables.join(', ')}.`);
            }
            const openPageUid = currentPageUid();
            const targetUid = isPositiveInteger(pageUid) ? Number(pageUid) : openPageUid;
            if (!targetUid) {
                return textResult('No page is open in the backend. Pass the pageUid of an existing page, e.g. from backend-search.');
            }
            const page = await findPage(targetUid, table);
            if (!page) {
                return textResult(
                    `There is no page with uid ${targetUid} on which the editor may create ${table} records. Nothing was opened.`
                    + (openPageUid && openPageUid !== targetUid ? ` The editor currently has page ${openPageUid} open; omit pageUid to use it.` : '')
                    + ' Use the pageUid of a backend-search result, not the uid of a content element.'
                );
            }
            const requested = {};
            Object.entries(values && typeof values === 'object' ? values : {}).forEach(([field, value]) => {
                if (/^[a-z0-9_]+$/i.test(field) && ['string', 'number', 'boolean'].includes(typeof value)) {
                    requested[field] = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
                }
            });
            const form = await findFormFields(table, targetUid, requested);
            if (form?.error || !Array.isArray(form?.fields)) {
                return textResult(`${form?.error ?? 'The form fields could not be determined.'} Nothing was opened.`);
            }

            const url = new URL(settings.recordEditUrl, location.href);
            url.searchParams.set(`edit[${table}][${targetUid}]`, 'new');
            // The type is always set, so the form shows exactly the fields that were checked.
            if (form.typeField) {
                requested[form.typeField] = form.type;
            }
            const prefilled = [];
            const ignored = [];
            Object.entries(requested).forEach(([field, value]) => {
                if (field === form.typeField || form.fields.includes(field)) {
                    url.searchParams.set(`defVals[${table}][${field}]`, value);
                    prefilled.push(field);
                } else {
                    ignored.push(field);
                }
            });
            url.searchParams.set('returnUrl', Viewport.ContentContainer.getUrl() || '');
            if (!await navigate(() => Viewport.ContentContainer.setUrl(url.toString()))) {
                return textResult(NOT_OPENED);
            }
            return textResult(
                `Opened the form for a new ${table} record`
                + (form.typeField ? ` of ${form.typeField} "${form.type}"` : '')
                + ` on page ${targetUid}${page.title ? ` "${page.title}"` : ''}`
                + (prefilled.length ? ` with ${prefilled.join(', ')} prefilled` : '')
                + '.'
                + (ignored.length ? ` Ignored, as the form does not show them to the editor: ${ignored.join(', ')}.` : '')
                + ' Ask the editor to review and save it.'
            );
        },
    });
}

if (document.modelContext) {
    registerSearchTool();
    registerOpenTool();
    registerPrepareRecordTool();
}
