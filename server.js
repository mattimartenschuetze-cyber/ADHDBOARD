const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e8,
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Serve static files
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadsDir));

// File upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    const fileUrl = '/uploads/' + req.file.filename;
    console.log('File uploaded:', fileUrl);
    res.json({
        success: true,
        url: fileUrl,
        filename: req.file.filename
    });
});

// In-memory storage for rooms
const roomStorage = {};

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Join a room
    socket.on('join_room', (roomId) => {
        socket.join(roomId);
        console.log(`User ${socket.id} joined room ${roomId}`);

        // Initialize room if it doesn't exist
        if (!roomStorage[roomId]) {
            roomStorage[roomId] = {
                elements: [],
                chat: [],
                background: 'dots'
            };
        }

        // Send existing canvas data and chat history
        socket.emit('canvas_data', roomStorage[roomId].elements);
        socket.emit('chat_history', roomStorage[roomId].chat);
        socket.emit('background_updated', roomStorage[roomId].background || 'dots');
    });

    // Handle new drawing element
    socket.on('new_element', (payload) => {
        const { room, element } = payload;
        if (roomStorage[room]) {
            roomStorage[room].elements.push(element);
            socket.to(room).emit('element_received', element);
            console.log(`New element added to room ${room}, type: ${element.type}`);
        }
    });

    // Handle full canvas sync (for clear/delete operations)
    socket.on('full_sync', (payload) => {
        const { room, data } = payload;
        if (roomStorage[room]) {
            roomStorage[room].elements = data;
            socket.to(room).emit('canvas_data', data);
            console.log(`Full sync for room ${room}, elements: ${data.length}`);
        }
    });

    // Handle chat messages
    socket.on('chat_message', (payload) => {
        const { room, text } = payload;
        if (roomStorage[room]) {
            const chatEntry = {
                text: text,
                senderId: socket.id,
                timestamp: Date.now()
            };
            roomStorage[room].chat.push(chatEntry);
            socket.to(room).emit('chat_received', chatEntry);
            console.log(`Chat message in room ${room}: ${text}`);
        }
    });

    // Handle laser pointer (real-time, not stored)
    socket.on('laser_pointer', (payload) => {
        const { room, laser } = payload;
        if (roomStorage[room]) {
            socket.to(room).emit('laser_received', laser);
            console.log(`Laser pointer in room ${room}`);
        }
    });

    // Handle background change
    socket.on('background_change', (payload) => {
        const { room, background } = payload;
        if (roomStorage[room]) {
            roomStorage[room].background = background;
            socket.to(room).emit('background_updated', background);
            console.log(`Background changed in room ${room}: ${background}`);
        }
    });

    // Handle game moves
    socket.on('game_move', (payload) => {
        const { room, gameIndex, game } = payload;
        console.log(`📥 Received game move - Room: ${room}, Index: ${gameIndex}, Player: ${game.currentPlayer}`);

        if (roomStorage[room]) {
            // Update the game in storage
            if (roomStorage[room].elements[gameIndex]) {
                roomStorage[room].elements[gameIndex] = game;
                console.log(`✅ Updated game in storage at index ${gameIndex}`);
            } else {
                console.error(`❌ Game not found at index ${gameIndex} in storage`);
            }

            // Broadcast to other players in room
            const clientsInRoom = io.sockets.adapter.rooms.get(room);
            console.log(`📤 Broadcasting to ${clientsInRoom ? clientsInRoom.size - 1 : 0} other players in room ${room}`);

            socket.to(room).emit('game_move_received', { gameIndex, game });
        } else {
            console.error(`❌ Room ${room} not found in storage`);
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server läuft auf Port ${PORT}`);
    console.log(`📱 Zugriff über: http://localhost:${PORT}`);
    console.log(`📁 Uploads Verzeichnis: ${uploadsDir}`);
});
