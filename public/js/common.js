// Shared helpers for every page. Loaded before the page script.

// ============================================
// API
// ============================================

async function api(path, { method = 'GET', body, headers = {} } = {}) {
    const options = { method, headers: { ...headers } };
    if (body !== undefined) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }
    const response = await fetch(`/api${path}`, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error || 'Connection error. Dobara try karein.');
        error.status = response.status;
        error.code = data.code; // e.g. 'blocked', 'closed'
        throw error;
    }
    return data;
}

// ============================================
// DOM
// ============================================

// Build an element without innerHTML, so user text can never become HTML.
// el('div', { className: 'x', onclick: fn }, 'text', childNode, ...)
function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else node[key] = value;
    }
    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false) continue;
        node.append(child instanceof Node ? child : String(child));
    }
    return node;
}

function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
}

function toast(text) {
    const node = el('div', { className: 'toast' }, text);
    document.body.append(node);
    setTimeout(() => node.remove(), 2500);
}

function formatTime(date) {
    const d = new Date(date);
    const today = new Date().toDateString() === d.toDateString();
    return today
        ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function isNearBottom(container) {
    return container.scrollHeight - container.scrollTop - container.clientHeight < 80;
}

// ============================================
// STORAGE
// ============================================

const store = {
    get(key, fallback = null) {
        try {
            const value = localStorage.getItem(key);
            return value === null ? fallback : JSON.parse(value);
        } catch (e) {
            return fallback;
        }
    },
    set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage blocked */ }
    },
    remove(key) {
        try { localStorage.removeItem(key); } catch (e) { /* storage blocked */ }
    },
};

// Rooms this browser owns: [{ slug, ownerName, ownerKey }]
const myRooms = {
    all: () => store.get('myRooms', []),
    find: (slug) => myRooms.all().find((r) => r.slug === slug),
    save(room) {
        const rooms = myRooms.all().filter((r) => r.slug !== room.slug);
        rooms.unshift(room);
        store.set('myRooms', rooms);
    },
};

function ownerLink(room) {
    return `${location.origin}/dashboard#key=${room.ownerKey}`;
}

function chatLink(slug) {
    return `${location.origin}/c/${slug}`;
}

// ============================================
// SHARING
// ============================================

function shareButtons(link, text) {
    const message = `${text}\n${link}`;
    const open = (url) => () => window.open(url, '_blank', 'noopener');
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(link);
            toast('✅ Link copy ho gaya');
        } catch (e) {
            window.prompt('Yeh link copy karein:', link);
        }
    };

    return el('div', { className: 'share-buttons' },
        navigator.share && el('button', {
            className: 'share-btn native',
            onclick: () => navigator.share({ text, url: link }).catch(() => {}),
        }, '📤 Share (Status / Story)'),
        el('button', { className: 'share-btn whatsapp', onclick: open(`https://wa.me/?text=${encodeURIComponent(message)}`) }, 'WhatsApp'),
        el('button', { className: 'share-btn facebook', onclick: open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(link)}`) }, 'Facebook'),
        el('button', { className: 'share-btn twitter', onclick: open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(message)}`) }, 'X / Twitter'),
        el('button', {
            className: 'share-btn instagram',
            onclick: async () => {
                await copy();
                toast('Instagram story mein "Link" sticker laga kar paste karein');
            },
        }, 'Instagram'),
        el('button', { className: 'share-btn copy', onclick: copy }, '🔗 Copy link'),
    );
}

// ============================================
// VISITOR IDENTITY
// ============================================
// A random device ID kept in three places (localStorage, cookie, IndexedDB)
// so clearing just one of them doesn't make the visitor look new.

function idb(mode, fn) {
    return new Promise((resolve) => {
        try {
            const open = indexedDB.open('chat-identity', 1);
            open.onupgradeneeded = () => open.result.createObjectStore('kv');
            open.onerror = () => resolve(null);
            open.onsuccess = () => {
                const tx = open.result.transaction('kv', mode);
                const req = fn(tx.objectStore('kv'));
                tx.oncomplete = () => resolve(req.result ?? null);
                tx.onerror = () => resolve(null);
            };
        } catch (e) {
            resolve(null);
        }
    });
}

async function getDeviceId() {
    const valid = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{32,64}$/.test(v);
    const fromCookie = (document.cookie.match(/(?:^|; )did=([^;]+)/) || [])[1];
    const fromIdb = await idb('readonly', (s) => s.get('did'));

    let id = [store.get('did'), fromCookie, fromIdb].find(valid);
    if (!id) {
        const bytes = crypto.getRandomValues(new Uint8Array(24));
        id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    store.set('did', id);
    document.cookie = `did=${id}; max-age=${60 * 60 * 24 * 730}; path=/; SameSite=Lax`;
    await idb('readwrite', (s) => s.put(id, 'did'));
    return id;
}

// Hash of stable browser/device traits. It survives clearing storage and
// incognito mode, but phones of the same model can collide, so the server
// treats a match as "possibly the same person", never as proof.
async function getFingerprint() {
    if (!crypto.subtle) return ''; // only available on https / localhost
    try {
        const canvas = document.createElement('canvas');
        canvas.width = 220;
        canvas.height = 40;
        const ctx = canvas.getContext('2d');
        ctx.textBaseline = 'top';
        ctx.font = '16px Arial';
        ctx.fillStyle = '#f60';
        ctx.fillRect(100, 1, 60, 20);
        ctx.fillStyle = '#069';
        ctx.fillText('anon-chat 👀 ŞĞ', 2, 15);

        let gpu = '';
        const gl = document.createElement('canvas').getContext('webgl');
        const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
        if (info) gpu = gl.getParameter(info.UNMASKED_RENDERER_WEBGL);

        const parts = [
            navigator.userAgent.replace(/\d+(\.\d+)*/g, ''), // ignore browser version updates
            navigator.language,
            (navigator.languages || []).join(','),
            navigator.platform,
            navigator.hardwareConcurrency,
            navigator.deviceMemory,
            navigator.maxTouchPoints,
            [screen.width, screen.height].sort((a, b) => a - b).join('x'),
            screen.colorDepth,
            window.devicePixelRatio,
            Intl.DateTimeFormat().resolvedOptions().timeZone,
            canvas.toDataURL(),
            gpu,
        ];
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('|')));
        return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
        return '';
    }
}

// ============================================
// MESSAGES
// ============================================

// Render a message list. Only redraws when something actually changed, so
// polling doesn't make the list flicker or lose the scroll position.
function renderMessageList(container, messages, { isMine, senderLabel, actions, divider, emptyText }) {
    const signature = JSON.stringify(messages.map((m) => [m._id, m.text, m.editedAt, m.seenAt]));
    if (container.dataset.signature === signature) return;
    const firstRender = !container.dataset.signature;
    const stickToBottom = firstRender || isNearBottom(container);
    container.dataset.signature = signature;

    container.replaceChildren();
    if (messages.length === 0) {
        container.append(el('div', { className: 'empty-state' },
            el('div', { className: 'empty-icon' }, '💬'),
            el('p', {}, emptyText)));
        return;
    }

    messages.forEach((msg, i) => {
        const dividerText = divider && divider(msg, messages[i - 1]);
        if (dividerText) container.append(el('div', { className: 'alias-divider' }, dividerText));

        const mine = isMine(msg);
        const buttons = actions ? actions(msg).filter(Boolean) : [];
        container.append(el('div', { className: `message ${mine ? 'mine' : 'theirs'}` },
            el('span', { className: 'sender' }, senderLabel(msg)),
            el('div', { className: 'text' }, msg.text),
            el('span', { className: 'time' },
                formatTime(msg.createdAt),
                msg.editedAt ? ' · edited' : '',
                mine && el('span', { className: `ticks ${msg.seenAt ? 'seen' : ''}`, title: msg.seenAt ? 'Dekh liya' : 'Bhej diya' }, msg.seenAt ? ' ✓✓' : ' ✓')),
            buttons.length > 0 && el('div', { className: 'actions' }, buttons),
        ));
    });

    if (stickToBottom) container.scrollTop = container.scrollHeight;
}

// ============================================
// REAL-TIME
// ============================================

// Socket.IO connection; `io` comes from /socket.io/socket.io.js.
function connectSocket(auth, handlers) {
    const socket = io({ auth });
    for (const [event, handler] of Object.entries(handlers)) socket.on(event, handler);
    return socket;
}

// "typing…" bubble that hides itself if no new typing event arrives.
function typingIndicator(node) {
    let timer = null;
    return {
        show() {
            node.hidden = false;
            clearTimeout(timer);
            timer = setTimeout(() => { node.hidden = true; }, 3000);
        },
        hide() {
            clearTimeout(timer);
            node.hidden = true;
        },
    };
}

// Call on every keystroke; emits at most once every 1.5 seconds.
function typingEmitter(emit) {
    let last = 0;
    return () => {
        const now = Date.now();
        if (now - last < 1500) return;
        last = now;
        emit();
    };
}

// "(3) Title" while there are unread messages.
function setUnreadTitle(base, unread) {
    document.title = unread > 0 ? `(${unread}) ${base}` : base;
}

// ============================================
// STORY CARD
// ============================================
// A 1080x1920 image for an Instagram / WhatsApp story. The link itself is
// added in the story with Instagram's "Link" sticker (or pasted on WhatsApp).

function wrapText(ctx, text, maxWidth) {
    const lines = [];
    let line = '';
    for (const word of text.split(/\s+/)) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > maxWidth && line) {
            lines.push(line);
            line = word;
        } else {
            line = test;
        }
    }
    if (line) lines.push(line);
    return lines;
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function drawStoryCard({ ownerName, prompt, link }) {
    const W = 1080;
    const H = 1920;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const font = (weight, size) => `${weight} ${size}px -apple-system, "Segoe UI", Roboto, sans-serif`;

    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#1a1a2e');
    bg.addColorStop(1, '#2c3e50');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Soft red glows
    for (const [x, y, r] of [[900, 250, 380], [150, 1650, 420]]) {
        const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
        glow.addColorStop(0, 'rgba(231, 76, 60, 0.45)');
        glow.addColorStop(1, 'rgba(231, 76, 60, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, W, H);
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = font(400, 180);
    ctx.fillText('👀', W / 2, 540);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = font(600, 44);
    ctx.fillText('ANONYMOUS CHAT', W / 2, 700);

    // White card with the owner's name and question
    ctx.font = font(700, 72);
    const lines = wrapText(ctx, prompt, 760).slice(0, 5);
    const cardH = 220 + lines.length * 92;
    const cardY = 830;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 60;
    ctx.shadowOffsetY = 20;
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, 100, cardY, W - 200, cardH, 48);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#e74c3c';
    ctx.font = font(700, 50);
    ctx.fillText(`@${ownerName}`, W / 2, cardY + 95);
    ctx.fillStyle = '#2c3e50';
    ctx.font = font(700, 72);
    lines.forEach((l, i) => ctx.fillText(l, W / 2, cardY + 200 + i * 92));

    // "Tap the link" pill
    const pillY = cardY + cardH + 110;
    ctx.fillStyle = '#e74c3c';
    roundRect(ctx, 190, pillY, W - 380, 130, 65);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = font(700, 50);
    ctx.fillText('👇 Link par tap karein', W / 2, pillY + 66);

    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = font(500, 40);
    ctx.fillText(link.replace(/^https?:\/\//, ''), W / 2, pillY + 230);

    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = font(500, 38);
    ctx.fillText('Naam chhupa ke, dil khol ke 💬', W / 2, H - 150);
    return canvas;
}

// Button that shares the story image (phones) or downloads it (desktop),
// with a small preview underneath.
function storyCardButton(info) {
    const preview = el('img', { className: 'story-preview', alt: 'Story card preview', hidden: true });
    const button = el('button', {
        className: 'share-btn story',
        onclick: async () => {
            const canvas = drawStoryCard(info);
            preview.src = canvas.toDataURL('image/jpeg', 0.6);
            preview.hidden = false;
            const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
            const file = new File([blob], 'anonymous-chat-story.png', { type: 'image/png' });

            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                try {
                    await navigator.clipboard.writeText(info.link).catch(() => {});
                    await navigator.share({ files: [file], text: info.link });
                    toast('Link copy ho gaya: story mein "Link" sticker laga dein');
                } catch (e) { /* share cancelled */ }
                return;
            }
            const url = URL.createObjectURL(blob);
            const a = el('a', { href: url, download: file.name });
            document.body.append(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            toast('📸 Story image download ho gayi');
        },
    }, '📸 Story image banao');
    return el('div', { className: 'story-card-tool' }, button, preview);
}
