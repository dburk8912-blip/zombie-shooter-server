// ============================================
// ZOMBIE SHOOTER MULTIPLAYER SERVER
// Node.js + Socket.IO
// ============================================

const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

// Create Socket.IO server with CORS enabled
const io = new Server(PORT, {
  cors: {
    origin: "*", // Allow all origins (fine for game)
    methods: ["GET", "POST"]
  }
});

// Store active games
// Map: roomCode -> {host, players, state, lastUpdate}
const games = new Map();

// Store socket to room mapping
// Map: socketId -> roomCode
const socketRooms = new Map();

console.log(`🎮 Zombie Shooter Server starting on port ${PORT}...`);

// ============================================
// SOCKET.IO EVENT HANDLERS
// ============================================

io.on('connection', (socket) => {
  console.log(`✅ Client connected: ${socket.id}`);
  
  // ========================================
  // HOST: Create new game
  // ========================================
  socket.on('host:create', (callback) => {
    try {
      const roomCode = generateRoomCode();
      
      // Create game room
      games.set(roomCode, {
        host: socket.id,
        players: new Map(), // playerId -> {name, joinedAt}
        state: null,
        createdAt: Date.now(),
        lastUpdate: Date.now()
      });
      
      // Join socket to room
      socket.join(roomCode);
      socketRooms.set(socket.id, roomCode);
      
      console.log(`🎲 Game created: ${roomCode} by ${socket.id}`);
      
      callback({ success: true, code: roomCode });
    } catch (error) {
      console.error('Error creating game:', error);
      callback({ error: 'Failed to create game' });
    }
  });
  
  // ========================================
  // PLAYER: Join existing game
  // ========================================
  socket.on('player:join', ({ code, name }, callback) => {
    try {
      const roomCode = code.toUpperCase();
      const game = games.get(roomCode);
      
      // Validate game exists
      if (!game) {
        console.log(`❌ Invalid code attempted: ${roomCode}`);
        return callback({ error: 'Invalid game code' });
      }
      
      // Check if game is full (max 3 joiners + 1 host = 4 total)
      if (game.players.size >= 3) {
        console.log(`❌ Game full: ${roomCode}`);
        return callback({ error: 'Game is full (4 players max)' });
      }
      
      // Add player to game
      game.players.set(socket.id, {
        name: name || 'Player',
        joinedAt: Date.now()
      });
      
      // Join socket to room
      socket.join(roomCode);
      socketRooms.set(socket.id, roomCode);
      
      console.log(`👤 Player joined: ${name} (${socket.id}) -> ${roomCode}`);
      console.log(`   Players in ${roomCode}: ${game.players.size + 1}/4`);
      
      // Notify host that player joined
      io.to(game.host).emit('player:joined', {
        playerId: socket.id,
        name: name || 'Player'
      });
      
      callback({ 
        success: true, 
        playerId: socket.id,
        playerCount: game.players.size + 1
      });
      
    } catch (error) {
      console.error('Error joining game:', error);
      callback({ error: 'Failed to join game' });
    }
  });
  
  // ========================================
  // HOST: Send game state update
  // ========================================
  socket.on('state:update', ({ code, state }) => {
    try {
      const roomCode = code.toUpperCase();
      const game = games.get(roomCode);
      
      // Validate
      if (!game) {
        console.log(`❌ State update for invalid game: ${roomCode}`);
        return;
      }
      
      if (socket.id !== game.host) {
        console.log(`❌ Non-host tried to update state: ${socket.id}`);
        return;
      }
      
      // Update state
      game.state = state;
      game.lastUpdate = Date.now();
      
      // Broadcast to all players in room (except host)
      socket.to(roomCode).emit('state:receive', state);
      
    } catch (error) {
      console.error('Error updating state:', error);
    }
  });
  
  // ========================================
  // PLAYER: Send input to host
  // ========================================
  socket.on('input:send', ({ code, input }) => {
    try {
      const roomCode = code.toUpperCase();
      const game = games.get(roomCode);
      
      // Validate
      if (!game) return;
      
      // Forward input to host
      io.to(game.host).emit('input:receive', {
        playerId: socket.id,
        input: input
      });
      
    } catch (error) {
      console.error('Error sending input:', error);
    }
  });
  
  // ========================================
  // DISCONNECT: Clean up
  // ========================================
  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
    
    const roomCode = socketRooms.get(socket.id);
    if (!roomCode) return;
    
    const game = games.get(roomCode);
    if (!game) return;
    
    // Check if disconnecting player was host
    if (socket.id === game.host) {
      console.log(`🏠 Host left game: ${roomCode}`);
      
      // Notify all players that game ended
      io.to(roomCode).emit('game:ended', {
        reason: 'Host disconnected'
      });
      
      // Delete game
      games.delete(roomCode);
      
      // Clean up all socket mappings
      for (const [socketId, code] of socketRooms.entries()) {
        if (code === roomCode) {
          socketRooms.delete(socketId);
        }
      }
      
      console.log(`🗑️  Game deleted: ${roomCode}`);
      
    } else {
      // Regular player left
      const player = game.players.get(socket.id);
      if (player) {
        console.log(`👋 Player left: ${player.name} from ${roomCode}`);
        
        game.players.delete(socket.id);
        socketRooms.delete(socket.id);
        
        // Notify host
        io.to(game.host).emit('player:left', {
          playerId: socket.id,
          name: player.name
        });
        
        console.log(`   Players in ${roomCode}: ${game.players.size + 1}/4`);
      }
    }
  });
  
  // ========================================
  // HOST: Kick player (optional)
  // ========================================
  socket.on('player:kick', ({ code, playerId }, callback) => {
    try {
      const roomCode = code.toUpperCase();
      const game = games.get(roomCode);
      
      // Validate host
      if (!game || socket.id !== game.host) {
        return callback({ error: 'Not authorized' });
      }
      
      const player = game.players.get(playerId);
      if (!player) {
        return callback({ error: 'Player not found' });
      }
      
      // Remove player
      game.players.delete(playerId);
      socketRooms.delete(playerId);
      
      // Notify kicked player
      io.to(playerId).emit('player:kicked', {
        reason: 'Kicked by host'
      });
      
      // Disconnect their socket
      const kickedSocket = io.sockets.sockets.get(playerId);
      if (kickedSocket) {
        kickedSocket.leave(roomCode);
      }
      
      console.log(`👢 Player kicked: ${player.name} from ${roomCode}`);
      
      callback({ success: true });
      
    } catch (error) {
      console.error('Error kicking player:', error);
      callback({ error: 'Failed to kick player' });
    }
  });
});

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Generate random 6-character room code
 * Uses alphanumeric (no confusing chars like O/0, I/1)
 */
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  
  // Generate random code
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  
  // Check if code already exists (very unlikely)
  if (games.has(code)) {
    return generateRoomCode(); // Recursively try again
  }
  
  return code;
}

/**
 * Clean up stale games (older than 30 minutes with no updates)
 */
function cleanupStaleGames() {
  const now = Date.now();
  const staleThreshold = 30 * 60 * 1000; // 30 minutes
  
  let cleaned = 0;
  
  for (const [code, game] of games.entries()) {
    if (now - game.lastUpdate > staleThreshold) {
      console.log(`🧹 Cleaning up stale game: ${code}`);
      
      // Notify players
      io.to(code).emit('game:ended', {
        reason: 'Game inactive for 30 minutes'
      });
      
      // Delete game
      games.delete(code);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Cleaned up ${cleaned} stale game(s)`);
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupStaleGames, 5 * 60 * 1000);

// ============================================
// STATUS LOGGING
// ============================================

// Log server stats every 60 seconds
setInterval(() => {
  const activeGames = games.size;
  let totalPlayers = 0;
  
  for (const game of games.values()) {
    totalPlayers += game.players.size + 1; // +1 for host
  }
  
  console.log(`📊 Server Status: ${activeGames} games, ${totalPlayers} players`);
}, 60 * 1000);

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

process.on('SIGTERM', () => {
  console.log('⚠️  SIGTERM received, shutting down gracefully...');
  
  // Notify all clients
  io.emit('server:shutdown', {
    message: 'Server is shutting down for maintenance'
  });
  
  // Close server
  io.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

console.log('✅ Zombie Shooter Server is running!');
console.log(`   Port: ${PORT}`);
console.log(`   Waiting for connections...`);
