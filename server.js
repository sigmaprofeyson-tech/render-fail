const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

app.get('/api/profiles', (req, res) => {
    let profilesPath = path.join(__dirname, 'public', 'profiles');
    if (!fs.existsSync(profilesPath)) {
        profilesPath = path.join(__dirname, 'profiles');
    }

    if (fs.existsSync(profilesPath)) {
        const files = fs.readdirSync(profilesPath).filter(f => {
            const ext = f.toLowerCase();
            return ext.endsWith('.png') || ext.endsWith('.jpg') || ext.endsWith('.jpeg') || ext.endsWith('.webp') || ext.endsWith('.gif');
        });
        
        if (files.length > 0) {
            res.json(files);
        } else {
            res.json(['1.png']);
        }
    } else {
        res.json(['1.png']);
    }
});

const rooms = {};

function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return code;
}

function updateLobby(roomCode) {
    if (!rooms[roomCode]) return;
    const room = rooms[roomCode];
    if (room.status === 'intermission') {
        io.to(roomCode).emit('updateIntermissionLobby', { players: room.players, hostId: room.hostId });
    } else if (room.status === 'waiting') {
        io.to(roomCode).emit('updateLobby', { players: room.players, hostId: room.hostId });
    }
}

function getPublicRoomsList() {
    return Object.keys(rooms).filter(code => rooms[code].isPublic && rooms[code].status === 'waiting').map(code => ({
        code: code,
        playerCount: rooms[code].players.filter(p => p.inLobby).length,
        maxPlayers: 14,
        hasPassword: rooms[code].password !== ''
    }));
}

io.on('connection', (socket) => {

    socket.on('getPublicRooms', () => {
        socket.emit('publicRoomsList', getPublicRoomsList());
    });

    socket.on('joinRandom', (userData) => {
        const publicRooms = Object.keys(rooms).filter(c => rooms[c].isPublic && rooms[c].status === 'waiting' && rooms[c].password === '');
        if (publicRooms.length > 0) {
            const targetRoom = publicRooms[Math.floor(Math.random() * publicRooms.length)];
            joinRoomLogic(socket, targetRoom, userData, '');
        } else {
            createRoomLogic(socket, userData, true, '');
        }
    });

    socket.on('createRoom', (data) => {
        createRoomLogic(socket, data.userData, data.isPublic, data.password);
    });

    function createRoomLogic(socket, userData, isPublic, password) {
        let roomCode;
        do { roomCode = generateRoomCode(); } while (rooms[roomCode]);

        rooms[roomCode] = {
            code: roomCode,
            hostId: socket.id,
            isPublic: isPublic,
            password: password || '',
            status: 'waiting',
            players: [],
            settings: {
                gameMode: 'yazciz',
                startMode: 'text',
                turns: 'auto',
                timeMode: 'normal'
            },
            chains: {},
            currentRound: 0,
            totalRounds: 0,
            readyCount: 0,
            submissions: 0,
            scores: {}
        };

        joinRoomLogic(socket, roomCode, userData, password);
        io.emit('publicRoomsList', getPublicRoomsList());
    }

    socket.on('joinWithCode', (data) => {
        joinRoomLogic(socket, data.roomCode.toUpperCase(), data.userData, data.password || '');
    });

    function joinRoomLogic(socket, roomCode, userData, password) {
        const room = rooms[roomCode];
        if (!room) return socket.emit('errorMsg', 'Böyle bir oda bulunamadı!');
        if (room.status === 'playing' || room.status === 'results') return socket.emit('errorMsg', 'Bu odada şu an oyun oynanıyor!');
        if (room.password !== '' && room.password !== password && room.hostId !== socket.id) return socket.emit('errorMsg', 'Hatalı şifre!');
        
        const existingPlayer = room.players.find(p => p.username === userData.username);
        const activePlayersCount = room.players.filter(p => p.inLobby).length;
        
        if (!existingPlayer && activePlayersCount >= 14) {
            return socket.emit('errorMsg', 'Bu oda tamamen dolu! (Max 14)');
        }

        if (existingPlayer) {
            existingPlayer.id = socket.id;
            existingPlayer.inLobby = true;
        } else {
            room.players.push({
                id: socket.id,
                username: userData.username,
                avatar: userData.avatar,
                inLobby: true,
                isSpectator: false,
                score: 0
            });
        }

        socket.join(roomCode);
        socket.roomId = roomCode;
        
        socket.emit('joinedRoom', { roomCode: roomCode, isHost: room.hostId === socket.id, status: room.status });
        socket.emit('updateSettings', room.settings);
        updateLobby(roomCode);
        io.emit('publicRoomsList', getPublicRoomsList()); 
    }

    socket.on('changeSettings', (data) => {
        const room = rooms[data.roomCode];
        if (room && room.hostId === socket.id) {
            room.settings = data.settings;
            io.to(data.roomCode).emit('updateSettings', room.settings);
        }
    });

    socket.on('sendMessage', (data) => {
        if (rooms[data.roomCode]) {
            io.to(data.roomCode).emit('receiveMessage', { sender: data.username, message: data.message, color: data.color });
        }
    });

    socket.on('startGame', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            
            // KONTROL 1: Herkes tam olarak lobiye gelmediyse oyunu başlatma
            if (!room.players.every(p => p.inLobby)) {
                return socket.emit('errorMsg', 'Herkes lobiye tam olarak bağlanmadan oyunu başlatamazsın!');
            }

            // KONTROL 2: Oyun baştan (waiting state'den) başlıyorsa herkesi dirilt.
            if (room.status === 'waiting') {
                room.players.forEach(p => { p.isSpectator = false; p.score = 0; });
            }

            room.status = 'playing';
            const activePlayers = room.players.filter(p => !p.isSpectator && p.inLobby);
            
            if (activePlayers.length < 2) {
                room.players.forEach(p => p.isSpectator = false);
            }

            room.chains = {};
            room.scores = {};
            
            const playingNow = room.players.filter(p => !p.isSpectator && p.inLobby);
            playingNow.forEach(p => {
                room.chains[p.id] = { owner: p.username, steps: [] };
                if(room.scores[p.id] === undefined) room.scores[p.id] = 0;
            });

            if (room.settings.gameMode === 'memesel') {
                room.totalRounds = 2;
            } else {
                room.totalRounds = room.settings.turns === 'auto' ? playingNow.length : parseInt(room.settings.turns);
            }
            
            room.currentRound = 0;
            io.to(roomCode).emit('startCountdown');
        }
    });

    socket.on('requestPhase1', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id && room.currentRound === 0) {
            room.currentRound = 1;
            startRound(roomCode);
        }
    });

    socket.on('toggleReady', (data) => {
        const room = rooms[data.roomCode];
        if (room && room.status === 'playing') {
            room.readyCount += data.isReady ? 1 : -1;
            const activePlayers = room.players.filter(p => !p.isSpectator && p.inLobby).length;
            io.to(data.roomCode).emit('readyCount', { ready: room.readyCount, total: activePlayers });

            if (room.readyCount >= activePlayers) {
                room.readyCount = 0;
                io.to(data.roomCode).emit('forceEndRound');
            }
        }
    });
    
    function handleSubmission(roomCode, playerId, targetChainId, stepData) {
        const room = rooms[roomCode];
        if (!room) return;
        
        let chainTarget = targetChainId || playerId;
        if (room.chains[chainTarget]) {
            room.chains[chainTarget].steps.push(stepData);
        }
        
        room.submissions++;
        const activePlayers = room.players.filter(p => !p.isSpectator && p.inLobby).length;
        
        if (room.submissions >= activePlayers) {
            room.submissions = 0;
            room.readyCount = 0;
            room.currentRound++;
            
            if (room.currentRound > room.totalRounds) {
                room.status = 'results';
                io.to(roomCode).emit('gameFinished', { 
                    chains: room.chains, 
                    players: room.players, 
                    gameMode: room.settings.gameMode 
                });
            } else {
                startRound(roomCode);
            }
        }
    }

    socket.on('submitText', (data) => {
        handleSubmission(data.roomCode, socket.id, data.targetChainId, {
            type: 'text',
            value: data.text,
            author: data.username,
            actionText: rooms[data.roomCode].currentRound === 1 ? 'yazdı:' : 'tahmin etti:'
        });
    });

    socket.on('submitDrawing', (data) => {
        handleSubmission(data.roomCode, socket.id, data.targetChainId, {
            type: 'image',
            value: data.image,
            author: data.username,
            actionText: 'çizdi:'
        });
    });

    socket.on('submitMemeselTemplate', (data) => {
        handleSubmission(data.roomCode, socket.id, socket.id, {
            type: 'template',
            value: data.image,
            boxes: data.boxes,
            author: 'Bilinmeyen' 
        });
    });

    socket.on('submitMemeselFill', (data) => {
        const uName = rooms[data.roomCode].players.find(p => p.id === socket.id).username;
        handleSubmission(data.roomCode, socket.id, data.targetChainId, {
            type: 'image',
            value: data.finalImage,
            author: uName,
            actionText: 'miimi hazırladı:'
        });
    });

    function startRound(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;
        
        room.readyCount = 0;
        room.submissions = 0;
        const activePlayers = room.players.filter(p => !p.isSpectator && p.inLobby);
        
        io.to(roomCode).emit('readyCount', { ready: 0, total: activePlayers.length });

        if (room.settings.gameMode === 'memesel') {
            if (room.currentRound === 1) {
                io.to(roomCode).emit('startMemeselDrawPhase', { settings: room.settings });
            } else if (room.currentRound === 2) {
                activePlayers.forEach((p, i) => {
                    const targetPlayerId = activePlayers[(i + 1) % activePlayers.length].id;
                    const chain = room.chains[targetPlayerId];
                    const templateData = chain.steps[0];
                    io.to(p.id).emit('startMemeselFillPhase', {
                        targetChainId: targetPlayerId,
                        templateImage: templateData.value || templateData.image, 
                        boxes: templateData.boxes,
                        settings: room.settings
                    });
                });
            }
        } else {
            activePlayers.forEach((p, i) => {
                const targetIdx = (i - (room.currentRound - 1) + activePlayers.length * 10) % activePlayers.length;
                const targetPlayerId = activePlayers[targetIdx].id;
                const chain = room.chains[targetPlayerId];

                if (room.currentRound === 1) {
                    if (room.settings.startMode === 'text') {
                        io.to(p.id).emit('startWritePhase', { settings: room.settings });
                    } else {
                        io.to(p.id).emit('startFreeDrawPhase', { settings: room.settings });
                    }
                } else {
                    const lastStep = chain.steps[chain.steps.length - 1];
                    if (lastStep.type === 'text') {
                        io.to(p.id).emit('startDrawPhase', { targetChainId: targetPlayerId, textToDraw: lastStep.value, settings: room.settings });
                    } else {
                        let imgSrc = lastStep.value || lastStep.image;
                        io.to(p.id).emit('startGuessPhase', { targetChainId: targetPlayerId, imageToGuess: imgSrc, settings: room.settings });
                    }
                }
            });
        }
    }
    
    socket.on('startResults', (data) => {
        const room = rooms[data.roomCode];
        if (room && room.hostId === socket.id) {
            room.resultState = {
                chainIds: Object.keys(room.chains).filter(id => {
                    if(room.settings.gameMode === 'memesel') return room.chains[id].steps.length > 1;
                    return true;
                }),
                currentChainIdx: 0,
                currentStepIdx: 0,
                settings: data.settings
            };
            showCurrentResultIntro(room);
        }
    });

    function showCurrentResultIntro(room) {
        if (!room.resultState || room.resultState.chainIds.length === 0) return io.to(room.code).emit('resultsFinished');
        
        const currentChainId = room.resultState.chainIds[room.resultState.currentChainIdx];
        const chain = room.chains[currentChainId];
        room.resultState.currentStepIdx = 0;
        
        io.to(room.code).emit('showResultIntro', { 
            chainId: currentChainId, 
            chainOwner: chain.owner,
            settings: room.resultState.settings,
            gameMode: room.settings.gameMode
        });
        
        if (!room.resultState.settings.manualResults) {
            setTimeout(() => { showNextStep(room); }, 3000);
        }
    }

    function showNextStep(room) {
        const currentChainId = room.resultState.chainIds[room.resultState.currentChainIdx];
        const chain = room.chains[currentChainId];
        
        if (room.resultState.currentStepIdx < chain.steps.length) {
            io.to(room.code).emit('showResultStep', {
                stepIndex: room.resultState.currentStepIdx,
                totalSteps: chain.steps.length,
                step: chain.steps[room.resultState.currentStepIdx],
                settings: room.resultState.settings,
                gameMode: room.settings.gameMode
            });
            room.resultState.currentStepIdx++;
            
            if (!room.resultState.settings.manualResults) {
                const waitTime = room.settings.gameMode === 'memesel' ? 6000 : 4000;
                setTimeout(() => { showNextStep(room); }, waitTime);
            }
        } else {
            const isLastChain = room.resultState.currentChainIdx === room.resultState.chainIds.length - 1;
            io.to(room.code).emit('showEndOfChain', { isLastChain: isLastChain });
        }
    }

    socket.on('nextResult', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) showNextStep(room);
    });

    socket.on('nextChain', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            room.resultState.currentChainIdx++;
            if (room.resultState.currentChainIdx < room.resultState.chainIds.length) {
                showCurrentResultIntro(room);
            } else {
                if (room.settings.gameMode === 'memesel') {
                    io.to(roomCode).emit('resultsFinished');
                } else {
                    handleElimination(room);
                }
            }
        }
    });

    socket.on('submitVote', (data) => {
        const room = rooms[data.roomCode];
        if (room && data.targetChainId) {
            const targetChainId = data.targetChainId;
            
            if (room.settings.gameMode === 'memesel') {
                // Memesel oylama devre dışı
            } else {
                const chain = room.chains[targetChainId];
                if (chain && chain.steps.length > 0) {
                    const authorName = chain.steps[chain.steps.length - 1].author;
                    const targetPlayer = room.players.find(p => p.username === authorName);
                    if (targetPlayer) room.scores[targetPlayer.id] = (room.scores[targetPlayer.id] || 0) + data.score;
                }
            }
        }
    });

    function handleElimination(room) {
        const activePlayers = room.players.filter(p => !p.isSpectator && p.inLobby);
        if (activePlayers.length <= 1) {
            io.to(room.code).emit('resultsFinished');
            return;
        }

        let minScore = Infinity;
        let maxScore = -Infinity;
        activePlayers.forEach(p => {
            const sc = room.scores[p.id] || 0;
            if (sc < minScore) minScore = sc;
            if (sc > maxScore) maxScore = sc;
        });

        const losers = activePlayers.filter(p => (room.scores[p.id] || 0) === minScore);
        const winners = activePlayers.filter(p => (room.scores[p.id] || 0) === maxScore);
        
        let reallyGameOver = false;
        if (activePlayers.length - losers.length <= 1) reallyGameOver = true;

        io.to(room.code).emit('showEliminationResults', {
            winnerName: winners.length > 0 ? winners.map(w => w.username).join(" & ") : "Kimse",
            loserNames: losers.map(l => l.username),
            isGameOver: reallyGameOver
        });

        losers.forEach(l => l.isSpectator = true); 
    }

    socket.on('finishEliminationStage', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            const activePlayers = room.players.filter(p => !p.isSpectator && p.inLobby);
            if (activePlayers.length <= 1) {
                io.to(roomCode).emit('resultsFinished');
            } else {
                room.status = 'intermission';
                io.to(roomCode).emit('returnedToLobby');
                updateLobby(roomCode);
            }
        }
    });

    socket.on('returnToLobby', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            room.status = 'waiting'; // Eski halinde 'intermission'dı, oyun tamamen başa sarsın diye düzelttik
            
            // KONTROL 3: Ana lobiye dönerken bağlantısı tamamen kopan ve dönmeyenleri odadan fırlat
            room.players = room.players.filter(p => p.inLobby);
            
            // Kalan herkesi dirilt ve sıfırla
            room.players.forEach(p => {
                p.isSpectator = false;
                p.score = 0;
            });

            io.to(roomCode).emit('backToLobby');
            updateLobby(roomCode);
        }
    });

    socket.on('disconnect', () => {
        if (socket.roomId && rooms[socket.roomId]) {
            const room = rooms[socket.roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            
            if (playerIndex !== -1) {
                // Eğer oyun başlamamışsa adamı direkt listeden sil ki yer kaplamasın.
                if (room.status === 'waiting') {
                    room.players.splice(playerIndex, 1);
                } else {
                    room.players[playerIndex].inLobby = false; 
                }
                
                if (room.hostId === socket.id) {
                    const activePlayer = room.players.find(p => p.inLobby);
                    if (activePlayer) {
                        room.hostId = activePlayer.id;
                    }
                }
                
                if (!room.players.some(p => p.inLobby)) {
                    delete rooms[socket.roomId];
                    io.emit('publicRoomsList', getPublicRoomsList());
                } else {
                    updateLobby(socket.roomId);
                }
            }
        }
    });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Çizgeç Sunucusu Aktif! Port: ${PORT}`);
});
