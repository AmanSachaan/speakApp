import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws'; 
import path from 'path';
import { fileURLToPath } from 'url';

// Standard setup for ES Modules to get __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files from a 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------------------
// WebRTC Signaling & Stranger Pairing Logic
// ----------------------------------------------------------------

// All users wait in a single queue. All connections start as voice chats.
const pendingUsers = []; 
// Stores { ws1: ws2, ws2: ws1 }
const pairedConnections = new Map(); 
// Stores { ws: timerReference } for the 60-second video enablement timer
const videoTimers = new Map(); 
const VIDEO_ENABLE_DELAY_MS = 60000; // 60 seconds

/**
 * Sends a JSON message to a client.
 */
function sendMessageToClient(ws, type, payload) {
    if (ws && ws.readyState === ws.OPEN) {
        try {
            ws.send(JSON.stringify({ type, ...payload }));
        } catch (e) {
            console.error("Error sending message to client:", e.message);
        }
    }
}

/**
 * Executes the logic to enable video mode for an established pair.
 */
function enableVideoModeForPair(ws1, ws2) {
    // Check if the pair is still connected before sending
    if (pairedConnections.get(ws1) === ws2) {
        // CRITICAL: Send the ENABLE_VIDEO signal to trigger client-side track replacement
        sendMessageToClient(ws1, 'ENABLE_VIDEO', { message: 'Video chat enabled! Say hello visually. 🤳' });
        sendMessageToClient(ws2, 'ENABLE_VIDEO', { message: 'Video chat enabled! Say hello visually. 🤳' });
        console.log("Sent ENABLE_VIDEO signal to a pair.");
    }
    
    // Clean up the timer references regardless
    const timer = videoTimers.get(ws1);
    if (timer) {
        clearTimeout(timer);
        videoTimers.delete(ws1);
        videoTimers.delete(ws2);
    }
}

/**
 * Attempts to find a waiting client and connect them, or adds the client to the waiting list.
 */
function attemptToPair(ws) {
    // 1. Clean the queue by filtering out closed or already paired sockets
    const availableUsers = pendingUsers.filter(user => 
        user.readyState === user.OPEN && !pairedConnections.has(user)
    );
    
    // 2. Look for a partner
    if (availableUsers.length > 0) {
        const partner = availableUsers.shift(); // Get the first waiting user
        
        // Remove the newly found partner from the main pendingUsers array
        const partnerIndex = pendingUsers.findIndex(u => u === partner);
        if (partnerIndex > -1) pendingUsers.splice(partnerIndex, 1);
        
        // Match found!
        pairedConnections.set(ws, partner);
        pairedConnections.set(partner, ws);
        
        // Use random initiator for balanced negotiation load
        const initiator = Math.random() < 0.5;

        sendMessageToClient(ws, 'PAIR_FOUND', { initiator: initiator }); 
        sendMessageToClient(partner, 'PAIR_FOUND', { initiator: !initiator });
        
        console.log(`Paired two clients.`);
        
        // Start the 60-second timer for this new voice-only pair
        const timer = setTimeout(() => {
            enableVideoModeForPair(ws, partner);
        }, VIDEO_ENABLE_DELAY_MS);
        
        videoTimers.set(ws, timer);
        videoTimers.set(partner, timer);

    } else {
        // 3. No one is waiting, so this client waits.
        pendingUsers.push(ws);
        sendMessageToClient(ws, 'STATUS', { message: `Searching for a stranger...` });
    }
}

/**
 * Disconnects a client from their current partner and cleans up state.
 */
function disconnectPair(ws, shouldRequeuePartner) {
    const partner = pairedConnections.get(ws);
    
    // 1. TIMER CLEANUP: Clear any associated timer
    const timer = videoTimers.get(ws);
    if (timer) {
        clearTimeout(timer);
        videoTimers.delete(ws);
        if (partner) videoTimers.delete(partner);
    }
    
    // 2. Partner cleanup
    if (partner) {
        sendMessageToClient(partner, 'DISCONNECTED', { message: 'Your partner disconnected.' });
        
        pairedConnections.delete(ws);
        pairedConnections.delete(partner);
        
        if (shouldRequeuePartner && partner.readyState === partner.OPEN) {
            // Requeue partner for a new match
            console.log("Partner is being re-queued.");
            attemptToPair(partner); 
        }
    }

    // 3. Cleanup from pending queue (in case they were waiting)
    const pendingIndex = pendingUsers.findIndex(user => user === ws);
    if (pendingIndex > -1) {
        pendingUsers.splice(pendingIndex, 1);
    }
}

// WebSocket connection handler
wss.on('connection', function connection(ws) {
    sendMessageToClient(ws, 'STATUS', { message: 'Press Connect to start.' });

    ws.on('message', function incoming(message) {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error("Invalid JSON received:", message);
            return;
        }

        switch (data.type) {
            case 'SIGNAL':
                const partner = pairedConnections.get(ws);
                if (partner) {
                    sendMessageToClient(partner, 'SIGNAL', { signal: data.signal });
                }
                break;

            case 'DISCONNECT':
                // Client initiated a manual disconnect
                disconnectPair(ws, false); 
                break;

            case 'CONNECT':
                // A new connection attempt is made (e.g., "Find New Stranger")
                // 1. Clean up any existing pairing or queue state for this user
                disconnectPair(ws, false); 
                
                // 2. Attempt to pair the user
                attemptToPair(ws);
                break;
        }
    });

    ws.on('close', function close() {
        console.log("Client disconnected from websocket.");
        // Client closed the tab/browser - requeue partner if they exist
        disconnectPair(ws, true); 
    });

    ws.on('error', (err) => {
        console.error("WebSocket Error:", err.message);
        // Client experienced an error - requeue partner if they exist
        disconnectPair(ws, true); 
    });
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});