// Public values injected into the deployed copy by GitHub Actions.
window.SUPABASE_CONFIG = {
    url: 'PUT_YOUR_SUPABASE_URL_HERE',
    anonKey: 'PUT_YOUR_ANON_KEY_HERE',
    schema: 'dough'
};

// Supabase Auth and persistence. Kept inline so the application stays 3 files.
(function () {
    'use strict';

    const URL_PLACEHOLDER = 'PUT_YOUR_SUPABASE_URL_HERE';
    const KEY_PLACEHOLDER = 'PUT_YOUR_ANON_KEY_HERE';
    let clientInstance = null;
    let signedInUserId = null;
    let currentRevision = 0;
    let realtimeChannel = null;

    function configured() {
        const config = window.SUPABASE_CONFIG;
        if (!config || config.schema !== 'dough' || config.url === URL_PLACEHOLDER ||
            config.anonKey === KEY_PLACEHOLDER || typeof config.anonKey !== 'string' ||
            config.anonKey.length < 20) return false;
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
// Monthly Totals
const balance = document.getElementById('balance');
const money_plus = document.getElementById('money-plus');
const money_minus = document.getElementById('money-minus');

// Period 1 Elements
const p1_income = document.getElementById('p1-income');
const p1_expense = document.getElementById('p1-expense');
const p1_balance = document.getElementById('p1-balance');
const list_p1 = document.getElementById('list-p1');
const ledger_list_p1 = document.getElementById('ledger-list-p1');

// Period 2 Elements
const p2_income = document.getElementById('p2-income');
const p2_expense = document.getElementById('p2-expense');
const p2_balance = document.getElementById('p2-balance');
const list_p2 = document.getElementById('list-p2');
const ledger_list_p2 = document.getElementById('ledger-list-p2');

// Form Elements
const form = document.getElementById('form');
const typeInput = document.getElementById('type');
const text = document.getElementById('text');
const amount = document.getElementById('amount');
const dayInput = document.getElementById('day');
const submitBtn = document.getElementById('submit-btn');

// Login Elements
const loginOverlay = document.getElementById('login-overlay');
const appContainer = document.getElementById('app-container');
const emailInput = document.getElementById('email-input');
const passwordInput = document.getElementById('password-input');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const signOutBtn = document.getElementById('sign-out-btn');

// Header Elements
const currentDateEl = document.getElementById('current-date');
const monthProgressEl = document.getElementById('month-progress');
const daysLeftEl = document.getElementById('days-left');

// Notes Element
const notesArea = document.getElementById('notes-area');

// --- STATE MANAGEMENT ---
let transactions = [];
let editState = { isEditing: false, id: null };
let appInitialized = false;
let cacheUserId = null;
let cachedTransactionIds = new Set();
let notesCacheTimeout;
const CACHE_PREFIX = 'dough:v2';

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

// --- LOGIN LOGIC ---
loginBtn.addEventListener('click', signIn);
emailInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') signIn();
});
passwordInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') signIn();
});

async function signIn() {
    loginError.innerText = '';
    loginBtn.disabled = true;
    loginBtn.innerText = 'Signing in...';
    try {
        const result = await window.DoughCloud.signIn(
            emailInput.value.trim(), passwordInput.value
        );
        if (!result.ok) throw new Error(result.error);
        passwordInput.value = '';
        await showApp();
    } catch (error) {
        loginError.innerText = error.message || 'Unable to sign in';
    } finally {
        loginBtn.disabled = false;
        loginBtn.innerText = 'Sign in';
    }
}

signOutBtn.addEventListener('click', async () => {
    clearTimeout(syncTimeout);
    clearTimeout(remoteSyncTimeout);
    clearTimeout(notesCacheTimeout);
    saveQueued = false;
    pendingChanges.clear();
    inFlightChanges.clear();
    clearUserCache();
    await window.DoughCloud.signOut();
    appInitialized = false;
    transactions = [];
    notesArea.value = '';
    appContainer.style.display = 'none';
    loginOverlay.style.display = 'flex';
});

// --- DATE & PROGRESS LOGIC ---
function updateDateAndProgress() {
    const now = new Date();
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    currentDateEl.innerText = now.toLocaleDateString('en-US', options);

    const currentDay = now.getDate();
    const currentMonth = now.getMonth(); 
    const currentYear = now.getFullYear();
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const percentage = (currentDay / daysInMonth) * 100;
    
    monthProgressEl.style.width = `${percentage}%`;
    daysLeftEl.innerText = `${daysInMonth - currentDay} days remaining in month`;
}

// --- APP FUNCTIONS ---

function handleTransactionSubmit(e) {
    e.preventDefault();

    if (text.value.trim() === '' || amount.value.trim() === '' || dayInput.value.trim() === '') {
        alert('Please add a description, amount, and day');
        return;
    }

    const parsedAmount = Number(amount.value);
    const parsedDay = Number(dayInput.value);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 0 || parsedAmount > 1000000000 ||
        !Number.isInteger(parsedDay) || parsedDay < 1 || parsedDay > 31 || text.value.trim().length > 200) {
        alert('Please enter a valid day, description, and amount.');
        return;
    }

    const transactionData = {
        text: text.value.trim(),
        amount: parsedAmount,
        type: typeInput.value,
        day: parsedDay,
        paid: false 
    };

    let changedTransaction;
    if (editState.isEditing) {
        transactions = transactions.map(item => {
            if (item.id === editState.id) {
                changedTransaction = { ...item, ...transactionData, id: editState.id, paid: item.paid };
                return changedTransaction;
            }
            return item;
        });
        
        editState = { isEditing: false, id: null };
        submitBtn.innerText = "Add Transaction";
        submitBtn.style.backgroundColor = "var(--primary-color)";
    } else {
        const newTransaction = {
            ...transactionData,
            id: generateID()
        };
        transactions.push(newTransaction);
        changedTransaction = newTransaction;
    }

    queueTransactionUpsert(changedTransaction);
    renderTransactions();
    updateValues();
    updateLedger();

    text.value = '';
    amount.value = '';
    dayInput.value = '';
    text.focus();
}

function generateID() {
    const random = new Uint32Array(2);
    crypto.getRandomValues(random);
    let id = random[0] * 0x200000 + (random[1] >>> 11);
    if (!Number.isSafeInteger(id) || id <= 0) id = Date.now();
    while (transactions.some(item => item.id === id)) id += 1;
    return id;
}

function escapeHTML(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function renderTransactions() {
    list_p1.innerHTML = '';
    list_p2.innerHTML = '';

    const currentDay = new Date().getDate();

    // Sort by type (income first), then by day
    transactions.sort((a, b) => {
        if (a.type === 'income' && b.type === 'expense') return -1;
        if (a.type === 'expense' && b.type === 'income') return 1;
        return a.day - b.day;
    });

    transactions.forEach(transaction => {
        const sign = transaction.type === 'expense' ? '-' : '+';
        const itemClass = transaction.type === 'expense' ? 'minus' : 'plus';
        const item = document.createElement('li');
        
        item.classList.add(itemClass);
        
        if (transaction.paid) {
            item.classList.add('completed');
        } else if (transaction.type === 'expense') {
            if (transaction.day < currentDay) {
                item.classList.add('overdue');
            } else if (transaction.day >= currentDay && transaction.day <= currentDay + 3) {
                item.classList.add('upcoming');
            }
        }

        item.innerHTML = `
            <div style="display:flex; align-items:center;">
                <div class="checkbox-container">
                    <input type="checkbox" 
                        ${transaction.paid ? 'checked' : ''} 
                        data-action="toggle" data-transaction-id="${transaction.id}"
                        aria-label="Mark ${escapeHTML(transaction.text)} as paid"
                    >
                </div>
                <div class="list-info">
                    <span class="list-date">Day ${transaction.day}</span>
                    <span>${escapeHTML(transaction.text)}</span>
                </div>
            </div>
            <div>
                <span class="money">${sign}$${Math.abs(transaction.amount).toFixed(2)}</span>
                <div class="list-actions" style="display:inline-block; margin-left:10px;">
                    <button class="action-btn edit-btn" type="button" data-action="edit"
                        data-transaction-id="${transaction.id}" aria-label="Edit ${escapeHTML(transaction.text)}">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="action-btn delete-btn" type="button" data-action="delete"
                        data-transaction-id="${transaction.id}" aria-label="Delete ${escapeHTML(transaction.text)}">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            </div>
        `;

        // Period 1: 6th - 19th
        // Period 2: 20th - 31st AND 1st - 5th
        if (transaction.day >= 6 && transaction.day <= 19) {
            list_p1.appendChild(item);
        } else {
            list_p2.appendChild(item);
        }
    });
}

function updateLedger() {
    ledger_list_p1.innerHTML = '';
    ledger_list_p2.innerHTML = '';
    
    const expenses = transactions
        .filter(t => t.type === 'expense')
        .sort((a, b) => a.day - b.day);

    expenses.forEach(exp => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td><span class="ledger-day-badge">${exp.day}</span></td>
            <td>${escapeHTML(exp.text)}</td>
        `;

        if (exp.day >= 6 && exp.day <= 19) {
            ledger_list_p1.appendChild(row);
        } else {
            ledger_list_p2.appendChild(row);
        }
    });
}

function updateValues() {
    const calcTotal = (items, type) => {
        return items
            .filter(item => item.type === type)
            .reduce((acc, item) => (acc += item.amount), 0);
    };

    const p1_items = transactions.filter(t => t.day >= 6 && t.day <= 19);
    const p2_items = transactions.filter(t => t.day >= 20 || t.day <= 5);

    const p1_inc = calcTotal(p1_items, 'income');
    const p1_exp = calcTotal(p1_items, 'expense');
    const p1_bal = p1_inc - p1_exp;

    const p2_inc = calcTotal(p2_items, 'income');
    const p2_exp = calcTotal(p2_items, 'expense');
    const p2_bal = p2_inc - p2_exp;

    const total_inc = p1_inc + p2_inc;
    const total_exp = p1_exp + p2_exp;
    const total_bal = total_inc - total_exp;

    p1_income.innerText = `+$${p1_inc.toFixed(2)}`;
    p1_expense.innerText = `-$${p1_exp.toFixed(2)}`;
    p1_balance.innerText = `$${p1_bal.toFixed(2)}`;

    p2_income.innerText = `+$${p2_inc.toFixed(2)}`;
    p2_expense.innerText = `-$${p2_exp.toFixed(2)}`;
    p2_balance.innerText = `$${p2_bal.toFixed(2)}`;

    money_plus.innerText = `+$${total_inc.toFixed(2)}`;
    money_minus.innerText = `-$${total_exp.toFixed(2)}`;
    balance.innerText = `$${total_bal.toFixed(2)}`;
}

function removeTransaction(id) {
    if (confirm('Delete this transaction?')) {
        transactions = transactions.filter(transaction => transaction.id !== id);
        queueTransactionDelete(id);
        renderTransactions();
        updateValues();
        updateLedger();
    }
}

function editTransaction(id) {
    const itemToEdit = transactions.find(transaction => transaction.id === id);
    if (!itemToEdit) return;
    
    text.value = itemToEdit.text;
    amount.value = itemToEdit.amount;
    dayInput.value = itemToEdit.day;
    typeInput.value = itemToEdit.type;

    editState = { isEditing: true, id: id };
    submitBtn.innerText = "Update Transaction";
    submitBtn.style.backgroundColor = "#f59e0b";

    document.querySelector('.add-transaction').scrollIntoView({ behavior: 'smooth' });
}

function togglePaid(id) {
    const item = transactions.find(t => t.id === id);
    if (item) {
        item.paid = !item.paid;
        queueTransactionUpsert(item);
        renderTransactions();
        updateValues();
    }
}

function resetMonthStatus() {
    if(confirm("Are you sure? This will uncheck all items for the new month.")) {
        transactions.forEach(t => {
            if (t.paid) {
                t.paid = false;
                queueTransactionUpsert(t, false);
            }
        });
        persistOutstandingChanges();
        saveToCloud();
        renderTransactions();
        updateValues();
    }
}

// --- SUPABASE SYNC LOGIC ---

let syncTimeout;
let lastSyncedTime = null;
let saveInFlight = false;
let saveQueued = false;
let remoteSyncTimeout;
let remoteSyncInFlight = null;
let pendingChanges = new Map();
let inFlightChanges = new Map();

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

function updateSyncTimestamp() {
    const timestampEl = document.getElementById('sync-timestamp');
    if (!timestampEl || !lastSyncedTime) return;
    
    const now = new Date();
    const diffMs = now - lastSyncedTime;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    
    let timeText = '';
    if (diffSec < 60) {
        timeText = `${diffSec} seconds ago`;
    } else if (diffMin < 60) {
        timeText = `${diffMin} min${diffMin > 1 ? 's' : ''} ago`;
    } else {
        timeText = `${diffHour} hour${diffHour > 1 ? 's' : ''} ago`;
    }
    
    timestampEl.innerText = `Last synced: ${timeText}`;
}

setInterval(updateSyncTimestamp, 60000);

function setSyncButton(icon, text) {
    const syncBtn = document.getElementById('sync-btn');
    if (syncBtn) syncBtn.innerHTML = `<i class="fas ${icon}"></i> ${text}`;
}

function restoreSyncButton(delay = 2000) {
    setTimeout(() => setSyncButton('fa-cloud', 'Cloud Sync'), delay);
}

// Debounce writes and serialize them so an older request cannot finish last.
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
    setSyncButton('fa-spinner fa-spin', 'Saving...');
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
        lastSyncedTime = new Date();
        updateSyncTimestamp();
        setSyncButton('fa-check-circle', 'Saved');
        restoreSyncButton();
    } catch (error) {
        for (const [key, change] of entries) {
            if (!pendingChanges.has(key)) pendingChanges.set(key, change);
        }
        console.error('Error saving to Supabase:', error);
        setSyncButton('fa-exclamation-triangle', 'Save error');
        restoreSyncButton(3500);
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
    if (changedTransactions) {
        renderTransactions();
        updateValues();
        updateLedger();
    }
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
    setSyncButton('fa-spinner fa-spin', 'Loading...');
    try {
        const data = await window.DoughCloud.pull();
        transactions = data.transactions;
        notesArea.value = data.notes;
        replaceUserCache(transactions, notesArea.value, data.revision);
        if (protectedChanges.size) reapplyProtectedChanges(protectedChanges);
        renderTransactions();
        updateValues();
        updateLedger();
        lastSyncedTime = new Date();
        updateSyncTimestamp();
        setSyncButton('fa-cloud-download-alt', 'Loaded');
        restoreSyncButton();
        return true;
    } catch (error) {
        console.error('Error loading from Supabase:', error);
        setSyncButton('fa-exclamation-triangle', 'Load error');
        restoreSyncButton(3500);
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
        lastSyncedTime = new Date();
        updateSyncTimestamp();
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
    setSyncButton('fa-spinner fa-spin', 'Syncing...');
    try {
        await syncRemoteChanges();
        setSyncButton('fa-check-circle', 'Up to date');
        restoreSyncButton();
    } catch (error) {
        console.error('Manual sync failed:', error);
        setSyncButton('fa-exclamation-triangle', 'Sync error');
        restoreSyncButton(3500);
    }
}

async function init() {
    if (appInitialized) return syncRemoteChanges();
    appInitialized = true;
    const userId = window.DoughCloud.getUserId();
    if (!userId) throw new Error('Your session could not be verified.');
    const cached = loadUserCache(userId);
    window.DoughCloud.setRevision(cached.revision);
    updateDateAndProgress();
    renderTransactions();
    updateValues();
    updateLedger();
    if (cached.ready) await syncRemoteChanges();
    else await syncFromCloud(allProtectedChanges());
    await window.DoughCloud.subscribe(scheduleRemoteSync);
    if (pendingChanges.size) saveToCloud();
}

async function showApp() {
    await init();
    loginOverlay.style.display = 'none';
    appContainer.style.display = window.innerWidth >= 768 ? 'grid' : 'flex';
}

if (notesArea) {
    notesArea.addEventListener('input', (e) => {
        clearTimeout(notesCacheTimeout);
        notesCacheTimeout = setTimeout(() => {
            cacheNotes(e.target.value);
            persistOutstandingChanges();
        }, 300);
        queueNotes(e.target.value);
    });
}

window.addEventListener('pagehide', () => {
    cacheNotes(notesArea.value);
    persistOutstandingChanges();
});

form.addEventListener('submit', handleTransactionSubmit);

function transactionIdFromTarget(target) {
    const control = target.closest('[data-transaction-id]');
    if (!control) return null;
    const id = Number(control.dataset.transactionId);
    return Number.isSafeInteger(id) ? id : null;
}

for (const list of [list_p1, list_p2]) {
    list.addEventListener('click', event => {
        const control = event.target.closest('button[data-action]');
        if (!control) return;
        const id = transactionIdFromTarget(control);
        if (id === null) return;
        if (control.dataset.action === 'edit') editTransaction(id);
        if (control.dataset.action === 'delete') removeTransaction(id);
    });
    list.addEventListener('change', event => {
        if (!event.target.matches('input[data-action="toggle"]')) return;
        const id = transactionIdFromTarget(event.target);
        if (id !== null) togglePaid(id);
    });
}

document.getElementById('reset-btn').addEventListener('click', resetMonthStatus);
document.getElementById('sync-btn').addEventListener('click', manualSync);

// --- DARK MODE LOGIC ---
const darkModeBtn = document.getElementById('dark-mode-btn');
const darkModeIcon = darkModeBtn.querySelector('i');

if (localStorage.getItem('darkMode') === 'enabled') {
    document.body.classList.add('dark-mode');
}

if (document.body.classList.contains('dark-mode')) {
    darkModeIcon.classList.replace('fa-moon', 'fa-sun');
}

darkModeBtn.addEventListener('click', () => {
    document.body.classList.toggle('dark-mode');
    if (document.body.classList.contains('dark-mode')) {
        localStorage.setItem('darkMode', 'enabled');
        darkModeIcon.classList.replace('fa-moon', 'fa-sun');
    } else {
        localStorage.setItem('darkMode', 'disabled');
        darkModeIcon.classList.replace('fa-sun', 'fa-moon');
    }
});

async function boot() {
    if (!window.DoughCloud || !window.DoughCloud.configured()) {
        loginError.innerText = 'Cloud sync is not configured. Check the Pages deployment.';
        loginBtn.disabled = true;
        return;
    }
    try {
        const session = await window.DoughCloud.getSession();
        if (session) await showApp();
    } catch (error) {
        loginError.innerText = error.message || 'Unable to connect to Supabase';
    }
}

boot();
