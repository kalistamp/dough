// --- CONFIGURATION ---
const MY_PASSWORD = "payme"; 

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
const submitBtn = document.getElementById('submit-btn'); // New ID for button

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

// Safely load data
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
    
    // Only seed if we haven't seeded AND there is no data
    if (!hasSeeded && transactions.length === 0) {
        transactions = [
            { id: 1, text: 'Paycheck 1', amount: 1500, type: 'income', day: 1, paid: false },
            { id: 2, text: 'Paycheck 2', amount: 1500, type: 'income', day: 15, paid: false },
            { id: 3, text: 'CUSTOM CASH', amount: 60, type: 'expense', day: 1, paid: false },
            { id: 4, text: 'Lending Club', amount: 130, type: 'expense', day: 9, paid: false },
            { id: 5, text: 'Car Payment', amount: 300, type: 'expense', day: 1, paid: false },
            { id: 6, text: 'Simplicity', amount: 160, type: 'expense', day: 25, paid: false },
            { id: 7, text: 'Flea Meds', amount: 50, type: 'expense', day: 1, paid: false },
            { id: 8, text: 'Groceries', amount: 300, type: 'expense', day: 1, paid: false },
            { id: 9, text: 'Gas', amount: 60, type: 'expense', day: 1, paid: false },
            { id: 10, text: 'Personal', amount: 200, type: 'expense', day: 1, paid: false }
        ];
        localStorage.setItem('hasSeeded', 'true');
        updateLocalStorage();
    }
}

// --- APP FUNCTIONS ---

// Add or Update transaction
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
        // Update existing item
        transactions = transactions.map(item => {
            if (item.id === editState.id) {
                return { ...item, ...transactionData, id: editState.id, paid: item.paid };
            }
            return item;
        });
        
        // Reset Edit State
        editState = { isEditing: false, id: null };
        submitBtn.innerText = "Add Transaction";
        submitBtn.style.backgroundColor = "var(--primary-color)";
    } else {
        // Create new item
        const newTransaction = {
            ...transactionData,
            id: generateID()
        };
        transactions.push(newTransaction);
    }

    updateLocalStorage();
    init();

    // Reset inputs
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

        if (transaction.day <= 15) {
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

        if (exp.day <= 15) {
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

    const p1_items = transactions.filter(t => t.day <= 15);
    const p2_items = transactions.filter(t => t.day > 15);

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
        init();
    }
}

// SAFE EDIT: Does not remove item until saved
function editTransaction(id) {
    const itemToEdit = transactions.find(transaction => transaction.id === id);
    if (!itemToEdit) return;
    
    text.value = itemToEdit.text;
    amount.value = itemToEdit.amount;
    dayInput.value = itemToEdit.day;
    typeInput.value = itemToEdit.type;

    // Enter Edit Mode
    editState = { isEditing: true, id: id };
    submitBtn.innerText = "Update Transaction";
    submitBtn.style.backgroundColor = "#f59e0b"; // Orange color for edit mode

    document.querySelector('.add-transaction').scrollIntoView({ behavior: 'smooth' });
}

function togglePaid(id) {
    const item = transactions.find(t => t.id === id);
    if (item) {
        item.paid = !item.paid;
        updateLocalStorage();
        init(); 
    }
}

function resetMonthStatus() {
    if(confirm("Are you sure? This will uncheck all items for the new month.")) {
        transactions.forEach(t => t.paid = false);
        updateLocalStorage();
        init();
    }
}

function exportJSON() {
    const dataStr = JSON.stringify(transactions, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = "budget-backup.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function updateLocalStorage() {
    localStorage.setItem('budgetData', JSON.stringify(transactions));
}

function init() {
    updateDateAndProgress();
    seedData();
    renderTransactions();
    updateValues();
    updateLedger();
    
    // Load Notes
    const savedNotes = localStorage.getItem('budgetNotes');
    if (savedNotes) {
        notesArea.value = savedNotes;
    }
}

// Auto-save notes
if (notesArea) {
    notesArea.addEventListener('input', (e) => {
        localStorage.setItem('budgetNotes', e.target.value);
    });
}

form.addEventListener('submit', handleTransactionSubmit);
