import './style.css';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const SCOPES = 'https://www.googleapis.com/auth/gmail.readonly';

let tokenClient;
let accessToken = localStorage.getItem('bac_access_token');
let tokenExpiry = localStorage.getItem('bac_token_expiry');

const authBtn = document.getElementById('auth-btn');
const logoEl = document.getElementById('logo');
const welcomeState = document.getElementById('welcome-state');
const loadingState = document.getElementById('loading');
const emptyState = document.getElementById('empty-state');
const debugBtn = document.getElementById('debug-btn');
const debugArea = document.getElementById('debug-area');
const dashboard = document.getElementById('dashboard');
let firstRawEmail = "";
let globalTransactions = []; // Store globally for Gemini

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
        // Token expires in 3600 seconds, store expiry time
        const expiry = new Date().getTime() + (3500 * 1000);
        localStorage.setItem('bac_access_token', accessToken);
        localStorage.setItem('bac_token_expiry', expiry);
        
        authBtn.textContent = 'Logout';
        authBtn.classList.add('logout');
        fetchExpenses();
      }
    },
  });

  // Auto-login if we have a valid token
  if (accessToken && tokenExpiry && new Date().getTime() < parseInt(tokenExpiry)) {
    authBtn.textContent = 'Logout';
    authBtn.classList.add('logout');
    fetchExpenses();
  } else {
    // Clear expired
    accessToken = null;
    localStorage.removeItem('bac_access_token');
    localStorage.removeItem('bac_token_expiry');
  }
}

function handleAuthClick() {
  if (accessToken) {
    // Logout
    google.accounts.id.disableAutoSelect();
    accessToken = null;
    localStorage.removeItem('bac_access_token');
    localStorage.removeItem('bac_token_expiry');
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
    // Broaden the search query to ensure we catch everything
    const query = encodeURIComponent(`notificacionesbaccr.com`);
    
    console.log("Searching with query:", decodeURIComponent(query));

    // 1. Fetch message list
    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=50`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    
    const listData = await listRes.json();
    console.log("Found messages:", listData.messages?.length || 0);
    
    if (!listRes.ok || listData.error) {
      firstRawEmail = "GMAIL API ERROR: " + JSON.stringify(listData, null, 2);
      showState('empty');
      return;
    }

    if (!listData.messages || listData.messages.length === 0) {
      firstRawEmail = "Query returned 0 results. Query was: " + decodeURIComponent(query);
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
      if (!firstRawEmail) {
         firstRawEmail = decodedHtml; // Save for debugging
      }
      
      const tx = extractTransactionDetails(decodedHtml);
      if (tx && tx.montoStr !== "CRC 0.00") {
        transactions.push(tx);
      } else {
        console.warn("Failed to parse transaction from message:", msg.id);
      }
    });

    console.log("Successfully parsed transactions:", transactions.length);

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
  
  // Clean HTML to make regex easier (remove newlines inside tags if any)
  const cleanText = htmlText.replace(/\n/g, ' ');

  const extractField = (fieldName) => {
    // HTML based match (supports td, th, div, span, p)
    const regex = new RegExp(`${fieldName}.*?<(?:td|th|div|span|p)[^>]*>(?:<[^>]+>)*\\s*(.*?)\\s*(?:<\\/[^>]+>)*\\s*<\\/(?:td|th|div|span|p)>`, 'is');
    const match = cleanText.match(regex);
    if (match && match[1]) {
        return match[1].replace(/<[^>]+>/g, '').trim();
    }
    
    // Plain text fallback (e.g., Monto: CRC 3,250.00)
    const plainRegex = new RegExp(`${fieldName}\\s*(.*?)(?:\\n|<br|\\t|$)`, 'is');
    const plainMatch = cleanText.match(plainRegex);
    if (plainMatch && plainMatch[1]) {
        return plainMatch[1].replace(/<[^>]+>/g, '').trim();
    }

    return null;
  };

  const comercio = extractField('Comercio:') || extractField('Comercio') || "Unknown Merchant";
  const fecha = extractField('Fecha:') || extractField('Fecha') || "";
  const tipo = extractField('Tipo de Transacci[oó]n:') || "COMPRA";
  const montoStr = extractField('Monto:') || extractField('Monto') || "CRC 0.00";
  
  
  // Clean amount string for number conversion e.g. "CRC 3,250.00" -> 3250.00
  let amountNum = 0;
  const numMatch = montoStr.match(/[\d,]+(?:\.\d+)?/);
  if (numMatch) {
    amountNum = parseFloat(numMatch[0].replace(/,/g, ''));
  }

  return { comercio, fecha, tipo, montoStr, amountNum };
}

function renderDashboard(transactions) {
  globalTransactions = transactions;
  
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
logoEl.addEventListener('click', () => { window.location.reload(); });
debugBtn?.addEventListener('click', () => { 
  debugArea.style.display = 'block'; 
  debugArea.value = firstRawEmail || "No emails were returned from Gmail!"; 
});

const aiInsightsBtn = document.getElementById('ai-insights-btn');
const aiInsightsPanel = document.getElementById('ai-insights-panel');
const aiInsightsContent = document.getElementById('ai-insights-content');
const clearKeyBtn = document.getElementById('clear-key-btn');

async function getAIInsights() {
  let apiKey = localStorage.getItem('gemini_api_key');
  if (!apiKey) {
    apiKey = prompt("Please securely paste your Gemini API Key (from aistudio.google.com/app/apikey). It will only be stored locally on your device.");
    if (!apiKey) return;
    localStorage.setItem('gemini_api_key', apiKey.trim());
  }

  aiInsightsPanel.classList.remove('hidden');
  aiInsightsContent.innerHTML = '<div class="spinner" style="width:24px; height:24px; margin: 0 auto;"></div><p style="text-align:center; color: var(--text-muted)">Gemini is analyzing...</p>';
  aiInsightsBtn.disabled = true;

  try {
    const txSummary = globalTransactions.map(tx => `${tx.fecha} | ${tx.comercio} | ${tx.montoStr}`).join('\\n');
    
    const promptText = `I have the following credit card transactions from my bank for this year:\n\n${txSummary}\n\nPlease analyze this spending. Give me my top spending categories, total amounts spent per category, and write a 2-sentence summary of my spending habits. Format the response cleanly using HTML tags (like <ul>, <li>, <strong>, <h3>) so I can display it directly in my web app. DO NOT include Markdown backticks or the \`\`\`html prefix.`;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }]
      })
    });

    if (!response.ok) {
      if (response.status === 400 || response.status === 403) {
        localStorage.removeItem('gemini_api_key');
        throw new Error("Invalid Gemini API Key or permission denied.");
      }
      throw new Error(`Failed to fetch from Gemini (${response.status})`);
    }

    const data = await response.json();
    let text = data.candidates?.[0]?.content?.parts?.[0]?.text || "No insights could be generated.";
    
    // Strip markdown formatting if Gemini includes it
    text = text.replace(/```html/g, '').replace(/```/g, '');

    aiInsightsContent.innerHTML = text;
  } catch (err) {
    console.error(err);
    aiInsightsContent.innerHTML = `<p style="color:var(--primary)">Error: ${err.message}</p>`;
  } finally {
    aiInsightsBtn.disabled = false;
  }
}

aiInsightsBtn?.addEventListener('click', getAIInsights);
clearKeyBtn?.addEventListener('click', () => {
   localStorage.removeItem('gemini_api_key');
   aiInsightsPanel.classList.add('hidden');
   aiInsightsContent.innerHTML = '';
   alert('Gemini API Key removed securely from your device.');
});
