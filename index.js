// index.js

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();

// 🔑 RENDER FIX: Use the PORT environment variable provided by Render or default to 3000 locally
const PORT = process.env.PORT || 3000;

// Create an HTTP server instance using the Express app
const server = http.createServer(app);

// Attach the WebSocket Server to the same HTTP server instance
const wss = new WebSocket.Server({ server });

// Serve the static HTML file (Frontend) from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------------------
// WebRTC Signaling & Stranger Pairing Logic
// ----------------------------------------------------------------

// Array to hold clients waiting for a match.
const waitingClients = [];
// Map to store connected pairs: { client1_socket: client2_socket, client2_socket: client1_socket }
const pairs = new Map();

/**
 * Sends a JSON message to a client.
 * NOTE: The payload now accepts an object for flexible WebRTC signaling.
 * @param {WebSocket} ws - The target client's WebSocket
 * @param {string} type - The type of message (STATUS, PAIR_FOUND, SIGNAL, DISCONNECTED)
 * @param {object} payload - The content of the message
 */
function sendMessageToClient(ws, type, payload) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type, ...payload }));
    }
}

/**
 * Attempts to find a waiting client and connect them, or adds the client to the waiting list.
 * @param {WebSocket} ws - The connecting client's WebSocket
 */
function attemptToPair(ws) {
    if (waitingClients.length > 0) {
        // Match found!
        const partner = waitingClients.shift(); // Get the oldest waiting client
        
        // Ensure the partner is still open and not already paired
        if (partner.readyState === WebSocket.OPEN && !pairs.has(partner)) {
            pairs.set(ws, partner);
            pairs.set(partner, ws);
            
            // Notify both clients of the connection and designate the initiator.
            // The client with initiator: true will send the WebRTC OFFER first.
            sendMessageToClient(ws, 'PAIR_FOUND', { initiator: true, message: 'Connected! Preparing voice chat as the initiator.' });
            sendMessageToClient(partner, 'PAIR_FOUND', { initiator: false, message: 'Connected! Waiting for offer to start voice chat.' });
            
            console.log('New pair established for WebRTC signaling.');
            return;
        }
        
        // If the old waiting client was invalid, re-try pairing for the current client
        attemptToPair(ws); 
    } else {
        // No one is waiting, so this client waits.
        waitingClients.push(ws);
        sendMessageToClient(ws, 'STATUS', { message: 'Waiting for a stranger to connect...' });
        console.log('Client waiting for a partner.');
    }
}

/**
 * Disconnects a client from their current partner and cleans up state.
 * @param {WebSocket} ws - The client's WebSocket to disconnect
 */
function disconnectPair(ws) {
    const partner = pairs.get(ws);

    if (partner) {
        // 1. Notify the partner
        // This tells the partner's browser to close the WebRTC connection.
        sendMessageToClient(partner, 'DISCONNECTED', { message: 'Your partner disconnected.' });
        
        // 2. Clear both entries from the pairs map
        pairs.delete(ws);
        pairs.delete(partner);
        console.log('Pair disconnected.');
        
        // 3. Put the partner back in the waiting queue immediately
        attemptToPair(partner);
    }
}

/**
 * Handles cleanup when a client completely closes their socket.
 * @param {WebSocket} ws - The closing client's WebSocket
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
    
    // Attempt to pair the client immediately upon connection
    attemptToPair(ws);

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
                    // The 'signal' property holds the WebRTC data sent from the client.
                    sendMessageToClient(partner, 'SIGNAL', { signal: data.signal });
                } else {
                    sendMessageToClient(ws, 'STATUS', { message: 'You are not currently paired for signaling.' });
                }
                break;

            case 'DISCONNECT':
                // Request to disconnect from the current partner
                disconnectPair(ws);
                // After disconnecting, automatically put them in the waiting list for a new connection
                attemptToPair(ws); 
                break;

            case 'CONNECT':
                // Explicit request to connect
                cleanupClient(ws); // Ensure they aren't paired or waiting
                attemptToPair(ws);
                break;
                
            // Removed 'CHAT' case as this is now a voice application
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
        cleanupClient(ws); // Clean up on error as well
    });
});

// Start the HTTP/WebSocket server
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket Server (for WebRTC Signaling) ready.`);
});