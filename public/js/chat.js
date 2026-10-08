const slug = decodeURIComponent(location.pathname.split('/')[2] || '');
const joinedKey = `joined:${slug}`;

const joinForm = document.getElementById('joinForm');
const nameInput = document.getElementById('visitorName');
const relationInput = document.getElementById('visitorRelation');
const messagesContainer = document.getElementById('messagesContainer');
const sendForm = document.getElementById('sendForm');
const messageInput = document.getElementById('messageInput');
const ownerStatus = document.getElementById('ownerStatus');
const closedBanner = document.getElementById('closedBanner');
const typing = typingIndicator(document.getElementById('typing'));

let room = null;
let deviceId = null;
let socket = null;
let titleBase = document.title;

const roomPath = `/rooms/${encodeURIComponent(slug)}`;
const visitorApi = (path, options = {}) =>
    api(`${roomPath}${path}`, { ...options, headers: { 'X-Device-Id': deviceId } });

const UNAVAILABLE = {
    blocked: ['🚫 Chat not available', 'This chat is no longer available to you.'],
    closed: ['🔒 This room is closed', 'The owner isn\'t accepting new messages right now. Please try again later.'],
};

function showUnavailable(code) {
    const [title, text] = UNAVAILABLE[code] || UNAVAILABLE.closed;
    document.getElementById('infoTitle').textContent = title;
    document.getElementById('infoText').textContent = text;
    if (code === 'blocked' && socket) {
        socket.disconnect();
        socket = null;
    }
    showScreen('infoScreen');
}

// Fill the page from the room's public info (also after the owner edits it).
function applyRoom() {
    titleBase = `Chat with ${room.ownerName}`;
    document.title = titleBase;
    document.getElementById('joinTitle').textContent = `💬 ${room.ownerName}`;
    document.getElementById('joinPrompt').textContent = room.prompt;
    document.getElementById('chatTitle').textContent = `💬 ${room.ownerName}`;

    const selected = relationInput.value;
    relationInput.replaceChildren(
        el('option', { value: '' }, 'How do you know them?'),
        ...room.relations.map((r) => el('option', { value: r, selected: r === selected }, r)),
    );

    // A closed room keeps existing chats readable but stops new messages.
    closedBanner.hidden = room.isOpen;
    messageInput.disabled = !room.isOpen;
    sendForm.querySelector('button').disabled = !room.isOpen;
}

async function reloadRoom() {
    room = await api(roomPath);
    applyRoom();
    if (!room.isOpen && document.getElementById('joinScreen').classList.contains('active')) showUnavailable('closed');
    if (room.isOpen && document.getElementById('infoScreen').classList.contains('active')
        && document.getElementById('infoTitle').textContent === UNAVAILABLE.closed[0]) {
        showScreen('joinScreen');
    }
}

// Count one "link opened" per browser session, but not the owner's own visits.
function countView() {
    const key = `viewed:${slug}`;
    try {
        if (myRooms.find(slug) || sessionStorage.getItem(key)) return;
        sessionStorage.setItem(key, '1');
    } catch (e) {
        return;
    }
    fetch(`/api${roomPath}/view`, { method: 'POST' }).catch(() => {});
}

// ============================================
// START
// ============================================

async function init() {
    try {
        room = await api(roomPath);
    } catch (error) {
        showScreen('notFoundScreen');
        return;
    }
    applyRoom();
    countView();

    if (myRooms.find(slug)) {
        const banner = document.getElementById('ownRoomBanner');
        banner.href = `/dashboard?room=${encodeURIComponent(slug)}`;
        banner.hidden = false;
    }

    deviceId = await getDeviceId();

    // Returning visitor who didn't press Exit: continue the same chat.
    if (store.get(joinedKey)) {
        try {
            const me = await visitorApi('/me');
            nameInput.value = me.name;
            relationInput.value = me.relation;
            openChat();
            return;
        } catch (error) {
            if (error.code === 'blocked') return showUnavailable('blocked');
            store.remove(joinedKey);
        }
    }
    if (!room.isOpen) return showUnavailable('closed');
    showScreen('joinScreen');
}

joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = joinForm.querySelector('button');
    button.disabled = true;
    try {
        await api(`${roomPath}/join`, {
            method: 'POST',
            body: {
                name: nameInput.value,
                relation: relationInput.value,
                deviceId,
                fp: await getFingerprint(),
            },
        });
        store.set(joinedKey, true);
        openChat();
    } catch (error) {
        if (error.code) showUnavailable(error.code);
        else alert(error.message);
    } finally {
        button.disabled = false;
    }
});

// ============================================
// CHAT
// ============================================

// The server refused or dropped our socket: find out why.
async function checkAccess() {
    try {
        await visitorApi('/me');
    } catch (error) {
        if (error.code === 'blocked') showUnavailable('blocked');
        else if (error.status === 401) exitChat();
    }
}

function openChat() {
    showScreen('chatScreen');
    delete messagesContainer.dataset.signature;
    ownerStatus.textContent = '';
    if (socket) socket.disconnect();
    // Every (re)connect reloads the chat, so nothing is missed while offline.
    socket = connectSocket({ role: 'visitor', slug, deviceId }, {
        connect: loadMessages,
        'messages:changed': loadMessages,
        'room:changed': () => reloadRoom().catch(() => {}),
        'owner:presence': ({ online }) => {
            ownerStatus.textContent = online ? '🟢 online' : '';
        },
        typing: () => typing.show(),
        connect_error: (error) => {
            if (error.message === 'unauthorized') checkAccess();
        },
        disconnect: (reason) => {
            if (reason === 'io server disconnect') checkAccess();
        },
    });
    if (room.isOpen) messageInput.focus();
}

async function loadMessages() {
    try {
        const messages = await visitorApi('/messages');
        if (messages.some((m) => m.fromOwner)) typing.hide();
        renderMessageList(messagesContainer, messages, {
            isMine: (m) => !m.fromOwner,
            senderLabel: (m) => (m.fromOwner ? `👑 ${room.ownerName}` : 'You'),
            actions: (m) => [!m.fromOwner && el('button', {
                title: 'Edit message',
                onclick: () => editMessage(m),
            }, '✏️')],
            emptyText: `Send ${room.ownerName} your first message!`,
        });
        markSeen(messages);
    } catch (error) {
        if (error.code === 'blocked') showUnavailable('blocked');
        else if (error.status === 401) exitChat();
    }
}

// Tell the server the owner's replies were seen, if this tab is visible.
// While hidden, unseen replies are counted in the tab title instead.
function markSeen(messages) {
    const unseen = messages.filter((m) => m.fromOwner && !m.seenAt).length;
    if (unseen && document.visibilityState === 'visible' && socket) socket.emit('seen');
    setUnreadTitle(titleBase, document.visibilityState === 'visible' ? 0 : unseen);
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && socket && socket.connected) loadMessages();
});

messageInput.addEventListener('input', typingEmitter(() => socket && socket.emit('typing')));

sendForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = messageInput.value.trim();
    if (!text) return;
    messageInput.value = '';
    try {
        await visitorApi('/messages', { method: 'POST', body: { text } });
        await loadMessages();
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    } catch (error) {
        messageInput.value = text;
        if (error.code === 'blocked') showUnavailable('blocked');
        else if (error.code === 'closed') reloadRoom().catch(() => {});
        else alert(error.message);
    }
});

async function editMessage(message) {
    const text = window.prompt('Edit message:', message.text);
    if (!text || !text.trim() || text.trim() === message.text) return;
    try {
        await visitorApi(`/messages/${message._id}`, { method: 'PUT', body: { text: text.trim() } });
        loadMessages();
    } catch (error) {
        alert(error.message);
    }
}

// Exit only forgets the name on this screen; the device ID stays.
function exitChat() {
    if (socket) socket.disconnect();
    socket = null;
    typing.hide();
    setUnreadTitle(titleBase, 0);
    store.remove(joinedKey);
    nameInput.value = '';
    relationInput.value = '';
    if (room.isOpen) showScreen('joinScreen');
    else showUnavailable('closed');
}

document.getElementById('exitBtn').addEventListener('click', exitChat);

init();
