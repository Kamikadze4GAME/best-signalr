'use strict';


const Promise = require('bluebird');
const EventEmitter = require('eventemitter2');
const rp = require('request-promise');
const debug = require('debug')('SignalR');
const URL = require('url');
const WS = require('ws');

const { HubError, ServerError } = require('./errors');
const { to64 } = require('./helpers');


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


var COUNTER = 0;

// TODO: negotiate
// TODO: start
// TODO: connect

class Signalr extends EventEmitter {
  constructor(opts = {}) {
    super({wildcard:true});

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
    this._lastInvokeId = 0;
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
          throw new Error(`You are using a version of the client that isn't compatible with the server. Client version ${this.clientProtocol}, server version ${res.ProtocolVersion}.`);
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
        let messages = [];

        data = Signalr._parseResponse(data);


        // Hearbeat
        if(Object.keys(data).length === 0) {
          debug('heartbeat');
          this.emit('heartbeat');
        }
        // Persistent message
        else if(data.C) {
          // TODO: mark last message only for persistance messages?
          // Mark time of last message
          this.markLastMessage();

          data = Signalr.decodePersistentMessage(data);

          this.updateGroupsToken(data.groupsToken);

          this.messageId = data.id;

          if(data.init) {
            console.log('TODO! it\'s init message');
          }

          messages = data.messages;
          // console.log('pers', data);
        }
        // Another (result of request etc)
        else {
          messages = [Signalr.decodeMessage(data)];
        }

        messages.forEach(message => {
          this.triggerMessage(message);
        });

      })
      .on('ping', (data) => {
        // TODO:
        console.log('ws.ping', data);
      })
      .on('pong', (data) => {
        // TODO:
        console.log('ws.pong', data);
      })
      .on('upgrade', (res) => {
        // TODO:
        console.log('ws.upgrade', 'res');
      })
    ;

    // TODO: what to return
    return null;
  }

  triggerMessage(message) {
    console.log(message);

    // TODO:
    if(message.state) {
      console.log('new state', message.state);
    }

    // Invoke
    if(message.invoke) {
      let invoke = message.invoke;

      debug('Client invoking `%s.%s` with args %o;', invoke.hub, invoke.method, invoke.args);

      this.emit(`invoke.${invoke.hub}.${invoke.method}`, invoke.args);
    }
    // Result of request
    else if(message.result) {
      let result = message.result;

      debug('Result for request ID = %s. Error = %o. Result = %o', result.id, (result.error ? result.error.message : null), result.result);

      this.emit(`result.${result.id}`, result.error, result.result);
    }
    // Progress of request
    else if(message.progress) {
      let progress = message.progress;

      debug('Progress for request ID = %s. Data = %o', progress.id, progress.data);

      this.emit(`progress.${result.id}`, progress.data);
    }
    // Progress of request
    else if(message.undef) {
      // TODO:
      console.log('UNDEF MESSAGE', message.undef);
    }
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

  abort() {
    let url = this._wrapURL('/abort');

    // TODO:
    url.searchParams.set('transport', 'webSockets');
    console.log(`${url}`);
    return rp(`${url}`);
  }

  // TODO: check state
  send(message) {
    return Promise.resolve()
      .then(_ => {
        if(typeof message !== 'string' && typeof message !== 'undefined' || message !== null) {
          message = JSON.stringify(message);
        }

        return new Promise((resolve, reject) => {
          this.transport.send(message, (err, res) => {
            if(err) {
              return reject(err);
            }
            
            resolve(res);
          });
        });
      })
    ;
  }

  invoke(hub, method, args = []) {
    let id = to64(++this._lastInvokeId);

    return Promise.resolve()
      .then(_ => {
        debug('Invoking `%s.%s` with args %o; ID = %s', hub, method, args, id);

        return this.send({
          H: hub,
          M: method,
          A: args,
          I: id
        });
      })
      .then(res => {
        return new Promise((resolve, reject) => {
          this.once(`result.${id}`, (err, data) => {
            if(err) {
              return reject(err);
            }

            resolve(data);
          });
        });
      })
      ;
  }

  // TODO:
  pool() {
    throw new Error('Only for long polling');
  }

  updateGroupsToken(groupsToken) {
    if(groupsToken) {
      this.groupsToken = groupsToken;
    }
  }


  static decodePersistentMessage(message) {
    let res = {
      id      : message.C,
      messages: message.M.map(this.decodeMessage)
    }

    if(typeof message.S !== 'undefined') {
      res.init = true;
    }

    if(typeof message.G !== 'undefined') {
      res.groupsToken = message.G;
    }

    if(typeof message.T !== 'undefined') {
      res.reconnect = true;
    }

    if(typeof message.L !== 'undefined') {
      res.longPollDelay = message.L;
    }

    return res;
  }

  static decodeMessage(message) {
    let state    = message.S;

    let result   = null;
    let progress = null;
    let invoke   = null;
    let undef    = null;

    // We got progress
    // {
    //   I: "P|1",       <------ ID of request with prefix `P|`
    //   P: {            <------ Progress message
    //     I: "1",       <------ ID of request
    //     D: 1          <------ Progress data of request
    //   }
    // }
    if(typeof message.P !== 'undefined') {
      progress = {
        id  : message.P.I.toString(),
        data: message.P.D
      };
    }

    // We result of request or error
    else if(typeof message.I !== 'undefined') {
      let error = null;

      // Error
      // {
      //   I: "0",
      //   E: "Hub error occurred", <------ Error
      //   H: true,                 <------ Is hub error
      //   D: {"ErrorNumber":42}    <------ Extra error data
      //   T: ?                     <------ Trace of error
      // }
      if(typeof message.E !== 'undefined') {
        // Hub error
        if(typeof message.H !== 'undefined' && message.H) {
          error = new HubError(message.E, message.D, message.T);
        }
        // Server error
        else {
          error = new ServerError(message.E, message.D, message.T);
        }
      }

      result = {
        id    : message.I.toString(),
        error : error,
        result: message.R
      };
    }

    // We got client hub call
    else if(typeof message.H !== 'undefined' && typeof message.M !== 'undefined') {
      invoke = {
        hub   : message.H,
        method: message.M,
        args  : message.A
      };
    }
    // Something else
    else {
      undef = message;
    }

    return {
      state,
      result,
      progress,
      invoke,
      undef
    };
  }

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
      // client.send({
      //   H: 'coreHub',
      //   M: 'subscribeToExchangeDeltas',
      //   A: ['USDT-BTC'],
      //   I: 'qwdq'
      // })

      // client.transport.close();
      client.invoke('coreHub', 'subscribeToExchangeDeltas', undefined ,['USDT-BTC'])
      .then(res2 => {
        console.log('invoke.res', res2);
      })
      .catch(err => {
        // console.log('invoke.err', err.message);
        console.dir(err, {depth:null});
      })

    }, 2000);


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
