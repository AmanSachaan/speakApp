// index.js

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();

const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve the static HTML file (Frontend) from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------------------
// Stranger Connect Logic
// ----------------------------------------------------------------

const waitingClients = [];
const pairs = new Map();

/**
 * Sends a JSON message to a client.
 * @param {WebSocket} ws - The target client's WebSocket
 * @param {string} type - The type of message (STATUS, DISCONNECTED, OFFER, ANSWER, CANDIDATE)
 * @param {object | string} data - The content of the message (string for STATUS, object for WebRTC data)
 */
function sendMessageToClient(ws, type, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const message = typeof data === 'string' ? { message: data } : data;
        ws.send(JSON.stringify({ type, ...message }));
    }
}

/**
 * Attempts to find a waiting client and connect them, or adds the client to the waiting list.
 * NOTE: The 'client' object here is the WebSocket connection.
 */
function attemptToPair(ws) {
    // 1. Clean up stale/closed clients from the waiting list
    for (let i = waitingClients.length - 1; i >= 0; i--) {
        if (waitingClients[i].readyState !== WebSocket.OPEN) {
            waitingClients.splice(i, 1);
        }
    }

    if (waitingClients.length > 0) {
        // Match found!
        const partner = waitingClients.shift();
        
        if (partner.readyState === WebSocket.OPEN && !pairs.has(partner)) {
            pairs.set(ws, partner);
            pairs.set(partner, ws);
            
            // Notify both clients of the connection AND tell them to start WebRTC
            sendMessageToClient(ws, 'STATUS', 'Connected! Starting voice call.');
            sendMessageToClient(partner, 'STATUS', 'Connected! Starting voice call.');
            // Send the 'START_CALL' signal to the client that just joined, they will initiate the offer
            sendMessageToClient(ws, 'START_CALL', 'You are the caller.'); 
            console.log('New voice pair established.');
            return;
        }
        
        attemptToPair(ws); 
    } else {
        // No one is waiting, so this client waits.
        waitingClients.push(ws);
        sendMessageToClient(ws, 'STATUS', 'Waiting for a stranger to connect...');
        console.log('Client waiting for a partner.');
    }
}

/**
 * Disconnects a client from their current partner and cleans up state.
 */
function disconnectPair(ws) {
    const partner = pairs.get(ws);

    if (partner) {
        // 1. Notify the partner to close their PeerConnection
        sendMessageToClient(partner, 'DISCONNECTED', 'Your partner disconnected. Click Connect to find a new stranger.');
        
        // 2. Clear both entries from the pairs map
        pairs.delete(ws);
        pairs.delete(partner);
        console.log('Pair disconnected.');
    }
}

/**
 * Handles cleanup when a client completely closes their socket.
 */
function cleanupClient(ws) {
    // 1. Remove from waiting list if they were waiting
    const index = waitingClients.indexOf(ws);
    if (index !== -1) {
        waitingClients.splice(index, 1);
        console.log('Removed client from waiting list.');
    }
    
    // 2. Disconnect from partner if they were paired (and notify partner)
    disconnectPair(ws);
}

// WebSocket connection handler
wss.on('connection', function connection(ws) {
    console.log('New client connected.');
    
    // Send welcome message and wait for the client to click 'Connect'.
    sendMessageToClient(ws, 'STATUS', 'Welcome! Click Connect to find a stranger.');

    // Handle messages from client
    ws.on('message', function incoming(message) {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            return; // Ignore invalid JSON
        }

        const partner = pairs.get(ws);

        switch (data.type) {
            case 'CONNECT':
                cleanupClient(ws);
                attemptToPair(ws);
                break;

            case 'DISCONNECT':
                disconnectPair(ws);
                sendMessageToClient(ws, 'STATUS', 'You disconnected. Click Connect to find a new stranger.');
                break;
                
            // ----------------------------------------------------------------
            // WebRTC Signaling Handlers
            // ----------------------------------------------------------------
            case 'OFFER':
            case 'ANSWER':
            case 'CANDIDATE':
                if (partner) {
                    // Forward the WebRTC signal directly to the partner
                    sendMessageToClient(partner, data.type, data);
                } else {
                    console.warn(`Received ${data.type} but no partner found.`);
                }
                break;

            default:
                console.warn('Unknown message type received:', data.type);
        }
    });

    // Handle client closing connection (browser tab closed, etc.)
    ws.on('close', function close() {
        console.log('Client disconnected.');
        cleanupClient(ws);
    });

    // Handle connection errors
    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
        cleanupClient(ws);
    });
});

// Start the HTTP/WebSocket server
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket Server ready.`);
});