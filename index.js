import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

// ES Module setup for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// --- State Management ---
const pendingUsers = [];
const pairedConnections = new Map();
const videoTimers = new Map();
const VIDEO_ENABLE_DELAY_MS = 60000; // 60 seconds

// --- Helper Functions ---

function sendMessageToClient(ws, type, payload) {
    if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type, ...payload }));
    }
}

function enableVideoModeForPair(ws1, ws2) {
    if (pairedConnections.get(ws1) === ws2) {
        console.log("Timer finished. Sending ENABLE_VIDEO to pair.");
        sendMessageToClient(ws1, 'ENABLE_VIDEO');
        sendMessageToClient(ws2, 'ENABLE_VIDEO');
    }
    const timer = videoTimers.get(ws1);
    if (timer) {
        clearTimeout(timer);
        videoTimers.delete(ws1);
        videoTimers.delete(ws2);
    }
}

function attemptToPair(ws) {
    const availableUsers = pendingUsers.filter(user =>
        user.readyState === user.OPEN && !pairedConnections.has(user)
    );

    if (availableUsers.length > 0) {
        const partner = availableUsers.shift();
        const partnerIndex = pendingUsers.findIndex(u => u === partner);
        if (partnerIndex > -1) pendingUsers.splice(partnerIndex, 1);

        pairedConnections.set(ws, partner);
        pairedConnections.set(partner, ws);

        console.log("Paired two clients.");
        const initiator = Math.random() < 0.5;
        sendMessageToClient(ws, 'PAIR_FOUND', { initiator });
        sendMessageToClient(partner, 'PAIR_FOUND', { initiator: !initiator });

        const timer = setTimeout(() => {
            enableVideoModeForPair(ws, partner);
        }, VIDEO_ENABLE_DELAY_MS);

        videoTimers.set(ws, timer);
        videoTimers.set(partner, timer);
    } else {
        pendingUsers.push(ws);
        sendMessageToClient(ws, 'STATUS', { message: 'Searching for a stranger...' });
    }
}

function disconnectPair(ws, shouldRequeuePartner) {
    const partner = pairedConnections.get(ws);
    const timer = videoTimers.get(ws);

    if (timer) {
        clearTimeout(timer);
        videoTimers.delete(ws);
        if (partner) videoTimers.delete(partner);
    }

    if (partner) {
        sendMessageToClient(partner, 'DISCONNECTED');
        pairedConnections.delete(ws);
        pairedConnections.delete(partner);

        if (shouldRequeuePartner && partner.readyState === partner.OPEN) {
            console.log("Partner is being re-queued.");
            attemptToPair(partner);
        }
    }

    const pendingIndex = pendingUsers.findIndex(user => user === ws);
    if (pendingIndex > -1) {
        pendingUsers.splice(pendingIndex, 1);
    }
}

// --- WebSocket Connection Handling ---

wss.on('connection', function connection(ws) {
    sendMessageToClient(ws, 'STATUS', { message: 'Press Connect to start.' });

    ws.on('message', function incoming(message) {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            return; // Ignore invalid JSON
        }

        switch (data.type) {
            case 'SIGNAL':
                const partner = pairedConnections.get(ws);
                if (partner) {
                    sendMessageToClient(partner, 'SIGNAL', { signal: data.signal });
                }
                break;
            case 'DISCONNECT':
                disconnectPair(ws, false);
                break;
            case 'CONNECT':
                disconnectPair(ws, false);
                attemptToPair(ws);
                break;
        }
    });

    ws.on('close', () => disconnectPair(ws, true));
    ws.on('error', () => disconnectPair(ws, true));
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});