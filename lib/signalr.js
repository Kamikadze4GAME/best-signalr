'use strict';

const debug        = require('debug')('SignalR');
const ws           = require('ws');
const URL          = require('url');
const EventEmitter = require('events');
const Promise      = require('bluebird');
const rp           = require('request-promise');


// {
//   "ConnectionTimeout": 110.0,
// }
//
// {
//   "DisconnectTimeout":5.0,
// }

const CLIENT_PROTOCOL = '1.5';
const LOGGING = false;
const NEGOTIATE_ABORT_TEXT = '__Negotiate Aborted__';

const STATES = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',

};

function ConnectingMessageBuffer(connection, drainCallback) {
    var that = this,
        buffer = [];

    that.tryBuffer = function (message) {
        if (connection.state === $.signalR.connectionState.connecting) {
            buffer.push(message);

            return true;
        }

        return false;
    };

    that.drain = function () {
        // Ensure that the connection is connected when we drain (do not want to drain while a connection is not active)
        if (connection.state === $.signalR.connectionState.connected) {
            while (buffer.length > 0) {
                drainCallback(buffer.shift());
            }
        }
    };

    that.clear = function () {
        buffer = [];
    };
}

// TODO:
function prepareQueryString(url) {
  return url;
}


// TODO: configureStopReconnectingTimeout
class SignalR extends EventEmitter {
  constructor() {
    super();

    this.url = null;
    this.qs = null;
    this.lastError = null;
    this._ = {
        keepAliveData: {},
        connectingMessageBuffer: new ConnectingMessageBuffer(this, function (message) {
            $connection.triggerHandler(events.onReceived, [message]);
        }),
        lastMessageAt: new Date().getTime(),
        lastActiveAt: new Date().getTime(),
        beatInterval: 5000, // Default value, will only be overridden if keep alive is enabled,
        beatHandle: null,
        totalTransportConnectTimeout: 0 // This will be the sum of the TransportConnectTimeout sent in response to negotiate and connection.transportConnectTimeout
    };

  }

  start(opts = {/*url*/}) {
    return Promise.resolve()
      .then(_ => {
        this.lastError = null;
        //
        // // TODO:
        // // If connection => return this
        // if(STATES.CONNECTION === this.state) {
        //   return this;
        // }
        // // TODO:
        // else if(this.changeState(STATES.DISCONNECTED, STATE.CONNECTING) === false) {
        //   // We're not connecting so try and transition into connecting.
        //   // If we fail to transition then we're either in connected or reconnecting.
        //   //
        //   // deferred.resolve(connection);
        //   // return deferred.promise();
        //   return this;
        // }

        // TODO: add reconnection timeout

        let url = new (URL.URL)(opts.url);

        url = `${url.protocol}//${url.host}${url.pathname}/negotiate`;

        this.emit('starting');

        url = prepareQueryString(url);

        debug(`Negotiating with ${url}.`);

          // Save the negotiate request object so we can abort it if stop is called while the request is in flight.
        this._.negotiateRequest = rp(''+url)
          .catch(err => {

            // TODO
            if(err.error !== NEGOTIATE_ABORT_TEXT) {
              console.log('TODO: Error during negotiation request.');
              this.emit('error', err);
            }

            // TODO: is return?
            // Stop the connection if negotiate failed
            return this.stop();
          })
          .then(res => {
            let keepAliveData;

            try {
              res = SignalR.parseResponse(res);
            } catch (e) {
              console.log('TODO: Error parsing negotiate response.');
              this.emit('error', e);
              return;
            }

            console.log(res);
            // TODO:
            keepAliveData = this._.keepAliveData;

            this.appRelativeUrl = res.Url;
            this.id = res.ConnectionId;
            this.token = res.ConnectionToken;
            this.webSocketServerUrl = res.WebSocketServerUrl;

            // The long poll timeout is the ConnectionTimeout plus 10 seconds
            this._.pollTimeout = res.ConnectionTimeout * 1000 + 10000; // in ms

            // Once the server has labeled the PersistentConnection as Disconnected, we should stop attempting to reconnect
            // after res.DisconnectTimeout seconds.
            this.disconnectTimeout = res.DisconnectTimeout * 1000; // in ms

            // Add the TransportConnectTimeout from the response to the transportConnectTimeout from the client to calculate the total timeout
            this._.totalTransportConnectTimeout = this.transportConnectTimeout + res.TransportConnectTimeout * 1000;

            // If we have a keep alive
            if (res.KeepAliveTimeout) {
                // Register the keep alive data as activated
                keepAliveData.activated = true;

                // Timeout to designate when to force the connection into reconnecting converted to milliseconds
                keepAliveData.timeout = res.KeepAliveTimeout * 1000;

                // Timeout to designate when to warn the developer that the connection may be dead or is not responding.
                keepAliveData.timeoutWarning = keepAliveData.timeout * connection.keepAliveWarnAt;

                // Instantiate the frequency in which we check the keep alive.  It must be short in order to not miss/pick up any changes
                this._.beatInterval = (keepAliveData.timeout - keepAliveData.timeoutWarning) / 3;
            } else {
                keepAliveData.activated = false;
            }

            // TODO: reconnectWindow?
            this.reconnectWindow = this.disconnectTimeout + (keepAliveData.timeout || 0);

            // Compare protocol version
            if (!res.ProtocolVersion || res.ProtocolVersion !== this.clientProtocol) {
              let error = new Erorr(`You are using a version of the client that isn't compatible with the server. Client version ${this.clientProtocol}, server version ${res.ProtocolVersion}.`);
              this.emit('error', error);
              throw error;
            }
          });

        return this._.negotiateRequest;
      })
      .then(res => {

        // The connection was aborted
        if(this.state === STATES.DISCONNECTED) {
          return;
        }
      });
  }

  // TODO: add this.state
  changeState(expectedState, newState) {
    if(this.state === expectedState) {
      this.state = newState;

      this.emit('state', {oldState: expectedState, newState: newState});
      return true;
    }
    return false;
  }

  // checkIsAlive() {
  //   let keepAliveData = this._.keepAliveData;
  //   let timeElapsed;
  //
  //   if(this.state === STATES.CONNECTED) {
  //     timeElapsed = new Date().getTime() - this._.lastMessageAt;
  //
  //     // Check if the keep alive has completely timed out
  //     if (timeElapsed >= keepAliveData.timeout) {
  //       debug('Keep alive timed out. Notifying transport that connection has been lost.');
  //
  //       // Notify transport that the connection has been lost
  //       console.log('TODO: this.transport.lostConnection(connection);');
  //       // this.transport.lostConnection(connection);
  //     }
  //     else if(timeElapsed >= keepAliveData.timeoutWarning) {
  //       // This is to assure that the user only gets a single warning
  //       if (!keepAliveData.userNotified) {
  //           debug("Keep alive has been missed, connection may be dead/slow.");
  //
  //           this.emit('slow');
  //           keepAliveData.userNotified = true;
  //       }
  //     }
  //     else {
  //       keepAliveData.userNotified = false;
  //     }
  //     // TODO:
  //   } else {
  //     return false
  //   }
  // }

  static parseResponse(response) {
    if(typeof response === 'string') {
      return JSON.parse(response);
    }

    // Or !response or not string
    return response;
  }



}


let signalr = new SignalR();

signalr.start({url: 'https://socket.bittrex.com/signalr'})
.then(res => {
  console.log(res);
})
.catch(err => {
  console.log(err);
})
