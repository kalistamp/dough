// Public values injected into the deployed copy by GitHub Actions.
window.SUPABASE_CONFIG = {
    url: 'PUT_YOUR_SUPABASE_URL_HERE',
    anonKey: 'PUT_YOUR_ANON_KEY_HERE',
    schema: 'dough'
};

// Supabase Auth and persistence. Kept inline so the application stays 3 files.
(function () {
    'use strict';

    let clientInstance = null;
    let signedInUserId = null;
    let currentRevision = 0;
    let realtimeChannel = null;

    function configured() {
        const config = window.SUPABASE_CONFIG;
        if (!config || config.schema !== 'dough' || typeof config.url !== 'string' ||
            typeof config.anonKey !== 'string' || config.url.startsWith('PUT_') ||
            config.anonKey.startsWith('PUT_') || config.anonKey.length < 20) return false;
        try {
            const url = new URL(config.url);
            return url.protocol === 'https:' && url.hostname.endsWith('.supabase.co') &&
                !url.username && !url.password;
        } catch (_) {
            return false;
        }
    }

    function client() {
        if (clientInstance) return clientInstance;
        if (!configured() || !window.supabase || !window.supabase.createClient) return null;
        const config = window.SUPABASE_CONFIG;
        clientInstance = window.supabase.createClient(config.url, config.anonKey, {
            db: { schema: config.schema },
            auth: { persistSession: true, autoRefreshToken: true }
        });
        return clientInstance;
    }

    async function getSession() {
        const c = client();
        if (!c) return null;
        const sessionResult = await c.auth.getSession();
        if (sessionResult.error) throw sessionResult.error;
        const session = sessionResult.data ? sessionResult.data.session : null;
        if (!session) {
            signedInUserId = null;
            return null;
        }
        const userResult = await c.auth.getUser();
        if (userResult.error) throw userResult.error;
        const user = userResult.data ? userResult.data.user : null;
        signedInUserId = user ? user.id : null;
        return user ? { ...session, user } : null;
    }

    async function requireUserId() {
        if (signedInUserId) return signedInUserId;
        const session = await getSession();
        if (!session || !session.user) throw new Error('Not signed in');
        return session.user.id;
    }

    async function signIn(email, password) {
        const c = client();
        if (!c) return { ok: false, error: 'Cloud sync is not configured.' };
        const { data, error } = await c.auth.signInWithPassword({ email, password });
        if (error) return { ok: false, error: error.message };
        if (!data.session || !data.user) return { ok: false, error: 'No active session was returned.' };
        signedInUserId = data.session.user.id;
        currentRevision = 0;
        return { ok: true, session: data.session };
    }

    async function signOut() {
        const c = client();
        if (c && realtimeChannel) await c.removeChannel(realtimeChannel);
        realtimeChannel = null;
        signedInUserId = null;
        currentRevision = 0;
        if (c) await c.auth.signOut();
    }

    function rowToTransaction(row) {
        return {
            id: Number(row.id), text: row.text, amount: Number(row.amount),
            type: row.type, day: Number(row.day), paid: !!row.paid
        };
    }

    function transactionToData(transaction) {
        return {
            id: Number(transaction.id),
            text: String(transaction.text || ''),
            amount: Number(transaction.amount),
            type: transaction.type === 'income' ? 'income' : 'expense',
            day: Math.max(1, Math.min(31, Number(transaction.day))),
            paid: !!transaction.paid
        };
    }

    function applyChangesToSnapshot(transactionMap, notes, changes) {
        let nextNotes = notes;
        for (const change of changes || []) {
            if (change.entity_type === 'transaction') {
                const id = Number(change.entity_id);
                if (change.deleted) transactionMap.delete(id);
                else if (change.data) transactionMap.set(id, rowToTransaction(change.data));
            } else if (change.entity_type === 'notes' && !change.deleted) {
                nextNotes = change.data && typeof change.data.body === 'string' ? change.data.body : '';
            }
        }
        return nextNotes;
    }

    async function readChangesSince(revision) {
        const c = client();
        if (!c) throw new Error('Cloud sync is not configured');
        const { data, error } = await c.rpc('read_budget_changes_since', {
            since_revision: Math.max(0, Number(revision) || 0)
        });
        if (error) throw error;
        const result = data || {};
        currentRevision = Math.max(0, Number(result.revision) || 0);
        return {
            revision: currentRevision,
            resetRequired: !!result.reset_required,
            changes: Array.isArray(result.changes) ? result.changes : []
        };
    }

    async function pull(attempt = 0) {
        const c = client();
        if (!c) throw new Error('Cloud sync is not configured');
        const userId = await requireUserId();
        const stateResult = await c.rpc('ensure_budget_state');
        if (stateResult.error) throw stateResult.error;
        const startRevision = Math.max(0, Number(stateResult.data) || 0);
        const [transactionResult, notesResult] = await Promise.all([
            c.from('transactions').select('id,text,amount,type,day,paid')
                .eq('user_id', userId).order('day').order('id').range(0, 4999),
            c.from('notes').select('body').eq('user_id', userId).eq('id', 1).maybeSingle()
        ]);
        if (transactionResult.error) throw transactionResult.error;
        if (notesResult.error) throw notesResult.error;
        if ((transactionResult.data || []).length === 5000) {
            throw new Error('Transaction safety limit reached; archive old rows before syncing.');
        }
        const transactionMap = new Map(
            (transactionResult.data || []).map(row => [Number(row.id), rowToTransaction(row)])
        );
        let notes = notesResult.data ? notesResult.data.body || '' : '';
        const delta = await readChangesSince(startRevision);
        if (delta.resetRequired) {
            if (attempt < 1) return pull(attempt + 1);
            throw new Error('Budget changed too quickly to create a consistent snapshot. Try again.');
        }
        notes = applyChangesToSnapshot(transactionMap, notes, delta.changes);
        return {
            transactions: [...transactionMap.values()],
            notes,
            revision: delta.revision
        };
    }

    async function applyChanges(changes) {
        const c = client();
        if (!c) throw new Error('Cloud sync is not configured');
        await requireUserId();
        if (!Array.isArray(changes) || !changes.length) return currentRevision;
        const { data, error } = await c.rpc('apply_budget_changes', {
            expected_revision: currentRevision,
            changes
        });
        if (error) throw error;
        currentRevision = Math.max(0, Number(data) || 0);
        return currentRevision;
    }

    async function subscribe(onSignal) {
        const c = client();
        if (!c) throw new Error('Cloud sync is not configured');
        const userId = await requireUserId();
        if (realtimeChannel) await c.removeChannel(realtimeChannel);
        const handler = payload => {
            const revision = Number(payload.new && payload.new.revision);
            if (revision > currentRevision && typeof onSignal === 'function') onSignal();
        };
        realtimeChannel = c.channel(`dough-budget-${userId}`)
            .on('postgres_changes', {
                event: 'INSERT', schema: 'dough', table: 'budget_sync_state',
                filter: `user_id=eq.${userId}`
            }, handler)
            .on('postgres_changes', {
                event: 'UPDATE', schema: 'dough', table: 'budget_sync_state',
                filter: `user_id=eq.${userId}`
            }, handler)
            .subscribe(status => {
                if (status === 'SUBSCRIBED' && typeof onSignal === 'function') onSignal();
            });
    }

    window.DoughCloud = {
        configured, getSession, signIn, signOut, pull,
        readChangesSince: () => readChangesSince(currentRevision),
        applyChanges, subscribe, transactionToData,
        getUserId: () => signedInUserId,
        setRevision: revision => {
            currentRevision = Math.max(0, Number(revision) || 0);
        }
    };
})();

// --- SELECT DOM ELEMENTS ---
const $ = id => document.getElementById(id);

const root = document.documentElement;

// Sign-in gate
const loginOverlay = $('login-overlay');
const loginForm = $('login-form');
const emailInput = $('email-input');
const passwordInput = $('password-input');
const loginBtn = $('login-btn');
const loginError = $('login-error');

// Shell
const appContainer = $('app-container');
const topbar = document.querySelector('.topbar');
const currentDateEl = $('current-date');
const themeBtn = $('theme-btn');
const menuBtn = $('menu-btn');
const syncBtn = $('sync-btn');
const syncText = $('sync-text');

// Hero
const balance = $('balance');
const moneyPlus = $('money-plus');
const moneyMinus = $('money-minus');
const nextDue = $('next-due');
const nextDueText = $('next-due-text');
const monthProgressEl = $('month-progress');
const daysLeftEl = $('days-left');

// Period views
const periodTabs = $('period-tabs');
const filterChips = $('filter-chips');
const listP1 = $('list-p1');
const listP2 = $('list-p2');
const emptyP1 = $('empty-p1');
const emptyP2 = $('empty-p2');
const sectionP1 = $('section-p1');
const sectionP2 = $('section-p2');
const ledgerP1 = $('ledger-list-p1');
const ledgerP2 = $('ledger-list-p2');

// Bottom chrome
const addBtn = $('add-btn');
const bottombarLabel = $('bottombar-label');
const bottombarValue = $('bottombar-value');

// Sheets
const entrySheet = $('entry-sheet');
const entryForm = $('entry-form');
const entryTitle = $('entry-title');
const typeToggle = $('type-toggle');
const textInput = $('text');
const amountInput = $('amount');
const dayInput = $('day');
const dayPicker = $('daypicker');
const submitBtn = $('submit-btn');
const menuSheet = $('menu-sheet');
const confirmSheet = $('confirm-sheet');
const confirmTitle = $('confirm-title');
const confirmText = $('confirm-text');
const confirmOk = $('confirm-ok');
const confirmCancel = $('confirm-cancel');
const toastHost = $('toasts');

const notesArea = $('notes-area');

// --- STATE ---
let transactions = [];
let editState = { isEditing: false, id: null };
let entryType = 'expense';
let viewPeriod = 'all';
let viewFilter = 'all';
let appInitialized = false;
let isLoading = true;

let cacheUserId = null;
let cachedTransactionIds = new Set();
let notesCacheTimeout;
let pendingChanges = new Map();
let inFlightChanges = new Map();
const CACHE_PREFIX = 'dough:v2';
const THEME_KEY = 'dough:theme';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

// --- FORMATTING ---
const currencyFormat = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2
});

function formatMoney(value) {
    return currencyFormat.format(Number(value) || 0);
}

function formatSigned(value, type) {
    const sign = type === 'expense' ? '-' : '+';
    return `${sign}${currencyFormat.format(Math.abs(Number(value) || 0))}`;
}

// --- PERIOD & STATUS ---
// Period 1 is the 6th-19th. Period 2 wraps the month boundary (20th-5th), so a
// bare day-number comparison mislabels it: on the 25th a bill due on the 3rd
// belongs to *next* month and is upcoming, not overdue. Resolve each day to a
// real date first, then compare.
function periodOf(day) {
    return day >= 6 && day <= 19 ? 'p1' : 'p2';
}

function resolveDueDate(day, now) {
    const today = now.getDate();
    let monthOffset = 0;
    if (day >= 20 && today <= 5) monthOffset = -1;
    else if (day <= 5 && today >= 20) monthOffset = 1;
    const year = now.getFullYear();
    const month = now.getMonth() + monthOffset;
    const daysInThatMonth = new Date(year, month + 1, 0).getDate();
    return new Date(year, month, Math.min(day, daysInThatMonth));
}

function statusOf(transaction, now) {
    if (transaction.paid) return 'paid';
    if (transaction.type === 'income') return 'income';
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffDays = Math.round((resolveDueDate(transaction.day, now) - midnight) / 86400000);
    if (diffDays < 0) return 'overdue';
    if (diffDays <= 3) return 'due-soon';
    return 'upcoming';
}

const STATUS_LABEL = {
    paid: 'Paid',
    overdue: 'Overdue',
    'due-soon': 'Due soon',
    upcoming: '',
    income: 'Income'
};

function matchesFilter(status, filter) {
    if (filter === 'all') return true;
    if (filter === 'paid') return status === 'paid';
    if (filter === 'unpaid') return status !== 'paid';
    if (filter === 'overdue') return status === 'overdue';
    return true;
}

// --- LOCAL CACHE ---
function cacheKey(suffix) {
    return `${CACHE_PREFIX}:${cacheUserId}:${suffix}`;
}

function writeCacheIndex() {
    if (!cacheUserId) return;
    localStorage.setItem(cacheKey('transaction-ids'), JSON.stringify([...cachedTransactionIds]));
}

function cacheTransaction(transaction, updateIndex = true) {
    if (!cacheUserId) return;
    const id = Number(transaction.id);
    localStorage.setItem(cacheKey(`transaction:${id}`), JSON.stringify(transaction));
    if (!cachedTransactionIds.has(id)) {
        cachedTransactionIds.add(id);
        if (updateIndex) writeCacheIndex();
    }
}

function deleteCachedTransaction(id) {
    if (!cacheUserId) return;
    localStorage.removeItem(cacheKey(`transaction:${Number(id)}`));
    if (cachedTransactionIds.delete(Number(id))) writeCacheIndex();
}

function cacheNotes(value) {
    if (cacheUserId) localStorage.setItem(cacheKey('notes'), String(value || ''));
}

function loadUserCache(userId) {
    cacheUserId = userId;
    cachedTransactionIds = new Set();
    try {
        const ids = JSON.parse(localStorage.getItem(cacheKey('transaction-ids')) || '[]');
        if (Array.isArray(ids)) cachedTransactionIds = new Set(ids.map(Number).filter(Number.isSafeInteger));
        transactions = [...cachedTransactionIds].map(id => {
            const value = localStorage.getItem(cacheKey(`transaction:${id}`));
            return value ? JSON.parse(value) : null;
        }).filter(Boolean);
        notesArea.value = localStorage.getItem(cacheKey('notes')) || '';

        // One-time migration from the original unscoped, full-array cache.
        if (!cachedTransactionIds.size) {
            const legacy = JSON.parse(localStorage.getItem('budgetData') || '[]');
            if (Array.isArray(legacy)) {
                transactions = legacy;
                for (const item of transactions) cacheTransaction(item, false);
                writeCacheIndex();
            }
            const legacyNotes = localStorage.getItem('budgetNotes');
            if (legacyNotes !== null) {
                notesArea.value = legacyNotes;
                cacheNotes(legacyNotes);
            }
        }
        localStorage.removeItem('budgetData');
        localStorage.removeItem('budgetNotes');
        const savedChanges = JSON.parse(localStorage.getItem(cacheKey('pending')) || '[]');
        if (Array.isArray(savedChanges)) {
            pendingChanges = new Map(savedChanges
                .filter(change => change && ['transaction', 'notes'].includes(change.entity_type) &&
                    typeof change.entity_id === 'string' && ['upsert', 'delete'].includes(change.action))
                .map(change => [changeKey(change), change]));
        }
        return {
            ready: localStorage.getItem(cacheKey('ready')) === '1',
            revision: Math.max(0, Number(localStorage.getItem(cacheKey('revision'))) || 0)
        };
    } catch (error) {
        console.error('Error loading local cache:', error);
        transactions = [];
        notesArea.value = '';
        pendingChanges = new Map();
        return { ready: false, revision: 0 };
    }
}

function cacheServerRevision(revision) {
    if (!cacheUserId) return;
    localStorage.setItem(cacheKey('revision'), String(Math.max(0, Number(revision) || 0)));
    localStorage.setItem(cacheKey('ready'), '1');
}

function replaceUserCache(nextTransactions, notes, revision) {
    if (!cacheUserId) return;
    for (const id of cachedTransactionIds) localStorage.removeItem(cacheKey(`transaction:${id}`));
    cachedTransactionIds = new Set();
    for (const item of nextTransactions) cacheTransaction(item, false);
    writeCacheIndex();
    cacheNotes(notes);
    cacheServerRevision(revision);
}

function clearUserCache() {
    if (!cacheUserId) return;
    for (const id of cachedTransactionIds) localStorage.removeItem(cacheKey(`transaction:${id}`));
    localStorage.removeItem(cacheKey('transaction-ids'));
    localStorage.removeItem(cacheKey('notes'));
    localStorage.removeItem(cacheKey('revision'));
    localStorage.removeItem(cacheKey('ready'));
    localStorage.removeItem(cacheKey('pending'));
    cachedTransactionIds = new Set();
    cacheUserId = null;
}

// --- TOASTS ---
function toast(message, kind = 'info', options = {}) {
    const node = document.createElement('div');
    node.className = `toast toast-${kind}`;

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'icon');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', kind === 'error' ? '#i-alert' : kind === 'success' ? '#i-check' : '#i-sync');
    icon.appendChild(use);
    node.appendChild(icon);

    const label = document.createElement('span');
    label.textContent = message;
    node.appendChild(label);

    let timer;
    const dismiss = () => {
        clearTimeout(timer);
        node.classList.add('is-leaving');
        setTimeout(() => node.remove(), 220);
    };

    if (typeof options.onUndo === 'function') {
        const undo = document.createElement('button');
        undo.type = 'button';
        undo.className = 'toast-undo';
        undo.textContent = 'Undo';
        undo.addEventListener('click', () => {
            options.onUndo();
            dismiss();
        });
        node.appendChild(undo);
    }

    toastHost.appendChild(node);
    timer = setTimeout(dismiss, options.duration || (kind === 'error' ? 5200 : 3200));
    return dismiss;
}

// --- SHEETS ---
function openSheet(dialog) {
    dialog.classList.remove('is-closing');
    dialog.style.removeProperty('--drag');
    if (!dialog.open) dialog.showModal();
}

function closeSheet(dialog) {
    if (!dialog.open || dialog.classList.contains('is-closing')) return;
    dialog.classList.add('is-closing');
    const finish = () => {
        dialog.close();
        dialog.classList.remove('is-closing');
        dialog.style.removeProperty('--drag');
    };
    if (reduceMotion.matches) finish();
    else setTimeout(finish, 200);
}

for (const dialog of document.querySelectorAll('dialog.sheet')) {
    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        closeSheet(dialog);
    });
    // Tapping the dimmed backdrop closes the sheet.
    dialog.addEventListener('click', event => {
        if (event.target === dialog) closeSheet(dialog);
    });
    for (const closer of dialog.querySelectorAll('[data-close-sheet]')) {
        closer.addEventListener('click', () => closeSheet(dialog));
    }
    attachSheetDrag(dialog);
}

// Drag the grip or header downward to dismiss, the way a native sheet behaves.
function attachSheetDrag(dialog) {
    const inner = dialog.querySelector('.sheet-inner');
    const handles = dialog.querySelectorAll('.sheet-grip, .sheet-head');
    let startY = 0;
    let offset = 0;
    let dragging = false;

    const move = event => {
        if (!dragging) return;
        offset = Math.max(0, event.clientY - startY);
        inner.style.setProperty('--drag', `${offset}px`);
    };
    const end = () => {
        if (!dragging) return;
        dragging = false;
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', end);
        inner.style.transition = '';
        if (offset > 110) closeSheet(dialog);
        else inner.style.removeProperty('--drag');
    };

    for (const handle of handles) {
        handle.addEventListener('pointerdown', event => {
            if (event.target.closest('button')) return;
            dragging = true;
            startY = event.clientY;
            offset = 0;
            document.addEventListener('pointermove', move);
            document.addEventListener('pointerup', end);
        });
    }
}

let confirmResolver = null;

function askConfirm(title, message, okLabel = 'Confirm') {
    confirmTitle.textContent = title;
    confirmText.textContent = message;
    confirmOk.textContent = okLabel;
    openSheet(confirmSheet);
    return new Promise(resolve => {
        confirmResolver = resolve;
    });
}

function settleConfirm(value) {
    closeSheet(confirmSheet);
    if (confirmResolver) {
        confirmResolver(value);
        confirmResolver = null;
    }
}

confirmOk.addEventListener('click', () => settleConfirm(true));
confirmCancel.addEventListener('click', () => settleConfirm(false));
confirmSheet.addEventListener('close', () => settleConfirm(false));

// --- ANIMATED MONEY ---
function animateMoney(el, value, options = {}) {
    const target = Number(value) || 0;
    const previous = el.dataset.value === undefined ? null : Number(el.dataset.value);
    el.dataset.value = String(target);

    if (options.negativeClass !== false) {
        el.classList.toggle('is-negative', target < 0);
    }

    const format = options.format || formatMoney;
    if (previous === null || previous === target || reduceMotion.matches) {
        el.textContent = format(target);
        return;
    }

    const start = performance.now();
    const duration = 420;
    const step = now => {
        const progress = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        el.textContent = format(previous + (target - previous) * eased);
        if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

// --- HEADER DATE & MONTH PROGRESS ---
function updateDateAndProgress() {
    const now = new Date();
    currentDateEl.textContent = now.toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric'
    });

    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const remaining = daysInMonth - now.getDate();
    monthProgressEl.style.width = `${(now.getDate() / daysInMonth) * 100}%`;
    daysLeftEl.textContent = remaining === 0
        ? 'Last day of the month'
        : `${remaining} day${remaining === 1 ? '' : 's'} left in ${now.toLocaleDateString('en-US', { month: 'long' })}`;
}

// --- SEGMENTED CONTROLS ---
function movePill(container, activeButton) {
    const pill = container.querySelector('.segmented-pill');
    if (!pill || !activeButton) return;
    if (!pill.dataset.ready) {
        pill.classList.add('is-init');
        pill.dataset.ready = '1';
        requestAnimationFrame(() => pill.classList.remove('is-init'));
    }
    pill.style.setProperty('--pill-x', `${activeButton.offsetLeft - container.clientLeft}px`);
    pill.style.setProperty('--pill-w', `${activeButton.offsetWidth}px`);
}

function syncPills() {
    movePill(periodTabs, periodTabs.querySelector('.segment.is-active'));
    movePill(typeToggle, typeToggle.querySelector('.segment.is-active'));
}

periodTabs.addEventListener('click', event => {
    const button = event.target.closest('.segment');
    if (!button) return;
    viewPeriod = button.dataset.period;
    for (const segment of periodTabs.querySelectorAll('.segment')) {
        const active = segment === button;
        segment.classList.toggle('is-active', active);
        segment.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    movePill(periodTabs, button);
    renderTransactions();
    renderBottomBar();
});

typeToggle.addEventListener('click', event => {
    const button = event.target.closest('.segment');
    if (!button) return;
    entryType = button.dataset.type;
    for (const segment of typeToggle.querySelectorAll('.segment')) {
        const active = segment === button;
        segment.classList.toggle('is-active', active);
        segment.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    movePill(typeToggle, button);
});

filterChips.addEventListener('click', event => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    viewFilter = chip.dataset.filter;
    for (const item of filterChips.querySelectorAll('.chip')) {
        const active = item === chip;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    renderTransactions();
});

// --- DAY PICKER ---
function buildDayPicker() {
    const today = new Date().getDate();
    const fragment = document.createDocumentFragment();
    for (let day = 1; day <= 31; day += 1) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'day-cell';
        cell.dataset.day = String(day);
        cell.dataset.period = periodOf(day);
        cell.setAttribute('role', 'radio');
        cell.setAttribute('aria-checked', 'false');
        cell.setAttribute('aria-label', `Day ${day}`);
        cell.textContent = String(day);
        if (day === today) cell.classList.add('is-today');
        fragment.appendChild(cell);
    }
    dayPicker.appendChild(fragment);
}

function setSelectedDay(day) {
    dayInput.value = day ? String(day) : '';
    for (const cell of dayPicker.querySelectorAll('.day-cell')) {
        const selected = Number(cell.dataset.day) === Number(day);
        cell.classList.toggle('is-selected', selected);
        cell.setAttribute('aria-checked', selected ? 'true' : 'false');
    }
}

dayPicker.addEventListener('click', event => {
    const cell = event.target.closest('.day-cell');
    if (!cell) return;
    setSelectedDay(Number(cell.dataset.day));
    clearFieldError($('day-error'));
});

// --- RENDERING ---
function buildRow(transaction, status) {
    const item = document.createElement('li');
    item.className = 'row';
    item.dataset.status = status;
    item.dataset.id = String(transaction.id);

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.appendChild(buildRowAction('edit', '#i-edit', `Edit ${transaction.text}`));
    actions.appendChild(buildRowAction('delete', '#i-trash', `Delete ${transaction.text}`));
    item.appendChild(actions);

    const main = document.createElement('div');
    main.className = 'row-main';

    const checkWrap = document.createElement('label');
    checkWrap.className = 'row-check';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !!transaction.paid;
    checkbox.dataset.action = 'toggle';
    checkbox.setAttribute('aria-label', `Mark ${transaction.text} as paid`);
    checkWrap.appendChild(checkbox);
    main.appendChild(checkWrap);

    const info = document.createElement('div');
    info.className = 'row-info';
    const label = document.createElement('span');
    label.className = 'row-text';
    label.textContent = transaction.text;
    info.appendChild(label);

    const meta = document.createElement('span');
    meta.className = 'row-meta';
    const dayChip = document.createElement('span');
    dayChip.className = 'day-chip';
    dayChip.textContent = `Day ${transaction.day}`;
    meta.appendChild(dayChip);
    const statusLabel = STATUS_LABEL[status];
    if (statusLabel) {
        const tag = document.createElement('span');
        tag.className = 'status-tag';
        tag.textContent = statusLabel;
        meta.appendChild(tag);
    }
    info.appendChild(meta);
    main.appendChild(info);

    const amount = document.createElement('span');
    amount.className = `row-amount money ${transaction.type === 'expense' ? 'minus' : 'plus'}`;
    amount.textContent = formatSigned(transaction.amount, transaction.type);
    main.appendChild(amount);

    item.appendChild(main);
    return item;
}

function buildRowAction(action, iconId, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `row-action row-action-${action}`;
    button.dataset.action = action;
    button.setAttribute('aria-label', label);
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'icon');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', iconId);
    icon.appendChild(use);
    button.appendChild(icon);
    return button;
}

function sortForDisplay(items) {
    return [...items].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'income' ? -1 : 1;
        return a.day - b.day;
    });
}

function renderSkeletons() {
    for (const list of [listP1, listP2]) {
        list.replaceChildren();
        for (let i = 0; i < 3; i += 1) {
            const placeholder = document.createElement('li');
            placeholder.className = 'skeleton-row';
            list.appendChild(placeholder);
        }
    }
    emptyP1.hidden = true;
    emptyP2.hidden = true;
}

function renderTransactions() {
    if (isLoading) return;
    const now = new Date();

    sectionP1.hidden = viewPeriod === 'p2';
    sectionP2.hidden = viewPeriod === 'p1';

    for (const [list, empty, period] of [[listP1, emptyP1, 'p1'], [listP2, emptyP2, 'p2']]) {
        const inPeriod = transactions.filter(item => periodOf(item.day) === period);
        const visible = sortForDisplay(inPeriod)
            .filter(item => matchesFilter(statusOf(item, now), viewFilter));

        list.replaceChildren();
        for (const item of visible) list.appendChild(buildRow(item, statusOf(item, now)));

        empty.hidden = visible.length > 0;
        if (!visible.length) {
            empty.querySelector('span').textContent = inPeriod.length
                ? 'Nothing matches this filter.'
                : 'No entries in this period yet.';
        }
    }
}

function renderLedger() {
    for (const [body, period] of [[ledgerP1, 'p1'], [ledgerP2, 'p2']]) {
        const bills = transactions
            .filter(item => item.type === 'expense' && periodOf(item.day) === period)
            .sort((a, b) => a.day - b.day);

        body.replaceChildren();
        if (!bills.length) {
            const row = document.createElement('tr');
            row.className = 'ledger-empty';
            const cell = document.createElement('td');
            cell.colSpan = 2;
            cell.textContent = 'No recurring bills yet.';
            row.appendChild(cell);
            body.appendChild(row);
            continue;
        }
        for (const bill of bills) {
            const row = document.createElement('tr');
            const dayCell = document.createElement('td');
            const badge = document.createElement('span');
            badge.className = 'ledger-day';
            badge.textContent = String(bill.day);
            dayCell.appendChild(badge);
            const nameCell = document.createElement('td');
            nameCell.textContent = bill.text;
            row.appendChild(dayCell);
            row.appendChild(nameCell);
            body.appendChild(row);
        }
    }
}

function totalsFor(items) {
    let income = 0;
    let expense = 0;
    let paid = 0;
    let bills = 0;
    for (const item of items) {
        if (item.type === 'income') income += item.amount;
        else {
            expense += item.amount;
            bills += 1;
            if (item.paid) paid += 1;
        }
    }
    return { income, expense, balance: income - expense, paid, bills };
}

function updateValues() {
    const now = new Date();
    const p1 = totalsFor(transactions.filter(item => periodOf(item.day) === 'p1'));
    const p2 = totalsFor(transactions.filter(item => periodOf(item.day) === 'p2'));
    const all = totalsFor(transactions);

    animateMoney(balance, all.balance);
    animateMoney(moneyPlus, all.income, { negativeClass: false });
    animateMoney(moneyMinus, all.expense, { negativeClass: false });

    for (const [prefix, totals] of [['p1', p1], ['p2', p2]]) {
        animateMoney($(`${prefix}-income`), totals.income, { negativeClass: false });
        animateMoney($(`${prefix}-expense`), totals.expense, { negativeClass: false });
        animateMoney($(`${prefix}-balance`), totals.balance);
        $(`${prefix}-paid`).textContent = `${totals.paid} / ${totals.bills}`;
        $(`${prefix}-paid-meter`).style.width =
            `${totals.bills ? (totals.paid / totals.bills) * 100 : 0}%`;
    }

    renderChipCounts(now);
    renderNextDue(now);
    renderBottomBar({ p1, p2, all });
}

function renderChipCounts(now) {
    const scope = transactions.filter(item =>
        viewPeriod === 'all' ? true : periodOf(item.day) === viewPeriod);
    const counts = { all: scope.length, unpaid: 0, overdue: 0, paid: 0 };
    for (const item of scope) {
        const status = statusOf(item, now);
        if (status === 'paid') counts.paid += 1;
        else counts.unpaid += 1;
        if (status === 'overdue') counts.overdue += 1;
    }
    for (const [key, value] of Object.entries(counts)) {
        const node = filterChips.querySelector(`[data-count="${key}"]`);
        if (!node) continue;
        node.textContent = String(value);
        node.closest('.chip').classList.toggle('is-empty', value === 0 && key !== 'all');
    }
}

function renderNextDue(now) {
    const upcoming = transactions
        .filter(item => item.type === 'expense' && !item.paid)
        .map(item => ({ item, due: resolveDueDate(item.day, now) }))
        .sort((a, b) => a.due - b.due);

    if (!upcoming.length) {
        nextDue.hidden = true;
        return;
    }

    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const overdue = upcoming.filter(entry => entry.due < midnight);
    nextDue.hidden = false;

    if (overdue.length) {
        const total = overdue.reduce((sum, entry) => sum + entry.item.amount, 0);
        nextDueText.textContent = overdue.length === 1
            ? `${overdue[0].item.text} is overdue — ${formatMoney(total)}`
            : `${overdue.length} bills overdue — ${formatMoney(total)}`;
        return;
    }

    const next = upcoming[0];
    const days = Math.round((next.due - midnight) / 86400000);
    const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
    nextDueText.textContent = `${next.item.text} due ${when} — ${formatMoney(next.item.amount)}`;
}

function renderBottomBar(precomputed) {
    const totals = precomputed || {
        p1: totalsFor(transactions.filter(item => periodOf(item.day) === 'p1')),
        p2: totalsFor(transactions.filter(item => periodOf(item.day) === 'p2')),
        all: totalsFor(transactions)
    };
    const active = viewPeriod === 'p1' ? totals.p1 : viewPeriod === 'p2' ? totals.p2 : totals.all;
    bottombarLabel.textContent = viewPeriod === 'all'
        ? 'Remaining this month'
        : `Remaining in ${viewPeriod === 'p1' ? 'Period 1' : 'Period 2'}`;
    animateMoney(bottombarValue, active.balance);
}

function renderAll() {
    renderTransactions();
    updateValues();
    renderLedger();
}

// --- TRANSACTION ACTIONS ---
function generateID() {
    const random = new Uint32Array(2);
    crypto.getRandomValues(random);
    let id = random[0] * 0x200000 + (random[1] >>> 11);
    if (!Number.isSafeInteger(id) || id <= 0) id = Date.now();
    while (transactions.some(item => item.id === id)) id += 1;
    return id;
}

function setFieldError(node, message) {
    node.textContent = message;
    node.closest('.field').classList.add('is-invalid');
}

function clearFieldError(node) {
    node.textContent = '';
    node.closest('.field').classList.remove('is-invalid');
}

function openEntrySheet(transaction) {
    clearFieldError($('text-error'));
    clearFieldError($('amount-error'));
    clearFieldError($('day-error'));

    if (transaction) {
        editState = { isEditing: true, id: transaction.id };
        entryTitle.textContent = 'Edit entry';
        submitBtn.textContent = 'Save changes';
        textInput.value = transaction.text;
        amountInput.value = transaction.amount;
        setSelectedDay(transaction.day);
        setEntryType(transaction.type);
    } else {
        editState = { isEditing: false, id: null };
        entryTitle.textContent = 'Add entry';
        submitBtn.textContent = 'Add entry';
        textInput.value = '';
        amountInput.value = '';
        setSelectedDay(new Date().getDate());
        setEntryType('expense');
    }

    openSheet(entrySheet);
    requestAnimationFrame(() => {
        movePill(typeToggle, typeToggle.querySelector('.segment.is-active'));
        if (!transaction) textInput.focus();
    });
}

function setEntryType(type) {
    entryType = type === 'income' ? 'income' : 'expense';
    for (const segment of typeToggle.querySelectorAll('.segment')) {
        const active = segment.dataset.type === entryType;
        segment.classList.toggle('is-active', active);
        segment.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    movePill(typeToggle, typeToggle.querySelector('.segment.is-active'));
}

entryForm.addEventListener('submit', event => {
    event.preventDefault();

    const description = textInput.value.trim();
    const parsedAmount = Number(amountInput.value);
    const parsedDay = Number(dayInput.value);
    let valid = true;

    clearFieldError($('text-error'));
    clearFieldError($('amount-error'));
    clearFieldError($('day-error'));

    if (!description) {
        setFieldError($('text-error'), 'Add a short description.');
        valid = false;
    } else if (description.length > 200) {
        setFieldError($('text-error'), 'Keep it under 200 characters.');
        valid = false;
    }
    if (!amountInput.value.trim() || !Number.isFinite(parsedAmount) ||
        parsedAmount < 0 || parsedAmount > 1000000000) {
        setFieldError($('amount-error'), 'Enter a valid amount.');
        valid = false;
    }
    if (!Number.isInteger(parsedDay) || parsedDay < 1 || parsedDay > 31) {
        setFieldError($('day-error'), 'Pick a day of the month.');
        valid = false;
    }
    if (!valid) return;

    const data = {
        text: description,
        amount: parsedAmount,
        type: entryType,
        day: parsedDay,
        paid: false
    };

    const wasEditing = editState.isEditing;
    let changed;
    if (wasEditing) {
        transactions = transactions.map(item => {
            if (item.id !== editState.id) return item;
            changed = { ...item, ...data, id: editState.id, paid: item.paid };
            return changed;
        });
    } else {
        changed = { ...data, id: generateID() };
        transactions.push(changed);
    }

    editState = { isEditing: false, id: null };
    queueTransactionUpsert(changed);
    renderAll();
    closeSheet(entrySheet);
    toast(wasEditing ? 'Entry updated' : 'Entry saved', 'success');
});

function removeTransaction(id) {
    const removed = transactions.find(item => item.id === id);
    if (!removed) return;
    transactions = transactions.filter(item => item.id !== id);
    queueTransactionDelete(id);
    renderAll();
    toast(`Deleted "${removed.text}"`, 'info', {
        duration: 6000,
        onUndo: () => {
            transactions.push(removed);
            queueTransactionUpsert(removed);
            renderAll();
            toast('Restored', 'success');
        }
    });
}

function togglePaid(id) {
    const item = transactions.find(entry => entry.id === id);
    if (!item) return;
    item.paid = !item.paid;
    queueTransactionUpsert(item);
    renderAll();
}

async function resetMonthStatus() {
    const paidCount = transactions.filter(item => item.paid).length;
    if (!paidCount) {
        toast('Nothing is checked off yet', 'info');
        return;
    }
    const ok = await askConfirm(
        'Reset checkboxes?',
        `This unchecks ${paidCount} paid ${paidCount === 1 ? 'entry' : 'entries'} so you can start a new month. Amounts are not changed.`,
        'Reset'
    );
    if (!ok) return;

    const snapshot = transactions.filter(item => item.paid).map(item => item.id);
    for (const item of transactions) {
        if (item.paid) {
            item.paid = false;
            queueTransactionUpsert(item, false);
        }
    }
    persistOutstandingChanges();
    saveToCloud();
    renderAll();
    toast(`Unchecked ${snapshot.length} ${snapshot.length === 1 ? 'entry' : 'entries'}`, 'success', {
        duration: 6000,
        onUndo: () => {
            for (const item of transactions) {
                if (snapshot.includes(item.id)) {
                    item.paid = true;
                    queueTransactionUpsert(item, false);
                }
            }
            persistOutstandingChanges();
            saveToCloud();
            renderAll();
        }
    });
}

// --- ROW INTERACTION (tap + swipe) ---
const SWIPE_REVEAL = 124;
let swipe = null;

function closeOpenRows(except) {
    for (const row of document.querySelectorAll('.row.is-open')) {
        if (row !== except) row.classList.remove('is-open');
    }
}

for (const list of [listP1, listP2]) {
    list.addEventListener('click', event => {
        const control = event.target.closest('button[data-action]');
        if (!control) return;
        const row = control.closest('.row');
        const id = Number(row && row.dataset.id);
        if (!Number.isSafeInteger(id)) return;
        row.classList.remove('is-open');
        if (control.dataset.action === 'edit') {
            openEntrySheet(transactions.find(item => item.id === id));
        } else if (control.dataset.action === 'delete') {
            removeTransaction(id);
        }
    });

    list.addEventListener('change', event => {
        if (!event.target.matches('input[data-action="toggle"]')) return;
        const row = event.target.closest('.row');
        const id = Number(row && row.dataset.id);
        if (Number.isSafeInteger(id)) togglePaid(id);
    });

    list.addEventListener('pointerdown', event => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        if (event.target.closest('button, input, label')) return;
        const main = event.target.closest('.row-main');
        if (!main) return;
        swipe = {
            row: main.closest('.row'),
            main,
            startX: event.clientX,
            startY: event.clientY,
            base: main.closest('.row').classList.contains('is-open') ? -SWIPE_REVEAL : 0,
            active: false
        };
    });
}

document.addEventListener('pointermove', event => {
    if (!swipe) return;
    const dx = event.clientX - swipe.startX;
    const dy = event.clientY - swipe.startY;

    if (!swipe.active) {
        if (Math.abs(dy) > Math.abs(dx) || Math.abs(dx) < 8) {
            if (Math.abs(dy) > 10) swipe = null;
            return;
        }
        swipe.active = true;
        swipe.row.classList.add('is-dragging');
        closeOpenRows(swipe.row);
    }

    const next = Math.max(-SWIPE_REVEAL, Math.min(0, swipe.base + dx));
    swipe.main.style.transform = `translateX(${next}px)`;
});

document.addEventListener('pointerup', event => {
    if (!swipe) return;
    const current = swipe;
    swipe = null;
    if (!current.active) return;

    const dx = event.clientX - current.startX;
    const offset = Math.max(-SWIPE_REVEAL, Math.min(0, current.base + dx));
    current.row.classList.remove('is-dragging');
    current.main.style.removeProperty('transform');
    current.row.classList.toggle('is-open', offset < -SWIPE_REVEAL / 2);
});

document.addEventListener('pointercancel', () => {
    if (swipe && swipe.active) {
        swipe.row.classList.remove('is-dragging');
        swipe.main.style.removeProperty('transform');
    }
    swipe = null;
});

// --- SUPABASE SYNC ---
let syncTimeout;
let lastSyncedTime = null;
let saveInFlight = false;
let saveQueued = false;
let remoteSyncTimeout;
let remoteSyncInFlight = null;

function persistOutstandingChanges() {
    if (!cacheUserId) return;
    const outstanding = new Map([...inFlightChanges, ...pendingChanges]);
    localStorage.setItem(cacheKey('pending'), JSON.stringify([...outstanding.values()]));
}

function changeKey(change) {
    return `${change.entity_type}:${change.entity_id}`;
}

function queueTransactionUpsert(transaction, schedule = true) {
    if (!transaction) return;
    cacheTransaction(transaction);
    const change = {
        entity_type: 'transaction',
        entity_id: String(transaction.id),
        action: 'upsert',
        data: window.DoughCloud.transactionToData(transaction)
    };
    pendingChanges.set(changeKey(change), change);
    if (schedule) {
        persistOutstandingChanges();
        saveToCloud();
    }
}

function queueTransactionDelete(id) {
    deleteCachedTransaction(id);
    const change = {
        entity_type: 'transaction', entity_id: String(id),
        action: 'delete', data: null
    };
    pendingChanges.set(changeKey(change), change);
    persistOutstandingChanges();
    saveToCloud();
}

function queueNotes(value) {
    const change = {
        entity_type: 'notes', entity_id: '1', action: 'upsert',
        data: { body: String(value || '') }
    };
    pendingChanges.set(changeKey(change), change);
    saveToCloud();
}

// Sync state now lives in a stable status pill; failures surface as a toast
// instead of a 3.5s label swap nobody sees.
function setSyncState(state, label) {
    syncBtn.dataset.state = state;
    syncText.textContent = label;
}

function updateSyncTimestamp() {
    const node = $('sync-timestamp');
    if (!node) return;
    if (!lastSyncedTime) {
        node.textContent = 'Not synced yet';
        return;
    }
    const seconds = Math.floor((Date.now() - lastSyncedTime) / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (seconds < 60) node.textContent = 'Synced just now';
    else if (minutes < 60) node.textContent = `Synced ${minutes} min${minutes === 1 ? '' : 's'} ago`;
    else node.textContent = `Synced ${hours} hour${hours === 1 ? '' : 's'} ago`;
}

setInterval(updateSyncTimestamp, 60000);

function markSynced() {
    lastSyncedTime = Date.now();
    updateSyncTimestamp();
    setSyncState('ok', 'Synced');
}

function saveToCloud() {
    clearTimeout(syncTimeout);
    syncTimeout = setTimeout(flushCloudSave, 750);
}

async function flushCloudSave() {
    if (saveInFlight) {
        saveQueued = true;
        return;
    }
    if (!pendingChanges.size) return;
    saveInFlight = true;
    const entries = [...pendingChanges.entries()];
    for (const [key, change] of entries) {
        if (pendingChanges.get(key) === change) pendingChanges.delete(key);
    }
    inFlightChanges = new Map(entries);
    setSyncState('busy', 'Saving');
    let savedRevision = null;
    try {
        const changes = entries.map(([, change]) => change);
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                savedRevision = await window.DoughCloud.applyChanges(changes);
                break;
            } catch (error) {
                const conflict = error && (error.code === '40001' ||
                    String(error.message || '').includes('DOUGH_REVISION_CONFLICT'));
                if (!conflict || attempt === 1) throw error;
                await syncRemoteChanges(new Set(entries.map(([key]) => key)));
            }
        }
        cacheServerRevision(savedRevision);
        markSynced();
    } catch (error) {
        for (const [key, change] of entries) {
            if (!pendingChanges.has(key)) pendingChanges.set(key, change);
        }
        console.error('Error saving to Supabase:', error);
        setSyncState('error', 'Not saved');
        toast('Changes could not be saved. They are stored on this device and will retry.', 'error');
    } finally {
        inFlightChanges = new Map();
        persistOutstandingChanges();
        saveInFlight = false;
        if (saveQueued || pendingChanges.size) {
            saveQueued = false;
            saveToCloud();
        }
    }
}

function applyRemoteChanges(changes, protectedKeys = new Set()) {
    let changedTransactions = false;
    let changedNotes = false;
    for (const change of changes || []) {
        if (protectedKeys.has(changeKey(change))) continue;
        if (change.entity_type === 'transaction') {
            const id = Number(change.entity_id);
            if (change.deleted) {
                transactions = transactions.filter(item => item.id !== id);
                deleteCachedTransaction(id);
            } else if (change.data) {
                const item = window.DoughCloud.transactionToData(change.data);
                const index = transactions.findIndex(existing => existing.id === id);
                if (index >= 0) transactions[index] = item;
                else transactions.push(item);
                cacheTransaction(item);
            }
            changedTransactions = true;
        } else if (change.entity_type === 'notes' && !change.deleted) {
            notesArea.value = change.data && typeof change.data.body === 'string'
                ? change.data.body : '';
            cacheNotes(notesArea.value);
            changedNotes = true;
        }
    }
    if (changedTransactions) renderAll();
    return changedTransactions || changedNotes;
}

function allProtectedChanges(extraKeys = new Set()) {
    const protectedChanges = new Map([...inFlightChanges, ...pendingChanges]);
    for (const key of extraKeys) {
        if (inFlightChanges.has(key)) protectedChanges.set(key, inFlightChanges.get(key));
        else if (pendingChanges.has(key)) protectedChanges.set(key, pendingChanges.get(key));
    }
    return protectedChanges;
}

function reapplyProtectedChanges(protectedChanges) {
    applyRemoteChanges([...protectedChanges.values()].map(change => ({
        entity_type: change.entity_type,
        entity_id: change.entity_id,
        deleted: change.action === 'delete',
        data: change.data
    })));
}

async function syncFromCloud(protectedChanges = new Map()) {
    setSyncState('busy', 'Loading');
    try {
        const data = await window.DoughCloud.pull();
        transactions = data.transactions;
        notesArea.value = data.notes;
        replaceUserCache(transactions, notesArea.value, data.revision);
        if (protectedChanges.size) reapplyProtectedChanges(protectedChanges);
        isLoading = false;
        renderAll();
        markSynced();
        return true;
    } catch (error) {
        console.error('Error loading from Supabase:', error);
        isLoading = false;
        renderAll();
        setSyncState('error', 'Offline');
        toast('Could not reach the cloud. Showing the copy stored on this device.', 'error');
        return false;
    }
}

async function syncRemoteChanges(extraProtectedKeys = new Set()) {
    if (remoteSyncInFlight) return remoteSyncInFlight;
    remoteSyncInFlight = (async () => {
        const protectedChanges = allProtectedChanges(extraProtectedKeys);
        const delta = await window.DoughCloud.readChangesSince();
        if (delta.resetRequired) return syncFromCloud(protectedChanges);
        applyRemoteChanges(delta.changes, new Set(protectedChanges.keys()));
        cacheServerRevision(delta.revision);
        isLoading = false;
        markSynced();
        return true;
    })();
    try {
        return await remoteSyncInFlight;
    } finally {
        remoteSyncInFlight = null;
    }
}

function scheduleRemoteSync() {
    clearTimeout(remoteSyncTimeout);
    remoteSyncTimeout = setTimeout(() => {
        syncRemoteChanges().catch(error => console.error('Realtime sync failed:', error));
    }, 200);
}

async function manualSync() {
    setSyncState('busy', 'Syncing');
    try {
        await syncRemoteChanges();
        renderAll();
        toast('Up to date', 'success');
    } catch (error) {
        console.error('Manual sync failed:', error);
        setSyncState('error', 'Sync failed');
        toast('Sync failed. Your changes are safe on this device.', 'error');
    }
}

// --- MENU ---
menuBtn.addEventListener('click', () => {
    updateSyncTimestamp();
    openSheet(menuSheet);
});

$('menu-sync').addEventListener('click', () => {
    closeSheet(menuSheet);
    manualSync();
});

$('menu-reset').addEventListener('click', () => {
    closeSheet(menuSheet);
    setTimeout(resetMonthStatus, 220);
});

$('menu-signout').addEventListener('click', async () => {
    closeSheet(menuSheet);
    const ok = await askConfirm(
        'Sign out?',
        'Your budget stays in the cloud. The copy cached on this device is cleared.',
        'Sign out'
    );
    if (ok) signOutOfApp();
});

syncBtn.addEventListener('click', manualSync);
addBtn.addEventListener('click', () => openEntrySheet(null));

async function signOutOfApp() {
    clearTimeout(syncTimeout);
    clearTimeout(remoteSyncTimeout);
    clearTimeout(notesCacheTimeout);
    saveQueued = false;
    pendingChanges.clear();
    inFlightChanges.clear();
    clearUserCache();
    await window.DoughCloud.signOut();
    appInitialized = false;
    isLoading = true;
    transactions = [];
    notesArea.value = '';
    appContainer.hidden = true;
    loginOverlay.hidden = false;
    loginOverlay.dataset.state = 'form';
}

// --- NOTES ---
notesArea.addEventListener('input', event => {
    clearTimeout(notesCacheTimeout);
    notesCacheTimeout = setTimeout(() => {
        cacheNotes(event.target.value);
        persistOutstandingChanges();
    }, 300);
    queueNotes(event.target.value);
});

window.addEventListener('pagehide', () => {
    cacheNotes(notesArea.value);
    persistOutstandingChanges();
});

// --- THEME ---
function effectiveDark() {
    if (root.classList.contains('theme-dark')) return true;
    if (root.classList.contains('theme-light')) return false;
    return darkQuery.matches;
}

function syncThemeColor() {
    const color = getComputedStyle(document.body).backgroundColor;
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
        meta.setAttribute('content', color);
    }
}

function applyTheme(preference) {
    root.classList.toggle('theme-dark', preference === 'dark');
    root.classList.toggle('theme-light', preference === 'light');
    requestAnimationFrame(syncThemeColor);
}

function toggleTheme() {
    const next = effectiveDark() ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
}

themeBtn.addEventListener('click', () => {
    if (!document.startViewTransition || reduceMotion.matches) {
        toggleTheme();
        return;
    }
    document.startViewTransition(() => toggleTheme());
});

darkQuery.addEventListener('change', syncThemeColor);

// --- SIGN IN ---
loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    loginError.textContent = '';
    loginBtn.disabled = true;
    loginBtn.dataset.busy = '1';
    try {
        const result = await window.DoughCloud.signIn(emailInput.value.trim(), passwordInput.value);
        if (!result.ok) throw new Error(result.error);
        passwordInput.value = '';
        await showApp();
    } catch (error) {
        loginError.textContent = error.message || 'Unable to sign in';
    } finally {
        loginBtn.disabled = false;
        loginBtn.dataset.busy = '0';
    }
});

// --- BOOT ---
async function init() {
    if (appInitialized) return syncRemoteChanges();
    appInitialized = true;
    const userId = window.DoughCloud.getUserId();
    if (!userId) throw new Error('Your session could not be verified.');
    const cached = loadUserCache(userId);
    window.DoughCloud.setRevision(cached.revision);
    updateDateAndProgress();

    if (transactions.length) {
        isLoading = false;
        renderAll();
    }

    if (cached.ready) await syncRemoteChanges();
    else await syncFromCloud(allProtectedChanges());

    isLoading = false;
    renderAll();
    syncPills();

    await window.DoughCloud.subscribe(scheduleRemoteSync);
    if (pendingChanges.size) saveToCloud();
}

async function showApp() {
    loginOverlay.hidden = true;
    appContainer.hidden = false;
    renderSkeletons();
    requestAnimationFrame(syncPills);
    await init();
}

window.addEventListener('resize', syncPills);

window.addEventListener('scroll', () => {
    topbar.classList.toggle('is-stuck', window.scrollY > 4);
}, { passive: true });

async function boot() {
    buildDayPicker();
    applyTheme(localStorage.getItem(THEME_KEY));
    updateDateAndProgress();

    if (!window.DoughCloud || !window.DoughCloud.configured()) {
        loginOverlay.dataset.state = 'form';
        loginError.textContent = 'Cloud sync is not configured. Check the Pages deployment.';
        loginBtn.disabled = true;
        return;
    }
    try {
        const session = await window.DoughCloud.getSession();
        if (session) await showApp();
        else loginOverlay.dataset.state = 'form';
    } catch (error) {
        loginOverlay.dataset.state = 'form';
        loginError.textContent = error.message || 'Unable to connect to Supabase';
    }
}

boot();
