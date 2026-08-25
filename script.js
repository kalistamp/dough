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
    let knownRemoteIds = new Set();

    function configured() {
        const config = window.SUPABASE_CONFIG;
        return !!(config && config.url && config.anonKey && config.schema &&
            config.url !== URL_PLACEHOLDER && config.anonKey !== KEY_PLACEHOLDER);
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
        const { data, error } = await c.auth.getSession();
        if (error) throw error;
        const session = data ? data.session : null;
        signedInUserId = session && session.user ? session.user.id : null;
        return session;
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
        signedInUserId = data.session.user.id;
        knownRemoteIds = new Set();
        return { ok: true, session: data.session };
    }

    async function signOut() {
        const c = client();
        signedInUserId = null;
        knownRemoteIds = new Set();
        if (c) await c.auth.signOut();
    }

    function rowToTransaction(row) {
        return {
            id: Number(row.id), text: row.text, amount: Number(row.amount),
            type: row.type, day: Number(row.day), paid: !!row.paid
        };
    }

    function transactionToRow(transaction, userId) {
        return {
            user_id: userId,
            id: Number(transaction.id),
            text: String(transaction.text || ''),
            amount: Number(transaction.amount),
            type: transaction.type === 'income' ? 'income' : 'expense',
            day: Math.max(1, Math.min(31, Number(transaction.day))),
            paid: !!transaction.paid
        };
    }

    async function pull() {
        const c = client();
        if (!c) throw new Error('Cloud sync is not configured');
        const [transactionResult, notesResult] = await Promise.all([
            c.from('transactions').select('*').order('day').order('id'),
            c.from('notes').select('body').eq('id', 1).maybeSingle()
        ]);
        if (transactionResult.error) throw transactionResult.error;
        if (notesResult.error) throw notesResult.error;
        const transactions = (transactionResult.data || []).map(rowToTransaction);
        knownRemoteIds = new Set(transactions.map(item => item.id));
        return {
            transactions,
            notes: notesResult.data ? notesResult.data.body || '' : ''
        };
    }

    async function pushTransactions(transactions) {
        const c = client();
        if (!c) throw new Error('Cloud sync is not configured');
        const userId = await requireUserId();
        const rows = (transactions || []).map(item => transactionToRow(item, userId));
        const localIds = new Set(rows.map(row => row.id));
        if (rows.length) {
            const { error } = await c.from('transactions').upsert(rows, {
                onConflict: 'user_id,id'
            });
            if (error) throw error;
        }
        const removed = [...knownRemoteIds].filter(id => !localIds.has(id));
        if (removed.length) {
            const { error } = await c.from('transactions').delete().in('id', removed);
            if (error) throw error;
        }
        knownRemoteIds = localIds;
    }

    async function pushNotes(notes) {
        const c = client();
        if (!c) throw new Error('Cloud sync is not configured');
        const userId = await requireUserId();
        const { error } = await c.from('notes').upsert({
            user_id: userId, id: 1, body: String(notes || '')
        }, { onConflict: 'user_id,id' });
        if (error) throw error;
    }

    window.DoughCloud = {
        configured, getSession, signIn, signOut, pull,
        pushTransactions, pushNotes
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

// Safely load local data initially so the app loads instantly
try {
    const storedData = localStorage.getItem('budgetData');
    transactions = storedData ? JSON.parse(storedData) : [];
} catch (error) {
    console.error("Error loading data:", error);
    transactions = [];
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
    saveQueued = false;
    await window.DoughCloud.signOut();
    appInitialized = false;
    transactions = [];
    notesArea.value = '';
    localStorage.removeItem('budgetData');
    localStorage.removeItem('budgetNotes');
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

    const transactionData = {
        text: text.value,
        amount: Math.abs(+amount.value),
        type: typeInput.value,
        day: +dayInput.value,
        paid: false 
    };

    if (editState.isEditing) {
        transactions = transactions.map(item => {
            if (item.id === editState.id) {
                return { ...item, ...transactionData, id: editState.id, paid: item.paid };
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
    }

    updateLocalStorage();
    renderTransactions();
    updateValues();
    updateLedger();

    text.value = '';
    amount.value = '';
    dayInput.value = '';
    text.focus();
}

function generateID() {
    let id = Date.now();
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
                        onchange="togglePaid(${transaction.id})"
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
                    <button class="action-btn edit-btn" onclick="editTransaction(${transaction.id})">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="action-btn delete-btn" onclick="removeTransaction(${transaction.id})">
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
        updateLocalStorage();
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
        updateLocalStorage();
        renderTransactions();
        updateValues();
    }
}

function resetMonthStatus() {
    if(confirm("Are you sure? This will uncheck all items for the new month.")) {
        transactions.forEach(t => t.paid = false);
        updateLocalStorage();
        renderTransactions();
        updateValues();
    }
}

// --- SUPABASE SYNC LOGIC ---

let syncTimeout;
let lastSyncedTime = null;
let saveInFlight = false;
let saveQueued = false;

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
    saveInFlight = true;
    setSyncButton('fa-spinner fa-spin', 'Saving...');
    try {
        await Promise.all([
            window.DoughCloud.pushTransactions(transactions),
            window.DoughCloud.pushNotes(notesArea.value)
        ]);
        lastSyncedTime = new Date();
        updateSyncTimestamp();
        setSyncButton('fa-check-circle', 'Saved');
        restoreSyncButton();
    } catch (error) {
        console.error('Error saving to Supabase:', error);
        setSyncButton('fa-exclamation-triangle', 'Save error');
        restoreSyncButton(3500);
    } finally {
        saveInFlight = false;
        if (saveQueued) {
            saveQueued = false;
            saveToCloud();
        }
    }
}

async function syncFromCloud() {
    setSyncButton('fa-spinner fa-spin', 'Loading...');
    try {
        const data = await window.DoughCloud.pull();
        transactions = data.transactions;
        notesArea.value = data.notes;
        localStorage.setItem('budgetData', JSON.stringify(transactions));
        localStorage.setItem('budgetNotes', notesArea.value);
        renderTransactions();
        updateValues();
        updateLedger();
        lastSyncedTime = new Date();
        updateSyncTimestamp();
        setSyncButton('fa-cloud-download-alt', 'Loaded');
        restoreSyncButton();
    } catch (error) {
        console.error('Error loading from Supabase:', error);
        setSyncButton('fa-exclamation-triangle', 'Load error');
        restoreSyncButton(3500);
    }
}

function manualSync() { syncFromCloud(); }

function updateLocalStorage() {
    localStorage.setItem('budgetData', JSON.stringify(transactions));
    saveToCloud();
}

async function init() {
    if (appInitialized) return syncFromCloud();
    appInitialized = true;
    updateDateAndProgress();
    const savedNotes = localStorage.getItem('budgetNotes');
    if (savedNotes) notesArea.value = savedNotes;
    renderTransactions();
    updateValues();
    updateLedger();
    await syncFromCloud();
}

async function showApp() {
    await init();
    loginOverlay.style.display = 'none';
    appContainer.style.display = window.innerWidth >= 768 ? 'grid' : 'flex';
}

if (notesArea) {
    notesArea.addEventListener('input', (e) => {
        localStorage.setItem('budgetNotes', e.target.value);
        saveToCloud();
    });
}

form.addEventListener('submit', handleTransactionSubmit);

// --- DARK MODE LOGIC ---
const darkModeBtn = document.getElementById('dark-mode-btn');
const darkModeIcon = darkModeBtn.querySelector('i');

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
