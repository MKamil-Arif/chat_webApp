const createForm = document.getElementById('createForm');
const ownerNameInput = document.getElementById('ownerName');
const promptInput = document.getElementById('prompt');
const myRoomsList = document.getElementById('myRoomsList');

const DEFAULT_PROMPT = 'Mujhse anonymously baat karo 👀';

function renderMyRooms() {
    const rooms = myRooms.all();
    myRoomsList.replaceChildren();
    if (rooms.length === 0) return;
    myRoomsList.append(
        el('h3', {}, 'Your rooms'),
        ...rooms.map((room) => el('a', { className: 'my-room', href: `/dashboard?room=${encodeURIComponent(room.slug)}` },
            el('span', {}, `👑 ${room.ownerName}`),
            el('small', {}, `/c/${room.slug}`))),
    );
}

createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = createForm.querySelector('button');
    button.disabled = true;
    try {
        const room = await api('/rooms', {
            method: 'POST',
            body: { ownerName: ownerNameInput.value, prompt: promptInput.value.trim() || DEFAULT_PROMPT },
        });
        myRooms.save(room);
        showCreated(room);
    } catch (error) {
        alert(error.message);
    } finally {
        button.disabled = false;
    }
});

function showCreated(room) {
    const link = chatLink(room.slug);
    document.getElementById('chatLinkText').textContent = link;
    document.getElementById('ownerLinkText').textContent = ownerLink(room);
    const prompt = promptInput.value.trim() || DEFAULT_PROMPT;
    document.getElementById('shareArea').replaceChildren(
        storyCardButton({ ownerName: room.ownerName, prompt, link }),
        shareButtons(link, prompt),
    );
    document.getElementById('openDashboard').href = `/dashboard?room=${encodeURIComponent(room.slug)}`;
    document.getElementById('copyOwnerLink').onclick = async () => {
        try {
            await navigator.clipboard.writeText(ownerLink(room));
            toast('✅ Secret link copied. Save it somewhere safe');
        } catch (e) {
            window.prompt('Save this secret link:', ownerLink(room));
        }
    };
    showScreen('createdScreen');
}

// Back to the empty form; the room just created shows up under "Your rooms".
document.getElementById('createAnother').addEventListener('click', () => {
    createForm.reset();
    renderMyRooms();
    showScreen('createScreen');
    ownerNameInput.focus();
});

renderMyRooms();
