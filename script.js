// --- CONFIGURATION ---
// CHANGE THIS PASSWORD BEFORE UPLOADING
const MY_PASSWORD = "payme"; 

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

const currentDateEl = document.getElementById('current-date');
const monthProgressEl = document.getElementById('month-progress');
const daysLeftEl = document.getElementById('days-left');

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

// --- DATE & PROGRESS LOGIC ---
function updateDateAndProgress() {
    const now = new Date();
    
    // 1. Display formatted date
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    currentDateEl.innerText = now.toLocaleDateString('en-US', options);

    // 2. Calculate Progress Bar
    const currentDay = now.getDate();
    const currentMonth = now.getMonth(); 
    const currentYear = now.getFullYear();

    // Get total days in current month (handle leap years etc automatically)
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    
    // Calculate percentage
    const percentage = (currentDay / daysInMonth) * 100;
    
    // Update DOM
    monthProgressEl.style.width = `${percentage}%`;
    
    // Update days left text
    const daysRemaining = daysInMonth - currentDay;
    daysLeftEl.innerText = `${daysRemaining} days remaining in month`;
}

// --- DATA INITIALIZATION (PRE-FILL FOR DEMO) ---
function seedData() {
    if (transactions.length === 0) {
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
        amount: +amount.value, 
        type: typeInput.value,
        day: +dayInput.value,
        paid: false 
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
    
    // Check if paid/completed
    if (transaction.paid) {
        item.classList.add('completed');
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

    list.appendChild(item);
}

// Update the balance, income and expense
function updateValues() {
    const income = transactions
        .filter(item => item.type === 'income')
        .reduce((acc, item) => (acc += item.amount), 0)
        .toFixed(2);

    const expense = transactions
        .filter(item => item.type === 'expense')
        .reduce((acc, item) => (acc += item.amount), 0)
        .toFixed(2);

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

// Edit transaction
function editTransaction(id) {
    const itemToEdit = transactions.find(transaction => transaction.id === id);
    
    text.value = itemToEdit.text;
    amount.value = itemToEdit.amount;
    dayInput.value = itemToEdit.day;
    typeInput.value = itemToEdit.type;

    removeTransaction(id);
    document.querySelector('.add-transaction').scrollIntoView({ behavior: 'smooth' });
}

// Toggle Paid status
function togglePaid(id) {
    const item = transactions.find(t => t.id === id);
    if (item) {
        item.paid = !item.paid;
        updateLocalStorage();
        init(); 
    }
}

// Reset all for new month
function resetMonthStatus() {
    // Only resets the "Paid" Checkboxes, keeps the data
    if(confirm("Are you sure? This will uncheck all items for the new month.")) {
        transactions.forEach(t => t.paid = false);
        updateLocalStorage();
        init();
    }
}

// Update local storage
function updateLocalStorage() {
    localStorage.setItem('budgetData', JSON.stringify(transactions));
}

// Init app
function init() {
    list.innerHTML = '';
    
    updateDateAndProgress();
    seedData();

    // Sort by day of month (1 to 31)
    transactions.sort((a, b) => a.day - b.day);

    transactions.forEach(addTransactionDOM);
    updateValues();
}

form.addEventListener('submit', addTransaction);
