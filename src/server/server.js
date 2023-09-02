/*jslint bitwise: true, node: true */
'use strict';

const config = require('../../config');
const mapUtils = require('./map/map');

let map = new mapUtils.Map(config);

const NetService = require('./services/netService')
const PlayerService = require('./services/playerService')
const netService = new NetService()
const playerService = new PlayerService(netService, map)

let spectators = [];

let leaderboard = [];
let leaderboardChanged = false;

netService.on('connection', (socket) => {
    let type = socket.handshake.query.type;
    console.log('User has connected: ', type);
    switch (type) {
        case 'player':
            playerService.connect(socket);
            break;
        case 'spectator':
            addSpectator(socket);
            break;
        default:
            console.log('Unknown user type, not doing anything.');
    }
});

const addSpectator = (socket) => {
    socket.on('gotit', function () {
        netService.connectClient(socket.id, socket);
        spectators.push(socket.id);
        netService.sendToAll('playerJoin', { name: 'Spectator' });
    });

    socket.emit("welcome", {}, {
        width: config.gameWidth,
        height: config.gameHeight
    });
}

const tickGame = () => {
    map.players.data.forEach(player => playerService.tick(player));
    map.massFood.move(config.gameWidth, config.gameHeight);

    map.players.handleCollisions(function (gotEaten, eater) {
        let cellGotEaten = map.players.getCell(
            gotEaten.playerIndex,
            gotEaten.cellIndex
        );

        let eaterPlayer = map.players.data[eater.playerIndex];
        let eaterCell = eaterPlayer.cells[eater.cellIndex];

        eaterCell.mass += cellGotEaten.mass;
        eaterPlayer.massTotal += cellGotEaten.mass;

        let playerDied = map.players.removeCell(gotEaten.playerIndex, gotEaten.cellIndex);
        if (playerDied) {
            let playerGotEaten = map.players.data[gotEaten.playerIndex];
            netService.sendToAll('playerDied', { name: playerGotEaten.name });
            netService.sendToClient(playerGotEaten.id, 'RIP');
            map.players.removePlayerByIndex(gotEaten.playerIndex);
        }
    });

};

const calculateLeaderboard = () => {
    const topPlayers = map.players.getTopPlayers();

    if (leaderboard.length !== topPlayers.length) {
        leaderboard = topPlayers;
        leaderboardChanged = true;
    } else {
        for (let i = 0; i < leaderboard.length; i++) {
            if (leaderboard[i].id !== topPlayers[i].id) {
                leaderboard = topPlayers;
                leaderboardChanged = true;
                break;
            }
        }
    }
}

const gameloop = () => {
    if (map.players.data.length > 0) {
        calculateLeaderboard();
        map.players.shrinkCells(config.massLossRate, config.defaultPlayerMass, config.minMassLoss);
    }

    map.balanceMass(config.foodMass, config.gameMass, config.maxFood, config.maxVirus);
};

const sendUpdates = () => {
    spectators.forEach(updateSpectator);
    map.enumerateWhatPlayersSee(function (playerData, visiblePlayers, visibleFood, visibleMass, visibleViruses) {
        netService.sendToClient(playerData.id, 'serverTellPlayerMove', playerData, visiblePlayers, visibleFood, visibleMass, visibleViruses);
        if (leaderboardChanged) {
            sendLeaderboard(playerData.id);
        }
    });

    leaderboardChanged = false;
};

const sendLeaderboard = (clientId) => {
    netService.sendToClient(clientId, 'leaderboard', {
        players: map.players.data.length,
        leaderboard
    });
}
const updateSpectator = (socketID) => {
    let playerData = {
        x: config.gameWidth / 2,
        y: config.gameHeight / 2,
        cells: [],
        massTotal: 0,
        hue: 100,
        id: socketID,
        name: ''
    };
    netService.sendToClient(socketID, 'serverTellPlayerMove', playerData, map.players.data, map.food.data, map.massFood.data, map.viruses.data);
    if (leaderboardChanged) {
        sendLeaderboard(socketID);
    }
}

setInterval(tickGame, 1000 / 60);
setInterval(gameloop, 1000);
setInterval(sendUpdates, 1000 / config.networkUpdateFactor);
