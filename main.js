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
    const query = encodeURIComponent(`notificacionesbaccr.com after:${currentYear}/01/01`);
    
    console.log("Searching with query:", decodeURIComponent(query));

    let allMessages = [];
    let pageToken = '';
    let pageCount = 0;

    // 1. Fetch message list (Paginated, max 10 pages / 500 emails to prevent freezing)
    while (pageCount < 10) {
      const ptParam = pageToken ? `&pageToken=${pageToken}` : '';
      const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=50${ptParam}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      
      const listData = await listRes.json();
      
      if (!listRes.ok || listData.error) {
        firstRawEmail = "GMAIL API ERROR: " + JSON.stringify(listData, null, 2);
        showState('empty');
        return;
      }

      if (listData.messages) {
        allMessages = allMessages.concat(listData.messages);
      }

      if (listData.nextPageToken) {
        pageToken = listData.nextPageToken;
        pageCount++;
        document.getElementById('loading-text').innerText = `Scanning emails (found ${allMessages.length})...`;
      } else {
        break;
      }
    }

    if (allMessages.length === 0) {
      firstRawEmail = "Query returned 0 results. Query was: " + decodeURIComponent(query);
      showState('empty');
      return;
    }

    // 2. Fetch full message details in batches (only those not cached!)
    let cachedTxs = {};
    try {
        cachedTxs = JSON.parse(localStorage.getItem('bac_transactions_cache') || '{}');
    } catch(e) { cachedTxs = {}; }

    const messagesToFetch = allMessages.filter(m => !cachedTxs[m.id]);
    const chunkSize = 20;

    for (let i = 0; i < messagesToFetch.length; i += chunkSize) {
      document.getElementById('loading-text').innerText = `Parsing new emails (${i}/${messagesToFetch.length})...`;
      const chunk = messagesToFetch.slice(i, i + chunkSize);
      
      const messagePromises = chunk.map(msg => 
        fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        }).then(res => res.json()).catch(e => null) // catch network failure on individual request
      );

      const messages = await Promise.all(messagePromises);

      messages.forEach(msg => {
        if (!msg || !msg.payload) return;
        
        const payload = msg.payload;
        let bodyData = '';
        
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
           firstRawEmail = decodedHtml; 
        }
        
        const tx = extractTransactionDetails(decodedHtml, msg.id);
        if (tx && tx.amountNum > 0) {
          cachedTxs[msg.id] = tx; // Add to cache dictionary
        }
      });
    }

    // Save cache
    localStorage.setItem('bac_transactions_cache', JSON.stringify(cachedTxs));

    // Combine cached and freshly parsed transactions matching the current list of queried messages
    const transactions = [];
    allMessages.forEach(m => {
       if (cachedTxs[m.id]) {
         transactions.push(cachedTxs[m.id]);
       }
    });

    console.log("Successfully loaded transactions:", transactions.length);

    if (transactions.length === 0) {
      showState('empty');
      return;
    }

    renderDashboard(transactions);

  } catch (error) {
    console.error("Error fetching emails:", error);
    alert("Error fetching emails: " + error.toString());
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

function extractTransactionDetails(htmlText, msgId) {
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
    
    // Plain text fallback
    const plainRegex = new RegExp(`${fieldName}\\s*(.*?)(?:\\n|<br|\\t|$)`, 'is');
    const plainMatch = cleanText.match(plainRegex);
    if (plainMatch && plainMatch[1]) {
        return plainMatch[1].replace(/<[^>]+>/g, '').trim();
    }

    return null;
  };

  const comercioRaw = extractField('Comercio:') || extractField('Comercio') || "Unknown Merchant";
  
  // Filter out false positive transactions that are just "Muchas gracias"
  if (!comercioRaw || comercioRaw.toLowerCase().includes('muchas gracias') || comercioRaw === "Unknown Merchant") {
      return null;
  }
  
  const pais = extractField('País:') || extractField('Pais:') || extractField('País') || extractField('Pais') || "CR";
  const isForeign = !pais.toUpperCase().includes('COSTA RICA') && !pais.toUpperCase().includes('CR');
  const comercio = comercioRaw + (isForeign ? " 🌎" : "");

  const fecha = extractField('Fecha:') || extractField('Fecha') || "";
  const tipo = extractField('Tipo de Transacci[oó]n:') || "COMPRA";
  const montoStrRaw = extractField('Monto:') || extractField('Monto') || "CRC 0.00";
  
  let amountNum = 0;
  const numMatch = montoStrRaw.match(/[\d,]+(?:\.\d+)?/);
  if (numMatch) {
    amountNum = parseFloat(numMatch[0].replace(/,/g, ''));
  }
  
  // Convert CRC to USD
  if (montoStrRaw.includes('CRC') || montoStrRaw.includes('¢')) {
     amountNum = amountNum / 505; // Standard approx exchange rate
  }
  
  amountNum = Math.round(amountNum); // No decimals requested
  const montoStr = "$" + amountNum;

  return { id: msgId, comercio, fecha, tipo, montoStr, amountNum };
}

function renderDashboard(transactions) {
  globalTransactions = transactions;
  
  // Sort by date (assuming order doesn't need complex parsing, or we just trust email order)
  // Usually Gmail API returns newest first.
  
  // Calculate total
  const total = transactions.reduce((sum, tx) => sum + tx.amountNum, 0);
  
  // Find prevalent currency strictly from the first valid string
  let currency = "USD";

  // Set Summary
  totalAmountEl.textContent = `${currency} ${total.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  transactionCountEl.textContent = `${transactions.length} transactions`;

  // We are not rendering the global transaction list anymore to save screen space and focus on category analysis.

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

const analyzeBtn = document.getElementById('analyze-btn');
const aiInsightsContent = document.getElementById('ai-insights-content');
const clearKeyBtn = document.getElementById('clear-key-btn');
const apiKeyPanel = document.getElementById('api-key-panel');
const geminiKeyInput = document.getElementById('gemini-key-input');
const saveKeyBtn = document.getElementById('save-key-btn');

saveKeyBtn?.addEventListener('click', () => {
   const val = geminiKeyInput.value.trim();
   if (val) {
      localStorage.setItem('gemini_api_key', val);
      apiKeyPanel.style.display = 'none';
      getAIInsights(); // auto-resume
   }
});

async function getAIInsights() {
  let apiKey = localStorage.getItem('gemini_api_key');
  if (!apiKey) {
    apiKeyPanel.style.display = 'block';
    aiInsightsContent.innerHTML = '';
    return;
  }
  apiKeyPanel.style.display = 'none';

  aiInsightsContent.innerHTML = '<div class="spinner" style="width:24px; height:24px; margin: 0 auto;"></div><p style="text-align:center; color: var(--text-muted)">Gemini is analyzing and categorizing...</p>';
  analyzeBtn.disabled = true;

  try {
    const txData = globalTransactions.map((tx, idx) => `${idx}: ${tx.comercio} - ${tx.montoStr}`).join('\\n');
    
    const promptText = `Categorize the following bank transactions into EXACTLY one of these categories: "Restaurants", "Groceries", "Shopping", "Hardware Store", "Subscriptions", "Uber Eats", "Transport", "Others".\\n\\nTransactions:\\n${txData}\\n\\nReturn ONLY a valid JSON array mapping the exact index to the chosen category. Example: [{"index": 0, "category": "Groceries"}, {"index": 1, "category": "Restaurants"}]`;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      headers: { 
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }],
        generationConfig: { responseMimeType: "application/json" }
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
    let jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    const mappedCategories = JSON.parse(jsonText);
    
    const catMap = {};
    if (Array.isArray(mappedCategories)) {
       mappedCategories.forEach(item => {
          catMap[item.index] = item.category;
       });
    }

    const categoryGroups = {
      "Restaurants": { total: 0, months: {} },
      "Groceries": { total: 0, months: {} },
      "Shopping": { total: 0, months: {} },
      "Hardware Store": { total: 0, months: {} },
      "Subscriptions": { total: 0, months: {} },
      "Uber Eats": { total: 0, months: {} },
      "Transport": { total: 0, months: {} },
      "Others": { total: 0, months: {} }
    };

    globalTransactions.forEach((tx, idx) => {
       const cat = catMap[idx] || "Others";
       
       // Parse amount from typical CRC or $ strings
       let val = parseFloat(tx.montoStr.replace(/[^0-9.-]+/g,""));
       if(isNaN(val)) val = 0;
       
       let monthStr = "Unknown";
       try {
         const d = new Date(tx.fecha);
         if (!isNaN(d)) {
            monthStr = d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
         } else {
            monthStr = tx.fecha.split(' ')[0] || "Unknown";
         }
       } catch(e){}

       if (categoryGroups[cat]) {
          categoryGroups[cat].total += val;
          if (!categoryGroups[cat].months[monthStr]) {
            categoryGroups[cat].months[monthStr] = { total: 0, txs: [] };
          }
          categoryGroups[cat].months[monthStr].total += val;
          categoryGroups[cat].months[monthStr].txs.push(tx);
       }
    });

    let html = '';
    Object.keys(categoryGroups).forEach(cat => {
       const group = categoryGroups[cat];
       if (group.total > 0) {
         html += `
         <details style="background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-md); margin-bottom:12px; padding:12px; cursor:pointer;" open>
            <summary style="font-weight:700; display:flex; justify-content:space-between; outline:none; color:var(--text-main); font-size: 16px;">
              <span>${cat}</span>
              <span>$${group.total.toLocaleString(undefined, {minimumFractionDigits:0, maximumFractionDigits:0})}</span>
            </summary>
            <div style="margin-top:12px; padding-top:12px; border-top:1px dashed var(--border);">
         `;
         
         Object.keys(group.months).forEach(mStr => {
            const mData = group.months[mStr];
            html += `
              <details style="margin-bottom:8px; margin-left:8px;">
                <summary style="font-weight:600; display:flex; justify-content:space-between; outline:none; color:var(--primary); font-size:14px; margin-bottom:6px;">
                  <span>${mStr}</span>
                  <span>$${mData.total.toLocaleString(undefined, {minimumFractionDigits:0, maximumFractionDigits:0})}</span>
                </summary>
                <div style="margin-left: 12px; margin-bottom: 12px;">
                  ${mData.txs.map(t => `
                     <div style="display:flex; justify-content:space-between; font-size:13px; margin-bottom:8px; color:var(--text-muted);">
                       <span>${t.fecha} - ${t.comercio}</span>
                       <strong style="color:var(--text-main)">${t.montoStr}</strong>
                     </div>
                  `).join('')}
                </div>
              </details>
            `;
         });
         
         html += `</div></details>`;
       }
    });

    if (!html) {
      html = `<p style="color:var(--text-muted);">No categorized transactions found.</p>`;
    }
    
    aiInsightsContent.innerHTML = html;
  } catch (err) {
    console.error(err);
    let extraHelp = "";
    if (err.message.includes("Load failed") || err.message.includes("Failed to fetch")) {
       extraHelp = "<br><br><small style='color:var(--text-muted); font-weight:normal;'><b>Note for iOS users:</b> 'Load failed' means Safari's built-in tracking prevention, an ad-blocker (like AdGuard), or a VPN is actively blocking the app from connecting to Google's AI API. Try turning off 'Advanced Tracking and Fingerprinting Protection' in Safari Settings or disabling content blockers for this page.</small>";
    }
    aiInsightsContent.innerHTML = `<p style="color:var(--primary); font-weight:600;">Error: ${err.message}${extraHelp}</p>`;
  } finally {
    analyzeBtn.disabled = false;
  }
}

analyzeBtn?.addEventListener('click', getAIInsights);
clearKeyBtn?.addEventListener('click', () => {
   localStorage.removeItem('gemini_api_key');
   aiInsightsContent.innerHTML = '';
   apiKeyPanel.style.display = 'block';
});
