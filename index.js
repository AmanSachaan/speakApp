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

// Serve static files (assuming your index.html is in a 'public' folder)
app.use(express.static(path.join(__dirname, 'public')));


// ----------------------------------------------------------------
// WebRTC Signaling & Stranger Pairing Logic
// ----------------------------------------------------------------

// Stores { mode: [{ ws: WebSocket, mode: 'voice'|'video', status: 'WAITING' }, ...] }
const pendingUsers = {
    voice: [],
    video: []
};
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
        sendMessageToClient(ws1, 'ENABLE_VIDEO', { message: 'Video chat enabled! Say hello visually. 🤳' });
        sendMessageToClient(ws2, 'ENABLE_VIDEO', { message: 'Video chat enabled! Say hello visually. 🤳' });
    }
    
    // Clean up the timer references
    const timer = videoTimers.get(ws1);
    if (timer) {
        clearTimeout(timer);
        videoTimers.delete(ws1);
        videoTimers.delete(ws2);
    }
}

/**
 * Attempts to find a waiting client in the specified mode and connect them, 
 * or adds the client to the waiting list.
 */
function attemptToPair(client) {
    const { ws, mode } = client;
    const queue = pendingUsers[mode];
    
    // 1. Clean the queue by filtering out closed or paired sockets
    pendingUsers[mode] = queue.filter(c => 
        c.ws.readyState === c.ws.OPEN && !pairedConnections.has(c.ws)
    );
    
    // 2. Look for a partner
    if (pendingUsers[mode].length > 0) {
        const partnerClient = pendingUsers[mode].shift();
        const partner = partnerClient.ws;
        
        // Match found!
        pairedConnections.set(ws, partner);
        pairedConnections.set(partner, ws);
        
        sendMessageToClient(ws, 'PAIR_FOUND', { initiator: true }); // Initiator
        sendMessageToClient(partner, 'PAIR_FOUND', { initiator: false });
        
        console.log(`Paired client in ${mode} mode.`);
        
        // Start the 60-second timer ONLY for 'voice' mode
        if (mode === 'voice') {
            const timer = setTimeout(() => {
                enableVideoModeForPair(ws, partner);
            }, VIDEO_ENABLE_DELAY_MS);
            
            videoTimers.set(ws, timer);
            videoTimers.set(partner, timer);
        }

    } else {
        // 3. No one is waiting, so this client waits.
        const existingIndex = pendingUsers[mode].findIndex(c => c.ws === ws);
        if (existingIndex === -1) {
            pendingUsers[mode].push(client);
        }
        sendMessageToClient(ws, 'STATUS', { message: `Searching for a stranger in ${mode} mode...` });
    }
}

/**
 * Disconnects a client from their current partner and cleans up state.
 * @param {WebSocket} ws The client initiating the disconnection or closure.
 * @param {boolean} shouldRequeuePartner If the partner should be immediately put back into a queue.
 */
function disconnectPair(ws, shouldRequeuePartner) {
    const partner = pairedConnections.get(ws);
    
    // 1. TIMER CLEANUP: Clear the timer
    const timer = videoTimers.get(ws);
    if (timer) {
        clearTimeout(timer);
        videoTimers.delete(ws);
        if (partner) {
            videoTimers.delete(partner);
        }
    }
    
    // 2. Partner cleanup
    if (partner) {
        sendMessageToClient(partner, 'DISCONNECTED', { message: 'Your partner disconnected.' });
        
        pairedConnections.delete(ws);
        pairedConnections.delete(partner);
        
        if (shouldRequeuePartner) {
            // Find partner's original connection details to requeue them
            const partnerClientObj = { ws: partner, mode: 'voice' }; // Default to voice if not in map
            
            // Note: We don't store client objects globally, so we assume 'voice' or rely on client's CONNECT message.
            // For simplicity, we assume they want to continue search in default mode.
            attemptToPair(partnerClientObj); 
        }
    }

    // 3. Cleanup from pending queues (in case they were waiting)
    for (const mode of ['voice', 'video']) {
        pendingUsers[mode] = pendingUsers[mode].filter(c => c.ws !== ws);
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
            return;
        }

        switch (data.type) {
            case 'SIGNAL':
                const partner = pairedConnections.get(ws);
                if (partner) {
                    sendMessageToClient(partner, 'SIGNAL', { signal: data.signal });
                } else {
                    // This often means the partner disconnected without the server knowing right away
                    // Clean up and notify self
                    disconnectPair(ws, false); 
                    sendMessageToClient(ws, 'STATUS', { message: 'Signaling failed: You are not paired.' });
                }
                break;

            case 'DISCONNECT':
                // Client initiated manual disconnect
                disconnectPair(ws, false); // Do NOT requeue partner
                sendMessageToClient(ws, 'STATUS', { message: 'Disconnected. Press Connect for a new stranger.' });
                break;

            case 'CONNECT':
                // A new connection attempt is made (or mode switch)
                const newMode = data.mode === 'video' ? 'video' : 'voice'; 
                
                // 1. Clean up any existing pairing or queue state
                disconnectPair(ws, false); 
                
                // 2. Attempt to pair in the new mode
                const clientObj = { ws: ws, mode: newMode };
                attemptToPair(clientObj);
                break;
        }
    });

    ws.on('close', function close() {
        // Client closed the tab/browser
        disconnectPair(ws, true); // Requeue partner
    });

    ws.on('error', (err) => {
        console.error("WebSocket Error:", err.message);
        disconnectPair(ws, true); // Requeue partner
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Serving static files from ${path.join(__dirname, 'public')}`);
});