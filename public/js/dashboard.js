const visitorsList = document.getElementById('visitorsList');
const visitorInfo = document.getElementById('visitorInfo');
const adminMessages = document.getElementById('adminMessages');
const replyForm = document.getElementById('replyForm');
const replyInput = document.getElementById('replyInput');
const searchVisitor = document.getElementById('searchVisitor');
const notifyBtn = document.getElementById('notifyBtn');
const typing = typingIndicator(document.getElementById('typing'));

let room = null; // { slug, ownerName, ownerKey }
let visitors = [];
let selectedId = null;
let socket = null;
let titleBase = document.title;
let refreshTimer = null;
let lastUnread = null; // visitorId -> unread count from the previous refresh

const ownerApi = (path, options = {}) =>
    api(`/owner${path}`, { ...options, headers: { Authorization: `Bearer ${room.ownerKey}` } });

const aliasText = (a) => `${a.name} (${a.relation})`;

// ============================================
// START
// ============================================

// Save a room from its secret owner key, after checking the key with the server.
async function addRoomByKey(ownerKey) {
    const info = await api('/owner/room', { headers: { Authorization: `Bearer ${ownerKey}` } });
    const saved = { slug: info.slug, ownerName: info.ownerName, ownerKey };
    myRooms.save(saved);
    return saved;
}

async function init() {
    // Opened via the secret owner link: /dashboard#key=...
    const hashKey = (location.hash.match(/key=([A-Za-z0-9_-]+)/) || [])[1];
    if (hashKey) {
        try {
            const saved = await addRoomByKey(hashKey);
            history.replaceState(null, '', `/dashboard?room=${encodeURIComponent(saved.slug)}`);
        } catch (e) {
            history.replaceState(null, '', '/dashboard');
            toast('❌ Yeh owner link ghalat hai');
        }
    }

    const wanted = new URLSearchParams(location.search).get('room');
    room = (wanted && myRooms.find(wanted)) || myRooms.all()[0];
    if (!room) {
        showScreen('noRoomScreen');
        return;
    }

    try {
        Object.assign(room, await ownerApi('/room'));
    } catch (error) {
        toast(`❌ ${error.message}`);
        showScreen('noRoomScreen');
        return;
    }

    titleBase = `Dashboard · ${room.ownerName}`;
    document.title = titleBase;
    document.getElementById('dashboardTitle').textContent = `👑 ${room.ownerName}`;
    setupRoomSelect();
    setupSharePanel();
    setupPanels();
    fillSettings();
    showEmptySelection();
    showScreen('dashboardScreen');

    await refresh();
    const wantedVisitor = new URLSearchParams(location.search).get('v');
    if (wantedVisitor && visitors.some((v) => v._id === wantedVisitor)) selectVisitor(wantedVisitor);

    // Every (re)connect reloads everything, so nothing is missed while offline.
    socket = connectSocket({ role: 'owner', key: room.ownerKey }, {
        connect: refresh,
        'visitor:changed': scheduleRefresh,
        presence: ({ visitorId, online }) => {
            const v = visitors.find((x) => x._id === visitorId);
            if (!v) return;
            v.online = online;
            renderVisitors();
            if (visitorId === selectedId) renderVisitorInfo();
        },
        typing: ({ visitorId }) => {
            if (visitorId === selectedId) typing.show();
        },
        connect_error: (error) => {
            if (error.message === 'unauthorized') toast('❌ Owner key ab valid nahi hai');
        },
    });
    setupNotifications();
    setupInstall();
}

// Several changes can arrive at once (message + seen + presence); batch them.
function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 150);
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && room && socket) refresh();
});

document.getElementById('keyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = document.getElementById('keyInput').value.trim();
    const key = (value.match(/key=([A-Za-z0-9_-]+)/) || [])[1] || value;
    try {
        const saved = await addRoomByKey(key);
        location.href = `/dashboard?room=${encodeURIComponent(saved.slug)}`;
    } catch (error) {
        alert(error.message);
    }
});

function setupRoomSelect() {
    const rooms = myRooms.all();
    if (rooms.length < 2) return;
    const select = document.getElementById('roomSelect');
    select.append(...rooms.map((r) => el('option', { value: r.slug, selected: r.slug === room.slug }, `${r.ownerName} · ${r.slug}`)));
    select.hidden = false;
    select.addEventListener('change', () => {
        location.href = `/dashboard?room=${encodeURIComponent(select.value)}`;
    });
}

function setupSharePanel() {
    const panel = document.getElementById('sharePanel');
    const link = chatLink(room.slug);
    const prompt = room.prompt || 'Mujhse anonymously baat karo 👀';
    panel.replaceChildren(
        el('code', {}, link),
        storyCardButton({ ownerName: room.ownerName, prompt, link }),
        shareButtons(link, prompt),
        el('button', {
            className: 'text-link',
            onclick: async () => {
                try {
                    await navigator.clipboard.writeText(ownerLink(room));
                    toast('✅ Secret owner link copy ho gaya');
                } catch (e) {
                    window.prompt('Secret owner link:', ownerLink(room));
                }
            },
        }, '🔑 Secret owner link copy karein (dusre phone ke liye)'),
    );
}

// Share / Stats / Settings panels under the header: one open at a time.
function setupPanels() {
    document.querySelectorAll('.panel-toggle').forEach((button) => {
        button.addEventListener('click', () => {
            const target = document.getElementById(button.dataset.panel);
            const opening = target.hidden;
            document.querySelectorAll('.panel').forEach((p) => { p.hidden = true; });
            document.querySelectorAll('.panel-toggle').forEach((b) => b.classList.remove('on'));
            target.hidden = !opening;
            button.classList.toggle('on', opening);
            if (opening && target.id === 'statsPanel') loadStats();
            if (opening && target.id === 'settingsPanel') fillSettings();
        });
    });
}

// ============================================
// VISITORS
// ============================================

async function refresh() {
    try {
        visitors = await ownerApi('/visitors');
        notifyNewMessages();
        renderVisitors();
        if (selectedId) {
            renderVisitorInfo();
            await loadMessages();
        }
    } catch (error) {
        if (error.status === 401) {
            if (socket) socket.disconnect();
            toast('❌ Owner key ab valid nahi hai');
        }
    }
}

function renderVisitors() {
    const term = searchVisitor.value.trim().toLowerCase();
    const shown = visitors.filter((v) => !term || v.aliases.some((a) => aliasText(a).toLowerCase().includes(term)));

    document.getElementById('totalVisitors').textContent = `${visitors.length} visitors`;
    document.getElementById('visitorCount').textContent = visitors.length;

    const totalUnread = visitors.reduce((sum, v) => sum + v.unread, 0);
    setUnreadTitle(titleBase, totalUnread);

    const signature = JSON.stringify([term, selectedId, shown.map((v) => [v._id, v.name, v.relation, v.messageCount, v.unread, v.online, v.blocked, v.aliases.length, v.links.length])]);
    if (visitorsList.dataset.signature === signature) return;
    visitorsList.dataset.signature = signature;

    if (shown.length === 0) {
        visitorsList.replaceChildren(el('div', { className: 'empty-state small' },
            el('div', { className: 'empty-icon' }, '👤'),
            el('p', {}, visitors.length ? 'Koi visitor nahi mila' : 'Abhi tak koi nahi aaya. Apna link share karein!')));
        return;
    }

    visitorsList.replaceChildren(...shown.map((v) => el('div', {
        className: `user-item ${v._id === selectedId ? 'active' : ''} ${v.unread ? 'unread' : ''}`,
        onclick: () => selectVisitor(v._id),
    },
        el('div', { className: 'user-info' },
            el('div', { className: 'user-name' }, v.name),
            el('div', { className: 'user-relation' }, v.relation),
            el('div', { className: 'identity-badges' },
                v.aliases.length > 1 && el('span', { className: 'badge alias', title: 'Is device se kai naam use hue' }, `🔄 ${v.aliases.length} naam`),
                v.links.length > 0 && el('span', { className: 'badge link', title: 'Shayad kisi aur visitor jaisa hai' }, '🔗 match'),
                v.blocked && el('span', { className: 'badge blocked', title: 'Blocked' }, '🚫 blocked'))),
        el('div', { className: 'user-meta' },
            el('span', { className: `user-status ${v.online ? 'online' : 'offline'}`, title: v.online ? 'Online' : 'Offline' }),
            v.unread
                ? el('span', { className: 'user-badge unread', title: 'Naye messages' }, v.unread)
                : el('span', { className: 'user-badge', title: 'Total messages' }, v.messageCount)),
    )));
}

searchVisitor.addEventListener('input', renderVisitors);

function selectVisitor(id) {
    selectedId = id;
    typing.hide();
    delete adminMessages.dataset.signature;
    delete visitorInfo.dataset.signature;
    replyInput.disabled = false;
    replyForm.querySelector('button').disabled = false;
    renderVisitors();
    renderVisitorInfo();
    loadMessages();
    replyInput.focus();
}

function showEmptySelection() {
    visitorInfo.replaceChildren(el('div', { className: 'no-user-selected' },
        el('div', { className: 'no-user-icon' }, '💬'),
        el('h3', {}, 'Kisi visitor ko select karein'),
        el('p', {}, 'Visitors ki list mein se chunein')));
    adminMessages.replaceChildren();
}

// The "detector": every name this device used, plus other visitors that
// look like the same person on another browser/device.
function renderVisitorInfo() {
    const v = visitors.find((x) => x._id === selectedId);
    if (!v) return;

    const signature = JSON.stringify(v);
    if (visitorInfo.dataset.signature === signature) return;
    visitorInfo.dataset.signature = signature;

    const reasonText = {
        'fingerprint+ip': 'same device + same internet',
        fingerprint: 'same device type, network alag',
    };

    visitorInfo.replaceChildren(el('div', { className: 'selected-user-detail' },
        el('div', { className: 'user-main' },
            el('div', { className: 'user-avatar' }, v.name.charAt(0).toUpperCase()),
            el('div', {},
                el('div', { className: 'user-name-display' }, v.name),
                el('div', { className: 'user-relation-display' },
                    v.relation,
                    el('span', { className: 'presence dark' }, v.online ? ' · 🟢 online' : '')),
                v.aliases.length > 1 && el('div', { className: 'identity-line' },
                    '🔄 Is device se naam: ',
                    v.aliases.map((a, i) => [
                        i > 0 && ' → ',
                        i === v.aliases.length - 1 ? el('strong', {}, aliasText(a)) : aliasText(a),
                    ])),
                v.links.map((l) => el('div', { className: `identity-line warn ${l.reason === 'fingerprint+ip' ? 'strong' : ''}` },
                    l.reason === 'fingerprint+ip' ? '⚠️ Shayad yahi banda hai: ' : '🤔 Ho sakta hai yeh bhi ho: ',
                    el('button', { className: 'inline-link', onclick: () => selectVisitor(l._id) }, aliasText(l)),
                    ` (${reasonText[l.reason]})`)),
            )),
        el('div', { className: 'visitor-actions' },
            el('div', { className: 'user-msg-count' }, `${v.messageCount} messages`),
            el('button', {
                className: `btn-block ${v.blocked ? 'unblock' : ''}`,
                onclick: () => toggleBlock(v),
            }, v.blocked ? '✅ Unblock' : '🚫 Block')),
    ));
}

async function toggleBlock(v) {
    const blocking = !v.blocked;
    if (blocking && !confirm(`"${v.name}" ko block karein? Yeh is device se (incognito mein bhi) message nahi bhej sakega.`)) return;
    try {
        await ownerApi(`/visitors/${v._id}/block`, { method: 'POST', body: { blocked: blocking } });
        toast(blocking ? '🚫 Visitor block ho gaya' : '✅ Visitor unblock ho gaya');
        refresh();
    } catch (error) {
        alert(error.message);
    }
}

// ============================================
// MESSAGES
// ============================================

async function loadMessages() {
    const id = selectedId;
    const messages = await ownerApi(`/visitors/${id}/messages`);
    if (id !== selectedId) return; // user switched visitor meanwhile
    if (messages.some((m) => !m.fromOwner)) typing.hide();
    renderMessageList(adminMessages, messages, {
        isMine: (m) => m.fromOwner,
        senderLabel: (m) => (m.fromOwner ? 'Aap' : m.aliasName),
        divider: (m, prev) => {
            const now = `${m.aliasName}|${m.aliasRelation}`;
            return prev && now !== `${prev.aliasName}|${prev.aliasRelation}`
                ? `🔄 Naya naam rakha: ${m.aliasName} (${m.aliasRelation})`
                : null;
        },
        actions: (m) => [
            m.fromOwner && el('button', { title: 'Edit', onclick: () => editMessage(m) }, '✏️'),
            el('button', { title: 'Delete', onclick: () => deleteMessage(m) }, '🗑️'),
        ],
        emptyText: 'Is visitor ne abhi koi message nahi bheja',
    });

    // Looking at this chat: mark the visitor's messages seen (✓✓ for them).
    const unseen = messages.some((m) => !m.fromOwner && !m.seenAt);
    if (unseen && document.visibilityState === 'visible' && socket) socket.emit('seen', { visitorId: id });
}

replyInput.addEventListener('input', typingEmitter(() => {
    if (socket && selectedId) socket.emit('typing', { visitorId: selectedId });
}));

replyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = replyInput.value.trim();
    if (!text || !selectedId) return;
    replyInput.value = '';
    try {
        await ownerApi(`/visitors/${selectedId}/messages`, { method: 'POST', body: { text } });
        await loadMessages();
        adminMessages.scrollTop = adminMessages.scrollHeight;
    } catch (error) {
        replyInput.value = text;
        alert(error.message);
    }
});

async function editMessage(message) {
    const text = window.prompt('Message edit karein:', message.text);
    if (!text || !text.trim() || text.trim() === message.text) return;
    try {
        await ownerApi(`/messages/${message._id}`, { method: 'PUT', body: { text: text.trim() } });
        loadMessages();
    } catch (error) {
        alert(error.message);
    }
}

async function deleteMessage(message) {
    if (!confirm('Yeh message delete karein?')) return;
    try {
        await ownerApi(`/messages/${message._id}`, { method: 'DELETE' });
        refresh();
    } catch (error) {
        alert(error.message);
    }
}

init();

// ============================================
// NOTIFICATIONS
// ============================================
// Closed dashboard: the server sends a Web Push notification (sw.js shows it).
// Open but hidden dashboard: the server skips push, so we show one here.

let swRegistration = null;

function notifyNewMessages() {
    const current = new Map(visitors.map((v) => [v._id, v.unread]));
    const previous = lastUnread;
    lastUnread = current;
    if (!previous || document.visibilityState === 'visible') return;
    if (!swRegistration || Notification.permission !== 'granted') return;

    for (const v of visitors) {
        if (v.unread > (previous.get(v._id) || 0)) {
            swRegistration.showNotification(`💬 ${v.name} (${v.relation})`, {
                body: `${v.unread} naya message`,
                tag: v._id,
                renotify: true,
                data: { url: `/dashboard?room=${encodeURIComponent(room.slug)}&v=${v._id}` },
            });
        }
    }
}

function base64ToBytes(base64) {
    const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

const pushKey = () => `push:${room.slug}`;

function setNotifyButton(on) {
    notifyBtn.textContent = on ? '🔔 On' : '🔕 Notifications';
    notifyBtn.title = on ? 'Notifications band karein' : 'Naye message par notification paayein';
    notifyBtn.classList.toggle('on', on);
}

async function subscribePush() {
    const { publicKey } = await api('/push/key');
    let subscription = await swRegistration.pushManager.getSubscription();
    // Server keys changed (e.g. VAPID keys were set later): the old subscription is useless.
    if (subscription && store.get('pushServerKey') !== publicKey) {
        await subscription.unsubscribe();
        subscription = null;
    }
    if (!subscription) {
        subscription = await swRegistration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: base64ToBytes(publicKey),
        });
    }
    store.set('pushServerKey', publicKey);
    await ownerApi('/push/subscribe', { method: 'POST', body: { subscription: subscription.toJSON() } });
    store.set(pushKey(), true);
}

async function setupNotifications() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
    try {
        swRegistration = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
    } catch (e) {
        return;
    }
    notifyBtn.hidden = false;

    const enabled = store.get(pushKey()) && Notification.permission === 'granted';
    setNotifyButton(enabled);
    if (enabled) subscribePush().catch(() => setNotifyButton(false)); // re-register with the server

    notifyBtn.addEventListener('click', async () => {
        notifyBtn.disabled = true;
        try {
            if (notifyBtn.classList.contains('on')) {
                const subscription = await swRegistration.pushManager.getSubscription();
                if (subscription) await ownerApi('/push/unsubscribe', { method: 'POST', body: { endpoint: subscription.endpoint } });
                store.remove(pushKey());
                setNotifyButton(false);
                toast('🔕 Notifications band');
            } else {
                const permission = await Notification.requestPermission();
                if (permission !== 'granted') {
                    toast('Browser settings mein notifications allow karein');
                    return;
                }
                await subscribePush();
                setNotifyButton(true);
                toast('🔔 Naye message par notification aayega');
            }
        } catch (error) {
            alert(error.message || 'Notifications on nahi ho sakin');
        } finally {
            notifyBtn.disabled = false;
        }
    });
}

// A notification was clicked while a dashboard was already open (see sw.js).
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
        if (!event.data || event.data.type !== 'open') return;
        const url = new URL(event.data.url, location.origin);
        if (url.searchParams.get('room') !== (room && room.slug)) {
            location.href = url.href;
            return;
        }
        const visitorId = url.searchParams.get('v');
        if (visitors.some((v) => v._id === visitorId)) selectVisitor(visitorId);
    });
}

// ============================================
// SETTINGS
// ============================================

function applyRoomHeader() {
    document.getElementById('dashboardTitle').textContent = `👑 ${room.ownerName}${room.isOpen ? '' : ' · 🔒 band'}`;
}

function fillSettings() {
    document.getElementById('settingPrompt').value = room.prompt || '';
    document.getElementById('settingRelations').value = (room.relations || []).join('\n');
    document.getElementById('settingOpen').checked = room.isOpen;
    document.getElementById('settingFilter').checked = room.filterProfanity;
    applyRoomHeader();
}

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = e.target.querySelector('button');
    button.disabled = true;
    try {
        const saved = await ownerApi('/room', {
            method: 'PATCH',
            body: {
                prompt: document.getElementById('settingPrompt').value.trim(),
                relations: document.getElementById('settingRelations').value.split('\n').map((r) => r.trim()).filter(Boolean),
                isOpen: document.getElementById('settingOpen').checked,
                filterProfanity: document.getElementById('settingFilter').checked,
            },
        });
        Object.assign(room, saved);
        fillSettings();
        setupSharePanel(); // the story card / share text use the prompt
        delete adminMessages.dataset.signature; // filter setting changes how messages look
        if (selectedId) loadMessages();
        toast('✅ Settings save ho gayin');
    } catch (error) {
        alert(error.message);
    } finally {
        button.disabled = false;
    }
});

// ============================================
// STATS
// ============================================

function utcOffset() {
    const minutes = -new Date().getTimezoneOffset();
    const sign = minutes >= 0 ? '+' : '-';
    const abs = Math.abs(minutes);
    return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function localDateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Horizontal bars, one per row, with the value printed beside each bar.
function barList(rows) {
    const max = Math.max(1, ...rows.map((r) => r.value));
    return el('div', { className: 'bar-list' }, rows.map((r) => el('div', { className: 'bar-row', title: `${r.label}: ${r.value}` },
        el('span', { className: 'bar-label' }, r.label),
        el('span', { className: 'bar-track' }, el('span', { className: 'bar-fill', style: `width: ${(r.value / max) * 100}%` })),
        el('span', { className: 'bar-value' }, r.value))));
}

// Vertical columns for the last 7 days.
function dayColumns(days) {
    const max = Math.max(1, ...days.map((d) => d.value));
    return el('div', { className: 'day-columns' }, days.map((d) => el('div', { className: 'day-col', title: `${d.title}: ${d.value} messages` },
        el('span', { className: 'day-value' }, d.value || ''),
        el('span', { className: 'day-bar-track' }, el('span', { className: 'day-bar', style: `height: ${(d.value / max) * 100}%` })),
        el('span', { className: 'day-label' }, d.label))));
}

function statTile(value, label, hint) {
    return el('div', { className: 'stat-tile', title: hint || '' },
        el('div', { className: 'stat-value' }, value),
        el('div', { className: 'stat-label' }, label));
}

async function loadStats() {
    const panel = document.getElementById('statsPanel');
    panel.replaceChildren(el('p', { className: 'muted' }, 'Loading…'));
    try {
        const stats = await ownerApi(`/stats?tz=${encodeURIComponent(utcOffset())}`);
        const conversion = stats.views ? Math.round((stats.visitors / stats.views) * 100) : 0;

        const counts = new Map(stats.perDay.map((d) => [d.date, d.count]));
        const days = [];
        for (let i = 6; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            days.push({
                value: counts.get(localDateKey(date)) || 0,
                label: i === 0 ? 'Aaj' : date.toLocaleDateString([], { weekday: 'short' }),
                title: date.toLocaleDateString([], { day: 'numeric', month: 'short' }),
            });
        }

        panel.replaceChildren(
            el('div', { className: 'stat-tiles' },
                statTile(stats.views, 'Link khula', 'Kitni baar aapka link khola gaya (har browser session mein ek baar)'),
                statTile(stats.visitors, 'Visitors', `Jinhon ne naam likh kar chat shuru ki (${conversion}% conversion)`),
                statTile(stats.people, 'Asli log (andaza)', 'Same device + same internet wale visitors ko ek banda gina'),
                statTile(stats.nameChangers, 'Naam badla', 'Jinhon ne doosre naam se dobara chat ki'),
                statTile(stats.received, 'Messages aaye'),
                statTile(stats.replies, 'Aapke replies'),
                statTile(stats.blocked, 'Blocked')),
            el('div', { className: 'stat-charts' },
                el('div', { className: 'stat-chart' },
                    el('h4', {}, 'Pichle 7 din: messages aaye'),
                    dayColumns(days)),
                el('div', { className: 'stat-chart' },
                    el('h4', {}, 'Visitors: relation ke hisaab se'),
                    stats.byRelation.length
                        ? barList(stats.byRelation.map((r) => ({ label: r.relation, value: r.count })))
                        : el('p', { className: 'muted' }, 'Abhi koi visitor nahi'))),
        );
    } catch (error) {
        panel.replaceChildren(el('p', { className: 'muted' }, error.message));
    }
}

// ============================================
// INSTALL (PWA)
// ============================================

function setupInstall() {
    const button = document.getElementById('installBtn');
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (standalone) return;

    let installEvent = null;
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        installEvent = e;
        button.hidden = false;
    });

    // iPhone/iPad have no install prompt: explain "Add to Home Screen" instead.
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (ios) button.hidden = false;

    button.addEventListener('click', async () => {
        if (installEvent) {
            installEvent.prompt();
            const { outcome } = await installEvent.userChoice;
            if (outcome === 'accepted') button.hidden = true;
            installEvent = null;
        } else if (ios) {
            alert('Safari mein neeche Share button (⬆️) dabayein, phir "Add to Home Screen" chunein. Install ke baad notifications bhi on ho sakti hain.');
        }
    });
    window.addEventListener('appinstalled', () => { button.hidden = true; });
}
