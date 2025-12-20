const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Aktivera CORS för HTTP requests
app.use(cors());
app.use(express.json());

// Servera statiska filer från 'public' mappen
app.use(express.static(path.join(__dirname, 'public')));

// Route för server status
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    games: games.size,
    players: getTotalPlayers(),
    uptime: process.uptime(),
    version: '1.0.0'
  });
});

// Route för att lista aktiva spel
app.get('/api/games', (req, res) => {
  const activeGames = Array.from(games.values()).map(game => ({
    id: game.id,
    host: game.players.find(p => p.isHost)?.name || 'Unknown',
    players: game.players.length,
    maxPlayers: 6,
    started: game.started,
    day: game.day
  }));
  
  res.json({ games: activeGames });
});

// Speldata i minnet
const games = new Map();

// Generera slumpmässigt game ID
function generateGameId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Utesluter förvirrande tecken
  let result = 'FRND';
  
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  return result;
}

// Hämta totalt antal spelare
function getTotalPlayers() {
  let total = 0;
  for (const game of games.values()) {
    total += game.players.length;
  }
  return total;
}

// Rensa gamla spel (automatskräpinsamling)
function cleanupOldGames() {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  
  for (const [gameId, game] of games.entries()) {
    if (game.started && game.lastActivity && (now - game.lastActivity > oneHour * 6)) {
      // Spel som inte varit aktiva på 6 timmar
      games.delete(gameId);
      console.log(`Rensade inaktivt spel: ${gameId}`);
    } else if (!game.started && game.createdAt && (now - game.createdAt > oneHour * 2)) {
      // Lobby som inte startat på 2 timmar
      games.delete(gameId);
      console.log(`Rensade ostartad lobby: ${gameId}`);
    }
  }
}

// Kör cleanup varje timme
setInterval(cleanupOldGames, 60 * 60 * 1000);

// Socket.io logik
io.on('connection', (socket) => {
  console.log(`Ny anslutning: ${socket.id} från ${socket.handshake.address}`);
  
  // Skicka välkomstmeddelande
  socket.emit('welcome', {
    message: 'Välkommen till Friendships Multiplayer!',
    serverTime: Date.now(),
    playerId: socket.id
  });
  
  // Skapa nytt spel
  socket.on('create_game', (data) => {
    try {
      if (!data.playerName || !data.avatar || !data.environment) {
        socket.emit('error', { message: 'Ogiltig data för att skapa spel' });
        return;
      }
      
      const gameId = generateGameId();
      
      const game = {
        id: gameId,
        hostId: socket.id,
        players: [{
          id: socket.id,
          name: data.playerName.substring(0, 20),
          avatar: data.avatar,
          environment: data.environment,
          isHost: true,
          time: 100,
          energy: 80,
          superEnergy: 50,
          connected: true
        }],
        currentTurn: null,
        day: 1,
        started: false,
        createdAt: Date.now(),
        lastActivity: Date.now()
      };
      
      games.set(gameId, game);
      
      // Gå med i game-rummet
      socket.join(gameId);
      
      // Skicka bekräftelse till klienten
      socket.emit('game_created', {
        gameId: gameId,
        playerName: data.playerName,
        players: game.players,
        message: 'Spel skapat! Dela koden med vänner.'
      });
      
      console.log(`Spel skapat: ${gameId} av ${data.playerName} (${socket.id})`);
      
    } catch (error) {
      console.error('Fel vid skapande av spel:', error);
      socket.emit('error', { message: 'Internt serverfel vid skapande av spel' });
    }
  });
  
  // Gå med i spel
  socket.on('join_game', (data) => {
    try {
      if (!data.gameId || !data.playerName || !data.avatar || !data.environment) {
        socket.emit('error', { message: 'Ogiltig data för att gå med i spel' });
        return;
      }
      
      const game = games.get(data.gameId.toUpperCase());
      
      if (!game) {
        socket.emit('error', { message: 'Spelet hittades inte. Kontrollera koden.' });
        return;
      }
      
      if (game.started) {
        socket.emit('error', { message: 'Spelet har redan startat' });
        return;
      }
      
      if (game.players.length >= 6) {
        socket.emit('error', { message: 'Spelet är fullt (max 6 spelare)' });
        return;
      }
      
      // Kontrollera om spelarnamnet redan finns
      const nameExists = game.players.some(p => p.name.toLowerCase() === data.playerName.toLowerCase());
      if (nameExists) {
        socket.emit('error', { message: 'Namnet är redan taget i detta spel' });
        return;
      }
      
      // Lägg till spelare
      const player = {
        id: socket.id,
        name: data.playerName.substring(0, 20),
        avatar: data.avatar,
        environment: data.environment,
        isHost: false,
        time: 100,
        energy: 80,
        superEnergy: 50,
        connected: true
      };
      
      game.players.push(player);
      game.lastActivity = Date.now();
      
      // Gå med i game-rummet
      socket.join(data.gameId);
      
      // Skicka välkomstmeddelande till ny spelare
      socket.emit('game_joined', {
        gameId: data.gameId,
        playerName: data.playerName,
        players: game.players,
        isHost: false,
        message: `Välkommen till ${gameId}! Väntar på att värd startar spelet.`
      });
      
      // Skicka uppdatering till alla i spelet
      io.to(data.gameId).emit('player_joined', {
        playerName: data.playerName,
        players: game.players,
        totalPlayers: game.players.length
      });
      
      console.log(`Spelare anslöt: ${data.playerName} till ${data.gameId} (Total: ${game.players.length})`);
      
    } catch (error) {
      console.error('Fel vid anslutning till spel:', error);
      socket.emit('error', { message: 'Internt serverfel vid anslutning till spel' });
    }
  });
  
  // Starta spel
  socket.on('start_game', (data) => {
    try {
      const game = games.get(data.gameId);
      
      if (!game) {
        socket.emit('error', { message: 'Spelet hittades inte' });
        return;
      }
      
      if (socket.id !== game.hostId) {
        socket.emit('error', { message: 'Endast värden kan starta spelet' });
        return;
      }
      
      if (game.players.length < 2) {
        socket.emit('error', { message: 'Behöver minst 2 spelare för att starta' });
        return;
      }
      
      game.started = true;
      game.currentTurn = game.players[0].id;
      game.day = 1;
      game.lastActivity = Date.now();
      
      // Skicka till alla spelare att spelet startat
      io.to(data.gameId).emit('game_started', {
        gameId: data.gameId,
        players: game.players,
        currentTurn: game.currentTurn,
        day: game.day,
        message: 'Spelet har startat!'
      });
      
      console.log(`Spel startat: ${data.gameId} med ${game.players.length} spelare`);
      
    } catch (error) {
      console.error('Fel vid start av spel:', error);
      socket.emit('error', { message: 'Internt serverfel vid start av spel' });
    }
  });
  
  // Spelarhandling
  socket.on('player_action', (data) => {
    try {
      const game = games.get(data.gameId);
      
      if (!game || !game.started) return;
      
      // Uppdatera spelarens status
      const playerIndex = game.players.findIndex(p => p.id === data.playerId);
      if (playerIndex !== -1) {
        game.players[playerIndex].time = data.time;
        game.players[playerIndex].energy = data.energy;
        game.players[playerIndex].superEnergy = data.superEnergy;
        game.lastActivity = Date.now();
      }
      
      // Skicka uppdatering till alla utom avsändaren
      socket.to(data.gameId).emit('player_action', {
        playerId: data.playerId,
        playerName: game.players[playerIndex]?.name || 'Spelare',
        actionId: data.actionId,
        friendName: data.friendName,
        time: data.time,
        energy: data.energy,
        superEnergy: data.superEnergy,
        timestamp: Date.now()
      });
      
    } catch (error) {
      console.error('Fel vid spelarhandling:', error);
    }
  });
  
  // Hjälp spelare
  socket.on('help_player', (data) => {
    try {
      const game = games.get(data.gameId);
      
      if (!game || !game.started) return;
      
      // Hitta spelare
      const helperIndex = game.players.findIndex(p => p.id === data.playerId);
      const targetIndex = game.players.findIndex(p => p.id === data.targetId);
      
      if (helperIndex === -1 || targetIndex === -1) return;
      
      // Uppdatera energi
      game.players[targetIndex].energy = Math.min(100, game.players[targetIndex].energy + data.energyBonus);
      game.lastActivity = Date.now();
      
      // Skicka uppdatering till alla
      io.to(data.gameId).emit('player_helped', {
        helperId: data.playerId,
        helperName: game.players[helperIndex].name,
        targetId: data.targetId,
        targetName: game.players[targetIndex].name,
        newEnergy: game.players[targetIndex].energy,
        timestamp: Date.now()
      });
      
    } catch (error) {
      console.error('Fel vid hjälp till spelare:', error);
    }
  });
  
  // Dela superenergi
  socket.on('share_super', (data) => {
    try {
      const game = games.get(data.gameId);
      
      if (!game || !game.started) return;
      
      // Hitta spelare
      const sharerIndex = game.players.findIndex(p => p.id === data.playerId);
      const targetIndex = game.players.findIndex(p => p.id === data.targetId);
      
      if (sharerIndex === -1 || targetIndex === -1) return;
      
      // Uppdatera superenergi
      game.players[targetIndex].superEnergy = Math.min(100, game.players[targetIndex].superEnergy + data.superBonus);
      game.lastActivity = Date.now();
      
      // Skicka uppdatering till alla
      io.to(data.gameId).emit('super_shared', {
        sharerId: data.playerId,
        sharerName: game.players[sharerIndex].name,
        targetId: data.targetId,
        targetName: game.players[targetIndex].name,
        newSuperEnergy: game.players[targetIndex].superEnergy,
        timestamp: Date.now()
      });
      
    } catch (error) {
      console.error('Fel vid delning av superenergi:', error);
    }
  });
  
  // Byt miljö
  socket.on('change_environment', (data) => {
    try {
      const game = games.get(data.gameId);
      
      if (!game || !game.started) return;
      
      // Hitta spelare
      const playerIndex = game.players.findIndex(p => p.id === data.playerId);
      if (playerIndex === -1) return;
      
      // Uppdatera miljö och tid
      game.players[playerIndex].environment = data.newEnvironment;
      game.players[playerIndex].time = data.newTime;
      game.lastActivity = Date.now();
      
      // Skicka uppdatering till alla
      io.to(data.gameId).emit('environment_changed', {
        playerId: data.playerId,
        playerName: game.players[playerIndex].name,
        newEnvironment: data.newEnvironment,
        newTime: data.newTime,
        timestamp: Date.now()
      });
      
    } catch (error) {
      console.error('Fel vid byte av miljö:', error);
    }
  });
  
  // Avsluta tur
  socket.on('turn_ended', (data) => {
    try {
      const game = games.get(data.gameId);
      
      if (!game || !game.started) return;
      
      // Uppdatera spelarens status
      const playerIndex = game.players.findIndex(p => p.id === data.playerId);
      if (playerIndex !== -1) {
        game.players[playerIndex].time = data.time;
        game.players[playerIndex].energy = data.energy;
        game.players[playerIndex].superEnergy = data.superEnergy;
      }
      
      // Nästa spelares tur
      const currentIndex = game.players.findIndex(p => p.id === game.currentTurn);
      let nextIndex = 0;
      
      if (currentIndex !== -1) {
        nextIndex = (currentIndex + 1) % game.players.length;
      }
      
      game.currentTurn = game.players[nextIndex]?.id || game.players[0]?.id;
      
      // Nästa dag om alla har spelat
      if (nextIndex === 0 && currentIndex !== -1) {
        game.day++;
      }
      
      game.lastActivity = Date.now();
      
      // Skicka uppdatering till alla
      io.to(data.gameId).emit('turn_ended', {
        players: game.players.map(p => ({
          id: p.id,
          name: p.name,
          avatar: p.avatar,
          environment: p.environment,
          isHost: p.isHost,
          time: p.time,
          energy: p.energy,
          superEnergy: p.superEnergy
        })),
        currentTurn: game.currentTurn,
        currentPlayerName: game.players.find(p => p.id === game.currentTurn)?.name || 'Okänd',
        day: game.day,
        timestamp: Date.now()
      });
      
    } catch (error) {
      console.error('Fel vid avslut av tur:', error);
    }
  });
  
  // Chattmeddelande
  socket.on('chat_message', (data) => {
    try {
      const game = games.get(data.gameId);
      
      if (!game) return;
      
      // Hitta spelarens namn
      const player = game.players.find(p => p.id === data.playerId);
      if (!player) return;
      
      game.lastActivity = Date.now();
      
      // Validera meddelande
      const message = data.message.toString().substring(0, 200).trim();
      if (!message) return;
      
      // Skicka till alla i spelet
      io.to(data.gameId).emit('chat_message', {
        playerId: data.playerId,
        playerName: player.name,
        message: message,
        timestamp: Date.now()
      });
      
    } catch (error) {
      console.error('Fel vid chattmeddelande:', error);
    }
  });
  
  // Ping/pong för att hålla anslutningen vid liv
  socket.on('ping', (data) => {
    socket.emit('pong', { timestamp: Date.now(), ...data });
  });
  
  // Uppdatera spelarstatus
  socket.on('update_status', (data) => {
    try {
      const game = games.get(data.gameId);
      
      if (!game) return;
      
      const playerIndex = game.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        game.players[playerIndex].connected = true;
        game.lastActivity = Date.now();
      }
    } catch (error) {
      console.error('Fel vid uppdatering av status:', error);
    }
  });
  
  // Återanslut till spel
  socket.on('rejoin_game', (data) => {
    try {
      const game = games.get(data.gameId);
      
      if (!game) {
        socket.emit('error', { message: 'Spelet hittades inte' });
        return;
      }
      
      const player = game.players.find(p => p.id === data.playerId);
      if (!player) {
        socket.emit('error', { message: 'Spelare hittades inte i detta spel' });
        return;
      }
      
      // Uppdatera spelarstatus
      player.connected = true;
      game.lastActivity = Date.now();
      
      // Gå med i rummet igen
      socket.join(data.gameId);
      
      // Skicka aktuellt spelstatus
      socket.emit('game_rejoined', {
        gameId: data.gameId,
        players: game.players,
        currentTurn: game.currentTurn,
        day: game.day,
        playerName: player.name,
        isHost: player.isHost,
        message: 'Återansluten till spelet!'
      });
      
      // Meddela andra spelare
      socket.to(data.gameId).emit('player_reconnected', {
        playerName: player.name,
        players: game.players
      });
      
      console.log(`Spelare återanslöt: ${player.name} till ${data.gameId}`);
      
    } catch (error) {
      console.error('Fel vid återanslutning till spel:', error);
      socket.emit('error', { message: 'Internt serverfel vid återanslutning' });
    }
  });
  
  // Lämna spel (manuellt)
  socket.on('leave_game', (data) => {
    try {
      const game = games.get(data.gameId);
      
      if (!game) return;
      
      const playerIndex = game.players.findIndex(p => p.id === socket.id);
      if (playerIndex === -1) return;
      
      const playerName = game.players[playerIndex].name;
      
      // Ta bort spelaren
      game.players.splice(playerIndex, 1);
      game.lastActivity = Date.now();
      
      // Om spelet är tomt, ta bort det
      if (game.players.length === 0) {
        games.delete(data.gameId);
        console.log(`Spel ${data.gameId} borttaget (inga spelare kvar)`);
        return;
      }
      
      // Om värd lämnade, gör nästa spelare till värd
      if (socket.id === game.hostId && game.players.length > 0) {
        game.hostId = game.players[0].id;
        game.players[0].isHost = true;
      }
      
      // Uppdatera tur om nödvändigt
      if (game.currentTurn === socket.id) {
        const nextIndex = 0; // Börja om från första spelaren
        game.currentTurn = game.players[nextIndex]?.id || null;
      }
      
      // Lämna rummet
      socket.leave(data.gameId);
      
      // Skicka uppdatering till återstående spelare
      io.to(data.gameId).emit('player_left', {
        playerName: playerName,
        players: game.players,
        newHostId: game.hostId,
        timestamp: Date.now()
      });
      
      console.log(`Spelare lämnade: ${playerName} från ${data.gameId} (${game.players.length} kvar)`);
      
    } catch (error) {
      console.error('Fel vid lämnande av spel:', error);
    }
  });
  
  // Hantera frånkoppling
  socket.on('disconnect', (reason) => {
    console.log(`Anslutning bröts: ${socket.id} - Orsak: ${reason}`);
    
    // Markera spelare som frånkopplad i alla spel
    for (const [gameId, game] of games.entries()) {
      const playerIndex = game.players.findIndex(p => p.id === socket.id);
      
      if (playerIndex !== -1) {
        const playerName = game.players[playerIndex].name;
        
        // Markera som frånkopplad istället för att ta bort direkt
        game.players[playerIndex].connected = false;
        game.lastActivity = Date.now();
        
        // Meddela andra spelare om frånkoppling
        socket.to(gameId).emit('player_disconnected', {
          playerName: playerName,
          players: game.players,
          timestamp: Date.now()
        });
        
        console.log(`Spelare frånkopplad: ${playerName} från ${gameId}`);
        
        // Starta timeout för att ta bort frånkopplade spelare
        setTimeout(() => {
          const game = games.get(gameId);
          if (!game) return;
          
          const stillDisconnectedIndex = game.players.findIndex(p => p.id === socket.id && !p.connected);
          if (stillDisconnectedIndex === -1) return;
          
          // Ta bort spelaren permanent om de fortfarande är frånkopplade
          game.players.splice(stillDisconnectedIndex, 1);
          
          if (game.players.length === 0) {
            games.delete(gameId);
            console.log(`Spel ${gameId} borttaget (alla spelare frånkopplade)`);
          } else {
            // Om värd lämnade, gör nästa spelare till värd
            if (socket.id === game.hostId) {
              game.hostId = game.players[0].id;
              game.players[0].isHost = true;
            }
            
            // Uppdatera tur om nödvändigt
            if (game.currentTurn === socket.id) {
              game.currentTurn = game.players[0]?.id || null;
            }
            
            // Skicka uppdatering
            io.to(gameId).emit('player_left', {
              playerName: playerName,
              players: game.players,
              newHostId: game.hostId,
              timestamp: Date.now(),
              reason: 'timeout'
            });
            
            console.log(`Spelare borttagen pga timeout: ${playerName} från ${gameId}`);
          }
        }, 30000); // 30 sekunder timeout
        
        break;
      }
    }
  });
});

// Felhantering för servern
server.on('error', (error) => {
  console.error('Server error:', error);
});

// Starta server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`=== Friendships Multiplayer Server ===`);
  console.log(`Server körs på port ${PORT}`);
  console.log(`Tid: ${new Date().toLocaleString()}`);
  console.log(`PID: ${process.pid}`);
  console.log(`===============================`);
});

// Hantera process avslut
process.on('SIGINT', () => {
  console.log('\nAvslutar server...');
  console.log(`Sparade ${games.size} aktiva spel`);
  server.close(() => {
    console.log('Server avslutad.');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\nMottog SIGTERM, avslutar...');
  server.close(() => {
    process.exit(0);
  });
});