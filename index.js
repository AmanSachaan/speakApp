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
// NOTE: Assuming the HTML file is now directly in the project root or the path is adjusted.
// If the HTML is in a 'public' directory, keep the original static serving.
// For this example, I'll keep the structure and assume HTML is in a 'public' folder.
app.use(express.static(path.join(__dirname, 'public')));


// ----------------------------------------------------------------
// WebRTC Signaling & Stranger Pairing Logic
// ----------------------------------------------------------------

// Array to hold clients waiting for a match.
// Clients are now objects: { ws: WebSocket, status: 'WAITING' | 'DISCONNECTED' }
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
    // Filter out invalid or explicitly 'DISCONNECTED' clients before matching
    const validWaitingClients = waitingClients.filter(c => 
        c.ws.readyState === c.ws.OPEN && !pairs.has(c.ws) && c.status === 'WAITING'
    );
    
    // Clean up the main array
    waitingClients.length = 0;
    waitingClients.push(...validWaitingClients);

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
        // Add as a 'WAITING' client object
        waitingClients.push({ ws: ws, status: 'WAITING' });
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
        
        // 3. Put the partner back in the waiting queue immediately
        if (shouldRequeuePartner) {
            attemptToPair(partner);
        } else {
             // Find the partner in the waitingClients array and mark them as DISCONNECTED
             const partnerIndex = waitingClients.findIndex(c => c.ws === partner);
             if (partnerIndex !== -1) {
                 waitingClients[partnerIndex].status = 'DISCONNECTED';
             }
        }
    }
    
    // Remove the current client from the waiting list in case they were waiting
    const index = waitingClients.findIndex(c => c.ws === ws);
    if (index !== -1) {
        waitingClients.splice(index, 1);
    }
}

/**
 * Handles cleanup when a client completely closes their socket.
 * @param {WebSocket} ws - The closing client's WebSocket
 */
function cleanupClient(ws) {
    // 1. Remove from waiting list if they were waiting
    const index = waitingClients.findIndex(c => c.ws === ws);
    if (index !== -1) {
        waitingClients.splice(index, 1);
    }
    
    // 2. Disconnect from partner if they were paired (and notify partner, re-queuing partner)
    disconnectPair(ws, true);
}

// WebSocket connection handler
wss.on('connection', function connection(ws) {
    // Client connects, do NOT auto-pair, they must click 'Connect'
    sendMessageToClient(ws, 'STATUS', { message: 'Press Connect to start.' });
    
    // Add the new client to a pseudo-waiting list with a 'DISCONNECTED' status
    // to allow 'CONNECT' to find them later, but only if they explicitly ask.
    waitingClients.push({ ws: ws, status: 'DISCONNECTED' }); 

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
                // WebRTC Signaling Data (Offer, Answer, or ICE Candidate)
                const partner = pairs.get(ws);
                if (partner) {
                    // Forward the signal object (SDP or ICE) to the partner
                    sendMessageToClient(partner, 'SIGNAL', { signal: data.signal });
                } else {
                    sendMessageToClient(ws, 'STATUS', { message: 'You are not paired.' });
                }
                break;

            case 'DISCONNECT':
                // Client requests to disconnect from partner, partner gets re-queued.
                // The current client's partner *should* be re-queued.
                // The current client is marked as 'DISCONNECTED' and removed from the queue.
                disconnectPair(ws, true); // Re-queue partner
                
                // Add the current client back with DISCONNECTED status (prevents auto-reconnect)
                waitingClients.push({ ws: ws, status: 'DISCONNECTED' }); 
                sendMessageToClient(ws, 'STATUS', { message: 'Disconnected. Press Connect for a new stranger.' });
                break;

            case 'CONNECT':
                // Explicit request to connect/re-connect
                // 1. Clean up any existing pairing and set the current client status to 'WAITING'
                disconnectPair(ws, false); // Do NOT re-queue the current client's partner if they had one
                
                // 2. Find the client in the array and update status to 'WAITING'
                const clientObj = waitingClients.find(c => c.ws === ws);
                if (clientObj) {
                    clientObj.status = 'WAITING';
                } else {
                    // Should not happen if connection is handled correctly, but for safety:
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
});