// --- CONFIGURATION ---
const MY_PASSWORD = "payme"; 
const GITHUB_TOKEN = "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"; // Paste your GitHub Token here
const GIST_ID = "85fd0ba8df128ea3f7a8b0ce317fda00";           // Paste your Gist ID here
const GIST_FILENAME = "budget-data.json";

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
const passwordInput = document.getElementById('password-input');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');

// Header Elements
const currentDateEl = document.getElementById('current-date');
const monthProgressEl = document.getElementById('month-progress');
const daysLeftEl = document.getElementById('days-left');

// Notes Element
const notesArea = document.getElementById('notes-area');

// --- STATE MANAGEMENT ---
let transactions = [];
let editState = { isEditing: false, id: null };

// Safely load local data initially so the app loads instantly
try {
    const storedData = localStorage.getItem('budgetData');
    transactions = storedData ? JSON.parse(storedData) : [];
} catch (error) {
    console.error("Error loading data:", error);
    transactions = [];
}

// --- LOGIN LOGIC ---
loginBtn.addEventListener('click', checkPassword);
passwordInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') checkPassword();
});

function checkPassword() {
    if (passwordInput.value === MY_PASSWORD) {
        loginOverlay.style.display = 'none';
        appContainer.style.display = window.innerWidth >= 768 ? 'grid' : 'flex'; 
        init(); 
    } else {
        loginError.innerText = "Incorrect Password";
        passwordInput.value = '';
    }
}

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

// --- DATA INITIALIZATION ---
function seedData() {
    const hasSeeded = localStorage.getItem('hasSeeded');
    
    if (!hasSeeded && transactions.length === 0) {
        transactions = [
            { id: 1, text: 'Paycheck 1', amount: 1500, type: 'income', day: 6, paid: false },
            { id: 2, text: 'Paycheck 2', amount: 1500, type: 'income', day: 20, paid: false },
            { id: 3, text: 'CUSTOM CASH', amount: 60, type: 'expense', day: 6, paid: false },
            { id: 4, text: 'Lending Club', amount: 130, type: 'expense', day: 9, paid: false },
            { id: 5, text: 'Car Payment', amount: 300, type: 'expense', day: 6, paid: false },
            { id: 6, text: 'Simplicity', amount: 160, type: 'expense', day: 25, paid: false },
            { id: 7, text: 'Flea Meds', amount: 50, type: 'expense', day: 6, paid: false },
            { id: 8, text: 'Groceries', amount: 300, type: 'expense', day: 6, paid: false },
            { id: 9, text: 'Gas', amount: 60, type: 'expense', day: 6, paid: false },
            { id: 10, text: 'Personal', amount: 200, type: 'expense', day: 6, paid: false }
        ];
        localStorage.setItem('hasSeeded', 'true');
        updateLocalStorage();
    }
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
        amount: +amount.value, 
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
    return Math.floor(Math.random() * 100000000);
}

function renderTransactions() {
    list_p1.innerHTML = '';
    list_p2.innerHTML = '';

    const currentDay = new Date().getDate();

    // Sort by day
    transactions.sort((a, b) => a.day - b.day);

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
                    <span>${transaction.text}</span>
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
            <td>${exp.text}</td>
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

// --- GITHUB GIST SYNC LOGIC ---

let syncTimeout;

// Auto-saves to Gist 1 second after any change is made
function saveToGist() {
    if (!GITHUB_TOKEN || !GIST_ID || GITHUB_TOKEN === "YOUR_GITHUB_TOKEN_HERE") return;
    
    clearTimeout(syncTimeout);
    syncTimeout = setTimeout(async () => {
        const syncBtn = document.getElementById('sync-btn');
        if(syncBtn) syncBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
        
        const exportData = {
            transactions: transactions,
            notes: notesArea.value
        };
        
        try {
            await fetch(`https://api.github.com/gists/${GIST_ID}`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    files: {
                        [GIST_FILENAME]: {
                            content: JSON.stringify(exportData, null, 2)
                        }
                    }
                })
            });
            if(syncBtn) syncBtn.innerHTML = '<i class="fas fa-check-circle"></i> Saved';
            setTimeout(() => {
                if(syncBtn) syncBtn.innerHTML = '<i class="fas fa-cloud"></i> Cloud Sync';
            }, 2000);
        } catch (error) {
            console.error("Error saving to Gist:", error);
            if(syncBtn) syncBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Error';
        }
    }, 1000);
}

// Pulls latest data from Gist (runs on load, or when you click the Cloud Sync button)
async function syncFromCloud() {
    if (!GITHUB_TOKEN || !GIST_ID || GITHUB_TOKEN === "YOUR_GITHUB_TOKEN_HERE") return;
    
    const syncBtn = document.getElementById('sync-btn');
    if(syncBtn) syncBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
    
    try {
        const response = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            },
            cache: 'no-store' // Prevent browser from caching old gist data
        });
        const gist = await response.json();
        
        if (gist.files && gist.files[GIST_FILENAME]) {
            const content = gist.files[GIST_FILENAME].content;
            const data = JSON.parse(content);
            
            // If Gist is completely empty, push our local data up to initialize it
            if (Object.keys(data).length === 0) {
                saveToGist();
                return;
            }

            if (data.transactions) {
                transactions = data.transactions;
                notesArea.value = data.notes !== undefined ? data.notes : "";
                localStorage.setItem('budgetNotes', notesArea.value);
            } else if (Array.isArray(data)) {
                transactions = data;
            }
            
            // Update local storage with new cloud data
            localStorage.setItem('budgetData', JSON.stringify(transactions));
            
            // Re-render UI
            renderTransactions();
            updateValues();
            updateLedger();
            
            if(syncBtn) syncBtn.innerHTML = '<i class="fas fa-cloud-download-alt"></i> Loaded';
            setTimeout(() => {
                if(syncBtn) syncBtn.innerHTML = '<i class="fas fa-cloud"></i> Cloud Sync';
            }, 2000);
        }
    } catch (error) {
        console.error("Error loading from Gist:", error);
        if(syncBtn) syncBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Load Error';
    }
}

function manualSync() {
    // When the user clicks the sync button, pull the latest data from the cloud
    // (If they made changes on another device, this brings them in)
    syncFromCloud();
}

function updateLocalStorage() {
    localStorage.setItem('budgetData', JSON.stringify(transactions));
    saveToGist(); // Trigger auto-save to cloud
}

function init() {
    updateDateAndProgress();
    seedData();
    
    // Load local notes immediately
    const savedNotes = localStorage.getItem('budgetNotes');
    if (savedNotes) {
        notesArea.value = savedNotes;
    }

    // Render local data immediately so the app feels fast
    renderTransactions();
    updateValues();
    updateLedger();

    // Then fetch the latest data from the cloud in the background
    syncFromCloud();
}

// Auto-save notes when you click out of the text box (change event)
if (notesArea) {
    notesArea.addEventListener('change', (e) => {
        localStorage.setItem('budgetNotes', e.target.value);
        saveToGist();
    });
}

form.addEventListener('submit', handleTransactionSubmit);
