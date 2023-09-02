const config = require("../../../config");
const express = require('express');
const {Server} = require('http');
const {Server: SocketServer} = require('socket.io');

class NetService {

    sockets = new Map();
    app = express();
    server = new Server(this.app)
    socket = new SocketServer(this.server);

    constructor() {
        this.app.use(express.static(__dirname + './../../client'));

        const ipAddress = process.env.OPENSHIFT_NODEJS_IP || process.env.IP || config.host;
        const serverPort = process.env.OPENSHIFT_NODEJS_PORT || process.env.PORT || config.port;
        this.server.listen(serverPort, ipAddress, () => console.log('[DEBUG] Listening on ' + ipAddress + ':' + serverPort));
    }

    on(event, callback) {
        this.socket.on(event, callback)
    }

    sendToAll(event, ...args) {
        this.socket.emit(event, ...args)
    }

    sendToClient(clientId, event, ...args) {
        this.sockets.get(clientId)?.emit(event, ...args)
    }

    connectClient(clientId, socket) {
        this.sockets.set(clientId, socket);
    }

    disconnectClient(clientId) {
        this.sockets.get(clientId)?.disconnect();
        this.sockets.delete(clientId)
    }
}


module.exports = NetService
