// --- CONFIGURATION ---
// CHANGE THIS PASSWORD BEFORE UPLOADING
const MY_PASSWORD = "password123"; 

// --- SELECT DOM ELEMENTS ---
const balance = document.getElementById('balance');
const money_plus = document.getElementById('money-plus');
const money_minus = document.getElementById('money-minus');
const list = document.getElementById('list');
const form = document.getElementById('form');
const typeInput = document.getElementById('type');
const text = document.getElementById('text');
const amount = document.getElementById('amount');
const dayInput = document.getElementById('day');

const loginOverlay = document.getElementById('login-overlay');
const appContainer = document.getElementById('app-container');
const passwordInput = document.getElementById('password-input');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');

// --- STATE MANAGEMENT ---

// Get transactions from local storage
const localStorageTransactions = JSON.parse(localStorage.getItem('budgetData'));

let transactions = localStorage.getItem('budgetData') !== null ? localStorageTransactions : [];

// --- LOGIN LOGIC ---
loginBtn.addEventListener('click', checkPassword);
passwordInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') checkPassword();
});

function checkPassword() {
    if (passwordInput.value === MY_PASSWORD) {
        loginOverlay.style.display = 'none';
        appContainer.style.display = 'block';
        init(); // Start the app
    } else {
        loginError.innerText = "Incorrect Password";
        passwordInput.value = '';
    }
}

// --- DATA INITIALIZATION (PRE-FILL FOR DEMO) ---
// If it's the first time running (no data), let's add your specific examples
function seedData() {
    if (transactions.length === 0) {
        transactions = [
            { id: 1, text: 'Paycheck 1', amount: 1500, type: 'income', day: 1 },
            { id: 2, text: 'Paycheck 2', amount: 1500, type: 'income', day: 15 },
            { id: 3, text: 'CUSTOM CASH', amount: 60, type: 'expense', day: 1 },
            { id: 4, text: 'Lending Club', amount: 130, type: 'expense', day: 9 },
            { id: 5, text: 'Car Payment', amount: 300, type: 'expense', day: 1 },
            { id: 6, text: 'Simplicity', amount: 160, type: 'expense', day: 25 },
            { id: 7, text: 'Flea Meds', amount: 50, type: 'expense', day: 1 },
            { id: 8, text: 'Groceries', amount: 300, type: 'expense', day: 1 },
            { id: 9, text: 'Gas', amount: 60, type: 'expense', day: 1 },
            { id: 10, text: 'Personal', amount: 200, type: 'expense', day: 1 }
        ];
        updateLocalStorage();
    }
}

// --- APP FUNCTIONS ---

// Add new transaction
function addTransaction(e) {
    e.preventDefault();

    if (text.value.trim() === '' || amount.value.trim() === '' || dayInput.value.trim() === '') {
        alert('Please add a description, amount, and day');
        return;
    }

    const transaction = {
        id: generateID(),
        text: text.value,
        amount: +amount.value, // Convert string to number
        type: typeInput.value,
        day: +dayInput.value
    };

    transactions.push(transaction);

    addTransactionDOM(transaction);
    updateValues();
    updateLocalStorage();

    // Reset inputs
    text.value = '';
    amount.value = '';
    dayInput.value = '';
    text.focus();
}

// Generate random ID
function generateID() {
    return Math.floor(Math.random() * 100000000);
}

// Add transactions to DOM list
function addTransactionDOM(transaction) {
    // Get sign
    const sign = transaction.type === 'expense' ? '-' : '+';
    const itemClass = transaction.type === 'expense' ? 'minus' : 'plus';

    const item = document.createElement('li');
    item.classList.add(itemClass);

    // Get ordinal suffix for date (1st, 2nd, 3rd)
    const suffix = getOrdinal(transaction.day);

    item.innerHTML = `
        <div class="list-info">
            <span class="list-date">Day ${transaction.day}</span>
            <span>${transaction.text}</span>
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

    list.appendChild(item);
}

// Helper: 1st, 2nd, 3rd, 4th
function getOrdinal(n) {
    return n; // Keep simple for now, can expand later
}

// Update the balance, income and expense
function updateValues() {
    // Calculate Income
    const income = transactions
        .filter(item => item.type === 'income')
        .reduce((acc, item) => (acc += item.amount), 0)
        .toFixed(2);

    // Calculate Expense
    const expense = transactions
        .filter(item => item.type === 'expense')
        .reduce((acc, item) => (acc += item.amount), 0)
        .toFixed(2);

    // Calculate Balance
    const total = (income - expense).toFixed(2);

    balance.innerText = `$${total}`;
    money_plus.innerText = `+$${income}`;
    money_minus.innerText = `-$${expense}`;
}

// Remove transaction by ID
function removeTransaction(id) {
    transactions = transactions.filter(transaction => transaction.id !== id);
    updateLocalStorage();
    init();
}

// Edit transaction (Populate form and remove old entry)
function editTransaction(id) {
    const itemToEdit = transactions.find(transaction => transaction.id === id);
    
    // Fill form
    text.value = itemToEdit.text;
    amount.value = itemToEdit.amount;
    dayInput.value = itemToEdit.day;
    typeInput.value = itemToEdit.type;

    // Remove old item
    removeTransaction(id);
    
    // Scroll to form
    document.querySelector('.add-transaction').scrollIntoView({ behavior: 'smooth' });
}

// Update local storage transactions
function updateLocalStorage() {
    localStorage.setItem('budgetData', JSON.stringify(transactions));
}

// Init app
function init() {
    list.innerHTML = '';
    
    // Check if empty, run seed data
    seedData();

    // Sort by day of month (1 to 31)
    transactions.sort((a, b) => a.day - b.day);

    transactions.forEach(addTransactionDOM);
    updateValues();
}

form.addEventListener('submit', addTransaction);
