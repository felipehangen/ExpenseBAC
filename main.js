import './style.css';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const SCOPES = 'https://www.googleapis.com/auth/gmail.readonly';

let tokenClient;
let accessToken = null;

const authBtn = document.getElementById('auth-btn');
const welcomeState = document.getElementById('welcome-state');
const loadingState = document.getElementById('loading');
const emptyState = document.getElementById('empty-state');
const dashboard = document.getElementById('dashboard');
const transactionList = document.getElementById('transaction-list');
const totalAmountEl = document.getElementById('total-amount');
const transactionCountEl = document.getElementById('transaction-count');

function showState(state) {
  welcomeState.classList.add('hidden');
  loadingState.classList.add('hidden');
  emptyState.classList.add('hidden');
  dashboard.classList.add('hidden');

  if (state === 'welcome') welcomeState.classList.remove('hidden');
  if (state === 'loading') loadingState.classList.remove('hidden');
  if (state === 'empty') emptyState.classList.remove('hidden');
  if (state === 'dashboard') dashboard.classList.remove('hidden');
}

function initGIS() {
  if (!CLIENT_ID || CLIENT_ID === 'YOUR_GOOGLE_CLIENT_ID_HERE') {
    alert("Please set your VITE_GOOGLE_CLIENT_ID in the .env file.");
    return;
  }
  
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: (tokenResponse) => {
      if (tokenResponse && tokenResponse.access_token) {
        accessToken = tokenResponse.access_token;
        authBtn.textContent = 'Logout';
        authBtn.classList.add('logout');
        fetchExpenses();
      }
    },
  });
}

function handleAuthClick() {
  if (accessToken) {
    // Logout
    google.accounts.id.disableAutoSelect();
    accessToken = null;
    authBtn.textContent = 'Login';
    authBtn.classList.remove('logout');
    showState('welcome');
    transactionList.innerHTML = '';
    return;
  }
  
  tokenClient.requestAccessToken();
}

async function fetchExpenses() {
  showState('loading');
  try {
    const currentYear = new Date().getFullYear();
    // Search BAC transactional emails for the current year
    const query = encodeURIComponent(`from:notificaci\u00f3n@notificacionesbaccr.com subject:"Notificaci\u00f3n de transacci\u00f3n" after:${currentYear}/01/01`);
    
    // 1. Fetch message list
    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=50`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    
    const listData = await listRes.json();
    
    if (!listData.messages || listData.messages.length === 0) {
      showState('empty');
      return;
    }

    // 2. Fetch full message details concurrently
    const messagePromises = listData.messages.map(msg => 
      fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      }).then(res => res.json())
    );

    const messages = await Promise.all(messagePromises);
    const transactions = [];

    // 3. Parse and extract
    messages.forEach(msg => {
      const payload = msg.payload;
      let bodyData = '';
      
      // The body could be in parts or in body.data
      if (payload.parts) {
        const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
        const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
        const part = htmlPart || textPart || payload.parts[0];
        if (part && part.body && part.body.data) {
          bodyData = part.body.data;
        }
      } else if (payload.body && payload.body.data) {
        bodyData = payload.body.data;
      }

      const decodedHtml = decodeBase64URL(bodyData);
      
      const tx = extractTransactionDetails(decodedHtml);
      if (tx && tx.monto) {
        transactions.push(tx);
      }
    });

    if (transactions.length === 0) {
      showState('empty');
      return;
    }

    renderDashboard(transactions);

  } catch (error) {
    console.error("Error fetching emails:", error);
    alert("Error fetching emails. Check the console.");
    showState('welcome');
  }
}

function decodeBase64URL(str) {
  if (!str) return '';
  // Convert from base64url to base64
  str = (str + '===').slice(0, str.length + (str.length % 4));
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(window.atob(str)));
}

function extractTransactionDetails(htmlText) {
  if (!htmlText) return null;
  
  // Using Regex to extract based on the table structure shown in the screenshot
  // Example: <td>Comercio:</td><td><b>SUPER LA PERLA</b></td>
  
  const extractField = (fieldName) => {
    // Look for the label followed by the value
    const regex = new RegExp(`${fieldName}.*?<(?:td|div|span)[^>]*>(?:<[^>]+>)*\\s*(.*?)\\s*(?:<\\/[^>]+>)*\\s*<\\/(?:td|div|span)>`, 'is');
    const match = htmlText.match(regex);
    if (match && match[1]) {
        // Strip out any remaining HTML tags and trim
        return match[1].replace(/<[^>]+>/g, '').trim();
    }
    return null;
  };

  const comercio = extractField('Comercio:') || "Unknown Merchant";
  const fecha = extractField('Fecha:') || "";
  const tipo = extractField('Tipo de Transacci[oó]n:') || "COMPRA";
  const montoStr = extractField('Monto:') || "CRC 0.00";
  
  // Clean amount string for number conversion e.g. "CRC 3,250.00" -> 3250.00
  let amountNum = 0;
  const numMatch = montoStr.match(/[\d,]+(?:\.\d+)?/);
  if (numMatch) {
    amountNum = parseFloat(numMatch[0].replace(/,/g, ''));
  }

  return { comercio, fecha, tipo, montoStr, amountNum };
}

function renderDashboard(transactions) {
  // Sort by date (assuming order doesn't need complex parsing, or we just trust email order)
  // Usually Gmail API returns newest first.
  
  // Calculate total
  const total = transactions.reduce((sum, tx) => sum + tx.amountNum, 0);
  
  // Find prevalent currency strictly from the first valid string
  let currency = "CRC";
  if (transactions.length > 0 && transactions[0].montoStr.includes('USD')) {
      currency = "USD";
  }

  // Set Summary
  totalAmountEl.textContent = `${currency} ${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  transactionCountEl.textContent = `${transactions.length} transactions`;

  // Render List
  transactionList.innerHTML = '';
  transactions.forEach(tx => {
    const li = document.createElement('li');
    li.className = 'transaction-item';
    li.innerHTML = `
      <div class="tx-details">
        <span class="tx-merchant">${tx.comercio}</span>
        <span class="tx-date">${tx.fecha}</span>
      </div>
      <div class="tx-details" style="align-items: flex-end;">
        <span class="tx-amount">${tx.montoStr}</span>
        <span class="tx-type">${tx.tipo}</span>
      </div>
    `;
    transactionList.appendChild(li);
  });

  showState('dashboard');
}

// Wait for GIS script to load
window.onload = () => {
  // Try initializing immediately in case it loaded fast
  if (window.google) {
    initGIS();
  } else {
    // Or wait for it if async
    const interval = setInterval(() => {
      if (window.google) {
        clearInterval(interval);
        initGIS();
      }
    }, 100);
  }
};

authBtn.addEventListener('click', handleAuthClick);
