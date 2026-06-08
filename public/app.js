const MONTH_NAMES = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

let currentMonthData = null;
let editingShiftId = null;
let supabaseClient = null;
let authMode = 'login'; // 'login' or 'signup'
let currentProfile = null; // cached profile row
let currentEmail = '';     // logged-in user's email
let currentUserId = '';    // logged-in user's id (for ownership checks)
let currentDisplayName = ''; // name from signup or OAuth provider
let currentAuthAvatar = '';  // avatar from OAuth provider (Google/Facebook), if any
let composerAttachments = []; // pending attachments for a new post
let activeChatUserId = null;  // user id of the open chat thread
let activeChatPeer = null;    // peer profile of the open chat
let conversationsCache = [];  // last loaded conversation list
let usersCache = [];          // all users (for the new-message picker)
let chatAttachments = [];     // pending attachments for the next chat message
let lastThreadSig = '';       // signature to avoid needless thread re-renders
let messagesChannel = null;   // Supabase Realtime subscription (incoming messages)
let chatChannel = null;       // Realtime broadcast channel for the open chat (typing)
let typingHideTimer = null;   // hides the peer "typing…" indicator
let lastTypingSent = 0;       // throttle for sending typing events
let messagesTimer = null;     // polling while the Messages view is open
let unreadTimer = null;       // global polling for the nav unread badge
let editAvatarData = null;  // pending avatar data URL while editing
let viewingProfileId = null; // the profile currently being viewed
let viewingProfile = null;   // its data
let viewingIsSelf = false;   // is the viewed profile mine?
let viewingPosts = [];       // the viewed profile's timeline posts
let composerMentions = [];    // @mentions attached to the home composer
let userPickerMode = 'chat';  // 'chat' | 'mention'
let editCoverTheme = null;  // pending cover theme id while editing
let editCoverImage = null;  // pending cover photo data URL (null = use color theme)

// Cover color themes — each profile gets a different one by default.
// `accent` also tints the avatar background and bio bar for a cohesive look.
const COVER_THEMES = [
  { id: 'aurora', gradient: 'linear-gradient(120deg,#2563eb,#7c3aed,#ec4899)', accent: '#7c3aed' },
  { id: 'ocean',  gradient: 'linear-gradient(120deg,#0ea5e9,#2563eb,#1e40af)', accent: '#2563eb' },
  { id: 'sunset', gradient: 'linear-gradient(120deg,#f59e0b,#f97316,#ef4444)', accent: '#f97316' },
  { id: 'forest', gradient: 'linear-gradient(120deg,#10b981,#059669,#65a30d)', accent: '#059669' },
  { id: 'berry',  gradient: 'linear-gradient(120deg,#a855f7,#d946ef,#db2777)', accent: '#db2777' },
  { id: 'teal',   gradient: 'linear-gradient(120deg,#06b6d4,#14b8a6,#0ea5e9)', accent: '#0d9488' },
  { id: 'rose',   gradient: 'linear-gradient(120deg,#fb7185,#f43f5e,#e11d48)', accent: '#e11d48' },
  { id: 'gold',   gradient: 'linear-gradient(120deg,#fbbf24,#f59e0b,#d97706)', accent: '#d97706' },
  { id: 'slate',  gradient: 'linear-gradient(120deg,#64748b,#475569,#1e293b)', accent: '#475569' },
  { id: 'mint',   gradient: 'linear-gradient(120deg,#34d399,#22d3ee,#38bdf8)', accent: '#0891b2' },
];

function getTheme(p) {
  const found = COVER_THEMES.find(t => t.id === (p && p.cover_theme));
  if (found) return found;
  // Deterministic default from the account, so every profile differs
  const seed = (p && (p.user_id || p.full_name)) || currentEmail || '';
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return COVER_THEMES[hash % COVER_THEMES.length];
}

// Wipe ALL cached per-user state. Call on login, logout, and account switch
// so one account never sees another account's data.
function resetUserState() {
  currentProfile = null;
  currentEmail = '';
  currentUserId = '';
  currentDisplayName = '';
  currentAuthAvatar = '';
  currentMonthData = null;
  editingShiftId = null;
  composerAttachments = [];
  activeChatUserId = null;
  activeChatPeer = null;
  conversationsCache = [];
  usersCache = [];
  chatAttachments = [];
  lastThreadSig = '';
  viewingProfileId = null;
  viewingProfile = null;
  viewingPosts = [];
  composerMentions = [];
  stopMessagesPolling();
  unsubscribeMessages();
  leaveChatChannel();
  if (unreadTimer) { clearInterval(unreadTimer); unreadTimer = null; }
  const badge = document.getElementById('nav-unread');
  if (badge) badge.classList.add('hidden');
}

// Pull name/email/avatar out of a Supabase user, covering both email signup
// (user_metadata.display_name) and OAuth providers (full_name / name / picture).
function captureIdentity(user) {
  if (!user) return;
  const m = user.user_metadata || {};
  currentUserId = user.id || currentUserId;
  currentEmail = user.email || currentEmail;
  currentDisplayName = m.display_name || m.full_name || m.name || currentDisplayName;
  currentAuthAvatar = m.avatar_url || m.picture || currentAuthAvatar;
}

// --- Supabase Auth Init ---

async function initSupabase() {
  try {
    const res = await fetch('/api/config');
    const config = await res.json();
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      throw new Error('Server missing Supabase config. Check SUPABASE_URL and SUPABASE_ANON_KEY in .env');
    }
    const createClient = (window.supabase?.createClient) || (window.supabase && typeof window.supabase === 'object' && window.supabase.createClient);
    if (!createClient) throw new Error('Supabase script not loaded. Check browser console for errors.');
    supabaseClient = createClient(config.supabaseUrl, config.supabaseAnonKey);
  } catch (e) {
    document.getElementById('view-auth').innerHTML = `
      <div class="card auth-card">
        <h2>Config Error</h2>
        <p class="auth-error">${e.message}</p>
      </div>
    `;
    showView('view-auth');
    return;
  }

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    showHome();
  } else {
    showView('view-auth');
  }

  supabaseClient.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      resetUserState();
      showView('view-auth');
    }
    // User arrived via a password-reset email link → let them set a new password
    if (event === 'PASSWORD_RECOVERY') {
      showView('view-reset');
    }
  });
}

async function getToken() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  return session?.access_token || null;
}

// --- API Helpers ---

async function api(url, options = {}) {
  const token = await getToken();
  if (!token) {
    showView('view-auth');
    throw new Error('Not authenticated');
  }
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      ...options
    });
  } catch (networkErr) {
    console.error('Network error:', networkErr);
    throw new Error('Could not connect to server. Is it running?');
  }
  if (res.status === 401) {
    showView('view-auth');
    throw new Error('Session expired. Please log in again.');
  }
  let data;
  try {
    data = await res.json();
  } catch (parseErr) {
    throw new Error(`Server error (${res.status})`);
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// --- Auth ---

function togglePassword() {
  const input = document.getElementById('auth-password');
  const btn = document.getElementById('btn-toggle-pw');
  if (input.type === 'password') {
    input.type = 'text';
    btn.innerHTML = '&#128064;';
    btn.title = 'Hide password';
  } else {
    input.type = 'password';
    btn.innerHTML = '&#128065;';
    btn.title = 'Show password';
  }
}

function toggleAuthMode(e) {
  e.preventDefault();
  authMode = authMode === 'login' ? 'signup' : 'login';
  document.getElementById('auth-title').textContent = authMode === 'login' ? 'Log In' : 'Sign Up';
  document.getElementById('btn-auth-submit').textContent = authMode === 'login' ? 'Log In' : 'Sign Up';
  document.getElementById('auth-toggle-text').textContent =
    authMode === 'login' ? "Don't have an account?" : 'Already have an account?';
  document.getElementById('auth-toggle-link').textContent =
    authMode === 'login' ? 'Sign Up' : 'Log In';
  document.getElementById('auth-error').classList.add('hidden');
  const nameGroup = document.getElementById('auth-name-group');
  const forgotLink = document.getElementById('forgot-link');
  if (authMode === 'signup') {
    nameGroup.classList.remove('hidden');
    forgotLink.classList.add('hidden'); // only relevant when logging in
  } else {
    nameGroup.classList.add('hidden');
    forgotLink.classList.remove('hidden');
  }
}

async function handleAuth(e) {
  if (e) e.preventDefault();
  const btn = document.getElementById('btn-auth-submit');
  const errorEl = document.getElementById('auth-error');

  if (!supabaseClient) {
    errorEl.textContent = 'App not ready. Refresh the page.';
    errorEl.classList.remove('hidden');
    return;
  }

  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const name = document.getElementById('auth-name').value.trim();

  if (!email || !password) {
    errorEl.textContent = 'Please enter email and password.';
    errorEl.classList.remove('hidden');
    return;
  }

  if (authMode === 'signup' && !name) {
    errorEl.textContent = 'Please enter your name.';
    errorEl.classList.remove('hidden');
    return;
  }

  errorEl.classList.add('hidden');
  errorEl.style.color = '';
  const originalText = btn.textContent;
  btn.textContent = authMode === 'signup' ? 'Signing up...' : 'Logging in...';
  btn.disabled = true;

  try {
    let result;
    if (authMode === 'signup') {
      result = await supabaseClient.auth.signUp({
        email,
        password,
        options: { data: { display_name: name } }
      });
    } else {
      result = await supabaseClient.auth.signInWithPassword({ email, password });
    }

    if (result.error) throw result.error;

    // Supabase returns a user with an empty identities array when the email
    // already exists (enumeration protection). Don't create a duplicate.
    if (authMode === 'signup' && result.data.user && Array.isArray(result.data.user.identities)
        && result.data.user.identities.length === 0) {
      showExistingAccountNotice(email);
      return;
    }

    if (authMode === 'signup' && !result.data.session) {
      errorEl.textContent = 'Check your email for a confirmation link.';
      errorEl.classList.remove('hidden');
      errorEl.style.color = 'var(--success)';
      return;
    }

    // Clear any cached state from a previous account before loading this one.
    resetUserState();

    if (authMode === 'signup') {
      // Confirmation is off: persist the entered name to the profile so it's
      // used for the display name and the initials avatar everywhere.
      try {
        currentProfile = await api('/api/profile', {
          method: 'PUT',
          body: JSON.stringify({ full_name: name }),
        });
      } catch (e) { /* non-fatal; profile can be set later */ }
    }

    showHome();
  } catch (err) {
    let msg = err?.message || String(err);
    const low = msg.toLowerCase();
    // Existing email on signup → guide to log in / reset instead of duplicating
    if (authMode === 'signup' && (low.includes('already registered') || low.includes('already exists') || low.includes('already been registered'))) {
      showExistingAccountNotice(email);
      return;
    }
    if (low.includes('email not confirmed')) {
      msg += ' Check your inbox for the confirmation link, or disable "Confirm email" in Supabase Dashboard > Authentication > Providers > Email.';
    }
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
    errorEl.style.color = '';
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// An account with this email already exists: switch to login and nudge them
function showExistingAccountNotice(email) {
  if (authMode === 'signup') toggleAuthMode({ preventDefault() {} });
  if (email) document.getElementById('auth-email').value = email;
  const errorEl = document.getElementById('auth-error');
  errorEl.innerHTML = 'An account with this email already exists. Please log in below — or tap <a href="#" onclick="handleForgotPassword(event)">Forgot password?</a> if you don\'t remember it.';
  errorEl.classList.remove('hidden');
  errorEl.style.color = '';
}

// Send a password-reset email with a link back to the app
async function handleForgotPassword(e) {
  if (e) e.preventDefault();
  const errorEl = document.getElementById('auth-error');
  const email = document.getElementById('auth-email').value.trim();
  if (!email) {
    errorEl.textContent = 'Enter your email above first, then tap “Forgot password?”.';
    errorEl.classList.remove('hidden');
    errorEl.style.color = '';
    return;
  }
  try {
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    if (error) throw error;
    errorEl.textContent = `If an account exists for ${email}, a password-reset link is on its way. Check your inbox.`;
    errorEl.classList.remove('hidden');
    errorEl.style.color = 'var(--success)';
  } catch (err) {
    errorEl.textContent = err.message || 'Could not send reset email.';
    errorEl.classList.remove('hidden');
    errorEl.style.color = '';
  }
}

// Set a new password after arriving from the reset email link
async function submitNewPassword() {
  const errorEl = document.getElementById('reset-error');
  const pw = document.getElementById('reset-password').value;
  const confirm = document.getElementById('reset-confirm').value;
  errorEl.classList.add('hidden');
  if (!pw || pw.length < 6) {
    errorEl.textContent = 'Password must be at least 6 characters.';
    errorEl.classList.remove('hidden');
    return;
  }
  if (pw !== confirm) {
    errorEl.textContent = 'Passwords do not match.';
    errorEl.classList.remove('hidden');
    return;
  }
  try {
    const { error } = await supabaseClient.auth.updateUser({ password: pw });
    if (error) throw error;
    document.getElementById('reset-password').value = '';
    document.getElementById('reset-confirm').value = '';
    showToast('Password updated');
    showHome();
  } catch (err) {
    errorEl.textContent = err.message || 'Could not update password.';
    errorEl.classList.remove('hidden');
  }
}

// Social login (Google / Facebook) via Supabase OAuth.
// Redirects to the provider, then back to the app; the session is picked up
// automatically on return by initSupabase().
async function signInWithProvider(provider) {
  const errorEl = document.getElementById('auth-error');
  errorEl.classList.add('hidden');
  if (!supabaseClient) {
    errorEl.textContent = 'App not ready. Refresh the page.';
    errorEl.classList.remove('hidden');
    return;
  }
  try {
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
    });
    if (error) throw error;
    // The browser is now redirecting to the provider.
  } catch (e) {
    let msg = e.message || `Could not start ${provider} login`;
    if (/provider is not enabled/i.test(msg)) {
      msg = `${provider[0].toUpperCase() + provider.slice(1)} login isn't enabled yet. Enable it in your Supabase dashboard (Authentication → Providers).`;
    }
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
    errorEl.style.color = '';
  }
}

// Empty the login/signup inputs so a previous account's email/password
// never lingers on the auth screen.
function clearAuthForm() {
  ['auth-email', 'auth-password', 'auth-name'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  // Re-arm the readonly-until-focus guard so the browser won't auto-fill
  // these from saved credentials when the screen is shown again.
  ['auth-email', 'auth-password'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.setAttribute('readonly', '');
  });
  const err = document.getElementById('auth-error');
  if (err) err.classList.add('hidden');
}

function toggleSettingsMenu() {
  document.getElementById('settings-menu').classList.toggle('hidden');
}

async function handleLogout() {
  closeSettingsMenu();
  await supabaseClient.auth.signOut();
  resetUserState();
  showView('view-auth');
}

async function handleDeleteAccount() {
  closeSettingsMenu();
  if (!confirm('Are you sure you want to delete your account? All your data will be permanently lost.')) return;
  if (!confirm('This cannot be undone. Type OK to confirm by clicking OK.')) return;

  try {
    await api('/api/account', { method: 'DELETE' });
    await supabaseClient.auth.signOut();
    resetUserState();
    showView('view-auth');
    showToast('Account deleted');
  } catch (e) {
    showToast(e.message, true);
  }
}

function closeSettingsMenu() {
  document.getElementById('settings-menu').classList.add('hidden');
}

// --- Toast ---

function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast' + (isError ? ' error' : '');
  const delay = isError ? 4000 : 2500;
  setTimeout(() => toast.classList.add('hidden'), delay);
}

// --- Navigation ---

function showView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(viewId).classList.add('active');
  const settingsEl = document.getElementById('settings-container');
  const navEl = document.getElementById('main-nav');
  if (viewId === 'view-auth') {
    settingsEl.classList.add('hidden');
    navEl.classList.add('hidden');
    clearAuthForm();
  } else {
    settingsEl.classList.remove('hidden');
    navEl.classList.remove('hidden');
    startUnreadPolling();
  }
  // Highlight the active nav tab
  document.getElementById('nav-home').classList.toggle('active', viewId === 'view-home');
  document.getElementById('nav-messages').classList.toggle('active', viewId === 'view-messages');
  document.getElementById('nav-shifts').classList.toggle('active', viewId === 'view-months' || viewId === 'view-month-detail');
  // Stop chat polling when we leave the Messages view
  if (viewId !== 'view-messages') stopMessagesPolling();
  closeSettingsMenu();
}

async function showMonthsList() {
  showView('view-months');
  currentMonthData = null;
  editingShiftId = null;
  updateWelcomeName();
  refreshHeaderAvatar();
  await loadMonths();
}

async function updateWelcomeName() {
  const el = document.getElementById('welcome-name');
  if (!el || !supabaseClient) return;
  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    captureIdentity(user);
    const name = currentProfile?.full_name || currentDisplayName || '';
    el.textContent = name ? `Welcome, ${name}!` : '';
  } catch (e) {
    el.textContent = '';
  }
}

// --- Profile ---

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// If the profile is missing a name (or avatar), backfill it from the signup
// display name / OAuth provider — so the name (never the email) shows up, and
// Google/Facebook users get their photo. Sends the FULL profile so no other
// field gets wiped by the upsert.
async function ensureProfileName() {
  if (!currentProfile) return;
  const needName = !currentProfile.full_name && currentDisplayName;
  const needAvatar = !currentProfile.avatar_url && currentAuthAvatar;
  if (!needName && !needAvatar) return;

  const payload = {
    full_name: currentProfile.full_name || currentDisplayName || '',
    headline: currentProfile.headline,
    bio: currentProfile.bio,
    date_of_birth: currentProfile.date_of_birth,
    location: currentProfile.location,
    occupation: currentProfile.occupation,
    education: currentProfile.education,
    website: currentProfile.website,
    avatar_url: currentProfile.avatar_url || currentAuthAvatar || null,
    cover_theme: currentProfile.cover_theme,
    cover_image: currentProfile.cover_image,
  };
  try {
    currentProfile = await api('/api/profile', { method: 'PUT', body: JSON.stringify(payload) });
  } catch (e) { /* non-fatal */ }
}

function getInitials(name) {
  const source = (name || currentDisplayName || currentEmail || '').trim();
  if (!source) return '?';
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function renderAvatarInto(el, avatarUrl, name) {
  if (!el) return;
  if (avatarUrl) {
    el.innerHTML = `<img src="${avatarUrl}" alt="Profile photo">`;
  } else {
    el.innerHTML = `<span class="avatar-initials">${escapeHtml(getInitials(name))}</span>`;
  }
}

async function refreshHeaderAvatar() {
  const el = document.getElementById('header-avatar');
  if (!el) return;
  if (!currentProfile) {
    try { currentProfile = await api('/api/profile'); } catch (e) { /* ignore */ }
  }
  renderAvatarInto(el, currentProfile?.avatar_url, currentProfile?.full_name);
  el.style.background = getTheme(currentProfile).accent;
}

function formatDob(dob) {
  if (!dob) return '';
  const [y, m, d] = dob.split('-').map(Number);
  if (!y || !m || !d) return dob;
  const date = new Date(y, m - 1, d);
  const formatted = date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  // Age
  const now = new Date();
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age--;
  return age >= 0 ? `${formatted} (${age} yrs)` : formatted;
}

function normalizeUrl(url) {
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

// "My Profile" entry point
function openProfile() {
  viewProfile(currentUserId);
}

// View any user's profile (read-only for others; editable for self)
async function viewProfile(userId) {
  if (!userId) return;
  closeSettingsMenu();
  closeUserPicker();
  showView('view-profile');
  document.getElementById('profile-display').classList.remove('hidden');
  document.getElementById('profile-edit').classList.add('hidden');

  if (!currentUserId || !currentEmail) {
    try {
      const { data: { user } } = await supabaseClient.auth.getUser();
      captureIdentity(user);
    } catch (e) { /* ignore */ }
  }

  let data;
  try {
    data = await api('/api/profile/' + userId);
  } catch (e) {
    showToast('Failed to load profile', true);
    return;
  }
  viewingProfileId = userId;
  viewingProfile = data.profile || { user_id: userId };
  viewingIsSelf = !!data.isSelf;
  viewingPosts = data.posts || [];
  if (viewingIsSelf) {
    currentProfile = viewingProfile;
    await ensureProfileName();
    viewingProfile = currentProfile;
  }
  renderProfile();
}

function renderProfile() {
  const p = viewingProfile || {};
  const name = p.full_name || (viewingIsSelf ? (currentDisplayName || 'Your Name') : 'Member');
  const theme = getTheme(p);

  const avatarEl = document.getElementById('profile-avatar');
  renderAvatarInto(avatarEl, p.avatar_url, name);
  avatarEl.style.background = theme.accent;
  const coverEl = document.querySelector('.profile-cover');
  coverEl.style.background = p.cover_image
    ? `url("${p.cover_image}") center / cover no-repeat`
    : theme.gradient;
  document.getElementById('profile-name').textContent = name;

  // Edit (self) vs Message (others)
  document.getElementById('btn-edit-profile').classList.toggle('hidden', !viewingIsSelf);
  document.getElementById('btn-message-profile').classList.toggle('hidden', viewingIsSelf);

  const headlineEl = document.getElementById('profile-headline');
  headlineEl.textContent = p.headline || '';
  headlineEl.classList.toggle('hidden', !p.headline);

  const bioEl = document.getElementById('profile-bio');
  bioEl.textContent = p.bio || '';
  bioEl.classList.toggle('hidden', !p.bio);
  bioEl.style.borderLeftColor = theme.accent;

  // Info grid — fill value or hide the row
  const setInfo = (itemId, valueId, value, asLink) => {
    const item = document.getElementById(itemId);
    const valEl = document.getElementById(valueId);
    if (value) {
      if (asLink) {
        const href = normalizeUrl(value);
        valEl.innerHTML = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(value)}</a>`;
      } else {
        valEl.textContent = value;
      }
      item.classList.remove('hidden');
    } else {
      item.classList.add('hidden');
    }
  };

  setInfo('info-dob', 'profile-dob', formatDob(p.date_of_birth));
  setInfo('info-location', 'profile-location', p.location);
  setInfo('info-occupation', 'profile-occupation', p.occupation);
  setInfo('info-education', 'profile-education', p.education);
  setInfo('info-website', 'profile-website', p.website, true);
  // Email is shown only on your own profile (kept private to others)
  setInfo('info-email', 'profile-email', viewingIsSelf ? currentEmail : '');

  // Wall
  document.getElementById('wall-title').textContent = viewingIsSelf ? 'Your Wall' : `${name}'s Wall`;
  document.getElementById('wall-text').placeholder = viewingIsSelf
    ? 'Write on your wall...' : `Write something to ${name}...`;
  renderWallPosts();
}

function renderWallPosts() {
  const el = document.getElementById('wall-posts');
  if (!viewingPosts.length) {
    el.innerHTML = '<p class="empty-state">No posts yet.</p>';
    return;
  }
  el.innerHTML = viewingPosts.map(renderPostCard).join('');
}

async function reloadViewedProfilePosts() {
  if (!viewingProfileId) return;
  try {
    const data = await api('/api/profile/' + viewingProfileId);
    viewingPosts = data.posts || [];
    renderWallPosts();
  } catch (e) { /* ignore */ }
}

function messageViewedUser() {
  if (viewingProfileId) messageUser(viewingProfileId);
}

async function submitWallPost() {
  const ta = document.getElementById('wall-text');
  const content = ta.value.trim();
  if (!content || !viewingProfileId) return;
  ta.value = '';
  try {
    await api('/api/posts', {
      method: 'POST',
      body: JSON.stringify({ content, wall_owner_id: viewingProfileId }),
    });
    await reloadViewedProfilePosts();
  } catch (e) {
    ta.value = content;
    showToast(e.message, true);
  }
}

// Refresh whichever post list is currently visible (home feed or a profile wall)
async function refreshCurrentPosts() {
  if (document.getElementById('view-profile').classList.contains('active') && viewingProfileId) {
    return reloadViewedProfilePosts();
  }
  return loadFeed();
}

function startEditProfile() {
  const p = currentProfile || {};
  document.getElementById('edit-full-name').value = p.full_name || '';
  document.getElementById('edit-headline').value = p.headline || '';
  document.getElementById('edit-dob').value = p.date_of_birth || '';
  document.getElementById('edit-location').value = p.location || '';
  document.getElementById('edit-occupation').value = p.occupation || '';
  document.getElementById('edit-education').value = p.education || '';
  document.getElementById('edit-website').value = p.website || '';
  document.getElementById('edit-bio').value = p.bio || '';
  document.getElementById('edit-new-password').value = '';
  document.getElementById('edit-confirm-password').value = '';

  editAvatarData = p.avatar_url || null;
  renderAvatarInto(document.getElementById('profile-edit-avatar-preview'), editAvatarData, p.full_name);

  editCoverTheme = getTheme(p).id;
  editCoverImage = p.cover_image || null;
  renderCoverSwatches();
  // Swatches stay hidden until the user picks "Change Color" from the cover menu
  document.getElementById('cover-swatches').classList.add('hidden');
  closeCoverMenu();
  applyEditCover();

  document.getElementById('profile-display').classList.add('hidden');
  document.getElementById('profile-edit').classList.remove('hidden');
}

function renderCoverSwatches() {
  const container = document.getElementById('cover-swatches');
  container.innerHTML = COVER_THEMES.map(t =>
    `<button type="button" class="cover-swatch" data-theme="${t.id}" title="${t.id}"
      style="background:${t.gradient}" onclick="selectCoverTheme('${t.id}')"></button>`
  ).join('');
}

function selectCoverTheme(id) {
  editCoverTheme = id;
  editCoverImage = null; // picking a color clears any photo
  applyEditCover();
}

function applyEditCover() {
  const theme = COVER_THEMES.find(t => t.id === editCoverTheme) || COVER_THEMES[0];
  const preview = document.getElementById('edit-cover-preview');
  if (editCoverImage) {
    preview.style.background = `url("${editCoverImage}") center / cover no-repeat`;
  } else {
    preview.style.background = theme.gradient;
  }
  // Tint the avatar preview to match the selected theme
  document.getElementById('profile-edit-avatar-preview').style.background = theme.accent;
  // Highlight the selected swatch
  document.querySelectorAll('.cover-swatch').forEach(el => {
    el.classList.toggle('selected', !editCoverImage && el.dataset.theme === editCoverTheme);
  });
}

function cancelEditProfile() {
  document.getElementById('profile-edit').classList.add('hidden');
  document.getElementById('profile-display').classList.remove('hidden');
}

// Read an image file, resize to max dimension, and return a small JPEG data URL
function resizeImageFile(file, maxDim, quality, cb) {
  if (!file.type.startsWith('image/')) {
    showToast('Please choose an image file', true);
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; }
      else if (height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      cb(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => showToast('Could not read that image', true);
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function handleAvatarSelect(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  resizeImageFile(file, 400, 0.85, (dataUrl) => {
    editAvatarData = dataUrl;
    renderAvatarInto(document.getElementById('profile-edit-avatar-preview'), editAvatarData, document.getElementById('edit-full-name').value);
  });
  event.target.value = ''; // allow re-selecting same file
}

function removeAvatar() {
  editAvatarData = null;
  renderAvatarInto(document.getElementById('profile-edit-avatar-preview'), null, document.getElementById('edit-full-name').value);
}

function handleCoverSelect(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  resizeImageFile(file, 1200, 0.82, (dataUrl) => {
    editCoverImage = dataUrl;
    applyEditCover();
  });
  event.target.value = '';
}

// --- Cover menu (photo vs color) ---

function toggleCoverMenu(event) {
  if (event) event.stopPropagation();
  document.getElementById('cover-menu').classList.toggle('hidden');
}

function closeCoverMenu() {
  document.getElementById('cover-menu')?.classList.add('hidden');
}

function coverMenuUploadPhoto() {
  closeCoverMenu();
  document.getElementById('cover-input').click();
}

function coverMenuChooseColor() {
  closeCoverMenu();
  editCoverImage = null; // switch to color mode
  document.getElementById('cover-swatches').classList.remove('hidden');
  applyEditCover();
}

async function saveProfile() {
  const payload = {
    full_name: document.getElementById('edit-full-name').value.trim(),
    headline: document.getElementById('edit-headline').value.trim(),
    date_of_birth: document.getElementById('edit-dob').value,
    location: document.getElementById('edit-location').value.trim(),
    occupation: document.getElementById('edit-occupation').value.trim(),
    education: document.getElementById('edit-education').value.trim(),
    website: document.getElementById('edit-website').value.trim(),
    bio: document.getElementById('edit-bio').value.trim(),
    avatar_url: editAvatarData,
    cover_theme: editCoverTheme,
    cover_image: editCoverImage,
  };

  try {
    currentProfile = await api('/api/profile', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    // Keep Supabase display_name in sync so the welcome message matches
    if (payload.full_name) {
      try { await supabaseClient.auth.updateUser({ data: { display_name: payload.full_name } }); } catch (e) { /* non-fatal */ }
    }
    viewingProfile = currentProfile;
    renderProfile();
    refreshHeaderAvatar();
    cancelEditProfile();
    showToast('Profile saved');
  } catch (e) {
    showToast(e.message, true);
  }
}

async function changePassword() {
  const pw = document.getElementById('edit-new-password').value;
  const confirm = document.getElementById('edit-confirm-password').value;
  if (!pw || pw.length < 6) {
    showToast('Password must be at least 6 characters', true);
    return;
  }
  if (pw !== confirm) {
    showToast('Passwords do not match', true);
    return;
  }
  try {
    const { error } = await supabaseClient.auth.updateUser({ password: pw });
    if (error) throw error;
    document.getElementById('edit-new-password').value = '';
    document.getElementById('edit-confirm-password').value = '';
    showToast('Password updated');
  } catch (e) {
    showToast(e.message || 'Could not update password', true);
  }
}

// --- Home Feed ---

async function showHome() {
  showView('view-home');
  currentMonthData = null;
  editingShiftId = null;
  composerMentions = [];
  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    captureIdentity(user);
  } catch (e) { /* ignore */ }
  if (!currentProfile) {
    try { currentProfile = await api('/api/profile'); } catch (e) { /* ignore */ }
  }
  await ensureProfileName();
  subscribeMessages();
  renderAvatarInto(document.getElementById('composer-avatar'), currentProfile?.avatar_url, currentProfile?.full_name);
  document.getElementById('composer-avatar').style.background = getTheme(currentProfile).accent;
  refreshHeaderAvatar();
  await loadFeed();
}

function feedInitials(name) {
  const s = (name || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Avatar markup for any user (posts/comments), tinted by their theme
function userAvatarHtml(url, name, userId, cssClass) {
  const theme = getTheme({ user_id: userId, full_name: name });
  const inner = url
    ? `<img src="${url}" alt="">`
    : `<span class="avatar-initials">${escapeHtml(feedInitials(name))}</span>`;
  return `<div class="${cssClass}" style="background:${theme.accent}">${inner}</div>`;
}

function authorName(p) {
  return p.full_name || 'Member';
}

function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const secs = Math.floor((Date.now() - then) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function humanSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// --- Composer ---

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB per file

function handleComposerImages(event) {
  const files = Array.from(event.target.files || []);
  files.forEach((file) => {
    if (composerAttachments.length >= 10) { showToast('Up to 10 attachments per post', true); return; }
    resizeImageFile(file, 1400, 0.82, (dataUrl) => {
      composerAttachments.push({ kind: 'image', name: file.name, mime: 'image/jpeg', data: dataUrl });
      renderComposerAttachments();
    });
  });
  event.target.value = '';
}

function handleComposerFiles(event) {
  const files = Array.from(event.target.files || []);
  files.forEach((file) => {
    if (composerAttachments.length >= 10) { showToast('Up to 10 attachments per post', true); return; }
    if (file.size > MAX_FILE_BYTES) { showToast(`"${file.name}" is larger than 8 MB`, true); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      composerAttachments.push({ kind: 'file', name: file.name, mime: file.type || 'application/octet-stream', data: e.target.result, size: file.size });
      renderComposerAttachments();
    };
    reader.onerror = () => showToast(`Could not read "${file.name}"`, true);
    reader.readAsDataURL(file);
  });
  event.target.value = '';
}

function removeComposerAttachment(index) {
  composerAttachments.splice(index, 1);
  renderComposerAttachments();
}

function renderComposerAttachments() {
  const el = document.getElementById('composer-attachments');
  if (composerAttachments.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = composerAttachments.map((a, i) => {
    if (a.kind === 'image') {
      return `<div class="attach-thumb">
        <img src="${a.data}" alt="">
        <button type="button" class="attach-remove" onclick="removeComposerAttachment(${i})" title="Remove">&times;</button>
      </div>`;
    }
    return `<div class="attach-chip">
      <span class="attach-chip-icon">&#128196;</span>
      <span class="attach-chip-name">${escapeHtml(a.name || 'file')}</span>
      <span class="attach-chip-size">${humanSize(a.size)}</span>
      <button type="button" class="attach-remove" onclick="removeComposerAttachment(${i})" title="Remove">&times;</button>
    </div>`;
  }).join('');
}

async function submitPost() {
  const text = document.getElementById('composer-text').value.trim();
  if (!text && composerAttachments.length === 0) {
    showToast('Write something or add an attachment', true);
    return;
  }
  const btn = document.getElementById('composer-post-btn');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Posting...';
  try {
    const payload = {
      content: text,
      attachments: composerAttachments.map(({ kind, name, mime, data }) => ({ kind, name, mime, data })),
      mentions: composerMentions.slice(),
    };
    await api('/api/posts', { method: 'POST', body: JSON.stringify(payload) });
    document.getElementById('composer-text').value = '';
    composerAttachments = [];
    composerMentions = [];
    renderComposerAttachments();
    showToast('Posted');
    await loadFeed();
  } catch (e) {
    showToast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// --- Feed rendering ---

async function loadFeed() {
  const list = document.getElementById('feed-list');
  try {
    const posts = await api('/api/posts');
    renderFeed(posts);
  } catch (e) {
    if (e.message !== 'Not authenticated') {
      list.innerHTML = '<p class="empty-state">Could not load the feed.</p>';
    }
  }
}

function renderFeed(posts) {
  const list = document.getElementById('feed-list');
  if (!posts || posts.length === 0) {
    list.innerHTML = '<p class="empty-state">No posts yet. Be the first to share something!</p>';
    return;
  }
  list.innerHTML = posts.map(renderPostCard).join('');
}

// Render post text, turning @mentions into clickable profile links
function renderPostContent(content, mentions) {
  let html = escapeHtml(content);
  (mentions || []).forEach((m) => {
    if (!m.full_name) return;
    const token = escapeHtml('@' + m.full_name);
    const link = `<a class="mention" onclick="viewProfile('${m.user_id}')">${token}</a>`;
    html = html.split(token).join(link);
  });
  return html;
}

function attachmentHtml(a) {
  if (a.kind === 'image') {
    return `<a class="post-image" href="${a.data}" target="_blank" rel="noopener"><img src="${a.data}" alt="${escapeHtml(a.name || '')}"></a>`;
  }
  return `<a class="post-file" href="${a.data}" download="${escapeHtml(a.name || 'file')}">
    <span class="post-file-icon">&#128196;</span>
    <span class="post-file-name">${escapeHtml(a.name || 'Download file')}</span>
    <span class="post-file-dl">Download</span>
  </a>`;
}

function renderPostCard(p) {
  const images = p.attachments.filter(a => a.kind === 'image');
  const files = p.attachments.filter(a => a.kind === 'file');
  const imagesHtml = images.length
    ? `<div class="post-images count-${Math.min(images.length, 4)}">${images.map(attachmentHtml).join('')}</div>` : '';
  const filesHtml = files.length
    ? `<div class="post-files">${files.map(attachmentHtml).join('')}</div>` : '';
  const contentHtml = p.content ? `<div class="post-content">${renderPostContent(p.content, p.mentions)}</div>` : '';
  const ownDelete = p.user_id === currentUserId
    ? `<button class="btn-icon delete post-delete" onclick="deletePost(${p.id})" title="Delete post">&times;</button>` : '';

  const commentsHtml = p.comments.map(c => renderComment(c)).join('');
  // When a post sits on someone else's wall, show the wall owner
  const wallTag = (p.wall_owner_id && p.wall_owner_id !== p.user_id)
    ? `<span class="wall-tag">&#9656; <a onclick="viewProfile('${p.wall_owner_id}')">${escapeHtml(p.wall_owner_name || 'wall')}</a></span>` : '';

  return `
    <div class="post-card" id="post-${p.id}">
      <div class="post-head">
        <span class="author-link" onclick="viewProfile('${p.user_id}')">${userAvatarHtml(p.avatar_url, authorName(p), p.user_id, 'feed-avatar')}</span>
        <div class="post-meta">
          <span class="post-author"><a onclick="viewProfile('${p.user_id}')">${escapeHtml(authorName(p))}</a>${wallTag}</span>
          <span class="post-time">${timeAgo(p.created_at)}</span>
        </div>
        ${ownDelete}
      </div>
      ${contentHtml}
      ${imagesHtml}
      ${filesHtml}
      <div class="post-actions">
        <button class="like-btn ${p.liked ? 'liked' : ''}" onclick="toggleLike('post', ${p.id}, this)">
          <span class="like-heart">${p.liked ? '❤️' : '♡'}</span>
          <span class="like-label">${p.like_count} ${p.like_count === 1 ? 'Like' : 'Likes'}</span>
        </button>
        <span class="post-comment-count">&#128172; ${p.comment_count} comment${p.comment_count === 1 ? '' : 's'}</span>
        ${p.user_id !== currentUserId ? `<button class="post-message-btn" onclick="messageUser('${p.user_id}')" title="Message ${escapeHtml(authorName(p))}">&#9993; Message</button>` : ''}
      </div>
      <div class="comments">
        ${commentsHtml}
        <div class="comment-compose">
          ${userAvatarHtml(currentProfile?.avatar_url, currentProfile?.full_name, currentUserId, 'feed-avatar feed-avatar-sm')}
          <input type="text" class="comment-input" id="comment-input-${p.id}" placeholder="Write a comment..."
            autocomplete="off" autocorrect="off" autocapitalize="sentences" spellcheck="true"
            onkeydown="if(event.key==='Enter'){event.preventDefault();addComment(${p.id});}">
          <button class="btn btn-primary btn-sm" onclick="addComment(${p.id})">Send</button>
        </div>
      </div>
    </div>
  `;
}

function renderComment(c) {
  const ownDelete = c.user_id === currentUserId
    ? `<button class="btn-icon delete comment-delete" onclick="deleteComment(${c.id})" title="Delete">&times;</button>` : '';
  return `
    <div class="comment" id="comment-${c.id}">
      <span class="author-link" onclick="viewProfile('${c.user_id}')">${userAvatarHtml(c.avatar_url, authorName(c), c.user_id, 'feed-avatar feed-avatar-sm')}</span>
      <div class="comment-body">
        <div class="comment-bubble">
          <span class="comment-author"><a onclick="viewProfile('${c.user_id}')">${escapeHtml(authorName(c))}</a></span>
          <span class="comment-text">${escapeHtml(c.content)}</span>
        </div>
        <div class="comment-meta">
          <button class="comment-like ${c.liked ? 'liked' : ''}" onclick="toggleLike('comment', ${c.id}, this)">
            Like<span class="${c.liked ? '' : 'hidden'}">d</span>
          </button>
          <span class="comment-like-count">${c.like_count > 0 ? '❤️ ' + c.like_count : ''}</span>
          <span class="comment-time">${timeAgo(c.created_at)}</span>
          ${ownDelete}
        </div>
      </div>
    </div>
  `;
}

async function toggleLike(targetType, targetId, btn) {
  try {
    const { liked, count } = await api('/api/likes', {
      method: 'POST',
      body: JSON.stringify({ target_type: targetType, target_id: targetId }),
    });
    if (targetType === 'post') {
      btn.classList.toggle('liked', liked);
      btn.querySelector('.like-heart').textContent = liked ? '❤️' : '♡';
      btn.querySelector('.like-label').textContent = `${count} ${count === 1 ? 'Like' : 'Likes'}`;
    } else {
      btn.classList.toggle('liked', liked);
      const dSpan = btn.querySelector('span');
      if (dSpan) dSpan.classList.toggle('hidden', !liked);
      const countEl = btn.parentElement.querySelector('.comment-like-count');
      if (countEl) countEl.textContent = count > 0 ? '❤️ ' + count : '';
    }
  } catch (e) {
    showToast(e.message, true);
  }
}

async function addComment(postId) {
  const input = document.getElementById(`comment-input-${postId}`);
  const content = input.value.trim();
  if (!content) return;
  input.disabled = true;
  try {
    await api(`/api/posts/${postId}/comments`, { method: 'POST', body: JSON.stringify({ content }) });
    input.value = '';
    await refreshCurrentPosts();
  } catch (e) {
    showToast(e.message, true);
  } finally {
    input.disabled = false;
  }
}

async function deletePost(id) {
  if (!confirm('Delete this post? This cannot be undone.')) return;
  try {
    await api(`/api/posts/${id}`, { method: 'DELETE' });
    showToast('Post deleted');
    await refreshCurrentPosts();
  } catch (e) {
    showToast(e.message, true);
  }
}

async function deleteComment(id) {
  if (!confirm('Delete this comment?')) return;
  try {
    await api(`/api/comments/${id}`, { method: 'DELETE' });
    await refreshCurrentPosts();
  } catch (e) {
    showToast(e.message, true);
  }
}

// --- Messages / Chat ---

async function showMessages() {
  showView('view-messages');
  currentMonthData = null;
  editingShiftId = null;
  if (!currentUserId) {
    try {
      const { data: { user } } = await supabaseClient.auth.getUser();
      captureIdentity(user);
    } catch (e) { /* ignore */ }
  }
  subscribeMessages();
  // Show the empty state unless a chat is already open
  if (!activeChatUserId) closeChat();
  await loadConversations();
  if (activeChatUserId) await loadThread(true);
  startMessagesPolling();
}

function startUnreadPolling() {
  if (unreadTimer) return;
  updateUnreadBadge();
  unreadTimer = setInterval(updateUnreadBadge, 8000);
}

function startMessagesPolling() {
  if (messagesTimer) return;
  messagesTimer = setInterval(async () => {
    if (!document.getElementById('view-messages').classList.contains('active')) return;
    await loadConversations();
    if (activeChatUserId) await loadThread(false);
    updateUnreadBadge();
  }, 3000);
}

function stopMessagesPolling() {
  if (messagesTimer) { clearInterval(messagesTimer); messagesTimer = null; }
}

// Realtime: instantly react when a new message arrives for me.
// (Requires the `messages` table to be added to Supabase Realtime; if it isn't,
// polling still keeps things up to date as a fallback.)
function subscribeMessages() {
  if (messagesChannel || !supabaseClient || !currentUserId) return;
  messagesChannel = supabaseClient
    .channel(`dm-${currentUserId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `recipient_id=eq.${currentUserId}` },
      (payload) => {
        const msg = payload.new || {};
        updateUnreadBadge();
        if (document.getElementById('view-messages').classList.contains('active')) {
          loadConversations();
          if (activeChatUserId && msg.sender_id === activeChatUserId) loadThread(true);
        }
      }
    )
    .subscribe();
}

function unsubscribeMessages() {
  if (messagesChannel && supabaseClient) {
    try { supabaseClient.removeChannel(messagesChannel); } catch (e) { /* ignore */ }
  }
  messagesChannel = null;
}

// --- Typing indicator (Realtime broadcast, per conversation) ---

function joinChatChannel(peerId) {
  leaveChatChannel();
  if (!supabaseClient || !currentUserId || !peerId) return;
  const key = [currentUserId, peerId].sort().join('_');
  chatChannel = supabaseClient.channel(`chat:${key}`, { config: { broadcast: { self: false } } });
  chatChannel.on('broadcast', { event: 'typing' }, (msg) => {
    const from = msg.payload && msg.payload.from;
    if (from && from === activeChatUserId) showPeerTyping();
  });
  chatChannel.subscribe();
}

function leaveChatChannel() {
  if (chatChannel && supabaseClient) {
    try { supabaseClient.removeChannel(chatChannel); } catch (e) { /* ignore */ }
  }
  chatChannel = null;
  if (typingHideTimer) { clearTimeout(typingHideTimer); typingHideTimer = null; }
  const el = document.getElementById('chat-typing');
  if (el) el.classList.add('hidden');
}

// Called as the user types — broadcast a throttled "typing" event to the peer
function onChatTyping() {
  if (!chatChannel) return;
  const now = Date.now();
  if (now - lastTypingSent < 1500) return;
  lastTypingSent = now;
  try {
    chatChannel.send({ type: 'broadcast', event: 'typing', payload: { from: currentUserId } });
  } catch (e) { /* ignore */ }
}

// Peer is typing → show indicator, auto-hide after a short pause
function showPeerTyping() {
  const el = document.getElementById('chat-typing');
  if (!el) return;
  el.classList.remove('hidden');
  const messagesEl = document.getElementById('chat-messages');
  if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  if (typingHideTimer) clearTimeout(typingHideTimer);
  typingHideTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

async function updateUnreadBadge() {
  const badge = document.getElementById('nav-unread');
  if (!badge || !supabaseClient) return;
  try {
    const { count } = await api('/api/messages/unread-total');
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : count;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch (e) { /* ignore */ }
}

async function loadConversations() {
  try {
    conversationsCache = await api('/api/conversations');
    renderConversations();
  } catch (e) {
    if (e.message !== 'Not authenticated') {
      document.getElementById('conversations-list').innerHTML = '<p class="empty-state">Could not load conversations.</p>';
    }
  }
}

function renderConversations() {
  const list = document.getElementById('conversations-list');
  if (!conversationsCache.length) {
    list.innerHTML = '<p class="empty-state">No conversations yet. Tap “+ New” to message someone.</p>';
    return;
  }
  list.innerHTML = conversationsCache.map((c) => {
    const name = c.full_name || 'Member';
    const prefix = c.last_sender === currentUserId ? 'You: ' : '';
    const preview = escapeHtml(prefix + (c.last_message || '📎 Attachment'));
    const unread = c.unread > 0
      ? `<span class="conv-unread">${c.unread > 99 ? '99+' : c.unread}</span>` : '';
    return `
      <button class="conv-item ${c.partner_id === activeChatUserId ? 'active' : ''}" onclick="pickConversation('${c.partner_id}')">
        ${userAvatarHtml(c.avatar_url, name, c.partner_id, 'feed-avatar')}
        <div class="conv-info">
          <div class="conv-top">
            <span class="conv-name">${escapeHtml(name)}</span>
            <span class="conv-time">${timeAgo(c.last_at)}</span>
          </div>
          <div class="conv-preview ${c.unread > 0 ? 'unread' : ''}">${preview}</div>
        </div>
        ${unread}
      </button>
    `;
  }).join('');
}

// Jump straight into a chat with a user (e.g. from a post's Message button)
async function messageUser(userId) {
  if (!userId || userId === currentUserId) return;
  await showMessages();
  const u = usersCache.find((x) => x.user_id === userId)
    || conversationsCache.find((c) => c.partner_id === userId);
  const peer = u
    ? { user_id: userId, full_name: u.full_name, avatar_url: u.avatar_url, cover_theme: u.cover_theme }
    : { user_id: userId, full_name: null, avatar_url: null };
  openChat(userId, peer);
}

function pickConversation(userId) {
  const c = conversationsCache.find((x) => x.partner_id === userId);
  const peer = c
    ? { user_id: userId, full_name: c.full_name, avatar_url: c.avatar_url, cover_theme: c.cover_theme }
    : { user_id: userId, full_name: null, avatar_url: null };
  openChat(userId, peer);
}

function openChat(userId, peer) {
  activeChatUserId = userId;
  activeChatPeer = peer;
  lastThreadSig = '';
  chatAttachments = [];
  renderChatAttachments();
  document.getElementById('chat-empty').classList.add('hidden');
  document.getElementById('chat-thread').classList.remove('hidden');
  document.querySelector('.messages-layout').classList.add('chat-open');
  renderChatPeer();
  renderConversations(); // refresh active highlight
  joinChatChannel(userId); // typing indicator channel
  loadThread(true);
  setTimeout(() => document.getElementById('chat-input')?.focus(), 50);
}

function closeChat() {
  activeChatUserId = null;
  activeChatPeer = null;
  leaveChatChannel();
  document.getElementById('chat-thread').classList.add('hidden');
  document.getElementById('chat-empty').classList.remove('hidden');
  document.querySelector('.messages-layout').classList.remove('chat-open');
  renderConversations();
}

function renderChatPeer() {
  const p = activeChatPeer || {};
  const name = p.full_name || 'Member';
  document.getElementById('chat-peer').innerHTML =
    `<span class="author-link" onclick="viewProfile('${p.user_id}')">${userAvatarHtml(p.avatar_url, name, p.user_id, 'feed-avatar feed-avatar-sm')}</span><span class="chat-peer-name"><a onclick="viewProfile('${p.user_id}')">${escapeHtml(name)}</a></span>`;
}

async function loadThread(forceScroll) {
  if (!activeChatUserId) return;
  let data;
  try {
    data = await api(`/api/messages/${activeChatUserId}`);
  } catch (e) {
    return;
  }
  if (data.peer) { activeChatPeer = data.peer; renderChatPeer(); }
  const msgs = data.messages || [];
  // Include read-state in the signature so the "Read" status re-renders too
  const readMine = msgs.filter((m) => m.sender_id === currentUserId && m.read_at).length;
  const sig = `${msgs.length}:${msgs.length ? msgs[msgs.length - 1].id : 0}:${readMine}`;
  if (sig === lastThreadSig && !forceScroll) return;
  lastThreadSig = sig;
  renderThread(msgs);
}

function renderThread(msgs) {
  const el = document.getElementById('chat-messages');
  if (!msgs.length) {
    el.innerHTML = '<p class="chat-empty-thread">No messages yet. Say hi! 👋</p>';
    return;
  }
  // Index of the last message I sent — only it shows a Read/Sent status
  let lastMineIndex = -1;
  msgs.forEach((m, i) => { if (m.sender_id === currentUserId) lastMineIndex = i; });

  el.innerHTML = msgs.map((m, i) => {
    const mine = m.sender_id === currentUserId;
    const atts = Array.isArray(m.attachments) ? m.attachments : [];
    const attHtml = atts.map(msgAttachmentHtml).join('');
    const textHtml = m.content ? `<div class="msg-text">${escapeHtml(m.content)}</div>` : '';
    const status = (mine && i === lastMineIndex)
      ? `<span class="msg-status">${m.read_at ? '✓✓ Read' : '✓ Sent'}</span>` : '';
    return `
      <div class="msg ${mine ? 'mine' : 'theirs'}">
        <div class="msg-bubble">${attHtml}${textHtml}</div>
        <div class="msg-time">${timeAgo(m.created_at)}${status}</div>
      </div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function msgAttachmentHtml(a) {
  if (a.kind === 'image') {
    return `<a class="msg-image" href="${a.data}" target="_blank" rel="noopener"><img src="${a.data}" alt="${escapeHtml(a.name || '')}"></a>`;
  }
  return `<a class="msg-file" href="${a.data}" download="${escapeHtml(a.name || 'file')}">
    <span class="msg-file-icon">&#128196;</span>
    <span class="msg-file-name">${escapeHtml(a.name || 'Download file')}</span>
  </a>`;
}

// --- Chat attachments ---

function handleChatImages(event) {
  const files = Array.from(event.target.files || []);
  files.forEach((file) => {
    if (chatAttachments.length >= 10) { showToast('Up to 10 attachments per message', true); return; }
    resizeImageFile(file, 1400, 0.82, (dataUrl) => {
      chatAttachments.push({ kind: 'image', name: file.name, mime: 'image/jpeg', data: dataUrl });
      renderChatAttachments();
    });
  });
  event.target.value = '';
}

function handleChatFiles(event) {
  const files = Array.from(event.target.files || []);
  files.forEach((file) => {
    if (chatAttachments.length >= 10) { showToast('Up to 10 attachments per message', true); return; }
    if (file.size > MAX_FILE_BYTES) { showToast(`"${file.name}" is larger than 8 MB`, true); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      chatAttachments.push({ kind: 'file', name: file.name, mime: file.type || 'application/octet-stream', data: e.target.result, size: file.size });
      renderChatAttachments();
    };
    reader.onerror = () => showToast(`Could not read "${file.name}"`, true);
    reader.readAsDataURL(file);
  });
  event.target.value = '';
}

function removeChatAttachment(index) {
  chatAttachments.splice(index, 1);
  renderChatAttachments();
}

function renderChatAttachments() {
  const el = document.getElementById('chat-attachments');
  if (!el) return;
  if (chatAttachments.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = chatAttachments.map((a, i) => {
    if (a.kind === 'image') {
      return `<div class="attach-thumb">
        <img src="${a.data}" alt="">
        <button type="button" class="attach-remove" onclick="removeChatAttachment(${i})" title="Remove">&times;</button>
      </div>`;
    }
    return `<div class="attach-chip">
      <span class="attach-chip-icon">&#128196;</span>
      <span class="attach-chip-name">${escapeHtml(a.name || 'file')}</span>
      <span class="attach-chip-size">${humanSize(a.size)}</span>
      <button type="button" class="attach-remove" onclick="removeChatAttachment(${i})" title="Remove">&times;</button>
    </div>`;
  }).join('');
}

async function sendMessage() {
  const input = document.getElementById('chat-input');
  const content = input.value.trim();
  if ((!content && chatAttachments.length === 0) || !activeChatUserId) return;
  const sentAttachments = chatAttachments.map(({ kind, name, mime, data }) => ({ kind, name, mime, data }));
  input.value = '';
  chatAttachments = [];
  renderChatAttachments();
  try {
    await api('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ recipient_id: activeChatUserId, content, attachments: sentAttachments }),
    });
    await loadThread(true);
    await loadConversations();
  } catch (e) {
    input.value = content; // restore on failure
    chatAttachments = sentAttachments;
    renderChatAttachments();
    showToast(e.message, true);
  }
}

// --- New message: user picker ---

async function showUserPicker(mode) {
  userPickerMode = mode === 'mention' ? 'mention' : 'chat';
  const modal = document.getElementById('userpicker-modal');
  const listEl = document.getElementById('userpicker-list');
  document.getElementById('userpicker-search').value = '';
  listEl.innerHTML = '<p class="empty-state">Loading...</p>';
  modal.classList.remove('hidden');
  setTimeout(() => document.getElementById('userpicker-search')?.focus(), 50);
  try {
    usersCache = await api('/api/users');
    renderUserPicker(usersCache);
  } catch (e) {
    listEl.innerHTML = '<p class="empty-state">Could not load people.</p>';
  }
}

function renderUserPicker(list) {
  const el = document.getElementById('userpicker-list');
  if (!list.length) {
    el.innerHTML = '<p class="empty-state">No other users found.</p>';
    return;
  }
  el.innerHTML = list.map((u) => {
    const name = u.full_name || 'Member';
    return `
      <button class="userpicker-item" onclick="pickUser('${u.user_id}')">
        ${userAvatarHtml(u.avatar_url, name, u.user_id, 'feed-avatar feed-avatar-sm')}
        <span class="userpicker-name">${escapeHtml(name)}</span>
      </button>`;
  }).join('');
}

function filterUserPicker() {
  const q = document.getElementById('userpicker-search').value.trim().toLowerCase();
  const filtered = !q ? usersCache
    : usersCache.filter((u) => (u.full_name || 'member').toLowerCase().includes(q));
  renderUserPicker(filtered);
}

function pickUser(userId) {
  const u = usersCache.find((x) => x.user_id === userId);
  closeUserPicker();
  if (userPickerMode === 'mention') {
    addMention(u || { user_id: userId, full_name: 'Member' });
    return;
  }
  openChat(userId, u || { user_id: userId, full_name: null, avatar_url: null });
}

// Insert an @mention into the home composer and remember it for the post
function addMention(user) {
  const name = user.full_name || 'Member';
  const ta = document.getElementById('composer-text');
  const insert = '@' + name + ' ';
  const start = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
  const end = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
  ta.value = ta.value.slice(0, start) + insert + ta.value.slice(end);
  const pos = start + insert.length;
  ta.focus();
  try { ta.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
  if (!composerMentions.some((m) => m.user_id === user.user_id)) {
    composerMentions.push({ user_id: user.user_id, full_name: name });
  }
}

function closeUserPicker() {
  document.getElementById('userpicker-modal').classList.add('hidden');
}

// --- Months List ---

async function loadMonths() {
  try {
    const months = await api('/api/months');
    renderMonthsList(months);
  } catch (e) {
    if (e.message !== 'Not authenticated') showToast('Failed to load months', true);
  }
}

function renderMonthsList(months) {
  const container = document.getElementById('months-list');

  if (months.length === 0) {
    container.innerHTML = '<p class="empty-state">No months created yet. Click "+ New Month" to get started.</p>';
    return;
  }

  container.innerHTML = months.map(m => {
    const statusClass = m.is_closed ? 'badge-closed' : 'badge-open';
    const statusText = m.is_closed ? 'Closed' : 'Open';
    return `
      <div class="month-item" onclick="openMonth(${m.id})">
        <div class="month-item-info">
          <span class="month-item-name">${MONTH_NAMES[m.month]} ${m.year}</span>
          <span class="badge ${statusClass}">${statusText}</span>
        </div>
        <div class="month-item-meta">
          <button class="btn-icon delete month-item-delete" onclick="event.stopPropagation(); deleteMonth(${m.id}, '${MONTH_NAMES[m.month]} ${m.year}')" title="Delete month">&times;</button>
        </div>
      </div>
    `;
  }).join('');
}

function showNewMonthForm() {
  const form = document.getElementById('new-month-form');
  form.classList.remove('hidden');
  const now = new Date();
  document.getElementById('new-month-select').value = now.getMonth() + 1;
  document.getElementById('new-year-input').value = now.getFullYear();
}

function hideNewMonthForm() {
  document.getElementById('new-month-form').classList.add('hidden');
}

async function createMonth() {
  const month = parseInt(document.getElementById('new-month-select').value);
  const year = parseInt(document.getElementById('new-year-input').value);

  if (!year || year < 2020 || year > 2099) {
    showToast('Please enter a valid year', true);
    return;
  }

  try {
    const newMonth = await api('/api/months', {
      method: 'POST',
      body: JSON.stringify({ month, year })
    });
    hideNewMonthForm();
    showToast(`${MONTH_NAMES[month]} ${year} created`);
    openMonth(newMonth.id);
  } catch (e) {
    showToast(e.message, true);
  }
}

async function deleteMonth(id, name) {
  if (!confirm(`Delete "${name}" and all its shifts? This cannot be undone.`)) return;
  try {
    await api(`/api/months/${id}`, { method: 'DELETE' });
    showToast(`${name} deleted`);
    loadMonths();
  } catch (e) {
    showToast(e.message, true);
  }
}

// --- Month Detail ---

async function openMonth(id) {
  try {
    const data = await api(`/api/months/${id}`);
    currentMonthData = data;
    renderMonthDetail();
    showView('view-month-detail');
  } catch (e) {
    showToast('Failed to load month', true);
  }
}

function renderMonthDetail() {
  const d = currentMonthData;
  const title = `${MONTH_NAMES[d.month]} ${d.year}`;
  document.getElementById('month-detail-title').textContent = title;

  const badge = document.getElementById('month-status-badge');
  const editBtn = document.getElementById('btn-edit-month');
  const shiftForm = document.getElementById('shift-form-container');
  const closeContainer = document.getElementById('close-month-container');
  const colActions = document.getElementById('col-actions');
  const colActionsFoot = document.getElementById('col-actions-foot');

  colActions.classList.remove('hidden');
  colActionsFoot.classList.remove('hidden');

  if (d.is_closed) {
    badge.textContent = 'Closed';
    badge.className = 'badge badge-closed';
    editBtn.classList.remove('hidden');
    shiftForm.classList.add('hidden');
    closeContainer.classList.add('hidden');
  } else {
    badge.textContent = 'Open';
    badge.className = 'badge badge-open';
    editBtn.classList.add('hidden');
    shiftForm.classList.remove('hidden');
    closeContainer.classList.remove('hidden');
    resetShiftForm();
  }

  renderShiftsTable();
}

async function reopenMonth() {
  try {
    await api(`/api/months/${currentMonthData.id}/reopen`, { method: 'PATCH' });
    currentMonthData.is_closed = 0;
    renderMonthDetail();
    showToast('Month reopened for editing');
  } catch (e) {
    showToast(e.message, true);
  }
}

async function closeMonth() {
  const name = `${MONTH_NAMES[currentMonthData.month]} ${currentMonthData.year}`;
  if (!confirm(`Close "${name}"? You can still edit later if needed.`)) return;
  try {
    await api(`/api/months/${currentMonthData.id}/close`, { method: 'PATCH' });
    currentMonthData.is_closed = 1;
    renderMonthDetail();
    showToast(`${name} closed`);
  } catch (e) {
    showToast(e.message, true);
  }
}

// --- Shifts ---

function renderShiftsTable() {
  const shifts = currentMonthData.shifts || [];
  const tbody = document.getElementById('shifts-body');
  const noShiftsMsg = document.getElementById('no-shifts-msg');
  const isEditable = !currentMonthData.is_closed;

  if (shifts.length === 0) {
    tbody.innerHTML = '';
    noShiftsMsg.classList.remove('hidden');
    document.getElementById('total-hours').innerHTML = '<strong>0</strong>';
    document.getElementById('total-earnings').innerHTML = '<strong>0.00 DKK</strong>';
    return;
  }

  noShiftsMsg.classList.add('hidden');

  let totalHours = 0;
  let totalEarnings = 0;

  tbody.innerHTML = shifts.map(s => {
    totalHours += s.total_hours;
    totalEarnings += s.daily_earnings;

    const dateParts = s.date.split('-');
    const displayDate = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`;

    const editDeleteHtml = isEditable ? `
          <button class="btn-icon" onclick="editShift(${s.id})" title="Edit">&#9998;</button>
          <button class="btn-icon delete" onclick="deleteShift(${s.id})" title="Delete">&times;</button>
    ` : '';

    return `
      <tr id="shift-row-${s.id}" class="${editingShiftId === s.id ? 'editing' : ''}">
        <td>
          ${displayDate}
          <span class="day-label">${s.day_name}</span>
        </td>
        <td>${s.start_time} \u2013 ${s.end_time}</td>
        <td>${s.break_start && s.break_end ? s.break_start + ' \u2013 ' + s.break_end : 'None'}</td>
        <td>${s.total_hours.toFixed(2)}</td>
        <td class="earnings-cell">${s.daily_earnings.toFixed(2)}</td>
        <td class="col-actions">
          <div class="actions-cell">
            <button class="btn-icon" onclick="showBreakdown(${s.id})" title="Details">&#9432;</button>
            ${editDeleteHtml}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  document.getElementById('total-hours').innerHTML = `<strong>${totalHours.toFixed(2)}</strong>`;
  document.getElementById('total-earnings').innerHTML = `<strong>${totalEarnings.toFixed(2)} DKK</strong>`;
}

function resetShiftForm() {
  editingShiftId = null;
  document.getElementById('shift-form-title').textContent = 'Add New Shift';
  document.getElementById('btn-save-shift').textContent = 'Add Shift';
  document.getElementById('btn-cancel-edit').classList.add('hidden');
  document.getElementById('shift-date').value = '';
  document.getElementById('shift-start').value = '';
  document.getElementById('shift-end').value = '';
  document.getElementById('shift-break-start').value = '';
  document.getElementById('shift-break-end').value = '';
  setDefaultDate();
}

function setDefaultDate() {
  if (!currentMonthData) return;
  const m = currentMonthData;
  const now = new Date();
  const y = m.year;
  const mo = m.month;

  if (now.getFullYear() === y && (now.getMonth() + 1) === mo) {
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(mo).padStart(2, '0');
    document.getElementById('shift-date').value = `${y}-${mm}-${dd}`;
  } else {
    const mm = String(mo).padStart(2, '0');
    document.getElementById('shift-date').value = `${y}-${mm}-01`;
  }
}

function editShift(id) {
  const shift = currentMonthData.shifts.find(s => s.id === id);
  if (!shift) return;

  editingShiftId = id;
  document.getElementById('shift-form-title').textContent = 'Edit Shift';
  document.getElementById('btn-save-shift').textContent = 'Update Shift';
  document.getElementById('btn-cancel-edit').classList.remove('hidden');
  document.getElementById('shift-date').value = shift.date;
  document.getElementById('shift-start').value = shift.start_time;
  document.getElementById('shift-end').value = shift.end_time;
  document.getElementById('shift-break-start').value = shift.break_start || '';
  document.getElementById('shift-break-end').value = shift.break_end || '';

  renderShiftsTable();
  document.getElementById('shift-form-container').scrollIntoView({ behavior: 'smooth' });
}

function cancelEditShift() {
  resetShiftForm();
  renderShiftsTable();
}

async function saveShift() {
  const date = document.getElementById('shift-date').value;
  const startTime = document.getElementById('shift-start').value;
  const endTime = document.getElementById('shift-end').value;
  const breakStart = document.getElementById('shift-break-start').value;
  const breakEnd = document.getElementById('shift-break-end').value;

  if (!date || !startTime || !endTime) {
    showToast('Please fill in date, start and end time', true);
    return;
  }

  if ((breakStart && !breakEnd) || (!breakStart && breakEnd)) {
    showToast('Please fill in both break start and end, or leave both empty', true);
    return;
  }

  const payload = {
    date,
    start_time: startTime,
    end_time: endTime,
    break_start: breakStart || null,
    break_end: breakEnd || null
  };

  try {
    if (editingShiftId) {
      await api(`/api/shifts/${editingShiftId}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showToast('Shift updated');
    } else {
      await api(`/api/months/${currentMonthData.id}/shifts`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast('Shift added');
    }

    const refreshed = await api(`/api/months/${currentMonthData.id}`);
    currentMonthData = refreshed;
    resetShiftForm();
    renderShiftsTable();
  } catch (e) {
    showToast(e.message, true);
  }
}

async function deleteShift(id) {
  if (!confirm('Delete this shift?')) return;
  try {
    await api(`/api/shifts/${id}`, { method: 'DELETE' });
    const refreshed = await api(`/api/months/${currentMonthData.id}`);
    currentMonthData = refreshed;
    renderShiftsTable();
    showToast('Shift deleted');
  } catch (e) {
    showToast(e.message, true);
  }
}

// --- Breakdown Modal ---

async function showBreakdown(shiftId) {
  try {
    const { shift, breakdown } = await api(`/api/shifts/${shiftId}/breakdown`);
    renderBreakdownModal(shift, breakdown);
  } catch (e) {
    showToast(e.message, true);
  }
}

function renderBreakdownModal(shift, breakdown) {
  const dateParts = shift.date.split('-');
  const displayDate = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`;
  const hasBreak = shift.break_start && shift.break_end;

  let segmentsHtml = breakdown.segments.map(seg => {
    if (seg.isBreak) {
      return `
        <tr class="breakdown-break-row">
          <td>${seg.dayName}</td>
          <td>${seg.from} \u2013 ${seg.to}</td>
          <td colspan="4" class="breakdown-break-label">BREAK (${seg.minutes} min)</td>
        </tr>
      `;
    }

    const supplementHtml = seg.supplement > 0
      ? `<span class="breakdown-supplement">+${seg.supplement.toFixed(2)}</span>`
      : '<span class="breakdown-no-supplement">none</span>';

    const supplementNameHtml = seg.supplementLabel
      ? `<div class="breakdown-supplement-name">${seg.supplementLabel}</div>`
      : '';

    return `
      <tr>
        <td>${seg.dayName}</td>
        <td>${seg.from} \u2013 ${seg.to}</td>
        <td>
          ${seg.baseRate.toFixed(2)} ${supplementHtml}
          ${supplementNameHtml}
        </td>
        <td><strong>${seg.rate.toFixed(2)}</strong> DKK/h</td>
        <td>${seg.hours.toFixed(2)}h</td>
        <td class="earnings-cell">${seg.earnings.toFixed(2)} DKK</td>
      </tr>
    `;
  }).join('');

  const modal = document.getElementById('breakdown-modal');
  const content = document.getElementById('breakdown-content');

  content.innerHTML = `
    <div class="breakdown-header-info">
      <div><strong>Date:</strong> ${displayDate} (${shift.day_name})</div>
      <div><strong>Shift:</strong> ${shift.start_time} \u2013 ${shift.end_time}</div>
      ${hasBreak ? `<div><strong>Break:</strong> ${shift.break_start} \u2013 ${shift.break_end} (${shift.break_minutes} min)</div>` : '<div><strong>Break:</strong> None</div>'}
    </div>

    <table class="breakdown-table">
      <thead>
        <tr>
          <th>Day</th>
          <th>Time</th>
          <th>Base + Supplement</th>
          <th>Rate</th>
          <th>Hours</th>
          <th>Earnings</th>
        </tr>
      </thead>
      <tbody>${segmentsHtml}</tbody>
    </table>

    <div class="breakdown-total">
      <div class="breakdown-total-row">
        <span>Total worked:</span>
        <strong>${breakdown.totalWorkedHours.toFixed(2)} hours</strong>
      </div>
      <div class="breakdown-total-row breakdown-total-earnings">
        <span>Total earnings:</span>
        <strong>${breakdown.totalEarnings.toFixed(2)} DKK</strong>
      </div>
    </div>
  `;

  modal.classList.remove('hidden');
}

function closeBreakdownModal() {
  document.getElementById('breakdown-modal').classList.add('hidden');
}

// --- Init ---

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('breakdown-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'breakdown-modal') closeBreakdownModal();
  });

  document.getElementById('userpicker-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'userpicker-modal') closeUserPicker();
  });

  document.addEventListener('click', (e) => {
    const container = document.getElementById('settings-container');
    if (container && !container.contains(e.target)) {
      closeSettingsMenu();
    }
    const coverWrap = document.querySelector('.edit-cover-preview-wrap');
    if (coverWrap && !coverWrap.contains(e.target)) {
      closeCoverMenu();
    }
  });

  initSupabase();
});
