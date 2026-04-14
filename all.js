import '@unocss/reset/tailwind.css';
import 'virtual:uno.css';
import './all.css';

// 這裡集中管理所有必要的 OAuth 與 Google Sheets 設定，避免散落在程式不同位置。
const CONFIG = {
  clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID,
  apiKey: import.meta.env.VITE_GOOGLE_API_KEY,
  spreadsheetId: import.meta.env.VITE_GOOGLE_SPREADSHEET_ID,
  scopes: [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/spreadsheets',
  ].join(' '),
};

// 全域狀態統一放在單一物件，讓畫面渲染與 API 流程都能共用同一份資料來源。
const state = {
  tokenClient: null,
  accessToken: '',
  userInfo: null,
  userRecord: null,
  usersMap: new Map(),
  restaurants: [],
  todayRestaurants: [],
  menuItems: [],
  todayOrders: [],
  isRefreshingToken: false,
  tokenRefreshPromise: null,
};

const elements = {
  loadingSection: document.querySelector('#loading-section'),
  loadingText: document.querySelector('#loading-text'),
  loginSection: document.querySelector('#login-section'),
  unauthorizedSection: document.querySelector('#unauthorized-section'),
  appSection: document.querySelector('#app-section'),
  loginButton: document.querySelector('#login-button'),
  logoutButton: document.querySelector('#logout-button'),
  logoutUnauthorizedButton: document.querySelector('#logout-unauthorized-button'),
  refreshButton: document.querySelector('#refresh-button'),
  userBadge: document.querySelector('#user-badge'),
  userName: document.querySelector('#user-name'),
  userRole: document.querySelector('#user-role'),
  adminConfig: document.querySelector('#admin-config'),
  restaurantCheckboxes: document.querySelector('#restaurant-checkboxes'),
  saveConfigButton: document.querySelector('#save-config-button'),
  todayRestaurantsChip: document.querySelector('#today-restaurants-chip'),
  menuList: document.querySelector('#menu-list'),
  menuEmptyState: document.querySelector('#menu-empty-state'),
  ordersList: document.querySelector('#orders-list'),
  ordersEmptyState: document.querySelector('#orders-empty-state'),
  copySummaryButton: document.querySelector('#copy-summary-button'),
  clearOrdersButton: document.querySelector('#clear-orders-button'),
  adminDanger: document.querySelector('#admin-danger'),
  statOrderCount: document.querySelector('#stat-order-count'),
  statOrderTotal: document.querySelector('#stat-order-total'),
  statRestaurantCount: document.querySelector('#stat-restaurant-count'),
  toast: document.querySelector('#toast'),
};

let toastTimer = null;

// 入口函式負責檢查必要設定、綁定事件，並等待 Google Identity Services script 可用。
async function boot() {
  bindEvents();

  if (!CONFIG.clientId || !CONFIG.apiKey || !CONFIG.spreadsheetId) {
    showOnly('login');
    elements.loginButton.disabled = true;
    setLoadingText('缺少環境變數，請先設定 .env 檔案。');
    showToast('請先設定 VITE_GOOGLE_CLIENT_ID、VITE_GOOGLE_API_KEY、VITE_GOOGLE_SPREADSHEET_ID。', true);
    return;
  }

  try {
    setLoadingText('正在載入 Google 登入服務...');
    await waitForGoogleIdentity();
    initTokenClient();
    showOnly('login');
  } catch (error) {
    console.error(error);
    setLoadingText('Google 登入服務載入失敗，請稍後重試。');
    showToast(getErrorMessage(error), true);
  }
}

// 綁定所有互動事件，集中管理可以避免初始化流程重複掛載事件處理器。
function bindEvents() {
  elements.loginButton.addEventListener('click', () => requestAccessToken(true));
  elements.logoutButton.addEventListener('click', handleLogout);
  elements.logoutUnauthorizedButton.addEventListener('click', handleLogout);
  elements.refreshButton.addEventListener('click', () => refreshAppData(true));
  elements.saveConfigButton.addEventListener('click', saveTodayConfig);
  elements.copySummaryButton.addEventListener('click', copyOrderSummary);
  elements.clearOrdersButton.addEventListener('click', clearAllOrders);
}

// 等待 Google Identity Services 腳本掛載完成，避免直接存取 window.google 時發生 undefined。
function waitForGoogleIdentity() {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const maxWait = 10000;

    const timer = window.setInterval(() => {
      if (window.google?.accounts?.oauth2) {
        window.clearInterval(timer);
        resolve();
        return;
      }

      if (Date.now() - startTime > maxWait) {
        window.clearInterval(timer);
        reject(new Error('Google Identity Services script 載入逾時。'));
      }
    }, 150);
  });
}

// 使用 GIS Token Model 建立 OAuth client，後續所有授權都透過這個 client 取得 access token。
function initTokenClient() {
  state.tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.clientId,
    scope: CONFIG.scopes,
    callback: async (tokenResponse) => {
      if (tokenResponse?.error) {
        showToast(`登入失敗：${tokenResponse.error}`, true);
        return;
      }

      state.accessToken = tokenResponse.access_token;

      try {
        setLoadingText('正在確認使用者身分與權限...');
        showOnly('loading');
        await handleAuthorizedSession();
      } catch (error) {
        console.error(error);
        showOnly('login');
        showToast(getErrorMessage(error), true);
      }
    },
  });
}

// 第一次登入使用 consent，後續 token 過期時則嘗試用 prompt=none 靜默刷新。
function requestAccessToken(withConsent = false) {
  if (!state.tokenClient) {
    showToast('Google 登入服務尚未初始化完成。', true);
    return;
  }

  state.tokenClient.requestAccessToken({
    prompt: withConsent ? 'consent' : '',
  });
}

// 這裡會在取得 OAuth token 後，先拿使用者 Email，再比對 Users 工作表並載入整個主畫面資料。
async function handleAuthorizedSession() {
  state.userInfo = await fetchUserInfo();
  state.userRecord = await checkUserPermission(state.userInfo.email);

  if (!state.userRecord) {
    renderUnauthorizedView();
    return;
  }

  renderUserBadge();
  showOnly('app');
  await refreshAppData(false);
}

// userinfo API 可直接拿到 email 與顯示名稱，這裡只保留畫面會使用到的欄位。
async function fetchUserInfo() {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: {
      Authorization: `Bearer ${state.accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error('無法取得 Google 使用者資訊。');
  }

  const data = await response.json();

  return {
    email: data.email?.toLowerCase() ?? '',
    name: data.name || data.email || '未知使用者',
  };
}

// 讀取 Users 表後，建立 email 到使用者資料的索引，之後訂單彙總與權限判斷都可重用這份資料。
async function checkUserPermission(email) {
  const rows = await sheetsGet('Users!A:C');
  const bodyRows = rows.slice(1);
  const usersMap = new Map();

  for (const row of bodyRows) {
    const [name = '', userEmail = '', role = '一般成員'] = row;
    const normalizedEmail = String(userEmail).trim().toLowerCase();
    if (!normalizedEmail) {
      continue;
    }

    usersMap.set(normalizedEmail, {
      name: String(name).trim() || normalizedEmail,
      email: normalizedEmail,
      role: String(role).trim() || '一般成員',
    });
  }

  state.usersMap = usersMap;
  return usersMap.get(email.toLowerCase()) || null;
}

// 一次刷新畫面資料，讓餐廳設定、菜單與今天訂單能在同一個流程同步更新。
async function refreshAppData(showDoneToast = false) {
  if (!state.userRecord) {
    return;
  }

  setActionLoading(elements.refreshButton, true, '更新中...');

  try {
    const [menuRows, todayRows, orderRows] = await Promise.all([
      sheetsGet('Menu!A:D'),
      sheetsGet('TodayConfig!A:A'),
      sheetsGet('Orders!A:F'),
    ]);

    state.menuItems = normalizeMenuRows(menuRows.slice(1));
    state.restaurants = getUniqueRestaurants(state.menuItems);
    state.todayRestaurants = normalizeTodayRestaurants(todayRows.slice(1));
    state.todayOrders = normalizeOrders(orderRows.slice(1));

    renderAdminArea();
    renderTodayRestaurantChips();
    renderMenuList();
    renderOrdersSummary();

    if (showDoneToast) {
      showToast('資料已重新整理。');
    }
  } catch (error) {
    console.error(error);
    showToast(getErrorMessage(error), true);
  } finally {
    setActionLoading(elements.refreshButton, false, '重新整理');
  }
}

// 所有 Sheets API 請求都統一走這個封裝，方便集中處理授權標頭、API key 與 401 重試邏輯。
async function sheetsRequest(path, options = {}, retry = true) {
  const separator = path.includes('?') ? '&' : '?';
  const apiKeyQuery = CONFIG.apiKey ? `${separator}key=${encodeURIComponent(CONFIG.apiKey)}` : '';
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.spreadsheetId}/${path}${apiKeyQuery}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.accessToken}`,
      ...(options.headers || {}),
    },
  });

  if (response.status === 401 && retry) {
    await refreshAccessToken();
    return sheetsRequest(path, options, false);
  }

  if (!response.ok) {
    const errorData = await safeJson(response);
    const message = errorData?.error?.message || `Google Sheets API 錯誤：${response.status}`;
    throw new Error(message);
  }

  return safeJson(response);
}

// 讀取指定範圍，若工作表目前沒有資料，統一回傳空陣列供上層邏輯處理。
async function sheetsGet(range) {
  const encodedRange = encodeURIComponent(range);
  const data = await sheetsRequest(`values/${encodedRange}`);
  return data?.values || [];
}

// 更新固定範圍，用於寫回 TodayConfig 等需要整段覆蓋的場景。
async function sheetsUpdate(range, values) {
  const encodedRange = encodeURIComponent(range);
  return sheetsRequest(`values/${encodedRange}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: JSON.stringify({
      range,
      majorDimension: 'ROWS',
      values,
    }),
  });
}

// 追加新列時使用 append，可保持 Orders 工作表的歷史紀錄。
async function sheetsAppend(range, values) {
  const encodedRange = encodeURIComponent(range);
  return sheetsRequest(
    `values/${encodedRange}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      body: JSON.stringify({
        range,
        majorDimension: 'ROWS',
        values,
      }),
    },
  );
}

// 清除範圍主要用於 TodayConfig 與管理員清空 Orders，不會刪除標題列本身。
async function sheetsClear(range) {
  const encodedRange = encodeURIComponent(range);
  return sheetsRequest(`values/${encodedRange}:clear`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

// 當 access token 過期時，集中在這裡處理刷新，避免多個 API 同時重複呼叫授權流程。
async function refreshAccessToken() {
  if (state.isRefreshingToken) {
    return state.tokenRefreshPromise;
  }

  state.isRefreshingToken = true;
  state.tokenRefreshPromise = new Promise((resolve, reject) => {
    state.tokenClient.callback = async (tokenResponse) => {
      if (tokenResponse?.error) {
        reject(new Error(`重新授權失敗：${tokenResponse.error}`));
        return;
      }

      state.accessToken = tokenResponse.access_token;

      try {
        state.userInfo = state.userInfo || (await fetchUserInfo());
      } catch (error) {
        console.error(error);
      }

      resolve();
    };

    state.tokenClient.requestAccessToken({ prompt: '' });
  });

  try {
    await state.tokenRefreshPromise;
  } finally {
    state.isRefreshingToken = false;
    state.tokenRefreshPromise = null;
    initTokenClient();
  }
}

// 管理員可從所有餐廳中勾選今天開放的餐廳，儲存時清空舊設定再寫入新設定。
async function saveTodayConfig() {
  if (!isAdmin()) {
    showToast('只有管理員可以設定今日餐廳。', true);
    return;
  }

  const selectedRestaurants = [...elements.restaurantCheckboxes.querySelectorAll('input[type="checkbox"]:checked')]
    .map((input) => input.value)
    .filter(Boolean);

  setActionLoading(elements.saveConfigButton, true, '儲存中...');

  try {
    await sheetsClear('TodayConfig!A2:A');

    if (selectedRestaurants.length > 0) {
      await sheetsUpdate(
        'TodayConfig!A2:A',
        selectedRestaurants.map((restaurant) => [restaurant]),
      );
    }

    state.todayRestaurants = [...selectedRestaurants];
    renderTodayRestaurantChips();
    renderMenuList();
    renderOrdersSummary();
    showToast('今日餐廳設定已更新。');
  } catch (error) {
    console.error(error);
    showToast(getErrorMessage(error), true);
  } finally {
    setActionLoading(elements.saveConfigButton, false, '儲存今日餐廳設定');
  }
}

// 每張餐點卡片都可以直接點餐，會把目前時間、登入者 Email、餐點與備註寫進 Orders 工作表。
async function submitOrder(item, noteValue, button) {
  if (!state.userRecord) {
    showToast('尚未登入，請先完成 Google 登入。', true);
    return false;
  }

  setActionLoading(button, true, '送出中...');

  try {
    const row = [
      formatDateTime(new Date()),
      state.userRecord.email,
      item.restaurant,
      item.name,
      item.price,
      noteValue.trim(),
    ];

    await sheetsAppend('Orders!A:F', [row]);
    showToast(`已送出 ${item.name}。`);
    await refreshAppData(false);
    return true;
  } catch (error) {
    console.error(error);
    showToast(getErrorMessage(error), true);
    return false;
  } finally {
    setActionLoading(button, false, '點餐');
  }
}

// 只取今天日期的訂單，方便做當日確認與統計，不會把舊資料混進來。
function getTodayOrders() {
  const todayKey = formatDateKey(new Date());
  return state.todayOrders.filter((order) => formatDateKey(order.createdAt) === todayKey);
}

// 一鍵複製會輸出可以直接貼到聊天工具的純文字摘要，包含餐廳分組、總筆數與總金額。
async function copyOrderSummary() {
  const orders = getTodayOrders();

  if (orders.length === 0) {
    showToast('今天還沒有訂單可複製。', true);
    return;
  }

  const summaryText = buildOrderSummaryText(orders);

  try {
    await navigator.clipboard.writeText(summaryText);
    showToast('今日訂單摘要已複製到剪貼簿。');
  } catch (error) {
    console.error(error);
    showToast('複製失敗，請確認瀏覽器是否允許剪貼簿權限。', true);
  }
}

// 這個功能依需求會清空 Orders 標題列之外的所有資料，因此操作前一定再做一次 confirm。
async function clearAllOrders() {
  if (!isAdmin()) {
    showToast('只有管理員可以清空訂單。', true);
    return;
  }

  const confirmed = window.confirm('確定要清空 Orders 工作表中標題列以外的所有資料嗎？');
  if (!confirmed) {
    return;
  }

  setActionLoading(elements.clearOrdersButton, true, '清空中...');

  try {
    await sheetsClear('Orders!A2:F');
    state.todayOrders = [];
    renderOrdersSummary();
    showToast('Orders 工作表已清空。');
  } catch (error) {
    console.error(error);
    showToast(getErrorMessage(error), true);
  } finally {
    setActionLoading(elements.clearOrdersButton, false, '清空今日點餐');
  }
}

// 管理員區塊根據角色切換顯示，並且在畫面上同步當前 TodayConfig 勾選狀態。
function renderAdminArea() {
  const adminMode = isAdmin();
  elements.adminConfig.classList.toggle('hidden', !adminMode);
  elements.adminDanger.classList.toggle('hidden', !adminMode);

  if (!adminMode) {
    return;
  }

  elements.restaurantCheckboxes.innerHTML = state.restaurants
    .map((restaurant) => {
      const checked = state.todayRestaurants.includes(restaurant) ? 'checked' : '';
      return `
        <label class="selection-card group">
          <input class="sr-only peer" type="checkbox" value="${escapeHtmlAttribute(restaurant)}" ${checked} />
          <div class="flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 border-slate-300 bg-white text-transparent transition-colors peer-checked:border-orange-500 peer-checked:bg-orange-500 peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-orange-500/30">
            <span class="i-lucide-check w-3.5 h-3.5"></span>
          </div>
          <span class="font-bold text-slate-700 transition-colors peer-checked:text-orange-700">${escapeHtml(restaurant)}</span>
        </label>
      `;
    })
    .join('');
}

// 畫面上方的使用者資訊可明確讓同仁知道自己目前登入的是哪個帳號與角色。
function renderUserBadge() {
  const userName = state.userRecord?.name || state.userInfo?.name || '未知使用者';
  const role = state.userRecord?.role || '未授權';

  elements.userBadge.classList.remove('hidden');
  elements.logoutButton.classList.remove('hidden');
  elements.userName.textContent = userName;
  elements.userRole.textContent = `${state.userInfo?.email || ''} ・ ${role}`;
}

// 以小標籤方式顯示今天開放餐廳，讓使用者一進畫面就知道今天有哪些選項。
function renderTodayRestaurantChips() {
  if (state.todayRestaurants.length === 0) {
    elements.todayRestaurantsChip.innerHTML = '<span class="rounded-full bg-slate-100 px-3 py-2 text-sm text-slate-500">今天尚未設定餐廳</span>';
    return;
  }

  elements.todayRestaurantsChip.innerHTML = state.todayRestaurants
    .map(
      (restaurant) =>
        `<span class="rounded-full bg-orange-100 px-3 py-2 text-sm font-semibold text-orange-700">${escapeHtml(restaurant)}</span>`,
    )
    .join('');
}

// 菜單會先依餐廳分組，再依分類分組，讓畫面在餐點變多時仍然清楚好掃描。
function renderMenuList() {
  const todaySet = new Set(state.todayRestaurants);
  const filteredItems = state.menuItems.filter((item) => todaySet.has(item.restaurant));

  elements.menuEmptyState.classList.toggle('hidden', filteredItems.length > 0);

  if (filteredItems.length === 0) {
    elements.menuList.innerHTML = '';
    return;
  }

  const restaurantGroups = groupBy(filteredItems, (item) => item.restaurant);
  const restaurantHtml = [...restaurantGroups.entries()]
    .map(([restaurant, restaurantItems]) => {
      const categoryGroups = groupBy(restaurantItems, (item) => item.category || '未分類');
      const categoryHtml = [...categoryGroups.entries()]
        .map(([category, categoryItems]) => {
          const cardsHtml = categoryItems
            .map((item) => {
              const itemKey = encodeURIComponent(`${item.restaurant}__${item.name}`);
              return `
                <article class="menu-card">
                  <div class="menu-card-header">
                    <div>
                      <h4 class="menu-name">${escapeHtml(item.name)}</h4>
                      <p class="menu-meta">${escapeHtml(category)}</p>
                    </div>
                    <span class="menu-price">$${item.price}</span>
                  </div>
                  <textarea
                    id="note-${itemKey}"
                    class="note-input"
                    placeholder="例如：少飯、微糖少冰、不要香菜"
                  ></textarea>
                  <button
                    type="button"
                    class="order-button"
                    data-order-restaurant="${escapeHtmlAttribute(item.restaurant)}"
                    data-order-name="${escapeHtmlAttribute(item.name)}"
                    data-order-price="${item.price}"
                    data-note-id="note-${itemKey}"
                    data-order-category="${escapeHtmlAttribute(item.category)}"
                  >
                    點餐
                  </button>
                </article>
              `;
            })
            .join('');

          return `
            <div class="space-y-3">
              <h3 class="category-title">${escapeHtml(category)}</h3>
              <div class="menu-grid">${cardsHtml}</div>
            </div>
          `;
        })
        .join('');

      return `
        <section class="restaurant-block">
          <h3 class="restaurant-title">${escapeHtml(restaurant)}</h3>
          <div class="mt-4 space-y-5">${categoryHtml}</div>
        </section>
      `;
    })
    .join('');

  elements.menuList.innerHTML = restaurantHtml;

  elements.menuList.querySelectorAll('.order-button').forEach((button) => {
    button.addEventListener('click', async () => {
      const noteId = button.dataset.noteId;
      const noteInput = noteId ? document.querySelector(`#${CSS.escape(noteId)}`) : null;

      const item = {
        restaurant: button.dataset.orderRestaurant || '',
        name: button.dataset.orderName || '',
        price: Number(button.dataset.orderPrice || 0),
        category: button.dataset.orderCategory || '',
      };

      const isSuccess = await submitOrder(item, noteInput?.value || '', button);

      if (isSuccess && noteInput) {
        noteInput.value = '';
      }
    });
  });
}

// 訂單摘要畫面與統計數字都在這裡更新，避免不同區塊各自重算產生不一致結果。
function renderOrdersSummary() {
  const orders = getTodayOrders();
  const groupedOrders = groupBy(orders, (order) => order.restaurant);
  const totalAmount = orders.reduce((sum, order) => sum + order.amount, 0);

  elements.statOrderCount.textContent = String(orders.length);
  elements.statOrderTotal.textContent = `$${totalAmount}`;
  elements.statRestaurantCount.textContent = String(state.todayRestaurants.length);
  elements.ordersEmptyState.classList.toggle('hidden', orders.length > 0);

  if (orders.length === 0) {
    elements.ordersList.innerHTML = '';
    return;
  }

  elements.ordersList.innerHTML = [...groupedOrders.entries()]
    .map(([restaurant, restaurantOrders]) => {
      const itemsHtml = restaurantOrders
        .map((order) => {
          const displayName = state.usersMap.get(order.email)?.name || order.email;
          const noteText = order.note ? `備註：${escapeHtml(order.note)}` : '備註：無';

          return `
            <li class="summary-item">
              <div class="summary-main">
                <p class="summary-name">${escapeHtml(displayName)} ・ ${escapeHtml(order.itemName)}</p>
                <p class="summary-note">${noteText}</p>
              </div>
              <div class="summary-price">$${order.amount}</div>
            </li>
          `;
        })
        .join('');

      return `
        <section class="summary-group">
          <h3 class="summary-restaurant">${escapeHtml(restaurant)}</h3>
          <ul class="summary-list">${itemsHtml}</ul>
        </section>
      `;
    })
    .join('');
}

// 未授權畫面只保留重新選帳號的動作，避免誤以為系統故障。
function renderUnauthorizedView() {
  elements.userBadge.classList.add('hidden');
  elements.logoutButton.classList.add('hidden');
  showOnly('unauthorized');
}

// 依目前主流程切換畫面顯示，避免多個 section 同時可見造成干擾。
function showOnly(sectionName) {
  const sections = {
    loading: elements.loadingSection,
    login: elements.loginSection,
    unauthorized: elements.unauthorizedSection,
    app: elements.appSection,
  };

  Object.entries(sections).forEach(([name, section]) => {
    const shouldShow = name === sectionName;
    section.classList.toggle('hidden', !shouldShow);
    if (shouldShow && (sectionName === 'loading' || sectionName === 'login' || sectionName === 'unauthorized')) {
      section.classList.add('flex');
    } else {
      section.classList.remove('flex');
    }
  });
}

// 所有主要操作按鈕都透過同一個 helper 切換 disabled 與按鈕文案，避免使用者重複點擊。
function setActionLoading(button, isLoading, loadingText) {
  if (!button) {
    return;
  }

  if (!button.dataset.defaultLabel) {
    button.dataset.defaultLabel = button.textContent.trim();
  }

  button.disabled = isLoading;
  button.textContent = isLoading ? loadingText : button.dataset.defaultLabel;
  button.classList.toggle('opacity-60', isLoading);
}

// Toast 用來顯示成功或錯誤訊息，避免過多 alert 影響操作流暢度。
function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.style.background = isError ? 'rgba(153, 27, 27, 0.96)' : 'rgba(15, 23, 42, 0.94)';
  elements.toast.classList.add('show');

  if (toastTimer) {
    window.clearTimeout(toastTimer);
  }

  toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove('show');
  }, 2600);
}

// 登出時把前端暫存狀態清乾淨，並撤銷目前 access token，避免下一位使用者沿用前一個人的狀態。
function handleLogout() {
  if (state.accessToken && window.google?.accounts?.oauth2) {
    window.google.accounts.oauth2.revoke(state.accessToken, () => {
      resetState();
      showOnly('login');
      showToast('已登出，請重新選擇 Google 帳號。');
    });
    return;
  }

  resetState();
  showOnly('login');
}

// 重置暫存狀態，確保登入/登出切換時不會殘留前一次資料。
function resetState() {
  state.accessToken = '';
  state.userInfo = null;
  state.userRecord = null;
  state.usersMap = new Map();
  state.restaurants = [];
  state.todayRestaurants = [];
  state.menuItems = [];
  state.todayOrders = [];

  elements.userBadge.classList.add('hidden');
  elements.logoutButton.classList.add('hidden');
  elements.menuList.innerHTML = '';
  elements.ordersList.innerHTML = '';
}

// 將 Menu 工作表轉成易用的物件結構，並且過濾掉缺少必要欄位的髒資料。
function normalizeMenuRows(rows) {
  return rows
    .map((row) => ({
      restaurant: String(row[0] || '').trim(),
      name: String(row[1] || '').trim(),
      price: Number(row[2] || 0),
      category: String(row[3] || '未分類').trim() || '未分類',
    }))
    .filter((item) => item.restaurant && item.name && Number.isFinite(item.price));
}

// TodayConfig 只需要餐廳名稱，因此把單欄資料攤平成簡單字串陣列。
function normalizeTodayRestaurants(rows) {
  return rows
    .map((row) => String(row[0] || '').trim())
    .filter(Boolean);
}

// Orders 工作表的時間欄位會轉成 Date 物件，之後做今日篩選與顯示都比較穩定。
function normalizeOrders(rows) {
  return rows
    .map((row) => ({
      createdAt: parseDateTime(String(row[0] || '')),
      email: String(row[1] || '').trim().toLowerCase(),
      restaurant: String(row[2] || '').trim(),
      itemName: String(row[3] || '').trim(),
      amount: Number(row[4] || 0),
      note: String(row[5] || '').trim(),
    }))
    .filter((order) => order.createdAt && order.email && order.restaurant && order.itemName);
}

// 建立不重複餐廳名稱清單，供管理員勾選今天要開放的餐廳。
function getUniqueRestaurants(items) {
  return [...new Set(items.map((item) => item.restaurant))].sort((left, right) => left.localeCompare(right, 'zh-Hant'));
}

// 文字摘要格式會直接拿去貼進通訊軟體，因此內容以清楚、可讀、可快速複製為優先。
function buildOrderSummaryText(orders) {
  const groupedOrders = groupBy(orders, (order) => order.restaurant);
  const lines = [`今日點餐彙總 (${formatDateDisplay(new Date())})`, '----------------'];
  let totalAmount = 0;
  let totalCount = 0;

  for (const [restaurant, restaurantOrders] of groupedOrders.entries()) {
    lines.push(restaurant);

    restaurantOrders.forEach((order, index) => {
      const displayName = state.usersMap.get(order.email)?.name || order.email;
      const noteText = order.note ? ` (${order.note})` : '';
      lines.push(`${index + 1}. ${displayName} - ${order.itemName} $${order.amount}${noteText}`);
      totalAmount += order.amount;
      totalCount += 1;
    });

    lines.push('');
  }

  lines.push('----------------');
  lines.push(`共 ${totalCount} 份，合計 $${totalAmount}`);
  return lines.join('\n');
}

// 將回應安全轉成 JSON，避免 clear 等回傳空物件時直接 parse 造成例外。
async function safeJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// 日期格式統一為工作表範例使用的 yyyy/mm/dd hh:mm，讓管理與人工檢視都一致。
function formatDateTime(date) {
  const year = date.getFullYear();
  const month = padNumber(date.getMonth() + 1);
  const day = padNumber(date.getDate());
  const hours = padNumber(date.getHours());
  const minutes = padNumber(date.getMinutes());
  return `${year}/${month}/${day} ${hours}:${minutes}`;
}

// 今日篩選只比對年月日，避免不同時間點建立的訂單被排除。
function formatDateKey(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return '';
  }

  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}`;
}

// 顯示在畫面與複製摘要中的日期採用簡短格式即可。
function formatDateDisplay(date) {
  return `${date.getFullYear()}/${padNumber(date.getMonth() + 1)}/${padNumber(date.getDate())}`;
}

// Sheets 字串日期採手動解析，避免不同瀏覽器對斜線日期格式的內建解析有落差。
function parseDateTime(value) {
  const match = value.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2}))?$/);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour = '0', minute = '0'] = match;
  return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
}

function padNumber(value) {
  return String(value).padStart(2, '0');
}

function isAdmin() {
  return state.userRecord?.role === '管理員';
}

function groupBy(items, keySelector) {
  const map = new Map();

  items.forEach((item) => {
    const key = keySelector(item);
    const existing = map.get(key) || [];
    existing.push(item);
    map.set(key, existing);
  });

  return map;
}

function setLoadingText(text) {
  elements.loadingText.textContent = text;
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : '發生未預期錯誤，請稍後再試。';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value);
}

boot();