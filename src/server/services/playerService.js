const config = require("../../../config");
const SAT = require("sat");
const util = require("../lib/util");
const {Player} = require('../map/player')
const chatRepository = require("../repositories/chat-repository");
const loggingRepository = require("../repositories/logging-repository");
const {getPosition} = require("../lib/entityUtils");
const {Vector, Circle} = SAT;

class PlayerService {

    initialMassLog = util.mathLog(config.defaultPlayerMass, config.slowBase);

    constructor(netService, map) {
        this.netService = netService;
        this.map = map;
    }

    connect(socket) {
        const player = new Player(socket.id);

        socket.on('gotit', (data) => this.spawnPlayer(player, socket, data)) //TODO: move to controller, add chat service/controller & commands service
            .on('pingcheck', () => socket.emit('pongcheck'))
            .on('windowResized', (data) => this.updatePlayerWindow(player, data))
            .on('respawn', () => this.respawnPlayer(player, socket))
            .on('disconnect', () => this.onPlayerDisconnected(player))
            .on('playerChat', (data) => this.onPlayerMessage(player, socket, data))
            .on('pass', (data) => this.loginPlayer(player, socket, data))
            .on('kick', (data) => this.performKickCommand(player, socket, data))
            .on('0', (target) => player.updateTarget(target)) // Heartbeat function, update everytime.
            .on('1', () => this.fireFood(player))
            .on('2', () => player.userSplit(config.limitSplit, config.defaultPlayerMass));
    }

    tick(player) {
        if (player.lastHeartbeat < Date.now() - config.maxHeartbeatInterval) {
            this.netService.sendToClient(player.id, 'kick', 'Last heartbeat received over ' + config.maxHeartbeatInterval + ' ago.');
            this.netService.disconnectClient(player.id);
            return;
        }

        player.move(config.slowBase, config.gameWidth, config.gameHeight, this.initialMassLog);

        const cellsToSplit = [];
        for (let cellIndex = 0; cellIndex < player.cells.length; cellIndex++) {
            const currentCell = player.cells[cellIndex];

            const cellCircle = new Circle(
                new Vector(currentCell.x, currentCell.y),
                currentCell.radius
            );

            const eatenFoodIndexes = util.getIndexes(this.map.food.data, food => this.isEntityInsideCircle(food, cellCircle));
            const eatenMassIndexes = util.getIndexes(this.map.massFood.data, mass => this.canEatMass(player, currentCell, cellCircle, cellIndex, mass));
            const eatenVirusIndexes = util.getIndexes(this.map.viruses.data, virus => this.canEatVirus(currentCell, cellCircle, virus));

            if (eatenVirusIndexes.length > 0) {
                cellsToSplit.push(cellIndex);
                this.map.viruses.delete(eatenVirusIndexes)
            }

            let massGained = 0;
            for (let index of eatenMassIndexes) { //eatenMassIndexes is an array of indexes -> "index of" instead of "index in" is intentional
                massGained += this.map.massFood.data[index].mass;
            }

            this.map.food.delete(eatenFoodIndexes);
            this.map.massFood.remove(eatenMassIndexes);
            massGained += (eatenFoodIndexes.length * config.foodMass);
            currentCell.addMass(massGained);
            player.massTotal += massGained;
        }
        player.virusSplit(cellsToSplit, config.limitSplit, config.defaultPlayerMass);
    }

    loginPlayer(player, socket, data) {
        const password = data[0];
        if (password === config.adminPass) {
            console.log('[ADMIN] ' + player.name + ' just logged in as an admin.');
            socket.emit('serverMSG', 'Welcome back ' + player.name);
            this.netService.sendToAll('serverMSG', player.name + ' just logged in as an admin.');
            player.admin = true;
        } else {
            console.log('[ADMIN] ' + player.name + ' attempted to log in with incorrect password.');

            socket.emit('serverMSG', 'Password incorrect, attempt logged.');

            loggingRepository.logFailedLoginAttempt(player.name, socket.handshake.address)
                .catch((err) => console.error("Error when attempting to log failed login attempt", err));
        }
    }

    fireFood(player) {
        for (let i = 0; i < player.cells.length; i++) {
            if (player.cells[i].mass >= config.defaultPlayerMass + config.fireFood) {
                player.cells[i].mass -= config.fireFood;
                player.massTotal -= config.fireFood;
                this.map.massFood.addNew(player, i, config.fireFood);
            }
        }
    }

    respawnPlayer(player, socket) {
        this.map.players.removePlayerByID(player.id);
        socket.emit('welcome', player, {
            width: config.gameWidth,
            height: config.gameHeight
        });
        console.log('[INFO] User ' + player.name + ' has respawned');
    }

    onPlayerDisconnected(player) {
        this.map.players.removePlayerByID(player.id);
        console.log('[INFO] User ' + player.name + ' has disconnected');
        this.netService.sendToAll('playerDisconnect', { name: player.name });
    }

    onPlayerMessage(player, socket, data) {
        const sender = data.sender.replace(/(<([^>]+)>)/ig, '');
        const message = data.message.replace(/(<([^>]+)>)/ig, '');

        if (config.logChat === 1) {
            const date = new Date();
            console.log('[CHAT] [' + date.getHours() + ':' + date.getMinutes() + '] ' + sender + ': ' + message);
        }

        this.netService.sendToAll('serverSendPlayerChat', {
            sender: sender,
            message: message.substring(0, 35)
        });

        chatRepository.logChatMessage(sender, message, socket.handshake.address)
            .catch((err) => console.error("Error when attempting to log chat message", err));
    }

    performKickCommand(sender, socket, data) {
        if (!sender.admin) {
            socket.emit('serverMSG', 'You are not permitted to use this command.');
            return;
        }
        for (let playerIndex in this.map.players.data) {
            let player = this.map.players.data[playerIndex];
            if (player.name === data[0] && !player.admin) {
                const reason = data.slice(1).join(' ');

                this.netService.sendToClient(player.id, 'kick', reason);
                this.netService.disconnectClient(player.id);
                this.map.players.removePlayerByIndex(playerIndex);

                socket.emit('serverMSG', 'User ' + player.name + ' was kicked by ' + sender.name);
                console.log('[ADMIN] User ' + player.name + ' was kicked by ' + sender.name + (reason === '' ? '' : ' for reason ' + reason));
                return;
            }
        }

        socket.emit('serverMSG', 'Could not locate user or user is an admin.');
    }

    isEntityInsideCircle(entity, circle) {
        return SAT.pointInCircle(new Vector(entity.x, entity.y), circle);
    }

    canEatMass(player, cell, cellCircle, cellIndex, mass) {
        if (this.isEntityInsideCircle(mass, cellCircle)) {
            if (mass.id === player.id && mass.speed > 0 && cellIndex === mass.num)
                return false;
            if (cell.mass > mass.mass * 1.1)
                return true;
        }

        return false;
    }

    canEatVirus(cell, cellCircle, virus) {
        return virus.mass < cell.mass && this.isEntityInsideCircle(virus, cellCircle)
    }

    getSpawnPoint() {
        return getPosition(
            config.newPlayerInitialPosition === 'farthest',
            util.massToRadius(config.defaultPlayerMass),
            this.map.players.data
        )
    }

    spawnPlayer(player, socket, data) {
        console.log('[INFO] Player ' + data.name + ' connecting!');

        if (this.map.players.findIndexByID(socket.id) > -1) {
            console.log('[INFO] Player ID is already connected, kicking.');
            socket.disconnect();
            return;
        } else if (!util.validNick(data.name)) {
            socket.emit('kick', 'Invalid username.');
            socket.disconnect();
            return;
        }

        player.init(this.getSpawnPoint(), config.defaultPlayerMass);

        console.log('[INFO] Player ' + data.name + ' connected!');
        this.netService.connectClient(socket.id, socket);
        player.clientProvidedData(data);
        this.map.players.pushNew(player);
        this.netService.sendToAll('playerJoin', { name: player.name });
        console.log('Total players: ' + this.map.players.data.length);
    }

    updatePlayerWindow(player, data) {
        player.screenWidth = data.screenWidth;
        player.screenHeight = data.screenHeight;
    }
}

module.exports = PlayerService
