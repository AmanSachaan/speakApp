import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws'; 
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));


// ----------------------------------------------------------------
// WebRTC Signaling & Stranger Pairing Logic
// ----------------------------------------------------------------

const waitingClients = [];
const pairs = new Map();
// Map to store the 1-minute video enablement timer for each client
const pairTimers = new Map(); 
const VIDEO_ENABLE_DELAY_MS = 60000; // 60 seconds

/**
 * Sends a JSON message to a client.
 */
function sendMessageToClient(ws, type, payload) {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type, ...payload }));
    }
}

/**
 * Executes the logic to enable video mode for an established pair.
 */
function enableVideoModeForPair(ws1, ws2) {
    sendMessageToClient(ws1, 'ENABLE_VIDEO', { message: 'Video mode enabled!' });
    sendMessageToClient(ws2, 'ENABLE_VIDEO', { message: 'Video mode enabled!' });
    
    // Clean up the timer reference after it fires
    pairTimers.delete(ws1);
    pairTimers.delete(ws2);
}

/**
 * Attempts to find a waiting client and connect them, or adds the client to the waiting list.
 */
function attemptToPair(ws) {
    const validWaitingClients = waitingClients.filter(c => 
        c.ws.readyState === c.ws.OPEN && !pairs.has(c.ws) && c.status === 'WAITING'
    );
    
    waitingClients.length = 0;
    waitingClients.push(...validWaitingClients);

    const currentClientIndex = waitingClients.findIndex(c => c.ws === ws);
    let currentClientObj;

    if (currentClientIndex !== -1) {
        currentClientObj = waitingClients.splice(currentClientIndex, 1)[0];
    } else {
        currentClientObj = { ws: ws, status: 'WAITING', mode: 'voice' };
    }

    if (waitingClients.length > 0) {
        // Match found!
        const partnerClient = waitingClients.shift();
        const partner = partnerClient.ws;
        
        pairs.set(ws, partner);
        pairs.set(partner, ws);
        
        sendMessageToClient(ws, 'PAIR_FOUND', { initiator: true });
        sendMessageToClient(partner, 'PAIR_FOUND', { initiator: false });
        
        // NEW TIMER LOGIC: Set a 1-minute timer for video enablement
        const timer = setTimeout(() => {
            enableVideoModeForPair(ws, partner);
        }, VIDEO_ENABLE_DELAY_MS);
        
        pairTimers.set(ws, timer);
        pairTimers.set(partner, timer);

    } else {
        // No one is waiting, so this client waits.
        waitingClients.push(currentClientObj);
        sendMessageToClient(ws, 'STATUS', { message: `Waiting for a stranger (${currentClientObj.mode} mode)...` });
    }
}

/**
 * Disconnects a client from their current partner and cleans up state.
 */
function disconnectPair(ws, shouldRequeuePartner = true) {
    const partner = pairs.get(ws);

    // TIMER CLEANUP: Clear the timer if it exists for this pair
    const timer = pairTimers.get(ws);
    if (timer) {
        clearTimeout(timer);
        pairTimers.delete(ws);
        if (partner) {
            pairTimers.delete(partner);
        }
    }
    
    if (partner) {
        sendMessageToClient(partner, 'DISCONNECTED', { message: 'Your partner disconnected.' });
        
        pairs.delete(ws);
        pairs.delete(partner);
        
        const partnerClientObj = waitingClients.find(c => c.ws === partner);

        if (partnerClientObj) {
            if (shouldRequeuePartner) {
                partnerClientObj.status = 'WAITING';
                attemptToPair(partner);
            } else {
                partnerClientObj.status = 'DISCONNECTED';
            }
        } else if (shouldRequeuePartner) {
            waitingClients.push({ ws: partner, status: 'WAITING', mode: 'voice' });
            attemptToPair(partner);
        }
    }
    
    const clientObj = waitingClients.find(c => c.ws === ws);
    if (clientObj) {
        clientObj.status = 'DISCONNECTED';
    }
}

/**
 * Handles cleanup when a client completely closes their socket.
 */
function cleanupClient(ws) {
    disconnectPair(ws, true);
    
    const index = waitingClients.findIndex(c => c.ws === ws);
    if (index !== -1) {
        waitingClients.splice(index, 1);
    }
}

// WebSocket connection handler
wss.on('connection', function connection(ws) {
    const newClientObj = { ws: ws, status: 'DISCONNECTED', mode: 'voice' }; 
    waitingClients.push(newClientObj);

    sendMessageToClient(ws, 'STATUS', { message: 'Press Connect to start.' });

    ws.on('message', function incoming(message) {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            return;
        }

        switch (data.type) {
            case 'SIGNAL':
                const partner = pairs.get(ws);
                if (partner) {
                    sendMessageToClient(partner, 'SIGNAL', { signal: data.signal });
                } else {
                    sendMessageToClient(ws, 'STATUS', { message: 'You are not paired.' });
                }
                break;

            case 'DISCONNECT':
                disconnectPair(ws, true); 
                sendMessageToClient(ws, 'STATUS', { message: 'Disconnected. Press Connect for a new stranger.' });
                break;

            case 'CONNECT':
                disconnectPair(ws, false); 
                
                const clientObj = waitingClients.find(c => c.ws === ws);
                if (clientObj) {
                    clientObj.status = 'WAITING';
                    clientObj.mode = data.mode === 'video' ? 'video' : 'voice'; 
                } else {
                    waitingClients.push({ ws: ws, status: 'WAITING', mode: data.mode === 'video' ? 'video' : 'voice' });
                }
                
                attemptToPair(ws);
                break;
        }
    });

    ws.on('close', function close() {
        cleanupClient(ws);
    });

    ws.on('error', (err) => {
        cleanupClient(ws);
    });
});

server.listen(PORT, () => {
    // Server is running
});