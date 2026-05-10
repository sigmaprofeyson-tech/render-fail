const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static('public'));

let rooms = {};
let genelIndex = 1;
const MAX_PLAYERS = 14;

function getAvailableGenelRoom() {
    for (let code in rooms) {
        if (code.startsWith('GENEL') && rooms[code].status === 'waiting' && rooms[code].players.length < MAX_PLAYERS) {
            return code;
        }
    }
    let newCode = 'GENEL' + genelIndex;
    while(rooms[newCode]) { genelIndex++; newCode = 'GENEL' + genelIndex; }
    rooms[newCode] = { 
        isPublic: true, password: null, settings: {}, 
        lobbySettings: { startMode: 'text', turns: 'auto', timeMode: 'normal' },
        players: [], hostId: null, status: 'waiting', chains: {}, readyPlayers: new Set(), currentTurn: 0, resultState: null 
    };
    return newCode;
}

function generateCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    do { code = ''; for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length)); } while (rooms[code]);
    return code;
}

io.on('connection', (socket) => {
    function joinRoomLogic(code, userData, passwordAttempt) {
        const room = rooms[code];
        if (!room) { socket.emit('errorMsg', 'Lobi bulunamadi!'); return; }
        if (room.players.length >= MAX_PLAYERS) { socket.emit('errorMsg', 'Oda dolu! (Max: ' + MAX_PLAYERS + ')'); return; }
        if (room.password && room.password !== passwordAttempt) { socket.emit('errorMsg', 'Sifre yanlis!'); return; }
        
        socket.join(code);
        room.players.push({ id: socket.id, inLobby: true, ...userData });
        if (room.players.length === 1) room.hostId = socket.id;
        
        socket.emit('joinedRoom', { roomCode: code, isHost: (room.hostId === socket.id) });
        socket.emit('updateSettings', room.lobbySettings); 
        io.to(code).emit('updateLobby', { players: room.players, hostId: room.hostId });
    }

    socket.on('joinRandom', (userData) => joinRoomLogic(getAvailableGenelRoom(), userData));
    
    socket.on('createRoom', (data) => {
        const code = generateCode();
        rooms[code] = { 
            isPublic: data.isPublic, 
            password: data.password || null,
            settings: {},
            lobbySettings: { startMode: 'text', turns: 'auto', timeMode: 'normal' },
            players: [], hostId: null, status: 'waiting', 
            chains: {}, readyPlayers: new Set(), currentTurn: 0,
            resultState: null
        };
        joinRoomLogic(code, data.userData, data.password);
    });

    socket.on('joinWithCode', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            if (room.status === 'playing') socket.emit('errorMsg', 'Oyun basladi, kapi kilitli!');
            else joinRoomLogic(data.roomCode, data.userData, data.password);
        } else socket.emit('errorMsg', 'Lobi bulunamadi!');
    });

    socket.on('getPublicRooms', () => {
        const list = [];
        for (let code in rooms) {
            if (rooms[code].isPublic && rooms[code].status === 'waiting') {
                list.push({ code, playerCount: rooms[code].players.length, maxPlayers: MAX_PLAYERS, hasPassword: !!rooms[code].password });
            }
        }
        socket.emit('publicRoomsList', list);
    });

    socket.on('sendMessage', (data) => {
        if (rooms[data.roomCode]) {
            io.to(data.roomCode).emit('receiveMessage', { sender: data.username, message: data.message, color: data.color });
        }
    });

    socket.on('changeSettings', (data) => {
        const room = rooms[data.roomCode];
        if(room && room.hostId === socket.id && room.status === 'waiting') {
            room.lobbySettings = data.settings;
            io.to(data.roomCode).emit('updateSettings', room.lobbySettings);
        }
    });

    socket.on('startGame', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id && room.players.length >= 2) {
            if (room.players.some(p => !p.inLobby)) {
                socket.emit('errorMsg', 'Tüm oyuncular lobiye dönmeden oyun başlatılamaz!');
                return;
            }
            room.status = 'playing';
            room.players.forEach(p => { room.chains[p.id] = []; });
            room.resultState = null;
            io.to(roomCode).emit('startCountdown');
        }
    });

    socket.on('requestPhase1', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.status === 'playing') {
            room.currentTurn = 0; room.readyPlayers.clear();
            if (room.lobbySettings.startMode === 'draw') {
                io.to(roomCode).emit('startFreeDrawPhase', { settings: room.lobbySettings });
            } else {
                io.to(roomCode).emit('startWritePhase', { settings: room.lobbySettings });
            }
        }
    });

    socket.on('toggleReady', (data) => {
        const room = rooms[data.roomCode];
        if(room && room.status === 'playing') {
            if(data.isReady) room.readyPlayers.add(socket.id);
            else room.readyPlayers.delete(socket.id);
            io.to(data.roomCode).emit('readyCount', { ready: room.readyPlayers.size, total: room.players.length });
            if(room.readyPlayers.size === room.players.length) io.to(data.roomCode).emit('forceEndRound');
        }
    });

    socket.on('submitText', (data) => {
        const room = rooms[data.roomCode];
        if(room && room.status === 'playing') {
            const targetChainId = data.targetChainId || socket.id;
            if(room.chains[targetChainId]) {
                room.chains[targetChainId].push({ type: 'text', author: data.username, actionText: 'şunu yazdı:', value: data.text });
                checkTurnCompletion(data.roomCode);
            }
        }
    });

    socket.on('submitDrawing', (data) => {
        const room = rooms[data.roomCode];
        if(room && room.status === 'playing') {
            const targetChainId = data.targetChainId || socket.id;
            if(room.chains[targetChainId]) {
                room.chains[targetChainId].push({ type: 'image', author: data.username, actionText: 'şunu çizdi:', value: data.image });
                checkTurnCompletion(data.roomCode);
            }
        }
    });

    function checkTurnCompletion(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;
        const expectedItems = room.currentTurn + 1;
        let allDone = true;
        
        for (let pid in room.chains) { 
            if (room.chains[pid].length < expectedItems) { allDone = false; break; } 
        }
        
        if(allDone) {
            room.currentTurn++; 
            room.readyPlayers.clear();
            io.to(roomCode).emit('readyCount', { ready: 0, total: room.players.length });
            
            let maxTurns = room.lobbySettings.turns === 'auto' ? room.players.length : parseInt(room.lobbySettings.turns);
            if (maxTurns > room.players.length) maxTurns = room.players.length;

            if (room.currentTurn >= maxTurns) {
                room.status = 'results';
                room.players.forEach(p => p.inLobby = false);
                io.to(roomCode).emit('updateLobby', { players: room.players, hostId: room.hostId });
                io.to(roomCode).emit('gameFinished', { chains: room.chains, players: room.players });
                return;
            }
            
            const players = room.players;
            players.forEach((p, index) => {
                const chainOwnerIndex = (index - room.currentTurn + players.length * 100) % players.length;
                const targetChainOwnerId = players[chainOwnerIndex].id;
                const lastStep = room.chains[targetChainOwnerId][room.currentTurn - 1];
                if (lastStep.type === 'text') {
                    io.to(p.id).emit('startDrawPhase', { targetChainId: targetChainOwnerId, textToDraw: lastStep.value, settings: room.lobbySettings });
                } else {
                    io.to(p.id).emit('startGuessPhase', { targetChainId: targetChainOwnerId, imageToGuess: lastStep.value, settings: room.lobbySettings });
                }
            });
        }
    }

    socket.on('startResults', (data) => {
        const room = rooms[data.roomCode];
        if (!room || room.hostId !== socket.id) return;
        room.settings = data.settings || { manualResults: true, voice: false };
        const chainIds = room.players.map(p => p.id);
        const maxSteps = Math.max(...chainIds.map(id => room.chains[id].length));
        room.resultState = { currentChainIndex: 0, currentStepIndex: 0, chains: chainIds, maxSteps: maxSteps, autoTimer: null, phase: 'intro' };
        broadcastResultState(data.roomCode);
    });

    socket.on('nextResult', (roomCode) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id || !room.resultState) return;
        if (room.resultState.phase !== 'step') return; 
        if (room.resultState.autoTimer) clearTimeout(room.resultState.autoTimer);
        advanceResult(roomCode);
    });

    socket.on('nextChain', (roomCode) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;
        if (room.resultState) {
            if (room.resultState.autoTimer) clearTimeout(room.resultState.autoTimer);
            room.resultState.currentChainIndex++;
            if (room.resultState.currentChainIndex >= room.resultState.chains.length) {
                io.to(roomCode).emit('resultsFinished');
                room.resultState = null;
            } else {
                room.resultState.phase = 'intro';
                room.resultState.currentStepIndex = 0;
                broadcastResultState(roomCode);
            }
        }
    });

    function advanceResult(roomCode) {
        const room = rooms[roomCode];
        if (!room || !room.resultState) return;
        const rs = room.resultState;
        if (rs.phase === 'intro') { rs.phase = 'step'; rs.currentStepIndex = 0; } 
        else if (rs.phase === 'step') {
            rs.currentStepIndex++;
            const chainId = rs.chains[rs.currentChainIndex];
            if (rs.currentStepIndex >= room.chains[chainId].length) rs.phase = 'endOfChain'; 
        }
        broadcastResultState(roomCode);
    }

    function broadcastResultState(roomCode) {
        const room = rooms[roomCode];
        if (!room || !room.resultState) return;
        const rs = room.resultState;
        if (rs.autoTimer) clearTimeout(rs.autoTimer);
        const chainId = rs.chains[rs.currentChainIndex];
        const chainOwner = room.players.find(p => p.id === chainId)?.username || 'Bilinmeyen';

        if (rs.phase === 'intro') {
            io.to(roomCode).emit('showResultIntro', { chainOwner: chainOwner, settings: room.settings });
            rs.autoTimer = setTimeout(() => advanceResult(roomCode), 3500);
        } else if (rs.phase === 'step') {
            io.to(roomCode).emit('showResultStep', {
                chainOwner: chainOwner, stepIndex: rs.currentStepIndex, totalSteps: room.chains[chainId].length,
                chainIndex: rs.currentChainIndex, totalChains: rs.chains.length, step: room.chains[chainId][rs.currentStepIndex],
                avgSteps: rs.maxSteps, settings: room.settings
            });
            if (!room.settings.manualResults) rs.autoTimer = setTimeout(() => advanceResult(roomCode), 5500);
        } else if (rs.phase === 'endOfChain') {
            io.to(roomCode).emit('showEndOfChain', { chainOwner: chainOwner, isLastChain: rs.currentChainIndex === rs.chains.length - 1 });
        }
    }

    socket.on('returnToLobby', (roomCode) => {
        const room = rooms[roomCode];
        if (room) {
            const player = room.players.find(p => p.id === socket.id);
            if(player) player.inLobby = true;
            if (room.players.every(p => p.inLobby)) {
                room.status = 'waiting'; room.chains = {}; room.currentTurn = 0;
                room.readyPlayers.clear(); room.resultState = null;
            }
            io.to(roomCode).emit('updateLobby', { players: room.players, hostId: room.hostId });
        }
    });

    socket.on('disconnect', () => {
        for (let code in rooms) {
            const room = rooms[code];
            const index = room.players.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                if (room.status === 'playing' || room.status === 'results') {
                    io.to(code).emit('errorMsg', 'Bir oyuncu bağlantıyı kopardığı için lobiye dönüldü!');
                    room.status = 'waiting'; room.chains = {}; room.currentTurn = 0;
                    room.readyPlayers.clear(); room.resultState = null;
                    io.to(code).emit('returnToLobbyClient');
                }
                room.players.splice(index, 1);
                if(room.players.length === 0) delete rooms[code];
                else {
                    if(room.hostId === socket.id && room.players.length > 0) room.hostId = room.players[0].id;
                    io.to(code).emit('updateLobby', { players: room.players, hostId: room.hostId });
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log('🔥 Çizim Mizim Aktif! Port: ' + PORT); });