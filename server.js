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
    rooms[newCode] = { isPublic: true, password: null, settings: { autoTurn: true, voice: false, manualResults: false }, players: [], hostId: null, status: 'waiting', chains: {}, readyPlayers: new Set(), currentTurn: 0, resultState: null };
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
        room.players.push({ id: socket.id, ...userData });
        if (room.players.length === 1) room.hostId = socket.id;
        socket.emit('joinedRoom', { roomCode: code, isHost: (room.hostId === socket.id) });
        io.to(code).emit('updateLobby', { players: room.players, hostId: room.hostId });
    }

    socket.on('joinRandom', (userData) => joinRoomLogic(getAvailableGenelRoom(), userData));
    
    socket.on('createRoom', (data) => {
        const code = generateCode();
        rooms[code] = { 
            isPublic: data.isPublic, 
            password: data.password || null,
            settings: data.settings || { autoTurn: true, voice: false, manualResults: false },
            players: [], hostId: null, status: 'waiting', 
            chains: {}, readyPlayers: new Set(), currentTurn: 0,
            resultState: null
        };
        joinRoomLogic(code, data.userData);
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

    socket.on('leaveRoom', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;
        socket.leave(roomCode);
        const index = room.players.findIndex(p => p.id === socket.id);
        if (index !== -1) {
            room.players.splice(index, 1);
            if(room.players.length === 0) { delete rooms[roomCode]; return; }
            if(room.hostId === socket.id) room.hostId = room.players[0].id;
            io.to(roomCode).emit('updateLobby', { players: room.players, hostId: room.hostId });
        }
    });

    socket.on('startGame', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id && room.players.length >= 2) {
            room.status = 'playing';
            room.players.forEach(p => { room.chains[p.id] = []; });
            room.resultState = null;
            io.to(roomCode).emit('startCountdown');
        }
    });

    socket.on('requestPhase1', (roomCode) => {
        const room = rooms[roomCode];
        if (room) {
            room.currentTurn = 0; room.readyPlayers.clear();
            io.to(roomCode).emit('startWritePhase');
        }
    });

    socket.on('toggleReady', (data) => {
        const room = rooms[data.roomCode];
        if(room) {
            if(data.isReady) room.readyPlayers.add(socket.id);
            else room.readyPlayers.delete(socket.id);
            io.to(data.roomCode).emit('readyCount', { ready: room.readyPlayers.size, total: room.players.length });
            if(room.readyPlayers.size === room.players.length) io.to(data.roomCode).emit('forceEndRound');
        }
    });

    socket.on('submitText', (data) => {
        const room = rooms[data.roomCode];
        if(room) {
            const targetChainId = data.targetChainId || socket.id;
            room.chains[targetChainId].push({ type: 'text', authorName: data.username, value: data.text });
            checkTurnCompletion(data.roomCode);
        }
    });

    socket.on('submitDrawing', (data) => {
        const room = rooms[data.roomCode];
        if(room) {
            room.chains[data.targetChainId].push({ type: 'image', authorName: data.username, value: data.image });
            checkTurnCompletion(data.roomCode);
        }
    });

    function checkTurnCompletion(roomCode) {
        const room = rooms[roomCode];
        const expectedItems = room.currentTurn + 1;
        let allDone = true;
        for (let pid in room.chains) { if (room.chains[pid].length < expectedItems) { allDone = false; break; } }
        if(allDone) {
            room.currentTurn++; room.readyPlayers.clear();
            io.to(roomCode).emit('readyCount', { ready: 0, total: room.players.length });
            if (room.currentTurn >= room.players.length) {
                room.status = 'results';
                io.to(roomCode).emit('gameFinished', { chains: room.chains, players: room.players, settings: room.settings });
                return;
            }
            const players = room.players;
            players.forEach((p, index) => {
                const chainOwnerIndex = (index - room.currentTurn + players.length * 100) % players.length;
                const targetChainOwnerId = players[chainOwnerIndex].id;
                const lastStep = room.chains[targetChainOwnerId][room.currentTurn - 1];
                if (lastStep.type === 'text') {
                    io.to(p.id).emit('startDrawPhase', { targetChainId: targetChainOwnerId, textToDraw: lastStep.value });
                } else {
                    io.to(p.id).emit('startGuessPhase', { targetChainId: targetChainOwnerId, imageToGuess: lastStep.value });
                }
            });
        }
    }

    socket.on('startResults', (roomCode) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;
        const chainIds = room.players.map(p => p.id);
        const maxSteps = Math.max(...chainIds.map(id => room.chains[id].length));
        room.resultState = { currentChainIndex: 0, currentStepIndex: 0, chains: chainIds, maxSteps: maxSteps, autoTimer: null };
        broadcastNextStep(roomCode);
    });

    socket.on('nextResult', (roomCode) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;
        if (room.resultState && room.resultState.autoTimer) clearTimeout(room.resultState.autoTimer);
        advanceResult(roomCode);
    });

    function advanceResult(roomCode) {
        const room = rooms[roomCode];
        if (!room || !room.resultState) return;
        const rs = room.resultState;
        const chainId = rs.chains[rs.currentChainIndex];
        const chain = room.chains[chainId];
        rs.currentStepIndex++;
        if (rs.currentStepIndex >= chain.length) {
            rs.currentChainIndex++;
            rs.currentStepIndex = 0;
            if (rs.currentChainIndex >= rs.chains.length) {
                io.to(roomCode).emit('resultsFinished');
                room.resultState = null;
                return;
            }
        }
        broadcastNextStep(roomCode);
    }

    function broadcastNextStep(roomCode) {
        const room = rooms[roomCode];
        if (!room || !room.resultState) return;
        const rs = room.resultState;
        const chainId = rs.chains[rs.currentChainIndex];
        const chain = room.chains[chainId];
        const step = chain[rs.currentStepIndex];
        const firstAuthor = room.players.find(p => p.id === chainId)?.username || 'Bilinmeyen';
        
        io.to(roomCode).emit('showResultStep', {
            chainOwner: firstAuthor,
            stepIndex: rs.currentStepIndex,
            totalSteps: chain.length,
            chainIndex: rs.currentChainIndex,
            totalChains: rs.chains.length,
            step: step,
            isLastStep: rs.currentStepIndex === chain.length - 1,
            isLastChain: rs.currentChainIndex === rs.chains.length - 1,
            avgSteps: rs.maxSteps,
            settings: room.settings
        });

        if (!room.settings.manualResults) {
            rs.autoTimer = setTimeout(() => advanceResult(roomCode), 6000);
        }
    }

    socket.on('returnToLobby', (roomCode) => {
        const room = rooms[roomCode];
        if (room) {
            room.status = 'waiting'; room.chains = {}; room.currentTurn = 0;
            room.readyPlayers.clear(); room.resultState = null;
            io.to(roomCode).emit('updateLobby', { players: room.players, hostId: room.hostId });
        }
    });

    socket.on('disconnect', () => {
        for (let code in rooms) {
            const index = rooms[code].players.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                rooms[code].players.splice(index, 1);
                if(rooms[code].players.length === 0) delete rooms[code];
                else {
                    if(rooms[code].hostId === socket.id && rooms[code].players.length > 0) {
                        rooms[code].hostId = rooms[code].players[0].id;
                    }
                    io.to(code).emit('updateLobby', { players: rooms[code].players, hostId: rooms[code].hostId });
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log('🔥 Render Fail Aktif! Port: ' + PORT); });