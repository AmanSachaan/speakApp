// index.js

import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws'; // Use named import for consistency
import path from 'path';
import { fileURLToPath } from 'url';

// Convert import.meta.url to directory name for path operations
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// 🔑 RENDER FIX: Use the PORT environment variable provided by Render or default to 3000 locally
const PORT = process.env.PORT || 3000;

// Create an HTTP server instance using the Express app
const server = http.createServer(app);

// Attach the WebSocket Server to the same HTTP server instance
const wss = new WebSocketServer({ server });

// Serve the static HTML file (Frontend) from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));


// ----------------------------------------------------------------
// WebRTC Signaling & Stranger Pairing Logic
// ----------------------------------------------------------------

// Array to hold clients waiting for a match.
// Clients are now objects: { ws: WebSocket, status: 'WAITING' | 'DISCONNECTED' }
// Key Fix: The logic needs to ensure the array only contains unique clients.
const waitingClients = [];
// Map to store connected pairs: { client1_socket: client2_socket, client2_socket: client1_socket }
const pairs = new Map();

/**
 * Sends a JSON message to a client.
 * @param {WebSocket} ws - The target client's WebSocket
 * @param {string} type - The type of message (STATUS, PAIR_FOUND, SIGNAL, DISCONNECTED)
 * @param {object} payload - The content of the message
 */
function sendMessageToClient(ws, type, payload) {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type, ...payload }));
    }
}

/**
 * Attempts to find a waiting client and connect them, or adds the client to the waiting list.
 * @param {WebSocket} ws - The connecting client's WebSocket
 */
function attemptToPair(ws) {
    // 1. Filter and clean the array before matching. We only want 'WAITING' clients who are not paired.
    const validWaitingClients = waitingClients.filter(c => 
        c.ws.readyState === c.ws.OPEN && !pairs.has(c.ws) && c.status === 'WAITING'
    );
    
    // Replace the waitingClients array with the filtered, valid list
    waitingClients.length = 0;
    waitingClients.push(...validWaitingClients);

    // 2. Separate the current client from the waiting list temporarily.
    const currentClientIndex = waitingClients.findIndex(c => c.ws === ws);
    let currentClientObj;

    if (currentClientIndex !== -1) {
        currentClientObj = waitingClients.splice(currentClientIndex, 1)[0];
    } else {
        // This should not happen if CONNECT correctly sets the status, but as a fallback
        currentClientObj = { ws: ws, status: 'WAITING' }; 
    }

    if (waitingClients.length > 0) {
        // Match found!
        const partnerClient = waitingClients.shift(); // Get the oldest waiting client object
        const partner = partnerClient.ws;
        
        pairs.set(ws, partner);
        pairs.set(partner, ws);
        
        // Notify both clients of the connection and designate the initiator.
        sendMessageToClient(ws, 'PAIR_FOUND', { initiator: true });
        sendMessageToClient(partner, 'PAIR_FOUND', { initiator: false });
        
    } else {
        // No one is waiting, so this client waits.
        // Add the current client back with the correct status.
        waitingClients.push(currentClientObj);
        sendMessageToClient(ws, 'STATUS', { message: 'Waiting for a stranger...' });
    }
}

/**
 * Disconnects a client from their current partner and cleans up state.
 * @param {WebSocket} ws - The client's WebSocket to disconnect
 * @param {boolean} shouldRequeuePartner - If the partner should be immediately put back in the waiting list.
 */
function disconnectPair(ws, shouldRequeuePartner = true) {
    const partner = pairs.get(ws);

    if (partner) {
        // 1. Notify the partner
        sendMessageToClient(partner, 'DISCONNECTED', { message: 'Your partner disconnected.' });
        
        // 2. Clear both entries from the pairs map
        pairs.delete(ws);
        pairs.delete(partner);
        
        // 3. Update partner's status and potentially re-queue them
        const partnerClientObj = waitingClients.find(c => c.ws === partner);

        if (partnerClientObj) {
            if (shouldRequeuePartner) {
                partnerClientObj.status = 'WAITING';
                attemptToPair(partner); // Re-run pairing logic for the partner
            } else {
                partnerClientObj.status = 'DISCONNECTED'; // Partner is now un-queued
            }
        } else if (shouldRequeuePartner) {
            // Partner was in a pair but not in the waitingClients array (shouldn't happen, but safe)
            waitingClients.push({ ws: partner, status: 'WAITING' });
            attemptToPair(partner);
        }
    }
    
    // Set the current client's status to DISCONNECTED if they exist in the array
    const clientObj = waitingClients.find(c => c.ws === ws);
    if (clientObj) {
        clientObj.status = 'DISCONNECTED';
    }
}

/**
 * Handles cleanup when a client completely closes their socket.
 * @param {WebSocket} ws - The closing client's WebSocket
 */
function cleanupClient(ws) {
    // 1. Disconnect from partner (and notify partner, re-queuing partner)
    disconnectPair(ws, true);
    
    // 2. Remove client object completely from waiting list
    const index = waitingClients.findIndex(c => c.ws === ws);
    if (index !== -1) {
        waitingClients.splice(index, 1);
    }
}

// WebSocket connection handler
wss.on('connection', function connection(ws) {
    // Client connects: add them to the managed list immediately with DISCONNECTED status
    const newClientObj = { ws: ws, status: 'DISCONNECTED' };
    waitingClients.push(newClientObj);

    sendMessageToClient(ws, 'STATUS', { message: 'Press Connect to start.' });

    // Handle messages from client
    ws.on('message', function incoming(message) {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            return; // Ignore invalid JSON
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
                // Client explicitly disconnects. Partner is re-queued, this client is marked DISCONNECTED.
                disconnectPair(ws, true); 
                sendMessageToClient(ws, 'STATUS', { message: 'Disconnected. Press Connect for a new stranger.' });
                break;

            case 'CONNECT':
                // Explicit request to connect/re-connect
                
                // 1. Disconnect from any current partner (partner is NOT re-queued, they're marked DISCONNECTED)
                disconnectPair(ws, false); 
                
                // 2. Find the client and update status to 'WAITING'
                const clientObj = waitingClients.find(c => c.ws === ws);
                if (clientObj) {
                    clientObj.status = 'WAITING';
                } else {
                     // Should not happen, but if they weren't in the array, add them now
                     waitingClients.push({ ws: ws, status: 'WAITING' });
                }
                
                // 3. Attempt to find a match
                attemptToPair(ws);
                break;
        }
    });

    // Handle client closing connection (browser tab closed, etc.)
    ws.on('close', function close() {
        cleanupClient(ws);
    });

    // Handle connection errors
    ws.on('error', (err) => {
        cleanupClient(ws); // Clean up on error as well
    });
});

// Start the HTTP/WebSocket server
server.listen(PORT, () => {
    // console.log output is removed as requested
});