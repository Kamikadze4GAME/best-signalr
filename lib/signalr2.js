'use strict';

const Promise = require('bluebird');
const rp = require('request-promise');
const URL = require('url');
const WS = require('ws');


const CLIENT_PROTOCOL_VERSION = '1.5';

const NEGOTIATE_ABORT_TEXT = '__Negotiate Aborted__';
const START_ABORT_TEXT = '__Start Aborted__';

function prepareHubs(hubs) {
  if(!Array.isArray(hubs)) {
    throw new Error('Hubs must be an array');
  }

  return (hubs || []).map(hub => {
    if(typeof hub !== 'string') {
      throw new Error('Hubs name must be a string');
    }

    return { name: hub.toLowerCase() };
  });
}

// TODO: negotiate
// TODO: start
// TODO: connect

class Signalr {
  constructor(opts = {}) {
    this.baseURL = opts.baseURL;
    this._transport = null;
    this.state = null;
    this.clientProtocol = opts.clientProtocol || CLIENT_PROTOCOL_VERSION;
    this.hubs = opts.hubs;
    this.qs = opts.qs;
    this.token = null;
    this.groupsToken = null;
    this.id = null;
    this.messageId = null;
    this._ = {
      keepAliveData: {},
      lastMessageAt: new Date().getTime(),
      lastActiveAt: new Date().getTime(),
      beatInterval: 5000, // Default value, will only be overridden if keep alive is enabled,
      beatHandle: null,
      totalTransportConnectTimeout: 0 // This will be the sum of the TransportConnectTimeout sent in response to negotiate and connection.transportConnectTimeout
    };
  }

  static get CONNECTING()   { return 0; }
  static get CONNECTED()    { return 1; }
  static get RECONNECTING() { return 2; }
  static get DISCONNECTED() { return 4; }


  static _parseResponse(message = '') {
    return JSON.parse(message);
  }

  crateTransport() {
    this._transport = new WS(this.baseURL);
  }

  // TODO:
  _wrapURL(pathname) {
    let url = new URL.URL(this.baseURL);

    if(pathname) {
      url.pathname += pathname;
    }

    url.searchParams.set('clientProtocol', this.clientProtocol);

    // Add token
    if(this.token) {
      url.searchParams.set('connectionToken', this.token);
    }

    // Add groups token
    if(this.groupsToken) {
      url.searchParams.set('groupsToken', this.groupsToken);
    }

    // For query
    if(this.qs) {
      if(typeof qs === 'string') {
        url.searchParams.set('queryString', this.qs);
      } else {
        url.searchParams.set('queryString', JSON.stringify(this.qs));
      }
    }

    // Add hubs
    if(this.hubs) {
      url.searchParams.set('connectionData', JSON.stringify(prepareHubs(this.hubs)));
    }

    return url;
  }

  // TODO: if err => stop connection
  // TODO: refact qs
  ping(qs) {
    let url = new URL.URL(this.baseURL);
    url.pathname += '/ping';

    // For query
    if(qs) {
      if(typeof qs === 'string') {
        url.searchParams.set('queryString', qs);
      } else {
        url.searchParams.set('queryString', JSON.stringify(qs));
      }
    }

    return rp(`${url}`)
      .catch(err => {
        // TODO: add err
        if(err.statusCode === 401 || err.statusCode === 403) {
          throw new Error(`Failed to ping server.  Server responded with status code ${err.statusCode}, stopping the connection.`);
        } else {
          console.error('Failed to ping server.');
          throw err;
        }
      })
      .then(res => {
        let data;

        try {
          data = Signalr._parseResponse(res)
        } catch (e) {
          console.error('Failed to parse ping server response, stopping the connection.');
          throw e;
        }

        if(data.Response === 'pong') {
          return;
        }
        else {
          throw new Error(`Invalid ping response when pinging server: '${res}'`);
        }
      });
  }

  // TODO:
  negotiate() {
    let url = this._wrapURL('/negotiate');

    return rp(`${url}`)
      // TODO: stop
      .catch(err => {
        if(err.error === NEGOTIATE_ABORT_TEXT) {
          throw new Error('The connection was stopped during the negotiate request.');
        }
        throw err;
      })
      .then(res => {
        res = Signalr._parseResponse(res);
        /*
          {
            Url: '/signalr',
            ConnectionToken: '9LaoKg/jAcheeEEH',
            ConnectionId: '5af8fc0b-8d72-4714-b54a-07d14c9c4f4a',
            KeepAliveTimeout: 20,
            DisconnectTimeout: 30,
            ConnectionTimeout: 110,
            TryWebSockets: true,
            ProtocolVersion: '1.5',
            TransportConnectTimeout: 5,
            LongPollDelay: 0
          }
        */
        let d = {};
        let _ = {keepAliveData:{}};
        let keepAliveData = _.keepAliveData;

        // TODO: d => this
        // NOTE: not used
        d.appRelativeUrl = res.Url;
        this.id = res.ConnectionId;
        this.token = res.ConnectionToken;

        // The long poll timeout is the ConnectionTimeout plus 10 seconds
        _.pollTimeout = res.ConnectionTimeout * 1000 + 10000;

        // Once the server has labeled the PersistentConnection as Disconnected, we should stop attempting to reconnect after res.DisconnectTimeout seconds.
        d.disconnectTimeout = res.DisconnectTimeout * 1000;

        // Add the TransportConnectTimeout from the response to the transportConnectTimeout from the client to calculate the total timeout
        _.totalTransportConnectTimeout = d.transportConnectTimeout + res.TransportConnectTimeout * 1000;

        // If we have a keep alive
        if (res.KeepAliveTimeout) {
          // Register the keep alive data as activated
          keepAliveData.activated = true;

          // Timeout to designate when to force the connection into reconnecting converted to milliseconds
          keepAliveData.timeout = res.KeepAliveTimeout * 1000;

          // Timeout to designate when to warn the developer that the connection may be dead or is not responding.
          keepAliveData.timeoutWarning = keepAliveData.timeout * d.keepAliveWarnAt;

          // Instantiate the frequency in which we check the keep alive.  It must be short in order to not miss/pick up any changes
          _.beatInterval = (keepAliveData.timeout - keepAliveData.timeoutWarning) / 3;
        } else {
          keepAliveData.activated = false;
        }

        d.reconnectWindow = d.disconnectTimeout + (keepAliveData.timeout || 0);


        if(!res.ProtocolVersion || res.ProtocolVersion !== this.clientProtocol) {
          throw new Error(`You are using a version of the client that isn't compatible with the server. Client version ${d.clientProtocol}, server version ${res.ProtocolVersion}.`);
          return;
        }

        // TODO: smth with res.TryWebSockets?
        return res;
      })
      .then(res => {
        // The connection was aborted
        if(this.state === Signalr.DISCONNECTED) {
          return;
        }
        return res;
        // TODO: supportsKeepAlive
        //
        // TODO: configurePingInterval
        // Used to ensure low activity clients maintain their authentication.
        // Must be configured once a transport has been decided to perform valid ping requests.
      })
    ;
  }

  connect() {
    let url = this._wrapURL('/connect');

    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

    // TODO:
    url.searchParams.set('transport', 'webSockets');

    this.transport = new WS(`${url}`);

    // TODO: handlers
    this.transport
      .on('unexpected-response', (req, res) => {
        console.log('ws.unx-res', req, res);
      })
      .on('open', () => {
        console.log('ws.opened');
      })
      .on('close', (code, reason) => {
        console.log('ws.closed', code, reason);
      })
      .on('error', (err) => {
        console.log('ws.err', err);
      })
      .on('message', (data) => {
        console.log('ws.message', data);

        data = Signalr._parseResponse(data);

        // data.M is PersistentResponse.Messages
        if(Object.keys(data).length === 0 || data.M) {
          data = Signalr.decodePersistentMessage(data);

          this.markLastMessage();

          this.updateGroups(data.groupsToken);

          if(data.id) {
            this.messageId = data.id;
          }

          if(Array.isArray(data.messages)) {
            data.messages.forEach(message => {
              this.triggerMessage(message);
            });
          }

          if(data.initMessage) {
            console.log('TODO! it\'s init message');
          }
        } else {
          this.triggerMessage(data);
        }

      })
      .on('ping', (data) => {
        console.log('ws.ping', data);
      })
      .on('pong', (data) => {
        console.log('ws.pong', data);
      })
      .on('upgrade', (res) => {
        console.log('ws.upgrade', 'res');
      })
    ;

    // TODO: what to return
    return null;
  }

  triggerMessage(message) {
    console.log('trig mess', message);
  }

  markLastMessage() {
    this._.lastActiveAt = new Date().getTime();
  }

  start() {
    let url = this._wrapURL('/start');

    // TODO:
    url.searchParams.set('transport', 'webSockets');

    return rp(`${url}`)
      .catch(err => {
        if(err.error === START_ABORT_TEXT) {
          // Stop has been called, no need to trigger the error handler
          // or stop the connection again with onStartError
          connection.log("The start request aborted because connection.stop() was called.");
          throw new Error('The connection was stopped during the start request.');
        }

        console.error(err);
        throw new Error('Error during start request. Stopping the connection.');
      })
      // TODO: stop connection (The start request failed. Stopping the connection.)
      .then(res => {
        let data;

        try {
          data = Signalr._parseResponse(res)
        } catch (e) {
          console.error(`Error parsing start response: '${res}'. Stopping the connection.`);
          throw e;
        }

        if(data.Response === 'started') {
          return;
        }
        else {
          throw new Error(`Invalid start response: '${res}'. Stopping the connection."`);
        }
      })
    ;
  }

  // TODO: write it
  reconnect() {
    throw new Error('Not implemented');
  }

  // TODO: write it
  stop() {
    throw new Error('Not implemented');
  }

  start() {
    let url = this._wrapURL('/start');

    // TODO:
    url.searchParams.set('transport', 'webSockets');

    return rp(`${url}`)
      .catch(err => {
        if(err.error === START_ABORT_TEXT) {
          // Stop has been called, no need to trigger the error handler
          // or stop the connection again with onStartError
          connection.log("The start request aborted because connection.stop() was called.");
          throw new Error('The connection was stopped during the start request.');
        }

        console.error(err);
        throw new Error('Error during start request. Stopping the connection.');
      })
      // TODO: stop connection (The start request failed. Stopping the connection.)
      .then(res => {
        let data;

        try {
          data = Signalr._parseResponse(res)
        } catch (e) {
          console.error(`Error parsing start response: '${res}'. Stopping the connection.`);
          throw e;
        }

        if(data.Response === 'started') {
          return;
        }
        else {
          throw new Error(`Invalid start response: '${res}'. Stopping the connection."`);
        }
      })
    ;
  }

  abort() {
    let url = this._wrapURL('/abort');

    // TODO:
    url.searchParams.set('transport', 'webSockets');
    console.log(`${url}`);
    return rp(`${url}`);
  }

  send(message) {
    if(typeof message === 'string' || typeof message === 'undefined' || message === null) {

    } else {
      // TODO: JSON?
      message = JSON.stringify(message);
    }

    try {
      this.transport.send(message);
    } catch (err) {
      console.log('WS.send.err', err);
    }
  }

  // TODO:
  pool() {
    throw new Error('Only for long polling');
  }

  updateGroups(groupsToken) {
    if(groupsToken) {
      this.groupsToken = groupsToken;
    }
  }

  static decodePersistentMessage(message) {
    return {
      id            : message.C,
      initMessage   : typeof message.S !== 'undefined' ? true : false,
      reconnect     : typeof message.T === 'undefined' ? true : false,
      messages      : message.M,
      groupsToken   : message.G,
      longPollDelay : message.L,
    };
  }

  static decodeHubMessage(message) {
    return {
      id    : message.I,
      hub   : message.H,
      method: message.M,
      args  : message.A,
      state : message.S
    };
  }

}

function parseMessage(mess = '') {
  mess = JSON.parse(mess);

  if(Object.keys(mess).length === 0) {
    return {
      keepAlive: true
    };
  }

  if(mess.C) {
    return parseSimpleMessage(mess);
  }

  if(mess.H) {
    return parseHubMesssage(mess);
  }


}

function parseSimpleMessage(mess = {}) {
  return {
    id: mess.C,
    groupToken: mess.G,
    messages: mess.M,
    // TODO: init: typeof mess.S !== 'undefined',
    init: typeof mess.S !== 'undefined' ? true : false,
    reconnect: typeof (mess.T) !== 'undefined' ? true : false,
    longPollDelay: mess.L
  };
}

function parseHubMesssage(mess = {}) {
  return {
    id: mess.I,
    hub: mess.H,
    method: mess.M,
    args: mess.A,
    state: mess.S
  };
}

function parseResponseMessage(mess = {}) {
  let isError = typeof mess.E !== 'undefined' ? true : false;

  if(!isError) {
    return {
      id: mess.I,
      result: mess.R
    };
  }

  return {
    id: mess.I,
    error: {
      hub: typeof mess.H !== 'undefined' ? mess.H : false,
      error: mess.E,
      data: mess.D ? mess.D : null,
      trace: mess.T,
      state: mess.S
    }
  }
}

function parseServerToClientMessage(mess = {}) {
  return {
    id: mess.C,
    methods: (mess.M || []).map(method => {
      return {
        hub: method.H,
        method: method.M,
        progress: method.P ? {
          id: method.P.I,
          data: method.P.D
        } : null,
        args: method.A,
        state: method.S
      };
    })
  };
}

function parseProgressMessage(mess = {}) {
  return {
    id: mess.C,
    methods: (mess.M || []).map(method => {
      return {
        hub: method.H,
        method: method.M,
        args: method.A,
        state: method.S
      };
    })
  };
}



let client = new Signalr({
  baseURL: 'https://socket.bittrex.com/signalr',
  hubs: ['coreHub']
});

let neg;
client.negotiate()
  .then(res => {
    neg = res;
    return client.connect(neg.ConnectionToken);
  })
  .then(res => {
    return client.start(neg.ConnectionToken);
  })
  .then(res => {
    console.log('started', res);

    setTimeout(function () {
      client.send({
        H: 'coreHub',
        M: 'subscribeToExchangeDeltas',
        A: ['USDT-BTC']
      });
    }, 1000);


    // setTimeout(function () {
    //   console.log('aborting');
    //   client.transport.send('qwerdfg');
    //   // client.abort().then(_ => {
    //   //     console.log('aborted');
    //   //   })
    // }, 5000);
  })
  .catch(err => {
    console.log('ERR', err);
  })


// rp.get()
