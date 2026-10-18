import { reactive } from 'vue';
import {
  getStoredNativeServerOrigin,
  isCapacitorAndroid,
  restoreStoredNativeServerOrigin,
  resolveServerAssetUrl,
  setStoredNativeServerOrigin
} from './capacitor-platform.ts';
import { isDemoMode, runtimeSessionToken } from './runtime.js';
import api from './api.js';
import { hasDocumentSession, isGatewayMode } from './gateway.ts';
import {
  addAuthInvalidListener,
  clearStoredToken,
  getStoredToken,
  setStoredToken
} from './auth-storage.js';

const DEFAULT_SITE_ICON_URL = '/logo.svg';
let loginProbeController;

function collectLoginNetwork(session) {
  if (isDemoMode || isCapacitorAndroid || !session.loginProbeId) return;
  loginProbeController?.abort();
  const controller = new AbortController();
  loginProbeController = controller;
  // 探测失败不影响登录；先记一次性 ID，刷新和重新进入后台时不重复加载或探测。
  void (async () => {
    if (localStorage.getItem('edgechat.login-probe') === session.loginProbeId) return;
    localStorage.setItem('edgechat.login-probe', session.loginProbeId);
    const { probeWebRtc } = await import('./login-network.ts');
    if (controller.signal.aborted) return;
    const result = await probeWebRtc({ signal: controller.signal });
    if (controller.signal.aborted || state.token !== session.token) return;
    await api.reportLoginNetwork(session.loginProbeId, result, { signal: controller.signal });
  })().catch(() => {});
}

const state = reactive({
  ready: false,
  token: isDemoMode ? runtimeSessionToken : getStoredToken(),
  session: null,
  site: {
    siteName: 'Edgechat',
    siteIconUrl: '',
    turnstileSiteKey: ''
  }
});

function clearAuthState() {
  loginProbeController?.abort();
  clearStoredToken();
  state.token = '';
  state.session = null;
}

function applySiteMetadata(site) {
  const siteName = String(site?.siteName || 'Edgechat').trim() || 'Edgechat';
  const siteIconUrl = String(site?.siteIconUrl || '').trim();
  document.title = siteName;

  let favicon = document.querySelector('link[rel="icon"]');
  if (!favicon) {
    favicon = document.createElement('link');
    favicon.setAttribute('rel', 'icon');
    document.head.appendChild(favicon);
  }

  if (siteIconUrl) {
    favicon.setAttribute('href', resolveServerAssetUrl(siteIconUrl));
  } else {
    favicon.setAttribute('href', DEFAULT_SITE_ICON_URL);
  }
}

async function loadSite() {
  try {
    const payload = await api.getSite();
    setSite(payload.site);
  } catch {
    applySiteMetadata(state.site);
  }
}

async function initialize() {
  if (state.ready) {
    return;
  }

  if (isCapacitorAndroid && !getStoredNativeServerOrigin()) {
    clearAuthState();
    state.ready = true;
    return;
  }

  if (hasDocumentSession && !isDemoMode && !isCapacitorAndroid) {
    // 网关登录可能切换了账号，不能让之前 localStorage 中的旧 token 覆盖刚验证的 Cookie。
    clearAuthState();
  }
  await loadSite();

  if (!state.token && !hasDocumentSession) {
    state.ready = true;
    return;
  }

  try {
    const payload = await api.session();
    state.session = payload.session;
    state.token = payload.session.token;
    setStoredToken(state.token);
    collectLoginNetwork(payload.session);
  } catch {
    clearAuthState();
  } finally {
    state.ready = true;
  }
}

async function login(credentials) {
  const payload = await api.login(credentials);
  state.token = payload.token;
  state.session = payload.session;
  state.ready = true;
  setStoredToken(payload.token);
  collectLoginNetwork(payload.session);
}

async function configureNativeServer(configuredOrigin) {
  if (!isCapacitorAndroid) {
    return '';
  }

  const previousOrigin = getStoredNativeServerOrigin();
  const nextOrigin = setStoredNativeServerOrigin(configuredOrigin);
  try {
    const payload = await api.getSite();
    if (nextOrigin !== previousOrigin) {
      clearAuthState();
    }
    setSite(payload.site);
    return nextOrigin;
  } catch (error) {
    restoreStoredNativeServerOrigin(previousOrigin);
    throw new Error('native_server_unavailable', { cause: error });
  }
}

async function logout() {
  try {
    if (state.token) {
      await api.logout();
    }
  } finally {
    clearAuthState();
    if (!isDemoMode && !isCapacitorAndroid) window.location.replace('/');
  }
}

function setSession(session) {
  state.session = session;
}
let authorizationRefresh;
function refreshAuthorization() {
  if (!state.session) return Promise.resolve();
  if (!authorizationRefresh) authorizationRefresh = api.authorization().then(({ authorization }) => {
    if (state.session) state.session = { ...state.session, ...authorization };
  }).catch((error) => {
    if (state.session) state.session = { ...state.session, canAccessAdmin: false, isSuperAdmin: false, permissions: [] };
    throw error;
  }).finally(() => { authorizationRefresh = null; });
  return authorizationRefresh;
}

function setSite(site) {
  state.site = {
    siteName: String(site?.siteName || 'Edgechat').trim() || 'Edgechat',
    siteIconUrl: String(site?.siteIconUrl || '').trim(),
    // 人机验证开关由部署环境变量决定，其他接口的站点响应不含该字段，这里保留已加载的值。
    turnstileSiteKey: String(site?.turnstileSiteKey ?? state.site.turnstileSiteKey ?? '').trim()
  };
  applySiteMetadata(state.site);
}

if (typeof window !== 'undefined') {
  window.addEventListener('authorization-changed', () => { void refreshAuthorization().catch(() => {}); });
  addAuthInvalidListener(() => {
    clearAuthState();
    if (isGatewayMode) window.location.replace('/');
  });
}

export default {
  get ready() {
    return state.ready;
  },
  get token() {
    return state.token;
  },
  get session() {
    return state.session;
  },
  get site() {
    return state.site;
  },
  initialize,
  login,
  configureNativeServer,
  logout,
  setSession,
  setSite,
  loadSite,
  refreshAuthorization
};
