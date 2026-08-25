const API_URL = window.location.hostname === 'localhost' 
    ? 'http://localhost:5000/api' 
    : 'https://your-app-name.vercel.app/api';

let currentUser = null;
let currentScreen = 'register';
let isAdmin = false;
let selectedUserId = null;
let allUsers = [];
let allMessages = [];
let messageInterval = null;

// DOM Elements
const registerScreen = document.getElementById('registerScreen');
const chatScreen = document.getElementById('chatScreen');
const adminPanel = document.getElementById('adminPanel');
const registerForm = document.getElementById('registerForm');
const messagesContainer = document.getElementById('messagesContainer');
const adminMessagesContainer = document.getElementById('adminMessagesContainer');
const messageInput = document.getElementById('messageInput');
const adminMessageInput = document.getElementById('adminMessageInput');
const sendBtn = document.getElementById('sendBtn');
const adminSendBtn = document.getElementById('adminSendBtn');
const logoutBtn = document.getElementById('logoutBtn');
const adminLogoutBtn = document.getElementById('adminLogoutBtn');
const userNameInput = document.getElementById('userName');
const userRelationInput = document.getElementById('userRelation');
const usersList = document.getElementById('usersList');
const selectedUserInfo = document.getElementById('selectedUserInfo');
const userCount = document.getElementById('userCount');
const totalUsers = document.getElementById('totalUsers');
const searchUser = document.getElementById('searchUser');

// ============================================
// USER REGISTRATION / LOGIN
// ============================================

function checkExistingUser() {
    const savedUser = localStorage.getItem('chatUser');
    if (savedUser) {
        try {
            return JSON.parse(savedUser);
        } catch (e) {
            return null;
        }
    }
    return null;
}

registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('userName').value.trim();
    const relation = document.getElementById('userRelation').value;

    if (!name || !relation) {
        alert('Please fill all fields');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/users`);
        const allUsers = await response.json();
        
        // Check if user exists
        const existingUser = allUsers.find(user => user.name.toLowerCase() === name.toLowerCase());
        
        let user;
        if (existingUser) {
            // ⭐ UPDATE: User exists, update their info
            user = existingUser;
            
            // Check if name or relation changed
            if (user.name !== name || user.relation !== relation) {
                const updateResponse = await fetch(`${API_URL}/users/${user._id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, relation })
                });
                user = await updateResponse.json();
                console.log('✅ User updated:', user.name);
            }
        } else {
            // New user
            const createResponse = await fetch(`${API_URL}/users`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, relation })
            });
            user = await createResponse.json();
            console.log('✅ New user created:', user.name);
        }
        
        localStorage.setItem('chatUser', JSON.stringify(user));
        currentUser = user;
        isAdmin = name.toLowerCase() === 'admin';
        
        if (isAdmin) {
            showScreen('admin');
            loadUsers();
        } else {
            showScreen('chat');
        }
        loadMessages();
        
        if (messageInterval) {
            clearInterval(messageInterval);
        }
        messageInterval = setInterval(() => {
            loadMessages();
            if (isAdmin) loadUsers();
        }, 5000);
        
    } catch (error) {
        console.error('Error:', error);
        alert('Connection error. Please try again.');
    }
});

document.addEventListener('DOMContentLoaded', () => {
    const savedUser = checkExistingUser();
    if (savedUser) {
        userNameInput.value = savedUser.name || '';
        userRelationInput.value = savedUser.relation || '';
        setTimeout(() => {
            registerForm.dispatchEvent(new Event('submit'));
        }, 500);
    } else {
        showScreen('register');
    }
});

// ============================================
// MESSAGE FUNCTIONS
// ============================================

sendBtn.addEventListener('click', sendUserMessage);
messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendUserMessage();
});

adminSendBtn.addEventListener('click', sendAdminMessage);
adminMessageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendAdminMessage();
});

async function sendUserMessage() {
    if (!currentUser) {
        alert('Please login first');
        return;
    }
    const message = messageInput.value.trim();
    if (!message) return;

    try {
        await fetch(`${API_URL}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: currentUser._id,
                userName: currentUser.name,
                message: message,
                isAdmin: false
            })
        });
        messageInput.value = '';
        loadMessages();
    } catch (error) {
        console.error('Error sending message:', error);
    }
}

async function sendAdminMessage() {
    if (!currentUser || !selectedUserId) {
        alert('Please select a user to reply');
        return;
    }
    const message = adminMessageInput.value.trim();
    if (!message) return;

    const selectedUser = allUsers.find(u => u._id === selectedUserId);
    if (!selectedUser) {
        alert('User not found');
        return;
    }

    try {
        await fetch(`${API_URL}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: selectedUserId,
                userName: selectedUser.name,
                message: message,
                isAdmin: true
            })
        });
        adminMessageInput.value = '';
        loadMessages();
        loadUsers();
    } catch (error) {
        console.error('Error sending admin message:', error);
    }
}

// ============================================
// LOAD USERS (ADMIN ONLY)
// ============================================

async function loadUsers() {
    if (!isAdmin) return;
    
    try {
        const response = await fetch(`${API_URL}/users`);
        allUsers = await response.json();
        
        const msgResponse = await fetch(`${API_URL}/messages`);
        allMessages = await msgResponse.json();
        
        renderUsers();
    } catch (error) {
        console.error('Error loading users:', error);
    }
}

// ============================================
// RENDER USERS LIST - WITH HISTORY
// ============================================

function renderUsers() {
    if (!usersList || !isAdmin) return;
    
    const filteredUsers = allUsers.filter(u => u.name.toLowerCase() !== 'admin');
    const searchTerm = searchUser ? searchUser.value.toLowerCase() : '';
    
    const searchedUsers = filteredUsers.filter(u => 
        u.name.toLowerCase().includes(searchTerm) ||
        (u.relation && u.relation.toLowerCase().includes(searchTerm))
    );
    
    usersList.innerHTML = '';
    
    if (totalUsers) {
        totalUsers.textContent = `${filteredUsers.length} Users`;
    }
    
    if (userCount) {
        userCount.textContent = filteredUsers.length;
    }
    
    if (searchedUsers.length === 0) {
        usersList.innerHTML = `
            <div style="padding: 30px 20px; text-align: center; color: #999;">
                <div style="font-size: 30px; margin-bottom: 10px;">👤</div>
                <p>No users found</p>
            </div>
        `;
        return;
    }
    
    searchedUsers.forEach(user => {
        const userMessages = allMessages.filter(m => m.userId === user._id);
        const msgCount = userMessages.length;
        
        // ⭐ Check if user has name history (changed name before)
        const hasHistory = user.nameHistory && user.nameHistory.length > 1;
        const nameChanges = user.nameHistory ? user.nameHistory.length - 1 : 0;
        
        const userDiv = document.createElement('div');
        userDiv.className = `user-item ${selectedUserId === user._id ? 'active' : ''}`;
        userDiv.dataset.userId = user._id;
        
        // ⭐ Show history indicator
        let historyIndicator = '';
        if (hasHistory) {
            const previousNames = user.nameHistory
                .slice(0, -1)
                .map(h => h.name)
                .join(' → ');
            historyIndicator = `
                <div style="font-size: 10px; opacity: 0.6; margin-top: 2px;">
                    🔄 Previously: ${previousNames}
                </div>
            `;
        }
        
        userDiv.innerHTML = `
            <div class="user-info">
                <div class="user-name">
                    ${user.name}
                    ${hasHistory ? ' 🔄' : ''}
                </div>
                <div class="user-relation">${user.relation || 'No relation'}</div>
                ${historyIndicator}
            </div>
            <div class="user-meta">
                <span class="user-status ${msgCount > 0 ? 'online' : 'offline'}"></span>
                <span class="user-badge">${msgCount}</span>
            </div>
        `;
        
        userDiv.addEventListener('click', function(e) {
            e.stopPropagation();
            const userId = this.dataset.userId;
            selectUser(userId);
        });
        
        usersList.appendChild(userDiv);
    });
}

if (searchUser) {
    searchUser.addEventListener('input', renderUsers);
}

// ============================================
// SELECT USER (ADMIN)
// ============================================

function selectUser(userId) {
    if (!isAdmin) return;
    
    selectedUserId = userId;
    
    const user = allUsers.find(u => u._id === userId);
    if (!user) {
        return;
    }
    
    const userMessages = allMessages.filter(m => m.userId === userId);
    const msgCount = userMessages.length;
    
    // ⭐ Show user history in detail view
    let historyHtml = '';
    if (user.nameHistory && user.nameHistory.length > 1) {
        historyHtml = `
            <div style="font-size: 12px; color: #7f8c8d; margin-top: 4px;">
                📝 Name History: 
                ${user.nameHistory.map((h, i) => 
                    i === user.nameHistory.length - 1 
                        ? `<strong style="color: #e74c3c;">${h.name}</strong>` 
                        : `${h.name}`
                ).join(' → ')}
            </div>
        `;
    }
    
    selectedUserInfo.innerHTML = `
        <div class="selected-user-detail">
            <div class="user-main">
                <div class="user-avatar">${user.name.charAt(0).toUpperCase()}</div>
                <div>
                    <div class="user-name-display">${user.name}</div>
                    <div class="user-relation-display">${user.relation || 'No relation'}</div>
                    ${historyHtml}
                </div>
            </div>
            <div class="user-msg-count">${msgCount} messages</div>
        </div>
    `;
    
    renderMessages(userMessages, adminMessagesContainer, true);
    renderUsers();
    adminMessagesContainer.scrollTop = adminMessagesContainer.scrollHeight;
}

// ============================================
// LOAD MESSAGES
// ============================================

async function loadMessages() {
    try {
        const response = await fetch(`${API_URL}/messages`);
        const messages = await response.json();
        allMessages = messages;
        
        if (isAdmin) {
            if (selectedUserId) {
                const userMessages = messages.filter(m => m.userId === selectedUserId);
                renderMessages(userMessages, adminMessagesContainer, true);
            } else {
                adminMessagesContainer.innerHTML = `
                    <div style="text-align: center; color: #999; padding: 40px;">
                        <div style="font-size: 40px; margin-bottom: 10px;">👈</div>
                        <p>Select a user from the left panel</p>
                    </div>
                `;
            }
            renderUsers();
        } else {
            const myMessages = messages.filter(m => m.userId === currentUser?._id);
            renderMessages(myMessages, messagesContainer, false);
        }
    } catch (error) {
        console.error('Error loading messages:', error);
    }
}

// ============================================
// RENDER MESSAGES
// ============================================

function renderMessages(messages, container, isAdminView) {
    container.innerHTML = '';
    
    if (!messages || messages.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; color: #999; padding: 40px;">
                <div style="font-size: 40px; margin-bottom: 10px;">💬</div>
                <p>No messages yet</p>
                <p style="font-size: 13px; margin-top: 5px;">Start the conversation!</p>
            </div>
        `;
        return;
    }
    
    messages.forEach((msg) => {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${msg.isAdmin ? 'admin' : 'user'}`;
        
        const sender = document.createElement('span');
        sender.className = 'sender';
        sender.textContent = msg.isAdmin ? '👑 Admin' : msg.userName;
        
        const text = document.createElement('div');
        text.textContent = msg.message;
        
        const time = document.createElement('span');
        time.className = 'time';
        const date = new Date(msg.timestamp);
        time.textContent = date.toLocaleTimeString();
        
        messageDiv.appendChild(sender);
        messageDiv.appendChild(text);
        messageDiv.appendChild(time);
        
        const isOwnMessage = msg.userId === currentUser?._id;
        const canEdit = isAdminView || isOwnMessage;
        
        if (canEdit) {
            const actions = document.createElement('div');
            actions.className = 'actions';
            
            if (isAdminView || isOwnMessage) {
                const editBtn = document.createElement('button');
                editBtn.textContent = '✏️';
                editBtn.title = 'Edit message';
                editBtn.onclick = (e) => {
                    e.stopPropagation();
                    const newMsg = prompt('Edit message:', msg.message);
                    if (newMsg && newMsg.trim()) {
                        editMessage(msg._id, newMsg.trim());
                    }
                };
                actions.appendChild(editBtn);
            }
            
            if (isAdminView) {
                const deleteBtn = document.createElement('button');
                deleteBtn.textContent = '🗑️';
                deleteBtn.title = 'Delete message';
                deleteBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (confirm('Delete this message?')) {
                        deleteMessage(msg._id);
                    }
                };
                actions.appendChild(deleteBtn);
            }
            
            messageDiv.appendChild(actions);
        }
        
        container.appendChild(messageDiv);
    });
    
    container.scrollTop = container.scrollHeight;
}

// ============================================
// EDIT / DELETE MESSAGES
// ============================================

async function editMessage(id, newMessage) {
    const msg = allMessages.find(m => m._id === id);
    if (!msg) return;
    
    const isOwnMessage = msg.userId === currentUser?._id;
    
    if (!isAdmin && !isOwnMessage) {
        alert('❌ You can only edit your own messages!');
        return;
    }
    
    try {
        await fetch(`${API_URL}/messages/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: newMessage })
        });
        loadMessages();
    } catch (error) {
        console.error('Error editing message:', error);
        alert('Failed to edit message');
    }
}

async function deleteMessage(id) {
    if (!isAdmin) {
        alert('❌ Only admin can delete messages!');
        return;
    }
    
    try {
        await fetch(`${API_URL}/messages/${id}`, {
            method: 'DELETE'
        });
        loadMessages();
    } catch (error) {
        console.error('Error deleting message:', error);
        alert('Failed to delete message');
    }
}

// ============================================
// SCREEN MANAGEMENT
// ============================================

function showScreen(screen) {
    registerScreen.classList.remove('active');
    chatScreen.classList.remove('active');
    adminPanel.classList.remove('active');
    
    if (screen === 'register') {
        registerScreen.classList.add('active');
    } else if (screen === 'chat') {
        chatScreen.classList.add('active');
    } else if (screen === 'admin') {
        adminPanel.classList.add('active');
        if (!selectedUserId) {
            selectedUserInfo.innerHTML = `
                <div class="no-user-selected">
                    <div class="no-user-icon">💬</div>
                    <h3>Select a user to start chatting</h3>
                    <p>Click on any user from the left panel</p>
                </div>
            `;
            adminMessagesContainer.innerHTML = '';
        }
        loadUsers();
    }
}

// ============================================
// LOGOUT
// ============================================

function performLogout() {
    localStorage.removeItem('chatUser');
    currentUser = null;
    isAdmin = false;
    selectedUserId = null;
    if (messageInterval) {
        clearInterval(messageInterval);
        messageInterval = null;
    }
    showScreen('register');
    userNameInput.value = '';
    userRelationInput.value = '';
}

logoutBtn.addEventListener('click', performLogout);
adminLogoutBtn.addEventListener('click', performLogout);