const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs'); // Profil okuma için eklendi

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e8 // Çizim resimlerinin sığması için
});

app.use(express.static(path.join(__dirname, 'public')));

// Profil fotoğraflarını otomatik çeken API
app.get('/api/profiles', (req, res) => {
    const dir = path.join(__dirname, 'public', 'profiles');
    fs.readdir(dir, (err, files) => {
        if (err) {
            return res.json(Array.from({length: 10}, (_, i) => `${i+1}.png`)); // Fallback
        }
        const images = files.filter(f => /\.(png|jpe?g|gif|webp)$/i.test(f));
        res.json(images);
    });
});

const rooms = {};

function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code;
    do {
        code = '';
        for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    } while (rooms[code]);
    return code;
}

function getActivePlayers(room) {
    return room.players.filter(p => !p.isSpectator);
}

// Şablonları rastgele dağıtmak için karıştırma fonksiyonu
function shuffleArray(array) {
    let curId = array.length;
    while (0 !== curId) {
        let randId = Math.floor(Math.random() * curId);
        curId -= 1;
        let tmp = array[curId];
        array[curId] = array[randId];
        array[randId] = tmp;
    }
    return array;
}

io.on('connection', (socket) => {
    console.log(`Yeni bağlantı: ${socket.id}`);

    // --- 1. LOBİ VE GİRİŞ İŞLEMLERİ ---
    socket.on('getPublicRooms', () => {
        const publicRooms = Object.values(rooms)
            .filter(r => r.isPublic && r.status === 'lobby' && r.players.length < 14)
            .map(r => ({
                code: r.code,
                playerCount: r.players.length,
                maxPlayers: 14,
                hasPassword: r.password !== ''
            }));
        socket.emit('publicRoomsList', publicRooms);
    });

    socket.on('createRoom', (data) => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            code: roomCode,
            isPublic: data.isPublic,
            password: data.password || '',
            hostId: socket.id,
            status: 'lobby',
            players: [{
                id: socket.id,
                username: data.userData.username,
                avatar: data.userData.avatar,
                inLobby: true,
                isSpectator: false,
                isReady: false
            }],
            settings: { gameMode: 'yazciz', startMode: 'text', turns: 'auto', timeMode: 'normal' },
            chains: {},
            submissions: {},
            roundCount: 0,
            maxRounds: 0,
            viewState: {},
            memeselTemplates: {} // Memesel için şablon deposu
        };

        socket.join(roomCode);
        socket.emit('joinedRoom', { roomCode, isHost: true, status: 'lobby' });
        io.to(roomCode).emit('updateSettings', rooms[roomCode].settings);
        io.to(roomCode).emit('updateLobby', rooms[roomCode]);
    });

    socket.on('joinWithCode', (data) => {
        const room = rooms[data.roomCode];
        if (!room) { return socket.emit('errorMsg', 'Böyle bir oda bulunamadı!'); }
        if (room.status === 'playing' || room.status === 'results') { return socket.emit('errorMsg', 'Oyun şu an devam ediyor!'); }
        if (room.players.length >= 14) { return socket.emit('errorMsg', 'Oda dolu!'); }
        if (room.password && room.password !== data.password) { return socket.emit('errorMsg', 'Hatalı şifre!'); }

        socket.join(room.code);
        room.players.push({
            id: socket.id,
            username: data.userData.username,
            avatar: data.userData.avatar,
            inLobby: true,
            isSpectator: false,
            isReady: false
        });

        socket.emit('joinedRoom', { roomCode: room.code, isHost: false, status: room.status });
        socket.emit('updateSettings', room.settings);
        if(room.status === 'intermission') io.to(room.code).emit('updateIntermissionLobby', room);
        else io.to(room.code).emit('updateLobby', room);
    });

    socket.on('joinRandom', (userData) => {
        const availableRoom = Object.values(rooms).find(r => r.isPublic && r.status === 'lobby' && r.players.length < 14 && !r.password);
        if (availableRoom) {
            socket.join(availableRoom.code);
            availableRoom.players.push({
                id: socket.id, username: userData.username, avatar: userData.avatar, inLobby: true, isSpectator: false, isReady: false
            });
            socket.emit('joinedRoom', { roomCode: availableRoom.code, isHost: false, status: 'lobby' });
            socket.emit('updateSettings', availableRoom.settings);
            io.to(availableRoom.code).emit('updateLobby', availableRoom);
        } else {
            socket.emit('errorMsg', 'Şu an uygun açık oda yok. Bir oda kurmayı dene!');
        }
    });

    socket.on('changeSettings', (data) => {
        const room = rooms[data.roomCode];
        if (room && room.hostId === socket.id) {
            room.settings = data.settings;
            io.to(room.code).emit('updateSettings', room.settings);
        }
    });

    socket.on('sendMessage', (data) => {
        io.to(data.roomCode).emit('receiveMessage', { sender: data.username, message: data.message, color: data.color });
    });

    // --- 2. OYUN BAŞLANGICI ---
    socket.on('startGame', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            room.status = 'playing';
            room.roundCount = 0;
            room.chains = {};
            room.submissions = {};
            room.memeselTemplates = {};
            
            const activePlayers = getActivePlayers(room);
            if(activePlayers.length < 2) return socket.emit('errorMsg', 'Yeterli oyuncu yok!');

            if (room.settings.gameMode === 'memesel') {
                room.maxRounds = 1; // Çizim + Doldurma
                activePlayers.forEach(p => {
                    p.isReady = false;
                    room.chains[p.id] = { owner: p.username, entries: [], votes: [] };
                });
            } else {
                room.maxRounds = room.settings.turns === 'auto' ? activePlayers.length : parseInt(room.settings.turns);
                activePlayers.forEach(p => {
                    p.isReady = false;
                    p.currentTargetChainId = p.id;
                    room.chains[p.id] = { owner: p.username, entries: [], votes: [] };
                });
            }

            io.to(roomCode).emit('startCountdown');
        }
    });

    socket.on('requestPhase1', (roomCode) => {
        const room = rooms[roomCode];
        if(room && room.hostId === socket.id) {
            room.submissions = {};
            room.players.forEach(p => p.isReady = false);
            
            const activeCount = getActivePlayers(room).length;
            io.to(roomCode).emit('readyCount', { ready: 0, total: activeCount });

            if (room.settings.gameMode === 'memesel') {
                io.to(roomCode).emit('startMemeselDrawPhase', { settings: room.settings });
            } else {
                if(room.settings.startMode === 'text') io.to(roomCode).emit('startWritePhase', { settings: room.settings });
                else io.to(roomCode).emit('startFreeDrawPhase', { settings: room.settings });
            }
        }
    });

    socket.on('toggleReady', (data) => {
        const room = rooms[data.roomCode];
        if(room) {
            const p = room.players.find(pl => pl.id === socket.id);
            if(p && !p.isSpectator) {
                p.isReady = data.isReady;
                const active = getActivePlayers(room);
                const readyCount = active.filter(pl => pl.isReady).length;
                io.to(room.code).emit('readyCount', { ready: readyCount, total: active.length });

                if(readyCount === active.length) io.to(room.code).emit('forceEndRound');
            }
        }
    });

    // YAZÇİZ STANDART AKIŞI
    socket.on('submitText', (data) => processSubmission(data, 'text'));
    socket.on('submitDrawing', (data) => processSubmission(data, 'image'));

    function processSubmission(data, type) {
        const room = rooms[data.roomCode];
        if (!room || room.settings.gameMode === 'memesel') return;

        const p = room.players.find(pl => pl.id === socket.id);
        if(!p || p.isSpectator) return;

        room.submissions[socket.id] = true;
        room.chains[p.currentTargetChainId].entries.push({
            type: type, value: value = type === 'text' ? data.text : data.image,
            author: p.username, authorId: p.id, actionText: type === 'text' ? 'şunu yazdı:' : 'şunu çizdi:'
        });

        const activePlayers = getActivePlayers(room);
        if(Object.keys(room.submissions).length === activePlayers.length) advanceRound(room);
    }

    function advanceRound(room) {
        room.roundCount++;
        room.submissions = {};
        const activePlayers = getActivePlayers(room);
        
        activePlayers.forEach(p => p.isReady = false);
        io.to(room.code).emit('readyCount', { ready: 0, total: activePlayers.length });

        if (room.roundCount >= room.maxRounds) {
            room.status = 'results';
            io.to(room.code).emit('gameFinished', { chains: room.chains, players: room.players, gameMode: 'yazciz' });
            return;
        }

        const currentTargets = activePlayers.map(p => p.currentTargetChainId);
        activePlayers.forEach((p, index) => {
            let nextIndex = index - 1;
            if(nextIndex < 0) nextIndex = activePlayers.length - 1;
            p.currentTargetChainId = currentTargets[nextIndex];
        });

        activePlayers.forEach(p => {
            const targetChain = room.chains[p.currentTargetChainId];
            const lastEntry = targetChain.entries[targetChain.entries.length - 1];

            if (lastEntry.type === 'text') io.to(p.id).emit('startDrawPhase', { settings: room.settings, targetChainId: p.currentTargetChainId, textToDraw: lastEntry.value });
            else io.to(p.id).emit('startGuessPhase', { settings: room.settings, targetChainId: p.currentTargetChainId, imageToGuess: lastEntry.value });
        });
    }

    // --- MEMESEL AKIŞI ---
    socket.on('submitMemeselTemplate', (data) => {
        const room = rooms[data.roomCode];
        if (!room || room.settings.gameMode !== 'memesel') return;
        const p = room.players.find(pl => pl.id === socket.id);
        if(!p || p.isSpectator) return;

        room.submissions[socket.id] = true;
        
        // Kendi zincirinin ilk adımı olarak şablonu kaydet
        room.chains[p.id].entries.push({
            type: 'image', value: data.image, author: p.username, authorId: p.id, actionText: 'şablonunu çizdi:'
        });

        room.memeselTemplates[p.id] = { image: data.image, boxes: data.boxes, ownerId: p.id };

        const activePlayers = getActivePlayers(room);
        if(Object.keys(room.submissions).length === activePlayers.length) {
            // Şablonları rastgele dağıt
            room.submissions = {};
            activePlayers.forEach(pl => pl.isReady = false);
            io.to(room.code).emit('readyCount', { ready: 0, total: activePlayers.length });

            const templateIds = shuffleArray(Object.keys(room.memeselTemplates));
            
            activePlayers.forEach((player, i) => {
                const assignedTemplateId = templateIds[i];
                player.currentTargetChainId = assignedTemplateId; // Hangi zinciri dolduracak
                const template = room.memeselTemplates[assignedTemplateId];
                
                io.to(player.id).emit('startMemeselFillPhase', {
                    settings: room.settings,
                    targetChainId: assignedTemplateId,
                    templateImage: template.image,
                    boxes: template.boxes
                });
            });
        }
    });

    socket.on('submitMemeselFill', (data) => {
        const room = rooms[data.roomCode];
        if (!room || room.settings.gameMode !== 'memesel') return;
        const p = room.players.find(pl => pl.id === socket.id);
        if(!p || p.isSpectator) return;

        room.submissions[socket.id] = true;
        
        room.chains[p.currentTargetChainId].entries.push({
            type: 'image', value: data.finalImage, author: p.username, authorId: p.id, actionText: 'miimi tamamladı:'
        });

        const activePlayers = getActivePlayers(room);
        if(Object.keys(room.submissions).length === activePlayers.length) {
            // Oyun bitti, direkt sonuçlara
            room.status = 'results';
            io.to(room.code).emit('gameFinished', { chains: room.chains, players: room.players, gameMode: 'memesel' });
        }
    });

    // --- 3. SONUÇLAR VE ELEME (WP GALERİ SİSTEMİ) ---
    socket.on('startResults', (data) => {
        const room = rooms[data.roomCode];
        if (room && room.hostId === socket.id) {
            room.viewState = { settings: data.settings, activeChainIds: Object.keys(room.chains), currentChainIndex: 0, currentStepIndex: 0 };
            sendResultStep(room);
        }
    });

    socket.on('nextResult', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            room.viewState.currentStepIndex++;
            sendResultStep(room);
        }
    });

    socket.on('nextChain', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            room.viewState.currentChainIndex++;
            room.viewState.currentStepIndex = 0;
            
            if (room.viewState.currentChainIndex >= room.viewState.activeChainIds.length) {
                if (room.settings.gameMode === 'memesel') {
                    // Memesel'de eleme yok, direkt galeriye geç!
                    io.to(roomCode).emit('resultsFinished');
                } else {
                    calculateAndShowElimination(room);
                }
            } else {
                sendResultStep(room);
            }
        }
    });

    function sendResultStep(room) {
        const state = room.viewState;
        const chainId = state.activeChainIds[state.currentChainIndex];
        const chain = room.chains[chainId];
        
        if (state.currentStepIndex === 0) {
            io.to(room.code).emit('showResultIntro', { chainId: chainId, chainOwner: chain.owner, settings: state.settings, gameMode: room.settings.gameMode });
            setTimeout(() => {
                io.to(room.code).emit('showResultStep', { stepIndex: state.currentStepIndex, totalSteps: chain.entries.length, step: chain.entries[state.currentStepIndex], settings: state.settings, gameMode: room.settings.gameMode });
            }, 2000);
        } else if (state.currentStepIndex < chain.entries.length) {
            io.to(room.code).emit('showResultStep', { stepIndex: state.currentStepIndex, totalSteps: chain.entries.length, step: chain.entries[state.currentStepIndex], settings: state.settings, gameMode: room.settings.gameMode });
        } else {
            io.to(room.code).emit('showEndOfChain', { isLastChain: state.currentChainIndex === state.activeChainIds.length - 1 });
        }
    }

    socket.on('submitVote', (data) => {
        const room = rooms[data.roomCode];
        if (room && room.chains[data.targetChainId]) {
            room.chains[data.targetChainId].votes.push(data.score);
        }
    });

    function calculateAndShowElimination(room) {
        let scores = {};
        for (const [chainId, chainData] of Object.entries(room.chains)) {
            scores[chainId] = chainData.votes.reduce((a, b) => a + b, 0);
        }

        const activePlayers = getActivePlayers(room);
        let winnerName = ""; let loserNames = []; let isGameOver = false;

        if (activePlayers.length > 0) {
            let maxScore = -1; let minScore = 999999;
            activePlayers.forEach(p => {
                const s = scores[p.id] || 0;
                if (s > maxScore) maxScore = s;
                if (s < minScore) minScore = s;
            });

            const winners = activePlayers.filter(p => (scores[p.id] || 0) === maxScore);
            const losers = activePlayers.filter(p => (scores[p.id] || 0) === minScore);

            winnerName = winners.map(w => w.username).join(" & ");
            
            if (activePlayers.length > 2) {
                losers.forEach(l => {
                    const player = room.players.find(p => p.id === l.id);
                    if(player) player.isSpectator = true;
                    loserNames.push(l.username);
                });
            } else {
                const absoluteLosers = activePlayers.filter(p => (scores[p.id]||0) < maxScore);
                absoluteLosers.forEach(l => {
                    const player = room.players.find(p => p.id === l.id);
                    if(player) player.isSpectator = true;
                });
            }
        }

        const remainingActive = getActivePlayers(room).length;
        if (remainingActive <= 1) {
            isGameOver = true;
            const grandWinner = getActivePlayers(room)[0];
            if(grandWinner) winnerName = grandWinner.username;
        }

        io.to(room.code).emit('showEliminationResults', { winnerName, loserNames, isGameOver });
    }

    socket.on('finishEliminationStage', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            const activeCount = getActivePlayers(room).length;
            if (activeCount <= 1) {
                io.to(roomCode).emit('resultsFinished');
            } else {
                room.status = 'intermission';
                io.to(roomCode).emit('joinedRoom', { roomCode: room.code, isHost: true, status: 'intermission' });
                io.to(roomCode).emit('updateIntermissionLobby', room);
            }
        }
    });

    socket.on('returnToLobby', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            room.status = 'lobby';
            room.players.forEach(p => { p.isSpectator = false; p.isReady = false; });
            io.to(roomCode).emit('returnedToLobby');
            io.to(roomCode).emit('updateLobby', room);
        }
    });

    socket.on('disconnect', () => {
        for (const code in rooms) {
            const room = rooms[code];
            const pIndex = room.players.findIndex(p => p.id === socket.id);
            if (pIndex !== -1) {
                room.players.splice(pIndex, 1);
                if (room.players.length === 0) { delete rooms[code]; } 
                else {
                    if (room.hostId === socket.id) {
                        room.hostId = room.players[0].id;
                        io.to(room.hostId).emit('joinedRoom', { roomCode: room.code, isHost: true, status: room.status });
                    }
                    if (room.status === 'intermission') io.to(code).emit('updateIntermissionLobby', room);
                    else if (room.status === 'lobby') io.to(code).emit('updateLobby', room);
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Çizgeç Sunucusu ${PORT} portunda ayaklandı!`);
});